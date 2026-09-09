/**
 * tasks 任务编排服务插件：从原 index.ts 抽取的一轮 CLI 执行编排——
 * 启动 active 状态、资源下载、任务卡片、进度流式更新、取消收尾与结果事件。
 * 实际执行前广播 task/started，成功卡片前广播 task/completion-check，
 * 任务结束后按结果广播 result/failed/paused/cancelled；普通消息与后台入口
 * 通过事件 origin 区分，后台入口不触发普通 QA/协作副作用。
 * 由业务插件完成必要的运行时校验与后续接力。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CliAdapter,
  CliEvent,
  CliRunResult,
  CliRunStats,
} from "../cli/types.js";
import {
  CliRunError,
  cliExecutionTimeoutMs,
} from "../cli/runner.js";
import {
  botCliEnvironment,
  type BotConfig,
} from "../core/bot-registry.js";
import {
  interactionPolicyOf,
  type InteractionPolicy,
} from "../core/interaction-policy.js";
import {
  isRetryRequest,
  resolveRetryPrompt,
  type Session,
} from "../core/session-manager.js";
import {
  requestTaskAbort,
  type AbortTaskOutcome,
  type ActiveRun,
} from "../core/task-abort.js";
import { TaskProgressTracker } from "../core/task-progress.js";
import type {
  StartTaskInput,
  TaskCompletionCheckPayload,
  TaskFailureAction,
  TaskFailureActionCollector,
  TaskResultPayload,
  TaskToolMetrics,
  TaskToolCallsOutcome,
  TaskToolCallsPayload,
} from "./types.js";

export { cliExecutionTimeoutMs } from "../cli/runner.js";

/**
 * 在已有会话上执行一次无卡片的 CLI 任务；调用方负责准备最终提示词，
 * TasksService 负责会话占用、运行实例登记、恢复指针和状态清理。
 */
export interface ExecuteOnSessionInput {
  bot: TaskResultPayload["bot"];
  botConfig: BotConfig;
  sessionId: string;
  prompt: string;
  /** 会话已占用后生成最终提示词，确保提示词扩展可读取一致的会话快照。 */
  composePrompt?: (session: Session) => string | Promise<string>;
  /** 未包装的任务文本；未提供时退回最终 prompt，仅供观察者展示。 */
  requestedPrompt?: string;
  ownerOpenId: string;
  replyToMessageId: string;
  hasThread: boolean;
  taskId?: string;
  interaction?: InteractionPolicy;
}

type BackgroundOutcome =
  | { kind: "result"; result: CliRunResult }
  | { kind: "failed"; error: string; stats?: CliRunStats }
  | { kind: "cancelled"; stats?: CliRunStats };

// Token、轮次和 CLI 耗时按执行轮累加；上下文占用与窗口大小是快照，只保留最新值。
function accumulateCliStats(
  current: CliRunStats | undefined,
  next: CliRunStats,
): CliRunStats {
  const sum = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  return {
    durationMs: sum(current?.durationMs, next.durationMs),
    turns: sum(current?.turns, next.turns),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    cacheReadTokens: sum(current?.cacheReadTokens, next.cacheReadTokens),
    cacheCreationTokens: sum(
      current?.cacheCreationTokens,
      next.cacheCreationTokens,
    ),
    contextUsedTokens: next.contextUsedTokens ?? current?.contextUsedTokens,
    contextWindowTokens:
      next.contextWindowTokens ?? current?.contextWindowTokens,
  };
}

/** 一轮任务的运行实例与上下文记忆，供停止、进度和后续任务读取。 */
export class TasksService extends Service {
  /** 每轮运行额外记录发起人和唯一 ID，供卡片按钮鉴权并隔离旧卡片。 */
  private readonly activeRuns = new Map<string, ActiveRun>();
  /** Claude 的模型窗口通常到本轮结束才返回，按会话记忆后供下一轮实时展示。 */
  private readonly contextWindows = new Map<string, number>();

  constructor(ctx: Context) {
    super(ctx, "tasks");
  }

  /** 当前正在执行的轮数；只读查询供状态命令和测试使用。 */
  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  /** 判断指定会话是否存在正在执行的轮次。 */
  hasActiveRun(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  /** 返回会话最近一次观察到的模型上下文窗口大小。 */
  contextWindowFor(sessionId: string): number | undefined {
    return this.contextWindows.get(sessionId);
  }

  /** 请求停止指定的一轮任务；发起人鉴权与旧卡片隔离见 task-abort。 */
  requestAbort(
    sessionId: string,
    runId: string,
    operatorOpenId: string,
  ): AbortTaskOutcome {
    return requestTaskAbort(this.activeRuns, sessionId, runId, operatorOpenId);
  }

  /** /close 专用停止：标记 cancelMode 后广播中止信号。 */
  abortForClose(sessionId: string): void {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.cancelMode = "close";
      active.controller.abort();
    }
  }

