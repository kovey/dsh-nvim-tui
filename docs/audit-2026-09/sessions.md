# 审计报告：sessions

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（dsh-nvim-tui v0.3.5，适配 dsh 0.1.5-rc.1）
- 审计单元：`sessions`
- 必读文件（已逐行完整读完）：
  - `src/sessions/index.ts`（364 行）
  - `src/sessions/services.ts`（361 行）
  - `src/sessions/commands/sessions.ts`（166 行）
  - `src/sessions/commands/workspace.ts`（115 行）
  - `src/sessions/commands/archive.ts`（29 行）
  - `src/sessions/commands/rename.ts`（32 行）
- 交叉验证（grep / 读全文）：
  - 本仓库：`src/kernel/app.ts`、`src/kernel/types.ts`、`src/kernel/subagent-clean.ts`、`src/kernel/headless.ts`、`src/kernel/lifecycle.ts`、`src/boot/boot.ts`、`src/boot/session-events.ts`、`src/statusline/index.ts`、`src/transcript/index.ts`、`src/subagents/index.ts`、`src/subagents/commands/subagents.ts`、`src/commands/index.ts`、`src/commands/core.ts`、`nvim/lua/dsh_tui/session.lua`、`nvim/lua/dsh_tui/popups.lua`、`nvim/lua/dsh_tui/init.lua`、`scripts/smoke.ts`、`README.md`、`REQUIREMENTS.md`、`docs/REVIEW-2025-09.md`
  - 宿主 0.1.5-rc.1 实体（`~/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh`）：`dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-session-persistence`、`dsh-session-projection`、`dsh-session-projection-cache`、`dsh-session-title`、`dsh-subagent`、`dsh-workspace`、`dsh-base/cordis.patch.yml`
- 未修改任何源码文件。

结论：**2 条高危 bug**（后台 resume 会话泄漏；`activity==='running'` 语义误读导致已结束思考链永不清理并被反复复活），**3 条中危**（恢复会话丢失标题；`/sessions`「未分组」是死行；resume/create 无回滚导致半挂载 live 记录滞留），**7 条低危 / 死代码 / 风险**。

---

## 1. [bug / high] 后台 resume 的会话在「待重命名」被丢弃时永不释放（live 记录 + AgentHandle + nvim buffer 永久泄漏）

**位置**
- 泄漏点建立：`src/sessions/commands/sessions.ts:75-86`
- 唯一的释放点：`src/commands/core.ts:358, 377, 381`
- 丢弃 pendingRename 的两条路径：
  - `src/sessions/services.ts:206-213`（`switchTo` → `clearPendings()`）
  - `src/commands/index.ts:186`（`setPendingRename` 纯覆盖）、`src/commands/index.ts:189-194`（`clearPendings` 仅置 null）
- 该机制的存在理由：`src/sessions/services.ts:173-175`、`src/sessions/commands/sessions.ts:77-80`（注释明确「后台恢复的会话不得无限累积」）

**机制**

`/sessions` 行操作「重命名」对**仅持久化**的会话先做一次后台 resume，并把 `background: true` 记进 pendingRename，期望「下一个输入」提交时（`core.ts:351-384`）才 `disposeLiveSession`：

```ts
// src/sessions/commands/sessions.ts:75-86
if (app.liveSessions.get(sid) === undefined) {
  await ensureLiveSession(app, sid)      // 建立 live 记录 + AgentHandle + chat/reasoning buffer
  background = true
}
app.slices.agent.setPendingRename({ kind: 'session', id: sid, background })
```

但 `pendingRename` 是单槽且可被无副作用地清空/覆盖：

```ts
// src/commands/index.ts:186
A.setPendingRename = (v) => { A.pendingRename = v }     // 覆盖：不 dispose 旧目标
// src/commands/index.ts:189-194
A.clearPendings = () => { A.pendingRename = null; ... }  // 清空：不 dispose
```

而 `switchTo` 在**每一次会话切换**都会调用 `clearPendings()`（`services.ts:212`，`services.ts:207` 还专门读了 pendingRename 只为打印提示）。因此：

- 触发 A：行操作重命名 → 在输入新名字之前切换/打开任何其它会话（`/sessions` → 打开、nvim `dsh-session-select`、`/new`、`/fork`、boot 自动恢复…）→ pendingRename 被清空，`disposeLiveSession` 永不执行。
- 触发 B：连续两次行操作重命名（或随后用 `/workspace` 重命名工作区，`workspace.ts:90`）→ 前一个后台会话被覆盖，同样不释放。

