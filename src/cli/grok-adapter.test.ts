/**
 * Grok CLI 适配器测试：验证 headless 参数构造、streaming-messages-json
 * 事件翻译、MCP 元工具展开、原生会话列表、compact 拒绝与登录识别。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { GrokAdapter } from "./grok-adapter.js";
import { listNativeCliSessions } from "./native-sessions.js";

const testApplicationTools = [
  {
    id: "threadpilot_clarification",
    command: process.execPath,
    args: ["server.js"],
    tools: ["request_clarification"],
  },
] as const;

test("GrokAdapter 默认使用 headless，并构造首次/续聊参数", () => {
  const adapter = new GrokAdapter();
  const prompt = '检查 "package.json"\n$(Remove-Item important.txt)';

  assert.equal(adapter.command, "grok");
  assert.equal(adapter.accessMode, "headless");
  assert.equal(adapter.displayName, "Grok");
  assert.deepEqual(adapter.buildArgs(prompt), [
    "-p",
    prompt,
    "--output-format",
    "streaming-messages-json",
    "--always-approve",
    "--no-auto-update",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "sess-abc"), [
    "--resume",
    "sess-abc",
    "-p",
    "继续",
    "--output-format",
    "streaming-messages-json",
    "--always-approve",
    "--no-auto-update",
  ]);
});

test("GrokAdapter 解析 init、工具配对、用量与终态回答", () => {
  const adapter = new GrokAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-abc",
        model: "grok-4.6",
      }),
    ),
    [{ type: "session", sessionId: "sess-abc" }],
  );

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        session_id: "sess-abc",
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
              id: "call_1",
              name: "read_file",
              input: { path: "src/cli/grok-adapter.ts" },
            },
          ],
        },
      }),
    ),
    [
      { type: "context", usedTokens: 38 },
      {
        type: "tool_start",
        toolUseId: "call_1",
        toolName: "read_file",
        label: "读取文件",
        detail: "src/cli/grok-adapter.ts",
      },
    ],
  );

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "user",
        session_id: "sess-abc",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              is_error: false,
            },
          ],
        },
      }),
    ),
    [{ type: "tool_end", toolUseId: "call_1", failed: false }],
  );

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "检查完成",
        session_id: "sess-abc",
        duration_ms: 1200,
        num_turns: 2,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
        },
      }),
    ),
    [
      {
        type: "result",
        answer: "检查完成",
        complete: true,
        sessionId: "sess-abc",
        stats: {
          durationMs: 1200,
          turns: 2,
          totalTokens: 38,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 20,
          cacheCreationTokens: 3,
        },
      },
    ],
  );
});

test("GrokAdapter 识别直接 MCP 名与 use_tool 转发的应用工具", () => {
  const adapter = new GrokAdapter(() => testApplicationTools);

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_direct",
              name: "threadpilot_clarification__request_clarification",
              input: { title: "确认范围" },
            },
          ],
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "call_direct",
        toolName: "threadpilot_clarification__request_clarification",
        label: "调用 threadpilot_clarification__request_clarification",
      },
      {
        type: "tool_call",
        toolUseId: "call_direct",
        toolName: "request_clarification",
        input: { title: "确认范围" },
      },
    ],
  );

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_meta",
              name: "use_tool",
              input: {
                tool_name: "threadpilot_clarification__request_clarification",
                arguments: { title: "确认范围" },
              },
            },
          ],
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "call_meta",
        toolName: "use_tool",
        label: "调用外部工具",
        detail: "threadpilot_clarification__request_clarification",
      },
      {
        type: "tool_call",
        toolUseId: "call_meta",
        toolName: "request_clarification",
        input: { title: "确认范围" },
      },
    ],
  );

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_meta_input",
              name: "use_tool",
              input: {
                tool_name: "threadpilot_clarification__request_clarification",
                tool_input: {
                  title: "任务优先级范围",
                  questions: [{ id: "priority-scope", prompt: "落到哪一层？" }],
                },
              },
            },
          ],
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "call_meta_input",
        toolName: "use_tool",
        label: "调用外部工具",
        detail: "threadpilot_clarification__request_clarification",
      },
      {
        type: "tool_call",
        toolUseId: "call_meta_input",
        toolName: "request_clarification",
        input: {
          title: "任务优先级范围",
          questions: [{ id: "priority-scope", prompt: "落到哪一层？" }],
        },
      },
    ],
  );
});

test("GrokAdapter 明确拒绝原生 compact 并识别失效会话与认证需求", () => {
  const adapter = new GrokAdapter();

  assert.throws(() => adapter.buildCompactPlan("sess-abc"), /暂不支持原生 \/compact/);
  assert.equal(adapter.isSessionUnavailable("session does not exist: sess-abc"), true);
  assert.equal(adapter.isSessionUnavailable("Couldn't start session: not found"), true);
  assert.equal(adapter.isSessionUnavailable("普通编译错误"), false);

  assert.equal(adapter.loginMode, "device");
  assert.equal(typeof adapter.login, "function");
  assert.equal(adapter.isAuthRequired("Please run grok login --device-auth"), true);
  assert.equal(adapter.isAuthRequired("Not authenticated. Set XAI_API_KEY"), true);
  assert.equal(adapter.isAuthRequired("session does not exist: sess-abc"), false);
  assert.equal(adapter.isAuthRequired("命令执行失败：exit code 1"), false);
});

test("GrokAdapter 读取当前工作目录的原生会话并过滤其他 cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadpilot-grok-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = root;

  try {
    const group = join(root, "sessions", encodeURIComponent(resolve(cwd)));
    const olderDir = join(group, "sess-old");
    const newerDir = join(group, "sess-new");
    const foreignDir = join(group, "sess-foreign");
    await mkdir(olderDir, { recursive: true });
    await mkdir(newerDir, { recursive: true });
    await mkdir(foreignDir, { recursive: true });
    await writeFile(
      join(olderDir, "summary.json"),
      JSON.stringify({
        info: { id: "sess-old", cwd },
        generated_title: "旧任务",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      join(newerDir, "summary.json"),
      JSON.stringify({
        info: { id: "sess-new", cwd },
        generated_title: "新任务",
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      join(foreignDir, "summary.json"),
      JSON.stringify({
        info: { id: "sess-foreign", cwd: join(root, "other") },
        generated_title: "别的项目",
        updated_at: "2026-07-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const sessions = await listNativeCliSessions({
      adapter: new GrokAdapter(),
      cwd,
    });
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["sess-new", "sess-old"],
    );
    assert.equal(sessions[0]?.title, "新任务");
    assert.equal(sessions[1]?.title, "旧任务");
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});

test("Grok 会话目录不存在时返回空列表", async () => {
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = join(tmpdir(), "threadpilot-grok-missing-home");
  try {
    const sessions = await listNativeCliSessions({
      adapter: new GrokAdapter(),
      cwd: join(tmpdir(), "threadpilot-grok-missing-cwd"),
    });
    assert.deepEqual(sessions, []);
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});
