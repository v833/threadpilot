# ThreadPilot

<p align="center">
  <img src="docs/public/logo-lockup.svg" alt="ThreadPilot" width="720">
</p>

> 在飞书话题里，指挥你的 AI 编程团队。

当前阶段支持从飞书话题真实调度 Codex、Claude Code、DimAgent 或 agy，并用同一张卡片实时展示当前动作、工具轨迹、耗时和上下文；成功后答案回到卡片正文，任务也可由发起人随时停止。同一话题会续接 CLI 上下文，会话和恢复指针都可跨进程重启恢复。一个进程可以按注册表启动多台职责不同的 bot，每台 bot 使用独立凭证、默认引擎、接入模式和角色说明，同时保留 `@` 提及、富文本代码以及图片和文件下载能力。

## Cordis 插件架构（一切皆为插件）

插件化设计：运行中的 ThreadPilot 本质上是一个 Cordis 根 Context，平台、执行引擎、斜杠命令、会话、任务编排和 bot 协作都是挂载在它上面的插件，通过 `ctx.<service>` 与类型化事件协作，而不是互相导入具体实现。

- **插件装配**：`cordis.yml` 声明启用哪些插件及参数。移除一个条目或设置 `disabled: true` 即可下线对应能力；新增能力只需写一个新插件并在 `src/plugins/loader.ts` 的注册表里登记名字。
- **服务**：`ctx.config`（bot 注册表）、`ctx.sessions`（会话模型）、`ctx.cli`（执行引擎与调度）、`ctx.lark`（飞书平台）、`ctx.cards`（卡片渲染）、`ctx.commands`（斜杠命令）、`ctx.tasks`（任务编排）、`ctx.schedule`（定时任务）、`ctx.collaboration`（bot 协作）、`ctx.orchestration`（多话题并行编排）。消费方通过 `inject` 声明依赖，Cordis 按依赖自动决定启动顺序。
- **事件**：lark 插件发出 `bot/message` 与 `bot/card-action`，router 路由插件消费并派发；任务完成后 tasks 服务广播 `task/result`，失败时广播 `task/failed`——collaboration 监听成功事件决定是否自动交接，orchestration 监听两类事件更新子任务状态；orchestration 再广播 `orchestration/update` / `orchestration/evicted`，可选插件 `orchestration/live-panel` 据此挂起并节流刷新实时面板卡片（移除该插件即回退为仅汇总文本），可选插件 `orchestration/actions` 认领面板「重试」按钮回调并重新派发失败子任务（移除即无重试按钮）。协作与编排都是可选插件，移除后任务编排不受影响。
- **引擎与命令都是插件**：`src/plugins/engines/*.ts` 通过 `ctx.cli.register()` 登记 Codex/Claude/DimAgent；`src/plugins/commands/*.ts` 通过 `ctx.commands.register()` 登记 `/help`、`/new`、`/resume`、`/compact`、`/doc`、`/status`、`/team`、`/cd`、`/close`、`/schedule`、`/schedules`、`/orchestrate`、`/panel`。新增执行引擎或斜杠命令 = 新增一个插件。

默认 `cordis.yml` 内容：

```yaml
plugins:
  - name: config
    config:
      botsPath: config/bots.json
  - name: sessions
  - name: cli
  - name: engines/claude
  - name: engines/codex
  - name: engines/dimagent
  - name: lark
  - name: cards
  - name: commands
  - name: commands/help
  - name: commands/new
  - name: commands/resume
  - name: commands/compact
  - name: commands/doc
  - name: commands/status
  - name: commands/cd
  - name: commands/close
  - name: commands/schedule
  - name: commands/schedules
  - name: collaboration
  - name: orchestration
    config:
      dispatchMode: topic
      maxRetry: 2
      pendingTimeoutMs: 1800000
  - name: orchestration/live-panel
  - name: orchestration/actions
  - name: commands/orchestrate
  - name: commands/panel
  - name: tasks
  - name: schedule
  - name: router
```

底层纯函数模块（`src/core/*`、`src/cli/*`、`src/im/*`）保持无框架依赖，由服务插件复用；`src/index.ts` 只是创建根 Context 并挂载 loader 的引导入口。

## 飞书开放平台配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建“飞书智能体应用”。
2. 确认应用已启用机器人能力，并订阅 `im.message.receive_v1` 与 `drive.notice.comment_add_v1` 事件；后者用于接收产品方案云文档评论。
3. 事件接收方式选择“使用长连接接收事件”。
4. 创建一个话题群，在群设置的“群机器人”中加入该应用。
5. 为每台 bot 创建应用并把 App ID、App Secret 写入本地 `.env`。bot 的对应关系在 `config/bots.json` 中维护。

`.env` 已被 Git 忽略，禁止提交真实凭证。

## 多 bot 注册表

先复制配置模板，再按本机 bot 填写配置：

```powershell
Copy-Item config/bots.example.json config/bots.json
```

`config/bots.json` 的顶层 `teamLeader` 声明团队负责人（稳定 ID，必须指向启用成员，否则在建立飞书连接前拒绝启动）；可选的 `defaultProductDeliveryMode` 为 `local` 或 `lark-doc`，省略时保持兼容旧版本的 `local`；`bots` 的每一项包含稳定的 `id`、凭证环境变量名、`defaultCli`、`workspace`、`role`、`systemPrompt` 和可选的 `skills`、`accessMode`、`enabled`、`collaborationMaxRounds`、`proxy`。`role` 是一句话职责说明，飞书 `/team` 团队卡片与成员提示词都会用到；`skills` 声明该成员处理任务时必须遵守的项目 Skill（如 `grill-me`）。Skill 按当前 workspace 的 `.agents/skills`、`.claude/skills`、ThreadPilot 内置 `.agents/skills`，再到用户级 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills` 的顺序查找，workspace 同名 Skill 可以覆盖内置版本；任务启动时会把最终解析到的内容注入提示词。`accessMode` 可填写 `headless` 或 `acp`，未填写时默认 `headless`；`acp` 是标准接入能力，由 `engines/acp` 插件提供，任何 defaultCli 都可声明（前提是该引擎注册了对应接入模式，运行时由 CLI 注册表校验）。`collaborationMaxRounds` 默认是 `16`，可设置为 `1` 到 `32`，防止协作失控循环。可选的 `proxy` 为该 bot 的网络代理 URL（如 `http://127.0.0.1:10808`）：配置后执行 CLI 时会把 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 注入子进程，供需要代理访问云端服务的引擎（如 agy）使用；不配置则该 bot 继承 `.env` 中的全局代理变量（见下）。也可以在 `.env` 中配置 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 作为所有 bot 的全局默认代理，bot 级 `proxy` 优先于 `.env` 的全局配置。两者都未配置则保持直连。示例文件可以提交，实际配置已被 Git 忽略：

