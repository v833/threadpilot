/**
 * ThreadPilot 插件公共契约：集中声明 Cordis 上的服务与事件，以及路由、命令、
 * 任务、协作之间共享的输入类型。这里是“一切皆为插件”的类型基石——
 * 平台、执行引擎、斜杠命令、任务编排、协作都是挂载在根 Context 上的插件，
 * 通过 ctx.<service> 与类型化事件协作，而不是互相导入具体实现。
 */
import type { Context } from "cordis";

import type { BotConfig, ProductDeliveryMode } from "../core/bot-registry.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import type { CliRequest, SlashCommand } from "../core/command-parser.js";
import type { InteractionPolicy } from "../core/interaction-policy.js";
import type { OrchestrationRun } from "../core/orchestration.js";
import type { ProductSpecFlow } from "../core/product-spec.js";
import type { QAResult } from "../core/qa-result.js";
import type { Session } from "../core/session-manager.js";
import type { CliAdapter, CliRunResult, CliRunStats } from "../cli/types.js";
import type { CardJson, TaskCardAction } from "../im/card.js";
import type { MessageResource } from "../im/message-parser.js";
import type {
  Bot,
  BotIdentity,
  CardAction,
  CardActionResponse,
  IncomingDocumentComment,
  IncomingMessage,
} from "../im/lark.js";

import type { AgentAdminService } from "./agent-admin.js";
import type { ApplicationToolsService } from "./application-tools.js";
import type { AuthService } from "./auth.js";
import type { CardsService } from "./cards.js";
import type { CliService } from "./cli.js";
import type { CollaborationService } from "./collaboration.js";
import type { CommandsService } from "./commands.js";
import type { ConfigService } from "./config.js";
import type { LarkService } from "./lark.js";
import type { OrchestrationService } from "./orchestration.js";
import type { ScheduleService } from "./schedule.js";
import type { SessionsService } from "./sessions.js";
import type { TasksService } from "./tasks.js";
import type { TeamService } from "./team.js";
import type { WorkspacesService } from "./workspaces.js";
import type { ClarificationService } from "./clarification.js";
import type { ProductSpecService } from "./product-spec.js";
import type { ProductCommentsService } from "./product-comments.js";
import type { ObservabilityService } from "./observability.js";
import type { BitableBoardService } from "./bitable-board.js";
import type { PromptsService, PromptComposeCollector } from "./prompts.js";
import type { IngressService } from "./ingress.js";
import type { PromptFragment } from "../core/prompts.js";

declare module "cordis" {
  interface Context {
    /** 机器人注册表：加载 config/bots.json 并解析环境变量凭证。 */
    config: ConfigService;
    /** Agent 管理覆盖层：每 agent 引擎模型环境注入与按 bot 重启常驻引擎；管理页面后台。 */
    agentAdmin: AgentAdminService;
    /** 提示词管理服务：模板注册、分层覆盖与任务流水线组装。 */
    prompts: PromptsService;
    /** 团队注册表与团队上下文扩展；移除 team 插件即可下线团队能力。 */
    team: TeamService;
    /** 会话模型：把飞书话题映射为稳定会话，约束生命周期。 */
    sessions: SessionsService;
    /** 执行引擎注册表与调度：统一驱动 Codex/Claude/DimAgent。 */
    cli: CliService;
    /** 飞书平台适配：启动多 bot、发送消息与卡片、下载资源。 */
    lark: LarkService;
    /** 应用工具注册表：业务插件登记 MCP Server，执行引擎读取通用描述。 */
    applicationTools: ApplicationToolsService;
    /** 卡片渲染：任务卡片、会话卡片、协作卡片的统一出口。 */
    cards: CardsService;
    /** 斜杠命令注册表：每个命令由独立插件登记处理函数。 */
    commands: CommandsService;
    /** bot 间协作：交接单、轮次去重与审查派发。 */
    collaboration: CollaborationService;
    /** 任务编排：一轮 CLI 执行的启动、进度、取消与收尾。 */
    tasks: TasksService;
    /** 定时任务：三种规则到点直接唤醒目标 CLI 静默执行，schedule_manage 统一管理。 */
    schedule: ScheduleService;
    /** 多话题并行编排：拆解大任务、派发子任务并汇总结果（移除本插件即下线编排）。 */
    orchestration: OrchestrationService;
    /** 工作区稳定 revision 指纹，供 QA Gate 固定和验证审查版本。 */
    workspaces: WorkspacesService;
    /** 需求澄清：逐题飞书流程、同话题替代与原 CLI 会话续接。 */
    clarification: ClarificationService;
    /** CLI 登录：识别认证需求、飞书卡片收集登录 key 并驱动引擎完成登录。 */
    auth: AuthService;
    /** 产品方案确认：真实产物校验、发起人确认和卡片状态流转。 */
    productSpec: ProductSpecService;
    /** 云文档评论评审：恢复产品会话并回写评论结果。 */
    productComments: ProductCommentsService;
    /** 可观测性与链路追踪：收集全链路 Span、Token 成本、时延与多维指标。 */
    observability: ObservabilityService;
    /** 飞书多维表格任务看板：双向任务同步与反向拉起服务。 */
    bitableBoard: BitableBoardService;
    /** 外部事件 Ingress：Webhook 网关、路由规则与实体→话题映射。 */
    ingress: IngressService;
  }

