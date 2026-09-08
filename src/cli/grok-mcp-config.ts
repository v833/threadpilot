/**
 * Grok headless MCP 配置准备：把插件注册的 stdio Server 合并进工作区
 * `.grok/config.toml` 的 `[mcp_servers.*]`，让 `grok -p` 自动发现
 * ThreadPilot 工具。只改写本插件登记的 server，保留用户其余 TOML 配置。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApplicationToolServer } from "./app-tools.js";

const pendingWrites = new Map<string, Promise<void>>();

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderServer(server: ApplicationToolServer): string {
  const args = server.args.map(tomlString).join(", ");
  return [
    `[mcp_servers.${server.id}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${args}]`,
    "enabled = true",
  ].join("\n");
}

/** 删除指定 server 的表及其子表，避免残留旧 command/args/headers。 */
function removeServerTables(content: string, serverId: string): string {
  const id = escapeRegExp(serverId);
  // 按“下一张表头”切段，不能用 [^[]*：args = ["..."] 里的 [ 会把表截断，
  // 留下裸数组行，整份 TOML 失效，Grok 就连不上 MCP。
  return content.replace(
    new RegExp(
      `(?:^|\\r?\\n)\\[mcp_servers\\.${id}(?:\\.[^\\]]+)?\\][^\\r\\n]*(?:\\r?\\n(?!\\[)[^\\r\\n]*)*`,
      "g",
    ),
    "\n",
  );
}

/** 丢掉表头之前的键值/数组残片，保留注释。 */
function stripOrphanedPrefix(content: string): string {
  const firstTable = content.search(/^\[/m);
  if (firstTable <= 0) return content;
  const kept = content
    .slice(0, firstTable)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed === "" || trimmed.startsWith("#");
    })
    .join("\n");
  return `${kept}${content.slice(firstTable)}`;
}

function upsertGrokMcpToml(
  content: string,
  servers: readonly ApplicationToolServer[],
): string {
  let next = stripOrphanedPrefix(content);
  for (const server of servers) {
    next = removeServerTables(next, server.id);
  }
  next = next.replace(/(\r?\n){3,}/g, "\n\n").trimEnd();
  const blocks = servers.map(renderServer).join("\n\n");
  if (!blocks) return next ? `${next}\n` : "";
  return next ? `${next}\n\n${blocks}\n` : `${blocks}\n`;
}

/** 当前工作区 Grok 项目级配置路径。 */
export function grokMcpConfigPath(cwd: string): string {
  return join(cwd, ".grok", "config.toml");
}

/**
 * 把 ThreadPilot 的 stdio Server 增量写入工作区 `.grok/config.toml`。
 * 无应用工具时不创建文件，避免给空工作区留下空配置。
 */
export async function ensureGrokMcpConfig(
  cwd: string,
  servers: readonly ApplicationToolServer[],
): Promise<void> {
  if (servers.length === 0) return;
  const path = grokMcpConfigPath(cwd);
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = upsertGrokMcpToml(content, servers);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, next, "utf8");
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
  pendingWrites.set(path, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(path) === current) pendingWrites.delete(path);
  }
}
