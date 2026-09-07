/**
 * Agent 管理 HTTP API 与管理页面托管:GET / 返回管理页面,
 * /api/agents 系列接口读写 config/engines.json 覆盖层,均需 X-Api-Token。
 * 镜像 schedule-api.ts 的 node:http + 127.0.0.1 + token 样板;
 * 具体业务逻辑由插件实现的 handlers 提供,本层只做路由与序列化。
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { ADMIN_UI_HTML } from "./admin-ui.js";

// 默认仅本机回环;公网经 Cloudflare Tunnel(容器经 172.22.0.1 访问)时
// 在服务器 .env 显式设置 ADMIN_API_HOST=0.0.0.0 以放开监听地址。
const HOST = process.env.ADMIN_API_HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

/** 单 agent 管理视图(apiKey 一律脱敏为 hasApiKey,明文不出接口)。 */
export interface AdminAgentView {
  botId: string;
  name?: string;
  role?: string;
  defaultCli?: string;
  accessMode?: string;
  /** 生效工作目录(覆盖后);未覆盖即 bots.json 的 workspaceDir。 */
  workspace: string;
  /** engines.json 里的工作目录覆盖;未覆盖不返回。 */
  workspaceOverride?: string;
  engines: Record<string, AdminEngineView>;
  /** 已注册引擎 id 列表(UI 据此渲染引擎编辑块)。 */
  engineIds: string[];
}

export interface AdminEngineView {
  baseUrl?: string;
  model?: string;
  wireApi?: "responses" | "chat";
  hasApiKey: boolean;
}

export type AgentAdminResult =
  | { ok: true; view: AdminAgentView; restarted: string[] }
  | { ok: false; status: number; error: string };

/** POST /api/agents/:botId/restart 的返回:显式重启不带 restarted 列表,只带提示。 */
export type AgentAdminRestartResult =
  | { ok: true; view: AdminAgentView; note: string }
  | { ok: false; status: number; error: string };

export interface AgentAdminApiHandlers {
  listAgents(): Promise<AdminAgentView[]>;
  getAgent(botId: string): Promise<AdminAgentView | undefined>;
  /** PUT /api/agents/:botId,body 为 { engines?, workspace? }。 */
  updateAgent(
    botId: string,
    body: { engines?: Record<string, unknown>; workspace?: unknown },
  ): Promise<AgentAdminResult>;
  removeEngine(botId: string, engineId: string): Promise<AgentAdminResult>;
  removeWorkspace(botId: string): Promise<AgentAdminResult>;
  /** POST /api/agents/:botId/restart,显式重启常驻引擎。 */
  restartAgent(botId: string): Promise<AgentAdminRestartResult>;
}

export interface AgentAdminApiOptions {
  port: number;
  /** 不配置 token 时拒绝启动(由插件在 apply 阶段保证),本层照实鉴权。 */
  token?: string;
  handlers: AgentAdminApiHandlers;
}

export function startAgentAdminApi(options: AgentAdminApiOptions): () => void {
  const { port, token, handlers } = options;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const segments = url.pathname.split("/").filter(Boolean);
      // 页面本体(静态 UI,不含敏感数据)允许无 token 加载;用户输入令牌后由页面
      // JS 带 X-Api-Token 调 API。其余请求一律鉴权。
      const isPageRequest = method === "GET" && segments.length === 0;
      if (!isPageRequest && !isAuthorized(req, token)) {
        return sendJson(res, 401, { error: "未授权" });
      }

      if (method === "GET" && segments.length === 0) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(ADMIN_UI_HTML);
      }
      if (method === "GET" && matches(segments, ["api", "health"])) {
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && matches(segments, ["api", "agents"])) {
        return sendJson(res, 200, { agents: await handlers.listAgents() });
      }
      if (
        method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[2]
      ) {
        const view = await handlers.getAgent(segments[2]);
        return sendJson(res, view ? 200 : 404, view ? { agent: view } : { error: "agent 不存在" });
      }
      if (
        method === "PUT" &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[2]
      ) {
        const body = (await readJson(req)) as {
          engines?: Record<string, unknown>;
          workspace?: unknown;
        };
        const result = await handlers.updateAgent(segments[2], body ?? {});
        return sendJson(res, result.ok ? 200 : result.status, result);
      }
      if (
        method === "DELETE" &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[2] &&
        segments[3] === "engines" &&
        segments[4]
      ) {
        const result = await handlers.removeEngine(segments[2], segments[4]);
        return sendJson(res, result.ok ? 200 : result.status, result);
      }
      if (
        method === "DELETE" &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[2] &&
        segments[3] === "workspace"
      ) {
        const result = await handlers.removeWorkspace(segments[2]);
        return sendJson(res, result.ok ? 200 : result.status, result);
      }
      if (
        method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[2] &&
        segments[3] === "restart"
      ) {
        const result = await handlers.restartAgent(segments[2]);
        return sendJson(res, result.ok ? 200 : result.status, result);
      }
      return sendJson(res, 404, { error: "接口不存在" });
    } catch (error) {
      return sendJson(res, 500, { error: (error as Error).message });
    }
  });
  server.listen(port, HOST, () => {
    console.log(`[管理] 管理接口已启动 http://${HOST}:${port}`);
  });
  // 随插件卸载关闭的常驻服务。
  return () => {
    server.close();
  };
}

function matches(segments: string[], pattern: string[]): boolean {
  return (
    segments.length === pattern.length &&
    pattern.every((part, index) => segments[index] === part)
  );
}

function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return req.headers["x-api-token"] === token;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
