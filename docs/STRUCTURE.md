# 目录结构与设计决策

## 源码布局

```
src/                          TypeScript 源码（strict；唯一手写源，根目录只留 index.ts）
  index.ts                    组合根：createApp → 安装各模块 → boot
  kernel/                     内核：公共接口、宿主边界与功能设施
    app.ts                      App 原语 + 六域 slices（runtime/sessions/ui/ext/trans/agent）
    types.ts                    共享类型：SessionEvent 判别联合 + 宿主服务结构
    ext-types.ts                扩展 API 公共类型契约
    rpc.ts                      nvim 通知注册表（dsh-* 方法）
    host-events.ts              宿主事件注册表（agent/status、subagent/*、workflow/*、审批/提问）
    lifecycle.ts               退出诊断 / teardown / quit
    headless.ts                 headless e2e（dump 看门狗 / kick）
    bridge.ts                   nvim spawn / socket 连接
    i18n.ts                     界面字典（zh/en）
    difficulty.ts               难度路由（规则 / LLM 定档、切换与恢复）
    vision.ts                   识图模型选型
    todo-guard.ts               待办清单纪律守卫
    theme-presets.ts            主题预设表
    change-ledger.ts            会话级文件改动账本
    approval-log.ts             审批历史落盘
    profile.ts / apikey.ts / subagent-clean.ts / session-health.ts / plugin-toggle.ts …
  feed/                       渲染公共层（只依赖 kernel）
    feed.ts                     transcript 渲染与流式增量更新
    table.ts                    GFM 表格框线 / 折行
    diff.ts                     文件 diff 计算与渲染
    stats.ts                    状态栏统计
    images.ts                   图片附件
    whale*.ts                   蓝鲸背景
  boot/                       运行期组合层
    boot.ts                     spawn / 连接 + 三条薄循环 + boot 序列（无行为分支）
    session-events.ts           session/event 管线（扩展镜像 → 子代理路由 → 按类型 hook）
    onboarding.ts               首次启动引导
  commands/                   消息发送 + 输入路由 + 命令系统
    index.ts                    本域命令装配 + 核心服务槽位（其余命令由各域 index 安装）
    core.ts                     followup/send/onInput/onCommand/@ 补全/模型切换 + 通知 + tui_command 工具
    nlcmd.ts                    自然语言命令路由（精确短语 → 命令）
    commands/                   45 个命令文件（一命令一文件，自注册）
  sessions/                   会话域（生命周期 / fork / 偏好持久化 + 10 个命令）
  subagents/                  子代理域（目录 / 对话窗）
  transcript/                 转录域（修复 / 事件访问 / workflow + 4 个命令）
  statusline/                 状态栏域（渲染 / 折叠统计 + 4 个命令）
  ext-api/                    EXT-API 实现（dsh-ext 总线 / 卡片 / 面板 / region）
  deps/                       依赖体检（/deps）
  market/                     插件市场与热启停（/market、/plugin）
lib/                          tsc 编译产物（.js + .d.ts；dsh 加载入口）
nvim/lua/dsh_tui/             nvim 侧 UI（19 个按职责拆分的 Lua 模块）
  init.lua                    公共门面 + 跨模块编排 + start()
  state.lua                   共享可变状态（窗口 / buffer 句柄唯一来源）
  api.lua                     EXT-API Lua 面（register / 浮窗 / 面板 / region / 总线 / 快照）
  layout.lua                  窗口布局、输入窗家具、启动接管、布局预设
  input.lua                   输入 buffer（文本、动态高度、历史、焦点）
  cmd_menu.lua / at_menu.lua  `/` 与 `@` 补全浮窗
  session.lua                 会话 buffer、思考面板、set_active
  keymaps.lua                 输入键位
  autocmds.lua                自愈 / 窗口归属 / 插件隔离 / 启动守卫
  highlight.lua               DshTui* 高亮组 + treesitter 代码块着色
  statusline.lua              聊天状态栏 + 终端标题（OSC 2）
  popup_core.lua / popups.lua 通用与专用浮窗
  subagent_chat.lua           子代理对话窗
  full_input.lua              <C-e> 全屏输入
docs/                         文档（本文件 + COMMANDS / CONFIG / EXT-API / ARCHITECTURE / 审计报告）
examples/                     示例插件（examples/nvim/git-panel.lua、examples/dsh-plugin/）
scripts/                      门禁与测试
  smoke.ts                    无头冒烟（RPC 往返 + Lua 插件 + 事件渲染）
  check-arch.mjs              架构边界守卫（App kernel-only / slice 白名单 / 跨域写）
  app-ops-check.mjs           域操作注入运行时守卫
  e2e.ts                      真模型端到端回归
  i18n-check.mjs              i18n 漂移报告
cordis.patch.yml              bundle patch：insert nvim-tui-runner 行
```

## 关键设计决策

- **不用 `nvim --embed`**：它会隐式 headless，网格渲染就得自己做。这里正常启动
  nvim，用 `--listen` socket 驱动，内置 TUI 负责终端渲染。
- **默认加载用户配置**：`-u NONE` 只是开关；dsh_tui 在 `VimEnter` 后接管布局。
  headless / 沙箱模式通过隔离 XDG 目录得到干净环境。
- **runner 行的 disposer 只拆 UI 不退出进程**：HMR 重载该行时 dsh 继续运行，下一
  次 apply 会 spawn 新的 nvim；只有主动退出、nvim 退出、致命错误或信号才走
  `appExit`。
- **消息只从 `session/event` 渲染**（不本地回显），避免与转录重复。
- **命令一命令一文件 + 自注册**：命令目录与 `/help`、补全、分发表共用同一注册表。
- **TypeScript 源码 → 编译产物**：`src/*.ts` 经 tsc（strict）输出 `lib/`，dsh 按
  npm 包入口加载；`.ts` 不能直接作 node_modules 入口（Node 拒绝 type-stripping）。
  `scripts/` 用 Node ≥23.6 原生 type-stripping 直跑，不进发布包。
- **类型严格性拉满**：`strict` + `noUnusedLocals/Parameters` +
  `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` +
  `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `noImplicitOverride` +
  `noFallthroughCasesInSwitch` + `noImplicitReturns` + `allowUnreachableCode` /
  `allowUnusedLabels: false`；宿主边界用条件展开表达「缺省 ≠ 显式 undefined」。
- **EXT-API 是稳定面**：`ctx.get('nvim-tui')`（Node）与 `require('dsh_tui').api`
  （Lua）有版本承诺；`M.*` 其余门面是内部接口。详见 [EXT-API.md](./EXT-API.md)。

## 门禁

`npm run check` = 双 tsconfig 类型检查 + `check-arch.mjs`（架构边界）+
`app-ops-check.mjs`（域操作注入断言）。`npm run smoke` 覆盖 RPC 往返、Lua 插件与
事件渲染；`npm run e2e` 用真模型跑一轮并校验转储。发布前 `prepublishOnly` 会依次
跑 check → build → smoke。