```json
{
  "teamLeader": "developer",
  "bots": [
    {
      "id": "developer",
      "appIdEnv": "FEISHU_DEVELOPER_APP_ID",
      "appSecretEnv": "FEISHU_DEVELOPER_APP_SECRET",
      "defaultCli": "dimagent",
      "accessMode": "acp",
      "workspace": ".",
      "role": "开发工程师，负责完成实现与验证",
      "systemPrompt": "你是主力开发助手，负责理解需求并完成实现；团队协作任务完成后向 Team Leader 返回结果，用户直接 @你的独立任务则直接向用户交付。",
      "collaborationMaxRounds": 16
    },
    {
      "id": "qa",
      "appIdEnv": "FEISHU_QA_APP_ID",
      "appSecretEnv": "FEISHU_QA_APP_SECRET",
      "defaultCli": "codex",
      "workspace": ".",
      "role": "QA 工程师，负责执行测试、验证验收标准并给出质量结论",
      "systemPrompt": "执行构建、测试和一次代码 review；团队协作任务完成后把测试证据与结构化缺陷交回 Team Leader，用户直接 @你的独立任务则直接向用户交付。",
      "enabled": true
    },
    {
      "id": "assistant",
      "appIdEnv": "FEISHU_ASSISTANT_APP_ID",
      "appSecretEnv": "FEISHU_ASSISTANT_APP_SECRET",
      "defaultCli": "codex",
      "workspace": ".",
      "role": "个人助理，负责协助用户处理日常事务、信息整理、计划安排和执行跟进",
      "systemPrompt": "你是个人助理，负责协助用户处理日常事务、信息整理、计划安排和执行跟进。",
      "enabled": true
    }
  ]
}
```

`appIdEnv` 和 `appSecretEnv` 指向 `.env` 中的真实凭证变量。停用 bot 时设置 `enabled: false`，它不会读取凭证或建立长连接；全部停用或配置字段错误时程序会在启动阶段退出。修改 `.env` 或 `config/*.json` 会触发 `pnpm start` 自动重启。群里 @哪台 bot，就由哪台 bot 接手，程序无需再次判断目标应用。

私聊 bot 时，任务进入 direct 模式：忽略该 bot 的团队角色、团队 Skill 和产品方案流程，不接受或派发其他 bot 的协作消息，直接回答当前用户。群聊中直接 `@普通成员` 进入 standalone 模式：保留该成员自身角色、Skill 和产品能力，但禁止跨 Bot 协作与自动回传；直接 `@Team Leader` 才进入 team 模式。Leader 派发给成员的 Bot 交接消息也使用 team 模式，成员完成后固定回到 Leader。需要在私聊中生成可查阅的飞书云文档时，使用 `/doc <任务>` 显式开启文档交付。

个人助理使用独立的飞书应用凭证和 `assistant` bot ID，不参与 Team Leader 组织的研发协作流程。启用前请在 `.env` 中填写 `FEISHU_ASSISTANT_APP_ID` 和 `FEISHU_ASSISTANT_APP_SECRET`，并把本地 `config/bots.json` 中的 `assistant.enabled` 设置为 `true`。

团队模式中的产品、开发和 QA 均由 Team Leader 统一调用 `dispatch_task` 派发；成员完成后通过固定的 `reportToBotId` 回到 Leader。用户直接 `@普通成员` 的 standalone 任务独立完成，不进入这条团队链。默认装配不启用自动 QA Gate，也不允许成员绕过 Leader 直接组织下一阶段。

在飞书群中 @任意成员发送 `/team`，会返回一张团队卡片，展示每位成员的职责、默认执行引擎、项目 Skill 与连接状态。

## 团队派发工作流

`dispatch-task` 插件向所有执行引擎动态注册 `dispatch_task` MCP 工具，但运行时只允许 `teamLeader` 调用。工具参数包含目标成员 `targetBotId`、协作目标 `objective`、完整要求 `instruction` 和可选期望产出 `expectedOutput`。校验通过后，`ctx.collaboration` 会登记一次性交接单、回复通用协作卡片并发送真正 `@` 目标 bot 的富文本消息；移除 `cordis.yml` 中的 `dispatch-task` 条目即可整体下线该入口。

交接单保存真人发起人、固定编排者 `reportToBotId` 和轮次信息。普通成员完成后，结果始终回到编排者，由编排者继续调用 `dispatch_task` 或向真人收口，不会在成员之间无条件来回弹。非 Team Leader、自派发、未知成员或超过 `collaborationMaxRounds` 的调用都会被拒绝。

## 产品文档工作流

产品经理使用 `grill-me` 完成澄清，再按全局 `defaultProductDeliveryMode` 选择唯一的方案交付方式：`local` 继续使用 `to-spec` 与 `to-tickets` 生成 `.scratch/<feature>/spec.md` 和 `issues`；`lark-doc` 使用用户级 `lark-doc` Skill 通过 `lark-cli docs +create --profile <botId> --as bot` 生成或更新飞书云文档。用户在单次任务中明确选择的方式会覆盖全局默认值，但不会同时维护两份方案。

两种方式都通过 `request_spec_approval` 提交。`product-spec` 插件认领启用了 `to-spec` 或 `lark-doc` 的 bot：本地模式会校验 Spec 是文件、Tickets 目录至少包含一个 Markdown 文件并记录内容指纹；飞书模式校验 `documentUrl` 使用 HTTPS、可信飞书系域名及 `/docx/` 路径，不读取本地文件。旧版本只提交 `specPath` 与 `ticketsPath` 的本地调用会自动按 `local` 兼容处理。随后任务卡只展示选中的唯一产物和“确认产品方案”按钮；只有贯穿协作链路的真人发起人可以确认。若方案来自团队交接且同时装配了 `dispatch-task`，确认事件会自动回到原 `reportToBotId`，由 Team Leader 决定是否再用 `dispatch_task` 交给职责合适的成员；直接发给产品经理的任务仍只更新确认状态。移除 `cordis.yml` 中的 `product-spec` 条目即可整体下线产品确认，移除 `dispatch-task` 则只下线自动团队回传。

## lark-cli 多应用（profile）与授权流程

Agent 使用 `lark-cli` 操作飞书云文档时，必须按“一个 bot = 一个 profile = 一个应用”工作，否则会出现文档归属错误（落到别的 bot 应用）或身份错误（以 `--as user` 创建时作者变成授权用户本人，且机器人在文档中不可被 @）。以下流程在首次部署或新增/更换 bot 时执行一次；配置完成后，ThreadPilot 会把 `--profile <botId> --as bot` 写进每个 bot 的任务提示词，无需手动干预。

### 1. 为每台 bot 添加 profile

`lark-cli` 的 profile 是独立的“应用凭证 + token”集合，名称必须与 `config/bots.json` 中的 bot `id` 一一对应（`qa`、`product`、`developer`、`ceo-assistant`）：

```powershell
# 从 .env 读取真实密钥，经 stdin 传入，避免出现在进程列表中
$secret = (Get-Content .env | Where-Object { $_ -match '^FEISHU_PRODUCT_APP_SECRET=' }) -split '=', 2 | Select-Object -Last 1
$secret | lark-cli profile add --name product --app-id cli_aaf077ee4e3adcce --app-secret-stdin

# 全部配置完成后查看：
lark-cli profile list
lark-cli whoami
```

注意：
- 一个 App ID 只能属于一个 profile；如果默认 profile 的名字是 App ID（如 `cli_aa0f399505b81cc8`），可以用 `lark-cli profile rename` 改成与 bot id 一致，例如 `lark-cli profile rename cli_aa0f399505b81cc8 qa`。
- CLI 明确禁止同一 App ID 重复添加 profile。

### 2. 开放平台申请文档 scope

在每个应用的开发者后台申请并**发布版本**后，该应用的 bot 身份才能创建/读写文档（“已申请”不等于“已生效”）：