`attachSession` 注册的资源是实打实的：live 记录（`services.ts:42-68`）、`AgentHandle`（宿主 agents registry 里注册的 agent）、以及 nvim 侧**每会话独立**的 chat/reasoning buffer（`nvim/lua/dsh_tui/session.lua:14-37` 每个 id 一个 buffer；只有 dispose 路径的 `close_chat`（`session.lua:134-146`）会回收）。泄漏后该会话还会继续以 `kind: 'live'` 出现在 `/sessions`（`sessions.ts:32-36`）里，且宿主 store 里已有它 → 之后再次重命名时 `app.liveSessions.get(sid) !== undefined`，`background` 变 false，连提交路径也不再释放。

**复现路径**
1. `/sessions` → 选一个「（历史）」会话 → 行操作 `重命名（下一条输入作为新名称）`；
2. 不输入名称，直接 `/sessions` → 打开另一个会话（或 `<C-n>`/`/new`）；
3. 重复 1-2 N 次：`app.slices.sessions.live.size` 持续增大，宿主 agents registry 中残留 N 个 agent，nvim 中残留 2N 个 buffer；进程退出才会释放。

**建议修法**
把「后台目标的生命周期」交给待重命名状态的所有权转移处处理，而不是交给消费点：
- 在 `setPendingRename` / `clearPendings`（`commands/index.ts`，或更合适：给 sessions 域加一个 `dropPendingRename()` op）中检测被替换/清空的 `{kind:'session', background:true}` 目标并 `void disposeLiveSession(id)`；
- 或让 `switchTo` 在调用 `clearPendings()` 之前显式结算：`const p = app.slices.agent.pendingRename; if (p?.kind === 'session' && p.background) void disposeLiveSession(p.id)`；
- 补一条回归：`smoke.ts` 断言「后台重命名 + 切换会话后 `live.size` 回落」。

---

## 2. [bug / high] `activity === 'running'` 被当作「回合进行中」：已结束的 continuable 子代理被永久标成运行中，TTL 清理永不触发，状态行幽灵计数在每次切换后被复活

**位置**
- 语义映射：`src/sessions/index.ts:53-60`
- 兜底路径同样的误读：`src/sessions/index.ts:71-75`
- 复活入口：`src/sessions/index.ts:86-101`（`seedRunningSubagents`）+ `src/sessions/services.ts:240`（每次 `switchTo` 都调用）
- 消费方：`src/statusline/index.ts:71-73`、`src/statusline/index.ts:183`；`src/subagents/commands/subagents.ts:17-28`、`:35-43`；`src/subagents/index.ts:214-216`
- 判定函数：`src/kernel/subagent-clean.ts:44-48`（`isExpired` 要求 `!running`）

**机制**

```ts
// src/sessions/index.ts:54-60
const children = entries.filter((e) => e?.kind === 'child').map((e) => ({
  ...
  running: e.activity === 'running',        // ← 误读
  ...
})).filter((c) => c.running || !hidden.has(c.id))
```

宿主 `ctx.subagents.listChildren()`（TUI 调用的正是这个「durable listing」）里的 `activity` **不是**「回合在跑」，而是「会话记录是否驻留在 session store」：

- `dsh-subagent/lib/index.js:2123-2127`：`const live = sessions.get(record.header.id)` → 语料 `live` 字段；
- `dsh-subagent/lib/index.js:2165`：`rows[index] = childRow(childId, identity, "running", ...)` —— **只要该子会话在 store 里驻留就填 "running"**；
- 真正的「Agent 驱动是否 running」只在 `catalogView`（`dsh-subagent/lib/index.js:79`：`agents?.get(entry.id)?.status === "running"`）里算，而它只服务 `remoteExportList`（浏览器 face），TUI 不走这条路；
- 类型文档也写明：`dsh-subagent/lib/types/control-types.d.ts:35-42`「`running` means the logical record is resident, `inactive` that it exists only in persistence … Neither encodes a durable outcome」。

对 **continuable** 子代理（可续聊，正是 TUI 主推的场景）其 child agent 在回合结束后**依然驻留**，于是 `activity` 恒为 `'running'`。连锁后果（全部有代码落点）：

