# 审计报告：boot-ext

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（dsh-nvim-tui v0.3.5，适配 dsh 0.1.5-rc.1），基线 `a14c7a7`，工作区干净
- 审计单元：`boot-ext`
- 必读文件（已**完整**通读）：
  - `src/boot/boot.ts`（239 行）
  - `src/boot/session-events.ts`（323 行）
  - `src/boot/onboarding.ts`（69 行）
  - `src/ext-api/index.ts`（679 行）
  - `src/index.ts`（96 行）
  - `cordis.patch.yml`（11 行）
- 交叉验证（grep + 读码，判断死代码/契约时使用）：
  - Node 侧：`src/kernel/rpc.ts`、`host-events.ts`、`headless.ts`、`lifecycle.ts`、`bridge.ts`、`term.ts`、`app.ts`、`difficulty.ts`、`apikey.ts`、`sessions/index.ts`、`sessions/services.ts`、`transcript/index.ts`、`statusline/index.ts`、`feed/feed.ts`、`feed/diff.ts`、`commands/core.ts`、`commands/commands/restart.ts`
  - Lua 侧：`nvim/lua/dsh_tui/api.lua`（1097 行）、`init.lua`、`rpc.lua`、`state.lua`（核对 `attach` / `register` / `handshake` / `rpc_call` / `session_event` 的真实签名与时序）
  - 宿主/依赖语义：`node_modules/neovim/lib/api/client.js`（`handleRequest`/`handleNotification`：无默认应答）、`node_modules/@deepseek-ai/dsh-session/lib/index.js`（`session/event` 观察者签名 `(session, event)`、`interruptedTurnClosers`）、`node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js`（事件名全集）、`node_modules/@deepseek-ai/cordis/lib/index.js`（`reflect.get` / `provide` 语义）
  - 文档对照：`docs/EXT-API.md`、`docs/ARCHITECTURE.md`、`docs/REVIEW-2025-09.md`（v0.3.3 旧审查，用于区分「新发现 / 旧已知未修」）、`REQUIREMENTS.md`、`scripts/e2e.ts`、`scripts/smoke.ts`、`examples/{dsh-plugin,nvim}`
- 复现手段：静态追踪 + 时序推演（attach 前后窗口逐行对时）；Lua↔Node 通知面对账（`grep -rhoE "dsh-[a-z0-9-]+"`）；`str_replace_editor` 等证据不足项已在附录 C 说明为何**不**列条
- **未修改任何源码文件**（仅新增本报告）

结论：**4 条中危 bug**（启动失败窗口退出码 0 且静默 / attach 窗口的 nvim→runner 入站通道未接线 / attach 前的 Lua 扩展订阅永不送达 / hmr 后 `tui:ready` 无人收到）、**2 条中危 risk**（console 进程级静默副作用、`api.ready` 无超时且可永不 resolve）、**1 条 missing-feature**（hmr 存活契约半实现）、**3 条低危**（1 bug + 1 risk + 1 deadcode）。

| # | 类别 | 严重度 | 位置 | 一句话 |
|---|------|--------|------|--------|
| 1 | bug | medium | `boot.ts:103-119` + `227-238` | nvim 在「socket 已连、attach 未完成」窗口死亡：`onExit` 先 `quit(0)` 把 `quitting` 置位 → boot 的 `quit(1)` 变 no-op → 退出码 0；若 teardown 已跑（`disposed`）连 fatal 都不打印（K2 只修了 `nvim===null` 那一半） |
| 2 | bug | medium | `boot.ts:154` → `189/195` | nvim→runner 的 `request`/`notification` 监听在 attach **之后**（还隔着 2 个 RPC 往返）才安装：该窗口的 `rpcnotify` 被丢弃，`vim.rpcrequest`（`api.rpc_call`）永久死锁 |
| 3 | bug | medium | `ext-api/index.ts:511` + `api.lua:133-136` | attach 之前 `api.register{events=…}` 的 `dsh-ext-register` 因 `S.channel==nil` 被跳过，attach 后无补发 → Lua 侧会话事件镜像永久静默失效（register 仍返回成功） |
| 4 | bug | medium | `ext-api/index.ts:51,158-159,677` | hmr 重载后 `tui:ready` 谁都没收到：`readyAnnounced` 是模块级（不再 fire），`lastFired` 却是安装级（补发无数据）→ 与 `docs/EXT-API.md:140-142` 的补发承诺矛盾 |
| 5 | risk | medium | `boot.ts:126-129` | `console.log/warn/error` 进程级劫持后**永不恢复**：feed flush 失败（`feed.ts:1068`）完全无声，e2e 的 `render flush failed` 断言（`e2e.ts:83`）恒不可达，`ARCHITECTURE.md:224-225` 承诺的覆盖告警在第二次 apply 起不可见 |
| 6 | risk | medium | `ext-api/index.ts:218-225,671-679` | `api.ready` 无超时、不 reject；boot 序列有 6 处 `disposed` early-return（`boot.ts:121/135/138/151/155/220`）+ catch 的 `230` 都「不 announce 就返回」，且 `maybeOnboard` 内含无界 await → 消费者初始化可静默永久挂起 |
| 7 | missing-feature | low | `ext-api/index.ts:95-99` vs `88-92` | 注释宣称「订阅与状态栏段必须跨 hmr 存活」，实际只有 `listeners`/`sessionSubs` 是模块级；`extStatusSegments`/`extNodeHandlers` 每次 apply 重建 → 段消失、`luaExt.on` 处理器失联 |
| 8 | bug | low | `session-events.ts:132-134` | `pendingFileSnaps.clear()` 无条件清空：任意会话的 `turn/end` 都踩掉活动会话在途工具调用的 pre-edit 快照 → 回退路径的 ✎ diff 块静默丢失（旧已知未修 `REVIEW:108`） |
| 9 | deadcode | low | `ext-api/index.ts:71,82,219` | `extReadyResolve` 只写不读（3 处赋值、全库 0 处读取），是 R3 修复留下的死状态 |
| 10 | risk | low | `ext-api/index.ts:196-200,435-439` | `Promise.race` 的超时 `setTimeout` 在成功路径不 `clearTimeout`：每次 `nvim.request({timeoutMs})` / `luaExt.call` 滞留一个最长 30s 的定时器（旧已知未修 `REVIEW:176`） |

