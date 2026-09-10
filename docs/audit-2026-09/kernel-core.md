# 审计报告：kernel-core（dsh-nvim-tui v0.3.5，适配 dsh 0.1.5-rc.1）

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（HEAD `a14c7a7`，工作区干净）
- 审计单元：`kernel-core`
- 必读文件（已用 `read` 完整通读）：
  - `src/kernel/app.ts`（611 行）
  - `src/kernel/types.ts`（566 行）
  - `src/kernel/index.ts`（29 行）
- 交叉验证（grep/read）：`src/index.ts`、`src/boot/boot.ts`、`src/boot/session-events.ts`、`src/kernel/lifecycle.ts`、`src/kernel/rpc.ts`、`src/kernel/headless.ts`、`src/sessions/index.ts`、`src/commands/index.ts`、`src/commands/core.ts`、`src/ext-api/index.ts`、`src/deps/services.ts`、`src/feed/feed.ts`、`scripts/check-arch.mjs`、`scripts/app-ops-check.mjs`、`docs/ARCHITECTURE.md`、`docs/REVIEW-2025-09.md`、`UPGRADE.md`、`README.md`、`REQUIREMENTS.md`
  - 宿主契约：`node_modules/@deepseek-ai/cordis/src/reflect.ts`、`node_modules/@deepseek-ai/dsh-agent/lib/types/*.d.ts`（本地装的是 0.1.2-rc.1，仅用于核对 cordis 服务语义与 Agent.session 形状）
- 机械核查（全部通过，作为基线）：`npx tsc --noEmit` 零错误；`tsc --outDir /tmp/libcheck` 与入库 `lib/` 逐字节一致；`node scripts/check-arch.mjs` ✓；`node scripts/app-ops-check.mjs` ✓（78 个域 op 全注入）；内部模块注册的 62 条命令**无重名**（`registerCommands` 去重分支不会被内部模块触发）。
- 未修改任何源码文件；本报告为唯一新增文件。

结论：**1 条高危**（kernel 的 notice 通道在「无活动会话」时整体静默，启动窗口内两条真实故障提示被丢弃）、**4 条中危**（进程级 fail-silent 钩子、`appExit` 一次性捕获、`liveSessions` 适配器一次性捕获、内核 barrel 死代码）、**7 条低危/类型契约**。

> 去重说明：本单元与并行单元 `.dsh/audit/commands-a.md`、`.dsh/audit/commands-core.md` 存在同源条目，报告中已逐条标注归属，本单元只报告**声明侧/内核侧**的机制与修复落点，避免重复计数。

---

## 1. [bug / high] `notice` 只有「当前活动会话 feed」一个 sink：启动窗口内的真实故障提示被整体吞掉

**位置**
- `src/kernel/app.ts:542-546`（sink 定义，本单元）
- 被吞的两条真实提示：`src/sessions/index.ts:253-260`（`refreshHistory` 失败）、`src/boot/boot.ts:158-165`（扩展接口握手失败）
- 对照：`src/kernel/app.ts:484-487`（guard 失败）、`src/kernel/app.ts:506-509`（命令重名）

**机制（确定因果链）**

```ts
// src/kernel/app.ts:542-546
app.slices.ui.activeFeed = () => {
  const rec = app.slices.sessions.activeId === null ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  return rec?.feed
}
app.notice = (text: unknown): void => { app.slices.ui.activeFeed()?.appendNotice(text) }
```

`activeId` 的唯一赋值点是 `src/sessions/services.ts:214`（`attachSession`），初值 `null`（`src/sessions/index.ts:153`）；而 boot 序列（`src/boot/boot.ts` 的 step 3）第一条 await 就是 `await resumeOrCreate(app)`（boot.ts:219），`resumeOrCreate` 的**第一句**是 `await app.slices.sessions.refreshHistory()`（`src/sessions/index.ts:320`）——冷启动（以及 HMR 后重新 apply）时此刻 `live` 还是空 Map、`activeId === null` ⇒ `activeFeed()` 恒 `undefined` ⇒ `?.` 静默丢弃。

