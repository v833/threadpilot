/**
 * Grok CLI 协议适配器：把 `grok -p --output-format streaming-messages-json`
 * 的 headless 输出接入 ThreadPilot。Grok 的 ACP 接入由通用 AcpAdapter
 * （engines/acp 插件）提供，不内嵌于此。
 *
 * 选用 streaming-messages-json 而不是 streaming-json：每行带 session_id，
 * 终态 result 携带完整答案，适配器无需跨行累积，并发多任务不会串话。
 * 该流外形接近 Claude stream-json，但 init/result 字段并不保证过 Claude
 * schema，因此独立解析，不复用 ClaudeAdapter。
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ApplicationToolProvider } from "./app-tools.js";
import { findAcpApplicationTool } from "./app-tools.js";
import { resolveCliCommand } from "./command-resolver.js";
import { ensureGrokMcpConfig } from "./grok-mcp-config.js";
import { captureProcessTree, stopProcessTree } from "./process-tree.js";
import { summarizeOutput } from "./pty-login.js";
import type {
  CliAccessMode,
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliLoginOptions,
  CliRunStats,
  CliSessionSummary,
} from "./types.js";

/** /resume 卡片最多展示的原生会话数量。 */
const SESSION_LIMIT = 8;
/** 设备码登录的等待上限；用户在浏览器授权通常需要一两分钟，给足缓冲。 */
const DEVICE_LOGIN_TIMEOUT_MS = 5 * 60_000;

interface GrokEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  message?: unknown;
}