  /**
   * 在已有会话上执行后台 CLI 任务。
   * 评论等非普通消息入口不能复制任务生命周期，统一通过此入口运行。
   */
  async executeOnSession(
    input: ExecuteOnSessionInput,
  ): Promise<CliRunResult> {
    const session = await this.claimSession(input.sessionId);
    const activeRun: ActiveRun = {
      controller: new AbortController(),
      ownerOpenId: input.ownerOpenId,
      runId: randomUUID(),
    };
    this.activeRuns.set(session.id, activeRun);
    const taskStartTime = Date.now();
    this.emitTaskClaimed(session.id, activeRun.runId);
    const requestedPrompt = input.requestedPrompt ?? input.prompt;
    const traceId = activeRun.runId;
    let observedStats: CliRunStats | undefined;
    let outcomeEmitted = false;
    const rememberCliSession = this.createCliSessionRecorder(session.id);
    const handleCliEvent = (event: CliEvent) => {
      if (event.type === "session") {
        // 会话 ID 先于最终结果到达；立即写入，后台任务被停止或进程重启后仍可 resume。
        void rememberCliSession(event.sessionId).catch((error) => {
          console.error(
            "[会话] 保存后台任务的 CLI 会话 ID 失败:",
            (error as Error).message,
          );
        });
        return;
      }
      if (event.type === "result" && event.stats) {
        observedStats = event.stats;
      }
    };
    try {
      const prompt = input.composePrompt
        ? await input.composePrompt(session)
        : input.prompt;
      const cliAdapter = this.getSessionAdapter(session);
      const cliEnv = this.getCliEnvironment(
        input.botConfig,
        session,
        undefined,
        input.ownerOpenId,
      );
      await this.ctx
        .parallel("task/started", {
          botConfig: input.botConfig,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          taskId: input.taskId,
          interaction: input.interaction,
          traceId,
          startedAt: taskStartTime,
          requestedPrompt,
          senderOpenId: input.ownerOpenId,
          origin: "background",
        })
        .catch((error) => {
          console.error("[任务] 广播后台开始事件失败:", (error as Error).message);
        });
      try {
        const result = await this.runCliTask(
          cliAdapter,
          prompt,
          session,
          activeRun.controller.signal,
          cliEnv,
          handleCliEvent,
        );
        if (result.sessionId) {
          await rememberCliSession(result.sessionId);
        }
        if (result.stats?.contextWindowTokens) {
          this.contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        if (activeRun.controller.signal.aborted) {
          await this.emitBackgroundOutcome(
            input,
            session,
            activeRun,
            requestedPrompt,
            taskStartTime,
            { kind: "cancelled", stats: observedStats ?? result.stats },
          );
          outcomeEmitted = true;
          throw new Error(`${cliAdapter.displayName} 执行已取消`);
        }
        await this.emitBackgroundOutcome(
          input,
          session,
          activeRun,
          requestedPrompt,
          taskStartTime,
          { kind: "result", result },
        );
        outcomeEmitted = true;
        return result;
      } catch (error) {
        const sessionUnavailable =
          error instanceof CliRunError &&
          Boolean(cliAdapter.isSessionUnavailable?.(error.message)) &&
          Boolean(session.cliSessionId);
        if (sessionUnavailable) {
          await this.ctx.sessions.manager.clearCliSessionId(session.id);
        }
        if (
          error instanceof CliRunError &&
          error.sessionId &&
          !sessionUnavailable
        ) {
          await rememberCliSession(error.sessionId);
        }
        if (!outcomeEmitted) {
          if (activeRun.controller.signal.aborted) {
            await this.emitBackgroundOutcome(
              input,
              session,
              activeRun,
              requestedPrompt,
              taskStartTime,
              { kind: "cancelled", stats: observedStats },
            );
          } else {
            await this.emitBackgroundOutcome(
              input,
              session,
              activeRun,
              requestedPrompt,
              taskStartTime,
              { kind: "failed", error: (error as Error).message, stats: observedStats },
            );
          }
          outcomeEmitted = true;
        }
        throw error;
      }
    } finally {
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      try {
        await this.markSessionIdle(session.id);
      } catch (error) {
        console.error(
          "[会话] 后台任务收尾时恢复空闲状态失败:",
          (error as Error).message,
        );
      }
    }
  }

  /** 等待并原子占用已有会话；后台入口与普通任务共用同一状态边界。 */
  private async claimSession(sessionId: string): Promise<Session> {
    while (true) {
      const session = this.ctx.sessions.manager.get(sessionId);
      if (!session || session.status === "closed") {
        throw new Error("会话已经失效");
      }
      if (session.status === "idle") {
        if (!session.cliSessionId) {
          throw new Error("会话对应的 CLI 会话不存在");
        }
        try {
          return await this.ctx.sessions.manager.transition(session.id, "active");
        } catch (error) {
          // 另一个入口可能刚刚抢占会话；仍是 active 时回到队列等待。
          if (this.ctx.sessions.manager.get(sessionId)?.status === "active") {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            continue;
          }
          throw error;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  private getSessionAdapter(session: Session): CliAdapter {
    return this.ctx.cli.get(session.cliId, session.accessMode ?? "headless");
  }

  /** 创建统一的 CLI 会话 ID 记录器，覆盖流式事件、成功结果和失败结果。 */
  private createCliSessionRecorder(
    sessionId: string,
    onObserved?: (cliSessionId: string) => void,
  ): (cliSessionId: string) => Promise<void> {
    let pendingCliSessionSave: Promise<void> | undefined;
    return async (cliSessionId: string) => {
      onObserved?.(cliSessionId);
      if (
        this.ctx.sessions.manager.get(sessionId)?.cliSessionId === cliSessionId
      ) {
        await pendingCliSessionSave;
        return;
      }
      const save = this.ctx.sessions.manager.setCliSessionId(
        sessionId,
        cliSessionId,
      );
      pendingCliSessionSave = save.then(() => undefined);
      await pendingCliSessionSave;
    };
  }

  /** 广播后台任务终态；观察者异常不能改变 CLI 任务本身的成功或失败。 */
  private async emitBackgroundOutcome(
    input: ExecuteOnSessionInput,
    session: Session,
    activeRun: ActiveRun,
    requestedPrompt: string,
    startedAt: number,
    outcome: BackgroundOutcome,
  ): Promise<void> {
    const payload: TaskResultPayload = {
      bot: input.bot,
      botConfig: input.botConfig,
      session: this.ctx.sessions.manager.get(session.id) ?? session,
      requestedPrompt,
      answer: outcome.kind === "result" ? outcome.result.answer : "",
      replyToMessageId: input.replyToMessageId,
      hasThread: input.hasThread,
      taskId: input.taskId,
      interaction: input.interaction,
      senderOpenId: input.ownerOpenId,
      origin: "background",
      durationMs: Date.now() - startedAt,
      stats:
        outcome.kind === "result"
          ? outcome.result.stats
          : outcome.stats,
      toolCalls: outcome.kind === "result" ? outcome.result.toolCalls : undefined,
      traceId: activeRun.runId,
      ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
    };
    try {
      if (outcome.kind === "result") {
        await this.ctx.parallel("task/result", payload);
      } else if (outcome.kind === "failed") {
        await this.ctx.parallel("task/failed", payload);
      } else {
        await this.ctx.parallel("task/cancelled", payload);
      }
    } catch (error) {
      console.error(
        `[任务] 广播后台${outcome.kind === "result" ? "结果" : outcome.kind === "failed" ? "失败" : "取消"}事件失败:`,
        (error as Error).message,
      );
    }
  }

  /** 统一合并 bot 代理和应用工具插件提供的 CLI 环境。 */
  private getCliEnvironment(
    botConfig: BotConfig,
    session: Session,
    collaboration: StartTaskInput["collaboration"],
    senderOpenId: string,
  ): Record<string, string> {
    return {
      ...(botCliEnvironment(botConfig) ?? {}),
      ...(this.ctx.bail("task/cli-environment", {
        session,
        collaboration,
        senderOpenId,
      }) ?? {}),
    };
  }

  /** 广播会话已被本轮占用；可选监听器异常不能回滚已经成功的状态迁移。 */
  private emitTaskClaimed(sessionId: string, runId: string): void {
    try {
      this.ctx.emit("task/claimed", { sessionId, runId });
    } catch (error) {
      console.error("[任务] 广播会话占用事件失败:", (error as Error).message);
    }
  }

  private async markSessionIdle(sessionId: string): Promise<void> {
    // /close 可能与后台 finally 同时发生；已关闭会话不能被迟到的清理逻辑改回 idle。
    if (this.ctx.sessions.manager.get(sessionId)?.status !== "active") return;
    await this.ctx.sessions.manager.transition(sessionId, "idle");
    console.log(`[会话] id=${sessionId} status=idle`);
  }

  /** 启动一轮任务；返回是否已完成前置准备并进入执行链，运行期结果仍走任务事件。 */
  async startTask(input: StartTaskInput): Promise<boolean> {
    try {
      return await this.runTask(input);
    } catch (error) {
      console.error("[任务] 启动失败:", (error as Error).message);
      if (this.activeRuns.has(input.session.id)) {
        this.activeRuns.delete(input.session.id);
      }
      try {
        await this.markSessionIdle(input.session.id);
      } catch (cleanupError) {
        console.error(
          "[会话] 启动失败后恢复空闲状态失败:",
          (cleanupError as Error).message,
        );
      }
      return false;
    }
  }

  private async runTask(input: StartTaskInput): Promise<boolean> {
    const {
      bot,
      botConfig,
      session,
      hasThread,
      replyToMessageId,
      senderOpenId,
      senderUnionId,
      taskId,
      requestedPrompt,
      originalRequestedPrompt,
      isCompacting,
      compactInstructions,
      collaboration,
      senderRuntime,
      resources,
      suppressHandoff,
    } = input;
    const interaction = interactionPolicyOf(input);
    // direct/standalone 是任务级硬边界：无论模型调用了什么应用工具，
    // 结果事件都不能触发 QA 或其他自动交接。
    const effectiveSuppressHandoff =
      suppressHandoff || interaction.capabilities.suppressHandoff;
    const cliAdapter = this.getSessionAdapter(session);
    const taskTitle = isCompacting ? "整理上下文" : cliAdapter.displayName;
    const taskStartTime = Date.now();

    const currentSession = this.ctx.sessions.manager.get(session.id);
    if (
      !currentSession ||
      (currentSession.status !== "creating" && currentSession.status !== "idle")
    ) {
      throw new Error(
        `会话 ${currentSession?.status ?? "missing"} 不能启动新任务`,
      );
    }
    const run = new AbortController();
    const activeRun: ActiveRun = {
      controller: run,
      ownerOpenId: senderOpenId,
      runId: randomUUID(),
    };
    // transition 在首次 await 前同步把内存状态置为 active；紧接着登记运行实例，
    // 让同一事件循环中的后续入口无法越过状态检查，/close 也能立即取得取消句柄。
    const claim = this.ctx.sessions.manager.transition(session.id, "active");
    this.activeRuns.set(session.id, activeRun);
    try {
      await claim;
      this.emitTaskClaimed(session.id, activeRun.runId);
    } catch (error) {
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      throw error;
    }

    // 503 等错误可能发生在 CLI 返回会话 ID 之前；先保存实际任务，明确重试时才能重放。
    // 先用未包装的原始指令识别“继续执行”，避免角色前缀破坏重试判断。
    let prompt = "";
    try {
      prompt = await this.buildTaskPrompt(
        botConfig,
        resolveRetryPrompt(session, requestedPrompt),
        interaction,
        session,
      );
      // “继续执行”只消费原始待重试指令，不能把它覆盖成恢复失败后的短语。
      if (
        !isCompacting &&
        (!session.retryPrompt || !isRetryRequest(requestedPrompt))
      ) {
        await this.ctx.sessions.manager.setRetryPrompt(
          session.id,
          requestedPrompt,
        );
      }
    } catch (error) {
      // 已认领会话但尚未进入执行链；准备失败必须释放运行实例并允许用户重试。
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      try {
        await this.markSessionIdle(session.id);
      } catch (cleanupError) {
        console.error(
          "[会话] 任务准备失败后恢复空闲状态失败:",
          (cleanupError as Error).message,
        );
      }
      throw error;
    }

    for (const resource of resources) {
      try {
        const savePath = await bot.downloadResource(
          replyToMessageId,
          resource.key,
          resource.type,
          join("data", "downloads"),
          resource.fileName,
        );
        console.log(`  [下载] ${resource.type} → ${savePath}`);
      } catch (error) {
        console.error(
          `  [下载失败] ${resource.key}:`,
          (error as Error).message,
        );
      }
    }

    // /close 可能在附件下载期间到达；关闭后不能再发送卡片或启动 CLI。
    if (run.signal.aborted) {
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      return false;
    }

    let cardId: string | undefined;
    try {
      cardId = await bot.replyCard(
        replyToMessageId,
        this.ctx.cards.task({
          title: taskTitle,
          status: "running",
          detail: isCompacting
            ? cliAdapter.compactDetail && compactInstructions
              ? `${cliAdapter.displayName} 正在${cliAdapter.compactDetail}`
              : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
            : "正在理解任务",
          abortSessionId: session.id,
          abortRunId: activeRun.runId,
        }),
        hasThread,
      );
    } catch (error) {
      // 任务尚未真正启动；创建卡片失败时必须撤销 active 状态，允许用户重试。
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      await this.markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新");
      // 飞书成功响应也可能缺少 ID，此时同样按启动失败回收会话状态。
      if (this.activeRuns.get(session.id) === activeRun) {
        this.activeRuns.delete(session.id);
      }
      await this.markSessionIdle(session.id);
      return false;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

    const progress = new TaskProgressTracker(
      Date.now,
      this.contextWindowFor(session.id),
      !session.cliSessionId,
    );
    let observedCliSessionId = session.cliSessionId;
    let observedStats: CliRunStats | undefined;
    const observedToolMetrics = new Map<
      string,
      { invocations: number; failures: number }
    >();
    const observedToolNames = new Map<string, string>();
    const observedToolIds = new Set<string>();
    const observedFailedToolIds = new Set<string>();
    let currentExecutionStatsObserved = false;
    const beginCliExecution = () => {
      // 纠正轮可能复用工具调用 ID；去重范围只覆盖单次 CLI 执行。
      observedToolNames.clear();
      observedToolIds.clear();
      observedFailedToolIds.clear();
      currentExecutionStatsObserved = false;
    };
    const snapshotToolMetrics = (): TaskToolMetrics =>
      Object.fromEntries(
        [...observedToolMetrics.entries()].map(([toolName, metrics]) => [
          toolName,
          { ...metrics },
        ]),
      );
    const rememberCliSession = this.createCliSessionRecorder(
      session.id,
      (cliSessionId) => {
        observedCliSessionId = cliSessionId;
      },
    );
    const cardUpdater = this.ctx.cards.throttled(async (card) => {
      try {
        await bot.updateCard(cardId, card);
      } catch (error) {
        console.error("[卡片] 更新失败:", (error as Error).message);
        throw error;
      }
    });
    let cancellationEmitted = false;
    const renderProgress = (snapshot = progress.snapshot()) => {
      cardUpdater.push(
        this.ctx.cards.task({
          title: taskTitle,
          status: "running",
          detail: isCompacting
            ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
            : snapshot.current,
          ...(!isCompacting ? { progress: snapshot } : {}),
          abortSessionId: session.id,
          abortRunId: activeRun.runId,
        }),
      );
    };
    const finishCancelled = async () => {
      console.log(`[CLI] 任务已取消 engine=${session.cliId}`);
      try {
        await cardUpdater.finish(
          this.ctx.cards.task({
            title: taskTitle,
            status: "cancelled",
            detail:
              activeRun.cancelMode === "close"
                ? "本次任务已停止，当前会话已经关闭。"
                : isCompacting
                  ? "整理已停止，当前 CLI 会话没有改变。"
                  : "本次任务已停止。你可以继续在当前话题里提问。",
            ...(!isCompacting ? { progress: progress.snapshot() } : {}),
          }),
        );
      } finally {
        if (!isCompacting && !cancellationEmitted) {
          cancellationEmitted = true;
          await this.ctx.parallel("task/cancelled", {
            bot,
            botConfig,
            session: this.ctx.sessions.manager.get(session.id) ?? session,
            requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
            answer: "",
            replyToMessageId,
            hasThread,
            collaboration,
            senderRuntime,
            taskId,
            suppressHandoff: effectiveSuppressHandoff,
            interaction,
            senderOpenId,
            senderUnionId,
            durationMs: Date.now() - taskStartTime,
            stats: observedStats,
            toolMetrics: snapshotToolMetrics(),
            traceId: activeRun.runId,
            origin: "message",
          });
        }
      }
    };
    // 没有新事件时心跳仍会推进耗时；节流器确保最终每秒最多一次 patch。
    const progressHeartbeat = setInterval(renderProgress, 1_000);
    progressHeartbeat.unref();

    // 不等待 CLI，确保长连接仍能接收 /status 和 /close 等控制消息。
    // bot 配置了网络代理（如 agy 访问云端服务）时，把标准代理变量注入 CLI 子进程并
    // 覆盖全局配置（bots.json 的 proxy 优先于 .env 的 HTTP_PROXY 等）；
    // 不配置则继承父进程环境，.env 的全局代理变量自然生效。
    const cliEnv = this.getCliEnvironment(
      botConfig,
      session,
      collaboration,
      senderOpenId,
    );
    const handleCliEvent = (event: CliEvent) => {
      if (
        event.type === "result" &&
        event.stats &&
        !currentExecutionStatsObserved
      ) {
        currentExecutionStatsObserved = true;
        observedStats = accumulateCliStats(observedStats, event.stats);
      }
      if (event.type === "tool_start" || event.type === "tool_call") {
        observedToolNames.set(event.toolUseId, event.toolName);
        if (!observedToolIds.has(event.toolUseId)) {
          observedToolIds.add(event.toolUseId);
          const metrics = observedToolMetrics.get(event.toolName) ?? {
            invocations: 0,
            failures: 0,
          };
          metrics.invocations += 1;
          observedToolMetrics.set(event.toolName, metrics);
        }
      }
      if (
        event.type === "tool_end" &&
        event.failed &&
        !observedFailedToolIds.has(event.toolUseId)
      ) {
        observedFailedToolIds.add(event.toolUseId);
        const toolName = observedToolNames.get(event.toolUseId);
        if (toolName) {
          const metrics = observedToolMetrics.get(toolName);
          if (metrics) metrics.failures += 1;
        }
      }
      if (event.type === "session") {
        // 会话 ID 先于最终结果到达；立即写入，任务被停止或进程重启后仍可 resume。
        void rememberCliSession(event.sessionId).catch((error) => {
          console.error(
            "[会话] 保存实时 CLI 会话 ID 失败:",
            (error as Error).message,
          );
        });
        return;
      }
      if (
        event.type !== "tool_start" &&
        event.type !== "tool_end" &&
        event.type !== "context"
      ) {
        return;
      }

      const snapshot = progress.accept(event);
      const currentDetail = snapshot.currentDetail
        ? ` detail=${snapshot.currentDetail}`
        : "";
      const context =
        snapshot.contextUsedTokens === undefined
          ? ""
          : ` context=${snapshot.contextUsedTokens}`;
      console.log(
        `[进度] ${snapshot.current}${currentDetail} tools=${snapshot.completedCount}/${snapshot.toolCount}${context}`,
      );
      renderProgress(snapshot);
    };
    if (!isCompacting) {
      // 开始事件只提供旁路观测，不得因可选监听器异常或耗时而阻断 CLI 主流程。
      // 携带 requestedPrompt/senderOpenId/collaboration，供看板等观察者展示标题、
      // 发起人并识别 QA 轮；旧广播缺省这些字段时消费者按 undefined 处理。
      void this.ctx
        .parallel("task/started", {
          botConfig,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          taskId,
          interaction,
          traceId: activeRun.runId,
          startedAt: taskStartTime,
          requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
          ...(senderOpenId ? { senderOpenId } : {}),
          ...(collaboration ? { collaboration } : {}),
          origin: "message",
        })
        .catch((error) => {
          const detail =
            error instanceof AggregateError
              ? error.errors
                  .map((item) =>
                    item instanceof Error ? item.message : String(item),
                  )
                  .join("; ")
              : error instanceof Error
                ? error.message
                : String(error);
          console.error(
            "[任务] 广播开始事件失败:",
            detail,
          );
        });
    }
    const runCorrection = async (correctionPrompt: string) => {
      const correctionSession =
        this.ctx.sessions.manager.get(session.id) ?? session;
      // 纠正轮沿用本轮私聊/群聊语义（角色与团队上下文策略一致）。
      const prompt = await this.buildTaskPrompt(
        botConfig,
        correctionPrompt,
        interaction,
        correctionSession,
      );
      beginCliExecution();
      const corrected = await this.runCliTask(
        cliAdapter,
        prompt,
        correctionSession,
        run.signal,
        cliEnv,
        handleCliEvent,
      );
      if (corrected.stats && !currentExecutionStatsObserved) {
        observedStats = accumulateCliStats(observedStats, corrected.stats);
      }
      if (corrected.sessionId) await rememberCliSession(corrected.sessionId);
      return corrected;
    };
    beginCliExecution();
    const execution = isCompacting
      ? this.ctx.cli
          .compact({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: compactInstructions,
            signal: run.signal,
            env: cliEnv,
          })
          .then((result) => ({
            answer: result.message ?? "",
            sessionId: result.sessionId,
            stats: undefined,
            toolCalls: undefined,
          }))
      : this.runCliTask(
          cliAdapter,
          prompt,
          session,
          run.signal,
          cliEnv,
          handleCliEvent,
        ).then((result) => {
          if (result.stats && !currentExecutionStatsObserved) {
            observedStats = accumulateCliStats(observedStats, result.stats);
          }
          return result;
        });

    void execution
      .then(async (result) => {
        clearInterval(progressHeartbeat);
        if (!isCompacting && result.sessionId) {
          await rememberCliSession(result.sessionId);
        }
        // /close、按钮和子进程退出可能竞态；取消后只能写灰色终态。
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        const initialTaskResultPayload: TaskResultPayload = {
          bot,
          botConfig,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
          answer: result.answer,
          replyToMessageId,
          hasThread,
          collaboration,
          senderRuntime,
          taskId,
          suppressHandoff: effectiveSuppressHandoff,
          interaction,
          senderOpenId,
          origin: "message",
          senderUnionId,
          durationMs: Date.now() - taskStartTime,
          stats: observedStats ?? result.stats,
          toolCalls: result.toolCalls,
          toolMetrics: snapshotToolMetrics(),
          traceId: activeRun.runId,
        };
        if (!isCompacting && result.stats?.contextWindowTokens) {
          this.contextWindows.set(session.id, result.stats.contextWindowTokens);
        }
        const publishToolOutcome = async (
          outcome: TaskToolCallsOutcome,
          resultPayload: TaskResultPayload,
          toolResult: typeof result,
        ) => {
          await cardUpdater.finish(outcome.card);
          await outcome.afterCardPublished?.();
          if (outcome.notificationText && !collaboration) {
            await bot.sendResultNotification({
              replyToMessageId,
              target: { openId: senderOpenId, name: "" },
              text: outcome.notificationText,
              replyInThread: hasThread,
            });
          }
          if (outcome.completion === "completed") {
            // 完成型应用工具替换普通成功卡片，但仍需广播结果供编排收口；
            // 产品文档等流程可通过 suppressHandoff 阻止继续自动交接。
            await this.ctx.parallel("task/result", {
              ...resultPayload,
              suppressHandoff:
                outcome.suppressHandoff ?? resultPayload.suppressHandoff,
            });
          } else {
            await this.ctx.parallel("task/paused", resultPayload);
          }
          console.log(
            `[CLI] ${cliAdapter.id} 已交给应用工具处理 session_id=${toolResult.sessionId ?? "(无)"}`,
          );
        };
        // 澄清等暂停型应用工具必须先认领，不能被产品方案的“成功提交”校验打断。
        if (!isCompacting && result.toolCalls?.length) {
          const initialToolPayload: TaskToolCallsPayload = {
            ...initialTaskResultPayload,
            result,
            runId: activeRun.runId,
            senderOpenId,
            senderUnionId,
            interaction,
            cardMessageId: cardId,
          };
          const initialToolOutcome = await this.ctx.serial(
            "task/tool-calls",
            initialToolPayload,
          );
          if (initialToolOutcome) {
            if (!isCompacting) {
              await this.ctx.sessions.manager.setRetryPrompt(session.id, undefined);
            }
            await publishToolOutcome(
              initialToolOutcome,
              initialTaskResultPayload,
              result,
            );
            return;
          }
        }
        let completedResult = result;
        if (!isCompacting) {
          const completionPayload: TaskCompletionCheckPayload = {
            ...initialTaskResultPayload,
            result,
            runId: activeRun.runId,
            senderOpenId,
            senderUnionId,
            interaction,
            cardMessageId: cardId,
            signal: run.signal,
            runCorrection,
          };
          const completionOutcome = await this.ctx.serial(
            "task/completion-check",
            completionPayload,
          );
          if (completionOutcome) completedResult = completionOutcome.result;
          if (run.signal.aborted) {
            await finishCancelled();
            return;
          }
          if (completedResult.sessionId) {
            await rememberCliSession(completedResult.sessionId);
          }
          if (completedResult.stats?.contextWindowTokens) {
            this.contextWindows.set(
              session.id,
              completedResult.stats.contextWindowTokens,
            );
          }
          await this.ctx.sessions.manager.setRetryPrompt(session.id, undefined);
        }
        const taskResultPayload: TaskResultPayload = {
          ...initialTaskResultPayload,
          session: this.ctx.sessions.manager.get(session.id) ?? session,
          answer: completedResult.answer,
          stats: observedStats ?? completedResult.stats ?? initialTaskResultPayload.stats,
          toolCalls: completedResult.toolCalls ?? initialTaskResultPayload.toolCalls,
          toolMetrics: snapshotToolMetrics(),
          durationMs: Date.now() - taskStartTime,
        };
        if (!isCompacting && completedResult.toolCalls?.length) {
          const toolPayload: TaskToolCallsPayload = {
            ...taskResultPayload,
            result: completedResult,
            runId: activeRun.runId,
            senderOpenId,
            senderUnionId,
            interaction,
            cardMessageId: cardId,
          };
          const outcome = await this.ctx.serial("task/tool-calls", toolPayload);
          if (outcome) {
            await publishToolOutcome(outcome, taskResultPayload, completedResult);
            return;
          }
        }
        await cardUpdater.finish(
          isCompacting
            ? this.ctx.cards.notice({
                title: result.answer ? "暂时无需整理" : "上下文已整理",
                template: result.answer ? "grey" : "green",
                detail:
                  result.answer ||
                  [
                    `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                    "CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。",
                  ].join("\n\n"),
              })
            : this.ctx.cards.task({
                title: taskTitle,
                status: "success",
                detail: "执行完成",
                progress: progress.snapshot(),
                answer: completedResult.answer,
                stats: taskResultPayload.stats,
              }),
        );
        if (
          !isCompacting &&
          this.ctx.cards.needsContinuation(completedResult.answer)
        ) {
          for (const chunk of this.ctx.cards.splitLongText(
            this.ctx.cards.continuation(completedResult.answer),
          )) {
            if (run.signal.aborted) break;
            await bot.reply(replyToMessageId, chunk, hasThread);
          }
        }
        console.log(
          `[CLI] ${cliAdapter.id} 完成 session_id=${completedResult.sessionId ?? "(无)"}`,
        );
        if (!collaboration) {
          await bot.sendResultNotification({
            replyToMessageId,
            target: { openId: senderOpenId, name: "" },
            text: isCompacting
              ? "上下文整理已完成，请查看上方结果。"
              : "任务已完成，请查看上方结果。",
            replyInThread: hasThread,
          });
        }
        if (!isCompacting) {
          // 协作交接走事件广播，collaboration 插件自行决定是否继续派发。
          await this.ctx.parallel("task/result", taskResultPayload);
        }
      })
      .catch(async (error) => {
        clearInterval(progressHeartbeat);
        const errorMessage = (error as Error).message;
        const currentSession =
          this.ctx.sessions.manager.get(session.id) ?? session;
        const sessionUnavailable =
          error instanceof CliRunError &&
          Boolean(cliAdapter.isSessionUnavailable?.(errorMessage)) &&
          Boolean(currentSession.cliSessionId);
        const failedCliSessionId =
          (error instanceof CliRunError ? error.sessionId : undefined) ??
          observedCliSessionId;
        if (!isCompacting && failedCliSessionId) {
          try {
            // 进程虽失败，但已建立的线程仍可续接，不能等成功路径才保存。
            await rememberCliSession(failedCliSessionId);
          } catch (persistError) {
            console.error(
              "[会话] 保存失败任务的 CLI 会话 ID 失败:",
              (persistError as Error).message,
            );
          }
        }
        if (sessionUnavailable) {
          try {
            // 续聊指针已失效；清掉后下一次“继续执行”才会按原任务新建会话。
            await this.ctx.sessions.manager.clearCliSessionId(session.id);
            console.warn(
              `[会话] CLI 会话已失效，将在下次重试时重新建立 engine=${cliAdapter.id}`,
            );
          } catch (persistError) {
            console.error(
              "[会话] 清除失效 CLI 会话 ID 失败:",
              (persistError as Error).message,
            );
          }
        }
        if (run.signal.aborted) {
          await finishCancelled();
          return;
        }
        console.error(`[CLI] 执行失败 engine=${cliAdapter.id}:`, errorMessage);
        const failureActions: TaskFailureAction[] = [];
        const failureActionCollector: TaskFailureActionCollector = {
          add(action) {
            failureActions.push(action);
          },
        };
        if (!isCompacting) {
          try {
            await this.ctx.parallel(
              "task/failure-actions",
              failureActionCollector,
              {
                input,
                sessionId: session.id,
                runId: activeRun.runId,
              },
            );
          } catch (actionError) {
            // 失败动作是可选增强；插件异常不能覆盖原任务的失败收尾。
            console.error(
              "[任务] 收集失败卡片动作失败:",
              (actionError as Error).message,
            );
          }
        }
        await cardUpdater.finish(
          this.ctx.cards.task({
            title: taskTitle,
            status: "failed",
            detail: isCompacting
              ? "上下文整理失败，当前 CLI 会话没有改变。"
              : sessionUnavailable
                ? "会话已失效。发送“继续执行”将重新建立会话并继续原任务。"
                : "执行没有完成。你可以调整指令后在当前话题重试。",
            technicalDetail: errorMessage,
            ...(failureActions.length ? { actions: failureActions } : {}),
            ...(!isCompacting ? { progress: progress.snapshot() } : {}),
          }),
        );
        if (!isCompacting) {
          // 失败也走事件广播（与 task/result 语义区分）：编排等可选插件据此标记
          // 子任务失败；collaboration 不监听本事件，不会误触发审查交接。
          // error 与 senderOpenId 供 auth 插件识别认证需求并发起登录卡片。
          await this.ctx.parallel("task/failed", {
            bot,
            botConfig,
            session: this.ctx.sessions.manager.get(session.id) ?? session,
            requestedPrompt: originalRequestedPrompt ?? requestedPrompt,
            answer: "",
            replyToMessageId,
            hasThread,
            collaboration,
            senderRuntime,
            taskId,
            suppressHandoff: effectiveSuppressHandoff,
            interaction,
            senderOpenId,
            senderUnionId,
            error: errorMessage,
            durationMs: Date.now() - taskStartTime,
            stats: observedStats,
            toolMetrics: snapshotToolMetrics(),
            traceId: activeRun.runId,
            origin: "message",
          });
        }
      })
      .finally(async () => {
        clearInterval(progressHeartbeat);
        // 仅清理自己登记的运行实例，防止旧任务的迟到回调删除同会话的新任务。
        if (this.activeRuns.get(session.id) === activeRun) {
          this.activeRuns.delete(session.id);
        }
        try {
          await this.markSessionIdle(session.id);
        } catch (error) {
          console.error(
            "[会话] 保存空闲状态失败:",
            (error as Error).message,
          );
        }
      })
      .catch((error) => {
        // 卡片更新、飞书回复或 finally 持久化失败也必须被消费，避免未处理拒绝。
        console.error("[任务] 回传或收尾失败:", (error as Error).message);
      });
    return true;
  }

  /** 通过 cli 服务启动一轮 CLI 子进程并转发流式事件。 */
  private runCliTask(
    adapter: CliAdapter,
    prompt: string,
    session: Session,
    signal: AbortSignal,
    env: Record<string, string> | undefined,
    onEvent: (event: CliEvent) => void,
  ) {
    console.log(
      `[CLI] 启动 engine=${adapter.id} access_mode=${adapter.accessMode} cwd=${session.workspaceDir}`,
    );
    return this.ctx.cli.run({
      adapter,
      prompt,
      cwd: session.workspaceDir,
      sessionId: session.cliSessionId,
      signal,
      timeoutMs: cliExecutionTimeoutMs(adapter.id),
      env,
      onEvent,
      botId: session.botId,
    });
  }

  private async buildTaskPrompt(
    botConfig: BotConfig,
    promptText: string,
    interaction: InteractionPolicy,
    session: Session,
  ): Promise<string> {
    return await this.ctx.prompts.composeTaskPrompt(botConfig, promptText, {
      interaction,
      session,
      defaultProductDeliveryMode: this.ctx.config.defaultProductDeliveryMode,
    });
  }
}

export const name = "tasks";
export const inject = ["config", "prompts", "sessions", "cli", "cards"];

export function apply(ctx: Context) {
  // 环境变量属于启动配置；先按实际启用的引擎校验，避免任务进入 active 后才发现格式错误。
  for (const cliId of new Set(ctx.config.bots.map((bot) => bot.defaultCliId))) {
    cliExecutionTimeoutMs(cliId);
  }
  new TasksService(ctx);
}