```ts
// src/sessions/index.ts:253-260
} catch (err) {
  // A storage read failure must be VISIBLE: silently keeping stale/empty history made
  // /sessions look like "all sessions vanished" and boot would quietly create a fresh session
  // (pre-review: bare catch {}).
  const e = err instanceof Error ? err : new Error(String(err))
  app.exitDiag('refreshHistory-failed', e.message)
  app.notice(`会话历史加载失败: ${e.message}（/sessions 列表可能不完整）`)   // ← 恒被丢弃
}
```

即：上一轮评审 S3「refreshHistory 静默吞错」的**修复本身是无效的**——`exitDiag` 会写 `~/.dsh/nvim-tui-errors.log`（`src/kernel/lifecycle.ts:21-26`），但用户侧承诺的聊天区提示永远不会出现。同文件 `resumeOrCreate` 的另一条提示是**故意排在 `createSession()` 之后**才可见的（`src/sessions/index.ts:335-336`），说明「先建会话再 notice」是作者已知的约束，而 `refreshHistory` 这条漏了。

**复现路径**
1. 让 `sessionPersistence.list()` 抛错（会话目录不可读 / 存储损坏 / `DSH_HOME` 权限异常）。
2. 冷启动 `dsh`：`refreshHistory` 抛错 → 聊天区**无任何提示**，随后 `resumeOrCreate` 新建空会话（用户视角＝「我的会话全没了」且没有任何解释）。
3. 唯一痕迹：`~/.dsh/nvim-tui-errors.log` 的 `退出诊断: refreshHistory-failed …`。

同类第二例（竞态）：`src/boot/boot.ts:158-165` 的握手失败 notice 发生在 `attach` 之后、`resumeOrCreate`（219 行）之前，靠 `.then` 微任务触发——若握手先于会话建立返回（`ok:false`），「扩展接口握手失败」同样被丢弃。`src/kernel/app.ts:484-487/506-509` 的两条内核提示在 install 期（无会话）同样不可达。

**建议修法**（任选其一，推荐 1）
1. 给 `app.notice` 一个兜底 sink：在 ui slice 增加 `pendingNotices: string[]`，`activeFeed()` 为 `undefined` 时压入队列，`attachSession`/`switchTo` 成功后在 feed 上 flush；同时（或至少）把无 feed 时的 notice 也写入 `errorLogPath`。
2. 或在 boot 完成（`announceReady`）之前把 `notice` 降级为 `process.stderr.write`（headless/CI 可见），并保留现有 feed 路径。
3. 顺带修 `refreshHistory` 调用方：把提示推迟到 `resumeOrCreate` 的会话建立之后（与 335-336 行同样式），或把失败信息带进新会话的 banner。

**去重**：`commands-a.md` F1 从「命令侧」报告了同一 sink 的另一批命中（`/compact`、`/context`、`/image` 等 20+ 处 `!rec` 分支）。本条只补内核侧根因 + 启动窗口的两条实例（其中 `refreshHistory` 一例是该单元未覆盖的、确定性的丢弃）。

---

## 2. [risk / medium] 进程级 `uncaughtException` / `unhandledRejection` 钩子只记日志，压制了 Node 的 fail-fast

**位置**：`src/kernel/app.ts:572-590`（另：`src/boot/boot.ts:126-129` 把 `console.log/warn/error` 全部替换为空函数）

```ts
// src/kernel/app.ts:577-590
const logProcessError = (kind: string, err: unknown) => {
  try { appendFileSync(errorLogPath, `${new Date().toISOString()} 进程诊断: ${kind}: …\n`) } catch {}
}
const onUnhandledRejection = (err: unknown) => logProcessError('unhandledRejection', err)
const onUncaughtException = (err: unknown) => logProcessError('uncaughtException', err)
process.on('unhandledRejection', onUnhandledRejection)
process.on('uncaughtException', onUncaughtException)
```

**机制**：Node 对 `uncaughtException` 的默认行为是打印堆栈并 `exit(1)`；**注册监听器本身就会取消该默认行为**。`unhandledRejection` 同理（默认 `--unhandled-rejections=throw` 会转成未捕获异常并退出）。这两个回调只做 `appendFileSync`，既不 rethrow 也不 `process.exit`，注释里假定的「alpha.4 宿主 fail-loud 会替我们退出」（app.ts:573-576）在没有该宿主行为的 profile 上不成立；再加上 boot 已经把 `console.error` 换成空函数（boot.ts:129），结果是**进程带着未知状态继续跑，且终端与聊天区都看不出异常**。监听器只在 `ctx.effect` 的 disposer 中移除（app.ts:604-605），而注册发生在 effect 之外，属于不对称接线。

