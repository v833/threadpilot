/**
 * PM2 持久化运行配置。
 *
 * 用法(通过 package.json 的 pm2:* 脚本,依赖全局安装的 pm2):
 *   pnpm pm2:start     启动机器人(崩溃自动重启、日志写入 data/pm2/)
 *   pnpm pm2:status    查看运行状态
 *   pnpm pm2:logs      实时查看日志
 *   pnpm pm2:restart   重启(发版部署新代码后)
 *   pnpm pm2:stop      停止
 *   pnpm pm2:delete    从 pm2 移除
 *   pnpm pm2:save      保存进程快照(开机自启前必须执行一次)
 *
 * 开机自启(Windows):
 *   pm2 在 Windows 上不原生支持 `pm2 startup`,需先 `pnpm pm2:save`
 *   保存进程快照,再用「任务计划程序」新建登录时触发的任务运行
 *   `pm2 resurrect` 恢复进程。详见 README 的 PM2 一节。
 */
module.exports = {
  apps: [
    {
      name: "threadpilot",
      // 必须在项目根:程序用 process.cwd() 定位 cordis.yml 与 .env
      cwd: __dirname,
      // 等价 `pnpm start:once`(tsx 直跑 TS 源码),不带文件监听
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      instances: 1,
      exec_mode: "fork",
      watch: false, // 常驻服务不随代码改动自动重启,发版后手动 pm2:restart
      autorestart: true, // 崩溃自动重启
      max_restarts: 10,
      restart_delay: 3000,
      min_uptime: "10s",
      kill_timeout: 10000, // 给 cordis 停机收尾留足时间
      time: true, // 日志行带时间戳
      out_file: "data/pm2/stdout.log",
      error_file: "data/pm2/stderr.log",
      merge_logs: true,
    },
  ],
};