1. `/subagents` 永远显示「· 运行中」（`subagents.ts:46`），`settledCount` 恒为 0 → 「🧹 清理全部已结束思考链」行永不出现（`subagents.ts:39-43`）；
2. TTL 清理永不生效：`expired = children.filter((c) => !c.running && isExpired(...))`（`subagents.ts:18`）恒为空 → `subagent-clean.ts:3-11` 声明的「超期思考链截断 + 隐藏」对 continuable 子代理整体失效；
3. 状态行幽灵计数：`seedRunningSubagents` 在**每次 `switchTo`** 把 `activity==='running'` 的孩子写回 `runningSubagents`（`index.ts:91-98`），而 `subagent/end` 只是 delete（`subagents/index.ts:322`）——切换一次会话幽灵就复活一次，`runningSubagentsOf()` 非空 → 状态行 running 徽标 + spinner 常亮（`statusline/index.ts:71-73, 183`）；
4. `subagents/index.ts:214-216`：给一个其实空闲的子代理发消息会打印「⏳ 已排队：子代理当前回合结束后处理」；
5. 反向漏网：`index.ts:60` 的 `c.running || !hidden.has(c.id)` 让「已清理（ledger 隐藏）但重新驻留」的子代理重新出现在列表里（续聊会冷恢复该 child）。

**复现路径**
1. 让主代理用 subagent/workflow 起一个 continuable 子代理并等它结束；
2. `/subagents` → 仍然显示「运行中」；等 72h 也不会出现清理行；
3. 切换到别的会话再切回来 → 状态行重新出现子代理 running 徽标（`subagent/end` 已删除过，被 seed 复活）。

**建议修法**
- `running` 只能来自事件（`subagent/start`/`subagent/end` 维护的 `runningSubagents`）或 `agents.get(childId)?.status === 'running'`（即宿主 catalogView 的口径）；把 `listChildren().activity` 仅当「驻留/可续聊」信息使用（例如列表用「已结束 · 可续聊」措辞）。
- TTL 清理不要依赖 `running`：改用「ledger 未记录 && createdAt 超期 && 非当前驻留事件」或以 `subagent/end` 的终态为准。
- `switchTo` 的 seed 应改为「对账」：只补 `runningSubagents` 缺失项，且以 agent 驱动状态为准，不要无条件写入。

---

## 3. [bug / medium] 恢复会话后标题丢失（回放不跑 `session/title` 钩子），`/sessions` 活会话行又没有历史标题兜底

**位置**
- 回放循环：`src/sessions/services.ts:160-171`
- 唯一写 `rec.title` 的地方：`src/boot/session-events.ts:184-193`
- `foldEvent` 无 title 分支：`src/statusline/index.ts:27-65`
- 消费点：`src/sessions/services.ts:42-44`（attach 时 `title: undefined`）、`src/sessions/services.ts:356-360`（`updateTitle`）、`src/sessions/commands/sessions.ts:27` vs `:35`、`src/commands/commands/status.ts:15`
- 需求：`REQUIREMENTS.md:246-247`（R-SESS-2「`/sessions` 浮窗显示标题 + 完整会话 id（`session/title` 事件…）」）

**机制**

标题在 0.1.5 里是**日志事件** `session/title`（`dsh-session-title/lib/index.js:177, 302` 追加，投影 `apply` 从事件取值），所以恢复时它一定在回放的事件流里。但 `doResumeSession` 的回放只做三件事：

```ts
// src/sessions/services.ts:163-168
rec.feed.appendNotice(`history replay: ${events.length} events`)
for (const event of events) {
  app.slices.ui.foldEvent(rec, event)        // 只折叠 usage/context/mode/policy/todo
  rec.feed.applyEvent(event, { history: true })
  app.slices.ui.maybePushFileDiff(rec.feed, event)
}
```

它**不经过** `boot/session-events.ts` 的 `MAIN_EVENT_HOOKS` 派发表，而 `rec.title` 的唯一写入点就在那张表里：

```ts
// src/boot/session-events.ts:184-193
'session/title': (rec, owner, event) => { ...; rec.title = data.title; ... }
```

全仓库 grep `rec.title` 仅此一处赋值（其余是读取）。于是 resume 完成后：`rec.title === undefined`，直到宿主**再次**追加新的 title 事件（用户重命名或新一轮自动命名）才会恢复。

用户可见后果（都是确定的代码路径）：
- `/status` 显示「（无标题）」（`commands/commands/status.ts:15`）；
- 终端标题变成 `dsh`（`services.ts:359` `rec?.title ?? 'dsh'`，OSC 2 由 `set_title` 写）；
- `/sessions` 列表里**活跃/已恢复会话那一行没有标题**：活会话列表循环只用 `rec?.title ?? ''`（`sessions.ts:35`），不放 `historyById` 兜底；而带兜底的写在工作区分组循环里（`sessions.ts:27` `rec?.title ?? hist?.title ?? ''`）。且历史行会被 `live.has(h.id)` 跳过（`sessions.ts:38`），所以没有任何一行能显示该标题。