---

## 1. [bug / medium] 启动失败窗口：nvim 在 attach 前死亡 → 退出码 0，且可能完全静默

**位置**
- `src/boot/boot.ts:103-119`（`onExit` 的 `childExitDuringBoot` 判据）
- `src/boot/boot.ts:131-154`（socket 连上后仍在跑的 boot 步骤：preload 等待循环 + `attach`）
- `src/boot/boot.ts:227-238`（boot catch：`exitDiag` + `process.stderr.write` + `quit(1)`）
- 配合：`src/kernel/lifecycle.ts:144-147`（`quit()` 的 `quitting` 幂等门）、`166-171`

**机制**

`onExit` 用「`runtime.nvim === null`」区分「boot 还在连接」与「boot 已连上」：

```ts
// boot.ts:103-119
onExit: (code, signal) => {
  app.exitDiag('nvim-exit', …)
  if (!app.slices.runtime.disposed) {
    if (app.slices.runtime.nvim === null) {           // ← 只在连接前成立
      W(app.slices.runtime).childExitDuringBoot = { code, signal }
      return                                          // boot 的 catch 会用 quit(1) 非 0 退出
    }
    void app.quit(0)                                  // ← 连接后：先入为主地 quit(0)
  }
},
```

`nvim` 在 `boot.ts:136` 被赋值，但 boot 之后还有两段会失败的步骤：`146-153` 的 preload 等待循环与 `154` 的 `await app.luaCall('require("dsh_tui").attach(...)')`（以及 `173/177` 的 `set_commands` / `apply_theme`）。这段窗口里 nvim 死亡（用户配置 `error()`+`qa`、启动期崩溃、preload 永不出现后 attach 报 `module 'dsh_tui' not found`）时：

1. `onExit` 走 `nvim !== null` 分支 → `app.quit(0)`。`quit()` 的第一条语句就是 `if (quitting) return; quitting = true`（`lifecycle.ts:145-146`），**同步**置位。
2. boot 随后的 `luaCall` 失败 → catch：若 `quit(0)` 已经把 `teardown()` 跑完（`disposed=true`，`lifecycle.ts:66-67`），则 `boot.ts:230` 的 `if (app.slices.runtime.disposed) return` 直接返回——**连 `process.stderr.write` 的 fatal 都没有**；否则走到 `237` 的 `app.quit(1)`，因 `quitting===true` 变 no-op，进程按 `quit(0)` 的路径以 **0** 退出。
3. `exitDiag('fatal', …, bootExit !== null ? … : '')` 里的 `bootExit` 此刻必为 `null`（只有 `nvim===null` 分支才记录），诊断里连「nvim 已退出」都丢失。

这正是 `docs/REVIEW-2025-09.md:36` 的 K2 项，`REVIEW:252` 标记 Fix-8「✅ 完成（childExitDuringBoot 记录 + stderr fatal）」——**只覆盖了 `nvim===null` 的一半**，连接的窗口仍然退出 0。

**影响**：`scripts/e2e.ts`、CI、以及任何 `dsh --profile …` 包装脚本把启动失败判为成功；用户在终端上看不到任何原因（TUI 直接消失，或只闪一下）。

