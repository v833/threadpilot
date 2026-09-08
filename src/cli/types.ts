/**
 * CLI 适配层公共契约：统一 Codex、Claude Code 与 DimAgent 的参数构造和事件语义，
 * 让 ThreadPilot 的进程控制与具体供应商协议彼此独立。
 */
import type { ApplicationToolServer } from './app-tools.js'

/** 引擎标识；内置引擎保持字面量提示，同时允许插件注册任意扩展 id（如 ACP 引擎）。 */
export type CliId = 'codex' | 'claude' | 'dimagent' | 'agy' | 'grok' | (string & {})

/** DimAgent 的接入协议；其他引擎目前只支持 headless。 */
export type CliAccessMode = 'headless' | 'acp'

/** ACP 恢复已有会话时使用的协议方法。auto 会优先使用 resume，再退回 load。 */
export type AcpResumeMethod = 'auto' | 'load' | 'resume'

/** ACP 引擎声明支持的 MCP 传输；stdio 是未声明 acp 入口的应用工具默认传输。 */
export type AcpMcpTransport = 'stdio' | 'http' | 'sse'

/** ACP 会话创建后需要应用的引擎配置；具体值由 ACP 引擎插件声明。 */
export interface AcpSessionConfig {
  /** 通过标准 session/set_config_option 顺序设置的配置项。 */
  configOptions?: Readonly<Record<string, string>>
  /** 通过标准 session/set_mode 设置的模式；通常可由 configOptions.mode 替代。 */
  modeId?: string
  /** DimCode 等 ACP 扩展支持的模型覆盖；值必须来自 session/new 的模型目录。 */
  model?: string
}

export interface CliRunStats {
  durationMs?: number
  turns?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextUsedTokens?: number
  contextWindowTokens?: number
}

/** /resume 卡片使用的轻量原生会话摘要，不包含消息正文。 */
export interface CliSessionSummary {
  id: string
  title: string
  updatedAt: string
}

/** 描述某个 CLI 的原生上下文整理协议和启动参数。 */
export type CliCompactPlan =
  | {
      protocol: 'claude-stream-json'
      command: string
      args: string[]
    }
  | {
      protocol: 'codex-app-server'
      command: string
      args: string[]
      sessionId: string
    }

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool_start'
      toolUseId: string
      toolName: string
      label: string
      detail?: string
    }
  | { type: 'tool_end'; toolUseId: string; failed: boolean }
  | {
      type: 'tool_call'
      toolUseId: string
      toolName: string
      input: unknown
    }
  | { type: 'context'; usedTokens: number }
  | {
      type: 'result'
      answer: string
      /** 协议已报告本轮业务完成；进程是否随后退出由 Runner 单独处理。 */
      complete: boolean
      sessionId?: string
      stats?: CliRunStats
    }
  | { type: 'error'; message: string; sessionId?: string }

/** 描述某种可由通用 Runner 驱动的无头 CLI。 */
export interface CliAdapter {
  readonly id: CliId
  readonly command: string
  readonly displayName: string
  readonly accessMode?: CliAccessMode
  buildArgs(prompt: string): string[]
  buildResumeArgs(prompt: string, sessionId: string): string[]
  /** 启动 headless 进程前准备工作区级配置；例如 agy 的 MCP 配置文件。 */
  prepareRun?(cwd: string): Promise<void> | void
  /** ACP/ headless 适配器提供插件注册的应用工具；未声明表示没有注入工具。 */
  getApplicationTools?(): readonly ApplicationToolServer[]
  /** ACP 适配器声明 session/new 后必须应用的会话配置；headless 适配器不实现。 */
  getAcpSessionConfig?(): AcpSessionConfig | undefined
  /** ACP 恢复方式；未声明时按能力自动选择。 */
  getAcpResumeMethod?(): AcpResumeMethod
  /** ACP server 的最低版本；声明后 initialize 必须返回不低于该版本的 agentInfo。 */
  getAcpMinAgentVersion?(): string | undefined
  /** ACP server 支持的 MCP 传输；未声明时保留所有应用工具传输。 */
  getAcpMcpTransports?(): readonly AcpMcpTransport[] | undefined
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan
  parseEvents(line: string): CliEvent[]
  /** 判断失败信息是否明确表示恢复指针已经失效。 */
  isSessionUnavailable?(message: string): boolean
  /**
   * 判断失败信息是否表明该引擎需要登录（未声明时 auth 插件用通用检测兜底）。
   * 例如 agy 未认证时的 "Authentication required ... paste the authorization code"。
   */
  isAuthRequired?(message: string): boolean
  /**
   * 用用户提交的授权码/登录 key 完成该引擎的登录；未声明表示该引擎暂不支持
   * 飞书卡片登录。key 模式（agy）授权码只在真实 TTY 中可粘贴，应借助 ConPTY；
   * device 模式（DimAgent）直接跑非交互设备码流程，无需用户输入 key。
   */
  login?(code: string, options?: CliLoginOptions): Promise<void>
  /**
   * 登录交互模式：key=用户在卡片输入授权码后提交（默认）；device=用户确认后
   * 启动设备码流程，登录进程把授权 URL/code 经 onOutput 推回卡片，用户浏览器授权。
   */
  readonly loginMode?: "key" | "device"
  /** 列出该引擎在当前工作目录的原生会话，供 /resume 卡片展示；未实现表示不支持。 */
  listNativeSessions?(cwd: string): Promise<CliSessionSummary[]>
  /** 是否对明确瞬时断流做有限重试（目前只有 Codex 声明）。 */
  readonly retryOnDisconnect?: boolean
  /** 原生上下文整理的策略描述；缺省用通用文案。 */
  readonly compactDetail?: string
}

/** 引擎登录执行的可选运行时上下文（由 auth 插件从失败任务推导）。 */
export interface CliLoginOptions {
  /** 执行登录进程的工作目录；缺省使用当前进程工作目录。 */
  cwd?: string
  /** 登录进程整体超时毫秒；缺省由实现决定（例如 90 秒）。 */
  timeoutMs?: number
  /** 登录进程输出回调，可用于在登录卡片上展示进度。 */
  onOutput?: (chunk: string) => void
  /**
   * key 模式延迟注入：登录进程打印授权提示后不立即注入 code，而是先等本回调
   * 返回用户提交的授权码再注入。授权码与登录进程的 PKCE 绑定，必须取自
   * 本进程打印的授权 URL（取自过期错误文本的旧授权码无法通过校验）。
   */
  getCode?: () => Promise<string>
}

/** CLI 一轮执行完成后返回给会话层的统一结果。 */
export interface CliRunResult {
  answer: string
  sessionId?: string
  stats?: CliRunStats
  /** 本轮调用的应用工具（按 toolUseId 去重、剔除失败的调用）。 */
  toolCalls?: Array<{
    toolUseId: string
    toolName: string
    input: unknown
  }>
}
