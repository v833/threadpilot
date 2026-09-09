/**
 * Agent 管理覆盖层(engines.json)核心逻辑:zod schema、原子读写、
 * 每 bot 引擎配置目录(CODEX_HOME / CLAUDE_CONFIG_DIR)生成与模型环境构造。
 *
 * 语义:
 * - engines.json 是一层独立覆盖,只描述"每 agent 的引擎模型 + 工作目录覆盖",
 *   不修改 config/bots.json(密钥不落项目配置,热更新只 watch 本文件)。
 * - codex 通过 CODEX_HOME 隔离:每 bot 生成自己的 config.toml,
 *   key 用独立环境变量 TP_CODEX_<BOTID>_API_KEY,绕开 codex shim
 *   source /root/.codex/sub2api.env 对 OPENAI_API_KEY 的污染。
 * - claude 通过 CLAUDE_CONFIG_DIR 隔离:每 bot 生成自己的 settings.json,
 *   env 块配 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL。
 *   不能纯 env 注入——settings.json 的 env 块会替换进程环境,服务器全局
 *   ~/.claude/settings.json 恰好含同名变量,注入会被覆盖。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** 本覆盖层支持的引擎 id(与 CliAdapter.id 对应)。 */
export const ENGINE_IDS = ["codex", "claude"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** 引擎模型覆盖:任一字段可缺省,缺省沿用该引擎的既有默认配置。 */
export const EngineOverrideSchema = z.object({
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  wireApi: z.enum(["responses", "chat"]).optional(),
});

export const AgentOverrideSchema = z.object({
  botId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "botId 不合法"),
  workspace: z.string().trim().min(1).optional(),
  engines: z.record(z.string(), EngineOverrideSchema).optional(),
});

const AgentAdminFileSchema = z.object({
  version: z.literal(1),
  agents: z.array(AgentOverrideSchema).default([]),
});

export interface EngineOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  wireApi?: "responses" | "chat";
}

/** 保存脱敏表单时，未提交新密钥则沿用已有密钥，避免空密码框误清除凭证。 */
export function preserveEngineApiKey(
  existing: EngineOverride | undefined,
  submitted: EngineOverride,
): EngineOverride {
  return submitted.apiKey || !existing?.apiKey
    ? submitted
    : { ...submitted, apiKey: existing.apiKey };
}

export interface AgentOverride {
  botId: string;
  workspace?: string;
  engines?: Record<string, EngineOverride>;
}

export interface AgentAdminFile {
  version: 1;
  agents: AgentOverride[];
}

export interface ProviderModelQuery {
  engineId: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ProviderConnectivityQuery extends ProviderModelQuery {
  model: string;
  wireApi?: "responses" | "chat";
}

export interface ProviderConnectivityResult {
  latencyMs: number;
}

const MODEL_RESPONSE_LIMIT = 2 * 1024 * 1024;

/**
 * 从供应商兼容接口读取模型 ID。管理员可配置任意供应商地址，因此只约束为
 * HTTP(S)，并通过超时与响应大小限制避免管理请求长期占用主进程。
 */
export async function fetchProviderModels(
  query: ProviderModelQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const endpoints = modelEndpointCandidates(query.baseUrl);
  const headers: Record<string, string> = { accept: "application/json" };
  if (query.apiKey) {
    headers.authorization = `Bearer ${query.apiKey}`;
    if (query.engineId === "claude") {
      headers["x-api-key"] = query.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        errors.push(`${endpoint.pathname}: HTTP ${response.status}`);
        continue;
      }
      const declaredSize = Number(response.headers.get("content-length") ?? 0);
      if (declaredSize > MODEL_RESPONSE_LIMIT) {
        errors.push(`${endpoint.pathname}: 响应超过 2MB`);
        continue;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MODEL_RESPONSE_LIMIT) {
        errors.push(`${endpoint.pathname}: 响应超过 2MB`);
        continue;
      }
      const models = extractModelIds(JSON.parse(text));
      if (models.length > 0) return models;
      errors.push(`${endpoint.pathname}: 响应中没有模型`);
    } catch (error) {
      errors.push(`${endpoint.pathname}: ${(error as Error).message}`);
    }
  }
  throw new Error(`获取模型列表失败: ${errors.join("; ")}`);
}

/** 发起一次最小真实推理请求，确认供应商、凭证与指定模型可以共同工作。 */
export async function testProviderConnectivity(
  query: ProviderConnectivityQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderConnectivityResult> {
  const request = connectivityRequest(query);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`模型连接失败: ${(error as Error).message}`);
  }
  const text = await readLimitedResponse(response);
  if (!response.ok) {
    throw new Error(`模型请求失败: HTTP ${response.status}${providerError(text)}`);
  }
  try {
    JSON.parse(text);
  } catch {
    throw new Error("模型请求失败: 供应商返回的不是 JSON");
  }
  return { latencyMs: Date.now() - startedAt };
}

