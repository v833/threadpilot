/**
 * 通用 ACP 适配器测试：验证标准 ACP 接入的参数构造、展示名回退、
 * 事件/compact 边界与失效会话识别，证明接入不绑定具体供应商。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AcpAdapter } from "./acp-adapter.js";
import { acpDaemonEnvironment, acpMcpServers } from "./app-tools.js";

test("AcpAdapter 用配置构造启动参数与展示名", () => {
  const applicationTools = [
    {
      id: "threadpilot_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ];
  const adapter = new AcpAdapter({
    id: "dimagent",
    command: "dim",
    args: ["acp"],
    displayName: "DimAgent",
    session: {
      configOptions: { permission: "full-access", mode: "agent" },
      model: "dimcode-api-oauth/deepseek-v4-pro",
    },
  }, () => applicationTools);

  assert.equal(adapter.id, "dimagent");
  assert.equal(adapter.command, "dim");
  assert.equal(adapter.accessMode, "acp");
  assert.deepEqual(adapter.buildArgs("提示词不进启动参数"), ["acp"]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "sess-1"), ["acp"]);
  assert.deepEqual(adapter.getApplicationTools(), applicationTools);
  assert.deepEqual(adapter.getAcpSessionConfig(), {
    configOptions: { permission: "full-access", mode: "agent" },
    model: "dimcode-api-oauth/deepseek-v4-pro",
  });
  assert.deepEqual(adapter.parseEvents('{"type":"result"}'), []);
});

test("ACP MCP 同时支持 stdio 与 DimAgent 所需的 HTTP 描述", () => {
  assert.deepEqual(
    acpMcpServers([
      {
        id: "stdio-server",
        command: "node",
        args: ["server.js"],
        tools: ["stdio_tool"],
      },
      {
        id: "http-server",
        command: "node",
        args: ["server.js"],
        tools: ["http_tool"],
        acp: {
          type: "http",
          url: "http://127.0.0.1:12345/mcp",
          headers: [],
        },
      },
    ]),
    [
      {
        name: "stdio-server",
        command: "node",
        args: ["server.js"],
        env: [],
      },
      {
        type: "http",
        name: "http-server",
        url: "http://127.0.0.1:12345/mcp",
        headers: [],
      },
    ],
  );
});

test("ACP daemon 环境剔除动态 HTTP 头变量并保留进程配置", () => {
  const servers = [
    {
      id: "schedule",
      command: "node",
      args: ["server.js"],
      tools: ["schedule_manage"],
      acp: {
        type: "http" as const,
        url: "http://127.0.0.1:3101/mcp",
        headersFromEnv: [
          { name: "x-chat-id", env: "THREADPILOT_CHAT_ID" },
          { name: "x-owner-id", env: "THREADPILOT_OWNER_OPEN_ID" },
        ],
      },
    },
  ];

  assert.deepEqual(
    acpDaemonEnvironment(servers, {
      HTTP_PROXY: "http://127.0.0.1:7890",
      THREADPILOT_CHAT_ID: "oc_current",
      THREADPILOT_OWNER_OPEN_ID: "ou_current",
    }),
    { HTTP_PROXY: "http://127.0.0.1:7890" },
  );
});

test("AcpAdapter 按配置登记 Grok ACP 启动参数", () => {
  const adapter = new AcpAdapter({
    id: "grok",
    command: "grok",
    args: ["agent", "--always-approve", "--no-leader", "stdio"],
    displayName: "Grok",
    resumeMethod: "load",
    acpMcpTransports: ["stdio", "http", "sse"],
  });

  assert.equal(adapter.id, "grok");
  assert.equal(adapter.accessMode, "acp");
  assert.equal(adapter.displayName, "Grok");
  assert.deepEqual(adapter.buildArgs("提示词不进启动参数"), [
    "agent",
    "--always-approve",
    "--no-leader",
    "stdio",
  ]);
  assert.deepEqual(adapter.getAcpResumeMethod(), "load");
  assert.deepEqual(adapter.getAcpMcpTransports(), ["stdio", "http", "sse"]);
});

test("AcpAdapter 缺省参数与展示名自动回退", () => {
  const adapter = new AcpAdapter({ id: "codex-acp", command: "codex" });

  assert.deepEqual(adapter.buildArgs(""), []);
  assert.equal(adapter.displayName, "codex-acp (ACP)");
});

test("AcpAdapter 明确拒绝原生 compact 并识别失效会话", () => {
  const adapter = new AcpAdapter({ id: "dimagent", command: "dim" });

  assert.throws(() => adapter.buildCompactPlan("sess-1"), /暂不支持/);
  assert.equal(
    adapter.isSessionUnavailable("session does not exist: sess-1"),
    true,
  );
  assert.equal(
    adapter.isSessionUnavailable("ACP server 不支持恢复已有会话"),
    true,
  );
  assert.equal(adapter.isSessionUnavailable("普通错误"), false);
});