**建议修法**：把「boot 是否完成」做成显式状态（如 `runtime.bootPhase: 'connecting' | 'wired' | 'ready'`），`onExit` 只在 `'ready'` 后允许 `quit(0)`；`childExitDuringBoot` 改为在 boot 的每个阶段（连接后、attach 后）都可记录；catch 里改用 `W(...).quitting = false` 或给 `quit` 加 `force` 参数保证退出码非 0。

---

## 2. [bug / medium] attach 之后、监听安装之前：nvim→runner 入站通道未接线（通知丢失 / 请求死锁）

**位置**
- `src/boot/boot.ts:154`（`attach`，Lua 侧在此刻拿到 channel）
- `src/boot/boot.ts:189-198`（`nvim.on('request')` / `nvim.on('notification')` 才安装）
- `nvim/lua/dsh_tui/rpc.lua:9-12`（`S.channel = channel_id` 后**同步** `emit('Attach')`）
- `nvim/lua/dsh_tui/api.lua:923-939`（`rpc_call` 用 `vim.rpcrequest`，不可取消）

**机制**

```ts
// boot.ts
154: await app.luaCall('require("dsh_tui").attach(...)', [channelId])  // S.channel 生效 + User DshTuiAttach 触发
158: void app.luaCall('…handshake…')          // 一个 RPC 往返
167: void app.luaCall('…vim.g.dsh_tui_glance…')
173: await app.luaCall('…set_commands…')      // 又一个 RPC 往返
177: await app.luaCall('…apply_theme…')       // 配置了 theme 时的第三个
181: nvim.on('disconnect', …)
189: nvim.on('request', (m,a,resp) => handleDshExtRequest(...))   // ← dsh-ext 请求面在这里才存在
195: nvim.on('notification', …)                                    // ← 所有 dsh-* 通知面也在这里才存在
```

而 `neovim` 客户端对无人监听的入站消息**没有任何默认处理**：

```js
// node_modules/neovim/lib/api/client.js:65-68
else { this.logger.info('handleRequest: %s', method); this.emit('request', method, args, resp); }
// :93-95
else { this.emit('notification', method, args); }
```

`EventEmitter.emit` 无监听者即丢弃 → `resp.send()` 永不发生。于是：

- **请求方向**：nvim 侧在 `User DshTuiAttach` 自动命令（`rpc.lua:11` 同步 `nvim_exec_autocmds`，就在 `attach` 这次 luaCall 内部）里调用 `api.rpc_call(...)` → `vim.rpcrequest(channel, 'dsh-ext', …)`（`api.lua:927`）→ runner 侧此时**没有** `request` 监听 → 无应答。同时 runner 正卡在 `await attach` 的响应上（Lua 侧被 rpcrequest 阻塞，attach 的返回值还没发回）→ **双向永久死锁**（ext-api 文档承诺的 30s 有界应答在此窗口不生效，因为 `handleDshExtRequest` 根本没被调用）。文件注释本身也承认该窗口存在风险面（`api.lua:918-922` 的 FREEZE GUARANTEE）。
- **通知方向**：同一窗口里 `api.notice()`（`api.lua:1052-1056`）、`api.register()`（`api.lua:133-136`，若 channel 已置位）、`dsh-input` 等 `rpcnotify` 全部被静默丢弃 → 例如在 Attach 自动命令里注册的扩展，注册通知直接消失（与第 3 条同因不同路）。

`docs/EXT-API.md:294-297` 明说「**任何请求必有有界应答**……有界应答是唯一的冻结防护」，与该窗口的事实不符。

**建议修法**：把 `nvim.on('request'/'notification')` 与 `wireHostEvents` 提到 `attach` **之前**（它们不依赖 attach，也不依赖 nvim 返回值）；或在 `attach` 前先装一个「缓冲队列」监听，接线后回放。

---

## 3. [bug / medium] attach 之前注册的 Lua 扩展：订阅永不送达 runner（会话事件镜像静默失效）

**位置**
- `nvim/lua/dsh_tui/api.lua:130-136`（注册时**只有** `S.channel` 非空才通知 runner）
- `nvim/lua/dsh_tui/rpc.lua:9-12`（attach 只是置 `S.channel` + emit，**不补发**已有注册）
- `src/ext-api/index.ts:511-520`（Node 侧 `dsh-ext-register` 处理器：唯一写入 `extLuaSubs` 的入口）
- `src/ext-api/index.ts:491-507`（`extDispatchSessionEvent` 只按 `extLuaSubs` 投递）

**机制**

```lua
-- api.lua:130-136
S.extReg[id] = reg
API.emit('ExtRegistered', { id = id, … })
if S.channel then                                     -- ← nil 时整段跳过，且此后无人重试
  vim.rpcnotify(S.channel, 'dsh-ext-register',
    { id = id, name = reg.name, version = reg.version, events = events })
end
```