**复现路径**
1. 建一个会话、发一句话让自动标题落盘（或 `/rename 我的会话`）；
2. 退出 dsh → 重新启动（自动 resume 该会话）→ `/status` 显示「（无标题）」；`/sessions` 中该会话行只有 id 没有标题。

**建议修法**
- 在 `doResumeSession` 回放时复用同一张钩子表（导出 hooks 或加一个 `app.slices.ui.applyHistoryEvent(rec, event)`），最低限度补 `session/title` → `rec.title`；
- `sessions.ts:35` 与 `:27` 统一为 `rec?.title ?? hist?.title ?? ''`。

---

## 4. [missing-feature / medium] `/sessions` 的「未分组」行是死行：README/REQUIREMENTS 宣称的分组从未实现

**位置**
- 行声明：`src/sessions/commands/sessions.ts:31`
- 无处理分支：`src/sessions/commands/sessions.ts:146-149`
- 相关过滤：`src/sessions/commands/sessions.ts:44-45`
- 文档：`README.md:43`、`README.md:334`、`README.md:339`

**机制**

```ts
// src/sessions/commands/sessions.ts:31
rows.push({ label: '未分组', value: 'ws:none' })
...
// src/sessions/commands/sessions.ts:146-149
if (sel.startsWith('ws:')) {
  const wid = sel.slice(3)                       // 'none'
  const w = workspaceRows.find((x) => x.id === wid)
  if (w === undefined) return                    // ← 静默 return，无 notice、无列表
```

工作区 id 由宿主分配为 UUID（`dsh-workspace/lib/index.js:485` `WorkspaceId(randomUUID())`），永远不可能是 `'none'`，因此这一行**在任何输入下都不可能匹配到工作区**，选中即静默返回（连「未知工作区」提示都没有）。而 README 明确把它算作浏览器的一环：「`/sessions` 工作区分组浏览器（📁 分组 + **未分组** + 归档隐藏…）」（`README.md:43`，另见 `:334`、`:339`）。

它同时是「没有工作区归属」的会话唯一的入口：既不在任何工作区（`w.sessionIds` 为空）、也不在 `historyHeaders`（要求 `h.cwd === process.cwd()`，`index.ts:245`）、且不在「其他目录」行（`sessions.ts:45` 显式 `h.cwd === undefined → continue`）的持久化会话——例如已归档以外的 `cwd` 缺失会话、以及在别的目录创建后从未 attach 的会话——在 `/sessions` 中**没有任何一行**能到达。

**复现路径**
1. `/sessions` → 光标移到「未分组」→ Enter：浮窗关闭、无任何反应、无提示；
2. （可选）造一个 `cwd === undefined` 的持久化会话：它在 `/sessions` 中完全不出现。

**建议修法**
实现它而不是删掉它：`ws:none` 分支列出「未被任何 workspace 计入且未归档」的会话（数据源现成：`all` 中的 `session-` 会话减去 `workspaceRows.flatMap(w => w.sessionIds)`），并给每行同样的行操作菜单；或至少把死行删掉并在 README 去掉「未分组」字样。

---

## 5. [risk / medium] resume / create / fork 都没有失败回滚：live 记录与 AgentHandle 会带着「半挂载」状态滞留

**位置**
- resume 半挂载：`src/sessions/services.ts:146-171`（`attachSession` 在 `:160` 已注册 live 记录，见 `:42-68`；随后 `:163-168` 的回放无 try/catch）
- 早退使记录无法自愈：`src/sessions/services.ts:135-144`
- 调用方的失败兜底：`src/sessions/index.ts:323-339`（`resumeOrFresh` 直接 `createSession()`）
- create / fork 泄漏：`src/sessions/services.ts:104-116`、`src/sessions/services.ts:288-303` + `:309-312`（catch 只 notice）
- 同类调用的确会抛：`src/sessions/services.ts:75-83`（`repairOrphanToolCalls` 被 try/catch 包裹）、`src/transcript/index.ts` 多处 `catch {}`

**机制**

`doResumeSession` 的顺序是「先注册、后回放」：`attachSession` 已经把 `live.set(id, {...})` 与 FeedRenderer 建好，紧接着的 `foldEvent` / `feed.applyEvent` / `maybePushFileDiff` 循环没有任何保护。任一条抛错（畸形事件、nvim 侧 render 失败、buffer 被外部 wipe…）都会：异常冒泡给调用方，而 **`live` 里的记录、AgentHandle、chat/reasoning buffer 全部留在原地**。之后：

