# dsh-tui-ext-example —— Node 侧 dsh 扩展示例

演示一个 dsh 插件如何通过 `ctx.get('nvim-tui')` 消费 TUI 开放接口：
状态栏段、斜杠命令、会话事件订阅、卡片、面板，以及与 nvim 侧插件互调
（dsh-ext 总线）。

安装（在 profile 的 `cordis.patch.yml` 里 `insert` 本插件，并保证
`dsh-nvim-tui` 也在 bundle 列表）：

```yaml
- insert:
    - id: tui-ext-example
      name: 'dsh-tui-ext-example'
```

> 本目录是**参考源码**，不参与主仓库编译（examples 不在 tsconfig 范围内）。
> 正式开发请以 npm 包方式发布；类型通过
> `import type { TuiExtApi } from 'dsh-nvim-tui'` 获取（结构类型，无需运行时依赖）。

## 文件

- `index.ts` —— 插件主体（含全部注释说明）
- `cordis.patch.yml` —— 挂载补丁
- `package.json` —— 最小包描述

## 它做了什么

1. `tui.on('tui:ready')` 后：
   - `ui.statuslineSegment('ext-demo', '⎇ demo')` 在状态栏加一段；
   - `registerCommands('/ext:ping')` 挂斜杠命令（进 / 补全目录）；
   - `onSessionEvent({ type: 'turn/end' })` 每个回合结束发 notice。
2. `/ext:card` 渲染一张可更新卡片；`/ext:panel` 打开右缘面板槽。
3. `luaExt.on('git-panel', ...)` 应答 nvim 侧插件的 `api.rpc_call`；
   `luaExt.emit('git-panel', 'refresh')` 反向驱动 nvim 插件
   （配合 `examples/nvim/git-panel.lua` 使用）。
