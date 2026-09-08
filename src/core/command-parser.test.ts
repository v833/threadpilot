/** 会话命令测试：覆盖带提及的合法命令和普通文本误识别边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCliRequest, parseCommand } from "./command-parser.js";

test("识别会话控制命令和可选机器人提及", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status" });
  assert.deepEqual(parseCommand("@MyBot /close"), { name: "close" });
  assert.deepEqual(parseCommand("@ThreadPilot /help  "), { name: "help" });
  assert.deepEqual(parseCommand("/new"), { name: "new" });
  assert.deepEqual(parseCommand("@ThreadPilot /resume"), { name: "resume" });
  assert.deepEqual(parseCommand("/team"), { name: "team" });
  assert.deepEqual(parseCommand("@CEO 助理 /team"), { name: "team" });
  assert.deepEqual(parseCommand("/compact"), {
    name: "compact",
    instructions: undefined,
  });
  assert.deepEqual(parseCommand("/compact 保留接口约定，省略测试日志"), {
    name: "compact",
    instructions: "保留接口约定，省略测试日志",
  });
  assert.deepEqual(parseCommand("/doc 整理本周发布说明"), {
    name: "doc",
    prompt: "整理本周发布说明",
  });
  assert.deepEqual(parseCommand("@ThreadPilot /doc  汇总历史消息"), {
    name: "doc",
    prompt: "汇总历史消息",
  });
  assert.deepEqual(parseCommand("/metrics"), {
    name: "metrics",
    args: undefined,
  });
  assert.deepEqual(parseCommand("@ThreadPilot /metrics traces"), {
    name: "metrics",
    args: "traces",
  });
  assert.deepEqual(parseCommand("/metrics bot developer"), {
    name: "metrics",
    args: "bot developer",
  });
  assert.deepEqual(parseCommand("/board"), {
    name: "board",
    args: undefined,
  });
  assert.deepEqual(parseCommand("@ThreadPilot /board init 敏捷开发大盘"), {
    name: "board",
    args: "init 敏捷开发大盘",
  });
  assert.deepEqual(parseCommand("/board link"), {
    name: "board",
    args: "link",
  });
  assert.deepEqual(parseCommand("/board status"), {
    name: "board",
    args: "status",
  });
});

test("解析 /cd 的查询、带空格路径和机器人提及", () => {
  assert.deepEqual(parseCommand("/cd"), { name: "cd", path: undefined });
  assert.deepEqual(parseCommand("@ThreadPilot /cd ../another project  "), {
    name: "cd",
    path: "../another project",
  });
  assert.deepEqual(parseCommand("/cd C:\\work\\project"), {
    name: "cd",
    path: "C:\\work\\project",
  });
});

test("解析 /schedule 自然语言与 /schedules 列表命令", () => {
  assert.deepEqual(parseCommand("/schedule 每小时检查一次服务日志"), {
    name: "schedule",
    request: "每小时检查一次服务日志",
  });
  assert.deepEqual(parseCommand("@ThreadPilot /schedule 每天 9 点检查日志"), {
    name: "schedule",
    request: "每天 9 点检查日志",
  });
  assert.deepEqual(parseCommand("/schedule"), {
    name: "schedule",
    request: undefined,
  });
  assert.deepEqual(parseCommand("/schedules"), { name: "schedules" });
  assert.deepEqual(parseCommand("@ThreadPilot /schedules"), {
    name: "schedules",
  });
});

test("/schedule 的管理动作保留为自然语言，交给命令插件拆分", () => {
  assert.deepEqual(parseCommand("/schedule pause abc123"), {
    name: "schedule",
    request: "pause abc123",
  });
  assert.deepEqual(parseCommand("/schedule delete abc123"), {
    name: "schedule",
    request: "delete abc123",
  });
  assert.equal(parseCommand("帮我 /schedule 检查日志"), undefined);
});

test("解析 /orchestrate 与 /panel 编排命令", () => {
  assert.deepEqual(parseCommand("/panel"), { name: "panel" });
  assert.deepEqual(parseCommand("@CEO 助理 /panel"), { name: "panel" });
  assert.deepEqual(parseCommand("/orchestrate"), {
    name: "orchestrate",
    prompt: undefined,
  });
  assert.deepEqual(
    parseCommand("/orchestrate 检查 TASK.md 的 A、B、C 三个模块"),
    {
      name: "orchestrate",
      prompt: "检查 TASK.md 的 A、B、C 三个模块",
    },
  );
  assert.deepEqual(parseCommand("@CEO 助理 /orchestrate 并行 review MR"), {
    name: "orchestrate",
    prompt: "并行 review MR",
  });
  // 编排命令必须出现在消息开头，普通文本里的斜杠不误识别。
  assert.equal(parseCommand("帮我 /panel 看看"), undefined);
  assert.equal(parseCommand("帮我 /orchestrate 一下"), undefined);
});

test("普通文本和不支持的命令不会被误识别", () => {
  assert.equal(parseCommand("帮我运行 /status 看看"), undefined);
  assert.equal(parseCommand("/unknown"), undefined);
  assert.equal(parseCommand("status"), undefined);
  assert.equal(parseCommand("帮我执行 /cd 检查项目"), undefined);
});

test("解析新话题显式指定的 CLI 与真实任务正文", () => {
  assert.deepEqual(parseCliRequest("/codex 检查项目"), {
    cliId: "codex",
    prompt: "检查项目",
  });
  assert.deepEqual(parseCliRequest("@MyBot /claude 修复类型错误"), {
    cliId: "claude",
    prompt: "修复类型错误",
  });
  assert.deepEqual(parseCliRequest("@MyBot /codex\n检查 package.json"), {
    cliId: "codex",
    prompt: "检查 package.json",
  });
  assert.deepEqual(
    parseCliRequest("@ThreadPilot /claude 检查项目", "ThreadPilot"),
    {
      cliId: "claude",
      prompt: "检查项目",
    },
  );
  assert.deepEqual(parseCliRequest("/dimagent 检查项目"), {
    cliId: "dimagent",
    prompt: "检查项目",
  });
  assert.deepEqual(parseCliRequest("/agy 检查项目"), {
    cliId: "agy",
    prompt: "检查项目",
  });
  assert.deepEqual(parseCliRequest("/grok 检查项目"), {
    cliId: "grok",
    prompt: "检查项目",
  });
});

test("引擎请求按注册表注入的 CLI ID 动态解析，未注册引擎不误识别", () => {
  const known = ["codex", "claude", "dimagent", "agy"];

  assert.deepEqual(parseCliRequest("/agy 检查项目", undefined, known), {
    cliId: "agy",
    prompt: "检查项目",
  });
  assert.deepEqual(
    parseCliRequest("@MyBot /agy 检查项目", undefined, known),
    {
      cliId: "agy",
      prompt: "检查项目",
    },
  );
  // 不在注册表里的引擎前缀不会被当成引擎请求，避免把任务文本误路由。
  assert.equal(parseCliRequest("/unknown 任务", undefined, known), undefined);
  assert.equal(
    parseCliRequest("/other 任务", undefined, ["codex"]),
    undefined,
  );
  // 空注册表时直接不识别，保证不会匹配空分支。
  assert.equal(parseCliRequest("/codex 任务", undefined, []), undefined);
});

test("空 CLI 指令保留引擎选择，普通文本不误识别", () => {
  assert.deepEqual(parseCliRequest("/codex"), {
    cliId: "codex",
    prompt: "",
  });
  assert.deepEqual(parseCliRequest("@MyBot /claude  "), {
    cliId: "claude",
    prompt: "",
  });
  assert.equal(parseCliRequest("帮我解释 /codex 的作用"), undefined);
  assert.equal(
    parseCliRequest("@ThreadPilot 帮我解释 /codex 的作用", "ThreadPilot"),
    undefined,
  );
  assert.equal(parseCliRequest("/status"), undefined);
});

test("解析 /login 与 /<engine> login 登录指令", () => {
  assert.deepEqual(parseCommand("/login"), { name: "login" });
  assert.deepEqual(parseCommand("@ThreadPilot /login  "), { name: "login" });

  // "/<engine> login" 按注册表引擎名识别为登录指令，不启动任务。
  assert.deepEqual(parseCliRequest("/agy login"), {
    cliId: "agy",
    prompt: "",
    login: true,
  });
  assert.deepEqual(parseCliRequest("@MyBot /codex login"), {
    cliId: "codex",
    prompt: "",
    login: true,
  });
  assert.deepEqual(
    parseCliRequest("@ThreadPilot /agy login", undefined, ["codex", "agy"]),
    { cliId: "agy", prompt: "", login: true },
  );
  // login 只是任务正文的一部分时仍是普通引擎请求。
  assert.deepEqual(parseCliRequest("/agy login 后检查配置"), {
    cliId: "agy",
    prompt: "login 后检查配置",
  });
  // 未注册引擎不会变成登录指令。
  assert.equal(
    parseCliRequest("/unknown login", undefined, ["codex", "agy"]),
    undefined,
  );
});