interface GrokContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  search_replace: "修改文件",
  grep: "搜索代码",
  list_dir: "列出目录",
  run_terminal_command: "运行命令",
  web_search: "搜索资料",
  web_fetch: "读取网页",
  todo_write: "更新任务",
  spawn_subagent: "启动子任务",
  memory_search: "搜索记忆",
  search_tool: "查找外部工具",
  use_tool: "调用外部工具",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(normalized.startsWith("/") ? -2 : -3).join("/");
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1)}…`
    : text;
}

function messageBlocks(message: unknown): GrokContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const values = [
    asNumber(usage.input_tokens),
    asNumber(usage.output_tokens),
    asNumber(usage.cache_read_input_tokens),
    asNumber(usage.cache_creation_input_tokens),
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => value + sum, 0)
    : undefined;
}

function contextWindowTokens(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const windows = Object.values(modelUsage)
    .filter(isRecord)
    .map((usage) => asNumber(usage.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0);
  return windows.length ? Math.max(...windows) : undefined;
}

function parseStats(event: GrokEvent): CliRunStats | undefined {
  const usage = isRecord(event.usage) ? event.usage : {};
  const durationMs = asNumber(event.duration_ms);
  const turns = asNumber(event.num_turns);
  const totalTokens = usageTokens(usage);
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = asNumber(usage.cache_creation_input_tokens);
  const windowTokens = contextWindowTokens(event.modelUsage);
  const stats: CliRunStats = {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(windowTokens !== undefined ? { contextWindowTokens: windowTokens } : {}),
  };
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function toolDetail(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (name === "read_file" || name === "search_replace" || name === "list_dir") {
    return shortPath(input.path);
  }
  if (name === "grep") return shortText(input.pattern);
  if (name === "run_terminal_command") {
    return shortText(input.command ?? input.CommandLine);
  }
  if (name === "web_search") return shortText(input.query);
  if (name === "web_fetch") return shortText(input.url);
  if (name === "use_tool" || name === "call_mcp_tool") {
    return shortText(
      input.tool_name ?? input.ToolName ?? input.name ?? input.tool,
    );
  }
  return undefined;
}

function parseInnerInput(input: Record<string, unknown>): unknown {
  let inner =
    input.tool_input ??
    input.arguments ??
    input.Arguments ??
    input.input ??
    input.params;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      return inner;
    }
  }
  return inner ?? input;
}

/**
 * 识别 ThreadPilot 应用工具。Grok 可能直接调用 MCP 展开名
 *（`server__tool`），也可能经 use_tool / call_mcp_tool 转发。
 */
function applicationToolCall(
  servers: ReturnType<ApplicationToolProvider>,
  toolName: string,
  input: unknown,
): { toolName: string; input: unknown } | undefined {
  const direct = findAcpApplicationTool(servers, toolName);
  if (direct) return { toolName: direct, input };
  if (
    (toolName === "use_tool" || toolName === "call_mcp_tool") &&
    isRecord(input)
  ) {
    const innerName =
      asString(input.tool_name) ??
      asString(input.ToolName) ??
      asString(input.name) ??
      asString(input.tool);
    if (!innerName) return undefined;
    const inner = findAcpApplicationTool(servers, innerName);
    if (!inner) return undefined;
    return { toolName: inner, input: parseInnerInput(input) };
  }
  return undefined;
}

function outputArgs(prompt: string): string[] {
  // 机器人无法展示交互式确认；提示词保持为独立参数，避免拼进 shell。
  return [
    "-p",
    prompt,
    "--output-format",
    "streaming-messages-json",
    "--always-approve",
    "--no-auto-update",
  ];
}

function grokHomeDir(): string {
  return process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

/** Grok 按 URL 编码的绝对 cwd 分组存放会话。 */
function grokSessionGroupDir(cwd: string): string {
  return join(grokHomeDir(), "sessions", encodeURIComponent(resolve(cwd)));
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function readGrokSession(
  directory: string,
  expectedCwd: string,
): Promise<CliSessionSummary | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const info = isRecord(parsed.info) ? parsed.info : {};
  const id = asString(info.id);
  if (!id) return undefined;
  const observedCwd = asString(info.cwd);
  if (observedCwd && !samePath(observedCwd, expectedCwd)) return undefined;
  const title =
    asString(parsed.generated_title) ??
    asString(parsed.session_summary) ??
    asString(parsed.last_turn_summary) ??
    "未命名会话";
  const updatedAt =
    asString(parsed.updated_at) ??
    asString(parsed.last_active_at) ??
    new Date(0).toISOString();
  return { id, title, updatedAt };
}

/** 将 Grok 的命令行和 JSONL 协议适配为 ThreadPilot 公共事件。 */
export class GrokAdapter implements CliAdapter {
  readonly id = "grok" as const;
  readonly command = "grok";
  readonly displayName = "Grok";
  readonly accessMode: CliAccessMode = "headless";
  /** Grok 平台 OAuth 走设备码流程，用户在浏览器授权，无需在卡片输入 key。 */
  readonly loginMode = "device" as const;

  constructor(
    private readonly applicationTools: ApplicationToolProvider = () => [],
  ) {}

  /** 每轮启动前把插件 Server 增量合并到当前工作区的 `.grok/config.toml`。 */
  async prepareRun(cwd: string): Promise<void> {
    await ensureGrokMcpConfig(cwd, this.applicationTools());
  }

  getApplicationTools() {
    return this.applicationTools();
  }

  buildArgs(prompt: string): string[] {
    return outputArgs(prompt);
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["--resume", sessionId, ...outputArgs(prompt)];
  }

  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    throw new Error("Grok 暂不支持原生 /compact，请在话题中发起整理任务");
  }

  isSessionUnavailable(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /(?:session|conversation)[^\n]*(?:not found|could not find|does not exist|expired|invalid|unknown)/.test(
        text,
      ) ||
      /(?:not found|could not find|does not exist|expired|invalid|unknown)[^\n]*(?:session|conversation)/.test(
        text,
      ) ||
      /no (?:such )?(?:session|conversation)\b/.test(text)
    );
  }

  isAuthRequired(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /authentication\s+required/.test(text) ||
      /not\s+authenticated/.test(text) ||
      /please\s+(?:run\s+)?grok\s+login/.test(text) ||
      /run:\s*grok\s+login/.test(text) ||
      /please\s+sign\s+in/.test(text) ||
      /sign\s+in\s+(?:first|required|again)/.test(text) ||
      /xai_api_key/.test(text) ||
      /no\s+(?:cached\s+)?credentials/.test(text)
    );
  }

  /**
   * 用设备码流程完成 Grok 登录：`grok login --device-auth` 打印授权 URL
   * 与设备码后轮询等待，用户在浏览器授权后以退出码 0 结束并写入凭据。
   * 全程不读 stdin；stdout 经 onOutput 转发到登录卡片。
   */
  async login(_code: string, options: CliLoginOptions = {}): Promise<void> {
    const executable = resolveCliCommand(this.command);
    await new Promise<void>((resolvePromise, reject) => {
      const processStartedAt = Date.now();
      const child = spawn(
        executable.command,
        [...executable.argsPrefix, "login", "--device-auth"],
        {
          cwd: options.cwd ?? process.cwd(),
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const processTreeSnapshot = captureProcessTree(child.pid, processStartedAt);
      let output = "";
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        void stopProcessTree(child, processTreeSnapshot).then(() =>
          fail(new Error("登录超时：请在浏览器中完成授权后再试。")),
        );
      }, options.timeoutMs ?? DEVICE_LOGIN_TIMEOUT_MS);
      const collect = (chunk: Buffer | string) => {
        const text = chunk.toString();
        output += text;
        options.onOutput?.(text);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => fail(error));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          options.onOutput?.("\n[threadpilot] 登录进程已退出（状态码 0）\n");
          resolvePromise();
        } else {
          fail(
            new Error(
              `登录没有完成（退出码 ${code}）：${summarizeOutput(output)}`,
            ),
          );
        }
      });
    });
  }

  /** 读取 Grok 当前工作目录下的原生会话，供 /resume 卡片展示。 */
  async listNativeSessions(cwd: string): Promise<CliSessionSummary[]> {
    const groupDir = grokSessionGroupDir(cwd);
    let names: string[];
    try {
      names = await readdir(groupDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const sessions = await Promise.all(
      names.map((name) => readGrokSession(join(groupDir, name), cwd)),
    );
    return sessions
      .filter((session): session is CliSessionSummary => session !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, SESSION_LIMIT);
  }

  parseEvent(line: string): CliEvent | undefined {
    return this.parseEvents(line)[0];
  }

  parseEvents(line: string): CliEvent[] {
    let event: GrokEvent;
    try {
      event = JSON.parse(line) as GrokEvent;
    } catch {
      return [];
    }

    const sessionId =
      typeof event.session_id === "string" ? event.session_id : undefined;

    if (event.type === "system" && event.subtype === "init" && sessionId) {
      return [{ type: "session", sessionId }];
    }

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      const usedTokens = usageTokens(message.usage);
      const contextEvents: CliEvent[] =
        usedTokens === undefined ? [] : [{ type: "context", usedTokens }];
      const toolEvents = messageBlocks(event.message).flatMap(
        (block): CliEvent[] => {
          if (
            block.type !== "tool_use" ||
            typeof block.id !== "string" ||
            typeof block.name !== "string"
          ) {
            return [];
          }
          const detail = toolDetail(block.name, block.input);
          const events: CliEvent[] = [
            {
              type: "tool_start",
              toolUseId: block.id,
              toolName: block.name,
              label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
              ...(detail ? { detail } : {}),
            },
          ];
          const application = applicationToolCall(
            this.applicationTools(),
            block.name,
            block.input,
          );
          if (application) {
            events.push({
              type: "tool_call",
              toolUseId: block.id,
              toolName: application.toolName,
              input: application.input,
            });
          }
          return events;
        },
      );
      return [...contextEvents, ...toolEvents];
    }

    if (event.type === "user") {
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string"
        ) {
          return [];
        }
        return [
          {
            type: "tool_end",
            toolUseId: block.tool_use_id,
            failed: block.is_error === true,
          },
        ];
      });
    }

    if (event.type !== "result") return [];
    const failed =
      event.is_error === true ||
      (typeof event.subtype === "string" && event.subtype.startsWith("error"));
    if (failed) {
      return [
        {
          type: "error",
          message:
            typeof event.result === "string"
              ? event.result
              : "Grok 执行失败",
          ...(sessionId ? { sessionId } : {}),
        },
      ];
    }
    if (typeof event.result !== "string") return [];
    const stats = parseStats(event);
    return [
      {
        type: "result",
        answer: event.result,
        complete: true,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      },
    ];
  }
}