`docs/REVIEW-2025-09.md:110` 已把这条列为遗留 🟡（当时定位 `app.ts:531-532`），代码未变。

**建议修法**：日志写完后恢复默认语义——`process.removeListener('uncaughtException', onUncaughtException); throw err`（rethrow 前先摘掉自己的监听器），或 `logProcessError(...); process.exitCode = 1; process.exit(1)`；若确实只想「记录后交给宿主」，至少在注册前检查 `process.listenerCount('uncaughtException') === 0`，仅在宿主已有 fail-loud 处理链时才跳过 rethrow。

---

## 3. [risk / medium] `appExit` 服务在 createApp 期被一次性捕获：捕获失败即静默降级为 `process.exit()`

**位置**：`src/kernel/app.ts:533-538`

```ts
const appExitService = svc('appExit')          // ← 只在 createApp 求值一次
app.requestExit = (code = 0) => {
  if (typeof appExitService === 'function') appExitService(code)
  else process.exit(code)                       // ← 静默硬退出（跳过 flush/teardown）
}
```

**机制与证据**
- 本仓库其余 23 个服务键**全部**是调用点惰性查询（`app.svc('…')`，见 `src/sessions/index.ts:37,211`、`src/kernel/app.ts:519` 等）；只有 `appExit` 在构造期快照。
- cordis 的 `ctx.get(name, strict = true)` 返回的是「当前实现值」快照，且要求提供方 fiber 处于 ACTIVE（`node_modules/@deepseek-ai/cordis/src/reflect.ts:233-237`，`get()` → `_getImpl(name, strict)?.value`）。`ctx.inject(['agents','agentDefaultModel'])`（`src/index.ts:74`）**不覆盖 `appExit`**：若 `appExit` 由更晚装载/更晚激活的 fiber 提供，或宿主 HMR 重新 provide，这里永远是 `undefined`，`requestExit` 永久走 `process.exit(code)`。本仓库自己就承认「服务可能在本 app 生命周期内才就绪」——`src/deps/services.ts:196-215,353-361` 会轮询 `svcOk()` 等 HMR 把服务组合进来，超时则重启。
- 触发点：`src/kernel/lifecycle.ts:201`（/restart）与 `:212`（普通 quit / 信号 / nvim 退出 / 致命错误）——两者都调 `app.requestExit(code)`。此时 `process.exit()` 会**同步截断** `quit` 里本应等待的会话 flush（`lifecycle.ts:110-115` 的 `sessionPersistence.flush()`）。
- 与文档冲突：`README.md:524`、`REQUIREMENTS.md:365`（D-3）、`cordis.patch.yml:7` 都宣称「用户退出 / nvim 退出 / 致命错误 / 信号才会走 `appExit`」。
- 次要：`typeof appExitService === 'function'` 是 duck-type 假设；若宿主的 `appExit` 是 cordis `Service` 实例（如 `AgentRegistry` 那样是对象），该分支恒假，同样落进 `process.exit`（本地无法核对 0.1.5 宿主形状，故并列为风险而非断定）。

**建议修法**：改为调用点惰性解析并保留降级可观测性：

```ts
app.requestExit = (code = 0) => {
  const exit = app.svc('appExit') as unknown
  if (typeof exit === 'function') return (exit as (c?: number) => void)(code)
  if (typeof (exit as { exit?: unknown })?.exit === 'function') return (exit as { exit: (c?: number) => void }).exit(code)
  app.exitDiag('requestExit-fallback', 'appExit service unavailable — hard process.exit')
  process.exit(code)
}
```

---

## 4. [risk / medium] `liveSessions` 适配器把 `agents` 注册表在 createApp 期捕获：服务被重新 provide 后会话查询永久失真

**位置**：`src/kernel/app.ts:414-431`（`liveSessions.get/list`），与 `src/kernel/app.ts:411-412`（`svc` 的惰性查询）形成对照

```ts
const agentsReg = runtimeCtx.get('agents') as unknown as {
  get?: (id: string) => { session?: unknown } | undefined
  list?: () => Array<{ session?: unknown }>
}
const liveSessions: SessionStore = {
  get: (id) => { const s = agentsReg?.get?.(id)?.session; … },
  list: () => (agentsReg?.list?.() ?? []).map((a) => a.session).filter(…),
}
```