```lua
-- rpc.lua:9-12  （runner attach 时唯一做的事）
function R.attach(channel_id)
  S.channel = channel_id
  require('dsh_tui.api').emit('Attach', { channel = channel_id })
end
```

时序：runner 先 spawn nvim，`--cmd` 里先装 `package.preload['dsh_tui']`（`bridge.ts:102`），runner 的等待循环一通过就 `attach`（`boot.ts:146-154`）；nvim 侧 `dsh_tui.start()` 挂在 `UIEnter`（`bridge.ts:107`，早于用户配置），而用户配置/插件注册发生在**其后**、与 runner 的 attach 处于同一时间尺度上竞争。谁先谁后是不确定的：

- 若插件先 `api.register{events=…}`（`S.channel==nil`）→ 通知不发；`grep -rn "dsh-ext-register"` 全库只有 `api.lua:134` 和 `ext-api/index.ts:511` 两处，**不存在** attach 后的补发路径 → runner 的 `extLuaSubs` 永远没有该 id → `extDispatchSessionEvent`（`ext-api:491-495`）不会把事件投给它，`api.on_session_event` 回调（`api.lua:1061-1074`）永不触发。
- 同一分支还会连带跳过 `on_ready`（`api.lua:142`：`S.started and S.channel ~= nil`）——晚加载对齐的**两条**路径同时失效，而 `api.register` 仍返回成功表，插件毫无察觉。

**证据面**：`docs/EXT-API.md:203` 承诺 `events = { 'turn/end' }` 即「订阅镜像会话事件」；`examples/nvim/git-panel.lua:22-27,68-71` 正是「setup 时 register + on_session_event」的写法；`scripts/smoke.ts:2513,2692-2694` 只用手工 `session_event({ 'smoke-ext' }, …)` 验证 Lua 分发，**没有**覆盖「register → runner `extLuaSubs`」这一段，故 CI 全绿也掩盖了该缺口。

**建议修法**：`R.attach()` 里遍历 `S.extReg` 补发 `dsh-ext-register`（把「已通知」状态记在 reg 上，避免重复）；Node 侧 `dsh-ext-register` 已是幂等写 Map，无需改动。

---

## 4. [bug / medium] hmr 重载后 `tui:ready` 无人收到：一次性标记是模块级，补发缓存却是安装级

**位置**
- `src/ext-api/index.ts:50-58`（模块级 `readyAnnounced` / `readyWaiters` / `moduleListeners`）
- `src/ext-api/index.ts:158-159`（**安装级** `lastFired` + `REPLAYABLE_EVENTS`）
- `src/ext-api/index.ts:251-260`（晚订阅补发只读 `lastFired`）
- `src/ext-api/index.ts:671-679`（`announceReady` → `if (first) extFire('tui:ready', …)`）

**机制**

```ts
let readyAnnounced = false                    // 模块级：跨 apply 存活（:51）
const listeners = readyListeners()            // 模块级：跨 apply 存活（:53/98）
…
const lastFired = new Map<string, { payload: unknown }>()   // ← 每次 installExtApi 重建（:158）
const REPLAYABLE_EVENTS = new Set<ExtEventName>(['tui:ready', 'tui:active-session'])
```

第二次 apply（runner row 热重载，`lifecycle.ts:63-64` 明确支持「dsh 继续运行、下次 apply 再 spawn 一个新 nvim」）时：

1. `fireExtReady()` 返回 `first = !readyAnnounced = false` → `announceReady` 里 `if (first) app.slices.ext.extFire('tui:ready', …)` **不执行**（`ext-api:677`），模块级 `listeners` 里的老订阅者收不到；
2. 若消费者在新 api 上 `tui.on('tui:ready', cb)`，走到补发分支（`ext-api:251-259`）却发现新的 `lastFired` 是空 Map → 什么都不发。

结果：重载之后**任何路径都收不到 `tui:ready`**（无论是重载前注册的监听者，还是重载后注册的）。`docs/EXT-API.md:140-142`「一次性生命周期事件（tui:ready / tui:active-session）晚订阅自动补发，boot 之后注册的消费者不会错过」对「boot 之后」成立、对「重载之后的 boot」不成立。`api.ready`（promise）本身能 resolve（`readyWaiters` 是模块级，被同一次 `fireExtReady` 排空），所以故障表现为「await ready 成功、事件却永远不来」——最难排查的一种。

**建议修法**：把 `lastFired` 也提到模块级（或让 `fireExtReady` 在 `first===false` 时仍用模块级的最后一次 payload 走一遍补发）；`REPLAYABLE_EVENTS` 的语义要同时覆盖「跨 apply 补发」。

---

## 5. [risk / medium] console 进程级劫持永不恢复：静默失败链与恒不可达的 e2e 断言

