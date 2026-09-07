---
layout: home

hero:
  name: "ThreadPilot"
  text: "在飞书话题里，指挥你的 AI 编程团队"
  tagline: "常驻后台连接飞书长连接，为每个话题拉起独立 CLI（Codex / Claude Code / DimAgent / Antigravity），流式卡片实时回传，手机电脑多端同步。"
  image:
    src: /logo.svg
    alt: ThreadPilot Logo
  actions:
    - theme: brand
      text: 5 分钟快速上手 →
      link: /guide/getting-started
    - theme: alt
      text: 飞书应用配置
      link: /guide/feishu-setup
    - theme: alt
      text: 团队协作流程
      link: /guide/team-agents

features:
  - icon: 💬
    title: 话题即隔离会话
    details: 在飞书话题群中 @机器人 提交任务，自动保持上下文连贯；不同话题独立隔离，随时追问或新建会话。
  - icon: 🎛️
    title: 实时流式卡片
    details: 每轮执行原样回传工具轨迹、命令输出、运行耗时与 Token 消耗，发起人可在卡片上随时停止任务。
  - icon: 👥
    title: 虚拟产研协作
    details: 支持配置多台不同职责的 Bot（助理、产品、开发、QA），由 Team Leader 统一派发任务并汇总各阶段结果。
  - icon: ⏱️
    title: 定时任务与看板
    details: 用自然语言配置周期巡检任务，一键初始化飞书多维表格看板，自动双向同步任务生命周期。
  - icon: 🔌
    title: 一切皆为插件
    details: 基于 Cordis 插件架构，执行引擎、平台、斜杠命令与协作逻辑完全解耦，通过 cordis.yml 声明式启用。
  - icon: 🔒
    title: 内网安全与鉴权
    details: 基于 WebSocket 长连接接收事件，无需公网 IP 与 Webhook；内置严格发起人鉴权，防止多人协同越权。
---
