/**
 * Codex 与 Claude Code 适配器测试：验证首次/续聊参数安全边界，
 * 以及两种真实 JSONL 协议到统一事件的映射。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveCliCommand } from "./command-resolver.js";

const testApplicationTools = [
  {
    id: "test_tools",
    command: process.execPath,
    args: ["test-server.js"],
    tools: ["ask_user"],
  },
] as const;

/** 断言 Claude 参数末尾携带注册表提供的 --mcp-config。 */
function expectClaudeMcpConfig(args: string[]): void {
  assert.equal(args.at(-2), "--mcp-config");
  const config = JSON.parse(args.at(-1) as string) as {
    mcpServers: Record<
      string,
      { type: string; command: string; args: string[] }
    >;
  };
  assert.equal(config.mcpServers.test_tools.type, "stdio");
  assert.equal(config.mcpServers.test_tools.command, process.execPath);
  assert.deepEqual(config.mcpServers.test_tools.args, ["test-server.js"]);
}

/** 断言 Codex 参数开头携带注册表提供的 MCP 配置。 */
function expectCodexMcpConfig(args: string[]): void {
  assert.equal(args[0], "-c");
  assert.match(args[1], /^mcp_servers\.test_tools\.command=/);
  assert.equal(args[2], "-c");
  assert.match(args[3], /^mcp_servers\.test_tools\.args=\[/);
}

test("用户提示词始终作为单独参数传给两个 CLI", () => {
  const prompt = '检查 "package.json"\n$(Remove-Item important.txt)';
  const adapters = [new ClaudeAdapter(), new CodexAdapter()];

  for (const adapter of adapters) {
    const first = adapter.buildArgs(prompt);
    const resumed = adapter.buildResumeArgs(prompt, "session-id");
    assert.equal(first.filter((argument) => argument === prompt).length, 1);
    assert.equal(resumed.filter((argument) => argument === prompt).length, 1);
  }
});

test("执行引擎只注入注册表提供的应用工具", () => {
  const plainClaude = new ClaudeAdapter();
  const plainCodex = new CodexAdapter();
  assert.equal(plainClaude.buildArgs("你好").includes("--mcp-config"), false);
  assert.equal(plainCodex.buildArgs("你好")[0], "exec");

  const claude = new ClaudeAdapter(() => testApplicationTools);
  const codex = new CodexAdapter(() => testApplicationTools);
  expectClaudeMcpConfig(claude.buildArgs("你好"));
  expectCodexMcpConfig(codex.buildArgs("你好"));
});

test("Claude Code 首次对话和续聊参数符合 headless 协议", () => {
  const adapter = new ClaudeAdapter(() => testApplicationTools);

  const first = adapter.buildArgs("你好");
  expectClaudeMcpConfig(first);
  assert.deepEqual(first.slice(0, -2), [
    "--dangerously-skip-permissions",
    "-p",
    "你好",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  const resumed = adapter.buildResumeArgs("继续", "claude-session");
  expectClaudeMcpConfig(resumed);
  assert.deepEqual(resumed.slice(0, -2), [
    "--resume",
    "claude-session",
    "--dangerously-skip-permissions",
    "-p",
    "继续",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  const compact = adapter.buildCompactPlan("claude-session", "保留接口");
  expectClaudeMcpConfig(compact.args);
  assert.equal(compact.protocol, "claude-stream-json");
  assert.equal(compact.command, "claude");
  assert.deepEqual(compact.args.slice(0, -2), [
    "--resume",
    "claude-session",
    "--dangerously-skip-permissions",
    "-p",
    "/compact 保留接口",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
});

test("Codex 首次对话和续聊参数符合 exec 协议", () => {
  const adapter = new CodexAdapter(() => testApplicationTools);

  const first = adapter.buildArgs("你好");
  expectCodexMcpConfig(first);
  assert.deepEqual(first.slice(4), [
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "你好",
  ]);
  const resumed = adapter.buildResumeArgs("继续", "codex-thread");
  expectCodexMcpConfig(resumed);
  assert.deepEqual(resumed.slice(4), [
    "exec",
    "resume",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "codex-thread",
    "继续",
  ]);
  assert.deepEqual(adapter.buildCompactPlan("codex-thread"), {
    protocol: "codex-app-server",
    command: "codex",
    args: ["app-server"],
    sessionId: "codex-thread",
  });
});

test("Windows 下解析到可直接 spawn 的真实 CLI 入口", () => {
  if (process.platform !== "win32") return;

  const codex = resolveCliCommand("codex");
  const claude = resolveCliCommand("claude");

  assert.equal(existsSync(codex.command), true);
  assert.equal(existsSync(claude.command), true);
  assert.equal(codex.command.toLowerCase().endsWith(".cmd"), false);
  assert.equal(claude.command.toLowerCase().endsWith(".cmd"), false);
});

test("Windows 下 Grok 可解析到 ~/.grok/bin 的真实 exe", () => {
  if (process.platform !== "win32") return;
  const grok = resolveCliCommand("grok");
  if (!existsSync(grok.command)) return;
  assert.equal(grok.command.toLowerCase().endsWith(".cmd"), false);
  assert.match(grok.command.toLowerCase(), /grok\.exe$/);
});

test("Claude Code 一行解析上下文和全部工具调用", () => {
  const adapter = new ClaudeAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session",
      }),
    ),
    [{ type: "session", sessionId: "claude-session" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
          },
          content: [
            {
              type: "tool_use",
              id: "tool-read",
              name: "Read",
              input: { file_path: "C:\\repo\\src\\index.ts" },
            },
            {
              type: "tool_use",
              id: "tool-bash",
              name: "Bash",
              input: { description: "  运行   测试  " },
            },
          ],
        },
      }),
    ),
    [
      { type: "context", usedTokens: 38 },
      {
        type: "tool_start",
        toolUseId: "tool-read",
        toolName: "Read",
        label: "读取文件",
        detail: "repo/src/index.ts",
      },
      {
        type: "tool_start",
        toolUseId: "tool-bash",
        toolName: "Bash",
        label: "运行命令",
        detail: "运行 测试",
      },
    ],
  );
});