  interface Events {
    /** 飞书收到新消息；lark 插件发出，router 插件消费并路由。 */
    "bot/message"(message: IncomingMessage, bot: Bot, botConfig: BotConfig): void;
    /** 飞书卡片按钮回调；lark 插件以 serial 分发，返回响应给平台。 */
    "bot/card-action"(
      action: CardAction,
      bot: Bot,
      botConfig: BotConfig,
    ): Promise<CardActionResponse | undefined>;
    /** 云文档评论事件；lark 插件发出，产品评论插件消费并恢复原会话。 */
    "bot/document-comment"(
      comment: IncomingDocumentComment,
      bot: Bot,
      botConfig: BotConfig,
    ): void | Promise<void>;
    /**
     * 任务提示词流水线组装事件：各插件监听此事件并通过 collector.add(...) 并发贡献 PromptFragment。
     *
     * 设计说明（偏离原始返回值设计的理由）：
     * Cordis 事件机制中 `ctx.parallel` 返回 `Promise<void>`，无法聚合多个插件的返回值；
     * 若使用 `ctx.serial` / `ctx.bail` 只能获取第一个非 undefined 返回值，无法多插件协同。
     * 因此采用 Collector 模式：prompts 服务传入收集器容器，所有插件并发注入片段，最终由流水线进行 priority 排序合并。
     */
    "task/prompt-compose"(
      collector: PromptComposeCollector,
      botConfig: BotConfig,
      taskPrompt: string,
      options: {
        interaction?: InteractionPolicy;
        session?: Session;
        defaultProductDeliveryMode?: ProductDeliveryMode;
      },
    ): void | Promise<void>;
    /** 应用工具插件按本轮任务上下文补充 CLI 环境；没有 provider 时不注入。 */
    "task/cli-environment"(
      payload: TaskCliEnvironmentPayload,
    ): Record<string, string> | undefined;
    /** 一轮 CLI 成功结束后，应用工具插件可优先认领结果并替换普通成功收尾。 */
    "task/tool-calls"(
      payload: TaskToolCallsPayload,
    ): Promise<TaskToolCallsOutcome | undefined>;
    /** 普通成功收尾前的业务完成校验；插件可在同一 CLI 会话纠正一次结果。 */
    "task/completion-check"(
      payload: TaskCompletionCheckPayload,
    ): Promise<TaskCompletionCheckOutcome | undefined>;
    /** 普通消息启动任务前的可选改写点；澄清插件用它让同话题补充替代旧卡片。 */
    "task/message"(
      payload: TaskMessagePayload,
    ): Promise<TaskMessageOutcome | undefined>;
    /** 任意任务已经原子占用会话；会话级临时能力据此使旧动作失效。 */
    "task/claimed"(payload: TaskClaimedPayload): void;
    /** 一轮普通任务已进入实际执行阶段；可观测性插件据此建立运行中 Trace。 */
    "task/started"(payload: TaskStartedPayload): void | Promise<void>;
    /**
     * 普通任务失败卡片生成前的扩展点；可选插件通过 collector.add 贡献卡片动作，
     * 同时保存动作所需的一次性上下文。插件下线时收集器为空，失败主流程不受影响。
     */
    "task/failure-actions"(
      collector: TaskFailureActionCollector,
      payload: TaskFailureActionPayload,
    ): void | Promise<void>;
    /** 一轮任务成功完成；tasks 服务发出，协作插件监听并决定是否继续交接。 */
    "task/result"(payload: TaskResultPayload): void | Promise<void>;
    /**
     * 一轮任务执行失败；tasks 服务在失败收尾时发出。
     * 与 task/result 语义区分（后者只在成功时广播），编排等插件据此标记子任务失败。
     */
    "task/failed"(payload: TaskResultPayload): void | Promise<void>;
    /** 一轮 CLI 已结束但业务流程等待用户输入；可观测性据此关闭运行中 Trace。 */
    "task/paused"(payload: TaskResultPayload): void | Promise<void>;
    /** 一轮任务由发起人主动停止；与失败事件分开，避免误触发认证或编排失败处理。 */
    "task/cancelled"(payload: TaskResultPayload): void | Promise<void>;
    /** 会话已关闭；保存会话级临时状态的插件应据此立即清理。 */
    "session/closed"(sessionId: string): void | Promise<void>;
    /** 产品方案由真人确认；可选团队派发插件据此把结果交回原编排者。 */
    "product-spec/approved"(
      payload: ProductSpecApprovedPayload,
    ): void | Promise<void>;
    /** QA Gate 已解析、校验并绑定实际 revision 的结构化审查结论。 */
    "qa/result"(payload: QAResultPayload): void | Promise<void>;
    /** 编排运行状态更新广播；orchestration 服务发出，live-panel 插件消费并节流刷新面板卡片。 */
    "orchestration/update"(
      payload: OrchestrationUpdatePayload,
    ): void | Promise<void>;
    /** 编排 run 被淘汰广播；live-panel 插件据此清理挂起卡片与节流引用。 */
    "orchestration/evicted"(
      payload: OrchestrationEvictedPayload,
    ): void | Promise<void>;
  }
}