```text
docx:document
docx:document:create
docx:document:readonly
docx:document:write_only
docs:document.comment:read
```

申请失败时错误信息会给出直达链接，形如 `https://open.feishu.cn/page/scope-apply?clientID=<appId>&scopes=docx:document,docx:document:create`。用 `lark-cli --profile <botId> auth scopes` 可确认每个应用是否已开通对应权限。

### 3. 为 profile 绑定你的飞书账号（user 授权）

user 授权只用于“机器人创建文档后，自动把你添加为 `full_access` 协作者”（permission_grant）；没有它文档也能创建，但你需要手动加协作者才能看到：

```powershell
# 发起非阻塞授权，拿到 device_code 与 verification_url
lark-cli --profile product auth login --domain docs --domain drive --domain im --no-wait --json

# 把上面的 verification_url 生成二维码给用户扫描（或直接打开链接）
lark-cli auth qrcode "https://accounts.feishu.cn/oauth/v1/device/verify?..." -o product-qr.png

# 用户扫码确认后，用同一个 device_code 完成轮询
lark-cli --profile product auth login --device-code <DEVICE_CODE> --json
```

device flow 约 10 分钟有效；完成后 `lark-cli --profile <botId> auth status` 应看到 `user: ready`。

### 4. 验证全链路

```powershell
# 每台 bot 逐一验证：状态、权限、真实建删
lark-cli --profile qa auth status
lark-cli --profile qa auth scopes
lark-cli --profile qa docs +create --as bot --title "verify" --content "验证"   # 成功后记下 document_id
lark-cli --profile qa drive +delete --file-token <document_id> --type docx --as bot --yes
```

验证要点：创建响应的 `permission_grant.status` 为 `granted`（说明已自动给你 full_access）；`drive +search` 确认验证文档已清理。

### 注意事项

- 任务提示词已注入“lark-cli 命令必须显式携带 `--profile <botId> --as bot`”的强制规则；请勿手动改回 `--as user`，否则新文档作者会变成你本人且 @ 不到机器人。
- 除非要彻底移除某个 bot，不要用 `lark-cli profile use` 全局切换默认 profile，命令显式 `--profile` 即可，避免其他任务误用。
- user token 到期后状态会是 `needs_refresh`，`lark-cli` 会自动刷新，通常无需重新扫码。

## 启动与验证

```powershell
pnpm build
pnpm test
pnpm start
```

测试默认由最多 6 个独立进程按实测长文件优先并行执行，耗时较长的进程生命周期、
ACP 守护进程与宿主集成测试会拆成逻辑分片，并按静态 manifest 逐片校验测试数量。CLI 分组默认使用 3 个进程，其他分组使用 4 个；开发中可用
`pnpm test:fast`、`pnpm test:cli` 或 `pnpm test:plugins` 缩短反馈时间；排查顺序污染时
使用 `pnpm test:serial`。可通过 `THREADPILOT_TEST_WORKERS` 临时调整并发数。

看到 `ws client ready` 后，在测试话题群里 `@机器人` 发送消息。

## PM2 持久化运行

机器人以 pm2 常驻托管（崩溃自动重启、日志落盘 `data/pm2/`），不再依赖终端窗口。配置文件为根目录 `ecosystem.config.cjs`，内部以 `tsx` 直跑 `src/index.ts`（等价 `pnpm start:once`，不带文件监听），发版后手动重启即可。

```powershell
npm install -g pm2            # 首次：全局安装 pm2
pnpm pm2:start                # 启动机器人（崩溃自动重启）
pnpm pm2:status               # 查看运行状态
pnpm pm2:logs                 # 实时查看日志
pnpm pm2:restart              # 发版部署后重启
pnpm pm2:stop                 # 停止
pnpm pm2:delete               # 从 pm2 移除
```

开机自启（Windows）：pm2 不原生支持 `pm2 startup`，改为登录时恢复进程快照：

1. 首次启动并确认正常后执行 `pnpm pm2:save` 保存进程快照（已在本机执行过）；
2. 打开「任务计划程序」→ 创建任务：触发器选择「登录时」，操作选择「启动程序」，程序填 `pm2`（或 `C:\Program Files\nodejs\pm2.cmd`），参数填 `resurrect`；
3. 登录后机器人自动恢复，`pnpm pm2:status` 应为 `online`。

> 从手动运行切换到 pm2 时，先停掉旧的手动进程，避免 `EADDRINUSE`（端口 3101）冲突。

## CLI 引擎配置

先确认本机终端可以找到两个 CLI：

```powershell
codex --version
claude --version
```

Codex 尚未安装时执行：

```powershell
npm install -g @openai/codex
codex
```

完成登录后，在项目目录验证非交互模式：

```powershell
codex exec --json --sandbox danger-full-access --skip-git-repo-check "只回复：Codex 已就绪"
```

Claude Code 尚未安装时执行：

```powershell
npm install -g @anthropic-ai/claude-code
claude
```

首次运行 `claude` 时完成 Anthropic 登录。使用兼容模型服务时，把供应商地址、认证令牌和模型配置保存在各 CLI 的用户级配置中，也可以使用 CC Switch 切换服务；不要把模型密钥写入项目或提交仓库。

飞书无法展示 Claude Code 的交互式权限确认，因此 ThreadPilot 会以 `--dangerously-skip-permissions` 无人值守运行 Claude。只应把 bot 指向明确可信、可随时回退的工作目录。

每台 bot 的默认工作目录和新话题默认引擎由 `config/bots.json` 决定：

```json
{
  "id": "developer",
  "defaultCli": "claude",
  "workspace": "C:\\你的\\项目\\绝对路径"
}
```

- `workspace` 可以填写相对路径或绝对路径；相对路径从 ThreadPilot 启动目录解析，未填写时兼容读取 `CLI_WORKDIR`、`CLAUDE_WORKDIR`，最后回退当前目录。
- 工作目录决定 CLI 读取、修改和执行命令的项目，启动时会检查路径存在且是文件夹。
- 话题创建时复制 bot 的默认目录；同一 bot 的不同话题可以分别使用不同项目。
- 在话题中发送 `/cd` 查看目录，发送 `/cd <目录>` 切换目录。相对路径以当前话题目录为基准，目录变化会清除旧 CLI 会话，下一条任务重新建立上下文。
- 已持久化话题继续使用自己的 `cliId`；修改 bot 的 `defaultCli` 只影响之后创建的新话题。

Codex 通过 `codex exec --json --sandbox danger-full-access --skip-git-repo-check` 运行，拥有完整系统访问权限；同一话题追问使用带 `--sandbox danger-full-access` 的 `codex exec resume`。Claude Code 通过 `claude -p --output-format stream-json --verbose` 运行，权限和模型后端沿用用户级 Claude Code 配置。

### Antigravity（agy headless）

安装并完成 agy 登录后，可在 `config/bots.json` 中把 bot 的 `defaultCli` 设置为 `agy`。agy 的 `-p/--print` headless 模式会加载 MCP；ThreadPilot 每轮启动前会把插件注册的 stdio Server 合并到当前工作区 `.agents/mcp_config.json`，保留用户已有的其他 Server，因此 `request_clarification` 也能进入飞书表单链路。agy 的全局 MCP 配置仍位于 `~/.gemini/config/mcp_config.json`。

```powershell
agy --version
agy mcp list
pnpm probe:tool agy .
```

