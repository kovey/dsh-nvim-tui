# 审计报告：transcript-statusline（`src/transcript/**` + `src/statusline/**`）

- 单元：`transcript-statusline` — 转录自愈（surfaceOp startSeq/endSeq 外科修复）/ rewind / 队列·inbox / 状态栏段折叠与渲染 / jobs 心跳
- 审计对象（全部用 read 全文读完，共 1061 行）：
  - `src/transcript/index.ts`（362）、`src/transcript/commands/queue.ts`（66）、`rewind.ts`（86）、`export.ts`（25）、`trajectory.ts`（49）
  - `src/statusline/index.ts`（379）、`commands/glance.ts`（37）、`cost.ts`（25）、`density.ts`（16）、`whale.ts`（16）
- 关联核对（grep/read）：`src/kernel/{app,types,host-events,difficulty}.ts`、`src/boot/{boot,session-events}.ts`、`src/sessions/{index,services}.ts`、`src/feed/{feed,stats,whale,diff}.ts`、`src/commands/{core,index}.ts`、`src/commands/commands/workflow.ts`、`nvim/`、`scripts/smoke.ts`、`README.md`、`REQUIREMENTS.md`、`CHANGELOG.md`、`docs/REVIEW-2025-09.md`
- 宿主核对（关键：本机真实运行宿主 = dsh **0.1.5-rc.1**，装在 profile 里）：
  - `/Users/zhangyong/.dsh/profiles/node_modules/@deepseek-ai/dsh-session`（0.1.5-rc.1）
  - 对照旧版：`<repo>/node_modules/@deepseek-ai/dsh-session`（0.1.2-rc.1，devDependency）
  - 另核对 `dsh-jobs` / `dsh-jobs-local` / `dsh-agent` / `dsh-agent-loop` / `dsh-workflow` / `dsh-session-stats` / `dsh-llm` / `dsh-llm-deepseek` 的 `.d.ts` 与 `lib/index.js`
- 方法：
  1. 全文精读 + 全局 grep 查证调用方（凡判定死代码均附 grep 证据）；
  2. **不改源码**的行为探针：直接用真实 0.1.5-rc.1 的 `dsh-session` 构造 `Session`，复刻插件在 `transcript/index.ts:65-91` 写下的 append/surfaceOp 信封，观察宿主校验结果（脚本 `/tmp/probe1.mjs`、`/tmp/probe2.mjs`，命令与输出见 F1）；
  3. 交叉核对 grep 宿主实现（`isReplaceOp` / `assertProvenance` / `assertToolResultRewrite` / `validateSessionEventData`）与插件注释所声称的语义。

结论：**发现 9 项**（bug 4 / missing-feature 3 / risk 1 / deadcode 1），按严重度排序。F1 是本次审计的头号问题：它让 0.2.9 起宣称的"崩溃后已继续对话的会话"自愈路径在 0.1.5 上**完全失效且静默**。

---

## F1. 非尾部自愈在 dsh 0.1.5-rc.1 上必然抛错并被 `catch {}` 吞掉——毒化会话依旧 400，用户零提示 — bug / 高

**位置**：`src/transcript/index.ts:86-91`（`surfaceReplace`）、`:176-185`（非尾部修复的调用与吞异常）、`:189-201`（因此永不执行的中和循环）。

**机制**：

```ts
// src/transcript/index.ts:86-91 —— surfaceReplace 永远带上 sourceEventSeqs
const surfaceReplace = (session, type, seq, data) => {
  session.append(type, data, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
}
// :176-185 —— 非尾部（崩溃后又发过消息）分支
try {
  surfaceReplace(session, 'assistant/message', seqA, { turn, step, message: { ...original, content: rebuilt } })
  repaired++
} catch { continue }        // ← 0.1.5 上必然走到这里：静默、repaired 不增、后续中和循环被跳过
```

宿主 0.1.5-rc.1 在 `assertProvenance` 里对 `assistant/message` 加了**禁止携带 `sourceEventSeqs`** 的新校验，而 replace 又要求 `sourceEventSeqs` 覆盖全部被遮蔽节点 —— 二者叠加使 **assistant/message 的位置替换在该宿主上不可能成立**：