/** 一台已启动 bot 的运行时状态：配置、平台句柄与稳定身份；WS 状态由 Bot 提供。 */
export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

/** 消息到达时的会话上下文，供命令插件消费。 */
export interface CommandContext {
  ctx: Context;
  bot: Bot;
  botConfig: BotConfig;
  message: IncomingMessage;
  /** 同一飞书话题的稳定任务编号，供会启动任务的命令沿用。 */
  taskId: string;
  session: Session;
  isNew: boolean;
  hasThread: boolean;
  /** 提及还原后的完整文本。 */
  resolvedText: string;
  cliRequest?: CliRequest;
  command: SlashCommand;
  /** 当前会话选中的执行引擎适配器。 */
  cliAdapter: CliAdapter;
  /** 路由入口解析的一次性交互策略。 */
  interaction?: InteractionPolicy;
}

/** 命令插件需要实现的处理函数签名。 */
export type CommandHandler = (input: CommandContext) => Promise<void>;

/** 启动一轮任务所需的全部输入，由 router 或 /compact 命令组装。 */
export interface StartTaskInput {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  hasThread: boolean;
  replyToMessageId: string;
  senderOpenId: string;
  senderUnionId?: string;
  /** 同一飞书话题的稳定任务编号；旧的定时/协作入口可以不提供。 */
  taskId?: string;
  /** 路由入口解析的一次性交互策略；缺省按 team 模式。 */
  interaction?: InteractionPolicy;
  requestedPrompt: string;
  /** 应用工具恢复轮次使用；CLI 收到 requestedPrompt，最终结果仍关联最初任务。 */
  originalRequestedPrompt?: string;
  isCompacting: boolean;
  compactInstructions?: string;
  collaboration?: CollaborationMessage;
  senderRuntime?: BotRuntime;
  resources: MessageResource[];
  /** 应用工具恢复任务可禁止普通协作与 QA 自动交接，但仍广播结果供编排汇总。 */
  suppressHandoff?: boolean;
}

