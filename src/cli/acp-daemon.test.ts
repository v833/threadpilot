/**
 * AcpDaemon 常驻进程测试：用 Node 子进程模拟标准 stdio server，覆盖
 * 多轮进程复用、并发 session 路由、空闲回收与崩溃重连，不依赖真实 DimAgent。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { AcpDaemon as ProductionAcpDaemon } from "./acp-daemon.js";
import type { ApplicationToolServer } from "./app-tools.js";
import type {
  AcpMcpTransport,
  AcpResumeMethod,
  AcpSessionConfig,
  CliAdapter,
  CliEvent,
} from "./types.js";

/** ACP 协议测试的假 server 没有后代，直属进程清理可避免每条用例扫描 WMI。 */
function stopRootProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2_000);
    timer.unref();
    child.once("close", finish);
    child.kill();
  });
}

class AcpDaemon extends ProductionAcpDaemon {
  constructor(
    adapter: CliAdapter,
    idleTimeoutMs?: number,
    env?: Record<string, string>,
  ) {
    super(adapter, idleTimeoutMs, env, stopRootProcess);
  }
}

/** 常驻进程测试用脚本：session/new 返回递增 id，prompt 应答包含自身 sessionId，
 *  用于验证同一进程上多轮/并发 turn 的通知路由互不串扰。 */