test("Claude Code 解析工具结果、最终统计和结果错误", () => {
  const adapter = new ClaudeAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-read" },
            {
              type: "tool_result",
              tool_use_id: "tool-bash",
              is_error: true,
            },
          ],
        },
      }),
    ),
    [
      { type: "tool_end", toolUseId: "tool-read", failed: false },
      { type: "tool_end", toolUseId: "tool-bash", failed: true },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        result: "项目名是 threadpilot",
        session_id: "claude-session",
        duration_ms: 1_500,
        num_turns: 2,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
        },
        modelUsage: {
          claude: { contextWindow: 200_000 },
          fallback: { contextWindow: 128_000 },
        },
      }),
    ),
    [
      {
        type: "result",
        answer: "项目名是 threadpilot",
        complete: true,
        sessionId: "claude-session",
        stats: {
          durationMs: 1_500,
          turns: 2,
          totalTokens: 38,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 20,
          cacheCreationTokens: 3,
          contextWindowTokens: 200_000,
        },
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "余额不足",
      }),
    ),
    [{ type: "error", message: "余额不足" }],
  );
  assert.deepEqual(adapter.parseEvents("diagnostic"), []);
  assert.deepEqual(
    adapter.parseEvents(JSON.stringify({ type: "assistant" })),
    [],
  );
});

test("Codex 解析会话、四类工具、上下文、统计和最终回答", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
    ),
    [{ type: "session", sessionId: "codex-thread" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "pwsh.exe -Command Get-Location",
          status: "in_progress",
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-1",
        toolName: "Bash",
        label: "运行命令",
        detail: "pwsh.exe -Command Get-Location",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          exit_code: 0,
          status: "completed",
        },
      }),
    ),
    [{ type: "tool_end", toolUseId: "item-1", failed: false }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-file",
          type: "file_change",
          changes: [{ path: "src/index.ts" }],
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-file",
        toolName: "Edit",
        label: "修改文件",
        detail: "src/index.ts",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: { id: "item-search", type: "web_search", query: "Codex CLI" },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-search",
        toolName: "WebSearch",
        label: "搜索资料",
        detail: "Codex CLI",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-mcp",
          type: "mcp_tool_call",
          server: "github",
          tool: "get_issue",
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-mcp",
        toolName: "MCP",
        label: "调用外部工具",
        detail: "github.get_issue",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "项目名是 threadpilot" },
      }),
    ),
    [{ type: "result", answer: "项目名是 threadpilot", complete: false }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 76_260,
          cached_input_tokens: 41_216,
          output_tokens: 126,
        },
      }),
    ),
    [
      { type: "context", usedTokens: 76_260 },
      {
        type: "result",
        answer: "",
        complete: true,
        stats: {
          totalTokens: 76_386,
          inputTokens: 76_260,
          outputTokens: 126,
          cacheReadTokens: 41_216,
        },
      },
    ],
  );
});