agy 当前没有原生 `/compact` 协议；话题仍可发送普通任务继续整理上下文。

#### agy 登录与「登录卡片」（auth 插件）

agy 未登录 Google 账号时，headless 任务会以 `Authentication required ...` 失败。启用 auth 插件（`cordis.yml` 中 `- name: auth`）后，ThreadPilot 会在失败话题里补发登录卡片：用户打开卡片上的授权链接，把授权码粘贴到输入框并点「确认并登录」，auth 插件会通过 ConPTY 把授权码注入 agy 完成登录（agy 只在真实 TTY 上接受粘贴，普通管道 stdin 会被忽略）。登录成功后令牌写入 `~/.gemini/antigravity-cli/antigravity-oauth-token`，之后 headless 免登录运行。

- 登录执行器由 `AgyAdapter.login()` 提供（`src/cli/agy-adapter.ts`），auth 插件不感知引擎细节；其他引擎可按 `CliAdapter` 的可选协议 `isAuthRequired` / `login` 接入同类能力。
- 授权码有效期短（通常几分钟），超时后需要重新生成；提交后卡片会流转「登录中 → 成功/失败」，失败可修改后重新提交。

### DimAgent（headless / ACP）

#### DimAgent 登录与「登录卡片」（auth 插件）

DimAgent 未登录平台账号时，任务会以 `Not signed in to DimAgent` 失败。启用 auth 插件后，ThreadPilot 会在失败话题里补发登录卡片：点击「确认并登录」即启动设备码流程（`dim auth login --device-login`），卡片会实时展示授权链接与设备码，用户在浏览器完成授权后自动完成登录（无需输入任何 key）。凭据写入 `~/.dimcode/v2/auth.json`，之后 headless / ACP 免登录运行。登录执行器由 `DimagentAdapter.login()` 提供（`src/cli/dimagent-adapter.ts`），声明 `loginMode: "device"`；auth 插件按此渲染“无输入框 + 浏览器授权”的卡片形态。

安装并先在交互界面完成 provider、模型和 MCP 配置：

```powershell
npm install -g dimcode
dim
```

DimAgent 的官方 CLI 入口是 `dim`；如果使用自定义命令名，可在 `.env` 中通过 `DIMAGENT_COMMAND` 覆盖。

官方 CLI 支持 stdio 与 HTTP MCP：`dim mcp add` 管理 `~/.dimcode/v2/mcp.json`，项目级配置为 `<project>/.mcp.json`；`dim exec` 默认加载配置中的 MCP，也可用 `--mcp-server <id>` 选择 Server。ThreadPilot 每轮 headless 执行前会把 `request_clarification` Server 增量写入当前项目的 `.mcp.json`，保留已有 Server；设置 `DIMAGENT_MCP_CONFIG_PATH` 可覆盖写入位置。

bot 通过 `accessMode` 选择接入方式，未填写时默认 `headless`：

```json
{
  "id": "developer",
  "defaultCli": "dimagent",
  "accessMode": "acp",
  "workspace": "."
}
```

- `headless`：每轮调用 `dim exec --json --policy full-access`，续聊使用 `dim exec resume <session-id>`。
- `acp`：由 `engines/acp` 插件以标准 ACP 协议接入——维护单个常驻 `dim acp` 进程，任务在同一进程上并发执行，新建或恢复 session 后把消息分片、工具状态与 token 用量映射到实时卡片；空闲自动回收、崩溃自动重连。
- ACP 与 headless 都复用 `~/.dimcode/v2/` 中的 provider、模型和凭据配置。`initialize` 不调用 `authenticate`，直接使用已有 Dim OAuth 登录。`session/new`、`resume`、`load` 的 `cwd` 会统一解析为绝对路径。
- Dim ACP 恢复按 `session/load` 走跨进程续接，要求 `dim >= 0.3.10`；旧会话锁仍在释放时会有限退避重试，找不到会话则清理失效指针并提示重新建立。
- `engines/acp` 的 `session.configOptions` 会在建 session 后按声明顺序调用 `session/set_config_option`；当前 DimAgent 配置为 `permission=full-access`、`mode=agent`，否则写入和进程工具会被只读预设静默拒绝。配置失败会终止本轮，不会假装继续执行。
- 可选的 `session.model` 会先校验 `session/new` 返回的 `models.availableModels`（兼容标准 `configOptions` 模型选项），再调用 DimCode 扩展 `session/set_model`。例如：

```yaml
session:
  configOptions:
    permission: full-access
    mode: agent
  model: dimcode-api-oauth/deepseek-v4-pro
```

- 官方 CLI 文档支持 stdio，但本机 `dimcode 0.3.16` 的 ACP `session/new` 会拒绝 stdio MCP；ThreadPilot 因此为 ACP 额外启动仅监听 `127.0.0.1` 的 HTTP MCP 入口，并把同一个 `request_clarification` 工具通过该入口注入。这样切换 `accessMode` 仍保持飞书澄清链路一致。只应配置可信且可回退的工作目录。
- 同一话题会自动续接 DimAgent session；当前 `/resume` 不枚举 DimAgent 自身数据库中的历史会话，`/compact` 也暂不调用 DimAgent 原生整理协议。

新话题可发送 `/dimagent <任务>` 显式选择 DimAgent；接入模式仍取该 bot 的 `accessMode` 配置。`engines/acp` 插件通过 `cordis.yml` 的 `engines` 列表声明 ACP 引擎（`id`/`command`/`args`），因此任何提供 ACP server 的 CLI 都能以相同方式接入；未注册的引擎与接入模式组合会在运行时明确报错。

## 话题与提及验证

分别在话题根消息和已有话题中 `@机器人`。终端应输出：

```text
[收到] chat=oc_xxx threadId=omt_xxx rootId=om_xxx sender=ou_xxx
  原文: @_user_1 帮我看看 @_user_2 的代码
  还原: @MyBot 帮我看看 @运营专家 的代码
  mentions: @_user_1=MyBot(ou_xxx), @_user_2=运营专家(ou_xxx)
[卡片] 已发送 message_id=om_xxx inThread=true
```

根消息的 `rootId` 可能为空，但话题消息会带 `threadId`；已有话题内的回复通常同时带 `threadId` 和 `rootId`。任务卡片应留在当前话题。

`text` 消息正文中的 `@_user_N` 会被还原为显示名；`post` 消息会保留 `at` 占位符，并在后续统一还原提及。富文本中的 `text`、链接、行内代码、代码块、Markdown 和换行也会进入 CLI 提示词，图片仍由资源下载链路单独处理。

## 图片和文件下载

不要只发送裸图片。在话题编辑器中输入 `@机器人 帮我看看这张图`，再把文字和图片作为同一条消息发送，以覆盖 `post` 内嵌图片分支。

资源会保存到：

```text
data/downloads/
```

图片根据响应 `Content-Type` 保存为 `jpg`、`png`、`gif`、`webp`、`bmp` 或 `ico`；无法识别时使用 `.img`。普通文件优先保留原文件扩展名，无法识别时使用 `.bin`。

PowerShell 中可以检查下载结果：

```powershell
Get-ChildItem -LiteralPath .\data\downloads
```

验证范围：

- `@机器人 + 文字 + JPEG/PNG/WebP`：扩展名应与真实格式一致
- `@机器人 + 文字 + 普通文件`：应保留原文件扩展名
- 日志应出现 `  [下载] image|file → data\downloads\...`