**机制与证据**
- 冷启动路径本身是安全的：`agents` 由 `ctx.inject(['agents','agentDefaultModel'], …)` 保证在 createApp 前已 ACTIVE（`src/index.ts:74`），并且 `Agent.session` 在 0.1.2/0.1.5 都是普通 readonly 属性（`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:66-69`），`.session` duck-type 形状成立。
- 风险在**重新 provide / HMR**：cordis 的 `get` 返回的是实现值快照（`reflect.ts:233-237`，`getTraceable(ctx, _getImpl(...).value)`），服务被 unload 后重新 provide 会生成新实例，而这里持有的旧引用不会更新。本插件明确支持「runner 行不重启、宿主侧插件热重载」的形态（`src/kernel/lifecycle.ts:63-64`「the runner row can be reloaded (hmr) while dsh keeps running」、`src/deps/services.ts:353-361` 等待 HMR 生效）。
- 失效后果是**静默的、半侧的**：`app.slices.sessions.live`（TUI 自己的 SessionRec 表）仍然完整，但所有 `app.liveSessions.*` 调用恒返回「无此会话」——`src/sessions/commands/sessions.ts:24,32,75`（会话列表过滤/打开判定）、`src/subagents/index.ts:33,119,251`（子代理 live 查找）、`src/kernel/lifecycle.ts:104`（旧宿主 flush 遍历）、`src/transcript/commands/rewind.ts:12`、`src/sessions/commands/rename.ts:23` 同时降级，用户只会看到「会话/子代理列表不对」而没有任何提示。

**建议修法**：把注册表查询变成每次调用解析，例如

```ts
const agentsReg = () => runtimeCtx.get('agents') as unknown as { get?: …; list?: … } | undefined
get: (id) => { const s = agentsReg()?.get?.(id)?.session; … }
```

并对「`agents` 存在但 `get`/`list` 均缺失」的情况记一次 `exitDiag`（现在的 `?.` 会把契约漂移完全吞掉）。

---

## 5. [deadcode / medium] `src/kernel/index.ts` 是无调用方的死 barrel（且不是对外可达的 API）

**位置**：`src/kernel/index.ts:1-29`（模块头自称「the public surface every business module imports from」）

**全局证据（grep 全仓，排除 `node_modules/`、`lib/`、`.git/`）**

```
grep -rn "kernel/index" .            → 仅 docs/REVIEW-2025-09.md:201,210（上一轮评审把它列为死代码）
grep -rn "from '.*kernel\.js'" src scripts  → 无输出
业务模块实际导入：../kernel/app.js ×21、../kernel/types.js ×13、rpc.js ×5、host-events.js ×5、
                  difficulty.js ×3、vision.js/ext-types.js ×2、term/subagent-clean/profile/lifecycle/headless/bridge/apikey ×1
```