**位置**
- `src/boot/boot.ts:124-129`（唯一的劫持点，`silent = () => {}` 赋给 `console.log/warn/error`）
- `src/feed/feed.ts:1063-1071`（feed flush 失败的唯一上报路径就是 `console.error`）
- `src/kernel/lifecycle.ts:117-123`（dispose 失败同上）
- `src/kernel/rpc.ts:22`、`src/kernel/host-events.ts:22`（覆盖告警同被静音）
- `scripts/e2e.ts:83`（断言 dump 不得含 `render flush failed`）

**机制**

`grep -rn "console\.\w* = \|restoreConsole" src/` 全库只有 `boot.ts:127-129` 三处赋值，**没有任何恢复点**（teardown/quit/headless 分支都没有）。而 boot 之后的诊断大量依赖 `console.*`：

- `feed.ts:1068`：`schedule()` 里 `flush().catch(err => console.error('[dsh-nvim-tui] render flush failed:', err))` —— 这是刷新失败（RPC 抖动、buffer 失效）的**唯一**出口，既不 `app.notice` 也不 `exitDiag`。劫持后该失败完全无声，聊天内容静默丢失。
- 连带 `scripts/e2e.ts:83` 的 `bad` 正则含 `render flush failed`：该字符串只写向被静音的 console（`grep -rn "render flush failed"` 仅 `feed.ts:1068` 与 `e2e.ts:83`），**永远不可能出现在 dump 里** → 这条 e2e 保护是恒假的；真实 flush 故障既不上报也检不出。
- `docs/ARCHITECTURE.md:224-225` 把「覆盖时留 `console.warn` 诊断」当作幂等覆盖修复的一部分，但覆盖只发生在**第二次** apply（重载）时，那时 console 早已被第一次 boot 静音 → 该诊断机制从设计上不可观测。
- headless 模式（`nvim --headless`，不占用 tty）也照旧静音，`scripts/e2e.ts` 失败时打印的 `out`（宿主 stdout/stderr）因此缺失自家日志。

该问题在 `docs/REVIEW-2025-09.md:106` 已作为「🟡 次要问题」登记（Fix-8 只落了 K1/K2，未做 console 治理；§8 声明 127 项次要问题未处理），本次复核**仍然成立**，并新增了「e2e 断言恒不可达」这条后果。

**建议修法**：把静音做成可撤销的作用域（`const restore = silenceConsole(); … teardown/quit 时 restore()`），或在 `headless` 下（不占 tty）与 teardown 之后不静音；把 `feed.ts:1068` 改成 `exitDiag('feed-flush', …)` + `app.notice`，让失败至少进错误日志。

---

## 6. [risk / medium] `api.ready` 无超时、不 reject，且 boot 存在多条「不再 announce」的出口

**位置**
- `src/ext-api/index.ts:218-225`（`ready` 只在 `fireExtReady()` 里被排空）
- `src/ext-api/index.ts:671-679`（`announceReady` = 唯一的 resolve 来源，位于 boot 序列末段）
- `src/boot/boot.ts:121,135,138,151,155,220`（6 处 `if (disposed) return`）、`230`（catch 里的 disposed 早退）
- `src/boot/boot.ts:219-226`（announce 之前还有 `resumeOrCreate` / `maybeOnboard`）
- `src/boot/onboarding.ts:47` + `src/kernel/apikey.ts:36-45`（`await cred.resolve(ref)` **无超时**）
- 消费范式：`examples/dsh-plugin/index.ts:19-21`（`void tui.ready.then(() => {…全部初始化…})`）、`docs/EXT-API.md:50`

**机制**

`ready` 的契约是「boot 完成」的唯一信号，但它既不会 reject 也没有超时；唯一的 resolve 入口 `announceReady` 在 boot 的最后一步，而它前面有：

1. 6 个 `if (app.slices.runtime.disposed) return`（`boot.ts:121/135/138/151/155/220`）——这些是「app 已被拆除」的正常出口，函数**静默返回**，`announceReady` 永不执行；
2. catch 分支（`230`）在 disposed 时同样早退；
3. `await maybeOnboard(app)`（`219-222` 之前）内部 `apiKeyConfigured` 对 credentials 服务做**无超时** await（`apikey.ts:39`）——凭证 seam 卡住（远端 store、mount 未就绪）就永远停在 boot 序列中段：nvim 界面已可见（bus 已接线），但 `announceReady`/`drainPendingInput` 永不发生，`api.ready` 永久 pending。

按文档推荐的消费范式（`void tui.ready.then(init)`），消费者的全部初始化（状态栏段、命令、事件订阅）会**静默永不执行**，且没有任何日志——只有 `api.ready` 这个 promise 永远挂着。对比：`EXT_HANDLER_TIMEOUT_MS` 为 dsh-ext 请求做了 30s 有界应答，`ready` 这个更关键的握手却没有任何上界。