下载失败时：

- `234003`：检查 `message_id` 和资源 key 是否来自同一条消息
- `234004`：检查机器人是否仍在当前群里
- 权限错误：确认应用已获得读取消息资源所需的消息权限
- 日志成功但找不到文件：确认从项目根目录运行 `pnpm start`

群聊中不带 `@机器人` 的普通消息默认不会推送给应用。

## 飞书到 CLI 的真实执行链路

在新话题发送一个容易核对的只读任务：

```text
@机器人 请读取 package.json，告诉我项目名称和主要依赖，不要修改文件
```

系统会依次执行：

1. 创建或复用当前话题的 ThreadPilot 会话，并切换为 `active`。
2. 在原话题发送蓝色的“Codex · 执行中”或“Claude Code · 执行中”卡片。
3. 后台启动真实 CLI 子进程，飞书长连接仍可处理 `/status` 和 `/close`。
4. 按行解析 stdout 中的 JSONL；一行可产生多个统一事件，普通诊断噪音会被忽略。
5. 工具、上下文事件实时汇总成稳定快照，打印到终端并以一秒上限刷新原卡片。
6. 成功时把原卡片更新为绿色，答案置于正文；超出卡片上限的剩余内容继续回复到同一话题。
7. 失败时卡片变红并折叠技术详情；停止时卡片变灰，不会写入迟到的成功状态。
8. 最后清理运行记录，把未关闭的会话持久化为 `idle`。

终端会输出实际引擎和工作目录：

```text
[CLI] id=claude command=claude
[CLI] id=codex command=codex
[Bot DEVELOPER] default_cli=claude access_mode=headless workspace=C:\你的\项目
[CLI] 启动 engine=codex access_mode=headless cwd=C:\你的\项目
[CLI] codex 完成 session_id=019f...
```

Claude Code 的 `session_id` 来自 `system/init` 或最终 `result` 事件；Codex 的会话标识来自 `thread.started.thread_id`，最终回答取最后一个 `item.completed` 的 `agent_message`。供应商事件先由各自适配器翻译，再交给通用 Runner 处理。

### CLI 流式事件与实时任务卡片

适配器会把供应商 JSONL 统一为会话、工具开始、工具结束、上下文、最终结果和错误事件。Claude Code 同一条 `assistant` 消息中的上下文用量及多个 `tool_use` 都会保留；`tool_result` 通过调用 ID 与开始事件配对。最终结果还会保留耗时、轮次、输入/输出/缓存 Token 和模型上下文窗口等真实统计。

Codex 使用 `item.started/item.completed` 中的 `command_execution`、`file_change`、`web_search` 和 `mcp_tool_call` 展示命令、文件修改、搜索与外部工具轨迹，并用 `item.id` 配对。最终回答来自 `agent_message`，输入、输出、缓存输入和总 Token 来自随后到达的 `turn.completed`；Runner 会合并两条事件。Codex 没有提供的 Claude 对应字段保持为空，不进行估算。

高频事件由 `TaskProgressTracker` 汇总：它支持并行工具调用，记录耗时、失败状态、本轮第一次和最新一次上下文，最多保留最近 12 条完成活动。快照仍会打印到终端，例如：

```text
[进度] 读取文件 detail=package.json tools=0/1 context=18432
[进度] 正在分析执行结果 tools=1/1 context=18432
```

同一份快照还会进入飞书卡片。`ThrottledCardUpdater` 在一秒窗口内只保留最新状态，并串行提交更新，避免高频工具事件触发限流或让画面来回跳动。没有新事件时，每秒心跳仍会推进耗时。

运行中卡片把当前动作放在顶部，只显示最近 3 条轨迹和“停止任务”按钮。成功后答案回到正文顶部，执行统计与最近 8 条轨迹收进折叠面板；失败显示可重试提示并折叠技术错误；取消使用灰色终态。

回答不超过 900 个字符时直接展示，更长时显示预览和折叠全文。超过卡片 6000 字符上限的剩余部分会按不超过 4000 字符的文本消息继续发送，并尽量在换行处切分。

停止按钮通过 `card.action.trigger` 回调。操作者身份只读取飞书平台回传的 `open_id`，并与任务发起人比较；按钮同时携带会话 ID 和每轮唯一运行 ID，因此旧卡片不能停止同一话题后来启动的新任务。按钮只停止本轮，`/close` 会停止本轮并关闭整个会话。

运行 `pnpm start` 后，在飞书新话题发送：

```text
@机器人 请读取 package.json 和 src/index.ts，总结项目的启动流程
```

终端应持续出现 `[进度]`，飞书卡片应每秒最多更新一次，完成后答案出现在绿色卡片正文。同一话题继续追问仍会续接原 CLI 会话。再发送一个长任务并点击“停止任务”，发起人会收到成功 Toast，卡片随后变灰，同一话题仍可继续提问；其他群成员点击时只会收到权限警告。

子进程使用参数数组且不启用 shell。飞书消息中的引号、换行、反引号或 `$()` 都只会成为提示词内容，不能拼接成额外系统命令。Windows 下会绕过 npm 的 `.cmd`/无扩展名包装器，直接启动真实 Node 入口或 exe，仍然保持 `shell=false`。每轮默认最多执行 30 分钟；可在 `.env` 中用 `CLI_TIMEOUT_MS` 统一配置，按引擎的 `<ENGINE_ID>_TIMEOUT_MS` 优先（例如 `CLAUDE_TIMEOUT_MS`、`CODEX_TIMEOUT_MS`）。显式超时或 `/close` 都会终止 CLI 及其整棵子进程树。

Codex 的 `app-server` 默认通过 stdio 通信，不需要额外的 `--stdio` 参数。首次 `codex exec` 使用 `--sandbox danger-full-access`；`codex exec resume` 使用 `--dangerously-bypass-approvals-and-sandbox`，因为续聊子命令不接受 `--sandbox`。Codex 返回 `stream disconnected before completion: Upstream request failed` 时，Runner 会把它视为瞬时流式断开，最多自动重试 5 次，依次等待 1 秒、1.5 秒、2 秒、2.5 秒、3 秒；已经建立 CLI 会话时优先使用续聊参数，没有会话 ID 时重新发起同一任务。Claude、认证、权限、会话失效和其他普通错误不会自动重试；用户在等待期间发送 `/close` 也会立即取消重试。

### 多 bot 与多引擎首通验收

插件按 cordis.yml 依次装配，启动日志先显示注册数量和会话恢复，再打印 CLI 引擎与每台 bot 的默认配置，随后出现连接成功：

```text
[配置] 已加载 3 个 bot 注册表
[会话] 已恢复 0 个会话
[Bot DEVELOPER] 已连接 name=开发助手 open_id=ou_developer
[Bot REVIEWER] 已连接 name=审查助手 open_id=ou_reviewer
[Bot ASSISTANT] 已连接 name=个人助理 open_id=ou_assistant
[CLI] id=claude command=claude
[CLI] id=codex command=codex
[Bot DEVELOPER] default_cli=claude access_mode=headless workspace=C:\你的\项目
[Bot REVIEWER] default_cli=codex access_mode=headless workspace=C:\审查\项目
[Bot ASSISTANT] default_cli=codex access_mode=headless workspace=C:\你的\项目
ThreadPilot 启动完成
```