```
$ grep -n "embeds its source stream" \
    /Users/zhangyong/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js
283:  if (event.type === "assistant/message" && raw !== void 0)
        throw new Error("assistant/message embeds its source stream and cannot carry sourceEventSeqs");
308:  const missing = shadowedSeqs.filter((seq) => !sources.has(seq));
310:  if (missing.length > 0) throw new Error(
        `surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(", ")}`);
```

用真实宿主 `foldSurface`（同一套 `planSurfaceEvent` → `assertProvenance`）实测三种信封：

```
$ node /tmp/probe1.mjs
A replace assistant w/ sourceEventSeqs => THROW: assistant/message embeds its source stream and cannot carry sourceEventSeqs
B replace assistant w/o sourceEventSeqs => THROW: surface replace: sourceEventSeqs must include every shadowed surface node; missing 1
C replace tool/result w/ user note    => OK nodes= [0,1,3]
```

`probe2.mjs` 用真 `Session.append` 复刻 `surfaceReplace` 的**完全相同的入参**：

```
$ node /tmp/probe2.mjs
A tail synthetic tool/result append => OK seq 3 nodes [0,1,2,3]      ← 尾部路径正常（不是问题）
B => THROW: assistant/message embeds its source stream and cannot carry sourceEventSeqs
C tool/result -> user note replace => OK nodes [0,1,2,4]
```

**这是 0.1.5 迁移引入的回归**：0.1.2-rc.1 的 `assertProvenance` 没有这条禁令（`grep -n "embeds its source stream" node_modules/@deepseek-ai/dsh-session/lib/index.js` → 无匹配；其 176 行反而是 `sourceEventSeqs must not be empty **except on assistant/message**`）。v0.3.5 只把 `start/end` 改成了 `startSeq/endSeq`（`CHANGELOG.md:23`），恰好撞上新禁令。

**后果**（对照 `CHANGELOG.md:869-886` 的承诺与 `src/sessions/services.ts:73-81` 的提示）：

1. 崩溃后又继续发过消息、或进程崩溃后恢复再继续的会话（CHANGELOG 提到的 php 263 轮真实案例），`repairOrphanToolCalls` 走非尾部分支 → 抛错 → `continue`；
2. 第 189-201 行的中和循环（本该把 v0.2.8 错位的合成 tool/result 节点换成普通文字）**永不执行**，因此悬空 `tool_calls` + 错位 `role=tool` 依旧存在，DeepSeek 每轮仍 400 `insufficient tool messages`；
3. `repaired` 保持 0 → `services.ts:79` 的 `if (repaired > 0)` 不成立 → **用户看不到任何 ♻ 提示**，只有 `catch { continue }` 内部的静默；层内还有 `boot`/`host-events` 的 diag（`kernel/host-events.ts:33-38`）也不会记录，因为异常在调用栈内部就被吃掉了；
4. 修复入口每次 attach/open 都会跑（`src/sessions/services.ts:78` 是唯一调用点），所以每次恢复都重复失败一次，没有任何自愈可能。

**复现路径**：真实宿主上构造一个面（surface）形如 `[user, assistant(tool_calls 未配对), user…]`，调用 `app.slices.trans.repairOrphanToolCalls(rec)`；或直接跑上面两条探针（无需任何插件运行环境）。

**建议修法**（宿主允许的能力边界已被探针界定）：

- 非尾部分支改为"整段替换为 `user/message` 节点"：`surfaceOp:{op:'replace',startSeq:asstSeq,endSeq:lastOrphanResultSeq}` + `sourceEventSeqs:[…全部被遮蔽seq]`，事件类型用 `user/message`（探针 C 证明 tool/result→user 的单节点替换合法，`assertToolResultRewrite` 只约束"替换事件本身是 tool/result"的情形，见宿主 `lib/index.js:346-347`），把原 assistant 文本与"工具调用未执行"说明一起写进该 user 消息正文；
- 或最小改动：把 `:177` 的类型换成 `user/message`（内容=原文 + 说明），并保留 189-201 的中和循环；
- 无论哪种，**禁止裸 `catch { continue }`**：改为 `catch (e) { app.exitDiag('transcript-repair', …)` / 计数失败并在 `services.ts` 侧提示"自愈失败，可用 /fork 派生"，否则同类宿主 API 变更会继续静默失效；
- 建议给 `repairOrphanToolCalls` 加一条针对 0.1.5 的 smoke 断言（真实 `foldSurface` 复算修复后的 wire 配对），当前 `scripts/smoke.ts` 对 `repairOrphanToolCalls/surfaceReplace` **零覆盖**（`grep -n "repairOrphan\|surfaceOp" scripts/smoke.ts` → 无匹配）。

