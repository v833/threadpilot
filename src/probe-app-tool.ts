/**
 * 应用工具探针：不经过飞书，直接驱动 Claude/Codex/DimAgent/agy/Grok 调用
 * request_clarification，验证 MCP 工具链、Adapter 解析与 Schema 校验。
 */
import { resolve } from "node:path";
import { clarificationToolServer } from "./plugins/clarification-tool.js";
import { AgyAdapter } from "./cli/agy-adapter.js";
import { ClaudeAdapter } from "./cli/claude-adapter.js";
import { CodexAdapter } from "./cli/codex-adapter.js";
import { DimagentAdapter } from "./cli/dimagent-adapter.js";
import { GrokAdapter } from "./cli/grok-adapter.js";
import { getCliAdapter, registerCliAdapter } from "./cli/registry.js";
import { runCli } from "./cli/runner.js";
import type { CliId } from "./cli/types.js";
import { findClarificationRequest } from "./core/clarification.js";

const cliId = process.argv[2] as CliId | undefined;
const workspace = process.argv[3] ?? process.cwd();
if (
  cliId !== "claude" &&
  cliId !== "codex" &&
  cliId !== "dimagent" &&
  cliId !== "agy" &&
  cliId !== "grok"
) {
  console.error("用法：pnpm probe:tool <claude|codex|dimagent|agy|grok> [工作目录]");
  process.exit(1);
}

const applicationTools = [clarificationToolServer()];

// 探针独立于插件装配运行，需要显式装配澄清插件提供的应用工具描述。
registerCliAdapter(new ClaudeAdapter(() => applicationTools));
registerCliAdapter(new CodexAdapter(() => applicationTools));
registerCliAdapter(new DimagentAdapter(() => applicationTools));
registerCliAdapter(new AgyAdapter(() => applicationTools));
registerCliAdapter(new GrokAdapter(() => applicationTools));

const adapter = getCliAdapter(cliId);
const result = await runCli({
  adapter,
  cwd: resolve(workspace),
  prompt: [
    "我们准备给任务列表增加优先级功能。",
    "请调用 request_clarification，询问一个会实质影响实现范围的问题。",
    "提供 2 到 4 个清晰选项，并标记推荐项。",
    "调用工具后，用一句话结束。",
  ].join("\n"),
  onEvent(event) {
    if (event.type !== "tool_call") return;
    console.log(`\n[应用工具] ${event.toolName}`);
    console.log(JSON.stringify(event.input, null, 2));
  },
});

const unexpectedTool = result.toolCalls?.find(
  (call) => call.toolName !== "request_clarification",
);
if (unexpectedTool) {
  throw new Error(`应用层收到未统一的工具名：${unexpectedTool.toolName}`);
}

const clarification = findClarificationRequest(result.toolCalls);
if (!clarification) {
  throw new Error(
    `${adapter.displayName} 没有返回通过 Zod Schema 校验的 request_clarification`,
  );
}

console.log(
  `\n[完成] ${adapter.displayName} 返回 ${clarification.questions.length} 个合法问题`,
);