/** 普通任务失败后可选插件收到的不可变执行快照。 */
export interface TaskFailureActionPayload {
  input: StartTaskInput;
  sessionId: string;
  runId: string;
}

/** 失败卡片动作的共享契约。 */
export type TaskFailureAction = TaskCardAction;

/** 失败卡片动作收集器；插件通过 add 贡献按钮，tasks 只负责渲染结果。 */
export interface TaskFailureActionCollector {
  add(action: TaskFailureAction): void;
}

/** 业务插件生成本轮应用工具环境时所需的最小公共上下文。 */
export interface TaskCliEnvironmentPayload {
  session: Session;
  collaboration?: CollaborationMessage;
  senderOpenId: string;
}

/** router 准备启动普通消息时交给可选业务插件的上下文。 */
export interface TaskMessagePayload {
  bot: Bot;
  botConfig: BotConfig;
  message: IncomingMessage;
  taskId: string;
  /** 当前入站消息的交互策略；澄清插件可用它判断是否需要沿用旧策略。 */
  interaction?: InteractionPolicy;
  requestedPrompt: string;
}

/** 可选业务插件对本轮提示词和原始任务归属的改写。 */
export interface TaskMessageOutcome {
  requestedPrompt: string;
  originalRequestedPrompt?: string;
  /** 澄清流程等可选插件可保留原任务的交互策略。 */
  interaction?: InteractionPolicy;
}

/** 产品方案确认事件只携带公共契约，不让 product-spec 依赖具体协作实现。 */
export interface ProductSpecApprovedPayload {
  flow: ProductSpecFlow;
  bot: Bot;
  botConfig: BotConfig;
  replyToMessageId: string;
  /** 直接产品任务确认时用户选择把方案交给 Team Leader 继续组织；协作任务无需此字段。 */
  handoffToLeader?: boolean;
}

/** 应用工具插件认领任务结果后返回的替代卡片与任务生命周期。 */
export interface TaskToolCallsOutcome {
  card: CardJson;
  /** paused 保留当前任务等待用户输入；completed 表示本轮已经完成。 */
  completion: "paused" | "completed";
  /** 卡片成功更新后发送给直接任务发起人的提醒；协作任务不会发送。 */
  notificationText?: string;
  /** 完成型工具结果是否禁止普通协作/QA 自动交接。 */
  suppressHandoff?: boolean;
  /** 最终卡片成功更新后提交插件内存状态；失败时不会调用。 */
  afterCardPublished?: () => void | Promise<void>;
}

/** 一轮 CLI 的应用工具调用及恢复任务所需上下文。 */
export interface TaskToolCallsPayload extends TaskResultPayload {
  result: CliRunResult;
  runId: string;
  senderOpenId: string;
  senderUnionId?: string;
  /** 当前运行卡片的 message_id，供流程卡片严格绑定回调来源。 */
  cardMessageId: string;
}

/** 成功卡片生成前的可选完成校验上下文。 */
export interface TaskCompletionCheckPayload extends TaskToolCallsPayload {
  /** 与当前任务绑定的取消信号；纠正轮不能脱离原任务生命周期。 */
  signal: AbortSignal;
  /** 由 tasks 提供的同会话重跑入口，插件不依赖具体 CLI 实现。 */
  runCorrection: (prompt: string) => Promise<CliRunResult>;
}

/** 完成校验可返回替代结果，后续工具认领和成功收尾统一使用该结果。 */
export interface TaskCompletionCheckOutcome {
  result: CliRunResult;
}