---

## F2. `/rewind` 重建把同一 SessionRec 的用量再累加一遍，状态栏 Σ/成本/缓存/上下文全部虚高 — bug / 中

**位置**：`src/transcript/commands/rewind.ts:60-75`（截断 + 重放）；累加语义在 `src/statusline/index.ts:27-35`（`foldEvent`）。

**机制**：

```ts
// statusline/index.ts:28-35 —— foldEvent 是"累加"语义，不是"重算"
rec.usage = foldUsage(rec.usage ?? EMPTY_USAGE, event.data.usage)
rec.lastUsage = foldUsage(EMPTY_USAGE, event.data.usage)
// rewind.ts:64-73 —— 对同一个 rec 重放截断后仍存在的全部事件，且从不重置 rec.usage
rec.feed.clear()
app.slices.ui.renderedDiffCalls.delete(rec.feed)
for (const e of app.slices.trans.sessionEvents(session)) {
  app.slices.ui.foldEvent(rec, e)      // ← usage 在旧值上继续累加
  rec.feed.applyEvent(e, { history: true })
  app.slices.ui.maybePushFileDiff(rec.feed, e)
}
```

截断只是把日志尾部丢掉，`rec.usage` 仍是**截断前**的全会话累计值；重放又把这批事件加一遍。结果：状态栏 `Σ`（`statusline/index.ts:232-234`）、`$cost`（`:286-288`）、`缓存 %`（`:216-218`）、`上下文 %`（`:219-226`）与 `/cost`（`statusline/commands/cost.ts:14-19`）在回退后一律翻倍/虚高（`上下文 %` 还会被 `Math.min(1, …)` 顶到 100%）。`rec.cacheReported`（:33）、`rec.todos/lastUsage` 之外的派生状态（`goal`/`planActive`/`jobsCache`/`committedJobsKey`/`difficulty`/`toolErrors`/`lastAssistantMessageId`/`deliverables`）也**完全没被重置或重放**——回退后它们仍是"未来"的值。

`docs/REVIEW-2025-09.md:156` 已把"rewind.ts 截断后 SessionRec 派生状态（goal/plan/todos 等）不同步"列为**未修复项**，但未指出 usage 的翻倍后果。

**复现路径**：任一有两个回合的会话 → `/rewind 1`（走确认弹窗）→ 观察状态栏 `Σ` 与 `/cost` 的 billed 输入是否 ≥ 回退前（正确行为应为"仅统计保留部分"）。

**建议修法**：重放前显式重置派生状态（`rec.usage = undefined; rec.lastUsage = undefined; rec.todos = null; rec.jobsCache = new Map(); rec.committedJobsKey = ''; rec.committedJobKeys = new Set(); rec.goal = null; rec.planActive = false; rec.cacheReported = false; rec.toolErrors = 0; rec.deliverables = {turn: undefined, paths: []}`），或把 `foldEvent` 拆成 `resetStats()` + `foldEvent()` 两步并只在 rewind 路径调用前者。另外此路径**不检查回合是否在跑**（`rec.status === '● running'` 时 `truncate` 会截掉正在进行的回合），建议加同 `/rewind` 数字路径一样的确认 + running 守卫。

---

## F3. `/rewind` 的核心能力在目标宿主不存在 → 命令恒为降级提示，但 README/REQUIREMENTS 仍宣称可用 — missing-feature / 中

**位置**：`src/transcript/commands/rewind.ts:12-16`（守卫）、`:60-75`（守卫之后的重建逻辑，0.1.5 上不可达）。

**机制与证据**：

```ts
const session = app.liveSessions.get(rec.id)
if (session === undefined || typeof session.truncate !== 'function') {
  app.notice(t('会话截断不可用：宿主 dsh-session 不支持 truncate（可用 /fork 派生替代）'))
  return
}
```

真实宿主 0.1.5-rc.1 的 `dsh-session` 整包**没有任何 truncate API**：

```
$ grep -rli "truncate" /Users/zhangyong/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib | wc -l
0
$ grep -rho "truncate[A-Za-z]*" .../dsh-session/lib .../dsh-agent*/lib | sort -u
truncated  truncatedDeleteCount  truncatedFile  truncatedStart   # 全是 Math.trunc / 展示截断，无 session 截断
```

