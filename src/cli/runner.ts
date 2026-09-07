/**
 * 通用 CLI Runner：按适配器接入模式调度 headless 或 ACP 进程，统一处理
 * 流式事件、瞬时断流重试、超时、取消和唯一收尾。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AcpDaemon } from "./acp-daemon.js";
import { runAcp } from "./acp-runner.js";
import { resolveCliCommand } from "./command-resolver.js";
import {
  captureProcessTree,
  stopProcessTree,
} from "./process-tree.js";
import type { ProcessTreeStopper } from "./process-tree.js";
import { cliTimeoutMs } from "./timeout.js";
import type { CliAdapter, CliEvent, CliRunResult } from "./types.js";

const TRANSIENT_STREAM_RETRY_DELAYS_MS = [
  1_000,
  1_500,
  2_000,
  2_500,
  3_000,
] as const;

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** 可选执行时限；未传入时使用统一默认硬超时。 */
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
  /** 运行时注入子进程的额外环境变量（如 bot 配置的网络代理），与父进程环境合并。 */
  env?: Record<string, string>;
  /** ACP 模式下的常驻进程；由调用方持有并负责生命周期与回收。 */
  acpDaemon?: AcpDaemon;
  /** 本轮任务归属的 bot id；cli 服务据此注入每 bot 的引擎模型环境并登记常驻进程。 */
  botId?: string;
}

