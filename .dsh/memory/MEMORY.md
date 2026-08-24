# dsh-nvim-tui 记忆索引

| harness 服务形状以真实 d.ts/运行实例为准 | 宿主服务接口先读 node_modules lib/types/*.d.ts，再真跑验证 |
| cordis ctx 属性访问需 inject，未声明直接崩 | 未 inject 的服务一律走 ctx.get('name') |
| 通知分发必须兜 try/catch | 命令抛异常 = unhandled rejection = 整个 dsh 退出 |
| 批量正则改写模板字面量会静默损坏嵌套反引号 | 嵌套反引号模板禁止正则批量包函数 |
