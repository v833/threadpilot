/**
 * agent-admin 插件：ThreadPilot 自定义管理页面与每 agent 引擎覆盖层。
 * - 提供 ctx.agentAdmin 服务（AgentAdminService）：modelEnvironment() 供 cli 插件在
 *   run() 时注入每 bot 的引擎模型环境（CODEX_HOME / CLAUDE_CONFIG_DIR），
 *   restartAgent() 按 bot 精确重启 ACP 常驻引擎进程；
 * - 托管 config/engines.json 覆盖层：启动加载、watchFile 热更新兜底、API 保存即 reload；
 * - 工作目录覆盖：原位更新 ctx.config.bots[i].workspaceDir（新会话生效），删除覆盖即恢复默认；
 * - 启动 127.0.0.1 管理 API（ADMIN_API_PORT 缺省 3103）；未配置 ADMIN_API_TOKEN 时
 *   管理接口拒绝启动（其余能力不受影响）。
 */
import { Service, type Context } from "cordis";
import { watchFile, unwatchFile } from "node:fs";
import { join, resolve } from "node:path";
import {
  AgentAdminStore,
  EngineOverrideSchema,
  fetchProviderModels,
  testProviderConnectivity,
  type AgentOverride,
  type EngineOverride,
} from "../core/agent-admin.js";
import {
  startAgentAdminApi,
  type AdminAgentView,
  type AdminEngineView,
  type AgentAdminApiHandlers,
  type AgentAdminRestartResult,
  type AgentAdminResult,
  type AgentAdminModelsResult,
  type AgentAdminConnectivityResult,
} from "../core/agent-admin-api.js";
import { resolveWorkspacePath } from "../core/workspace.js";
import type { BotConfig } from "../core/bot-registry.js";

/** 对外暴露的 agent-admin 服务：模型环境构造与 per-bot 重启。 */
export class AgentAdminService extends Service {
  constructor(
    ctx: Context,
    private readonly store: AgentAdminStore,
  ) {
    super(ctx, "agentAdmin");
  }

  /** 某 bot 某引擎的子进程模型环境；无覆盖返回 undefined。 */
  modelEnvironment(
    botId: string,
    engineId: string,
  ): Record<string, string> | undefined {
    return this.store.modelEnvironment(botId, engineId);
  }

  /** 显式重启某 bot 的常驻引擎进程（ACP）；headless 模式每次任务新进程，无需操作。 */
  async restartAgent(botId: string): Promise<void> {
    await this.ctx.cli.disposeDaemonsForBot(botId);
  }
}

export const name = "agent-admin";
export const inject = ["config", "cli"];

export interface Config {
  /** 覆盖层文件路径；缺省 <baseDir>/config/engines.json。 */
  enginesPath?: string;
  /** 引擎配置目录基准；缺省 <baseDir>/data/engines。 */
  engineDir?: string;
  baseDirectory?: string;
}

export function apply(ctx: Context, config: Config = {}) {
  const baseDir = config.baseDirectory ?? process.cwd();
  const enginesPath = resolve(
    baseDir,
    config.enginesPath ?? process.env.ENGINES_CONFIG ?? "config/engines.json",
  );
  const engineBaseDir = resolve(
    baseDir,
    config.engineDir ?? join("data", "engines"),
  );
  const store = new AgentAdminStore(enginesPath, engineBaseDir);

  // 启动时的原始工作目录快照，供覆盖删除后恢复默认值。
  const originalWorkspaces = new Map(
    ctx.config.bots.map((bot) => [bot.id, bot.workspaceDir]),
  );
  const engineIds = () => ctx.cli.list().map((adapter) => adapter.id);

  // 注册服务；cli 插件在 run() 时经此注入每 bot 的模型环境。
  new AgentAdminService(ctx, store);

  let debounceTimer: NodeJS.Timeout | undefined;
  const reload = async (): Promise<string[]> => {
    const before = store.list();
    const result = await store.load();
    if (!result.ok) {
      // 配置损坏时不 crash 主流程，保留上次覆盖继续服务。
      console.error(`[管理] ${result.error};保留上次覆盖`);
      return [];
    }
    const changedBots = AgentAdminStore.changedEngineBots(before, result.agents);
    await store.apply(result.agents);
    applyWorkspaceOverrides(ctx, result.agents, baseDir, originalWorkspaces);
    for (const botId of changedBots) {
      await ctx.cli
        .disposeDaemonsForBot(botId)
        .catch((error: unknown) =>
          console.error(
            `[管理] 重启 ${botId} 常驻引擎失败: ${(error as Error).message}`,
          ),
        );
    }
    if (changedBots.length > 0) {
      console.log(`[管理] 已热更新引擎覆盖，重启: ${changedBots.join(", ")}`);
    }
    return changedBots;
  };

  // 手工编辑 engines.json 的热更新兜底；API 保存路径直接调 reload，不依赖 watcher。
  const onFileChange = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void reload(), 300);
  };
  watchFile(enginesPath, { interval: 500 }, onFileChange);

  // 管理 API：token 必配，否则管理接口拒绝启动。
  const port = Number(process.env.ADMIN_API_PORT ?? 3103);
  const token = process.env.ADMIN_API_TOKEN;
  let closeApi: (() => void) | undefined;
  if (!token) {
    console.error(
      `[管理] 未配置 ADMIN_API_TOKEN，管理接口拒绝启动(http://127.0.0.1:${port})`,
    );
  } else {
    closeApi = startAgentAdminApi({
      port,
      token,
      handlers: buildHandlers(ctx, store, engineIds, reload),
    });
  }

  // 启动时先应用一次现有覆盖（幂等；首次运行无 daemon 可重启）。
  void reload().catch((error: unknown) =>
    console.error(`[管理] 初始加载失败: ${(error as Error).message}`),
  );

  return () => {
    unwatchFile(enginesPath, onFileChange);
    if (debounceTimer) clearTimeout(debounceTimer);
    closeApi?.();
  };
}

