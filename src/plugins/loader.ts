/**
 * loader 装配插件：读取 cordis.yml，把其中声明的插件逐个挂载到根 Context。
 * 它是“声明式装配”的入口——启用/停用/替换能力都只改配置文件，不改代码。
 */
import type { Context, Plugin } from "cordis";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

import * as agentAdminPlugin from "./agent-admin.js";
import * as applicationToolsPlugin from "./application-tools.js";
import * as authPlugin from "./auth.js";
import * as bitableBoardPlugin from "./bitable-board.js";
import * as cardsPlugin from "./cards.js";
import * as clarificationPlugin from "./clarification.js";
import * as cliPlugin from "./cli.js";
import * as collaborationPlugin from "./collaboration.js";
import * as dispatchTaskPlugin from "./dispatch-task.js";
import * as egressPlugin from "./egress.js";
import * as ingressPlugin from "./ingress.js";
import * as commandsPlugin from "./commands.js";
import * as configPlugin from "./config.js";
import * as boardCommand from "./commands/board.js";
import * as cdCommand from "./commands/cd.js";
import * as closeCommand from "./commands/close.js";
import * as compactCommand from "./commands/compact.js";
import * as docCommand from "./commands/doc.js";
import * as helpCommand from "./commands/help.js";
import * as loginCommand from "./commands/login.js";
import * as metricsCommand from "./commands/metrics.js";
import * as newCommand from "./commands/new.js";
import * as orchestrateCommand from "./commands/orchestrate.js";
import * as panelCommand from "./commands/panel.js";
import * as resumeCommand from "./commands/resume.js";
import * as scheduleCommand from "./commands/schedule.js";
import * as schedulesCommand from "./commands/schedules.js";
import * as statusCommand from "./commands/status.js";
import * as teamCommand from "./commands/team.js";
import * as claudeEngine from "./engines/claude.js";
import * as codexEngine from "./engines/codex.js";
import * as dimagentEngine from "./engines/dimagent.js";
import * as agyEngine from "./engines/agy.js";
import * as acpEngine from "./engines/acp.js";
import * as larkPlugin from "./lark.js";
import * as observabilityPlugin from "./observability.js";
import * as orchestrationPlugin from "./orchestration.js";
import * as orchestrationActions from "./orchestration/actions.js";
import * as orchestrationLivePanel from "./orchestration/live-panel.js";
import * as productSpecPlugin from "./product-spec.js";
import * as productCommentsPlugin from "./product-comments.js";
import * as promptsPlugin from "./prompts.js";
import * as qaGatePlugin from "./qa-gate.js";
import * as routerPlugin from "./router.js";
import * as schedulePlugin from "./schedule.js";
import * as sessionsPlugin from "./sessions.js";
import * as tasksPlugin from "./tasks.js";
import * as taskRetryPlugin from "./task-retry.js";
import * as teamPlugin from "./team.js";
import * as workspacesPlugin from "./workspaces.js";

/** 插件名 → 插件对象；新增插件时在这里登记名字，供 cordis.yml 引用。 */
const pluginRegistry: Record<string, Plugin> = {
  config: configPlugin,
  "agent-admin": agentAdminPlugin,
  prompts: promptsPlugin,
  sessions: sessionsPlugin,
  cli: cliPlugin,
  "application-tools": applicationToolsPlugin,
  auth: authPlugin,
  "bitable-board": bitableBoardPlugin,
  clarification: clarificationPlugin,
  "engines/claude": claudeEngine,
  "engines/codex": codexEngine,
  "engines/dimagent": dimagentEngine,
  "engines/agy": agyEngine,
  "engines/acp": acpEngine,
  lark: larkPlugin,
  cards: cardsPlugin,
  commands: commandsPlugin,
  "commands/board": boardCommand,
  "commands/help": helpCommand,
  "commands/login": loginCommand,
  "commands/metrics": metricsCommand,
  "commands/new": newCommand,
  "commands/resume": resumeCommand,
  "commands/compact": compactCommand,
  "commands/doc": docCommand,
  "commands/status": statusCommand,
  "commands/team": teamCommand,
  "commands/cd": cdCommand,
  "commands/close": closeCommand,
  "commands/schedule": scheduleCommand,
  "commands/schedules": schedulesCommand,
  "commands/orchestrate": orchestrateCommand,
  "commands/panel": panelCommand,
  collaboration: collaborationPlugin,
  "dispatch-task": dispatchTaskPlugin,
  ingress: ingressPlugin,
  egress: egressPlugin,
  workspaces: workspacesPlugin,
  "qa-gate": qaGatePlugin,
  orchestration: orchestrationPlugin,
  "orchestration/actions": orchestrationActions,
  "orchestration/live-panel": orchestrationLivePanel,
  "product-spec": productSpecPlugin,
  "product-comments": productCommentsPlugin,
  observability: observabilityPlugin,
  tasks: tasksPlugin,
  "task-retry": taskRetryPlugin,
  team: teamPlugin,
  schedule: schedulePlugin,
  router: routerPlugin,
};

