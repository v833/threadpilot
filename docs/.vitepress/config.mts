import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "ThreadPilot",
  description: "在飞书话题里，指挥你的 AI 编程团队",
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'ThreadPilot',
    nav: [
      { text: '首页', link: '/' },
      { text: '快速上手', link: '/guide/getting-started' },
      { text: '配置指南', link: '/guide/feishu-setup' },
      { text: '使用手册', link: '/guide/user-manual' },
      { text: '团队协作', link: '/guide/team-agents' },
      { text: '命令大全', link: '/guide/commands' }
    ],
    sidebar: [
      {
        text: '新手指南',
        items: [
          { text: '产品介绍与架构', link: '/guide/what-is-threadpilot' },
          { text: '5 分钟快速上手', link: '/guide/getting-started' }
        ]
      },
      {
        text: '配置与环境',
        items: [
          { text: '飞书应用创建与配置', link: '/guide/feishu-setup' },
          { text: '配置文件全景字典', link: '/guide/configuration' },
          { text: '执行引擎接入指南', link: '/guide/engines' }
        ]
      },
      {
        text: '日常使用与协作',
        items: [
          { text: '基础使用说明书', link: '/guide/user-manual' },
          { text: '团队 Bot 协同工作流', link: '/guide/team-agents' },
          { text: '斜杠命令全解析', link: '/guide/commands' },
          { text: 'CLI 登录与认证', link: '/guide/login' }
        ]
      },
      {
        text: '高级场景功能',
        items: [
          { text: '定时任务与自动化', link: '/guide/schedule' },
          { text: '飞书多维表格看板', link: '/guide/board' },
          { text: '多话题并行编排', link: '/guide/orchestration' },
          { text: '可观测性与 Trace 大盘', link: '/guide/observability' }
        ]
      },
      {
        text: '运维与排错',
        items: [
          { text: '常见问题与故障排查', link: '/guide/faq' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/v833/threadpilot' }
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 ThreadPilot Team'
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    }
  }
})