const ACP_RESIDENT_SERVER_SCRIPT = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
let nextSession = 0;
let mcpCount = 0;
let mcpHeaders = [];
let setupLog = [];
let sessionCwd = "";
let initialized = false;
const heldPrompts = new Map();
const cancelledSessions = new Set();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const respond = () => {
      initialized = true;
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: process.env.THREADPILOT_TEST_VERSION || "0.3.16" }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } } });
    };
    const delayMs = Number(process.env.THREADPILOT_TEST_INITIALIZE_DELAY_MS || "0");
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
    return;
  }
  if (message.method === "session/new") {
    if (!initialized) {
      send({ id: message.id, error: { code: -32000, message: "session/new before initialize" } });
      return;
    }
    if (process.env.THREADPILOT_TEST_HOLD_SESSION_NEW === "1") return;
    mcpCount = Array.isArray(message.params && message.params.mcpServers) ? message.params.mcpServers.length : 0;
    mcpHeaders = message.params && message.params.mcpServers && message.params.mcpServers[0] && message.params.mcpServers[0].headers || [];
    sessionCwd = message.params.cwd;
    send({ id: message.id, result: {
      sessionId: "acp-session-" + (++nextSession),
      configOptions: [
        { id: "permission", type: "select", currentValue: "read-only", options: [{ value: "read-only", name: "Read Only" }, { value: "full-access", name: "Full Access" }] },
        { id: "mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }] },
        { id: "model", category: "model", type: "select", currentValue: "test-model-a", options: [{ value: "test-model-a", name: "A" }, { value: "test-model-b", name: "B" }] },
      ],
      models: { availableModels: [{ modelId: "test-model-a", name: "A" }, { modelId: "test-model-b", name: "B" }] },
    } });
    return;
  }
  if (message.method === "session/set_config_option") {
    if (process.env.THREADPILOT_TEST_CONFIG_FAIL === "1" && !process.env.THREADPILOT_TEST_CONFIG_RELEASED) {
      process.env.THREADPILOT_TEST_CONFIG_RELEASED = "1";
      send({ id: message.id, error: { code: -32603, message: "set config failed" } });
      return;
    }
    setupLog.push(message.params.configId + "=" + message.params.value);
    send({ id: message.id, result: { configOptions: [
      { id: "permission", type: "select", currentValue: message.params.configId === "permission" ? message.params.value : "read-only", options: [{ value: "read-only", name: "Read Only" }, { value: "full-access", name: "Full Access" }] },
      { id: "mode", type: "select", currentValue: message.params.configId === "mode" ? message.params.value : "agent", options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }] },
      { id: "model", category: "model", type: "select", currentValue: "test-model-a", options: [{ value: "test-model-a", name: "A" }, { value: "test-model-b", name: "B" }] },
    ] } });
    return;
  }
  if (message.method === "session/set_model") {
    setupLog.push("model=" + message.params.modelId);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/resume") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/load") {
    if (process.env.THREADPILOT_TEST_LOAD_HELD === "1" && !process.env.THREADPILOT_TEST_LOAD_RELEASED) {
      process.env.THREADPILOT_TEST_LOAD_RELEASED = "1";
      send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: "Session held by another process" } } });
    } else {
      send({ id: message.id, result: {} });
    }
    return;
  }
  if (message.method === "session/cancel") {
    const sessionId = message.params.sessionId;
    cancelledSessions.add(sessionId);
    const promptId = heldPrompts.get(sessionId);
    if (promptId !== undefined) {
      heldPrompts.delete(sessionId);
      send({ id: promptId, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (message.method === "session/close") {
    setupLog.push("close");
    const respond = () => send({ id: message.id, result: {} });
    const delayMs = Number(process.env.THREADPILOT_TEST_CLOSE_DELAY_MS || "0");
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
    return;
  }
  if (message.method !== "session/prompt") return;
  const sessionId = message.params.sessionId;
  if (process.env.THREADPILOT_TEST_HOLD_PROMPT === "1" && !cancelledSessions.has(sessionId)) {
    heldPrompts.set(sessionId, message.id);
    return;
  }
  if (process.env.THREADPILOT_TEST_MCP === "1") {
    if (process.env.THREADPILOT_TEST_STREAMED_INPUT === "1") {
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "mcp-call", title: "澄清", name: "request_clarification", status: "in_progress" } } });
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "mcp-call", status: "completed", rawInput: { questions: [{ id: "q1", prompt: "p1" }] } } } });
    } else {
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "mcp-call", title: process.env.THREADPILOT_TEST_MCP_TITLE === "1" ? "threadpilot_clarification__request_clarification" : "澄清", ...(process.env.THREADPILOT_TEST_MCP_TITLE === "1" ? {} : { name: "request_clarification" }), status: "in_progress", rawInput: { questions: [] } } } });
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "mcp-call", status: "completed" } } });
    }
  }
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.THREADPILOT_TEST_PROXY || (cancelledSessions.has(sessionId) ? "cancel-seen" : (process.env.THREADPILOT_TEST_SETUP === "1" ? (setupLog.join("|") + "|cwd=" + sessionCwd) : (process.env.THREADPILOT_TEST_MCP_HEADERS === "1" ? JSON.stringify(mcpHeaders) : (process.env.THREADPILOT_TEST_MCP === "1" ? ("mcp-" + mcpCount) : ("答-" + sessionId))))) } } }
  });
  send({ id: message.id, result: { stopReason: "end_turn", usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 } } });
});
`;

class AcpScriptAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = process.execPath;
  readonly displayName = "测试 DimAgent";
  readonly accessMode = "acp" as const;

  constructor(
    private readonly applicationTools: () => readonly ApplicationToolServer[] = () => [],
    private readonly sessionConfig?: AcpSessionConfig,
    private readonly resumeMethod?: AcpResumeMethod,
    private readonly minAgentVersion?: string,
    private readonly acpMcpTransports?: readonly AcpMcpTransport[],
  ) {}

  buildArgs(): string[] {
    return ["-e", ACP_RESIDENT_SERVER_SCRIPT];
  }

  buildResumeArgs(): string[] {
    return this.buildArgs();
  }

  buildCompactPlan(): never {
    throw new Error("测试不支持 compact");
  }

  parseEvents(): CliEvent[] {
    return [];
  }

  getApplicationTools() {
    return this.applicationTools();
  }

  getAcpSessionConfig() {
    return this.sessionConfig;
  }

  getAcpResumeMethod() {
    return this.resumeMethod ?? "auto";
  }

  getAcpMinAgentVersion() {
    return this.minAgentVersion;
  }

  getAcpMcpTransports() {
    return this.acpMcpTransports;
  }
}

/** 命令不存在的适配器，用于验证启动失败路径不会泄漏未处理的子进程错误。 */
class MissingCommandAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = "dim-threadpilot-no-such-command";
  readonly displayName = "测试缺失命令";
  readonly accessMode = "acp" as const;

  buildArgs(): string[] {
    return ["acp"];
  }

  buildResumeArgs(): string[] {
    return ["acp"];
  }

  buildCompactPlan(): never {
    throw new Error("测试不支持 compact");
  }

  parseEvents(): CliEvent[] {
    return [];
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 ACP 状态变化超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("AcpDaemon 常驻复用：多轮任务共享同一子进程", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter());
  try {
    const first = await daemon.runTurn({ prompt: "任务一", cwd: process.cwd() });
    const pidAfterFirst = daemon.pid;
    assert.ok(pidAfterFirst, "首轮后应持有常驻进程");
    assert.equal(first.sessionId, "acp-session-1");

    const second = await daemon.runTurn({
      prompt: "任务二",
      cwd: process.cwd(),
      sessionId: first.sessionId,
    });
    assert.equal(daemon.pid, pidAfterFirst, "第二轮应复用同一进程而不是重新拉起");
    assert.equal(second.sessionId, "acp-session-1");
    assert.equal(second.answer, "答-acp-session-1");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 把 Bot 级环境注入常驻子进程", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter(), undefined, {
    THREADPILOT_TEST_PROXY: "proxy-marker",
  });
  try {
    const result = await daemon.runTurn({ prompt: "检查环境", cwd: process.cwd() });
    assert.equal(result.answer, "proxy-marker");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 向 session/new 注入 MCP，并汇总应用工具调用", async () => {
  const adapter = new AcpScriptAdapter(() => [
    {
      id: "threadpilot_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ]);
  const daemon = new AcpDaemon(adapter, undefined, { THREADPILOT_TEST_MCP: "1" });
  try {
    const result = await daemon.runTurn({ prompt: "调用澄清", cwd: process.cwd() });
    assert.equal(result.answer, "mcp-1");
    assert.deepEqual(result.toolCalls, [
      {
        toolUseId: "mcp-call",
        toolName: "request_clarification",
        input: { questions: [] },
      },
    ]);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 在 tool_call 之后通过 tool_call_update 接收 rawInput 时能正确更新应用工具参数", async () => {
  const adapter = new AcpScriptAdapter(() => [
    {
      id: "threadpilot_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ]);
  const daemon = new AcpDaemon(adapter, undefined, {
    THREADPILOT_TEST_MCP: "1",
    THREADPILOT_TEST_STREAMED_INPUT: "1",
  });
  try {
    const result = await daemon.runTurn({ prompt: "调用澄清", cwd: process.cwd() });
    assert.equal(result.answer, "mcp-1");
    assert.deepEqual(result.toolCalls, [
      {
        toolUseId: "mcp-call",
        toolName: "request_clarification",
        input: { questions: [{ id: "q1", prompt: "p1" }] },
      },
    ]);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 每轮用当前 env 生成 HTTP MCP 动态请求头", async () => {
  const adapter = new AcpScriptAdapter(() => [
    {
      id: "threadpilot_schedule_manage",
      command: process.execPath,
      args: ["server.js"],
      tools: ["schedule_manage"],
      acp: {
        type: "http",
        url: "http://127.0.0.1:3101/mcp",
        headersFromEnv: [
          { name: "x-threadpilot-chat-id", env: "THREADPILOT_CHAT_ID" },
          { name: "x-threadpilot-owner-open-id", env: "THREADPILOT_OWNER_OPEN_ID" },
        ],
      },
    },
  ]);
  const daemon = new AcpDaemon(adapter, undefined, {
    THREADPILOT_TEST_MCP_HEADERS: "1",
  });
  try {
    const first = await daemon.runTurn({
      prompt: "话题一",
      cwd: process.cwd(),
      env: {
        THREADPILOT_CHAT_ID: "oc_first",
        THREADPILOT_OWNER_OPEN_ID: "ou_first",
      },
    });
    const second = await daemon.runTurn({
      prompt: "话题二",
      cwd: process.cwd(),
      env: {
        THREADPILOT_CHAT_ID: "oc_second",
        THREADPILOT_OWNER_OPEN_ID: "ou_second",
      },
    });

    assert.deepEqual(JSON.parse(first.answer), [
      { name: "x-threadpilot-chat-id", value: "oc_first" },
      { name: "x-threadpilot-owner-open-id", value: "ou_first" },
    ]);
    assert.deepEqual(JSON.parse(second.answer), [
      { name: "x-threadpilot-chat-id", value: "oc_second" },
      { name: "x-threadpilot-owner-open-id", value: "ou_second" },
    ]);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 兼容 DimAgent 把 MCP 工具名放在 tool_call.title", async () => {
  const adapter = new AcpScriptAdapter(() => [
    {
      id: "threadpilot_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ]);
  const daemon = new AcpDaemon(adapter, undefined, {
    THREADPILOT_TEST_MCP: "1",
    THREADPILOT_TEST_MCP_TITLE: "1",
  });
  try {
    const result = await daemon.runTurn({ prompt: "调用澄清", cwd: process.cwd() });
    assert.deepEqual(result.toolCalls, [
      {
        toolUseId: "mcp-call",
        toolName: "request_clarification",
        input: { questions: [] },
      },
    ]);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 按 session/new 目录顺序提升权限、模式并覆盖模型", async () => {
  const adapter = new AcpScriptAdapter(
    () => [],
    {
      configOptions: { permission: "full-access", mode: "agent" },
      model: "test-model-b",
    },
  );
  const daemon = new AcpDaemon(adapter, undefined, {
    THREADPILOT_TEST_SETUP: "1",
  });
  try {
    const result = await daemon.runTurn({ prompt: "检查配置", cwd: "." });
    assert.equal(
      result.answer,
      "permission=full-access|mode=agent|model=test-model-b|cwd=" + process.cwd(),
    );
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 会清理配置失败的半配置 session", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(() => [], { configOptions: { permission: "full-access" } }),
    undefined,
    { THREADPILOT_TEST_CONFIG_FAIL: "1", THREADPILOT_TEST_SETUP: "1" },
  );
  try {
    const events: CliEvent[] = [];
    await assert.rejects(
      () => daemon.runTurn({
        prompt: "配置失败",
        cwd: process.cwd(),
        onEvent: (event) => events.push(event),
      }),
      /配置失败/,
    );
    assert.equal(events.some((event) => event.type === "session"), false);
    const result = await daemon.runTurn({ prompt: "清理后重建", cwd: process.cwd() });
    assert.match(result.answer, /close/);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 按适配器声明使用 session/load，并对占用锁有限重试", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(() => [], undefined, "load"),
    undefined,
    { THREADPILOT_TEST_LOAD_HELD: "1" },
  );
  try {
    const first = await daemon.runTurn({ prompt: "首轮", cwd: process.cwd() });
    const second = await daemon.runTurn({
      prompt: "跨进程恢复",
      cwd: process.cwd(),
      sessionId: first.sessionId,
    });
    assert.equal(second.answer, "答-" + first.sessionId);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 按 ACP transport 能力过滤不支持的 stdio MCP", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(
      () => [
        {
          id: "threadpilot_clarification",
          command: process.execPath,
          args: ["server.js"],
          tools: ["request_clarification"],
        },
      ],
      undefined,
      undefined,
      undefined,
      ["http", "sse"],
    ),
    undefined,
    { THREADPILOT_TEST_MCP: "1" },
  );
  try {
    const result = await daemon.runTurn({ prompt: "调用澄清", cwd: process.cwd() });
    assert.equal(result.answer, "mcp-0");
    assert.deepEqual(result.toolCalls, undefined);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 拒绝低于适配器最低要求的 ACP 版本", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(() => [], undefined, undefined, "0.3.10"),
    undefined,
    { THREADPILOT_TEST_VERSION: "0.3.9" },
  );
  try {
    await assert.rejects(
      () => daemon.runTurn({ prompt: "版本检查", cwd: process.cwd() }),
      /最低版本 0\.3\.10/,
    );
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 并发：同一进程上多个 session 并行执行且通知不串扰", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter());
  try {
    const [a, b] = await Promise.all([
      daemon.runTurn({ prompt: "并发一", cwd: process.cwd() }),
      daemon.runTurn({ prompt: "并发二", cwd: process.cwd() }),
    ]);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.answer, `答-${a.sessionId}`);
    assert.equal(b.answer, `答-${b.sessionId}`);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 并发启动：后续任务等待 initialize 握手完成", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(),
    undefined,
    { THREADPILOT_TEST_INITIALIZE_DELAY_MS: "100" },
  );
  try {
    const [a, b] = await Promise.all([
      daemon.runTurn({ prompt: "握手后一", cwd: process.cwd() }),
      daemon.runTurn({ prompt: "握手后二", cwd: process.cwd() }),
    ]);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.answer, `答-${a.sessionId}`);
    assert.equal(b.answer, `答-${b.sessionId}`);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 空闲回收：无任务超过阈值后自动关闭进程", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter(), 20);
  try {
    await daemon.runTurn({ prompt: "跑一轮", cwd: process.cwd() });
    const pidBeforeIdle = daemon.pid;
    assert.ok(daemon.pid, "刚跑完任务应仍持有进程");
    await waitFor(() => daemon.pid === undefined);
    assert.equal(daemon.pid, undefined, "空闲超时后应回收进程");
    const result = await daemon.runTurn({ prompt: "回收后再跑", cwd: process.cwd() });
    assert.equal(result.answer, "答-acp-session-1");
    assert.ok(daemon.pid);
    assert.notEqual(daemon.pid, pidBeforeIdle, "空闲回收后同一 daemon 应能重新拉起进程");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 空闲回收等待 session/close 时不会复用待关闭连接", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(),
    1,
    { THREADPILOT_TEST_CLOSE_DELAY_MS: "150" },
  );
  try {
    await daemon.runTurn({ prompt: "首轮", cwd: process.cwd() });
    const pidBeforeIdle = daemon.pid;
    assert.ok(pidBeforeIdle);
    // 让空闲回收进入延迟的 session/close，再启动下一轮。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await daemon.runTurn({ prompt: "回收期间重试", cwd: process.cwd() });
    assert.equal(second.answer, "答-acp-session-1");
    assert.ok(daemon.pid);
    assert.notEqual(daemon.pid, pidBeforeIdle, "新任务应等待旧连接释放后重建进程");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 忽略旧 ACP 子进程晚到的 error 事件", async () => {
  type ChildLike = { emit: (event: string, ...args: unknown[]) => boolean };
  const daemon = new AcpDaemon(new AcpScriptAdapter(), 1);
  try {
    await daemon.runTurn({ prompt: "首轮", cwd: process.cwd() });
    const oldChild = (daemon as unknown as { child?: ChildLike }).child;
    assert.ok(oldChild);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await daemon.runTurn({ prompt: "重建", cwd: process.cwd() });
    const newPid = daemon.pid;
    assert.ok(newPid);

    oldChild.emit("error", new Error("late old process error"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.pid, newPid, "旧进程事件不能清理新连接");
    await daemon.runTurn({
      prompt: "验证复用",
      cwd: process.cwd(),
      sessionId: "acp-session-1",
    });
    assert.equal(daemon.pid, newPid);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon prompt 超时会发送 session/cancel，远端 turn 可继续复用", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(),
    undefined,
    { THREADPILOT_TEST_HOLD_PROMPT: "1" },
  );
  try {
    await assert.rejects(
      () => daemon.runTurn({ prompt: "超时轮", cwd: process.cwd(), timeoutMs: 500 }),
      /执行超时/,
    );
    const result = await daemon.runTurn({
      prompt: "取消后继续",
      cwd: process.cwd(),
      sessionId: "acp-session-1",
      timeoutMs: 500,
    });
    assert.equal(result.answer, "cancel-seen");
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon session/new 挂起时也受本轮总超时保护", async () => {
  const daemon = new AcpDaemon(
    new AcpScriptAdapter(),
    undefined,
    { THREADPILOT_TEST_HOLD_SESSION_NEW: "1" },
  );
  try {
    await assert.rejects(
      () => daemon.runTurn({ prompt: "创建会话", cwd: process.cwd(), timeoutMs: 100 }),
      /执行超时/,
    );
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 崩溃重连：进程退出后下一轮自动重建", async () => {
  const daemon = new AcpDaemon(new AcpScriptAdapter());
  try {
    const first = await daemon.runTurn({ prompt: "首轮", cwd: process.cwd() });
    const pidBeforeCrash = daemon.pid;
    assert.ok(pidBeforeCrash);

    // 模拟进程崩溃：强制结束整个进程树，daemon 应感知并标记失效。
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(pidBeforeCrash), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("exit", () => resolve());
    });
    await waitFor(() => daemon.pid === undefined);

    const second = await daemon.runTurn({
      prompt: "崩溃后重试",
      cwd: process.cwd(),
      sessionId: first.sessionId,
    });
    assert.notEqual(daemon.pid, pidBeforeCrash, "崩溃后应重建新进程");
    assert.equal(second.answer, "答-" + first.sessionId);
  } finally {
    await daemon.close();
  }
});

test("AcpDaemon 启动失败：命令缺失时立即报错且不泄漏子进程错误", async () => {
  const daemon = new AcpDaemon(new MissingCommandAdapter());
  try {
    await assert.rejects(
      () => daemon.runTurn({ prompt: "x", cwd: process.cwd() }),
      /(?:no such|ENOENT|找不到|missing|spawn)/i,
    );
  } finally {
    await daemon.close();
  }
});
