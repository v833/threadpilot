/** agent-admin 覆盖层测试：engines.json 解析/原子读写、引擎配置目录生成与模型环境构造。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentAdminStore, codexKeyEnv } from "./agent-admin.js";

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "threadpilot-admin-"));
  await mkdir(join(directory, "config"), { recursive: true });
  return {
    directory,
    filePath: join(directory, "config", "engines.json"),
    engineBaseDir: join(directory, "data", "engines"),
  };
}

test("文件缺失时 load 返回空覆盖", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentAdminStore(filePath, engineBaseDir);
  const result = await store.load();
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.agents, []);
});

test("损坏的 engines.json 返回错误而不抛出", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(filePath, "{ 不是 json", "utf8");
  const store = new AgentAdminStore(filePath, engineBaseDir);
  const result = await store.load();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /解析失败/);
});

test("合法文件解析出覆盖；非法 botId 报错", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      agents: [
        {
          botId: "developer",
          workspace: "/root/work/dev",
          engines: {
            codex: {
              baseUrl: "https://api.example.com/v1",
              apiKey: "sk-1",
              model: "gpt-x",
              wireApi: "responses",
            },
          },
        },
      ],
    }),
    "utf8",
  );
  const store = new AgentAdminStore(filePath, engineBaseDir);
  const result = await store.load();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0].workspace, "/root/work/dev");
    assert.equal(result.agents[0].engines?.codex?.model, "gpt-x");
    assert.equal(result.agents[0].engines?.codex?.wireApi, "responses");
  }
  await writeFile(
    filePath,
    JSON.stringify({ version: 1, agents: [{ botId: "非法 id", engines: {} }] }),
    "utf8",
  );
  const bad = await store.load();
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /botId 不合法/);
});

test("save 原子写入并可从文件读回，不留 .tmp", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentAdminStore(filePath, engineBaseDir);
  await store.save([
    { botId: "qa", engines: { codex: { baseUrl: "https://x", model: "m" } } },
  ]);
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.agents[0].botId, "qa");
  const result = await store.load();
  assert.equal(result.ok, true);
  await assert.rejects(readFile(`${filePath}.tmp`, "utf8"));
});

test("apply 生成 codex config.toml，key 不落明文", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentAdminStore(filePath, engineBaseDir);
  await store.apply([
    {
      botId: "developer",
      engines: {
        codex: {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-secret",
          model: "gpt-x",
          wireApi: "chat",
        },
      },
    },
  ]);
  const toml = await readFile(
    join(engineBaseDir, "developer", "codex", "config.toml"),
    "utf8",
  );
  assert.match(toml, /model = "gpt-x"/);
  assert.match(toml, /model_provider = "tp-developer"/);
  assert.match(toml, /\[model_providers\.tp-developer\]/);
  assert.match(toml, /base_url = "https:\/\/api\.example\.com\/v1"/);
  assert.match(toml, /wire_api = "chat"/);
  assert.match(toml, /env_key = "TP_CODEX_DEVELOPER_API_KEY"/);
  assert.ok(!toml.includes("sk-secret"));
});

test("apply 生成 claude settings.json env 块", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentAdminStore(filePath, engineBaseDir);
  await store.apply([
    {
      botId: "developer",
      engines: {
        claude: {
          baseUrl: "https://ark.cn-beijing.volces.com",
          apiKey: "ak-secret",
          model: "deepseek-v4-flash",
        },
      },
    },
  ]);
  const settings = JSON.parse(
    await readFile(
      join(engineBaseDir, "developer", "claude", "settings.json"),
      "utf8",
    ),
  );
  assert.deepEqual(settings.env, {
    ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com",
    ANTHROPIC_AUTH_TOKEN: "ak-secret",
    ANTHROPIC_MODEL: "deepseek-v4-flash",
  });
});

test("modelEnvironment 按引擎构造隔离环境", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentAdminStore(filePath, engineBaseDir);
  assert.equal(store.modelEnvironment("developer", "codex"), undefined);
  await store.apply([
    {
      botId: "developer",
      engines: {
        codex: { baseUrl: "https://x", apiKey: "sk-1", model: "m" },
        claude: { baseUrl: "https://y", apiKey: "ak-1", model: "m2" },
      },
    },
  ]);
  const codex = store.modelEnvironment("developer", "codex")!;
  assert.equal(codex.CODEX_HOME, join(engineBaseDir, "developer", "codex"));
  assert.equal(codex[codexKeyEnv("developer")], "sk-1");
  const claude = store.modelEnvironment("developer", "claude")!;
  assert.equal(
    claude.CLAUDE_CONFIG_DIR,
    join(engineBaseDir, "developer", "claude"),
  );
  assert.equal(store.modelEnvironment("developer", "agy"), undefined);
});

test("changedEngineBots 只报告 engines 变化的 bot", () => {
  const before = [
    { botId: "a", engines: { codex: { model: "m1" } } },
    { botId: "b", engines: { codex: { model: "x" } } },
    { botId: "c", workspace: "/tmp/c" },
  ];
  const after = [
    { botId: "a", engines: { codex: { model: "m2" } } },
    { botId: "b", engines: { codex: { model: "x" } } },
    { botId: "c", workspace: "/tmp/c2" },
  ];
  assert.deepEqual(AgentAdminStore.changedEngineBots(before, after), ["a"]);
});

test("workspace 覆盖可读取", async (t) => {
  const { directory, filePath, engineBaseDir } = await makeStore();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentAdminStore(filePath, engineBaseDir);
  await store.apply([{ botId: "dev", workspace: "/root/work/dev" }]);
  assert.equal(store.workspaceOverride("dev"), "/root/work/dev");
  assert.equal(store.workspaceOverride("qa"), undefined);
});