**建议修法**：`ready` 用 `Promise.race` 加一个可配置的 boot 超时（超时 reject 而不是静默 pending）；`maybeOnboard` 的 credentials 查询加超时（例如 2s，失败按「未配置」处理）；或让 `announceReady` 在早退路径上也调用（用 dispose 前的最后一次状态）。

---

## 7. [missing-feature / low] 「跨 hmr 存活」契约半实现：状态栏段与 `luaExt` 处理器每次 apply 都会丢

**位置**
- 注释（宣称）：`src/ext-api/index.ts:95-99`「Subscription/slot state lives at MODULE scope: a runner-row reload (hmr) re-runs apply() in the same process — plugin subscriptions and status segments must survive the reload, not silently vanish.」
- 实现：`src/ext-api/index.ts:98-99`（只有 `listeners`/`sessionSubs` 来自模块级）+ `88-92`（`extLuaSubs`/`extNodeHandlers`/`extStatusSegments` 都在 `app.slices.ext` 域默认值里，每次 apply 重建）
- 消费侧：`examples/dsh-plugin/index.ts:22-25`（段只在 `ready.then` 里注册一次）、`examples/dsh-plugin/index.ts:28`（`registerCommands`）

**机制**

`installExtApi` 每次 apply 都把 ext 域重置为默认值：

```ts
Object.assign(app.slices.ext, {
  …
  extLuaSubs: new Map(),                 // Lua 侧订阅表：重载后清空（第 3 条的 Node 侧镜像）
  extNodeHandlers: new Map(),            // luaExt.on 处理器表：重载后清空
  extStatusSegments: new Map(),          // 状态栏段：重载后清空
})
```

而模块级的只有 `moduleListeners`（`on`）与 `moduleSessionSubs`（`onSessionEvent`）。因此「只重载 runner row、不重载消费方 row」时（这正是注释描述的 hmr 场景）：

- 消费方注入的状态栏段消失（消费方的 `apply` 不会重跑，`tui.ready.then` 早在旧 api 上执行过，不会补注册）；
- `luaExt.on(extId, fn)` 处理器消失 → nvim 侧对同一 extId 的 `api.rpc_call` 变成结构化错误 `no ext handler: id.method`（`ext-api:650-652`），扩展总线静默失联；
- `scripts/check-arch.mjs:108` 的 `STATE_FIELDS.ext` 又把这几项**钉**在 app 域（跨域写入会被架构守卫拦下），所以「直接搬去模块级」会与守卫冲突——修法需要显式设计（例如模块级保留 snapshot，install 时回填）。

**建议修法**：对 `extStatusSegments`/`extNodeHandlers` 采用与 `readyWaiters` 相同的模块级快照 + install 时回填；或明确改口注释与 `docs/EXT-API.md`，声明「重载后需重新注册」。

---

## 8. [bug / low] `turn/end` 钩子无条件 `pendingFileSnaps.clear()`：跨会话踩掉在途 diff 快照

**位置**
- `src/boot/session-events.ts:132-134`（`'turn/end'` 钩子第一条语句）
- 写入方：`src/boot/session-events.ts:38-48`（`tool/call` 异步读 pre-edit 快照，key = `callId`）
- 消费方：`src/transcript/index.ts:271-281`（`tool/result` 时若 `pendingFileSnaps` 无该 callId → 直接 return，不渲染 ✎ 块）

**机制**

`pendingFileSnaps` 是**全局** Map（`app.slices.ui.pendingFileSnaps`，key 仅为 `callId`），而 `'turn/end'` 钩子对它做无条件清空：

```ts
'turn/end': (rec, owner, event) => {
  app.slices.ui.pendingFileSnaps.clear()      // ← 不区分 owner.id，也不区分是否活动会话
```

同一个钩子里其它副作用都做了 `owner.id === app.slices.sessions.activeId` 的门控（`165` 铃声、`175` 通知、`189` 标题），唯独这一条没有。切换会话并不会 dispose 旧会话（`sessions/services.ts:202-242` 的 `switchTo` 只改 `activeId`；`disposeLiveSession` 需显式调用），因此「后台会话 A 的 `turn/end`」与「活动会话 B 的 `tool/call`→`tool/result`」可以真实交错：A 的 `turn/end` 落在 B 的两次事件之间 → B 的 `snap === undefined` → 回退路径的 diff 块静默不渲染（`meta.diffs` 主路径不受影响，只有「工具未给 presentationMeta」的新建/删除类改动会丢）。

该点已登记在 `docs/REVIEW-2025-09.md:108`（「session-events.ts:129 pendingFileSnaps.clear() 全局清空，跨会话并发回合快照互相踩踏」，属 §8 未处理的次要问题），本次复核仍然成立。

