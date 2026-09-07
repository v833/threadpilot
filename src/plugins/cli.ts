/**
 * cli 服务插件：把执行引擎注册表、Runner 调度、原生会话与原生 compact
 * 统一挂到 ctx.cli。引擎插件通过 ctx.cli.register() 登记自己，
 * 实现“新增执行引擎 = 新增一个插件”。
 */
import { Service, type Context } from "cordis";
import { AcpDaemon } from "../cli/acp-daemon.js";
import { acpDaemonEnvironment } from "../cli/app-tools.js";
import { compactCliSession } from "../cli/native-compact.js";
import { listNativeCliSessions } from "../cli/native-sessions.js";
import {
  getCliAdapter,
  listCliAdapters,
  registerCliAdapter,
} from "../cli/registry.js";
import { runCliWithTransientRetry } from "../cli/runner.js";
import type { ListNativeCliSessionsOptions } from "../cli/native-sessions.js";
import type { CompactCliSessionOptions } from "../cli/native-compact.js";
import type { RunCliOptions } from "../cli/runner.js";
import type {
  CliAccessMode,
  CliAdapter,
  CliId,
  CliRunResult,
  CliSessionSummary,
} from "../cli/types.js";

/** 执行引擎注册与调度的统一出口。 */
export class CliService extends Service {
  /** 每个 acp 引擎 + 环境组合的常驻进程；不同代理不能共享同一子进程。 */
  private readonly acpDaemons = new Map<string, AcpDaemon>();
  /** 每个 bot 在 acp 模式下建立的常驻进程 key 集合，供管理页按 bot 精确重启。 */
  private readonly botDaemonKeys = new Map<string, Set<string>>();

  constructor(ctx: Context) {
    super(ctx, "cli");
  }

  /** 引擎插件登记自己的适配器。 */
  register(adapter: CliAdapter): void {
    registerCliAdapter(adapter);
  }

  get(id: CliId, accessMode: CliAccessMode = "headless"): CliAdapter {
    return getCliAdapter(id, accessMode);
  }

  list(): CliAdapter[] {
    return listCliAdapters();
  }

  /** 计算某 acp 引擎 + 环境组合的常驻进程 key（env 排序后序列化）。 */
  private daemonKeyOf(
    adapter: CliAdapter,
    env: Record<string, string> | undefined,
  ): string {
    const daemonEnv = acpDaemonEnvironment(
      adapter.getApplicationTools?.() ?? [],
      env,
    );
    const envKey = JSON.stringify(
      Object.entries(daemonEnv ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    return `${adapter.id}:${envKey}`;
  }

  /** 获取（必要时拉起）某 acp 引擎和环境组合的常驻进程。 */
  private getAcpDaemon(
    adapter: CliAdapter,
    env: Record<string, string> | undefined,
  ): AcpDaemon {
    const key = this.daemonKeyOf(adapter, env);
    let daemon = this.acpDaemons.get(key);
    if (!daemon) {
      const daemonEnv = acpDaemonEnvironment(
        adapter.getApplicationTools?.() ?? [],
        env,
      );
      daemon = new AcpDaemon(adapter, undefined, daemonEnv);
      this.acpDaemons.set(key, daemon);
    }
    return daemon;
  }

  /** 合并该 bot 的引擎模型环境（CODEX_HOME / CLAUDE_CONFIG_DIR 等）到本轮执行环境。 */
  private mergeModelEnvironment(
    options: RunCliOptions,
  ): Record<string, string> | undefined {
    if (!options.botId) return options.env;
    const modelEnv = this.ctx.agentAdmin?.modelEnvironment(
      options.botId,
      options.adapter.id,
    );
    if (!modelEnv) return options.env;
    // 模型环境在前、调用方 env 在后：业务显式注入的变量优先。
    return { ...modelEnv, ...options.env };
  }

  /** 执行一轮 CLI（首次或续聊），带 Codex 瞬时断流的自动重试。 */
  run(options: RunCliOptions): Promise<CliRunResult> {
    const env = this.mergeModelEnvironment(options);
    if (options.adapter.accessMode === "acp") {
      // 注入共享常驻进程，让同引擎的后续任务复用连接而不是反复拉起进程；
      // 同时登记该 bot 的常驻进程 key，供管理页按 bot 精确重启。
      if (options.botId) {
        const keys = this.botDaemonKeys.get(options.botId) ?? new Set<string>();
        keys.add(this.daemonKeyOf(options.adapter, env));
        this.botDaemonKeys.set(options.botId, keys);
      }
      return runCliWithTransientRetry({
        ...options,
        env,
        acpDaemon: this.getAcpDaemon(options.adapter, env),
      });
    }
    return runCliWithTransientRetry({ ...options, env });
  }

  /** 关闭某 bot 在 acp 模式下建立的常驻引擎进程；headless 每次任务新进程，无需处理。 */
  async disposeDaemonsForBot(botId: string): Promise<void> {
    const keys = this.botDaemonKeys.get(botId);
    this.botDaemonKeys.delete(botId);
    if (!keys || keys.size === 0) return;
    await Promise.all(
      [...keys].map((key) => {
        const daemon = this.acpDaemons.get(key);
        if (!daemon) return undefined;
        this.acpDaemons.delete(key);
        return daemon.close();
      }),
    );
    console.log(`[CLI] 已重启 ${botId} 的常驻引擎进程`);
  }

  /** 关闭全部 ACP 常驻进程；由插件卸载回调调用。 */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.acpDaemons.values()].map((daemon) => daemon.close()),
    );
    this.acpDaemons.clear();
    this.botDaemonKeys.clear();
  }

  /** 驱动 Claude/Codex 原生上下文整理协议。 */
  compact(options: CompactCliSessionOptions) {
    return compactCliSession(options);
  }

  /** 列出当前工作目录中的原生 CLI 会话，供 /resume 卡片展示。 */
  listNativeSessions(
    options: ListNativeCliSessionsOptions,
  ): Promise<CliSessionSummary[]> {
    return listNativeCliSessions(options);
  }
}

export const name = "cli";

export function apply(ctx: Context) {
  const service = new CliService(ctx);
  // 卸载插件时回收常驻 ACP 进程，避免 ThreadPilot 退出后遗留 dim acp 子进程；
  // cordis 会等待清理函数完成。
  return () => service.dispose();
}