分别新开三个话题，向开发助手、审查助手和个人助理各发一条任务。开发助手应使用 Claude Code，审查助手和个人助理应使用 Codex；同一话题分别 @ 三台 bot 时，`/status` 返回的机器人 ID、执行引擎和 CLI 会话 ID 也应各自独立。

单独发送 `/codex`、`/claude` 或 `/dimagent` 会提示补充任务，不会启动进程；在已建立的话题发送与原引擎不同的前缀，系统会要求新开话题，避免混用不同引擎的会话 ID。新话题可用对应的 `/<引擎> <任务>` 前缀显式选择执行引擎。

真实任务运行期间发送 `/close`，`AbortController` 会终止对应子进程。会话保持 `closed`，不会再发送绿色成功卡片或最终回答。

CLI 返回的会话标识会保存为 `Session.cliSessionId`。同一话题下一轮会自动调用 Claude Code 的 `--resume <session_id>` 或 Codex 的 `exec resume <thread_id>`；新话题没有恢复指针，会从干净上下文开始。

## Leader 统一研发流程

团队研发任务由 Team Leader 统一编排：Leader 先按需派发产品经理；产品方案经用户确认后自动回到 Leader；Leader 再派发 Developer；Developer 完成后自动回到 Leader；Leader 最多派发一次 QA；QA 完成一次 review 后自动回到 Leader，由 Leader 汇总结果、决定是否安排修复并最终通知用户。成员不能调用 `dispatch_task`，因此不会绕过 Leader 互相派发。

交接单保存真人发起人、固定编排者 `reportToBotId` 和协作轮次。卡片只负责展示任务说明，真实 `@` 消息负责触发目标 Bot；交接单被目标领取后立即删除，重复事件不会再次执行。当前交接单保存在内存中，服务在投递后重启会丢失尚未领取的任务。

### 多轮对话验收

1. 新开话题发送“请记住暗号‘Agent 操作系统’，只回复‘记住了’”。
2. 等待完成后，在同一话题追问“我刚才让你记住的暗号是什么？”，回答应包含“Agent 操作系统”。
3. 发送 `/status`，应同时看到 ThreadPilot 的“会话”和执行引擎的“CLI 会话”。
4. 打开 `data/sessions.json`，对应记录应包含非空 `cliSessionId`。
5. 重启机器人并在原话题继续追问，上下文仍应保留。
6. 新开另一个话题询问暗号，它不应继承上一话题的上下文。

## 会话模型

会话地址按以下优先级确定：

```text
threadId || rootId || messageId
```

再与 `chatId` 和当前 `botId` 组合为查找键。因此同一 bot 在同一群聊、同一话题里的追问会复用相同会话；不同 bot、不同话题或不同群会创建独立会话。普通群和单聊没有话题 ID 时，每条消息使用自身 `messageId` 创建会话。

会话状态流转：

```text
creating → active → idle → active
    └────→ idle（命令）
    └──────────────→ closed
```

- `creating`：刚创建，尚未执行
- `active`：Codex 或 Claude Code 子进程正在运行
- `idle`：上一轮完成，可以继续追问
- `closed`：话题会话已关闭，不再接受任务

执行中的普通消息会收到“当前会话还在执行”的提示，不会启动第二段任务。

每台 bot 的默认执行引擎和接入模式由注册表决定，会话类型支持 `claude`、`codex` 和 `dimagent`。引擎与接入模式只在话题首次创建会话时确定，之后的普通追问、显式引擎前缀和重启恢复都不能改变它。内存中的会话映射会同步保存到 `data/sessions.json`，程序重启后按原 bot、群聊和话题恢复；旧快照没有 `accessMode` 时按 `headless` 恢复。

## 会话持久化与重启恢复

程序启动时会先读取：

```text
data/sessions.json
```

文件不存在时按首次启动处理，日志会显示：

```text
[配置] 已加载 2 个 bot 注册表
[会话] 已恢复 0 个会话
```

每次创建会话、切换状态、更新 CLI 恢复指针或记录待重试任务时，`SessionManager` 都会保存完整快照。保存成功后内存和磁盘一起前进；首次创建保存失败会删除刚建立的内存会话，状态或恢复信息保存失败则回滚到原值。

磁盘存储遵循以下规则：

- 每条记录先经过 Zod 校验，坏记录会被过滤并从清理后的文件中移除。
- 每条记录包含 `botId` 和绝对 `workspaceDir`；升级前缺少 `botId` 或 `workspaceDir` 的旧记录会按 bot 默认目录补齐，并在加载后自动重写为新结构。
- 重启时仍为 `creating` 或 `active` 的会话恢复成 `idle`，因为旧任务进程已经不存在。
- Codex、Claude 和 DimAgent 都可以保存恢复指针。
- 旧记录可以没有 `cliSessionId`；首次任务成功后写入，新记录的空字符串会被视为坏数据。
- CLI 首次返回会话 ID 时会立即写入快照；即使任务随后被停止、超时或进程重启，下一条消息仍会优先尝试续接原会话。
- 若 CLI 明确返回会话不存在或已失效，ThreadPilot 会清除旧指针；下一次“继续执行”会用原始任务重新建立会话，避免无限重试坏 ID。
- 任务启动前会临时写入 `retryPrompt`，成功后立即删除；若失败发生在 CLI 返回会话 ID 之前，发送“继续执行”等明确重试指令会重放原任务。
- 并发保存通过写入队列串行执行，确保后触发的状态不会被旧快照覆盖。
- 数据先完整写入 `sessions.json.tmp`，再用 `rename` 替换正式文件，避免留下半截 JSON。

PowerShell 中可以检查当前快照：

```powershell
Get-Content -LiteralPath .\data\sessions.json -Encoding utf8
```

重启验收步骤：

1. 在飞书新话题发送任务，等待卡片完成。
2. 在原话题发送 `@机器人 /status`，记下“会话”和“CLI 会话”两个 ID；磁盘状态应为 `idle`。
3. 在终端按 `Ctrl+C`，然后重新运行 `pnpm start`。
4. 启动日志应显示 `[会话] 已恢复 1 个会话`，数量以实际已有话题为准。
5. 在原话题再次发送 `@机器人 /status`，两个会话 ID 都应与重启前相同，状态为“空闲”。
6. 新开话题发送消息，应创建不同的会话 ID。

## 会话命令

命令可以直接发送，也可以带机器人提及：

```text
/status
@机器人 /status
/help
/close
/new
/resume
/compact 保留接口约定，省略排查过程
/claude 检查 package.json
/codex 查看当前目录结构
```

- `/status`：返回 ThreadPilot 会话 ID、状态、执行引擎、CLI 会话 ID、工作目录、话题 ID 和更新时间
- `/new`：清空当前话题绑定的 CLI 会话；旧会话仍由引擎保留
- `/resume`：读取当前工作目录中的 Claude/Codex 原生会话并用卡片选择恢复
- `/compact [要求]`：在当前 CLI 会话内调用引擎原生上下文整理；Claude 支持附加要求，Codex 使用默认策略
- `/doc <任务>`：显式请求生成飞书云文档；普通任务不会自动触发文档交付
- `/cd`：查看当前工作目录
- `/cd <目录>`：切换当前话题的工作目录
- `/help`：列出会话控制和引擎选择命令
- `/close`：关闭当前话题会话
- `/schedule <自然语言需求>`：创建定时任务，例如 `/schedule 每天早上 9 点检查服务日志`
- `/schedule pause|resume|delete|run <id>`：暂停 / 恢复 / 删除 / 立即执行定时任务
- `/schedules`：查看当前聊天中由自己创建的定时任务
- `/orchestrate <大任务>`：拆解成多个子任务并行派发给团队成员（默认 `topic` 模式：同群多话题并行派发，同一 bot 可跨话题承接多个子任务；`same-topic` 为兼容降级）
- `/panel`：查看当前群聊、当前 bot 创建的编排运行进度（按 chatId + botId 隔离）
- `/claude <任务>`：新话题使用 Claude Code
- `/codex <任务>`：新话题使用 Codex
- `/dimagent <任务>`：新话题使用 DimAgent（接入模式取 bot 的 `accessMode`）