/** 一轮任务中按工具名聚合的调用与失败次数。 */
export type TaskToolMetrics = Record<
  string,
  { invocations: number; failures: number }
>;

/** 任务入口来源，用于区分普通消息和不应触发业务接力的后台任务。 */
export type TaskOrigin = "message" | "background";

/** 任意任务成功占用会话后广播的运行标识。 */
export interface TaskClaimedPayload {
  sessionId: string;
  runId: string;
}

/** 一轮普通任务开始时广播的稳定链路上下文。 */
export interface TaskStartedPayload {
  botConfig: BotConfig;
  session: Session;
  taskId?: string;
  /** 本轮交互策略；后台观察者可缺省。 */
  interaction?: InteractionPolicy;
  traceId: string;
  startedAt: number;
  /** 本轮任务指令（原始请求），供看板等观察者展示标题；兼容旧广播可缺省。 */
  requestedPrompt?: string;
  /** 任务发起人 open_id；可缺省（旧广播或定时入口）。 */
  senderOpenId?: string;
  /** 协作交接单；QA 轮携带 qaReview，观察者可据此标记“QA验收中”。 */
  collaboration?: CollaborationMessage;
  /** 入口来源；后台任务只供观察者消费，不触发普通 QA/协作副作用。 */
  origin?: TaskOrigin;
}

/** 一轮任务成功完成时随 task/result 事件广播给协作插件的信息。 */
export interface TaskResultPayload {
  bot: Bot;
  botConfig: BotConfig;
  session: Session;
  requestedPrompt: string;
  answer: string;
  replyToMessageId: string;
  hasThread: boolean;
  collaboration?: CollaborationMessage;
  senderRuntime?: BotRuntime;
  taskId?: string;
  suppressHandoff?: boolean;
  /** 本轮交互策略；旧事件缺省按 team 模式。 */
  interaction?: InteractionPolicy;
  /** 任务发起人 open_id；auth 等插件用它校验后续卡片动作的权限。 */
  senderOpenId?: string;
  /** 任务发起人 union_id；跨 bot 产品确认时优先用它识别同一真人。 */
  senderUnionId?: string;
  /** 失败任务的错误摘要（仅 task/failed 携带），auth 插件据此识别认证需求。 */
  error?: string;
  /** CLI 执行统计（Token 消耗、耗时、缓存等），供可观测性插件与下游使用。 */
  stats?: CliRunStats;
  /** 任务执行实际耗时（毫秒）。 */
  durationMs?: number;
  /** 本轮触发的工具调用列表。 */
  toolCalls?: CliRunResult["toolCalls"];
  /** 包含失败调用在内的工具指标；由 tasks 从流式事件实时聚合。 */
  toolMetrics?: TaskToolMetrics;
  /** 关联的链路追踪 ID。 */
  traceId?: string;
  /** 入口来源；后台任务只供观察者消费，不触发普通 QA/协作副作用。 */
  origin?: TaskOrigin;
}

/** QA Gate 从普通 CLI 文本中解析出的结构化、可路由结论。 */
export interface QAResultPayload extends TaskResultPayload {
  qaResult: QAResult;
}

/** 实时面板挂卡片所需锚点：回复目标与话题参数，由编排服务创建 run 时记录。 */
export interface OrchestrationPanelAnchor {
  bot: Bot;
  replyToMessageId: string;
  hasThread: boolean;
}

/** 编排运行状态更新事件负载：run 快照 + 首次挂卡片锚点。 */
export interface OrchestrationUpdatePayload {
  run: OrchestrationRun;
  /**
   * 挂实时面板卡片的锚点；仅创建 run 后的首次广播携带（编排服务在派发完成后发一次），
   * live-panel 首次收到时 replyCard 挂起卡片，后续更新只携带 run 快照。
   */
  anchor?: OrchestrationPanelAnchor;
}

/** 编排 run 被淘汰事件负载：live-panel 按 runId 清理挂起卡片与节流引用。 */
export interface OrchestrationEvictedPayload {
  runId: string;
}
