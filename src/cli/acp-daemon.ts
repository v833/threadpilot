/**
 * ACP 常驻进程：为任意标准 ACP 接入引擎维护单个常驻 ACP server 子进程与
 * 持久 ACP 连接。多个任务在同一进程上并发执行（通知按 sessionId 路由隔离），
 * 空闲超时自动回收，进程崩溃后下次调用自动重建，ThreadPilot 退出时显式关闭。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolveCliCommand } from "./command-resolver.js";
import {
  captureProcessTree,
  stopProcessTree,
} from "./process-tree.js";
import type { ProcessTreeSnapshot } from "./process-tree.js";
import type { ProcessTreeStopper } from "./process-tree.js";
import { cliTimeoutMs } from "./timeout.js";
import {
  acpMcpServers,
  findAcpApplicationTool,
  unsupportedAcpMcpServers,
} from "./app-tools.js";
import type { ApplicationToolServer } from "./app-tools.js";
import type {
  AcpSessionConfig,
  CliAdapter,
  CliEvent,
  CliRunResult,
  CliRunStats,
} from "./types.js";

/** 无任务运行超过该时长即回收常驻进程；可在构造时覆盖。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
/** 常驻进程从拉起到底盘完成握手的最大时限，超时按启动失败处理并回收。 */
const INITIALIZE_TIMEOUT_MS = 30 * 1_000;
/** Dim 进程退出后会短暂保留 session 锁；load 只在明确锁错误时有限重试。 */
const LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 2_500] as const;
/** prompt 响应与最后一条 session/update 可能乱序，给通知一个有限排空窗口。 */
const PROMPT_NOTIFICATION_DRAIN_MS = 250;
/** session/close 是收尾操作，不能因为服务端异常拖住 ThreadPilot 退出。 */
const SESSION_CLOSE_TIMEOUT_MS = 2_000;

const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  delete: "删除文件",
  move: "移动文件",
  search: "搜索代码",
  execute: "运行命令",
  think: "分析任务",
  fetch: "读取网页",
  switch_mode: "切换模式",
  other: "调用工具",
};

/** ACP 失败时携带已经创建或恢复的 session ID，供 runner 包装成 CliRunError 后持久化。 */
class AcpRunError extends Error {
  constructor(
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AcpRunError";
  }
}

/** 在常驻 ACP 进程上执行一轮所需的最小参数；adapter 由 daemon 构造时持有。 */
export interface AcpTurnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** 可选执行时限；未传入时使用统一默认硬超时。 */
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
  /** 当前轮工具上下文；只用于生成 MCP 动态参数，不改变常驻子进程环境。 */
  env?: Record<string, string>;
}

/** 单个进行中 turn 的通知收集状态；daemon 按 sessionId 路由到此。 */
interface TurnCollector {
  /** 绑定本轮 onEvent 的发射器；观察者异常按轮记录并在结束时抛出。 */
  emit: (event: CliEvent) => void;
  answer: string;
  stats?: CliRunStats;
  startedTools: Set<string>;
  completedTools: Set<string>;
  /** 记录 ACP 工具 ID 对应的 wire name，后续 patch 可能只携带 toolCallId。 */
  toolNames: Map<string, string>;
  /** 避免同一个 MCP 工具在 tool_call/tool_call_update 中重复进入结果链路。 */
  applicationTools: Set<string>;
  /** 本轮实际发送给 ACP 的工具；过滤掉 server 不支持的 transport。 */
  applicationToolServers: readonly ApplicationToolServer[];
  /** ACP 路径没有 headless Runner 的事件回收，因此在 daemon 内汇总成功工具调用。 */
  toolCalls: Map<
    string,
    { toolUseId: string; toolName: string; input: unknown }
  >;
}

function statsFromUsage(usage: acp.Usage | null | undefined): CliRunStats | undefined {
  if (!usage) return undefined;
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens !== undefined && usage.cachedReadTokens !== null
      ? { cacheReadTokens: usage.cachedReadTokens }
      : {}),
    ...(usage.cachedWriteTokens !== undefined && usage.cachedWriteTokens !== null
      ? { cacheCreationTokens: usage.cachedWriteTokens }
      : {}),
  };
}

