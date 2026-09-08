/**
 * grok 引擎插件：把 Grok CLI 的 headless 适配器登记到 ctx.cli。
 * Grok 的 ACP 接入由 engines/acp 插件提供（标准 ACP 适配器）。
 * 在 cordis.yml 中移除本插件即可整体下线 Grok headless 支持。
 */
import type { Context } from "cordis";
import { GrokAdapter } from "../../cli/grok-adapter.js";

export const name = "engines/grok";
export const inject = ["cli", "applicationTools"];

export function apply(ctx: Context) {
  ctx.cli.register(new GrokAdapter(() => ctx.applicationTools.list()));
}
