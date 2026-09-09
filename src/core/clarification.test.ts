/**
 * 澄清请求数据结构测试：Schema 边界校验与工具调用历史提取。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ClarificationFlowStore,
  ClarificationRequestSchema,
  findClarificationRequest,
  formatClarificationAnswers,
  formatClarificationMessage,
} from "./clarification.js";

test("合法澄清请求通过校验并填充默认值", () => {
  const parsed = ClarificationRequestSchema.safeParse({
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入用户详情？",
        recommendedOptionId: "name",
        options: [
          { id: "name", label: "点击列表姓名" },
          { id: "menu", label: "从操作菜单进入" },
        ],
      },
    ],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.title, "需求澄清");
    assert.equal(parsed.data.intro, "");
  }
});

test("拒绝重复的选项 ID 与不存在的推荐项", () => {
  const duplicateOption = ClarificationRequestSchema.safeParse({
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入？",
        options: [
          { id: "name", label: "点击姓名" },
          { id: "name", label: "从菜单进入" },
        ],
      },
    ],
  });
  assert.equal(duplicateOption.success, false);

  const missingRecommended = ClarificationRequestSchema.safeParse({
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入？",
        recommendedOptionId: "ghost",
        options: [
          { id: "name", label: "点击姓名" },
          { id: "menu", label: "从菜单进入" },
        ],
      },
    ],
  });
  assert.equal(missingRecommended.success, false);
});

test("拒绝重复的问题 ID 与越界的问题/选项数量", () => {
  const option = (id: string) => ({ id, label: `选项 ${id}` });
  const question = (id: string) => ({
    id,
    prompt: `问题 ${id}?`,
    options: [option("1"), option("2")],
  });

  const duplicateQuestion = ClarificationRequestSchema.safeParse({
    questions: [question("a"), question("a")],
  });
  assert.equal(duplicateQuestion.success, false);

  const tooManyQuestions = ClarificationRequestSchema.safeParse({
    questions: Array.from({ length: 6 }, (_, index) =>
      question(`q${index}`),
    ),
  });
  assert.equal(tooManyQuestions.success, false);

  const tooFewOptions = ClarificationRequestSchema.safeParse({
    questions: [{ ...question("a"), options: [option("1")] }],
  });
  assert.equal(tooFewOptions.success, false);
});

test("findClarificationRequest 提取最近一次合法澄清请求", () => {
  const valid = {
    title: "确认范围",
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入？",
        options: [
          { id: "name", label: "点击姓名" },
          { id: "menu", label: "从菜单进入" },
        ],
      },
    ],
  };
  const calls = [
    { toolName: "Bash", input: { command: "ls" } },
    { toolName: "request_clarification", input: valid },
  ];
  assert.equal(findClarificationRequest(calls)?.title, "确认范围");

  const expanded = [
    {
      toolName: "mcp__threadpilot_clarification__request_clarification",
      input: valid,
    },
  ];
  assert.equal(findClarificationRequest(expanded)?.title, "确认范围");

  // 跳过其他工具与未通过校验的调用，只认最近一次合法请求。
  const broken = { title: "", questions: [] };
  const mixed = [
    { toolName: "request_clarification", input: broken },
    { toolName: "request_clarification", input: valid },
  ];
  assert.equal(findClarificationRequest(mixed)?.questions.length, 1);

  assert.equal(findClarificationRequest(undefined), undefined);
  assert.equal(
    findClarificationRequest([{ toolName: "Bash", input: {} }]),
    undefined,
  );
});

test("逐题保存用户答案并允许 Agent 采用当前或全部剩余推荐", () => {
  const store = new ClarificationFlowStore();
  const flow = store.create({
    taskId: "task-1",
    botId: "product",
    sessionId: "session-1",
    ownerOpenId: "ou_owner",
    originalMessageId: "om_root",
    requestedPrompt: "增加用户详情页",
    replyInThread: true,
    request: {
      title: "确认详情页",
      intro: "请确认关键范围。",
      questions: [
        {
          id: "scope",
          prompt: "首期范围？",
          recommendedOptionId: "basic",
          options: [
            { id: "basic", label: "只读基础信息" },
            { id: "full", label: "包含编辑" },
          ],
        },
        {
          id: "entry",
          prompt: "从哪里进入？",
          recommendedOptionId: "list",
          options: [
            { id: "list", label: "用户列表" },
            { id: "search", label: "全局搜索" },
          ],
        },
        {
          id: "permission",
          prompt: "谁可以查看？",
          recommendedOptionId: "admin",
          options: [
            { id: "admin", label: "仅管理员" },
            { id: "staff", label: "全部员工" },
          ],
        },
      ],
    },
  });

  const first = store.answer(flow.token, "scope", "只读基础信息");
  assert.equal(first?.complete, false);
  assert.equal(first?.flow.currentIndex, 1);
  assert.equal(first?.flow.answers[0]?.source, "user");

  const second = store.answerWithRecommendation(flow.token, false);
  assert.equal(second?.complete, false);
  assert.equal(second?.flow.answers[1]?.answer, "用户列表");
  assert.equal(second?.flow.answers[1]?.source, "agent");

  const completed = store.answerWithRecommendation(flow.token, true);
  assert.equal(completed?.complete, true);
  assert.equal(completed?.flow.answers[2]?.answer, "仅管理员");
  assert.match(formatClarificationAnswers(flow), /Agent 采用推荐方案：用户列表/);
});

test("同一任务的新流程替换旧 token，文字补充保留已确认答案", () => {
  const store = new ClarificationFlowStore();
  const create = () =>
    store.create({
      taskId: "task-1",
      botId: "product",
      sessionId: "session-1",
      ownerOpenId: "ou_owner",
      originalMessageId: "om_root",
      requestedPrompt: "增加用户详情页",
      replyInThread: true,
      request: {
        title: "确认范围",
        intro: "",
        questions: [
          {
            id: "scope",
            prompt: "首期范围？",
            options: [
              { id: "basic", label: "基础信息" },
              { id: "full", label: "完整信息" },
            ],
          },
        ],
      },
    });
  const first = create();
  store.answer(first.token, "scope", "基础信息");
  const supplement = formatClarificationMessage(first, "还要展示注册时间");
  assert.match(supplement, /用户回答：基础信息/);
  assert.match(supplement, /还要展示注册时间/);

  const replacement = create();
  assert.equal(store.get(first.token), undefined);
  assert.equal(store.findForTask("task-1", "product"), replacement);
});