## 定时任务

ThreadPilot 可以把“开始”这件事也交给系统：用自然语言 `/schedule <需求>` 创建定时任务，到点后直接唤醒目标 bot 的 CLI 会话静默执行计划里的 `prompt`，结果由任务内容自己送回，不在群里推派发消息。

```text
/schedule 每天 9 点检查服务日志
→ CEO 助理调用 schedule_manage（action=add）创建，回执给出任务 id、规则与下次执行时间
/schedules
→ 当前聊天中由自己创建的计划卡片（id、执行成员、规则、状态、下次触发时间）
/schedule pause <id>     # 暂停
/schedule resume <id>    # 恢复
/schedule delete <id>    # 删除
/schedule run <id>       # 立即执行一次
```

核心机制（`schedule` 服务插件，`src/plugins/schedule.ts` + `src/core/scheduler.ts`）：

- **三种调度规则**由 `ScheduleRuleSchema` 约束：一次性 `runAt`、固定间隔 `everyMs`（最低 1 分钟）、Cron `expression` + 时区（缺省 `Asia/Shanghai`）。
- **计划与运行记录分离存储**：`data/schedules.json` 保存计划，`data/schedule-runs.json` 保存运行记录（同一 `scheduleId + scheduledFor` 只允许一条，防止重复触发；每计划最多保留 100 条历史）。
- **统一管理工具 `schedule_manage`**：`list/add/addMany/update/remove/removeMany/removeAll/run/pause/resume/logs` 十一种 action，按当前 `chatId + creatorOpenId` 隔离；MCP 子进程经 loopback 内部 HTTP API（`POST /api/schedules/manage`，默认端口 3101）当场执行，回执是真实落盘结果。
- **重启恢复**：启动时把中断的 `running` 记录标记失败，过期的一次性任务记 `skipped` 并完成，不会在重启后突然补跑。
- **schedules.json 热更新**：直接编辑文件后 watcher 自动对内存做新增、更新、删除差异合并，无需重启。
- **执行边界**：周期按计划时间保持固定节拍，上一轮未结束则本轮记 `skipped`；静默 CLI 单轮默认 30 分钟超时，可用 `<ENGINE>_TIMEOUT_MS` 或 `CLI_TIMEOUT_MS` 覆盖。
- 管理 API 只监听 `127.0.0.1`；如有本机其他进程接入，建议设置 `SCHEDULE_API_TOKEN`。
- 在 `cordis.yml` 中同时移除 `schedule`、`commands/schedule`、`commands/schedules` 即可整体下线定时能力。

## 多维表格任务看板（bitable-board）

ThreadPilot 可以把团队任务实时同步到飞书多维表格（Bitable）看板，也能从表格反向拉起新任务：管理者在表格里新增一行“待处理”记录并指定负责人，ThreadPilot 自动驱动对应 Bot 开工并把结果写回该记录。这是独立插件 `bitable-board`（`src/plugins/bitable-board.ts` + 数据契约 `src/core/bitable-board.ts`），在 `cordis.yml` 中移除条目或保持 `disabled: true` 即整体下线，不影响核心任务执行。

### 一键初始化（推荐）

无需手动建表与提取 `appToken/tableId`：在飞书群聊中发送 `/board init [看板名称]`，ThreadPilot 自动创建多维表格、10 个标准字段与 6 色状态枚举、看板视图，并把**初始化群绑定为反向拉起的回退群聊**（记录未填“群聊ID”也能开工），完成后持久化到 `data/bitable-board.json` 并就地热挂载，无需重启。重启后自动从缓存恢复挂载。使用 `/board link`、`/board status` 查询状态，`/board init --force` 覆盖重建。

### 前置配置