**建议修法**：把 `clear()` 限定为 `owner.id === app.slices.sessions.activeId`（或在 `pendingFileSnaps` 的 value 里带上 `sessionId`，命中前校验）。

---

## 9. [deadcode / low] `extReadyResolve` 只写不读

**位置**
- `src/ext-api/index.ts:71`（`extReadyResolve: null` 初始化）
- `src/ext-api/index.ts:82`（`fireExtReady` 里 `WE.extReadyResolve = null`）
- `src/ext-api/index.ts:219`（构造 `ready` 时 `WE.extReadyResolve = resolve`）
- 声明：`src/kernel/app.ts:264`；架构守卫清单：`scripts/check-arch.mjs:108`

**证据（无调用方）**

```
$ grep -rn "extReadyResolve" src/ scripts/ docs/
src/ext-api/index.ts:71:    extReadyResolve: null,
src/ext-api/index.ts:82:      WE.extReadyResolve = null
src/ext-api/index.ts:219:      WE.extReadyResolve = resolve
src/kernel/app.ts:264:    readonly extReadyResolve: (() => void) | null
scripts/check-arch.mjs:108:  ext: ['extApi','extReadyResolve', …],
docs/REVIEW-2025-09.md:23:  | R3 | … fireExtReady 把 WE.extReadyResolve = null 而**从不调用**它 …
```

3 处赋值、**0 处读取**（含 scripts/examples）。它是 R3（`REVIEW:23`）改用 `readyWaiters` 排空后的残留：字段既不再被调用，也不再是 resolve 的真源。

**建议修法**：从 `AppSlices.ext`、`installExtApi` 与 `check-arch.mjs` 的 `STATE_FIELDS.ext` 中一并删除。

---

## 10. [risk / low] `Promise.race` 的超时定时器在成功路径不清理

**位置**
- `src/ext-api/index.ts:191-201`（`nvimLayer.request({ timeoutMs })`）
- `src/ext-api/index.ts:426-447`（`luaExt.call`，默认 30s）

**机制**

```ts
// ext-api:194-200
const p = app.slices.runtime.nvim.request(method, args)
if (opts?.timeoutMs === undefined) return p
return Promise.race([ p, new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`nvim.request ${method} 超时`)), opts.timeoutMs)) ])   // ← 无 clearTimeout
```

```ts
// ext-api:435-439（luaExt.call 同理，timeoutMs 默认 EXT_HANDLER_TIMEOUT_MS = 30_000）
const res = await Promise.race([ p, new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`lua ext …timeout (${timeoutMs}ms)`)), timeoutMs)) ])
```

成功路径（正常情况）不 `clearTimeout`：每次调用都留下一个最长 30s 的挂起定时器（`luaExt.call` 被轮询式调用时会累积），延后事件循环的自然退出，并持有闭包。对比：同文件 `handleDshExtRequest:654-663` 与 `bridge.ts:195-205` 都成对 `clearTimeout`，只有这两处漏了。（`docs/REVIEW-2025-09.md:176` 已登记为未修次要问题；`kernel-runtime.md` 附录 B 亦提及，本次复核仍然成立。）

**建议修法**：`let t; const timeoutP = new Promise(...); return Promise.race([...]).finally(() => clearTimeout(t))`。

---

# 附录 A：核查过、**未发现问题**的面（避免遗漏误判）

