/**
 * 会话命令解析器：识别控制命令和新话题的执行引擎前缀，
 * 防止普通任务文本中偶然出现斜杠字样时误触发控制或切换操作。
 * 引擎请求按调用方注入的注册表 CLI ID 动态解析，新增引擎无需改白名单。
 */
import type { CliId } from "../cli/types.js";

export type SlashCommand =
  | { name: "close" | "status" | "help" | "new" | "resume" | "team" }
  | { name: "compact"; instructions?: string }
  | { name: "doc"; prompt?: string }
  | { name: "cd"; path?: string }
  | { name: "schedules" }
  | { name: "schedule"; request?: string }
  | { name: "orchestrate"; prompt?: string }
  | { name: "panel" }
  /** 发起 CLI 登录卡片；cliId 缺省表示当前会话的引擎。 */
  | { name: "login"; cliId?: CliId }
  /** 可观测性与指标大盘查询。 */
  | { name: "metrics"; args?: string }
  /** 任务看板初始化、链接与状态大盘。 */
  | { name: "board"; args?: string };

// 飞书还原提及后可能得到“@机器人名称 /status”，机器人名称允许包含空格，
// 因此名称段用非贪婪匹配，避免把后面的命令内容吞进显示名。
const COMMAND_RE = /^(?:@.+?\s+)?\/(close|status|help|new|resume|team)\s*$/;
const CD_RE = /^(?:@.+?\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const COMPACT_RE = /^(?:@.+?\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/;
const DOC_RE = /^(?:@.+?\s+)?\/doc(?:\s+([\s\S]+?))?\s*$/;
const METRICS_RE = /^(?:@.+?\s+)?\/metrics(?:\s+([\s\S]+?))?\s*$/;
const BOARD_RE = /^(?:@.+?\s+)?\/board(?:\s+([\s\S]+?))?\s*$/;
/** 未显式注入注册表时的回退引擎集合（router 会传入真实注册表，保持两者同步）。 */
const DEFAULT_CLI_IDS = ["codex", "claude", "dimagent", "agy", "grok"] as const;
// /schedule 后的自然语言不硬拆，整段交给模型用 schedule_manage 理解并创建。
const SCHEDULE_RE = /^(?:@.+?\s+)?\/schedule(?:\s+([\s\S]+?))?\s*$/;
const SCHEDULES_RE = /^(?:@.+?\s+)?\/schedules\s*$/;
const ORCHESTRATE_RE =
  /^(?:@.+?\s+)?\/orchestrate(?:\s+([\s\S]+?))?\s*$/;
const PANEL_RE = /^(?:@.+?\s+)?\/panel\s*$/;
const LOGIN_RE = /^(?:@.+?\s+)?\/login\s*$/;

function stripLeadingMention(
  text: string,
  leadingMentionName: string | undefined,
): string {
  const trimmed = text.trim();
  if (!leadingMentionName) return trimmed;
  const prefix = `@${leadingMentionName}`;
  if (!trimmed.startsWith(prefix)) return trimmed;
  const remainder = trimmed.slice(prefix.length);
  // 精确名称之后必须有空白，避免把短名称误匹配成长名称前缀。
  return /^\s/.test(remainder) ? remainder.trimStart() : trimmed;
}

/** 解析受支持的会话命令；普通文本返回 undefined。 */
export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();
  const cdMatch = CD_RE.exec(value);
  if (cdMatch) return { name: "cd", path: cdMatch[1]?.trim() || undefined };

  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    return {
      name: "compact",
      instructions: compactMatch[1]?.trim() || undefined,
    };
  }
  const docMatch = DOC_RE.exec(value);
  if (docMatch) {
    return {
      name: "doc",
      prompt: docMatch[1]?.trim() || undefined,
    };
  }

  const schedulesMatch = SCHEDULES_RE.exec(value);
  if (schedulesMatch) return { name: "schedules" };

  const scheduleMatch = SCHEDULE_RE.exec(value);
  if (scheduleMatch) {
    return {
      name: "schedule",
      request: scheduleMatch[1]?.trim() || undefined,
    };
  }

  const orchestrateMatch = ORCHESTRATE_RE.exec(value);
  if (orchestrateMatch) {
    return {
      name: "orchestrate",
      prompt: orchestrateMatch[1]?.trim() || undefined,
    };
  }
  const panelMatch = PANEL_RE.exec(value);
  if (panelMatch) return { name: "panel" };
  const loginMatch = LOGIN_RE.exec(value);
  if (loginMatch) return { name: "login" };
  const metricsMatch = METRICS_RE.exec(value);
  if (metricsMatch) {
    return {
      name: "metrics",
      args: metricsMatch[1]?.trim() || undefined,
    };
  }

  const boardMatch = BOARD_RE.exec(value);
  if (boardMatch) {
    return {
      name: "board",
      args: boardMatch[1]?.trim() || undefined,
    };
  }

  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return {
    name: match[1] as
      | "close"
      | "status"
      | "help"
      | "new"
      | "resume"
      | "team",
  };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
  /** 完整的 `/<engine> login` 指令：发起该引擎的登录流程，不启动任务。 */
  login?: boolean;
}

/** 转义正则特殊字符，保证注册表里带符号的 CLI ID 也能安全参与匹配。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 解析消息开头的引擎选择；精确提及名称允许包含空格。
 * knownCliIds 由调用方从执行引擎注册表注入（router 传 ctx.cli.list()），
 * 未传时回退到内置引擎集合，保证纯函数可独立使用。
 */
export function parseCliRequest(
  text: string,
  leadingMentionName?: string,
  knownCliIds: readonly string[] = DEFAULT_CLI_IDS,
): CliRequest | undefined {
  if (knownCliIds.length === 0) return undefined;
  const pattern = knownCliIds.map(escapeRegExp).join("|");
  const match = new RegExp(
    `^(?:@.+?\\s+)?\\/(${pattern})(?:\\s+([\\s\\S]*))?$`,
  ).exec(stripLeadingMention(text, leadingMentionName));
  if (!match) return undefined;
  // 恰好是 "/<engine> login"（其余内容缺省为空）时，把它当作登录指令而不是
  // 一个以 login 为正文的任务；"/<engine> login 其他任务" 仍是普通引擎请求。
  if ((match[2] ?? "").trim() === "login") {
    return { cliId: match[1] as CliId, prompt: "", login: true };
  }
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? "").trim(),
  };
}