const LoaderEntrySchema = z.object({
  name: z.string().min(1),
  // yaml 空块（如 `config:` 下只有注释）会解析为 null，需与缺失一样放行，
  // 由装配处 `entry.config ?? {}` 归一化为空对象。
  config: z.record(z.string(), z.unknown()).nullish(),
  disabled: z.boolean().optional(),
});

const LoaderDocumentSchema = z.object({
  plugins: z.array(LoaderEntrySchema).min(1),
});

export const name = "loader";

export interface Config {
  /** cordis.yml 路径；缺省时读取项目根目录。 */
  path?: string;
}

// FiberState 常量枚举在运行时内联为数字：PENDING=0、LOADING=1、ACTIVE=2、FAILED=3。
const FIBER_STATE_ACTIVE = 2;
const FIBER_STATE_FAILED = 3;

interface FiberLike {
  state: number;
  name?: string;
  await(): Promise<unknown>;
}

/**
 * 等待根上下文上所有插件 fiber 进入终态（ACTIVE 或 FAILED）。
 * cordis 的 ctx.plugin() 对等待 inject 依赖的 PENDING fiber 会立即返回，
 * 因此深层依赖级联不能靠 await mount fiber 保证就绪，必须轮询注册表。
 * `exclude` 用于排除正在执行本函数的插件自身 fiber。
 */
export async function waitForAllActive(
  ctx: Context,
  timeoutMs = 5_000,
  exclude?: FiberLike,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const fibers: FiberLike[] = [];
    ctx.registry.forEach((runtime) => {
      for (const fiber of runtime.fibers) {
        if (fiber !== exclude) fibers.push(fiber as FiberLike);
      }
    });
    const failed = fibers.find((fiber) => fiber.state === FIBER_STATE_FAILED);
    if (failed) {
      // await() 会抛出该 fiber 的失败原因。
      await failed.await();
      throw new Error("插件加载失败");
    }
    if (fibers.length && fibers.every((fiber) => fiber.state === FIBER_STATE_ACTIVE)) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      const pending = fibers
        .filter((fiber) => fiber.state !== FIBER_STATE_ACTIVE)
        .map((fiber) => fiber.name ?? "<匿名>")
        .join(", ");
      throw new Error(`插件挂载超时，以下插件未就绪: ${pending}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function apply(ctx: Context, config: Config = {}) {
  const ymlPath = resolve(process.cwd(), config.path ?? "cordis.yml");
  let content: string;
  try {
    content = await readFile(ymlPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `找不到插件装配文件: ${ymlPath}。请参照 README 创建 cordis.yml。`,
      );
    }
    throw error;
  }

  const document = LoaderDocumentSchema.parse(parseYaml(content));
  const fibers: PromiseLike<unknown>[] = [];
  for (const entry of document.plugins) {
    if (entry.disabled) continue;
    const plugin = pluginRegistry[entry.name];
    if (!plugin) {
      throw new Error(`cordis.yml 引用了未注册的插件: ${entry.name}`);
    }
    fibers.push(ctx.plugin(plugin, entry.config ?? {}));
  }
  // 先等待 mount fiber 捕获立即失败，再等深层依赖级联全部就绪。
  // 排除 loader 自身：它的 fiber 在 apply 执行期间始终是 LOADING。
  await Promise.all(fibers);
  await waitForAllActive(ctx, 5_000, ctx.fiber);
}