- `ensureLiveSession` 的第一行 `if (app.slices.sessions.live.has(id)) return Promise.resolve(id)`（`services.ts:136`）会让后续任何一次打开**直接返回这条坏记录**，不再重新 resume → 该会话永久坏掉；
- boot 路径的 `resumeOrFresh` 捕获异常后 `createSession()` 新建会话并提示「恢复会话失败」，坏记录继续驻留（用户以为只是恢复失败）。

同类缺失还有两处：`createSession` 在 `agents.create` 成功之后才 `await attachSession(...)`，`attachSession` 内任一 `app.lua.ensureChat/ensureReasoning`（`services.ts:22, 30`）reject 时没有 `handle.dispose()`；`forkSession` 的 catch（`:309-312`）同样只提示不回收刚创建的 handle。

**复现/验证路径**
- 静态可证：`services.ts:146-171` 无 try/catch，`live.set` 在 `services.ts:42` 早于回放；`resumeOrFresh`（`index.ts:335`）只新建不清理。
- 动态复现（可选）：临时让 `foldEvent` 对某个 `turn/end` 抛错，或断开 nvim channel 后 `/sessions → 打开历史会话`，观察 `live` 中残留条目且再次打开直接返回。

**建议修法**
- 把 `doResumeSession` 的回放包进 try/catch：失败时 `live.delete(sid)` + `await handle.dispose()` + `close_chat`（复用 `disposeLiveSession` 主体）后再 rethrow；
- `createSession`/`forkSession` 用 try/catch 包住 `attachSession`，失败时 `await handle.dispose()`；
- 给 `ensureLiveSession` 的早退加健康判定（例如记录 `attachFailed` 标记，允许重试一次）。

---

## 6. [risk / medium] `disposeLiveSession` 先删表项再 await dispose：该窗口内的 resume 会撞上宿主的 "session already exists"

**位置**
- `src/sessions/services.ts:176-189`（`:180` `live.delete(id)` 早于 `:182` `await rec.handle.dispose()`）
- 去重只覆盖并发调用：`src/sessions/services.ts:135-144`
- 调用方是 fire-and-forget：`src/commands/core.ts:358, 377, 381`
- 同族历史缺陷：`docs/REVIEW-2025-09.md` S2（双 live 记录 / 双 FeedRenderer 写同一 buffer）

**机制**

宿主的 `AgentRegistry.resume` 最终走 `ctx.sessions.prepare(id, …)`，而 `dsh-session/lib/index.js:1380` 明写：

```js
if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
```

`disposeLiveSession` 在 `handle.dispose()` **完成之前**就把记录从 `live` 里删掉，`ensureLiveSession` 又只查 `live` + in-flight 表（`services.ts:136-138`），于是「dispose 进行中 + 用户马上打开同一会话」时，`doResumeSession` 会调用 `agents.resume(id)` 撞上仍在册的会话 → resume 直接失败（命令 guard 弹 notice：「恢复失败 … already exists」），同时还存在旧的 FeedRenderer 尚未释放、与新记录共写同一 chat buffer 的窗口（正是 S2 修的那类症状，只是窗口从「并发调用」挪到了「dispose 期间」）。

**复现路径**
1. `/sessions` → 历史会话 → 重命名（后台 resume，`background:true`）→ 输入空行（`core.ts:355-359`）触发 `void disposeLiveSession(id)`；
2. 立刻再 `/sessions → 打开` 该会话：可能得到 "session … already exists"（取决于 dispose 是否已把 session 移出 store）。

**建议修法**
- `disposeLiveSession` 改为「先 dispose、后 delete」，并把操作中的 id 放进 in-flight（或 `disposing`）集合，`ensureLiveSession` 先 `await` 该集合中的 Promise；
- 或在 `ensureLiveSession` 里加一道宿主口径的判定：`app.liveSessions.get(id) !== undefined` 时不要发起 `agents.resume`（应等待/复用在册记录）。

---

## 7. [bug / low] `/rename` 把可能为 `undefined` 的 live session 直接交给宿主 `sessionTitle.rename`，与同族路径的守卫不一致

**位置**
- `src/sessions/commands/rename.ts:22-24`
- 对照实现（有守卫）：`src/commands/core.ts:372-373`

**机制**