/** 等待 ACP 操作，并在本轮取消或超时时立即释放调用方。底层请求另行接收同一 signal。 */
function withInterruption<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(asError(signal.reason ?? "ACP 执行已取消"));
  }
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(asError(signal.reason ?? "ACP 执行已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([operation, interrupted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function permissionResponse(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  // 飞书任务没有同步审批通道；与 dim exec 的 full-access 默认行为一致，
  // 优先选择允许选项，不能安全选择时明确取消本次请求。
  const option =
    params.options.find((item) => item.kind === "allow_always") ??
    params.options.find((item) => item.kind === "allow_once");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function toolEventLabel(update: acp.ToolCall | acp.ToolCallUpdate): string {
  return TOOL_LABELS[update.kind ?? "other"] ?? "调用工具";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (!isRecord(value)) return message;
  const data = isRecord(value.data) ? value.data : undefined;
  const detail =
    (data && typeof data.details === "string" && data.details) ||
    (data && typeof data.detail === "string" && data.detail);
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

function asError(value: unknown): Error {
  if (value instanceof Error) {
    const message = errorMessage(value);
    return message === value.message ? value : new Error(message, { cause: value });
  }
  return new Error(errorMessage(value));
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

interface AcpSessionResponse {
  configOptions?: unknown;
  modes?: unknown;
  /** DimCode 扩展字段：模型目录不在标准 ACP v1 类型中。 */
  models?: unknown;
}

function versionParts(value: unknown): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

function versionAtLeast(actual: unknown, minimum: string): boolean {
  const current = versionParts(actual);
  const required = versionParts(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function isHeldSessionError(error: unknown): boolean {
  const message = errorMessage(error);
  return /held by another process|already in use|session(?: .*?)?locked/i.test(message);
}

function isSessionUnavailableError(error: unknown): boolean {
  const message = errorMessage(error);
  return /session[^\n]*(?:not found|does not exist|expired|invalid|unknown)/i.test(message) ||
    /no (?:such )?(?:session|conversation)\b/i.test(message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("ACP 执行已取消"));
  }
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectDelay(new Error("ACP 执行已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sessionResponse(value: unknown): AcpSessionResponse {
  return isRecord(value) ? value : {};
}

function optionValues(option: unknown): string[] {
  if (!isRecord(option) || !Array.isArray(option.options)) return [];
  const values: string[] = [];
  for (const entry of option.options) {
    if (!isRecord(entry)) continue;
    const value = asNonEmptyString(entry.value);
    if (value) values.push(value);
    if (Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (isRecord(nested)) {
          const nestedValue = asNonEmptyString(nested.value);
          if (nestedValue) values.push(nestedValue);
        }
      }
    }
  }
  return values;
}

function findConfigOption(configOptions: unknown, id: string): unknown {
  if (!Array.isArray(configOptions)) return undefined;
  return configOptions.find(
    (option) => isRecord(option) && option.id === id,
  );
}

function modelIdsFromResponse(
  response: AcpSessionResponse,
  configOptions: unknown,
): string[] {
  const models = isRecord(response.models) ? response.models.availableModels : undefined;
  if (Array.isArray(models)) {
    const ids = models
      .map((model) => (isRecord(model) ? asNonEmptyString(model.modelId) : undefined))
      .filter((id): id is string => Boolean(id));
    if (ids.length > 0) return ids;
  }
  if (!Array.isArray(configOptions)) return [];
  const modelOption = configOptions.find(
    (option) =>
      isRecord(option) &&
      (option.id === "model" || option.category === "model"),
  );
  return optionValues(modelOption);
}

function modeIdsFromResponse(response: AcpSessionResponse): string[] {
  const modes = isRecord(response.modes) ? response.modes.availableModes : undefined;
  if (!Array.isArray(modes)) return [];
  return modes
    .map((mode) => (isRecord(mode) ? asNonEmptyString(mode.id) : undefined))
    .filter((id): id is string => Boolean(id));
}

/**
 * 按 ACP 引擎插件声明的顺序应用 session/new 返回的会话配置。
 * 配置请求失败必须中止本轮，尤其是 DimAgent 的 permission 默认只读时，
 * 继续执行会把写入和进程工具静默变成无效操作。
 */
async function applySessionConfig(
  client: acp.ClientContext,
  sessionId: string,
  response: AcpSessionResponse,
  config: AcpSessionConfig | undefined,
  displayName: string,
  signal: AbortSignal,
): Promise<void> {
  if (!config) return;

  try {
    let configOptions = response.configOptions;
    for (const [configId, value] of Object.entries(config.configOptions ?? {})) {
      const option = findConfigOption(configOptions, configId);
      if (!option) {
        throw new Error(
          `${displayName} ACP session 配置缺少选项 ${configId}，无法安全继续`,
        );
      }
      const values = optionValues(option);
      if (values.length > 0 && !values.includes(value)) {
        throw new Error(
          `${displayName} ACP session 配置选项 ${configId} 不支持值 ${value}`,
        );
      }
      const updated = await client.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId, configId, value },
        { cancellationSignal: signal },
      );
      configOptions = updated.configOptions;
    }

    if (config.modeId) {
      const modeIds = modeIdsFromResponse(response);
      if (modeIds.length > 0 && !modeIds.includes(config.modeId)) {
        throw new Error(
          `${displayName} ACP session 不支持模式 ${config.modeId}`,
        );
      }
      await client.request(
        acp.methods.agent.session.setMode,
        { sessionId, modeId: config.modeId },
        { cancellationSignal: signal },
      );
    }

    if (config.model) {
      const modelIds = modelIdsFromResponse(response, configOptions);
      if (!modelIds.includes(config.model)) {
        throw new Error(
          `${displayName} ACP session 不支持模型 ${config.model}；可用模型：${modelIds.join(", ") || "未知"}`,
        );
      }
      // DimCode 扩展：模型 ID 来自 session/new 的 models.availableModels。
      await client.request(
        "session/set_model",
        { sessionId, modelId: config.model },
        { cancellationSignal: signal },
      );
    }
  } catch (error) {
    throw new Error(
      `${displayName} ACP session 配置失败: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * 单个常驻 ACP server 进程。连接一旦建立便持续复用（initialize 只做一次），
 * 每个 turn 在独立 session 上运行；进程异常退出后自动标记失效并在下次调用时重建。
 */
export class AcpDaemon {
  private child: ChildProcess | undefined;
  /** 启动时记录的进程树；主 ACP 进程提前退出后仍用于清理脱离父树的后代。 */
  private processTreeSnapshot: ProcessTreeSnapshot | undefined;
  private connection: acp.ClientConnection | undefined;
  private client: acp.ClientContext | undefined;
  private capabilities: acp.InitializeResponse["agentCapabilities"] | undefined;
  /** 连接已失效（进程退出或被主动关闭），下次 acquire 需要重建。 */
  private broken = false;
  /** 并发 acquire 的去重句柄，避免多个任务同时拉起两个进程。 */
  private acquiring: Promise<acp.ClientContext> | undefined;
  private stderr = "";
  /** 进行中的 turn 收集器；session/update 通知按 sessionId 路由。 */
  private readonly turns = new Map<string, TurnCollector>();
  /** 已进入 runTurn 但尚未登记 session 的任务；空闲回收必须等待这些任务完成启动。 */
  private activeRuns = 0;
  /** daemon 生命周期内见过的 ACP session；关闭连接前逐个发送 session/close。 */
  private readonly sessions = new Set<string>();
  private idleTimer: NodeJS.Timeout | undefined;
  /** 串行化空闲回收与插件卸载，避免同时关闭同一连接。 */
  private closing: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly adapter: CliAdapter,
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
    /** 常驻进程启动环境；同一 daemon 生命周期内保持不变。 */
    private readonly env?: Record<string, string>,
    /** 进程树收尾边界；生产默认完整清理，测试可替换以聚焦 ACP 协议。 */
    private readonly stopTree: ProcessTreeStopper = stopProcessTree,
  ) {}

  /** 当前常驻子进程 PID；未启动或已回收时为 undefined（也用于测试断言）。 */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 空闲定时器：无活跃 turn 时在 idleTimeoutMs 后回收进程；到点若已有新任务则重排。 */
  private scheduleIdleClose(): void {
    if (this.closed) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.closed) return;
      if (this.activeRuns > 0 || this.turns.size > 0 || this.acquiring) {
        this.scheduleIdleClose();
        return;
      }
      void this.recycleIdle();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** 建立子进程与 ACP 连接并完成握手；仅由 acquire 在无可用连接时调用。 */
  private async spawnConnection(): Promise<acp.ClientContext> {
    const executable = resolveCliCommand(this.adapter.command);
    const processStartedAt = Date.now();
    const child = spawn(
      executable.command,
      [...executable.argsPrefix, ...this.adapter.buildArgs("")],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(this.env ? { env: { ...process.env, ...this.env } } : {}),
      },
    );
    this.child = child;
    this.processTreeSnapshot = captureProcessTree(child.pid, processStartedAt);
    this.stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr += chunk.toString();
    });

    // spawn 失败（如命令不存在）时 SDK 请求会挂起；显式关闭连接让挂起请求
    // 立即失败，也避免未监听的 error 事件泄漏到事件循环。
    child.once("error", (error) => {
      // 子进程事件可能晚于回收完成才到达；旧实例不能清理新连接。
      if (this.closed || this.child !== child) return;
      const stale = this.connection;
      if (!this.markBroken({ child })) return;
      if (stale) stale.close(asError(error));
    });

    const app = acp
      .client({ name: "threadpilot" })
      .onRequest(acp.methods.client.session.requestPermission, (context) =>
        permissionResponse(context.params),
      )
      .onNotification(acp.methods.client.session.update, (context) => {
        this.handleSessionUpdate(context.params);
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;
    this.client = connection.agent;
    this.broken = false;

    // 进程崩溃时显式关闭连接，让所有在途 prompt 请求立刻失败，
    // 不依赖 SDK 对 stdin/stdout EOF 的感知时序。
    child.once("close", () => {
      // 子进程事件可能晚于回收完成才到达；旧实例不能清理新连接。
      if (this.closed || this.child !== child) return;
      const stale = this.connection;
      const processTreeSnapshot = this.processTreeSnapshot;
      if (!this.markBroken({ child })) return;
      if (stale) {
        stale.close(
          new Error(
            this.stderr.trim() || `${this.adapter.displayName} ACP 常驻进程提前退出`,
          ),
        );
      }
      void this.stopTree(child, processTreeSnapshot);
    });
    // 连接层关闭（主动 close 或传输断开）同样标记失效；非主动断开时
    // 旧子进程仍可能存活，必须连同启动时快照一起回收。
    const handleConnectionClosed = () => {
      if (this.closed || this.connection !== connection) return;
      const staleChild = this.child;
      const processTreeSnapshot = this.processTreeSnapshot;
      if (!this.markBroken({ connection })) return;
      if (staleChild) void this.stopTree(staleChild, processTreeSnapshot);
    };
    void connection.closed.then(handleConnectionClosed, handleConnectionClosed);

    try {
      const initialized = await Promise.race([
        this.client.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "threadpilot",
            title: "ThreadPilot",
            version: "0.1.0",
          },
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${this.adapter.displayName} ACP 启动超时`)),
            INITIALIZE_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      this.capabilities = initialized.agentCapabilities;
      const minimumVersion = this.adapter.getAcpMinAgentVersion?.();
      if (
        minimumVersion &&
        !versionAtLeast(initialized.agentInfo?.version, minimumVersion)
      ) {
        const actualVersion = initialized.agentInfo?.version ?? "未知";
        throw new Error(
          `${this.adapter.displayName} ACP 版本 ${actualVersion} 不满足最低版本 ${minimumVersion}`,
        );
      }
      return this.client;
    } catch (error) {
      // 启动失败（命令缺失/握手超时/协议错误）：关闭连接并结束子进程，
      // 让挂起的 acquire 立即失败，后续调用可重新拉起。
      const stale = this.connection;
      const processTreeSnapshot = this.processTreeSnapshot;
      this.markBroken({ child, connection });
      if (stale === connection) stale.close(asError(error));
      await this.stopTree(child, processTreeSnapshot);
      throw error;
    }
  }

  /** 连接失效后清理句柄；在途 turn 由连接关闭触发失败，无需在此主动干预。 */
  private markBroken(expected?: {
    child?: ChildProcess;
    connection?: acp.ClientConnection;
  }): boolean {
    if (expected?.child && this.child !== expected.child) return false;
    if (expected?.connection && this.connection !== expected.connection) return false;
    if (this.broken) return false;
    this.broken = true;
    this.connection = undefined;
    this.client = undefined;
    this.child = undefined;
    this.processTreeSnapshot = undefined;
    this.capabilities = undefined;
    return true;
  }

  /** 获取可用连接；首次调用拉起进程，崩溃后自动重建，并发调用共享同一次启动。 */
  private async acquire(): Promise<acp.ClientContext> {
    // 空闲回收是异步的；新任务必须等旧连接完全释放后再检查/拉起，
    // 否则会拿到即将被 markBroken 的旧 client，导致本轮无结果。
    while (this.closing) await this.closing;
    if (this.closed) {
      throw new Error(`${this.adapter.displayName} ACP 常驻进程已关闭`);
    }
    // spawnConnection 在 initialize 完成前就会设置 client；并发任务必须先
    // 复用同一个 acquiring Promise，不能绕过握手直接发送 session/new。
    if (this.acquiring) return this.acquiring;
    if (this.client && !this.broken) return this.client;
    this.acquiring ??= this.spawnConnection().finally(() => {
      this.acquiring = undefined;
    });
    return this.acquiring;
  }

  /** Dim 的旧进程退出后 session 锁不是立即释放，只有锁错误才进行有限退避重试。 */
  private async loadSessionWithRetry(
    client: acp.ClientContext,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.request(
          acp.methods.agent.session.load,
          { sessionId, cwd, mcpServers },
          { cancellationSignal: signal },
        );
      } catch (error) {
        const retryDelay = LOAD_RETRY_DELAYS_MS[attempt];
        if (!isHeldSessionError(error) || retryDelay === undefined) throw error;
        await delay(retryDelay, signal);
      }
    }
  }

  /** 在连接仍可用时尽力关闭 session；失败只记录日志，不覆盖原始错误。 */
  private async closeSessionBestEffort(
    client: acp.ClientContext,
    sessionId: string,
  ): Promise<void> {
    if (!this.capabilities?.sessionCapabilities?.close) return;
    try {
      await Promise.race([
        client.request(acp.methods.agent.session.close, { sessionId }),
        delay(SESSION_CLOSE_TIMEOUT_MS),
      ]);
    } catch (error) {
      console.warn(
        `[ACP] ${this.adapter.displayName} session/close 失败 session=${sessionId}: ${asError(error).message}`,
      );
    }
  }

  /** 生成本轮实际发送的 MCP 列表，并把不兼容 transport 变成可诊断 warning。 */
  private acpMcpServers(
    applicationTools: readonly ApplicationToolServer[],
    allApplicationTools: readonly ApplicationToolServer[] = applicationTools,
    turnEnv?: Record<string, string>,
  ): acp.McpServer[] {
    const supportedTransports = this.adapter.getAcpMcpTransports?.();
    const dropped = unsupportedAcpMcpServers(allApplicationTools, supportedTransports);
    if (dropped.length > 0) {
      console.warn(
        `[ACP] ${this.adapter.displayName} 不支持这些 MCP transport，已跳过: ${dropped.join(", ")}`,
      );
    }
    return acpMcpServers(applicationTools, supportedTransports, {
      ...this.env,
      ...turnEnv,
    });
  }

  /** 将 agent 的 session/update 通知按 sessionId 路由到对应 turn 的收集器。 */
  private handleSessionUpdate(params: acp.SessionNotification): void {
    const { sessionId, update } = params;
    const turn = this.turns.get(sessionId);
    if (!turn) return;

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") turn.answer += update.content.text;
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      turn.emit({ type: "context", usedTokens: update.used });
      turn.stats = {
        ...turn.stats,
        contextUsedTokens: update.used,
        contextWindowTokens: update.size,
      };
      return;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return;
    }
    const updateWireName = update.name ?? update.title;
    if (updateWireName) turn.toolNames.set(update.toolCallId, updateWireName);
    const wireName = turn.toolNames.get(update.toolCallId);
    const applicationToolName = findAcpApplicationTool(
      turn.applicationToolServers,
      wireName,
    );
    if (!turn.startedTools.has(update.toolCallId)) {
      turn.startedTools.add(update.toolCallId);
      turn.emit({
        type: "tool_start",
        toolUseId: update.toolCallId,
        toolName: update.name ?? update.title ?? update.kind ?? "Tool",
        label: toolEventLabel(update),
        ...(update.title ? { detail: update.title } : {}),
      });
    }
    if (applicationToolName) {
      if (!turn.applicationTools.has(update.toolCallId)) {
        turn.applicationTools.add(update.toolCallId);
        turn.emit({
          type: "tool_call",
          toolUseId: update.toolCallId,
          toolName: applicationToolName,
          input: update.rawInput ?? {},
        });
        turn.toolCalls.set(update.toolCallId, {
          toolUseId: update.toolCallId,
          toolName: applicationToolName,
          input: update.rawInput ?? {},
        });
      } else if ("rawInput" in update && update.rawInput !== undefined) {
        const existing = turn.toolCalls.get(update.toolCallId);
        if (existing) {
          existing.input = update.rawInput;
        } else {
          turn.toolCalls.set(update.toolCallId, {
            toolUseId: update.toolCallId,
            toolName: applicationToolName,
            input: update.rawInput,
          });
        }
      }
    }
    if (
      !turn.completedTools.has(update.toolCallId) &&
      (update.status === "completed" || update.status === "failed")
    ) {
      turn.completedTools.add(update.toolCallId);
      turn.emit({
        type: "tool_end",
        toolUseId: update.toolCallId,
        failed: update.status === "failed",
      });
      if (update.status === "failed") turn.toolCalls.delete(update.toolCallId);
    }
  }

  /** 在常驻进程上执行一轮 prompt：新建/恢复会话、收集通知、软取消与超时。 */
  async runTurn(options: AcpTurnOptions): Promise<CliRunResult> {
    const { prompt, cwd, sessionId, signal, timeoutMs, onEvent, env } = options;
    const effectiveTimeoutMs = cliTimeoutMs(timeoutMs);
    if (signal?.aborted) {
      throw new Error(`${this.adapter.displayName} 执行已取消`);
    }
    if (!cwd.trim()) {
      throw new Error(`${this.adapter.displayName} ACP 需要工作目录 cwd`);
    }
    const timeoutMessage = `${this.adapter.displayName} 执行超时`;
    const turnController = new AbortController();
    const interrupt = (error: Error) => {
      if (!turnController.signal.aborted) turnController.abort(error);
    };
    const timeoutTimer = setTimeout(
      () => interrupt(new Error(timeoutMessage)),
      effectiveTimeoutMs,
    );
    timeoutTimer.unref();
    const abortFromCaller = () =>
      interrupt(new Error(`${this.adapter.displayName} 执行已取消`));
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    const turnSignal = turnController.signal;
    const withDeadline = <T>(operation: Promise<T>): Promise<T> =>
      withInterruption(operation, turnSignal);
    // ACP session/new、resume、load 都要求绝对路径；调用方传相对路径时
    // 统一以 ThreadPilot 当前进程目录解析，避免 DimCode 直接拒绝请求。
    const absoluteWorkingDirectory = resolve(cwd);
    this.activeRuns += 1;
    this.clearIdleTimer();

    let client: acp.ClientContext;
    let observedSessionId = sessionId;
    // 新 session 只有在权限/模式/模型配置成功后才可交给任务层持久化。
    // 配置失败会立即 close 半配置 session，不能把它作为可恢复指针返回。
    let sessionReady = Boolean(sessionId);
    let observerError: Error | undefined;
    const emit = (event: CliEvent) => {
      try {
        onEvent?.(event);
      } catch (error) {
        observerError = asError(error);
      }
    };

    let turn: TurnCollector | undefined;
    let promptStarted = false;
    try {
      client = await withDeadline(this.acquire());
      const allApplicationTools = this.adapter.getApplicationTools?.() ?? [];
      const supportedTransports = this.adapter.getAcpMcpTransports?.();
      const applicationTools = supportedTransports
        ? allApplicationTools.filter((server) =>
            supportedTransports.includes(server.acp?.type ?? "stdio"),
          )
        : allApplicationTools;
      const mcpServers = this.acpMcpServers(
        applicationTools,
        allApplicationTools,
        env,
      );
      const requestedResumeMethod = this.adapter.getAcpResumeMethod?.() ?? "auto";
      const resumeMethod =
        requestedResumeMethod === "auto"
          ? this.capabilities?.sessionCapabilities?.resume
            ? "resume"
            : this.capabilities?.loadSession
              ? "load"
              : undefined
          : requestedResumeMethod;

      const applyConfigOrCleanup = async (
        targetSessionId: string,
        response: AcpSessionResponse,
      ): Promise<void> => {
        try {
          await applySessionConfig(
            client,
            targetSessionId,
            response,
            this.adapter.getAcpSessionConfig?.(),
            this.adapter.displayName,
            turnSignal,
          );
        } catch (error) {
          await this.closeSessionBestEffort(client, targetSessionId);
          this.sessions.delete(targetSessionId);
          throw error;
        }
      };

      if (observedSessionId) {
        if (resumeMethod === "resume") {
          if (!this.capabilities?.sessionCapabilities?.resume) {
            throw new Error(`${this.adapter.displayName} ACP server 不支持 session/resume`);
          }
          const resumed = await withDeadline(
            client.request(acp.methods.agent.session.resume, {
              sessionId: observedSessionId,
              cwd: absoluteWorkingDirectory,
              mcpServers,
            }, { cancellationSignal: turnSignal }),
          );
          this.sessions.add(observedSessionId);
          await withDeadline(
            applyConfigOrCleanup(observedSessionId, sessionResponse(resumed)),
          );
          sessionReady = true;
        } else if (resumeMethod === "load") {
          if (!this.capabilities?.loadSession) {
            throw new Error(`${this.adapter.displayName} ACP server 不支持 session/load`);
          }
          await withDeadline(
            this.loadSessionWithRetry(
              client,
              observedSessionId,
              absoluteWorkingDirectory,
              mcpServers,
              turnSignal,
            ),
          );
          // session/load 返回的模型目录并不稳定，且已加载会话应保留原有
          // permission/mode/model；不要用 session/new 的目录规则重新校验。
          this.sessions.add(observedSessionId);
          sessionReady = true;
        } else {
          throw new Error(`${this.adapter.displayName} ACP server 不支持恢复已有会话`);
        }
      } else {
        const createRequest = client.request(
          acp.methods.agent.session.new,
          {
            cwd: absoluteWorkingDirectory,
            mcpServers,
          },
          { cancellationSignal: turnSignal },
        );
        // ACP 取消是协作式的；若服务端忽略取消并迟到返回，必须主动关闭
        // 这个已不再属于任何任务的 session，避免服务端资源永久泄漏。
        void createRequest.then(
          (created) => {
            if (turnSignal.aborted) {
              void this.closeSessionBestEffort(client, created.sessionId);
            }
          },
          () => undefined,
        );
        const created = await withDeadline(createRequest);
        observedSessionId = created.sessionId;
        this.sessions.add(created.sessionId);
        const configureRequest = applyConfigOrCleanup(
          created.sessionId,
          sessionResponse(created),
        );
        void configureRequest.then(
          () => {
            if (turnSignal.aborted) {
              void this.closeSessionBestEffort(client, created.sessionId);
              this.sessions.delete(created.sessionId);
            }
          },
          () => undefined,
        );
        await withDeadline(configureRequest);
        sessionReady = true;
        // 只有配置成功后才通知任务层写入恢复指针，避免半配置 session 被持久化。
        emit({ type: "session", sessionId: created.sessionId });
      }

      if (!observedSessionId) {
        throw new Error(`${this.adapter.displayName} ACP 没有有效 session ID`);
      }

      const currentTurn: TurnCollector = {
        emit,
        answer: "",
        startedTools: new Set(),
        completedTools: new Set(),
        toolNames: new Map(),
        applicationTools: new Set(),
        applicationToolServers: applicationTools,
        toolCalls: new Map(),
      };
      turn = currentTurn;
      this.turns.set(observedSessionId, currentTurn);
      promptStarted = true;
      const response = await this.racePrompt(
        client,
        observedSessionId,
        prompt,
        turnSignal,
      );
      // ACP server 可能先返回 prompt response，再发送最后一条消息分片；
      // 保留短暂窗口，避免最终答案或工具结果被 finally 提前丢弃。
      await withDeadline(delay(PROMPT_NOTIFICATION_DRAIN_MS, turnSignal));
      currentTurn.stats = { ...currentTurn.stats, ...statsFromUsage(response.usage) };
      if (observerError) throw observerError;
      if (response.stopReason === "cancelled") {
        throw new Error(`${this.adapter.displayName} 执行已取消`);
      }
      if (!currentTurn.answer) throw new Error(`${this.adapter.displayName} 没有返回最终结果`);
      const result: CliRunResult = {
        answer: currentTurn.answer,
        sessionId: observedSessionId,
        ...(currentTurn.stats ? { stats: currentTurn.stats } : {}),
        ...(currentTurn.toolCalls.size > 0
          ? { toolCalls: [...currentTurn.toolCalls.values()] }
          : {}),
      };
      emit({
        type: "result",
        answer: result.answer,
        complete: true,
        ...(result.stats ? { stats: result.stats } : {}),
      });
      return result;
    } catch (error) {
      if (observedSessionId && isSessionUnavailableError(error)) {
        // 失效指针不应在 daemon 收尾时再次 close；上层会清理持久化指针。
        this.sessions.delete(observedSessionId);
      }
      // 会话已在常驻进程中建立；即使本轮失败也能续接，交给会话层持久化。
      throw sessionReady && observedSessionId
        ? new AcpRunError(asError(error).message, observedSessionId, { cause: error })
        : error;
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", abortFromCaller);
      if (turn && observedSessionId) this.turns.delete(observedSessionId);
      this.activeRuns -= 1;
      if (this.activeRuns === 0) {
        // prompt 前的取消意味着 new/load/config 状态可能不确定；没有并发任务时
        // 直接回收连接，确保迟到响应不会影响下一轮。prompt 阶段仍保留软取消复用。
        if (turnSignal.aborted && !promptStarted) await this.recycleIdle();
        else this.scheduleIdleClose();
      }
    }
  }

  /**
   * 等待 prompt 响应，同时处理超时、取消与连接断开。
   * 常驻进程为多任务共享，取消只能发送 session/cancel 通知做软取消，
   * 不能像一次性进程那样直接杀掉整个进程树。
   */
  private async racePrompt(
    client: acp.ClientContext,
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    const promptPromise = client.request(
      acp.methods.agent.session.prompt,
      { sessionId, prompt: [{ type: "text", text: prompt }] },
      { cancellationSignal: signal },
    );

    let abort: (() => void) | undefined;
    let cancelSent = false;
    const sendCancel = () => {
      if (cancelSent) return;
      cancelSent = true;
      // 超时和外部取消都必须停止远端 prompt；取消通知失败时保留原始错误。
      try {
        void Promise.resolve(
          client.notify(acp.methods.agent.session.cancel, { sessionId }),
        ).catch(() => undefined);
      } catch {
        // 连接已关闭时 notify 可能同步抛错，本地中断仍需继续。
      }
    };
    const interrupted = new Promise<never>((_, reject) => {
      const interrupt = (message: string) => {
        sendCancel();
        reject(new Error(message));
      };
      abort = () => {
        // 软取消：通知 agent 停止本轮，本地立即失败；prompt 响应稍后到达时已被忽略。
        interrupt(asError(signal.reason ?? `${this.adapter.displayName} 执行已取消`).message);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });

    // 本轮持有的连接意外关闭时，prompt 请求会被 SDK 拒绝；这里兜底提供稳定错误。
    const connectionClosed = new Promise<never>((_, reject) => {
      void this.connection?.closed.then(
        () =>
          reject(
            new Error(
              this.stderr.trim() || `${this.adapter.displayName} ACP 常驻进程已退出`,
            ),
          ),
        (error) => reject(asError(error)),
      );
    });

    try {
      return await Promise.race([promptPromise, interrupted, connectionClosed]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  /** 空闲回收只释放当前连接，daemon 对象仍可被 CliService 再次复用。 */
  private async recycleIdle(): Promise<void> {
    if (this.closed) return;
    await this.closeConnection(false);
  }

  /** 关闭常驻进程并释放连接；永久关闭仅用于插件卸载。 */
  private async closeConnection(permanent: boolean): Promise<void> {
    if (permanent) this.closed = true;
    if (this.closing) {
      await this.closing;
      return;
    }
    this.closing = (async () => {
      this.clearIdleTimer();
      const client = this.client;
      const connection = this.connection;
      const child = this.child;
      const processTreeSnapshot = this.processTreeSnapshot;
      const sessionIds = [...this.sessions];
      if (client) {
        // ACP 规定 session/close 会取消该 session 的进行中工作并释放资源；
        // 必须在关闭 JSON-RPC 连接和子进程前发送，避免 Dim 锁延迟释放。
        await Promise.all(
          sessionIds.map((sessionId) => this.closeSessionBestEffort(client, sessionId)),
        );
      }
      // 关闭期间若有异常回调或重连，不能误清理后来建立的实例。
      const isCurrent = this.connection === connection && this.child === child;
      if (isCurrent) {
        this.sessions.clear();
        this.markBroken({ child, connection });
      }
      if (connection) {
        connection.close(new Error(`${this.adapter.displayName} ACP 常驻进程已关闭`));
      }
      if (child) {
        await this.stopTree(child, processTreeSnapshot);
      }
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }

  /** 永久关闭常驻进程并释放连接；幂等，供 ThreadPilot 退出时调用。 */
  async close(): Promise<void> {
    await this.closeConnection(true);
  }
}


