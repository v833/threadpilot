# 配置文件全景字典

ThreadPilot 的配置由三个文件协同管理，职责明确、凭据隔离：

1. **`.env`**：存储敏感密钥（飞书 App Secret）、网络代理及全局环境变量（Git 自动忽略，禁止提交）。
2. **`config/bots.json`**：定义团队成员、各 Bot 绑定的 CLI 引擎、工作目录、角色职责与协作关系。
3. **`cordis.yml`**：插件装配文件，声明系统启用的插件列表与参数。

---

## 一、`.env` 环境变量配置

在项目根目录下创建 `.env` 文件。支持以下环境变量：

### 1. 飞书凭证（按 Bot 隔离）

每个在 `config/bots.json` 中声明的 Bot，都需要一对对应的 App ID 与 App Secret：

```dotenv
# 开发工程师凭据
FEISHU_DEVELOPER_APP_ID=cli_a1b2c3d4e5f6
FEISHU_DEVELOPER_APP_SECRET=xxxxxxxxxxxxxxxxxxxx

# QA 工程师凭据（可选）
FEISHU_QA_APP_ID=cli_b2c3d4e5f6a1
FEISHU_QA_APP_SECRET=yyyyyyyyyyyyyyyyyyyy

# 产品经理凭据（可选）
FEISHU_PRODUCT_APP_ID=cli_c3d4e5f6a1b2
FEISHU_PRODUCT_APP_SECRET=zzzzzzzzzzzzzzzzzzzz

# CEO 助理凭据（可选）
FEISHU_ASSISTANT_APP_ID=cli_d4e5f6a1b2c3
FEISHU_ASSISTANT_APP_SECRET=wwwwwwwwwwwwwwwwwwww
```

### 2. 真人管理员与点名通知

```dotenv
# 你的飞书 OpenID（以 ou_ 开头）
# 发送任意消息给 Bot，控制台打印的 sender= 后的值即为你的 OpenID
OWNER_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxxxxxx
```
> 配置后，当 Bot 遇到严重阻塞、方案确认或任务全部收口时，会在飞书群中精准 `@` 真人管理员。

### 3. 全局网络代理

对于需要翻墙访问云端大模型 API 的 CLI 引擎（如 Claude Code、Gemini/Antigravity 等），可在 `.env` 中配置全局代理：

```dotenv
HTTP_PROXY=http://127.0.0.1:10808
HTTPS_PROXY=http://127.0.0.1:10808
ALL_PROXY=http://127.0.0.1:10808
NO_PROXY=localhost,127.0.0.1,::1
```
- 所有启动的子进程 CLI 会自动继承这些环境变量。
- 若某个 Bot 需要走不同代理通道，可在 `config/bots.json` 的对应 bot 项中配置专属 `proxy` 覆盖。

### 4. 任务超时控制（可选）

```dotenv
# 全局单轮任务超时时间（毫秒），默认 30 分钟
CLI_TIMEOUT_MS=600000

# 针对特定引擎的超时（优先于全局配置）
CODEX_TIMEOUT_MS=300000
CLAUDE_TIMEOUT_MS=600000
```

---

## 二、`config/bots.json` 团队角色配置

复制配置模板即可开始修改：
```powershell
Copy-Item config/bots.example.json config/bots.json
```

### 配置结构示例

```json
{
  "teamLeader": "developer",
  "defaultProductDeliveryMode": "local",
  "bots": [
    {
      "id": "developer",
      "appIdEnv": "FEISHU_DEVELOPER_APP_ID",
      "appSecretEnv": "FEISHU_DEVELOPER_APP_SECRET",
      "defaultCli": "codex",
      "accessMode": "headless",
      "workspace": ".",
      "role": "开发工程师，负责理解需求并编写代码，支持单元测试",
      "systemPrompt": "你是团队主力开发，专注以最简、可维护的代码解决问题；团队协作任务完成后把结果交回 Team Leader，用户直接 @你的独立任务则直接向用户交付。",
      "collaborationMaxRounds": 16,
      "enabled": true
    },
    {
      "id": "qa",
      "appIdEnv": "FEISHU_QA_APP_ID",
      "appSecretEnv": "FEISHU_QA_APP_SECRET",
      "defaultCli": "codex",
      "accessMode": "headless",
      "workspace": ".",
      "role": "QA 测试工程师，负责执行构建、测试与代码 review",
      "systemPrompt": "执行一次质量 review；团队协作任务完成后把测试证据与结构化缺陷交回 Team Leader，用户直接 @你的独立任务则直接向用户交付。",
      "enabled": true
    }
  ]
}
```