```ts
// src/sessions/commands/rename.ts:12-24
const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
if (!rec) { app.notice(t('无活跃会话')); return }
...
sessionTitle.rename(app.liveSessions.get(rec.id), title)   // ← 只保证 TUI 侧 live 有记录
```

`rec` 来自 TUI 的 `live` map，`app.liveSessions.get()` 读的是宿主 agents registry（`kernel/app.ts:423-431`）。两者的生命周期并不完全重合：宿主侧 agent 被回收/卸载（loader reload、owner fiber 释放、外部客户端接管）后，TUI map 仍可能留着记录，此时传参为 `undefined`。同族的行操作重命名路径对同一表达式**显式判空**并给出可读提示（`core.ts:372-373`「会话已不在线（可能已退出或未成功恢复），无法重命名」），`/rename` 却直接调用宿主 API（`dsh-session-title` 会对 session 调 `append`），只能靠 `catch` 兜住，用户看到的是原始 TypeError 文案而不是「会话已不在线」。

**建议修法**
在 `rename.ts` 里加同一条守卫：

```ts
const live = app.liveSessions.get(rec.id)
if (live === undefined) { app.notice(t('会话已不在线（可能已退出或未成功恢复），无法重命名')); return }
sessionTitle.rename(live, title)
```

---

## 8. [risk / low] `dsh-session-new` 的宿主侧入口在产品内是孤儿路径，且实现与 `/new` 的目录口径不一致

**位置**
- 通知注册：`src/sessions/index.ts:302-305`
- 唯一生产者：`nvim/lua/dsh_tui/popups.lua:585`（浮动列表内 `<C-n>`）→ `:646-651` → 导出 `nvim/lua/dsh_tui/init.lua:207, 211-212`
- 对照口径：`src/sessions/commands/new.ts:17`（`openDirPicker(activeSessionCwd(app))`）、`src/kernel/app.ts:38-45`（`activeSessionCwd` 存在的理由）
- 唯一调用者（仅测试）：`scripts/smoke.ts:165, 692, 1154-1167`

**机制**

`grep -rn "show_session_list" src/ lib/ examples/ docs/` 只命中 Lua 定义与 smoke 测试；runner 侧从不调用它——`/sessions` 已由 Node 端 `app.openPicker` 接管（`commands/sessions.ts:50`），`sessionEntries`（`refreshList` 维护，`index.ts:263-276`）也只被 headless dump 读取（`kernel/headless.ts:29`）。也就是说：那条 `<C-n>` 键位在产品内没有任何入口，只有 `scripts/smoke.ts:1166` 手工驱动过它。

一旦被触发（用户自写 keymap / 扩展调用），`createSession()` 不传 `cwdPath` → `process.cwd()`（`services.ts:93`），而 `/new` 用的是 `activeSessionCwd(app)`。在「恢复了另一个目录的会话」的场景下，新会话会被静默创建在 shell 目录而不是用户当前工作的项目目录（`kernel/app.ts:38-45` 的注释正是为这个场景写的）。

**建议修法**
- 要么删掉孤儿浮动列表 + 该通知（连同 `sessionEntries`/`refreshList` 的消费者说明），要么把它接回产品（例如 `/sessions` 的 nvim 原生浮窗模式）；
- 若保留，handler 改为 `app.slices.sessions.createSession(activeSessionCwd(app))` 或直接复用 `/new` 命令实现，避免两套口径。

---

## 9. [deadcode / low] `AppSlices.sessions.attachSession` 槽无任何调用方

**位置**
- 接口声明：`src/kernel/app.ts:240`
- 默认值：`src/sessions/index.ts:169`；赋值：`src/sessions/index.ts:279`

**证据（全局 grep）**

```
$ grep -rn "sessions\.attachSession\|attachSession(" src/ lib/ scripts/ examples/ nvim/ | grep -v "w\.attachSession"
src/sessions/index.ts:279:  app.slices.sessions.attachSession = (handle, modelRef) => attachSession(app, handle, modelRef).then(() => {})
src/sessions/services.ts:116 / :160 / :303   # 都是模块内部直接调用 attachSession(app, ...)
lib/sessions/services.js:113 / :156 / :300
lib/sessions/index.js:287                     # 构建产物同源
```

即：模块内部一律直接调 `attachSession()` 函数，`app.slices.sessions.attachSession` 这个跨模块 op（含 `kernel/app.ts` 的契约声明与 `index.ts:169` 的 no-op 默认）从未被任何文件使用。`w.attachSession`（工作区实体方法）与它无关。属于契约层的死接口，容易误导出「外部模块可挂载会话」的假象。