插件自身也承认这点（`src/sessions/index.ts:114` 注释："0.1.5 owns its storage (no raw artifacts / no truncate API)"，`CHANGELOG.md:546-547`："rc.1 Session 无 truncate，/rewind 已由前置守卫优雅降级为 /fork 提示"）。但面向用户/需求的文档仍把它当完成态售卖：

- `README.md:223`：`| 会话 | /rewind [第N条] | 回退：选择一条用户消息边界，截断其后的会话内容并重建界面 |`
- `REQUIREMENTS.md:195`：同上；`REQUIREMENTS.md:378`：M6 里程碑把"`/rewind` 回退重建"标为 **✅ 完成**；
- `README.md:281` / `REQUIREMENTS.md:240`：把 `/rewind` 当作"历史带图消息导致 text-only 模型回放失败"的**修复手段**（`src/boot/session-events.ts:200-208` 的告警文案也在教用户这么做），而该手段在 0.1.5 上只会打印"不支持 truncate"。

也就是：`/rewind` 在目标宿主上永远停在 `:12-16` 的守卫，`:60-75` 的重建块是死代码；而用户被文档与告警引导去用一个不可用的命令。`/fork` 虽是提示中的替代，但 fork 不删历史、旧会话仍留在列表里，不能解决"带图毒化会话继续被回放"的问题。

**建议修法**：（a）文档与命令描述改标注降级语义（README/REQUIREMENTS 的 M6 勾选与 `/rewind` 行加"0.1.5 宿主不可用，降级 /fork"）；（b）更实际的替代实现：0.1.5 有 fork（`CHANGELOG` 的 `/fork`）+ surface replace（宿主允许 `user/message` 位置替换），可用"以截断点之前的 surface 前缀 fork 出新会话"或"用 replace 中性化尾部区间"来实现回退，而不是依赖不存在的 `truncate`；（c）`session-events.ts` 的带图告警文案改为指向真正可用的手段。

---

## F4. 切会话后 jobs 心跳不刷新：徽标/鲸鱼/钉底任务板最多滞后 30s — bug / 低-中

**位置**：`src/sessions/services.ts:236-237`（`switchTo` 尾部）；`src/statusline/index.ts:99-176`（`refreshBgJobs`）、`:186`（`runningBadge` 读 `rec.bgJobs`）、`:321-351`（监听器注册）。

**机制**：`refreshBgJobs` 只处理**当前 active** 的 rec（`:100-101`），而它的调用点只有三处：

```
$ grep -rn "refreshBgJobs" src/ --include=*.ts
src/kernel/app.ts:253        (声明)
src/statusline/index.ts:309  (默认空实现) 312/316(赋值) 324/344(监听器内)
src/boot/boot.ts:207         (30s idleRefreshTimer)
```

`switchTo` 只调 `ensureSpinner()` + `updateStatusline()`（`sessions/services.ts:236-237`），**不调 `refreshBgJobs()`**；而 `jobs.onJobsChanged` 只在任务状态变化时触发（切会话不是任务变化），`attachSession` 给新 rec 的初值是 `bgJobs: 0`（`sessions/services.ts:67`）。于是切到一个"agent 空闲但后台 bash 任务仍在跑"的会话时：`ensureSpinner`/`runningBadge` 认为无任务（`:72-74`、`:186`），状态栏显示 idle、鲸鱼不转、钉底任务板为空，最长 30s 后才被心跳纠正。

同一处还有重复查询：`updateStatusline` 自己在 `:255-261` 又取一次 `jobs.list()`（只数 `running`），与 `refreshBgJobs` 维护的 `rec.bgJobs`（数 `running+stopping`、`:137`）是两次独立的宿主查询与两个口径，运行中每 450ms 渲染一帧就要多一次 `list()`（宿主 `dsh-jobs-local/lib/index.js:178-180` 每次都对全部任务重建快照）。

**建议修法**：在 `switchTo`（以及 `attachSession` 完成时）加 `app.slices.ui.refreshBgJobs()`；`⚙ N` 段改为直接复用 `rec.bgJobs`（或删除该段，`runningBadge` 已表达同一信息），去掉每帧的第二次 `jobs.list()`。

---

