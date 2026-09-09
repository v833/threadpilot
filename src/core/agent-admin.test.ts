/** agent-admin 覆盖层测试：engines.json 解析/原子读写、引擎配置目录生成与模型环境构造。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentAdminStore,
  codexKeyEnv,
  fetchProviderModels,
  preserveEngineApiKey,
  testProviderConnectivity,
} from "./agent-admin.js";

test("保存引擎时空 API Key 保留旧值，非空新值正常替换", () => {
  const existing = { apiKey: "sk-old", model: "old-model" };

  assert.deepEqual(
    preserveEngineApiKey(existing, { model: "new-model" }),
    { apiKey: "sk-old", model: "new-model" },
  );
  assert.deepEqual(
    preserveEngineApiKey(existing, { apiKey: "sk-new", model: "new-model" }),
    { apiKey: "sk-new", model: "new-model" },
  );
});

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

test("fetchProviderModels 读取 OpenAI 兼容模型并去重排序", async () => {
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      data: [{ id: "gpt-z" }, { id: "gpt-a" }, { id: "gpt-z" }],
    }));
  }) as typeof fetch;

  const models = await fetchProviderModels({
    engineId: "codex",
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-secret",
  }, fetchImpl);

  assert.equal(requestedUrl, "https://api.example.com/v1/models");
  assert.equal(requestedHeaders?.get("authorization"), "Bearer sk-secret");
  assert.deepEqual(models, ["gpt-a", "gpt-z"]);
});

test("fetchProviderModels 为 Claude 设置兼容请求头并回退 models 路径", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    if (requests.length === 1) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify({ models: [{ modelId: "claude-x" }] }));
  }) as typeof fetch;

  const models = await fetchProviderModels({
    engineId: "claude",
    baseUrl: "https://provider.example/api",
    apiKey: "ak-secret",
  }, fetchImpl);

  assert.deepEqual(requests.map((request) => request.url), [
    "https://provider.example/api/v1/models",
    "https://provider.example/api/models",
  ]);
  assert.equal(requests[0].headers.get("x-api-key"), "ak-secret");
  assert.equal(requests[0].headers.get("anthropic-version"), "2023-06-01");
  assert.deepEqual(models, ["claude-x"]);
});

test("fetchProviderModels 拒绝非 HTTP(S) 供应商地址", async () => {
  await assert.rejects(
    fetchProviderModels({ engineId: "codex", baseUrl: "file:///etc/passwd" }),
    /仅支持 HTTP\(S\)/,
  );
});

test("testProviderConnectivity 按 responses 协议发起最小请求", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "resp-1" }));
  }) as typeof fetch;

  const result = await testProviderConnectivity({
    engineId: "codex",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-secret",
    model: "gpt-x",
    wireApi: "responses",
  }, fetchImpl);

  assert.equal(requestedUrl, "https://api.example.com/v1/responses");
  assert.deepEqual(requestedBody, {
    model: "gpt-x",
    max_output_tokens: 1,
    input: "Reply OK",
  });
  assert.ok(result.latencyMs >= 0);
});

test("testProviderConnectivity 支持 chat 与 Claude messages 协议", async () => {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;

  await testProviderConnectivity({
    engineId: "codex",
    baseUrl: "https://openai.example",
    model: "gpt-chat",
    wireApi: "chat",
  }, fetchImpl);
  await testProviderConnectivity({
    engineId: "claude",
    baseUrl: "https://anthropic.example",
    apiKey: "ak-secret",
    model: "claude-x",
  }, fetchImpl);

  assert.equal(requests[0].url, "https://openai.example/v1/chat/completions");
  assert.deepEqual(requests[0].body, {
    model: "gpt-chat",
    max_tokens: 1,
    messages: [{ role: "user", content: "Reply OK" }],
  });
  assert.equal(requests[1].url, "https://anthropic.example/v1/messages");
  assert.equal(requests[1].headers.get("x-api-key"), "ak-secret");
  assert.equal(requests[1].headers.get("anthropic-version"), "2023-06-01");
});

test("testProviderConnectivity 返回供应商模型错误但不泄露响应正文", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    error: { message: "model not found", internal: "private detail" },
  }), { status: 404 })) as typeof fetch;

  await assert.rejects(
    testProviderConnectivity({
      engineId: "codex",
      baseUrl: "https://api.example.com/v1",
      model: "missing",
    }, fetchImpl),
    /^Error: 模型请求失败: HTTP 404 - model not found$/,
  );
});
