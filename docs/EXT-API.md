# dsh-nvim-tui 插件开放接口（EXT-API）

本插件对外提供两套**稳定**接口，供其他 dsh 插件与 nvim 插件在 TUI 内渲染 UI、使用
nvim 窗口、读写输入、订阅会话事件：

| 面 | 消费者 | 入口 | 版本 |
|---|---|---|---|
| Node 面 | 其他 dsh 插件（TS/JS，cordis 插件） | `ctx.get('nvim-tui')` | `EXT_API_VERSION`（lib/index.d.ts 导出） |
| Lua 面 | TUI 实例内的 nvim 插件（用户配置里加载） | `require('dsh_tui').api` | `api.version` |

`require('dsh_tui')` 的其余 `M.*` 门面是**内部接口**（runner + smoke 测试专用），
不做稳定性承诺；`src/app.ts` 的 App 字段同理。

## 一、总体模型

```
dsh 插件 ──ctx.get('nvim-tui')──▶ TuiExtApi（本包导出）
   │                                    │
   │  luaExt.call/emit/on               │  nvim.request/call/lua/ex
   ▼                                    ▼
 nvim 实例 ◀── 唯一 msgpack-RPC 通道 ──▶ dsh_tui.api（Lua 面）
   ▲                                    ▲
   │  rpc_call（vim.rpcrequest）        │  ui.card/float/panel/picker…
用户 nvim 插件（require('dsh_tui').api）
```

原则：

1. **唯一通道**：不新开 socket/进程，全部复用现有 RPC 通道，天然串行化。
2. **注册制所有权**：扩展窗口/缓冲/面板必须经 `api.register` / `api.float_open` /
   `api.panel_claim` 登记；登记资源被所有权/自愈层放行，未登记窗口维持严管
   （启动守卫会关掉它们）。
3. **故障隔离**：所有扩展回调都被 guard 包裹 —— 抛错进 feed notice + 错误日志，
   绝不让扩展拖垮 TUI 事件循环。
4. **能力协商**：Node 侧 `capabilities()`；headless 模式下 UI 原语安全降级
   （`ui.panel` 返回 null，卡片落入 dump）。
5. **句柄再解析**：自愈层会重建窗口，缓存原始 window/buffer id 会失效 —— Lua 侧
   一律用 `api.handles()` 重新解析；窗口被外力关闭时收到
   `User DshTuiExtWindowClosed`。

## 二、Node 面 API（`ctx.get('nvim-tui')`）

服务名 **`'nvim-tui'`**（发布后冻结，改名成本极高）。消费方用结构类型
（`import type { TuiExtApi } from 'dsh-nvim-tui'`），运行时 duck-typing，无需
运行时依赖本包。

```ts
const tui = ctx.get('nvim-tui') as TuiExtApi | undefined
if (!tui) return          // nvim-tui 未挂载（如 headless 宿主）
await tui.ready           // boot 完成（nvim 已连接、首个会话已建立）
```

### 2.1 原生执行层 `tui.nvim`

```ts
await tui.nvim.request('nvim_buf_get_lines', [buf, 0, -1, false])  // nvim_* API
await tui.nvim.call('expand', ['%'])                                // vim.fn
await tui.nvim.lua('return vim.o.columns', [])                      // 任意 Lua（逃生舱）
await tui.nvim.ex('edit ' + fnameescape(path))                      // vim.cmd
// request 可带超时（超时只 reject，nvim 端继续执行 —— 调用需幂等安全）:
await tui.nvim.request('nvim_eval', ['slow()'], { timeoutMs: 2000 })
```

纪律：**扩展回调内禁止长时同步 `nvim.request`**（单通道串行，会卡死整个 TUI
渲染）。**dsh-ext 处理器（`luaExt.on` 的回调）**的语义：
- 处理器内可以安全做嵌套 nvim 调用（nvim 阻塞在 `vim.rpcrequest` 期间仍会
  处理事件，嵌套请求会被正常应答）；
- 但**处理器时长 = nvim UI 冻结时长**，且 runner 有 30s 超时兜底（
  `EXT_HANDLER_TIMEOUT_MS`，`luaExt.on(extId, fn, { timeoutMs })` 可调）——
  超时后给调用方回结构化错误，处理器在后台继续跑完、结果被丢弃。长任务请
  用后台 job + `luaExt.emit` 事件回推。

