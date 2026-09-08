/**
 * Windows CLI 入口解析：绕过 npm 生成的无扩展名 shell 脚本和 .cmd 包装器，
 * 直接定位 Node 入口或原生 exe，从而继续保持 spawn(shell=false)。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface ResolvedCliCommand {
  command: string;
  argsPrefix: string[];
}

interface WindowsCliDefinition {
  windowsPackageEntry: string[];
  windowsPackageEntryType: "node" | "executable";
}

const WINDOWS_CLI_DEFINITIONS: Record<string, WindowsCliDefinition[]> = {
  codex: [
    {
      windowsPackageEntry: [
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ],
      windowsPackageEntryType: "node",
    },
  ],
  claude: [
    {
      windowsPackageEntry: [
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ],
      windowsPackageEntryType: "executable",
    },
    {
      windowsPackageEntry: [
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "node_modules",
        "@anthropic-ai",
        "claude-code-win32-x64",
        "claude.exe",
      ],
      windowsPackageEntryType: "executable",
    },
    {
      windowsPackageEntry: [
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli-wrapper.cjs",
      ],
      windowsPackageEntryType: "node",
    },
  ],
  dim: [
    {
      windowsPackageEntry: ["node_modules", "dimcode", "bin", "dim.mjs"],
      windowsPackageEntryType: "node",
    },
  ],
};

function pathDirectories(): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Grok 安装器把二进制放在 GROK_HOME/bin 或 ~/.grok/bin，不一定在当前进程 PATH。 */
function grokHomeBinary(): string | undefined {
  const home = process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
  const names = process.platform === "win32" ? ["grok.exe", "grok"] : ["grok"];
  for (const name of names) {
    const candidate = join(home, "bin", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 解析已安装 CLI 的可执行入口，非 Windows 平台直接交给 PATH。 */
export function resolveCliCommand(
  command: string,
): ResolvedCliCommand {
  if (process.platform !== "win32") return { command, argsPrefix: [] };
  // 已是路径（含分隔符）的命令视为已解析入口（如测试注入的 process.execPath），
  // 不再按 PATH 搜索或补 .exe 后缀，避免 node.exe 被追加成 node.exe.exe。
  if (command.includes("/") || command.includes("\\")) {
    return { command, argsPrefix: [] };
  }

  const directories = pathDirectories();
  const definitions = WINDOWS_CLI_DEFINITIONS[command];
  if (definitions) {
    for (const definition of definitions) {
      for (const directory of directories) {
        const packageEntry = join(directory, ...definition.windowsPackageEntry);
        if (!existsSync(packageEntry)) continue;
        if (definition.windowsPackageEntryType === "node") {
          return { command: process.execPath, argsPrefix: [packageEntry] };
        }
        return { command: packageEntry, argsPrefix: [] };
      }
    }
  }

  // 原生可执行文件（如 agy）：PATH 里第一优先可能是 .cmd 包装器（proxy/更新器），
  // 而 node-pty 的 ConPTY CreateProcess 只认 .exe，因此跳过 .cmd 直接定位
  // 真正的 .exe 绝对路径，保证登录注入等 TTY 场景也能按名启动。
  for (const directory of directories) {
    const executable = join(directory, `${command}.exe`);
    if (existsSync(executable)) {
      return { command: executable, argsPrefix: [] };
    }
  }

  // Grok 安装器写入用户目录，当前进程 PATH 可能还没有 ~/.grok/bin。
  if (command === "grok") {
    const homeBinary = grokHomeBinary();
    if (homeBinary) return { command: homeBinary, argsPrefix: [] };
  }

  // 明确使用 .exe，避免 Node 命中 npm 的无扩展名 sh 脚本后返回 EPERM。
  return { command: `${command}.exe`, argsPrefix: [] };
}