/** 把 engines.json 的 workspace 覆盖原位应用到内存 bot 配置；未覆盖的恢复默认值。 */
function applyWorkspaceOverrides(
  ctx: Context,
  agents: AgentOverride[],
  baseDir: string,
  originalWorkspaces: Map<string, string>,
): void {
  const overrideByBot = new Map<string, string>();
  for (const agent of agents) {
    if (agent.workspace) overrideByBot.set(agent.botId, agent.workspace);
  }
  for (const bot of ctx.config.bots) {
    const override = overrideByBot.get(bot.id);
    const fallback = originalWorkspaces.get(bot.id) ?? bot.workspaceDir;
    const resolved = override
      ? resolveWorkspacePath(override, baseDir)
      : fallback;
    bot.workspaceDir = resolved;
    ctx.config.defaultWorkspaces[bot.id] = resolved;
  }
}

/** 单个 bot 的管理视图（apiKey 脱敏为 hasApiKey，明文不出接口）。 */
function viewOf(
  bot: BotConfig,
  store: AgentAdminStore,
  allEngineIds: string[],
): AdminAgentView {
  const override = store.get(bot.id);
  const engines: Record<string, AdminEngineView> = {};
  for (const engineId of allEngineIds) {
    const engine = store.engineOverride(bot.id, engineId);
    if (!engine) continue;
    engines[engineId] = {
      ...(engine.baseUrl ? { baseUrl: engine.baseUrl } : {}),
      ...(engine.model ? { model: engine.model } : {}),
      ...(engine.wireApi ? { wireApi: engine.wireApi } : {}),
      hasApiKey: Boolean(engine.apiKey),
    };
  }
  return {
    botId: bot.id,
    name: bot.role,
    role: bot.role,
    defaultCli: bot.defaultCliId,
    accessMode: bot.accessMode,
    workspace: bot.workspaceDir,
    ...(override?.workspace ? { workspaceOverride: override.workspace } : {}),
    engines,
    engineIds: allEngineIds,
  };
}