### 顶层参数字典

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| `teamLeader` | string | **是** | - | 团队负责人（必须是 `bots` 列表中存在的稳定 `id`），只有 Leader 拥有向其他成员调用 `dispatch_task` 派发任务的权限。 |
| `defaultProductDeliveryMode` | string | 否 | `"local"` | 产品方案默认交付形态：`"local"`（本地 Markdown 真实落盘到 `.scratch/`）或 `"lark-doc"`（自动创建飞书云文档）。 |

### `bots[i]` 成员对象参数字典

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| `id` | string | **是** | - | 成员唯一稳定标识（如 `developer`, `qa`, `product`, `ceo-assistant`）。 |
| `appIdEnv` | string | **是** | - | 指向 `.env` 中 App ID 的环境变量名。 |
| `appSecretEnv` | string | **是** | - | 指向 `.env` 中 App Secret 的环境变量名。 |
| `defaultCli` | string | **是** | - | 默认执行引擎：`"codex"`, `"claude"`, `"dimagent"`, `"agy"` 或自定义 ACP 引擎 ID。 |
| `accessMode` | string | 否 | `"headless"` | CLI 接入模式：`"headless"`（命令行子进程）或 `"acp"`（标准 Agent Client Protocol 通道）。 |
| `workspace` | string | 否 | `"."` | 默认工作区路径，可以是当前工程相对路径或绝对路径（如 `D:/projects/my-web`）。 |
| `role` | string | **是** | - | 成员的一句话职责说明，不仅会在飞书 `/team` 卡片展示，还会作为团队上下文注入协作提示词。 |
| `systemPrompt` | string | 否 | `""` | 成员专属的系统设定，会优先注入每轮任务的提示词流水线中。 |
| `skills` | string[] | 否 | `[]` | 必须遵守的项目技能列表（如 `["grill-me"]`），任务启动前会自动查找并加载技能定义。 |
| `collaborationMaxRounds`| number | 否 | `16` | 协作最大轮次限制（1~32），防止多 Bot 互相调用陷入死循环。 |
| `proxy` | string | 否 | - | 成员专属代理 URL（如 `http://127.0.0.1:10808`），配置后覆盖 `.env` 中的全局代理。 |
| `enabled` | boolean | 否 | `true` | 是否启用该 Bot。设为 `false` 则启动时跳过该 Bot，不建立长连接也不占用资源。 |

---

## 三、`cordis.yml` 插件装配文件

ThreadPilot 的全部能力均以插件形式挂载在根 Context 上。你可以通过编辑 `cordis.yml` 声明启用哪些插件。

### 常用装配选项示例

```yaml
plugins:
  # 核心服务
  - name: config
    config:
      botsPath: config/bots.json
  - name: sessions
  - name: cli

  # 启用的执行引擎插件
  - name: engines/claude
  - name: engines/codex
  - name: engines/dimagent
  - name: engines/agy
  - name: engines/grok

  # 平台与通信
  - name: lark
  - name: cards

  # 斜杠命令插件（需要什么命令就留什么）
  - name: commands
  - name: commands/help
  - name: commands/new
  - name: commands/resume
  - name: commands/compact
  - name: commands/status
  - name: commands/team
  - name: commands/cd
  - name: commands/close
  - name: commands/schedule
  - name: commands/schedules

  # 高级协作与编排
  - name: collaboration
  - name: orchestration
    config:
      dispatchMode: topic      # 子任务派发模式：topic（独立话题，推荐）或 same-topic
      maxRetry: 2              # 失败子任务最大重试次数
      pendingTimeoutMs: 1800000 # 运行超时时间（毫秒，默认30分钟）
  - name: orchestration/live-panel
  - name: orchestration/actions

  # 任务编排与定时
  - name: tasks
  - name: schedule
  - name: router
```

> **修改即生效**：在 `pnpm start`（开发模式）下，编辑 `cordis.yml`、`.env` 或 `config/bots.json` 会自动触发热重载，无需手动重启。
