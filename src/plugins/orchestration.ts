/**
 * orchestration 编排服务插件：把一个大任务拆成多个子任务并行派发给不同 bot，
 * 并汇总子任务结果供 /panel 展示。派发方式由插件 config 的 dispatchMode 决定：
 * 默认 topic（每个子任务在编排群内发一条新根消息 @ 目标 bot，形成独立话题，
 * 同一 bot 可跨话题并行承接多个子任务）；不同 bot 必须配置不同 workspace，
 * 避免并发写入同一工作树；same-topic 是 P0 降级方案（在当前话题
 * 回复派发）。每个子任务构造协作交接单（round=1/maxRounds=1）经 ctx.collaboration
 * 注册，再由 @ 消息派发——目标 bot 走现有 router 的协作识别启动任务；
 * 成功/失败分别由 task/result、task/failed 事件驱动子任务状态。
 * 运行表有界：已完成的 run 只保留最近 MAX_RUNS 条；pending run 由 pendingTimeoutMs
 * 超时收口，防止无界增长。run 同时记录 chatId/botId，/panel 按来源租户过滤。topic 模式允许
 * 同一 bot 承接多个子任务（各自独立话题并行）；same-topic 降级时同一 bot 多子任务
 * 会被拆解校验整轮拒绝（当前话题回复会因 router busy 拒绝第二个）。
 * 本服务不直接 import 卡片渲染实现：实时面板由可选插件 orchestration/live-panel
 * 订阅 orchestration/update 事件完成（创建 run 后广播一次带锚点，状态变化时广播
 * run 快照，run 淘汰时广播 orchestration/evicted）；live-panel 下线时事件无消费者，
 * 空转无害，/orchestrate 仍按本服务回复汇总文本。
 * P0-3 失败子任务一键重试：面板卡片上为 failed 子任务渲染「重试」按钮，点击后
 * 经可选插件 orchestration/actions 调用本服务的 retrySubTask 重新派发（复用协作
 * 交接单）。鉴权只信飞书回调的 operatorOpenId、一次性重试令牌防重复点击、次数
 * 受插件 config 的 maxRetry 约束。actions 插件下线时 enableRetry 不执行，面板
 * 不渲染重试按钮，保留手动「继续执行」降级路径。
 */
import { Service, type Context } from "cordis";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import { botCliEnvironment, type BotConfig } from "../core/bot-registry.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import {
  MAX_RUNS,
  isRunTerminal,
  nextRunId,
  parseRetryToken,
  parseSubTaskSpecs,
  parseSubTaskTaskId,
  subTaskTaskId,
  trimRuns,
  type OrchestrationRun,
  type OrchestrationSubTask,
  type SubTaskSpec,
} from "../core/orchestration.js";
import type { Session } from "../core/session-manager.js";
import type { Bot, IncomingMessage } from "../im/lark.js";
import type {
  OrchestrationEvictedPayload,
  OrchestrationUpdatePayload,
  TaskResultPayload,
} from "./types.js";

/** 编排拆解 CLI 调用的最长等待时间；拆解只需一次规划，不应无限等待。 */
const DECOMPOSE_TIMEOUT_MS = 120_000;

/** 单个编排 run 等待子任务结果的默认上限；设为 0 可显式关闭超时。 */
const DEFAULT_PENDING_TIMEOUT_MS = 30 * 60 * 1000;

/** 子任务派发方式：topic=独立新话题派发（默认），same-topic=当前话题回复派发（P0 降级）。 */
export type DispatchMode = "topic" | "same-topic";

/** 重试子任务的拒绝原因；ok=false 时 actions 插件据此映射 toast。 */
export type RetrySubTaskReason =
  | "not_found"
  | "not_failed"
  | "forbidden"
  | "limit"
  | "duplicate"
  | "bad_token"
  | "dispatch_failed";

/** retrySubTask 的返回契约：ok=true 已重新派发；否则 reason 说明拒绝原因。 */
export interface RetrySubTaskResult {
  ok: boolean;
  reason?: RetrySubTaskReason;
  /** dispatch_failed 时携带底层派发错误信息。 */
  message?: string;
}