/** 把请求里的引擎字段清洗为覆盖：空字符串字段剔除，全空返回 undefined。 */
function normalizeEngine(raw: unknown): EngineOverride | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) clean[key] = trimmed;
    } else if (value !== undefined && value !== null) {
      clean[key] = value;
    }
  }
  const parsed = EngineOverrideSchema.safeParse(clean);
  if (!parsed.success) {
    throw new Error(
      `引擎参数不合法: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return Object.keys(clean).length > 0 ? parsed.data : undefined;
}

function buildHandlers(
  ctx: Context,
  store: AgentAdminStore,
  engineIds: () => string[],
  reload: () => Promise<string[]>,
): AgentAdminApiHandlers {
  const findBot = (botId: string): BotConfig | undefined =>
    ctx.config.bots.find((bot) => bot.id === botId);

  return {
    async listAgents() {
      const ids = engineIds();
      return ctx.config.bots.map((bot) => viewOf(bot, store, ids));
    },

    async getAgent(botId) {
      const bot = findBot(botId);
      return bot ? viewOf(bot, store, engineIds()) : undefined;
    },

    async listModels(botId, engineId, body): Promise<AgentAdminModelsResult> {
      if (!findBot(botId)) {
        return { ok: false, status: 404, error: `agent 不存在: ${botId}` };
      }
      if (!new Set(engineIds()).has(engineId)) {
        return { ok: false, status: 400, error: `未注册的引擎: ${engineId}` };
      }
      const saved = store.engineOverride(botId, engineId);
      const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : saved?.baseUrl;
      const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
        ? body.apiKey.trim()
        : saved?.apiKey;
      if (!baseUrl) {
        return { ok: false, status: 400, error: "请先填写 Base URL" };
      }
      try {
        return {
          ok: true,
          models: await fetchProviderModels({ engineId, baseUrl, apiKey }),
        };
      } catch (error) {
        return { ok: false, status: 502, error: (error as Error).message };
      }
    },

    async testConnectivity(
      botId,
      engineId,
      body,
    ): Promise<AgentAdminConnectivityResult> {
      if (!findBot(botId)) {
        return { ok: false, status: 404, error: `agent 不存在: ${botId}` };
      }
      if (!new Set(engineIds()).has(engineId)) {
        return { ok: false, status: 400, error: `未注册的引擎: ${engineId}` };
      }
      const saved = store.engineOverride(botId, engineId);
      const value = (input: unknown, fallback?: string): string | undefined =>
        typeof input === "string" && input.trim() ? input.trim() : fallback;
      const baseUrl = value(body.baseUrl, saved?.baseUrl);
      const apiKey = value(body.apiKey, saved?.apiKey);
      const model = value(body.model, saved?.model);
      const wireApi = value(body.wireApi, saved?.wireApi);
      if (!baseUrl) {
        return { ok: false, status: 400, error: "请先填写 Base URL" };
      }
      if (!model) {
        return { ok: false, status: 400, error: "请先选择或填写 Model" };
      }
      if (wireApi !== undefined && wireApi !== "responses" && wireApi !== "chat") {
        return { ok: false, status: 400, error: "Wire API 不合法" };
      }
      try {
        const result = await testProviderConnectivity({
          engineId,
          baseUrl,
          apiKey,
          model,
          wireApi,
        });
        return { ok: true, latencyMs: result.latencyMs };
      } catch (error) {
        return { ok: false, status: 502, error: (error as Error).message };
      }
    },

    async updateAgent(botId, body): Promise<AgentAdminResult> {
      const bot = findBot(botId);
      if (!bot) {
        return { ok: false, status: 404, error: `agent 不存在: ${botId}` };
      }
      const ids = new Set(engineIds());
      const engines: Record<string, EngineOverride> = {};
      if (body.engines !== undefined) {
        if (!body.engines || typeof body.engines !== "object") {
          return { ok: false, status: 400, error: "engines 必须是对象" };
        }
        for (const [engineId, raw] of Object.entries(body.engines)) {
          if (!ids.has(engineId)) {
            return { ok: false, status: 400, error: `未注册的引擎: ${engineId}` };
          }
          let normalized: EngineOverride | undefined;
          try {
            normalized = normalizeEngine(raw);
          } catch (error) {
            return { ok: false, status: 400, error: (error as Error).message };
          }
          if (normalized) engines[engineId] = normalized;
        }
      }

      const agents = store.list();
      let entry = agents.find((agent) => agent.botId === botId);
      if (!entry) {
        entry = { botId };
        agents.push(entry);
      }
      if (body.engines !== undefined) {
        const merged = { ...entry.engines, ...engines };
        if (Object.keys(merged).length > 0) entry.engines = merged;
        else delete entry.engines;
      }
      if (body.workspace !== undefined) {
        const workspace =
          typeof body.workspace === "string" ? body.workspace.trim() : "";
        if (workspace) entry.workspace = workspace;
        else delete entry.workspace;
      }
      const cleaned = agents.filter((agent) => agent.engines || agent.workspace);
      try {
        await store.save(cleaned);
      } catch (error) {
        return {
          ok: false,
          status: 500,
          error: `保存失败: ${(error as Error).message}`,
        };
      }
      const restarted = await reload();
      return { ok: true, view: viewOf(bot, store, engineIds()), restarted };
    },

    async removeEngine(botId, engineId): Promise<AgentAdminResult> {
      const bot = findBot(botId);
      if (!bot) {
        return { ok: false, status: 404, error: `agent 不存在: ${botId}` };
      }
      const agents = store.list();
      const entry = agents.find((agent) => agent.botId === botId);
      if (entry?.engines?.[engineId]) {
        delete entry.engines[engineId];
        if (Object.keys(entry.engines).length === 0) delete entry.engines;
        const cleaned = agents.filter((agent) => agent.engines || agent.workspace);
        await store.save(cleaned);
      }
      const restarted = await reload();
      return { ok: true, view: viewOf(bot, store, engineIds()), restarted };
    },

    async removeWorkspace(botId): Promise<AgentAdminResult> {
      const bot = findBot(botId);
      if (!bot) {
        return { ok: false, status: 404, error: `agent 不存在: ${botId}` };
      }
      const agents = store.list();
      const entry = agents.find((agent) => agent.botId === botId);
      if (entry?.workspace) {
        delete entry.workspace;
        if (!entry.engines || Object.keys(entry.engines).length === 0) {
          const index = agents.findIndex((agent) => agent.botId === botId);
          if (index >= 0) agents.splice(index, 1);
        }
        await store.save(agents);
      }
      const restarted = await reload();
      return { ok: true, view: viewOf(bot, store, engineIds()), restarted };
    },

    async restartAgent(botId): Promise<AgentAdminRestartResult> {
      const bot = findBot(botId);
      if (!bot) {
        return { ok: false, status: 404, error: `agent 不存在: ${botId}` };
      }
      await ctx.cli
        .disposeDaemonsForBot(botId)
        .catch((error: unknown) =>
          console.error(`[管理] 重启失败: ${(error as Error).message}`),
        );
      return {
        ok: true,
        view: viewOf(bot, store, engineIds()),
        note: "已重启常驻引擎(ACP);headless 模式每次任务新进程,无需重启",
      };
    },
  };
}