## F5. `/queue` 的增删改不请求状态栏刷新 → `⏳ N` 徽标假数据（最长 30s） — bug / 低

**位置**：`src/transcript/commands/queue.ts:39-43`（clear）、`:51-56`（remove）、`:57-60`（edit）。

**机制**：三个动作都只 `app.notice(...)`，而 `app.notice` 仅追加到 feed（`src/kernel/app.ts:546: app.notice = (text) => { app.slices.ui.activeFeed()?.appendNotice(text) }`），不触发状态栏；队列徽标只在 `updateStatusline` 里现算：

```ts
// src/statusline/index.ts:266-273
const queued = ((inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0))
if (queued > 0) right.push(escapeStatusline(`⏳ ${queued}`))
```

`grep -n "updateStatusline\|refreshBgJobs" src/transcript/commands/queue.ts` → **无匹配**；对比其他命令都会显式刷新（如 `statusline/commands/glance.ts:28`、`commands/core.ts:90/122`）。用户 `/queue` 清空 3 条后，徽标仍显示 `⏳ 3`，直到下一次 `updateStatusline`（30s 心跳 `boot.ts:205-210` 或任意 session 事件）。同一问题也存在于 `commands/core.ts:328-348` 的"编辑排队消息"路径（`inbox.replace` 后无刷新）。

**建议修法**：三处动作成功后加 `app.slices.ui.updateStatusline()`（一行）。

---

## F6. workflow 运行表跨会话共享且日志/阶段/代理数组无界增长 — risk / 低-中

**位置**：`src/transcript/index.ts:215`（模块级 `workflowRuns` 初始化）、`:298-361`（六个 handler）、`:324-330`（logs 无上限）。

**机制**：`workflowRuns` 是挂在 `app.slices.trans` 上的**全局** Map（不按会话分区、不在会话关闭/切换时清理），唯一的有界手段是 200 条的**插入序**淘汰（`:307-310`）：

```ts
if (app.slices.trans.workflowRuns.size >= 200 && !has(runId)) {
  const oldest = app.slices.trans.workflowRuns.keys().next()
  if (oldest.done !== true) delete(oldest.value)     // 可能淘汰仍在 running 的运行
}
```

而单个 run 内部完全没有上限：`:329 if (run) run.logs.push(message as string)`、`:320 run.phases.push(...)`、`:337 run.agents.push(...)`。workflow 脚本是模型写的，`log()` 出现在循环里（宿主只限 item/agent 数，不限 `log` 次数）时 `run.logs` 会线性增长；`/workflow` 只展示 `run.logs.slice(-6)`（`src/commands/commands/workflow.ts:24`），其余全部是纯内存泄漏。同时 `/workflow` 会把**别的会话**跑过的运行列出来（`workflow.ts:15` 遍历全表），而运行 id/meta 并未与 session 关联。

**建议修法**：`logs` 环形截断（如 `if (run.logs.length > 200) run.logs.shift()`），`phases/agents` 同理；淘汰改为"优先淘汰已结束的最旧项"（或按 `run.running === false` 过滤后再淘汰）；在 `workflow/start` 时记录 owner session id，`/workflow` 只展示当前会话（或至少标注来源会话）。

---

## F7. `/density` 只影响"此后新产生"的工具卡，切换后当前视图无任何变化且不持久化 — missing-feature / 低

**位置**：`src/statusline/commands/density.ts:5-10`；消费点 `src/feed/feed.ts:777,785`。

**机制**：`dense` 只在**事件期**被读取——`applyEvent` 的 `tool/result` 分支当场把行拼成字符串推进 `base`：

```ts
// feed/feed.ts:777
const previewPart = !this.dense && structured === null && preview ? ` · ${preview}` : ''
// feed/feed.ts:785
const outLines = structured === null || this.dense ? [line] : [line, ...structured.map((h) => `  · ${h}`)]
```

`/density` 只做 `feed.dense = !feed.dense`（`density.ts:8`），既没有重渲染（不调 `schedule()/flush()`），而 `base` 里存的是**已拼好的文本行**，即使重渲染也无法把旧卡"变紧凑"。所以 README `:251`"紧凑模式（工具卡片仅标题行）"在用户操作当下**看不到任何效果**（下一张工具结果卡才会变），且与 `/glance` 不同，它不写 `vim.g`（`glance.ts:29` 有持久化钩子），插件重载即回默认（`feed.ts:258 this.dense = false`）。