1. **`MAIN_EVENT_HOOKS` 的事件名与宿主词汇表**：`turn/start`、`tool/call`、`tool/result`、`turn/end`、`session/title`、`user/message`、`assistant/message`、`plan/mode`、`goal/change` 九个 key 全部存在于 `node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js:21-73`，无拼写漂移；`session/event` 的观察者签名 `(session, event)`（`dsh-session/lib/index.js:1435`：`callbackArgs = [this, event]`）与 handler 的 `owner.id` 用法一致。
2. **孤儿工具调用的自愈（`session-events.ts:135-164`）**：与宿主 `interruptedTurnClosers`（`dsh-session/lib/index.js:477-570`）不重复——宿主只在「日志以未闭合回合结尾」时补写，而本路径处理「`turn/end` 已落盘但 tool/result 缺失」（调度器崩溃），语义互补；`setTimeout(…,0)` 规避 `session.append` 的发布边界重入（`dsh-session/lib/index.js:1418`：`if (entry?.appending) throw`）也是必要的。
3. **`handleDshExtRequest`（`ext-api:623-666`）**：`answered` 单次应答、先 JSON 清洗再 `resp.send`、超时与服务端异常都回结构化错误、`clearTimeout` 成对——与 `docs/EXT-API.md:294-297` 的契约一致（唯一缺口是第 2 条的「监听未装」窗口）。
4. **`nvimLayer` 白名单**：`SAFE_VIM_FN` 已剔除 `systemlist`（`ext-api:180-189`），与 `docs/EXT-API.md` 的「只读」声明一致（`REVIEW:258` 的 E2 已修）。
5. **`registerCommands` 的所有权式注销**（`ext-api:404-424`）：用 `registerCommands` 返回的「实际接受集合」过滤，重复名被拒时不误删原命令，与 `app.ts:499-514` 的语义匹配。
6. **`dsh-ext-card-activate`（`ext-api:530-612`）**：`pendingCardInput` 有真实消费方（`commands/core.ts:569-589` 的 `dsh-input` 与 `:597-600` 的 `dsh-command`），`confirm`/`input` 在 headless 下按文档降级为 plain；无死路径。
7. **`index.ts:74-95` 的注入与发布**：`ctx.inject(['agents','agentDefaultModel'])` 内同步完成各 install + `ctx.provide('nvim-tui', …)`，boot 用 `void` 启动（内部自带 try/catch）——未发现「在 inject 里赋值到 ctx」这类会死锁的写法（注释所述禁忌已避开）。
8. **`cordis.patch.yml`**：只声明 `id/name`，与 `RunnerConfig` 全可选的默认值（`app.ts:439-444`：headless/watchdogMs/dumpPath 均有 env 兜底）一致，未发现「文档承诺的配置项无处可配」的问题。
9. **boot 序列的其余顺序**：watchdog 在首个 `await` 前布防（`boot.ts:87-88`，K3 已修）；`installHeadless` 先于 `session/event` 订阅（避免旧 TDZ 地雷）；`drainPendingInput` 在 `announceReady` 之前（先补发 pending 输入再宣布就绪），顺序合理。

# 附录 B：旧审查已登记、本次复核**仍成立**但未计入本单元条目的项

- `docs/REVIEW-2025-09.md:106` / `:224`（Fix-8 未含 console 治理）→ 本报告第 5 条已升级为正式条目（带新证据）。
- `docs/REVIEW-2025-09.md:108` → 第 8 条。
- `docs/REVIEW-2025-09.md:176` → 第 10 条。
- `docs/REVIEW-2025-09.md:202`「src/ext-api/index.ts:5-9 模块头注释『later phases』与已实现矛盾」：同类漂移还有 `src/boot/session-events.ts:248` 的注释「the Lua-side routing lands with P3」——而 Lua 侧镜像早已实现（`api.lua:1061-1074` + `ext-api:491-507`）。属注释漂移，未单列条目。
- `src/kernel/lifecycle.ts:189-206`（`/restart` 后继 spawn 失败被当成成功、退出码 0）已由 **kernel-runtime** 单元作为其第 1 条报告（含 python3 依赖证据），本单元不重复计数；与本报告第 1 条同属「静默失败 + 退出码」族，建议汇总时合并呈现修复方案。

# 附录 C：证据不足、**未**列为问题的点

- `session-events.ts:19-26` `producedPathFromCall` 的 `if (name === 'str_replace_editor' && args?.command !== 'insert') return null`：该守卫使 `str_replace_editor` 的 `create`/`str_replace` 命令既不计入 `/deliverables`，也不建立 pre-edit 快照（只有 `insert` 通过）。但本仓库未安装 dsh 核心（`node_modules` 无 `dsh` 包），无法核对 `str_replace_editor` 各 `command` 的入参形状（`file_path` vs `path`）与该守卫的历史意图（`git log -S` 只能追到 "Add dsh-nvim-tui source"，无说明），故不列为缺陷。
- `ext-api/index.ts:301-303` `ui.card` 的 `ttlMs` 定时器未纳入任何 disposer：`dismiss()` 自身幂等（`feed.ts:427-435` 命中不存在即 return），失败也只落到被静音的 flush catch，无法论证实际危害，未列条。
- `ext-api/index.ts:127-151` `releaseClaim`/`releaseSlot` 先删 Node 侧 claim 再 `await …region_release(...).catch(()=>{})`：Lua 侧释放失败会造成两侧登记不一致，但 `region_claim` 对「同 ext 同 side 已有块」的行为（覆盖还是报错）未在 `api.lua:763-858` 中读到明确结论，无法给出后果，未列条。
- `ext-api/index.ts:280-283` `ui.card` 在 `opts.sessionId` 指向非 live 会话时静默落到**当前活动** feed（`?? app.slices.ui.activeFeed()`）：属文档未覆盖的降级，是否可接受取决于契约意图，未列条。
- `docs/EXT-API.md:137` 称 `onSessionEvent` 回调可收到「实时事件 + 历史回放」，而 runner 的 resume 回放是直接 `foldEvent`/`applyEvent`（`sessions/services.ts:164-168`），不经 `session/event`；宿主的 `session.append` 又是唯一派发点（`dsh-session/lib/index.js:1435`）。因无法排除宿主在 resume 时另有派发路径，未列条（建议 docs 单元复核）。