**建议修法** 删除该 slot（声明 + 默认 + 赋值），或明确它是对外扩展 API 并补文档/示例。

---

## 10. [risk / low] `switchTo` 先改 `activeId` 再 await `lua.setActive`，失败无回滚

**位置** `src/sessions/services.ts:214-215`（配合 `:241` 的 `recordState`）

**机制**

```ts
WSS(app.slices.sessions).activeId = id
await app.lua.setActive(id)          // 失败即抛出，activeId 已切走
...
if (app.slices.sessions.live.has(id)) app.slices.sessions.recordState(id)
```

若 `setActive` 的 RPC 失败（nvim 正在退出/断连），TUI 侧 `activeId` 已指向新会话，而 nvim 仍显示旧会话的 buffer：此后所有 `activeFeed()`/notice/事件折叠都写到新会话的 feed（用户在看的却是旧 buffer）；`updateTitle`、`updateStatusline` 也基于新会话。异常最终由命令 guard 变成一条 notice，状态却不复位。同类条目在 `docs/REVIEW-2025-09.md`（低优先清单）里已被记录但仍未修。

**建议修法** 先 `await app.lua.setActive(id)`，成功后再写 `activeId`（并保留失败时的旧值），或失败时回滚 `activeId` 到切换前的值并提示。

---

## 11. [bug / low] 标题投影回退用了签名不兼容的服务，异常被本地 try/catch 吞掉（该回退永远拿不到标题）

**位置**
- `src/sessions/index.ts:225-235`
- 类型把两个宿主服务混为一谈：`src/kernel/types.ts:302-308`（`sessionProjections` 与 `sessionProjectionCache` 共用同一个含 `cachedSnapshot(meta, inheritedEventCount, keys)` 的接口）

**机制**

```ts
// src/sessions/index.ts:225-235
const projections = app.svc('sessionProjectionCache') ?? app.svc('sessionProjections')
const cachedTitle = (h) => {
  if (typeof projections?.cachedSnapshot !== 'function') return undefined
  try {
    const snap = projections.cachedSnapshot(h, h.inheritedEventCount ?? 0, ['title'])
    ...
  } catch { return undefined }
}
```

`sessionProjections`（投影注册表）的同名方法是**另一个签名**且需要 live Session：

```js
// dsh-session-projection/lib/index.js:165-172
cachedSnapshot(session, keys) {
  const selected = keys === void 0 ? void 0 : new Set(keys);   // keys=0 → TypeError: 0 is not iterable
  ...
  const cell = registration.cells.get(session);                 // 入参应是 Session 对象
```

TUI 传的是 `(header, 0, ['title'])`：第三参 `0` 会先让 `new Set(0)` 抛 TypeError（被这里自己的 `catch` 吞掉，返回 undefined），即便不抛，`cells.get(header)` 也永远取不到 cell。也就是说 —— 注释里那句「fall back to the base registry for profiles that expose the read there」所承诺的回退，在任何 profile 下都不可能生效；标题会静默缺失（当前 `dsh-base/cordis.patch.yml:162-163` 默认挂载了 `session-projection-cache`，所以现实影响仅限于去掉该插件的自定义 profile）。

**建议修法** 只认 `sessionProjectionCache`（缺失则不做标题回退并保持 `h.title` 兜底）；若确实要支持注册表，用 `sessionProjections.snapshot(liveSession, ['title'])` 并传入 live Session；同时在 `kernel/types.ts` 里把两个服务的 `cachedSnapshot` 拆成各自的签名，让 tsc 能拦住这类误用。

---

## 12. [risk / low] `listSubagentChildren` 静默丢弃宿主上报的 diagnostic 行（不可读子代理从目录里消失）

**位置** `src/sessions/index.ts:51-63`

**机制**

```ts
// src/sessions/index.ts:54-61
const children = entries.filter((e) => e?.kind === 'child').map(...)
  .filter((c) => c.running || !hidden.has(c.id))
if (children.length > 0 || entries.some((e) => e?.kind === 'child')) return children
```

宿主的 `listChildren` 除 `kind:'child'` 外还会返回诊断行：`dsh-subagent/lib/types/control-types.d.ts:55-69`（`kind:'diagnostic'`，`reason: 'corrupt' | 'unavailable' | 'unsupported'`；live 分支的 fold 抛错也会产出 corrupt 行，见 `dsh-subagent/lib/index.js:2154-2162`）。TUI 只映射 `child`：