/** 解析一轮 CLI 的可选执行时限；引擎专用变量优先于 CLI_TIMEOUT_MS。 */
export function cliExecutionTimeoutMs(
  cliId: string,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const engineKey = `${cliId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TIMEOUT_MS`;
  const source = env[engineKey]?.trim() || env.CLI_TIMEOUT_MS?.trim();
  if (!source) return undefined;
  if (!/^\d+$/.test(source)) {
    throw new Error(`${engineKey}/CLI_TIMEOUT_MS 必须是正整数毫秒值`);
  }
  const timeoutMs = Number(source);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${engineKey}/CLI_TIMEOUT_MS 必须是正整数毫秒值`);
  }
  return timeoutMs;
}

/** CLI 失败信息；若进程已返回会话 ID，调用方仍可持久化并续聊。 */
export class CliRunError extends Error {
  constructor(
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliRunError";
  }
}

/** 执行一次首次对话或续聊，并返回最终回答及执行引擎会话 ID。 */
export function runCli(
  options: RunCliOptions,
  stopTree: ProcessTreeStopper = stopProcessTree,
): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs,
    onEvent,
    env,
  } = options;

  if (signal?.aborted) {
    return Promise.reject(new Error(`${adapter.displayName} 执行已取消`));
  }

  const effectiveTimeoutMs = cliTimeoutMs(timeoutMs);

  if (adapter.accessMode === "acp") {
    // 常驻路径用调用方注入的 daemon；无注入时走临时 daemon（一轮后即回收）。
    const promise = options.acpDaemon
      ? options.acpDaemon.runTurn({ ...options, timeoutMs: effectiveTimeoutMs })
      : runAcp({ ...options, timeoutMs: effectiveTimeoutMs });
    return promise.catch((error) => {
      if (error instanceof CliRunError) throw error;
      const sessionId =
        error instanceof Error && "sessionId" in error &&
        typeof error.sessionId === "string"
          ? error.sessionId
          : undefined;
      throw sessionId
        ? new CliRunError((error as Error).message, sessionId, { cause: error })
        : error;
    });
  }

  const startHeadless = (headlessTimeoutMs: number) => {
    if (signal?.aborted) {
      return Promise.reject(new Error(`${adapter.displayName} 执行已取消`));
    }
    const executable = resolveCliCommand(adapter.command);
    const adapterArgs = sessionId
      ? adapter.buildResumeArgs(prompt, sessionId)
      : adapter.buildArgs(prompt);

    return new Promise<CliRunResult>((resolve, reject) => {
    // shell=false 且参数分离，飞书文本无法逃逸成额外系统命令。
    const processStartedAt = Date.now();
    const child = spawn(
      executable.command,
      [...executable.argsPrefix, ...adapterArgs],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // 调用方注入的环境变量（如 bot 配置的网络代理）与父进程环境合并。
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
    );
    // 记录本次进程的启动边界；主进程提前退出时只清理该时间窗口内的后代，
    // 避免 Windows 复用旧 PID 后误杀无关进程。
    const processTreeSnapshot = captureProcessTree(child.pid, processStartedAt);
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let observedAnswer: string | undefined;
    let observedStats: CliRunResult["stats"];
    let observedComplete = false;
    // 同一 toolUseId 可能在流式输出中重复出现，用 Map 按 id 去重；
    // 收到失败的 tool_end 时把这次调用从结果中移除。
    const observedToolCalls = new Map<
      string,
      NonNullable<CliRunResult["toolCalls"]>[number]
    >();
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;
    let timedOut = false;

    let timer: NodeJS.Timeout | undefined;
    let stopPromise: Promise<void> | undefined;
    let stopping = false;
    let stopForAbort: () => void;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stopForAbort);
      lines.close();
    };
    const buildResult = (): CliRunResult => {
      const answer = observedAnswer;
      if (answer === undefined) {
        throw new Error(`${adapter.displayName} 没有返回最终结果`);
      }
      const toolCalls = [...observedToolCalls.values()].map((call) => ({
        toolUseId: call.toolUseId,
        toolName: call.toolName,
        input: call.input,
      }));
      return {
        answer,
        ...(observedSessionId ? { sessionId: observedSessionId } : {}),
        ...(observedStats ? { stats: observedStats } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    };
    const fail = (error: Error) => {
      // abort、spawn error 与 close 可能先后到达，只允许第一个出口结束 Promise。
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        observedSessionId
          ? new CliRunError(error.message, observedSessionId, { cause: error })
          : error,
      );
    };
    const stopOnce = () => {
      stopPromise ??= stopTree(child, processTreeSnapshot);
      return stopPromise;
    };
    const resolveSuccess = () => {
      if (settled || stopping || observedAnswer === undefined) return;
      const result = buildResult();
      settled = true;
      cleanup();
      // 业务完成但子进程未退出时，必须先收割 CLI 及后代，再把结果交回任务层。
      void stopOnce().finally(() => resolve(result));
    };
    const stopThenFail = (error: Error) => {
      if (settled || stopping) return;
      stopping = true;
      // close 正常到达时会提前 fail；否则宽限期结束后这里保证 Promise 收尾。
      void stopOnce().finally(() => fail(error));
    };
    const completedResultError = (): Error | undefined => {
      if (timedOut) return new Error(`${adapter.displayName} 执行超时`);
      if (signal?.aborted) return new Error(`${adapter.displayName} 执行已取消`);
      if (resultError) return resultError;
      if (child.exitCode !== null && child.exitCode !== 0) {
        return new Error(
          stderr.trim() || `${adapter.displayName} 退出，状态码 ${child.exitCode}`,
        );
      }
      if (sessionId && adapter.isSessionUnavailable?.(stderr)) {
        return new CliRunError(
          `${adapter.displayName} 会话已失效：${stderr.trim()}`,
          observedSessionId,
        );
      }
      return undefined;
    };
    const finishCompletedResult = () => {
      if (
        settled ||
        stopping ||
        !observedComplete ||
        observedAnswer === undefined
      ) return;
      const error = completedResultError();
      if (error) {
        stopThenFail(error);
        return;
      }
      // 协议终态已经包含完整结果，此时直接收割仍存活的主进程及其当前
      // 后代，可走 Windows taskkill /T，避免正常任务额外扫描系统进程表。
      resolveSuccess();
    };
    stopForAbort = () => {
      stopThenFail(new Error(`${adapter.displayName} 执行已取消`));
    };
    signal?.addEventListener("abort", stopForAbort, { once: true });
    // 覆盖 spawn 与监听器注册之间发生 abort 的极小竞态。
    if (signal?.aborted) stopForAbort();

    timer = setTimeout(() => {
      timedOut = true;
      stopThenFail(new Error(`${adapter.displayName} 执行超时`));
    }, headlessTimeoutMs);

    lines.on("line", (line) => {
      try {
        for (const event of adapter.parseEvents(line)) {
          // 观察者不能破坏 Runner 内部状态更新；异常会在进程退出后稳定拒绝。
          try {
            onEvent?.(event);
          } catch (error) {
            resultError =
              error instanceof Error ? error : new Error(String(error));
          }
          if ("sessionId" in event && event.sessionId) {
            observedSessionId = event.sessionId;
          }
          if (event.type === "error") {
            resultError = new Error(event.message);
          } else if (event.type === "tool_call") {
            observedToolCalls.set(event.toolUseId, event);
          } else if (event.type === "tool_end" && event.failed) {
            observedToolCalls.delete(event.toolUseId);
          } else if (event.type === "result") {
            // Codex 会把回答和统计拆成不同事件；空字段不能覆盖已经观察到的值。
            if (event.answer) observedAnswer = event.answer;
            if (event.stats) observedStats = event.stats;
            if (event.complete) observedComplete = true;
            finishCompletedResult();
          }
        }
      } catch (error) {
        resultError =
          error instanceof Error ? error : new Error(String(error));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      // 实时识别认证需求：agy 等引擎未登录时会长时间等待用户登录（60s 超时），
      // 与其让任务挂起再等超时，不如检测到登录提示就立即停止并返回认证错误，
      // 让 tasks 失败路径马上广播 task/failed，auth 插件随即补发登录卡片。
      // 检测委托 adapter 的 isAuthRequired 协议，runner 不感知具体引擎。
      if (
        !settled &&
        !resultError &&
        adapter.isAuthRequired?.(stderr)
      ) {
        stopThenFail(
          new Error(stderr.trim() || `${adapter.displayName} 需要登录`),
        );
      }
    });

    child.once("error", (error) => {
      if (timedOut) {
        stopThenFail(new Error(`${adapter.displayName} 执行超时`));
      } else if (signal?.aborted) {
        stopThenFail(new Error(`${adapter.displayName} 执行已取消`));
      } else {
        fail(error);
      }
    });

    child.once("close", (code) => {
      if (settled) return;
      if (timedOut) {
        stopThenFail(new Error(`${adapter.displayName} 执行超时`));
        return;
      }
      if (signal?.aborted) {
        stopThenFail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      if (resultError) {
        stopThenFail(resultError);
        return;
      }
      if (code !== 0) {
        stopThenFail(
          new Error(
            stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
          ),
        );
        return;
      }
      if (observedAnswer === undefined) {
        fail(new Error(`${adapter.displayName} 没有返回最终结果`));
        return;
      }
      if (!observedComplete) {
        fail(new Error(`${adapter.displayName} 未收到业务完成信号`));
        return;
      }
      // 续聊时若 stderr 明确提示会话已失效（如 agy 对不存在会话降级为新会话，
      // 仍以退出码 0 返回“成功”结果），不能把静默新建会话当成功接受：
      // 必须报错让会话层清除失效指针，下一次任务重新建立会话。
      if (sessionId && adapter.isSessionUnavailable?.(stderr)) {
        stopThenFail(
          new CliRunError(
            `${adapter.displayName} 会话已失效：${stderr.trim()}`,
            observedSessionId,
          ),
        );
        return;
      }

      settled = true;
      cleanup();
      const result = buildResult();
      // 即使主进程已经正常 close，也可能留下脱离父树的后代；统一经过
      // stopProcessTree，让启动时快照中的后代也得到清理。
      void stopOnce().then(
        () => resolve(result),
        () => resolve(result),
      );
    });
    });
  };

  // 配置准备失败时不启动 CLI，错误直接回到任务层展示；重试时会再次执行幂等准备。
  const preparation = Promise.resolve().then(() => adapter.prepareRun?.(cwd));
  let preparationTimer: NodeJS.Timeout | undefined;
  let abortPreparation: (() => void) | undefined;
  const preparationTimeout = new Promise<never>((_, reject) => {
    preparationTimer = setTimeout(
      () => reject(new Error(`${adapter.displayName} 执行超时`)),
      effectiveTimeoutMs,
    );
  });
  const preparationCancelled = new Promise<never>((_, reject) => {
    abortPreparation = () =>
      reject(new Error(`${adapter.displayName} 执行已取消`));
    signal?.addEventListener("abort", abortPreparation, { once: true });
    if (signal?.aborted) abortPreparation();
  });
  const startedAt = Date.now();
  return Promise.race([preparation, preparationTimeout, preparationCancelled])
    .finally(() => {
      if (preparationTimer) clearTimeout(preparationTimer);
      if (abortPreparation) {
        signal?.removeEventListener("abort", abortPreparation);
      }
    })
    .then(() => {
      const remainingMs = effectiveTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(`${adapter.displayName} 执行超时`);
      }
      return startHeadless(remainingMs);
    });
}

function isTransientStreamDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stream disconnected before completion:\s*upstream request failed/i.test(
    message,
  );
}

function waitForRetry(
  adapter: CliAdapter,
  signal: AbortSignal | undefined,
  delayMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error(`${adapter.displayName} 执行已取消`));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * 对声明了 retryOnDisconnect 的引擎（目前只有 Codex）的明确瞬时断流做有限重试；
 * 每次重试优先续接已建立的 CLI 会话。其他 CLI 或错误保持一次执行语义，
 * 避免认证、权限或代码错误被静默重复执行。
 */
export async function runCliWithTransientRetry(
  options: RunCliOptions,
  stopTree: ProcessTreeStopper = stopProcessTree,
): Promise<CliRunResult> {
  let currentSessionId = options.sessionId;
  const timeoutMs = cliTimeoutMs(options.timeoutMs);
  const deadlineAt = Date.now() + timeoutMs;

  const timeoutError = () => {
    const error = new Error(`${options.adapter.displayName} 执行超时`);
    return currentSessionId
      ? new CliRunError(error.message, currentSessionId, { cause: error })
      : error;
  };

  for (let retryIndex = 0; ; retryIndex += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    try {
      return await runCli(
        {
          ...options,
          timeoutMs: remainingMs,
          ...(currentSessionId ? { sessionId: currentSessionId } : {}),
          onEvent: (event) => {
            if (event.type === "session") currentSessionId = event.sessionId;
            options.onEvent?.(event);
          },
        },
        stopTree,
      );
    } catch (error) {
      if (
        options.adapter.retryOnDisconnect !== true ||
        !isTransientStreamDisconnect(error) ||
        retryIndex >= TRANSIENT_STREAM_RETRY_DELAYS_MS.length ||
        options.signal?.aborted
      ) {
        throw error;
      }
      if (error instanceof CliRunError && error.sessionId) {
        currentSessionId = error.sessionId;
      }

      const delayMs = TRANSIENT_STREAM_RETRY_DELAYS_MS[retryIndex];
      // 退避同样属于单轮总预算；剩余时间不足以开始下一次尝试时直接收口。
      if (deadlineAt - Date.now() <= delayMs) throw timeoutError();
      console.warn(
        `[CLI] 检测到流式连接中断，将在 ${delayMs}ms 后重试 (${retryIndex + 1}/${TRANSIENT_STREAM_RETRY_DELAYS_MS.length})`,
      );
      await waitForRetry(options.adapter, options.signal, delayMs);
    }
  }
}