**附带证据**：`package.json` 的 `exports` 只有 `"."`（→ `lib/index.js`）、`"./cordis.patch.yml"`、`"./package.json"`，没有 kernel 子路径——外部消费者按包规范无法 `import 'dsh-nvim-tui/lib/kernel/index.js'`（Node 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`），所以它连「对外公共面」都不成立。

> 与并行单元的结论差异：`.dsh/audit/kernel-runtime.md` 在讨论 `subagent-clean` 导出时把 `src/kernel/index.ts:24` 描述为「公共导出面，供外部消费者使用」。就本单元核查到的证据（零内部导入 + exports 无该子路径 + 上次评审已判死），该描述不成立；建议汇总时以本条为准，或由维护者明确「保留 barrel 作为对外 SDK」并补上 `exports` 子路径。

**危害（为什么不是纯无害残留）**：`export * from './types.js'` + 12 个具名再导出（`createApp/BUILD_*/App/AppSlices/WritableSlice/CommandSpec/SessionRec/ModelRef/WorkflowRun/ServiceMap` + 内核设施）构成**第二个、无人校验的表面**：types.ts 改名/删字段不会有任何编译或脚本报错（`check-arch.mjs` 只扫 kernel 的 import 方向，不校验 barrel），未来从它 import 的代码会走 `bridge/lifecycle/headless` 的非组合根路径。`docs/REVIEW-2025-09.md:210` 已把它列为死代码，本次核查仍未修复。

**建议修法**：二选一——(a) 删除该文件（并同步 `README.md` 目录说明）；(b) 让它成为唯一入口：把 21 处 `../kernel/app.js` / 13 处 `../kernel/types.js` 的导入改为 `../kernel/index.js`，并在 `check-arch.mjs` 增加「kernel 目录只能经 index.ts 被外部导入」的扫描，否则 barrel 会再次漂移。

---

## 6. [missing-feature / low] 0.1.5 新增的 `system/message` surface 事件没有类型成员也没有渲染分支，与升级文档的宣称不符

**位置**：`src/kernel/types.ts:85-115`（`SessionEvent` 联合与「unknown kinds … dropped by the default branch」注释）

**证据链**
- grep 全仓 `src/`：`system/message` **0 命中**（`grep -rn "system/message" src scripts` 无输出）。
- `SessionEvent` 联合（types.ts:91-115）无该成员；`MAIN_EVENT_HOOKS`（`src/boot/session-events.ts:80-243`）无该键；`FeedRenderer.applyEvent` 的 `switch` 落到 `default: break`（`src/feed/feed.ts:924-925`）直接丢弃。
- 文档却宣称已支持：`UPGRADE.md:21-22`「**新增 surface 事件 `system/message`** … TUI 以暗淡通知行渲染，不进用户气泡」；`CHANGELOG.md:48` 进一步说明真机 0.1.5 会话的**首条** `system/message` 就带着 todo-guard 段落（即该事件确实存在并会流经 `session/event` 管线）。
- 现状对 `form:'notice'` 的 **user/message** 变体是有渲染的（`src/feed/feed.ts:684-687`），所以本条只针对 `system/message` 这一类型缺口。

**影响**：若宿主把 0.1.5 的系统/通知类 surface 消息以 `system/message` 投递，TUI 侧零渲染、零日志（连 `exitDiag` 都没有），升级文档承诺的行为不可观测。

**建议修法**：三选一并保持一致——(a) 在 `SessionEvent` 增加 `{ type: 'system/message'; data?: ChatMessage | { message?: ChatMessage } }` 并在 feed 的 `applyEvent` 里按「暗淡通知行」渲染（复用 `appendNotice`/`· ` 前缀）；(b) 若产品决策是「不渲染系统消息」，把 `UPGRADE.md:21-22` 改成「TUI 不渲染该事件（仅用于宿主上下文）」，并在 types.ts 注释里显式登记该类型为「已知但忽略」；(c) 至少在 default 分支对 `system/message` 记一次 `exitDiag`，避免将来宿主扩展时再次静默丢失。

---

## 7. [risk / low] 内核原语对「尚未注入的 slice 字段」用 `=== null` / `!== null` 判空：任何 install 前调用都会 TypeError

**位置**：`src/kernel/app.ts:450`（`const slices = { runtime: {}, sessions: {}, ui: {}, ext: {}, trans: {}, agent: {} } as unknown as AppSlices`）、`src/kernel/app.ts:41-45`、`src/kernel/app.ts:516-519`、`src/kernel/app.ts:548-554`

```ts
// app.ts:41-45（activeSessionCwd）
const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
// app.ts:518（refreshCommandCatalog 同款表达式）
// app.ts:553-554（openPicker）
if (app.slices.agent.pickerSettle !== null) app.slices.agent.settlePicker(null)
app.slices.agent.setPickerSettle(resolve)
```

**机制**：createApp 只保证「壳」，`live` / `activeId` / `pickerSettle` / `setPickerSettle` / `settlePicker` 全部由 `installSessions`（`src/sessions/index.ts:151-184`）与 `installCommands`（`src/commands/index.ts:128-129,224`）注入。install 前这些字段是 `undefined`：`undefined === null` 为 **false**，于是代码会继续走到 `app.slices.sessions.live.get(...)`（`live` 未定义 → `TypeError: Cannot read properties of undefined`）或 `app.slices.agent.settlePicker(null)`（→ `TypeError: settlePicker is not a function`，且该异常发生在 `new Promise` 执行器内部，会把 `openPicker` 的返回 promise 变成 rejected，而不是「打开一个选择器」）。`scripts/app-ops-check.mjs` 只在完整 install 链**之后**断言注入，覆盖不到 t=0。

**可达性**：当前调用点都在 boot 之后，因此**未观察到线上触发**（这也是只给 low 的原因）；但内核把这些 API 当 t=0 原语宣传（app.ts:392-401 注释「the mechanism exists from t=0」），而同一类失误在本仓库已真实发生过并留下记录——`docs/ARCHITECTURE.md:182-185`「install 期不得读他域（违反即未定义调用——I2 实测两次踩中…均以 TypeError 静默挂掉为代价发现）」。

**建议修法**：判空统一用 `?? null`/可选调用（`app.slices.agent.settlePicker?.(null)`、`app.slices.sessions.live?.get(...)`），或在 createApp 里给 `ui.activeFeed`、`agent.*Settle` 这类被内核自身引用的槽位预置 no-op 实现（`app.slices.ui.activeFeed` 已有先例：app.ts:542 与 sessions/index.ts:181 各实现了一份完全相同的逻辑，建议只留一份）。

---

## 8. [risk / low] `registerCommands` 对重名命令「静默拒绝」，扩展方拿不到失败信号

**位置**：`src/kernel/app.ts:499-514`（去重策略）、`src/kernel/app.ts:546`（提示通道）、`src/ext-api/index.ts:401-425`（外部注册路径）

```ts
for (const s of specs) {
  if (app.commandSpecs.some((e) => e.name === s.name)) {
    app.notice(`⚠ 命令 ${s.name} 已注册，忽略重复`)   // install 期调用 → 见第 1 条，被丢弃
    continue
  }
  app.commandSpecs.push(s); accepted.push(s)
}
return accepted
```

**机制**：`commands-a.md`/本单元均已确认内部 62 条命令无重名，所以该分支实际只有外部扩展会走。而 `tui.registerCommands(cmds)`（ext-api:401-425）**只返回一个 disposer**：被拒的条目不出现在 `mine` 里，扩展方无法区分「注册成功」与「被静默忽略」——它的命令永远不会出现在补全菜单，disposer 也不做任何事。若注册发生在 install 期/无会话窗口，连那条 `notice` 也一起被丢掉（第 1 条机制）。此处与 `registerNvimNotification` 的语义**相反**（`src/kernel/rpc.ts:16-24`：同 owner 重注册按「幂等覆盖」处理并留 `console.warn`），两级注册表策略不一致。

**建议修法**：让重名成为可观测结果——`registerCommands` 返回 `{accepted, rejected}`（或把 rejected 写进 `exitDiag`），ext-api 侧把 rejected 通过 `tui.notify`/返回值告知调用方；若确实需要「同 owner 覆盖」语义，则对齐 `rpc.ts` 的幂等覆盖 + warn。

---

## 9. [deadcode / low] `${dumpPath}.applies` 是只写不读的调试残留，且是 createApp 内唯一无 try/catch 的同步文件写

**位置**：`src/kernel/app.ts:540`

```ts
if (headless) appendFileSync(`${dumpPath}.applies`, `apply ${new Date().toISOString()}\n`)
```

**证据**：`grep -rn "applies" src scripts nvim docs README.md CHANGELOG.md`（含 git 历史 `git log -S".applies"` / `git grep`）只命中这一处写入与若干无关词（`settings.applies` 字段、feed 注释等）——**没有任何读取方、断言方或文档描述**；`scripts/e2e.ts:22` 只 `unlinkSync(dumpPath)`，不清 `${dumpPath}.applies`，因此每次 headless apply 都会在 `/tmp`（或用户配置的目录）追加一行且永不回收。同文件其他落盘路径都做了保护（`app.ts:483-486`、`lifecycle.ts:22-25`），`headless.ts:26-47` 的 dump 写入也在 try/catch 内。

**附带风险**：若 `config.dumpPath` 的父目录不存在（用户自定义路径），这次 `appendFileSync` 会**在 createApp 内同步抛出** → cordis apply 失败、TUI 整体挂不上；headless 之外的路径不写该文件，所以只在 headless 模式暴露。

**建议修法**：直接删除该行（纯调试残留）；若确实要保留 apply 计数，则包 `try/catch` 并让 e2e 真正断言它，同时把文件放进 `spawned.dir` 之类的临时目录而非用户配置路径。

---

## 10. [deadcode / low] `openLivePicker` 在 createApp 内被定义两次，第一份永不生效

**位置**：`src/kernel/app.ts:472-477`（App 字面量内的定义）与 `src/kernel/app.ts:565-570`（createApp 返回前的再次赋值）

两份实现逐字等价（`pick: app.openPicker(title, items)` + `update` → `luaCall('require("dsh_tui").update_picker(...)')`）。`app` 对象直到 `app.ts:610` 才 `return`，中间没有任何外部代码能观察到它，因此在 570 行赋值之后 472-477 行那份**不可达**。`scripts/check-arch.mjs` 的 `MOVED_SERVICES` 哨兵只校验 `app.<x> =` 形式的搬迁，不覆盖字面量内的重复定义。

**建议修法**：删除 472-477 行（保留 565-570），或反过来只留字面量内一份并删掉 565-570 的重复赋值。

---

## 11. [risk / low] `SessionRec` 的尾随索引签名让 strict 失效：字段改名/拼错在编译期无声通过

**位置**：`src/kernel/app.ts:107-156`（`[key: string]: unknown` 在 155 行）

`SessionRec` 是跨模块最大的状态记录（约 30 个具名字段，被 feed / sessions / transcript / statusline / difficulty / vision / subagents 共同读写）。索引签名使其任意属性访问合法：`rec.difficulty`、`rec.modelRef`、`rec.visionTmp` 之类字段被重命名或拼错时，`tsc --strict` 不会报错（`unknown` 只在参与运算时才会暴露类型错误，纯赋值/存在性判断/透传都给不出信号）。本仓库正在做持续的 slice/状态重构（`docs/ARCHITECTURE.md` P0–P2、I1/I2），这类记录的编译期保护尤其重要。

**证据（既有结论、仍然存在）**：`docs/REVIEW-2025-09.md:112`「app.ts:135 SessionRec 尾随索引签名使拼错属性静默通过 strict」，代码未变（行号因文件增长移至 155）。可对照：`types.ts` 里的 `ChatMessage`/`MessageSourceLike` 索引签名是**必要的**（宿主消息结构可扩展），而 `SessionRec` 是本仓库自有结构，不存在该理由。

**建议修法**：删除索引签名；把确实动态的少量字段（如 `runningSince`、插件附加位）显式声明，或集中到一个 `dyn?: Record<string, unknown>` 字段，让其余字段恢复严格类型检查。

---

## 12. [risk / low] `ApprovalRequest.signal.removeEventListener` 声明了却从未被使用：abort 监听器只加不摘

**位置**：`src/kernel/types.ts:126-131`（声明）与 `src/commands/core.ts:695-697`（审批）、`716-718`（提问）

`ApprovalRequest.signal` 被声明为 `{ addEventListener: …; removeEventListener?: … }`，但全仓 `grep -rn "removeEventListener" src/` **只命中这一行类型声明**：审批/提问两条注册路径都只

```ts
// src/commands/core.ts:695-697（提问侧 716-718 同款）
request.signal?.addEventListener('abort', () => { app.slices.agent.abortApproval(entry) }, { once: true })
```

`{ once: true }` 只在 **abort 真的触发时**才注销：用户在浮窗里作答（settle）后宿主若不再 abort 该 signal，监听器与其闭包（持有 `entry`/`app`）就会一直挂在 signal 上。若宿主复用同一长生命周期 signal（例如 agent 级取消信号）承载多次审批/提问，这些监听器会逐次累积（每次审批一个），而声明的 `removeEventListener?` 从未被使用；若 signal 是 per-request 短命对象，则只是白声明的接口面。本地无法核对 0.1.5 宿主 signal 的生命周期，故按 low/中置信度记录。

**建议修法**：注册时保存 `cb`，在 settle/reject/abort 的各个出口 `request.signal?.removeEventListener?.('abort', cb)`（放弃 `{once:true}` 依赖）；或把该成员从类型里删掉，明确写下「监听器由宿主 signal 生命周期统一回收」的契约。

---

## 附：核查过但**不**认定为本单元缺陷的点（避免误报）

1. **`persistedHeader`（app.ts:47-54）形状归一化正确**：0.1.5 快照 `{header, revision, …}` → 返回 `header`；pre-0.1.5 直返 header → 走 `return item` 分支。两处唯一消费者（`src/sessions/index.ts:42,217`）都会用 `typeof h.id === 'string'` 过滤，`header` 缺失时不会崩。唯一小瑕疵：`header` 为 `null`/缺失时返回的是「快照本身」，随后被静默丢弃（无 `id`），没有诊断——影响极低，未单列。`inheritedEventCount` 落在 header 还是快照上，本地装的 0.1.2 宿主无法核对，故不作为结论。
2. **`liveSessions` 的 duck-type 形状成立**：`agents.get(id)`/`list()` + `Agent.session` 与 0.1.2 宿主类型一致（`dsh-agent/lib/types/index.d.ts:344,358`、`runtime-types.d.ts:66-69`），冷启动路径无缺陷（风险只在捕获时效，见第 4 条）。
3. **`activeSessionCwd`（app.ts:41-45）语义正确**：读 session 自身 `header.cwd`、无会话时回落 `process.cwd()`，5 个调用点（`sessions/commands/new.ts:17`、`commands/core.ts:304`、`commands/commands/image.ts:37`、`remember.ts:18`、`lines.ts:17,20`）均在 install 之后，符合注释契约。
4. **`openPicker` 的单槽 + 身份校验失败结算（app.ts:548-563）已正确**：对应上一轮 K5 的修复经复核有效（`if (app.slices.agent.pickerSettle === resolve)`）；同一模式未同步到目录选择器，见下条跨单元说明。
5. **`BUILD_VERSION='0.3.5'` 与 `package.json` 版本一致**；`lib/` 与全新编译产物逐字节一致；`tsc`（含 scripts 配置）零错误；`check-arch.mjs`、`app-ops-check.mjs` 通过。
6. **`ServiceMap` 的 24 个键全部有调用方**（`grep -o "svc('[a-z]*')"` 计数 24/24），无死键；`registerCommands` 去重分支在内部模块中不可达（62 条命令名全不重复）。

### 跨单元观察（属其他单元/文件，供汇总时归并，不计入本单元条目）

- `src/commands/core.ts:260-264`：目录选择器缺少内核已修的**身份校验失败结算**，陈旧 `luaCall` 迟到的 rejection 会清掉新 picker 的槽位 → 后续 `await` 永久挂起（`new.ts:17`、`lines.ts:17`、`attach.ts:19`、`dir.ts:15`、`workspace.ts:71`）。已由 `commands-a.md` 报告（其证据同样引用 `app.ts:556-562` 的修复注释），本单元不重复计数。
- `src/commands/index.ts:71,130,184` 三个 owner op（`setApproval`/`setQuestions`/`setDirSettle`）**零调用方**，而声明在 `app.ts:330,334,337`（本单元）。已由 `commands-core.md` §9 从实现侧报告；若采纳修复，注意接口成员需要在本单元文件里一并删除（`setApproval`/`setQuestions` 是**旧单槽语义**，将来被调用会绕过 `advanceApproval`/`advanceQuestions`，正是上一轮 R1/R2 的回归路径）。
- `src/kernel/app.ts:516-529` 的 `refreshCommandCatalog` 重发的是安装期冻结的 `desc` 字符串，`/locale` 切换后目录语言不变——已由 `commands-a.md` F5 报告（内核侧修法：spec 存 zh key，渲染处再 `t()`）。
- `scripts/check-arch.mjs:87-111` 的 `STATE_OWNERS`/`STATE_FIELDS` 只登记了 `src/commands/index.ts` 为 agent 域 owner，未登记 `src/commands/core.ts`、`src/commands/commands/*.ts`、`src/subagents/commands/subagents.ts`；这些文件存在直接切片写入（`core.ts:192,214,262,264,330,353`、`bell.ts:16-17`、`image.ts:20`、`subagents/commands/subagents.ts:74`），因此 `docs/ARCHITECTURE.md:170-186` 宣称的「跨域变更一律走 ops、check-arch 3c 双保险」在这些文件上并不成立。`STATE_FIELDS` 还漏了 `runtime.restartPending`、`runtime.childExitDuringBoot`、`agent.approvalQueue`、`agent.questionsQueue`。
- `src/kernel/types.ts:197`：`list?: () => Promise<Array<SessionHeaderLike | { header: SessionHeaderLike }> | Array<SessionHeaderLike | { header: SessionHeaderLike }>>` —— 联合两支类型**完全相同**，是无效冗余（复制粘贴残留），建议改为单支 `Promise<Array<…>>`。