- 当同一父会话**同时**存在健康子代理与诊断子代理时（`children.length > 0` 成立）直接 `return children`，诊断行被静默丢弃 → 该子代理在 `/subagents` 中完全不可见，既无法回放也无法纳入 TTL 清理；
- 只有在「全部是诊断行」时才落到本地兜底扫描（`:64-81`，按 `parentSession + origin==='subagent'` 重建），语义与宿主的 reason 不同（一律显示「已结束」）。

**建议修法** 把诊断行保留为列表条目（例如 `label: '⚠ 无法读取（corrupt）'` + 不可选中或仅「尝试打开」动作），至少在丢弃时打印一次 notice；同时修正 `entries.some(...)` 这个只认 `child` 的早退条件。

---

## 附：复核过但未单列的问题（低价值 / 已有记录 / 证据不足，供后续参考）

1. `refreshList`（`sessions/index.ts:263-276`）不按 `archivedSessionIds` 过滤 → `sessionEntries` 里仍含已归档会话；当前唯一消费者是 headless dump（`kernel/headless.ts:29`），产品内无可见影响。同项见 `docs/REVIEW-2025-09.md`（低优先清单）。
2. `isZstdArtifact`（`sessions/index.ts:105-110`）用 `readFileSync(path).subarray(0,4)` 为比对 4 字节魔数把整个会话日志读进内存；仅 pre-0.1.5 宿主可达（`supportsRawArtifacts`），0.1.5 上是死路径。建议 `openSync`+`readSync` 只读 4 字节。
3. `cleanSubagentChain`（`:116-147`）在 0.1.5 上只剩「隐藏 + `workspaceRegistry.archiveSession(childId)`」；`subagent-clean.ts:3-11` 文件头仍宣称用 `truncateStored` 截断（宿主 0.1.5 `sessionPersistence` 只有 `list/stat/open/create/flush`，无 `truncateStored`/`inspect`/`locate`/`readRaw`），注释与实现不符（`docs/REVIEW-2025-09.md` 已记）。`writeFileSync(path + '.tmp')` + `renameSync` 无 fsync（非原子），且 `writeCleanedIds` 吞错。
4. `resumeSession`（`services.ts:192-198`）里 `if (sid === undefined) return` 不可达：`doResumeSession` 只返回 `sid: string` 或 reject（`ensureLiveSession` 的 `Promise<string | undefined>` 联合类型没有对应实现路径）。
5. `/workspace add <目录> [标题]`（`workspace.ts:24`）用空白切分，路径含空格时会被截断并把余下部分当标题（`/workspace add /Users/me/My Project` → path=`/Users/me/My`）；宿主 `create` 会 realpath+stat，通常以可见错误收场，故未列为缺陷。
6. `sessions.ts:150-155`「新建会话于此工作区」只把 `meta.cwd` 设为工作区路径、不调用 `w.attachSession(sid)`；宿主 `WorkspaceEntity.sessionIds`（`dsh-workspace/lib/index.js:87-89`）是「显式账目 ∩ cwd 索引」，官方控制器在 create 后会显式 attach（`dsh-api-session-controller/lib/index.js:583-592`），所以该新会话不会出现在工作区分组下（README:339 把「需显式移入」写成了预期行为，而「未分组」行又是死行，见第 4 条）。
7. `/archive`（无参）默认归档**当前**会话（`archive.ts:12-13`），归档后自动恢复会跳过它（`index.ts:348-354`），而宿主 0.1.5 没有 unarchive API（`dsh-workspace/lib/types/index.d.ts` 仅有 `archiveSession`）——单向操作且无二次确认；可用 `/search` 重新打开该会话，故未列为缺陷。
8. `listSubagentChildren` 调 `subagentsSvc.listChildren(parentId)` / `persistence.list()` 时不传 `AbortSignal`（`index.ts:41, 53`），且 `seedRunningSubagents` 在每次 `switchTo` 都会触发一次完整列表扫描（`:86-88`, `services.ts:240`）：宿主侧对冷子会话可能走 `observeSession`（读日志）路径，子代理越多切换越慢；配合第 2 条（永不清理由）成本单调增长。未单列是因为缺少可量化的超时契约。
9. `docs/REVIEW-2025-09.md` 低优先清单中仍成立、本次复核确认未修的项：`switchTo` 无回滚（本次列为第 10 条）、`refreshList` 不过滤归档（本附注 1）、`subagent-clean` 注释不符（附注 3）、「新建会话于此工作区」不 attach（附注 6）。