**建议修法**：把 dense 判定移到渲染期（`base` 存结构化行描述，render 时按 `this.dense` 组装），或在 `/density` 里对 `base` 中已有的工具卡做一次降级重写；同时像 `/glance` 一样持久化到 `vim.g.dsh_tui_dense` 并在 boot 恢复。

---

## F8. `/trajectory` 的 `step` 变量只写不读 — deadcode / 低

**位置**：`src/transcript/commands/trajectory.ts:21`（`let step = 0`）、`:26`（赋值）。

**证据**：

```
$ grep -n "step" src/transcript/commands/trajectory.ts
21:  let step = 0
24:    const data = e.data as { turn?: number; step?: number; ... }
26:      step = data?.turn === turn ? (data?.step ?? 0) : step     ← 唯一赋值，之后无任何读取
32:      lines.push(`步骤 ${data.step ?? '?'} · ${text || '（无文本）'}`)   ← 用的是 data.step，与 step 无关
```

同文件内无其他引用、`trajectoryCommand` 也不导出 `step`，属纯死变量（连带 `turn/start` 分支的 `continue` 只剩漏斗作用）。

**建议修法**：删掉 `step` 与 `:25-28` 的 `turn/start` 分支，或改为真正记录"当前步骤"用于后续事件缺少 `step` 时的兜底显示。

---

## F9. 价格表缺 `deepseek-v4-flash-vision-exp`（及自定义/档位模型）→ 识图回合的 `$cost` 与 `/cost` 预估整段消失 — missing-feature / 低

**位置**：`src/feed/stats.ts:13-16`（硬编码价格表）、`:44-47`（未知模型返回 `undefined`）；消费点 `src/statusline/index.ts:286-288`、`src/statusline/commands/cost.ts:16-19`。

**机制**：宿主 0.1.5-rc.1 的 deepseek 目录里一共三个模型 id：

```
$ grep -n 'id: "deepseek-v4' .../dsh-llm-deepseek/lib/index.js
1852: id: "deepseek-v4-flash"
1858: id: "deepseek-v4-pro"
1864: id: "deepseek-v4-flash-vision-exp"
```

而 `MODEL_PRICES` 只有前两个。插件的识图路径恰恰会临时切到第三个（`src/commands/core.ts:76-89`，`findVisionModel` 候选即 `deepseek-flash`/`deepseek-v4-flash-vision-exp`），`/difficulty` 档位路由也可切到用户在 config 里配的任意模型（`kernel/difficulty.ts:31`）。一旦当前模型不在表里，`estimateCost` 返回 `undefined` → 状态栏 `$` 段不渲染，`/cost` 静默省略"预估 $"（用户无法区分"没花钱"和"没价格"）。

**建议修法**：补 `deepseek-v4-flash-vision-exp` 价格；`estimateCost` 的未知模型情形在 `/cost` 里显式打印"（该模型未收录价格）"而不是静默省略；长期可改为从宿主 `llm.listModels`/目录元数据读取价格。

---

## 附：本次核对后**判定无问题**的高危嫌疑点（避免后续重复排查）