### 2.2 UI 原语层 `tui.ui`

```ts
// 卡片：渲染进指定会话 feed，可原地更新/关闭（headless 落入 e2e dump）。
// 带 onAction 时动作可交互：光标停在卡片上按 1-9 直接触发，Enter 弹动作
// 选择浮窗（仅主会话 chat 窗口）。注意：数字键是 chat 缓冲的显式映射，
// 会吃掉普通移动的 count 前缀（如 5j 会先触发 5 → 卡片处无效则 j 只移 1 行）。
const card = tui.ui.card({
  sessionId: tui.getActiveSessionId()!,  // 省略 = 当前活跃会话
  plugin: 'dsh-git', title: '分支清理', body: '已删除 3 个合并分支',
  actions: [{ label: '确认', value: 'yes' }, { label: '详情', value: 'detail' }],
  onAction: (value) => tui.ui.notice('选择了 ' + value),
  ttlMs: 8000,                                   // 可选自动消失
})
card.update({ body: '重新扫描完成' })
card.dismiss()

// 受管浮动窗口（登记制，boot 守卫放行；q/Esc 关闭）
const f = await tui.ui.float({ lines: ['日志行 1', '日志行 2'], title: '安装进度' })
await tui.nvim.request('nvim_buf_set_lines', [f.buf, 0, -1, false, ['新日志']])
await tui.ui.floatClose(f.id)

// 复用 TUI 选择器
const pick = await tui.ui.picker({ title: '选择会话', items: [{ label: 'A', value: 'a' }] })

// 瞬态通知 + 状态栏段
tui.ui.notice('操作完成')
tui.ui.statuslineSegment('git-badge', '⎇ main', 50)   // 优先级排序，'' 移除

// 面板列（多面板并发）：每个 extId 一块，按 claim 顺序自上而下堆叠在
// 右缘（side:'left' 可选）；height 显式行数，否则按权重分摊剩余预算；
// reasoning 面板打开时排到列底。Node 侧 '__node__' 同一时刻持有一块
// （重复 claim 返回 null + notice）。
const p = await tui.ui.panel({ title: 'Git 面板', width: 52, lines: ['…'] })
// 写内容: nvim_buf_set_lines(p.buf, …)（buffer 保持可写、编辑键已 Nop）
await tui.ui.panelRelease()
```

### 2.3 事件 / 会话 / 命令

```ts
const off = tui.on('tui:active-session', (payload) => { /* { id } */ })
const off2 = tui.onSessionEvent(
  { type: ['turn/end', 'tool/result'], sessionId: undefined },
  (sessionId, ev) => { /* 实时事件 + 历史回放 */ })
off(); off2()

// 一次性生命周期事件（tui:ready / tui:active-session）晚订阅自动补发，
// boot 之后注册的消费者不会错过。
const off3 = tui.on('tui:ready', () => tui.ui.notice('TUI 已就绪'))

tui.getActiveSessionId()      // string | null
tui.submit('帮我检查这个仓库')  // 走输入框提交路径
tui.insertInput('/sessions ') // 只填入不提交

// 斜杠命令（名字不带 '/'）：进入 / 补全目录与 /help；重名被拒绝
const offCmd = tui.registerCommands([{
  name: 'git:log', desc: '最近提交', group: '扩展',
  fn: async (arg) => { tui.ui.card({ plugin: 'dsh-git', title: 'log', body: '…' }) },
}])
offCmd()  // 注销
```

### 2.4 扩展总线 `tui.luaExt`（与 nvim 插件互调）

```ts
// 调 nvim 插件注册的方法（api.rpc_register）；失败 reject 远端错误，
// 超时（默认 30s，opts.timeoutMs 可调）reject timeout 错误
const v = await tui.luaExt.call('git-panel', 'currentBranch')
// 发事件给 nvim 插件（User DshTuiExtEvent + api.on_ext_event 回调）
tui.luaExt.emit('git-panel', 'branch-changed', { branch: 'main' })
// 应答 nvim 插件发来的 vim.rpcrequest；每条请求保证在 timeoutMs 内得到
// 应答（超时回结构化错误，处理器后台继续、结果丢弃）
const offRpc = tui.luaExt.on('git-panel', async (method, args) => {
  if (method === 'commits') return [{ hash: 'abc' }]
  throw new Error('unknown method: ' + method)
}, { timeoutMs: 10_000 })
```