/** /panel 查询条件：运行必须同时属于当前群聊和当前 bot。 */
export interface OrchestrationListFilter {
  chatId: string;
  botId: string;
}

/** 重试重新派发所需的最小上下文：与创建 run 时的派发参数一致，记录在运行表之外。 */
interface RunDispatchContext {
  bot: Bot;
  fromBotId: string;
  chatId: string;
  replyToMessageId: string;
  hasThread: boolean;
}

/** 启动一次编排所需的全部输入，由 /orchestrate 命令插件组装。 */
export interface StartOrchestrationOptions {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  hasThread: boolean;
  message: IncomingMessage;
  prompt: string;
}

/**
 * 构造让编排 bot 输出结构化子任务清单的提示词；成员 id 来自 bot 注册表。
 * 模式参数约束同 bot 多子任务：same-topic 只允许每个成员承接一个子任务（当前话题
 * 回复派发会因 router busy 拒绝第二个）；topic 允许多个子任务选择同一 bot（每个
 * 子任务独立新话题派发，只需子任务 ID 互不相同）。
 */
function buildDecomposePrompt(
  ctx: Context,
  members: string[],
  task: string,
  mode: DispatchMode,
): string {
  return ctx.prompts.render("orchestration.decompose", { members, task, mode });
}

/** 编排服务：维护有界运行表、派发子任务并监听任务事件汇总结果。 */
export class OrchestrationService extends Service {
  /** 运行表：完成一次编排即清理最旧的历史 run，见 trimRuns，避免无界增长。 */
  private readonly runs = new Map<string, OrchestrationRun>();
  /** 子任务派发方式，由插件 config 决定；独立话题派发是 P0-1 默认行为。 */
  private readonly dispatchMode: DispatchMode;
  /** 子任务最大重试次数，由插件 config 决定，默认 2；达到上限后不再渲染/接受重试。 */
  private readonly maxRetry: number;
  /** pending run 的超时上限；超时后所有未完成子任务标记 failed，避免运行表永久保留。 */
  private readonly pendingTimeoutMs: number;
  /**
   * 重试按钮是否启用：由可选插件 orchestration/actions 启动时置位。
   * actions 下线（从 cordis.yml 移除）时保持 false，面板不渲染重试按钮。
   */
  private retryEnabled = false;
  /** 已消费的一次性重试令牌：首次消费后加入，重复令牌直接拒绝，防连点重复派发。 */
  private readonly consumedRetryTokens = new Set<string>();
  /** run → 派发上下文：retrySubTask 复用 dispatchSubTask 重新派发时恢复 bot/话题参数。 */
  private readonly runContexts = new Map<string, RunDispatchContext>();
  /** runId → pending 超时定时器；终态或淘汰时清理，定时器 unref 不阻止进程退出。 */
  private readonly pendingTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    ctx: Context,
    dispatchMode: DispatchMode = "topic",
    maxRetry = 2,
    pendingTimeoutMs = DEFAULT_PENDING_TIMEOUT_MS,
  ) {
    super(ctx, "orchestration");
    this.dispatchMode = dispatchMode;
    this.maxRetry = maxRetry;
    this.pendingTimeoutMs = Math.max(0, pendingTimeoutMs);
  }

  list(filter?: OrchestrationListFilter): OrchestrationRun[] {
    const runs = [...this.runs.values()];
    if (!filter) return runs;
    return runs.filter(
      (run) => run.chatId === filter.chatId && run.botId === filter.botId,
    );
  }

  /** actions 插件启动时调用，开启面板重试按钮渲染；插件下线时保持关闭。 */
  enableRetry(): void {
    this.retryEnabled = true;
  }

  /** 面板渲染要用的最大重试次数：重试未启用时返回 0（不渲染任何重试按钮）。 */
  retryMax(): number {
    return this.retryEnabled ? this.maxRetry : 0;
  }

  /** 启动一次编排（拆解 → 派发 → 汇总），内部异常统一消费。 */
  startOrchestration(options: StartOrchestrationOptions): void {
    void this.runOrchestration(options).catch((error) => {
      console.error("[编排] 失败:", (error as Error).message);
    });
  }

  private async runOrchestration(
    options: StartOrchestrationOptions,
  ): Promise<void> {
    const { bot, botConfig, session, hasThread, message, prompt } = options;

    let specs: SubTaskSpec[];
    try {
      specs = await this.decompose(botConfig, session, prompt);
    } catch (error) {
      await bot.reply(
        message.messageId,
        `拆解失败：${(error as Error).message}\n请调整任务描述后重试。`,
        hasThread,
      );
      return;
    }

    // 只派发给已就绪的 bot；存在未知成员时整轮拒绝，避免静默丢子任务。
    const unknownBots = [...new Set(specs.map((spec) => spec.bot))].filter(
      (botId) => !this.ctx.lark.bot(botId),
    );
    if (unknownBots.length) {
      await bot.reply(
        message.messageId,
        `拆解结果里包含未就绪的成员：${unknownBots.join("、")}。请重新描述任务。`,
        hasThread,
      );
      return;
    }

    // same-topic 降级：同一目标 bot 在同一话题同一时刻只能执行一个任务，多个子任务派给
    // 同一 bot 时，router 的 busy 检查会拒绝第二个，因此派发前整轮拒绝。
    const duplicatedBots = [
      ...new Set(
        specs
          .map((spec) => spec.bot)
          .filter((botId, index, all) => all.indexOf(botId) !== index),
      ),
    ];
    if (this.dispatchMode === "same-topic" && duplicatedBots.length) {
      await bot.reply(
        message.messageId,
        `拆解结果里同一成员被分配了多个子任务：${duplicatedBots.join("、")}。请调整任务描述，让每个成员只承接一个子任务。`,
        hasThread,
      );
      return;
    }

    // 不同 bot 并行写同一目录会造成覆盖和误测。子任务实际使用目标 bot 的 workspace；
    // 不同成员共享目录时整轮拒绝，要求配置独立 worktree 或重新拆成串行任务。
    const workspaces = new Map<string, string[]>();
    for (const spec of specs) {
      const workspaceDir = this.ctx.config.bot(spec.bot)!.workspaceDir;
      // realpath 折叠 junction/符号链接别名；仅比较字符串会漏掉两个配置路径实际指向
      // 同一物理目录的情况，仍会产生并发覆盖。
      let canonicalDir: string;
      try {
        canonicalDir = await realpath(workspaceDir);
      } catch (error) {
        await bot.reply(
          message.messageId,
          `成员 ${spec.bot} 的工作目录不可用：${(error as Error).message}`,
          hasThread,
        );
        return;
      }
      const key = process.platform === "win32"
        ? normalize(canonicalDir).toLowerCase()
        : normalize(canonicalDir);
      const members = workspaces.get(key) ?? [];
      members.push(`${spec.bot}#${spec.id}`);
      workspaces.set(key, members);
    }
    const sharedWorkspaces = [...workspaces.entries()].filter(
      ([, members]) =>
        new Set(members.map((member) => member.split("#", 1)[0])).size > 1,
    );
    if (sharedWorkspaces.length) {
      await bot.reply(
        message.messageId,
        `以下并行子任务共享可写工作目录：${sharedWorkspaces
          .map(([path, members]) => `${members.join("/")} -> ${path}`)
          .join("；")}。请为对应 bot 配置不同 worktree，或改为串行任务。`,
        hasThread,
      );
      return;
    }

    const run = this.createRun(prompt, specs, message.senderOpenId, {
      bot,
      fromBotId: botConfig.id,
      chatId: message.chatId,
      replyToMessageId: message.messageId,
      hasThread,
    });
    const failures: string[] = [];
    for (const sub of run.subTasks) {
      try {
        await this.dispatchSubTask(
          sub,
          run,
          bot,
          botConfig.id,
          message.chatId,
          message.messageId,
          hasThread,
        );
      } catch (error) {
        sub.status = "failed";
        sub.error = (error as Error).message;
        failures.push(`#${sub.id}（${sub.targetBotId}）：${sub.error}`);
      }
    }
    this.schedulePendingTimeout(run);

    // 派发完成后广播首次状态更新（带挂卡片锚点）：实时面板插件据此挂起面板卡片，
    // 快照此时已包含同步派发失败的子任务；live-panel 未装配时事件无消费者，空转无害。
    await this.ctx.parallel("orchestration/update", {
      run,
      anchor: { bot, replyToMessageId: message.messageId, hasThread },
    } satisfies OrchestrationUpdatePayload);

    const summary = failures.length
      ? [
          `已创建 ${run.runId}：${run.subTasks.length} 个子任务`,
          `其中 ${failures.length} 个派发失败：`,
          ...failures.map((line) => `- ${line}`),
        ].join("\n")
      : `已创建 ${run.runId}：${run.subTasks.length} 个子任务，已派发给对应成员。\n用 /panel 查看进度。`;
    await bot.reply(message.messageId, summary, hasThread);
  }

  private createRun(
    prompt: string,
    specs: SubTaskSpec[],
    ownerOpenId: string,
    context: RunDispatchContext,
  ): OrchestrationRun {
    const run: OrchestrationRun = {
      runId: nextRunId(this.runs.keys()),
      // 一次性实例标识：交接 taskId、重试令牌、服务端校验都绑定它，跨进程重启后旧卡片
      // 无法命中新 run（展示 runId 可重新从 run-001 递增，不做数据契约）。
      instanceId: randomUUID(),
      prompt,
      ownerOpenId,
      chatId: context.chatId,
      botId: context.fromBotId,
      startedAt: new Date().toISOString(),
      subTasks: specs.map((spec) => ({
        id: spec.id,
        prompt: spec.prompt,
        targetBotId: spec.bot,
        workspaceDir: this.ctx.config.bot(spec.bot)!.workspaceDir,
        status: "pending",
        retryCount: 0,
        attempt: 0,
      })),
    };
    this.runs.set(run.runId, run);
    // 记录派发上下文：失败子任务重试时复用同一派发路径；工作目录保存在子任务自身。
    this.runContexts.set(run.runId, context);
    // 每次创建 run 后触发淘汰：把已完成的旧 run 清理到 MAX_RUNS 以内，
    // 覆盖“子任务同步派发失败、未走事件即终态”的运行也能被清理的场景。
    this.trimRuns();
    console.log(
      `[编排] ${run.runId} 创建，共 ${run.subTasks.length} 个子任务`,
    );
    return run;
  }

  /** 淘汰策略：只保留最近 MAX_RUNS 条已完成的 run，其余从运行表删除并广播淘汰事件，
   * 让实时面板插件清理对应的挂起卡片与节流引用（避免更新到已淘汰 run）。 */
  private trimRuns(): void {
    const trimmed = trimRuns([...this.runs.values()], MAX_RUNS);
    const kept = new Set(trimmed.map((run) => run.runId));
    for (const run of [...this.runs.values()]) {
      if (!kept.has(run.runId)) {
        this.runs.delete(run.runId);
        this.clearPendingTimer(run.runId);
        // 淘汰时同步清理派发上下文与已消费令牌，避免这两个内存表随 run 无限增长。
        // 令牌前缀用实例标识（instanceId），与重试令牌格式保持一致。
        this.runContexts.delete(run.runId);
        for (const token of this.consumedRetryTokens) {
          if (token.startsWith(`${run.instanceId}:`)) {
            this.consumedRetryTokens.delete(token);
          }
        }
        void this.ctx.parallel("orchestration/evicted", {
          runId: run.runId,
        } satisfies OrchestrationEvictedPayload);
      }
    }
  }

  /** 为仍有 pending 子任务的 run 设置一次性超时；终态 run 不保留无意义定时器。 */
  private schedulePendingTimeout(run: OrchestrationRun): void {
    this.clearPendingTimer(run.runId);
    if (this.pendingTimeoutMs <= 0 || isRunTerminal(run)) return;
    const timer = setTimeout(() => {
      void this.expirePendingRun(run.runId);
    }, this.pendingTimeoutMs);
    // 测试宿主和正常进程退出不应被一个等待外部 bot 的定时器阻塞。
    timer.unref?.();
    this.pendingTimers.set(run.runId, timer);
  }

  private clearPendingTimer(runId: string): void {
    const timer = this.pendingTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTimers.delete(runId);
  }

  /** 将长期没有结果的 pending 子任务收口为失败，并撤销仍未领取的交接单。 */
  private async expirePendingRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || isRunTerminal(run)) {
      this.clearPendingTimer(runId);
      return;
    }

    const finishedAt = new Date().toISOString();
    const error = `等待子任务结果超时（${this.pendingTimeoutMs}ms）`;
    for (const sub of run.subTasks) {
      if (sub.status !== "pending") continue;
      if (sub.currentDispatchId) {
        this.ctx.collaboration.consume(
          sub.currentDispatchId,
          sub.targetBotId,
        );
      }
      delete sub.currentDispatchId;
      sub.status = "failed";
      sub.error = error;
      sub.finishedAt = finishedAt;
    }
    this.clearPendingTimer(runId);
    await this.ctx.parallel("orchestration/update", {
      run,
    } satisfies OrchestrationUpdatePayload);
    this.trimRuns();
  }

  /** 用编排 bot 的 CLI 跑一次拆解，返回结构化子任务规格。 */
  private async decompose(
    botConfig: BotConfig,
    session: Session,
    prompt: string,
  ): Promise<SubTaskSpec[]> {
    const adapter = this.ctx.cli.get(
      session.cliId,
      session.accessMode ?? "headless",
    );
    const members = this.ctx.config.bots.map((config) => config.id);
    const result = await this.ctx.cli.run({
      adapter,
      prompt: buildDecomposePrompt(this.ctx, members, prompt, this.dispatchMode),
      cwd: session.workspaceDir,
      // 拆解是编排 bot 的一次独立规划，不复用用户会话上下文，避免污染后续任务。
      timeoutMs: DECOMPOSE_TIMEOUT_MS,
      env: botCliEnvironment(botConfig),
      onEvent: () => {},
      botId: botConfig.id,
    });
    return parseSubTaskSpecs(result.answer);
  }

  /** 派发单个子任务：注册交接单并 @ 目标 bot；失败时撤销交接单并清理 currentDispatchId。 */
  private async dispatchSubTask(
    sub: OrchestrationSubTask,
    run: OrchestrationRun,
    bot: Bot,
    fromBotId: string,
    chatId: string,
    replyToMessageId: string,
    hasThread: boolean,
  ): Promise<void> {
    // 派发入口先清空 currentDispatchId：任何失败路径（含目标 bot 未就绪、注册前抛错）都
    // 不能残留上一 attempt 的交接单号，否则重试后旧 attempt 的迟到结果可能错误命中。
    // 只有注册交接单并发送成功后才重新写入新 dispatchId。
    delete sub.currentDispatchId;
    const target = this.ctx.lark.bot(sub.targetBotId);
    if (!target) throw new Error(`成员未就绪: ${sub.targetBotId}`);

    const collaboration: CollaborationMessage = {
      dispatchId: randomUUID().replaceAll("-", "").slice(0, 12),
      // 交接 taskId 绑定 run 实例标识：重试复用同一 taskId（新 dispatchId），跨进程重启后
      // 旧 taskId 无法命中新 run。
      taskId: subTaskTaskId(run.instanceId, sub.id),
      ownerOpenId: run.ownerOpenId,
      fromBotId,
      toBotId: sub.targetBotId,
      reportToBotId: fromBotId,
      objective: `编排 ${run.runId} · ${sub.id}`,
      instruction: sub.prompt,
      expectedOutput: "完成子任务并返回可供编排汇总的结果。",
      round: 1,
      maxRounds: 1,
      workspaceDir:
        sub.workspaceDir ??
        this.ctx.config.bot(sub.targetBotId)?.workspaceDir ??
        process.cwd(),
      // 编排服务自己监听 task/result|failed 汇总叶子结果，协作插件无需再次回传或通知真人。
      suppressAutomaticHandoff: true,
    };
    // 复用协作交接单：router 对 bot@bot 消息只认已注册的交接单，注册失败会丢消息。
    this.ctx.collaboration.register(collaboration);
    // 记录当前派发尝试的交接单：handleTaskOutcome 据此忽略旧 attempt 的迟到结果。
    sub.currentDispatchId = collaboration.dispatchId;
    const dispatchText = `【编排 ${run.runId}·${sub.id}】${sub.prompt}（任务编号：${collaboration.dispatchId}）`;
    try {
      if (this.dispatchMode === "topic") {
        // 独立话题派发：发一条新根消息 @ 目标 bot，让同一 bot 可跨话题并行承接子任务。
        const messageId = await bot.sendMentionToChat(
          chatId,
          target.identity,
          dispatchText,
        );
        if (!messageId?.trim()) {
          throw new Error("飞书没有返回编排派发 message_id");
        }
      } else {
        // same-topic 降级：在当前话题回复派发（P0 行为，同 bot 同话题仍会 busy 拒绝）。
        const messageId = await bot.replyMention(
          replyToMessageId,
          target.identity,
          dispatchText,
          hasThread,
        );
        if (!messageId?.trim()) {
          throw new Error("飞书没有返回编排派发 message_id");
        }
      }
    } catch (error) {
      // @ 派发失败时撤销交接单，避免目标 bot 后续在一张失败的通知上重复领取；
      // 同时清空 currentDispatchId，让迟到的旧结果无法命中该子任务。
      this.ctx.collaboration.consume(collaboration.dispatchId, sub.targetBotId);
      delete sub.currentDispatchId;
      throw error;
    }
  }

  /** task/result 与 task/failed 事件入口：从交接单反解 run 实例/子任务并更新状态，
   * 更新后广播 orchestration/update 供实时面板刷新；run 全终态后可能触发淘汰广播。
   * 只接受与当前派发尝试匹配的交接单结果，旧 attempt 的迟到结果直接忽略，避免覆盖
   * 重试中或新 attempt 的状态。 */
  async handleTaskOutcome(
    collaboration: CollaborationMessage | undefined,
    status: "done" | "failed",
    answer?: string,
  ): Promise<void> {
    if (!collaboration) return;
    const parsed = parseSubTaskTaskId(collaboration.taskId);
    if (!parsed) return;
    // taskId 绑定 instanceId：跨进程重启后旧 taskId 在这里查不到 run，静默忽略。
    const run = [...this.runs.values()].find(
      (item) => item.instanceId === parsed.instanceId,
    );
    const sub = run?.subTasks.find((item) => item.id === parsed.subTaskId);
    if (!run || !sub) return;
    // 结果必须属于当前派发尝试：重试后 currentDispatchId 更新，旧 attempt 的迟到
    // task/result|task/failed 因 dispatchId 不匹配被忽略，不覆盖新状态。
    if (collaboration.dispatchId !== sub.currentDispatchId) return;
    // 同一个 dispatch 可能因平台重试同时投递 result 与 failed；首个终态赢，后续
    // 事件幂等忽略，避免 finishedAt/answer/error 被另一种终态覆盖。
    if (sub.status !== "pending") return;
    sub.status = status;
    sub.finishedAt = new Date().toISOString();
    if (answer) sub.answer = answer;
    if (status === "failed" && !sub.error) sub.error = "任务执行失败";
    // 子任务终态可能让 run 变为全终态；顺手清理超限的已完成 run，及时回收内存。
    if (isRunTerminal(run)) this.clearPendingTimer(run.runId);
    this.trimRuns();
    // 状态变化广播（无锚点）：live-panel 已有挂卡片信息，直接节流刷新该 run 的面板卡片。
    await this.ctx.parallel("orchestration/update", {
      run,
    } satisfies OrchestrationUpdatePayload);
  }

  /**
   * 失败子任务一键重试：校验鉴权/次数/一次性令牌后，把子任务复位为 pending 并复用
   * 原派发上下文重新派发（新 dispatchId，目标/提示词/工作目录不变）。返回结果供
   * orchestration/actions 插件映射 toast。
   */
  async retrySubTask(
    runId: string,
    subTaskId: string,
    operatorOpenId: string,
    token: string,
  ): Promise<RetrySubTaskResult> {
    const run = this.runs.get(runId);
    const sub = run?.subTasks.find((item) => item.id === subTaskId);
    if (!run || !sub) return { ok: false, reason: "not_found" };
    if (sub.status !== "failed") return { ok: false, reason: "not_failed" };
    // 鉴权身份只信飞书回调的 operatorOpenId，不信任卡片 value 里可被构造的用户字段。
    if (operatorOpenId !== run.ownerOpenId) return { ok: false, reason: "forbidden" };
    if (sub.retryCount >= this.maxRetry) return { ok: false, reason: "limit" };
    // 一次性令牌：必须未被消费过，且完整结构与当前 run 实例/子任务匹配（解析 instanceId
    // 与 subTaskId 做全量比对，不再用单纯前缀匹配），防旧卡片连点与跨实例复用。
    if (this.consumedRetryTokens.has(token)) return { ok: false, reason: "duplicate" };
    const parsedToken = parseRetryToken(token);
    if (
      !parsedToken ||
      parsedToken.instanceId !== run.instanceId ||
      parsedToken.subTaskId !== sub.id
    ) {
      return { ok: false, reason: "bad_token" };
    }
    this.consumedRetryTokens.add(token);

    const context = this.runContexts.get(runId);
    if (!context) return { ok: false, reason: "not_found" };

    // 同步复位为 pending 并清空旧结果：后续并发点击看到非 failed 即被拒绝，防止连点。
    // attempt 是派发尝试计数，随重试递增；currentDispatchId 由 dispatchSubTask 写入。
    sub.attempt += 1;
    sub.retryCount += 1;
    sub.status = "pending";
    delete sub.answer;
    delete sub.error;
    delete sub.finishedAt;

    try {
      await this.dispatchSubTask(
        sub,
        run,
        context.bot,
        context.fromBotId,
        context.chatId,
        context.replyToMessageId,
        context.hasThread,
      );
    } catch (error) {
      // 派发失败回滚为 failed 并记录原因；令牌已消费，用户刷新面板后用新令牌再试。
      sub.status = "failed";
      sub.error = (error as Error).message;
      await this.ctx.parallel("orchestration/update", { run });
      return {
        ok: false,
        reason: "dispatch_failed",
        message: (error as Error).message,
      };
    }

    this.schedulePendingTimeout(run);

    await this.ctx.parallel("orchestration/update", { run });
    return { ok: true };
  }
}

export const name = "orchestration";
export const inject = ["lark", "cli", "config", "prompts", "collaboration"];

export interface Config {
  /** 子任务派发方式：topic=独立新话题派发（默认），same-topic=当前话题回复派发（P0 降级）。 */
  dispatchMode?: DispatchMode;
  /** 失败子任务最大重试次数，默认 2；达到上限后面板不再渲染重试按钮。 */
  maxRetry?: number;
  /** pending run 等待结果的毫秒数，默认 30 分钟；设为 0 禁用超时。 */
  pendingTimeoutMs?: number;
}

export function apply(ctx: Context, config: Config = {}) {
  const service = new OrchestrationService(
    ctx,
    config.dispatchMode ?? "topic",
    config.maxRetry ?? 2,
    config.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS,
  );
  // 事件监听而非直接调用：编排成为可选插件，移除本插件不影响任务与协作。
  ctx.on("task/result", (payload: TaskResultPayload) => {
    return service.handleTaskOutcome(
      payload.collaboration,
      "done",
      payload.answer,
    );
  });
  ctx.on("task/failed", (payload: TaskResultPayload) => {
    return service.handleTaskOutcome(payload.collaboration, "failed");
  });
}
