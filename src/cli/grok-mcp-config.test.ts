/**
 * Grok MCP 配置准备测试：验证工作区 `.grok/config.toml` 的创建、合并、
 * 幂等更新，以及空工具列表不落盘。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureGrokMcpConfig,
  grokMcpConfigPath,
} from "./grok-mcp-config.js";

const server = {
  id: "threadpilot_clarification",
  command: process.execPath,
  args: ["server.js"],
  tools: ["request_clarification"],
} as const;

test("Grok MCP 配置保留用户段落，并可幂等更新 ThreadPilot Server", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "threadpilot-grok-mcp-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = grokMcpConfigPath(cwd);
  await mkdir(join(cwd, ".grok"), { recursive: true });
  await writeFile(
    configPath,
    [
      "[permission]",
      'defaultMode = "auto"',
      "",
      "[mcp_servers.existing]",
      'command = "existing"',
      "args = []",
      "",
      "[mcp_servers.threadpilot_clarification]",
      'command = "old"',
      'args = ["old.js"]',
      "",
    ].join("\n"),
    "utf8",
  );

  await ensureGrokMcpConfig(cwd, [server]);
  await ensureGrokMcpConfig(cwd, [server]);

  const content = await readFile(configPath, "utf8");
  assert.match(content, /\[permission\]/);
  assert.match(content, /defaultMode = "auto"/);
  assert.match(content, /\[mcp_servers\.existing\]/);
  assert.match(content, /command = "existing"/);
  assert.equal(content.includes('command = "old"'), false);
  assert.ok(
    content.includes(
      `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
    ),
  );
  assert.match(content, /args = \["server\.js"\]/);
  assert.match(content, /enabled = true/);
  assert.equal(
    (content.match(/\[mcp_servers\.threadpilot_clarification\]/g) ?? []).length,
    1,
  );
  assert.equal(content.trimStart().startsWith("["), true);
});

test("Grok MCP 配置更新不会被 args 数组里的方括号截断", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "threadpilot-grok-mcp-args-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await ensureGrokMcpConfig(cwd, [server]);
  await ensureGrokMcpConfig(cwd, [
    {
      ...server,
      args: ["server.js", "--flag"],
    },
  ]);
  const content = await readFile(grokMcpConfigPath(cwd), "utf8");
  assert.equal(content.includes('args = ["server.js"]\nenabled = true'), false);
  assert.match(content, /args = \["server\.js", "--flag"\]/);
  assert.equal(
    (content.match(/\[mcp_servers\.threadpilot_clarification\]/g) ?? []).length,
    1,
  );
});

test("没有应用工具时不创建 Grok 工作区配置", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "threadpilot-grok-mcp-empty-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await ensureGrokMcpConfig(cwd, []);
  await assert.rejects(readFile(grokMcpConfigPath(cwd)), { code: "ENOENT" });
});