| 嫌疑 | 结论与证据 |
|---|---|
| `surfaceOp:{op:'replace',startSeq,endSeq}` 拼写 | **正确**（0.1.5 已改名）：`grep -n "function isReplaceOp" .../dsh-session/lib/index.js:262-264` 要求恰好 3 键 `op/startSeq/endSeq`；插件 `transcript/index.ts:88` 与注释一致。 |
| `events[seqA]` 用 seq 当数组下标 | **成立**：宿主契约 `get seq(){ return SessionLogOffset(this.log.length) }`（`.../dsh-session/lib/index.js:1128`）+ `snapshotEvents(fromSeq=0)` 返回全量日志，seq === 下标；`nodes` 也是 seq 数组。 |
| 尾部补写的 `tool/result` 信封 | **合法**：探针 A `append => OK`；`error:{name:'ToolOutcomeUnknownError'|'ToolNotStartedError', code: TOOL_OUTCOME_UNKNOWN|TOOL_NOT_STARTED}` 与宿主 `interruptedTurnClosers`（`lib/index.js:656-689`）逐字一致；`createToolResultMessage` 产物满足宿主 `assertMessageEventShape`（role=user / source.kind=tool / 单 tool-result 块 / toolCallId 匹配）。 |
| `user/message` 事件 data 形状 | **正确**：宿主 `SessionEventMap['user/message'] = UserMessage`（不是 `{message}` 包装），`transcript/index.ts:199` 直接传 `createUserMessage(...)` 合法。 |
| `assistant/message` 替换缺 `stream` | 理论上会让会话不可恢复（`assertAssistantSettlementShape` 要求 `stream` 为数组，`lib/index.js:903-907`），但该路径在 0.1.5 上先于此处抛错（见 F1），故只作为 F1 的加重因素记录。 |
| inbox API（`queue.ts`） | **正确**：`Inbox.nextTurn/nextStep/clear()/remove(id)/replace(id,msg)` 均在 0.1.5 契约内（`dsh-agent/lib/types/runtime-types.d.ts:43-70`、`dsh-agent-loop/lib/types/inbox.d.ts`）。 |
| jobs API（`statusline/index.ts`） | 签名/字段正确：`list(caller?: Agent): JobSnapshot[]`、`onJobDone(snap, owner: Agent|undefined)`、`onJobsChanged(owner)`，`Agent.session.id` 存在（`dsh-session` `get id()`），status 枚举 `running/stopping/completed/killed/failed` 与图标分支一致。 |
| workflow host 事件元数 | **正确**：`workflow/phase(info,title)`、`/log(info,message)`、`/agent-start(info,agent)`、`/agent-end(info,agent{seq,outcome})`、`/end(info,result{stopReason,error})` 与 `dsh-workflow/lib/types/index.d.ts:24-70` 一致。 |
| `sessionStats` 投影字段 | **正确**：`ttftMs/ttftSteps/decodeMs/decodeTokens` 与 `dsh-session-stats/lib/types/types.d.ts` 一致，`stateOf(session,'sessionStats')` 签名一致；未注册时静默隐藏是合理降级。 |
| 状态栏 token 口径 | **正确**：`billedInput = input+cacheRead+cacheWrite` 与宿主"counts are DISJOINT"契约（`dsh-llm/lib/types/types.d.ts:130-136`，adapter 已从 `prompt_tokens` 里扣除 cache read，`dsh-llm-deepseek/lib/index.js:1149-1163`）一致。 |
| `/whale` 开关与动画 | **正常**：`setWhale()` → `schedule()` → 渲染空态时 `feed.ts:1361 this.ensureWhaleTicker()`，有内容时停止（静态水印）符合注释。 |
| `glance` 段名与开关 | **正常**：六个段名与 `statusline/index.ts:218/223/227/232/285/286` 的判定一一对应；`restoreGlance` 由 `boot.ts:167-168` 调用（非死代码）。 |
| `runningBadge` 是否死导出 | **非死代码**：`scripts/smoke.ts:1746-1749` 断言四个分支。 |
| `/queue` 编辑流与乐观回显冲突 | **无冲突**：`commands/core.ts:328-348` 在 `pendingQueueEdit` 分支提前 return，不会把该行当作新消息入队（`pendingEchoes` 不会被污染）。 |
| 转录 diff 去重缓存 | **无问题**：`rewind.ts:68` 已按 `renderedDiffCalls.delete(rec.feed)` 重置（REVIEW S1/Fix-4 的修复在位）。 |

**判为"证据不足、未上报"**（记录以便后续版本复核）：

- 尾部修复用**日志**判定配对（`transcript/index.ts:132-138` 的 `have` 集合扫全量 event，而不是像非尾部分支那样走 surface `nodes`），与宿主"配对是 surface 属性"（`deriveMessages`/`foldSurface`）口径不一致；但穷举可达场景后，"assistant 是最后一个 surface 节点"与"同名 callId 的 tool/result 只存在于日志、不在 surface"无法同时成立（任何替换节点都会占据被遮蔽节点的位置，从而出现在 assistant 之后），故不上报为缺陷，仅建议改为从 surface 推导 `have` 以对齐口径。
- `refreshBgJobs` 把"从 `jobs.list` 消失的 running 任务"伪造成 `killed`（`:131-135`）：`dsh-jobs-local` 只在 owner disposal 时删除任务记录（`lib/index.js:410-413`），而 owner 释放时对应 rec 已从 `live` 删除并提前 return（`:101`），当前不可达。