test("Codex 标记命令失败并解析协议错误", () => {
  const adapter = new CodexAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item-failed",
          type: "command_execution",
          exit_code: 1,
          status: "failed",
        },
      }),
    ),
    [{ type: "tool_end", toolUseId: "item-failed", failed: true }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "模型不可用" },
      }),
    ),
    [{ type: "error", message: "模型不可用" }],
  );
  assert.deepEqual(adapter.parseEvents("not-json"), []);
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.completed",
        item: { id: "reasoning", type: "reasoning", text: "分析" },
      }),
    ),
    [],
  );
});

test("Claude Code 把已注册应用工具调用翻译成统一的 tool_call 事件", () => {
  const adapter = new ClaudeAdapter(() => [
    {
      id: "threadpilot",
      command: "test",
      args: [],
      tools: ["request_clarification"],
    },
  ]);

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-clarify",
              name: "mcp__threadpilot__request_clarification",
              input: {
                title: "确认优先级功能范围",
                questions: [
                  {
                    id: "priority_scope",
                    prompt: "优先级需要支持几档？",
                    options: [
                      { id: "three", label: "高、中、低三档" },
                      { id: "custom", label: "允许自定义优先级" },
                    ],
                    recommendedOptionId: "three",
                  },
                ],
              },
            },
          ],
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "tool-clarify",
        toolName: "mcp__threadpilot__request_clarification",
        label: "调用 mcp__threadpilot__request_clarification",
      },
      {
        type: "tool_call",
        toolUseId: "tool-clarify",
        toolName: "request_clarification",
        input: {
          title: "确认优先级功能范围",
          questions: [
            {
              id: "priority_scope",
              prompt: "优先级需要支持几档？",
              options: [
                { id: "three", label: "高、中、低三档" },
                { id: "custom", label: "允许自定义优先级" },
              ],
              recommendedOptionId: "three",
            },
          ],
        },
      },
    ],
  );
});

test("Codex 把已注册应用工具调用翻译成统一的 tool_call 事件", () => {
  const adapter = new CodexAdapter(() => [
    {
      id: "threadpilot",
      command: "test",
      args: [],
      tools: ["request_clarification"],
    },
  ]);

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item-clarify",
          type: "mcp_tool_call",
          server: "threadpilot",
          tool: "request_clarification",
          arguments: {
            title: "确认优先级功能范围",
            questions: [
              {
                id: "priority_scope",
                prompt: "优先级需要支持几档？",
                options: [
                  { id: "three", label: "高、中、低三档" },
                  { id: "custom", label: "允许自定义优先级" },
                ],
                recommendedOptionId: "three",
              },
            ],
          },
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "item-clarify",
        toolName: "MCP",
        label: "调用外部工具",
        detail: "threadpilot.request_clarification",
      },
      {
        type: "tool_call",
        toolUseId: "item-clarify",
        toolName: "request_clarification",
        input: {
          title: "确认优先级功能范围",
          questions: [
            {
              id: "priority_scope",
              prompt: "优先级需要支持几档？",
              options: [
                { id: "three", label: "高、中、低三档" },
                { id: "custom", label: "允许自定义优先级" },
              ],
              recommendedOptionId: "three",
            },
          ],
        },
      },
    ],
  );
});

test("适配器能识别失效的续聊会话并忽略普通模型错误", () => {
  assert.equal(
    new CodexAdapter().isSessionUnavailable("Could not find thread abc"),
    true,
  );
  assert.equal(
    new CodexAdapter().isSessionUnavailable("模型不可用"),
    false,
  );
  assert.equal(
    new ClaudeAdapter().isSessionUnavailable("No such session: abc"),
    true,
  );
  assert.equal(
    new ClaudeAdapter().isSessionUnavailable("rate limit exceeded"),
    false,
  );
});