### 2.5 TuiExtApi 类型摘要

```ts
export interface TuiExtApi {
  version: string
  ready: Promise<void>
  capabilities(): Record<string, boolean>        // headless/card/float/picker/panel/rpc
  nvim: { request; call; lua; ex }
  ui: { card; float; floatClose; picker; notice; statuslineSegment; panel; panelRelease }
  on(event: ExtEventName, cb): () => void
  onSessionEvent(filter, cb): () => void
  getActiveSessionId(): string | null
  submit(text): void
  insertInput(text): void
  registerCommands(cmds): () => void
  luaExt: { call; emit; on }
}
```

## 三、Lua 面 API（`require('dsh_tui').api`）

TUI 默认加载用户配置（`loadUserConfig !== false`），因此用户自己的 nvim 插件
天然运行在 TUI 实例内。`dsh_tui.api` 是**唯一**稳定面。

```lua
local api = require('dsh_tui').api
local ok, err = api.register {
  id = 'git-panel',            -- 必填，^[%w_%.-]+$；重复注册被拒
  name = 'Git 面板',
  version = '1.0.0',
  events = { 'turn/end' },     -- 订阅镜像会话事件（省略 / {} / 'all' / 含 'all' = 全部）
  on_ready = function(reg, p) end,            -- 晚加载对齐：TUI 已启动时注册即刻同步调用
  on_active_session = function(reg, p) end,   -- 同上，载荷 { id }
}
if not ok then error(err) end
-- 晚加载插件的初始态快照（User 事件不重放，从这里拿 boot/会话现状）:
local snap = api.snapshot()    -- { started, attached, activeSession, runnerVersion, layoutName, chatWin, inputBuf, panelWin, … }
```

### 3.1 窗口原语（登记制）

```lua
-- 受管浮动窗口：boot 守卫放行，q/Esc 关闭（收到 User DshTuiExtWindowClosed）
local f, err = api.float_open('git-panel', {
  lines = { 'l1' }, title = '标题', relative = 'editor',
  width = 60, height = 12, row = nil, col = nil,
})
api.float_close('git-panel', f.win)

-- 面板列（多面板并发）：每个 extId 一块，按 claim 顺序堆叠；height =
-- 显式行数（默认按权重分摊）；q/Esc 释放；TUI 负责 resize 重锚定与聚焦
-- 归还；reasoning 面板打开时排到列底。
local p, err = api.panel_claim('git-panel', { side = 'right', width = 52, height = 12, title = 'Git', footer = ' q 关闭 ', lines = {} })
api.panel_release('git-panel')
```

unregister 会顺带清理该扩展注册的斜杠命令（不留死目录项）。

### 3.2 句柄 / 输入 / 事件

```lua
api.handles()            -- { chatWin, inputWin, inputBuf, reasoningWin,
                         --   panels = { [extId] = { win, buf } },
                         --   panelWin/panelBuf = 栈首面板（兼容），… }（永远现取）
api.input_get()
api.input_fill('text') / api.input_append('tail')

api.last_event()         -- 最近一次 User DshTui* 事件的载荷
                         -- （nvim_exec_autocmds 的 data 不保证进 vim.v.event，用它读）

-- User autocmd 事件一览（payload 经 api.last_event() 读取）:
--   DshTuiReady / DshTuiAttach / DshTuiActiveSession / DshTuiLayoutRebuilt
--   DshTuiShutdown / DshTuiExtRegistered / DshTuiExtWindowClosed
--   DshTuiExtEvent / DshTuiSessionEvent / DshTuiExtWindowsPruned
-- User 事件是「实时变更流」、不重放：晚加载插件（lazy.nvim VeryLazy）错过
-- DshTuiReady/Attach/ActiveSession 时，用 register 的 on_ready /
-- on_active_session 同步回调 + api.snapshot() 对齐初始态。
vim.api.nvim_create_autocmd('User', { pattern = 'DshTuiActiveSession', callback = function()
  local id = api.last_event().id
end })
```

### 3.3 钩子 / 命令 / RPC

