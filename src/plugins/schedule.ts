/**
 * schedule 定时任务服务插件：装配计划/运行记录 Store、Scheduler、内部 HTTP API、
 * schedules.json 热更新 watcher 与 schedule_manage MCP 工具。到点后由本插件
 * 直接唤醒目标 bot 的 CLI 会话静默执行 prompt，不向群里推派发消息；任务需要
 * 推送结果时由任务内容自行完成。
 */
import { Service, type Context } from "cordis";
import type { IncomingHttpHeaders } from "node:http";
import { resolve } from "node:path";
import { cliExecutionTimeoutMs } from "../cli/runner.js";
import { botCliEnvironment } from "../core/bot-registry.js";
import { interactionPolicyOf } from "../core/interaction-policy.js";
import { Scheduler, type ScheduledTaskDispatcher } from "../core/scheduler.js";
import { JsonScheduleRunStore } from "../core/schedule-run-store.js";
import { JsonScheduleStore } from "../core/schedule-store.js";
import { startScheduleApi } from "../core/schedule-api.js";
import { startScheduleFileWatcher } from "../core/schedule-watcher.js";
import {
  executeScheduleManageRequest,
  type ScheduleManageOutcome,
} from "../core/schedule-manage-service.js";
import type { ScheduleManageRequest } from "../core/schedule.js";
import { startLoopbackMcpHttpServer } from "../mcp/loopback-http-server.js";
import { registerScheduleManageTool } from "../mcp/schedule-tools.js";
import { scheduleManageToolServer } from "./schedule-tool.js";

/** 挂到 ctx.schedule 的服务，向命令与测试暴露调度器。 */
export class ScheduleService extends Service {
  constructor(
    ctx: Context,
    readonly scheduler: Scheduler,
    private readonly runStore: JsonScheduleRunStore,
  ) {
    super(ctx, "schedule");
  }

  /** 按话题与创建人隔离地执行管理请求。 */
  manage(
    request: ScheduleManageRequest,
    actor: { chatId: string; creatorOpenId: string },
  ): Promise<ScheduleManageOutcome> {
    return executeScheduleManageRequest(request, {
      scheduler: this.scheduler,
      runStore: this.runStore,
      ...actor,
      isTargetBotAllowed: (targetBotId) =>
        this.ctx.config.bots.some((bot) => bot.id === targetBotId),
    });
  }
}

export const name = "schedule";
export const inject = ["config", "prompts", "cli", "applicationTools"];

export interface Config {
  /** schedules.json 路径；缺省时使用 data/schedules.json。 */
  storePath?: string;
  /** schedule-runs.json 路径；缺省时使用 data/schedule-runs.json。 */
  runStorePath?: string;
}

const DEFAULT_SCHEDULE_RUN_TIMEOUT_MS = 30 * 60_000;

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function apply(ctx: Context, config: Config = {}) {
  const storePath = resolve(process.cwd(), config.storePath ?? "data/schedules.json");
  const runStorePath = resolve(
    process.cwd(),
    config.runStorePath ?? "data/schedule-runs.json",
  );
  const scheduleStore = new JsonScheduleStore(storePath);
  const runStore = new JsonScheduleRunStore(runStorePath);

  // 每个计划一条独立 CLI 会话，跨轮续接；不占用真实飞书话题的会话。
  const cliSessions = new Map<string, string>();

  const dispatcher: ScheduledTaskDispatcher = async (task, scheduledFor) => {
    const botConfig = ctx.config.bots.find((bot) => bot.id === task.targetBotId);
    if (!botConfig) {
      throw new Error(`目标成员未注册或未启用: ${task.targetBotId}`);
    }
    const adapter = ctx.cli.get(
      botConfig.defaultCliId,
      botConfig.accessMode ?? "headless",
    );
    const interaction = interactionPolicyOf({});
    const rawTaskPrompt = `${task.prompt}\n\n（定时任务触发，计划时间：${scheduledFor}）`;
    const prompt = await ctx.prompts.composeTaskPrompt(botConfig, rawTaskPrompt, {
      interaction,
      defaultProductDeliveryMode: ctx.config.defaultProductDeliveryMode,
    });
    const env = {
      ...(botCliEnvironment(botConfig) ?? {}),
      THREADPILOT_CHAT_ID: task.chatId,
      THREADPILOT_OWNER_OPEN_ID: task.creatorOpenId,
    };
    console.log(
      `[定时] 触发 ${task.id} → ${task.targetBotId} engine=${adapter.id}（${scheduledFor}）`,
    );
    try {
      const result = await ctx.cli.run({
        adapter,
        prompt,
        cwd: botConfig.workspaceDir,
        sessionId: cliSessions.get(task.id),
        timeoutMs:
          cliExecutionTimeoutMs(adapter.id) ?? DEFAULT_SCHEDULE_RUN_TIMEOUT_MS,
        env,
        botId: botConfig.id,
      });
      if (result.sessionId) {
        cliSessions.set(task.id, result.sessionId);
      } else {
        cliSessions.delete(task.id);
      }
      return { sessionId: result.sessionId };
    } catch (error) {
      // 失败后丢弃旧会话指针，下轮从干净会话重新开始，避免坏会话被反复续接。
      cliSessions.delete(task.id);
      throw error;
    }
  };

  const scheduler = new Scheduler({ scheduleStore, runStore, dispatcher });
  await scheduler.start();
  console.log(`[定时] 已恢复 ${scheduler.list().length} 条定时任务`);

  const service = new ScheduleService(ctx, scheduler, runStore);
  ctx.on("task/cli-environment", ({ session, collaboration, senderOpenId }) => ({
    THREADPILOT_CHAT_ID: session.chatId,
    THREADPILOT_OWNER_OPEN_ID: collaboration?.ownerOpenId ?? senderOpenId,
  }));

  const closeApi = startScheduleApi({
    scheduler,
    runStore,
    port: Number(process.env.SCHEDULE_API_PORT ?? 3101),
    token: process.env.SCHEDULE_API_TOKEN,
    isTargetBotAllowed: (targetBotId) =>
      ctx.config.bots.some((bot) => bot.id === targetBotId),
  });
  const stopWatcher = startScheduleFileWatcher({
    scheduler,
    filePath: storePath,
  });

  // ACP 引擎可能只支持 HTTP/SSE MCP；独立 loopback 入口随插件一起下线。
  const httpServer = await startLoopbackMcpHttpServer({
    register: (server, request) =>
      registerScheduleManageTool(server, {
        chatId: headerValue(request.headers, "x-threadpilot-chat-id"),
        creatorOpenId: headerValue(
          request.headers,
          "x-threadpilot-owner-open-id",
        ),
      }),
    label: "定时任务",
  });
  const unregister = ctx.applicationTools.register(
    scheduleManageToolServer(httpServer.url),
  );
  ctx.effect(() => () => httpServer.close(), "schedule MCP HTTP");

  return () => {
    stopWatcher();
    closeApi();
    scheduler.stop();
    unregister();
  };
}