function connectivityRequest(query: ProviderConnectivityQuery): {
  endpoint: URL;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (query.engineId === "claude") {
    if (query.apiKey) {
      headers["x-api-key"] = query.apiKey;
      headers.authorization = `Bearer ${query.apiKey}`;
    }
    headers["anthropic-version"] = "2023-06-01";
    return {
      endpoint: providerEndpoint(query.baseUrl, "messages"),
      headers,
      body: {
        model: query.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply OK" }],
      },
    };
  }
  if (query.apiKey) headers.authorization = `Bearer ${query.apiKey}`;
  if (query.wireApi === "chat") {
    return {
      endpoint: providerEndpoint(query.baseUrl, "chat/completions"),
      headers,
      body: {
        model: query.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply OK" }],
      },
    };
  }
  return {
    endpoint: providerEndpoint(query.baseUrl, "responses"),
    headers,
    body: { model: query.model, max_output_tokens: 1, input: "Reply OK" },
  };
}

async function readLimitedResponse(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MODEL_RESPONSE_LIMIT) throw new Error("供应商响应超过 2MB");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MODEL_RESPONSE_LIMIT) {
    throw new Error("供应商响应超过 2MB");
  }
  return text;
}

function providerError(text: string): string {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.error && typeof payload.error === "object"
      ? payload.error as Record<string, unknown>
      : undefined;
    const message = nested?.message ?? payload.message ?? payload.error;
    return typeof message === "string" && message.trim()
      ? ` - ${message.trim().slice(0, 300)}`
      : "";
  } catch {
    return "";
  }
}

function modelEndpointCandidates(baseUrl: string): URL[] {
  const base = parseProviderBase(baseUrl);
  const path = base.pathname.replace(/\/+$/, "");
  const paths = path.endsWith("/models")
    ? [path]
    : path.endsWith("/v1")
      ? [`${path}/models`]
      : [`${path}/v1/models`, `${path}/models`];
  return paths.map((pathname) => new URL(pathname || "/models", base));
}

function providerEndpoint(baseUrl: string, resource: string): URL {
  const base = parseProviderBase(baseUrl);
  const path = base.pathname.replace(/\/+$/, "");
  const prefix = path.endsWith("/v1") ? path : `${path}/v1`;
  return new URL(`${prefix}/${resource}`, base);
}

function parseProviderBase(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl.trim());
  } catch {
    throw new Error("Base URL 不合法");
  }
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new Error("Base URL 仅支持 HTTP(S)");
  }
  if (base.username || base.password) {
    throw new Error("Base URL 不能包含用户名或密码");
  }
  base.search = "";
  base.hash = "";
  return base;
}

function extractModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : undefined;
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const ids: string[] = [];
  for (const item of source) {
    const value = typeof item === "string"
      ? item
      : item && typeof item === "object"
        ? ["id", "model", "modelId"]
            .map((key) => (item as Record<string, unknown>)[key])
            .find((candidate) => typeof candidate === "string")
        : undefined;
    if (typeof value === "string" && value.trim()) ids.push(value.trim());
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export type LoadResult =
  | { ok: true; agents: AgentOverride[] }
  | { ok: false; error: string };

/** codex 独立 key 的环境变量名:botId 大写、非字母数字转下划线。 */
export function codexKeyEnv(botId: string): string {
  return `TP_CODEX_${botId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
}

/** TOML 基本字符串:转义反斜杠与双引号。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * engines.json 覆盖层的纯逻辑:内存覆盖 + 文件读写 + 引擎配置目录生成。
 * 不依赖 cordis/ctx,便于单元测试;插件负责把它接到热更新与 CLI 注入。
 */
export class AgentAdminStore {
  private agents: AgentOverride[] = [];

  constructor(
    private readonly filePath: string,
    private readonly engineBaseDir: string,
  ) {}

  /** 当前全部覆盖(浅拷贝,防外部篡改内存)。 */
  list(): AgentOverride[] {
    return this.agents.map((agent) => ({ ...agent, engines: agent.engines ? { ...agent.engines } : undefined }));
  }

  get(botId: string): AgentOverride | undefined {
    return this.agents.find((agent) => agent.botId === botId);
  }

  /** 该 bot 某引擎的模型覆盖;无覆盖返回 undefined。 */
  engineOverride(botId: string, engineId: string): EngineOverride | undefined {
    return this.get(botId)?.engines?.[engineId];
  }

  /** 该 bot 的覆盖工作目录(原样,未解析为绝对路径);未覆盖返回 undefined。 */
  workspaceOverride(botId: string): string | undefined {
    return this.get(botId)?.workspace;
  }

  /**
   * 构造该 bot 某引擎的子进程模型环境;无覆盖返回 undefined。
   * 调用方需保证配置目录已生成(apply 或保存后已触发)。
   */
  modelEnvironment(
    botId: string,
    engineId: string,
  ): Record<string, string> | undefined {
    const override = this.engineOverride(botId, engineId);
    if (!override) return undefined;
    if (engineId === "codex") {
      const env: Record<string, string> = { CODEX_HOME: this.engineDir(botId, "codex") };
      if (override.apiKey) env[codexKeyEnv(botId)] = override.apiKey;
      return env;
    }
    if (engineId === "claude") {
      return { CLAUDE_CONFIG_DIR: this.engineDir(botId, "claude") };
    }
    return undefined;
  }

  /** 读取并解析 engines.json;文件缺失视为空覆盖。解析失败返回错误(不抛)。 */
  async load(): Promise<LoadResult> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, agents: [] };
      }
      return { ok: false, error: `engines.json 读取失败: ${(error as Error).message}` };
    }
    try {
      const parsed = AgentAdminFileSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        return {
          ok: false,
          error: `engines.json 格式错误: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        };
      }
      return { ok: true, agents: parsed.data.agents };
    } catch (error) {
      return { ok: false, error: `engines.json 解析失败: ${(error as Error).message}` };
    }
  }

  /** 原子写入 engines.json(临时文件 + rename,避免读到半截文件)。 */
  async save(agents: AgentOverride[]): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const content: AgentAdminFile = { version: 1, agents };
    await writeFile(tmpPath, JSON.stringify(content, null, 2) + "\n", "utf8");
    await rename(tmpPath, this.filePath);
  }

  /** 应用一份覆盖:更新内存并重新生成所有涉及 bot 的引擎配置目录。 */
  async apply(agents: AgentOverride[]): Promise<void> {
    this.agents = agents;
    for (const agent of agents) {
      for (const [engineId, override] of Object.entries(agent.engines ?? {})) {
        await this.writeEngineFiles(agent.botId, engineId, override);
      }
    }
  }

  /** 两份覆盖间引擎模型配置(engines 部分)发生变化的 botId 集合,用于精确重启常驻进程。 */
  static changedEngineBots(before: AgentOverride[], after: AgentOverride[]): string[] {
    const keyOf = (agent?: AgentOverride) => JSON.stringify(agent?.engines ?? {});
    const beforeMap = new Map(before.map((agent) => [agent.botId, keyOf(agent)]));
    const afterMap = new Map(after.map((agent) => [agent.botId, keyOf(agent)]));
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    return [...ids].filter((id) => (beforeMap.get(id) ?? "{}") !== (afterMap.get(id) ?? "{}"));
  }

  private engineDir(botId: string, engineId: string): string {
    return join(this.engineBaseDir, botId, engineId);
  }

  private async writeEngineFiles(
    botId: string,
    engineId: string,
    override: EngineOverride,
  ): Promise<void> {
    if (engineId === "codex") await this.writeCodexConfig(botId, override);
    else if (engineId === "claude") await this.writeClaudeConfig(botId, override);
  }

  /** 生成 /data/engines/<botId>/codex/config.toml。baseUrl 缺失时仅写 model(沿用默认 provider)。 */
  private async writeCodexConfig(botId: string, override: EngineOverride): Promise<void> {
    const dir = this.engineDir(botId, "codex");
    await mkdir(dir, { recursive: true });
    const { model, baseUrl, wireApi } = override;
    const lines: string[] = [];
    if (model) lines.push(`model = ${tomlString(model)}`);
    if (baseUrl) {
      const provider = `tp-${botId}`;
      lines.push(
        `model_provider = ${tomlString(provider)}`,
        "",
        `[model_providers.${provider}]`,
        `name = ${tomlString(`${botId} codex`)}`,
        `base_url = ${tomlString(baseUrl)}`,
        `wire_api = ${tomlString(wireApi ?? "responses")}`,
      );
      // key 不落明文,通过独立环境变量在任务时注入
      if (override.apiKey) lines.push(`env_key = ${tomlString(codexKeyEnv(botId))}`);
    }
    await writeFile(join(dir, "config.toml"), lines.join("\n") + "\n", "utf8");
  }

  /** 生成 /data/engines/<botId>/claude/settings.json,env 块配模型三件套。 */
  private async writeClaudeConfig(botId: string, override: EngineOverride): Promise<void> {
    const dir = this.engineDir(botId, "claude");
    await mkdir(dir, { recursive: true });
    const env: Record<string, string> = {};
    if (override.baseUrl) env.ANTHROPIC_BASE_URL = override.baseUrl;
    if (override.apiKey) env.ANTHROPIC_AUTH_TOKEN = override.apiKey;
    if (override.model) env.ANTHROPIC_MODEL = override.model;
    await writeFile(join(dir, "settings.json"), JSON.stringify({ env }, null, 2) + "\n", "utf8");
  }
}