1. 在[飞书开放平台](https://open.feishu.cn/)为应用开通多维表格读写权限（`bitable:app`）。
2. 新建一张多维表格，字段按下表（也可在 `cordis.yml` 用 `fields` 覆盖字段名）：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| 任务ID | 文本 | ThreadPilot 任务标识；反向拉起的记录由系统自动回写 |
| 任务标题 | 文本 | 必填；反向拉起时作为 Bot 的任务指令 |
| 负责人(Bot) | 文本 | 必填；`config/bots.json` 中的 bot id（如 `developer`） |
| 发起人 | 文本 | 可选；发起人 open_id，用于停止按钮鉴权 |
| 当前状态 | 单选 | 待处理 / 方案确认中 / 开发中 / QA验收中 / 已完成 / 失败 |
| 轮次 | 数字 | 协作交接轮次 |
| 产物链接(文档/PR) | 文本 | 产品文档 / PR 等链接（从工具调用自动提取） |
| 消耗Token | 数字 | 任务总 Token 消耗 |
| 耗时 | 数字 | 任务耗时（毫秒） |
| 群聊ID | 文本 | 可选；反向拉起时任务执行的群聊 |
| 创建时间 / 更新时间 | 自动 | 使用多维表格系统自动字段 |

3. 在 `cordis.yml` 启用插件并填入 `appToken`、`tableId`：

```yaml
- name: bitable-board
  config:
    appToken: "你的 app_token"
    tableId: "你的 table_id"
    # botId: ""              # 调用 Bitable API 的 bot，缺省用 Team Leader
    # sync: true             # 单向事件同步（ThreadPilot ➔ Bitable）
    # pull: true             # 反向任务拉起（Bitable ➔ ThreadPilot）
    # pollIntervalMs: 30000  # 反向拉起轮询间隔
    # fallbackChatId: ""     # 记录未填“群聊ID”时的执行群聊
```

### 同步语义

- **事件同步**：监听 `task/started`、`task/tool-calls`、`task/result`、`task/failed`、`task/cancelled`、`product-spec/approved`、`qa/result`，按“任务ID”字段 Upsert 记录。状态机：开发中 →（提交产品方案）方案确认中；直接产品任务确认后进入已完成，协作任务确认后恢复开发中；QA 轮进入 QA验收中，并按结论进入已完成 / 开发中 / 失败；失败或取消任务标记“失败”。
- **队列与节流**：高频事件先进内存队列，节流窗口（默认 1.5s）内合并同一任务的状态，保留稳定标题和历史产物；Token 与耗时按运行 `traceId` 去重累计，避免 `task/result` 与 `qa/result` 重复计数。写入失败按指数退避重试（默认 3 次），Bitable API 异常不阻塞主任务与卡片响应。
- **反向拉起**：轮询（默认 30s）检测“当前状态=待处理”的记录（新建或从其他状态改回），在记录的“群聊ID”或 `fallbackChatId` 群中向负责人 Bot 发起任务，并把任务ID回写记录；启动扫描会补拉停机期间留下的待处理记录，若任务未成功进入执行链则保留待处理状态并在下轮重试。

### 验收

1. 表格中手动新增一行（任务标题、负责人、当前状态=待处理），等待一个轮询周期。
2. 对应 Bot 应在群聊中收到开工消息并开始执行，表格记录自动更新为“开发中”。
3. 任务完成后记录自动更新为“已完成”，并回填 Token、耗时、产物链接。
4. 把记录状态改回“待处理”，任务会再次拉起。
5. 在 `cordis.yml` 设置 `disabled: true` 后重启，普通任务执行不受影响。

## 多话题并行编排

ThreadPilot 可以把一个大目标拆成多个可并行的子任务，派发给不同 bot 独立执行，再用一张面板汇总进度——`orchestration` 服务插件 + `/orchestrate`、`/panel` 命令插件。

```text
/orchestrate 检查 TASK.md 里的 A、B、C 三个模块，分别让开发、审查、助理 bot 分析
→ ⏳ 正在拆解任务并派发子任务，请稍候…
→ 已创建 run-001：3 个子任务，已派发给对应成员。
  用 /panel 查看进度。
/panel
→ 编排面板：1 个运行
  run-001 · 1/3 完成
  ✅ 完成 #t1［developer］  分析模块 A …
  ⏳ 等待 #t2［product］    审查模块 B …
  ❌ 失败 #t3［assistant］  整理结论 …
```

流程与语义：

- **拆解**：编排 bot 用自己绑定的 CLI 跑一次独立规划（不复用用户会话上下文），只输出结构化子任务 JSON（`{"tasks":[{"id","prompt","bot"}]}`）；解析容错、字段经 Zod 校验，2 分钟内未返回视为拆解失败，执行时继承编排 bot 的代理配置。
- **派发方式（默认 `topic`，`same-topic` 为兼容降级）**：`cordis.yml` 的 `orchestration.dispatchMode` 决定。默认 `topic`：每个子任务构造协作交接单（`round=1`/`maxRounds=1`）经 `ctx.collaboration` 注册，再在编排所在群内发一条独立根消息（独立话题）`@` 目标 bot——同一 bot 可跨话题并行承接多个子任务，两个子任务各走各的话题、互不阻塞。`same-topic` 为兼容降级：改在当前话题 `@` 目标 bot，此时同一 bot 的多个子任务会被整轮拒绝。
- **收集**：子任务成功由 `task/result` 事件驱动为 `done` 并保存回答摘要，失败由 `task/failed` 事件驱动为 `failed`；编排交接单明确禁止 collaboration 自动回传，因此叶子结果不会逐项通知真人；面板通过 `/panel` 实时查看。
- **工作区隔离**：每个子任务使用目标 bot 自己配置的 `workspace`；不同 bot 若指向同一可写目录，整轮拒绝并要求配置独立 worktree 或改为串行任务。
- **生命周期边界**：子任务 ID 会 trim 后校验唯一性；派发接口未返回 `message_id` 会立即将子任务标记为失败并撤销交接单。同一派发尝试的重复 `task/result`/`task/failed` 事件只接受首个终态；run 默认等待结果 30 分钟，超时后未完成子任务自动标记为失败并清理交接单。
- **失败重试**：面板卡片上为 `failed` 子任务渲染「重试」按钮（可选插件 `orchestration/actions` 提供，点击重新派发、带发起人鉴权/防重复/次数上限 `maxRetry`）；也可在话题中直接 `@` 目标 bot 发送“继续执行”让目标 bot 基于已保存的原始子任务重试。移除 `orchestration/actions` 即下线一键重试（无按钮），保留手动「继续执行」。
- **插件化**：`orchestration`（服务）与 `commands/orchestrate`、`commands/panel`（命令）是独立插件，都在 `cordis.yml` 声明；移除 `orchestration` 即整体下线编排，`task/failed` 事件无监听者时自动退化为普通失败收尾。
- 拆解的目标 bot 必须已就绪（运行时存在），否则整轮拒绝并提示。

### 并行编排验收

1. 确认团队中至少两台 bot 在线（`/team` 查看连接状态）。
2. 发送 `/orchestrate 检查 package.json 和 src/index.ts，分别让开发、审查 bot 分析`。
3. 日志应出现 `[编排] run-001 创建，共 2 个子任务`，编排所在群内出现两条独立根消息（各带任务编号、独立话题，默认 `topic` 模式）。
4. 两台目标 bot 各自独立执行（可同时运行，不互相等待）。
5. 完成后发送 `/panel`，卡片显示 `2/2 完成`，各子任务带回答摘要。
6. 在 `cordis.yml` 中移除 `commands/orchestrate`、`commands/panel`、`orchestration` 后重启，现有任务与协作链路仍正常。

### 会话整理与历史恢复验收

在一个已经完成过任务的话题中依次发送：

1. `/new`：收到绿色“新会话已就绪”卡片；下一条任务会建立新 CLI 会话，旧记录仍可恢复。
2. `/resume`：卡片只列出当前 `workspaceDir` 的原生会话，显示标题、更新时间和短 ID；点击“恢复”后当前记录标记为当前会话。
3. `/compact 保留架构决定和待办事项`：蓝色卡片显示整理进度，完成后变为绿色；CLI 会话 ID 保持不变。短 Claude 会话会显示“暂时无需整理”。

按钮回调会重新读取当前工作目录并校验 CLI 会话 ID，历史记录被删除或移出目录后不会被恢复。整理和恢复期间仍遵守单话题单任务状态，发起人可以使用停止按钮取消 compact。

### 工作目录验收

启动 `pnpm start` 后，在 bot 的新话题依次发送：

```text
@机器人 /cd
@机器人 /cd ../another-project
@机器人 /status
```

`/status` 应显示新的绝对工作目录，CLI 会话应为“尚未建立”；下一条任务会在新目录启动。另一个话题或另一台 bot 的 `/status` 应继续显示各自目录。对不存在的目录执行 `/cd` 时会提示错误，原目录不会改变；执行中的任务切换会被拒绝。

如果任务仍在执行，`/close` 会通过 `AbortController` 终止后台 CLI 子进程，并且不会写入绿色成功终态或回复最终答案。关闭后在同一话题发送普通消息，只会收到“请新开一个话题”的提醒。

建议按以下顺序验证：

1. 新话题发送任务，日志显示 `[会话] 新建 ... status=creating`
2. 任务完成后日志显示相同 ID 的 `status=idle`
3. 同一话题继续发送任务，日志显示 `[会话] 复用`
4. 执行中发送普通消息，收到忙碌提示
5. 发送 `/status` 和 `/help` 检查命令回复
6. 新任务执行中发送 `/close`，日志出现 `[CLI] 任务已取消 engine=...`
7. 关闭的话题继续发送消息，收到新开话题提示
8. 新开话题后应得到不同的会话 ID，并能正常完成任务

## OWNER_OPEN_ID

自己发送一条消息后，把日志中 `sender=` 后面的 `ou_` 值写入 `.env`：

```dotenv
OWNER_OPEN_ID=ou_你的OpenID
```

后续需要点名提醒真人时，可以发送飞书的 `at` 标签：

```typescript
await bot.reply(
  message.messageId,
  `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`,
);
```

暂时不需要申请“获取群信息”权限；等需要枚举群成员时，再使用群成员列表接口。