```lua
-- 提交前钩子：返回 nil/false 否决（草稿保留），返回字符串替换提交内容
local off = api.before_submit('git-panel', function(text)
  if text == 'veto' then return nil end
  return text .. ' [via git-panel]'
end); off()

-- Lua 侧斜杠命令：本地执行（不路由到 runner），并入 / 补全目录
api.register_command('git-panel', 'gitp', '打开 git 面板', function(arg)
  api.notice('git-panel', '面板已打开')      -- 瞬态通知走 runner
end)
api.unregister_command('git-panel', 'gitp')

-- dsh-ext 总线
local branch, err = api.rpc_call('dsh-git-host', 'currentBranch')  -- 阻塞至应答
api.rpc_register('git-panel', 'currentBranch', function(args) return 'main' end)
api.on_ext_event('git-panel', function(event, payload) end)        -- Node luaExt.emit
api.on_session_event('git-panel', function(ev) end)                -- 镜像会话事件
```

## 四、dsh-ext 总线协议

单一方法名多路复用（避免 nvim 通知方法名随插件膨胀）：

```
Lua → Node: vim.rpcrequest(S.channel, 'dsh-ext', { v = 1, id = extId, method, args })
Node → Lua: runner 调 api.rpc_dispatch(extId, method, args) / api.rpc_event(...)
```

- 应答统一为 `{ ok = true, value }` / `{ ok = false, error }`；**任何请求必有
  有界应答**（未注册 extId / 处理异常 / 处理器超时都回错误，默认上限
  `EXT_HANDLER_TIMEOUT_MS` = 30s）—— `vim.rpcrequest` 阻塞 nvim 且**不可从
  Lua 取消**，有界应答是唯一的冻结防护；超时后处理器在后台继续、结果丢弃。
- extId 路由表：Node 侧 `tui.luaExt.on` 注册（可带 `{ timeoutMs }`），Lua 侧
  `api.rpc_register` 注册。
- 卡片激活（通知，非请求）：chat 光标停在交互卡片上时，Lua 侧
  `rpcnotify('dsh-ext-card-activate', { mark, action })` —— `action` 为数字
  时直接触发第 N 个动作，缺省时 runner 弹动作选择浮窗后回填索引。
- TUI teardown / 插件 unregister 时双向拒掉在途请求，广播 `DshTuiShutdown`。

## 五、兼容性与版本策略

- **服务名 `'nvim-tui'`、`dsh-ext` 协议 `{ v = 1, … }`、`dsh_tui.api` 表名**发布后冻结。
- `EXT_API_VERSION` / `api.version` 采用 semver；**boot handshake**：runner 在
  attach 后调用 `api.handshake(EXT_API_VERSION)` 比对主版本，不匹配时 boot
  notice 提示（`扩展接口握手失败/版本不匹配`）。
- 弃用策略：稳定面字段只增不改；确需破坏时先加新名、旧名保留一个 minor 版本
  并在 notice 中提示。
- **不承诺兼容**：`require('dsh_tui').M.*` 其余字段、`src/app.ts` 的 App、所有
  `dsh-*` 内部通知、`S._*` 状态字段。
- 能力语义：`capabilities()` 的 `card/float/picker` 在 headless 下同样可用
  （内容落 e2e dump，便于测试）；`panel` 在 headless 下被禁用并返回 null。

## 六、信任模型

扩展与 TUI 同信任域（本就能写文件、跑命令），**不做权限沙箱**，只做故障隔离
（guard + 超时 + 错误日志带 extId）与生命周期管理（teardown 时关窗拒流）。

## 七、示例

- Node 侧 dsh 插件：见 [`examples/dsh-plugin/`](../examples/dsh-plugin/)（状态栏段 +
  命令 + 会话事件订阅 + 与 nvim 插件互调）。
- nvim 侧插件：见 [`examples/nvim/git-panel.lua`](../examples/nvim/git-panel.lua)
  （注册 + 面板槽 + before_submit + rpc）。

## 八、路线图（未实现项）

- region 布局（chat 让出顶部/底部区域的真实分屏槽）—— 当前面板列为右缘浮动栈。
- Node 侧 `ui.panel` 多块并发（Lua 侧已支持每 ext 一块；Node 的 `__node__`
  目前同一时刻一块）。
- 卡片动作的确认/输入型交互（当前为单选动作）。
