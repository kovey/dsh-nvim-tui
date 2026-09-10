# 审计报告：feed-core（`src/feed/feed.ts`）

- 单元：`feed-core` — FeedRenderer 渲染管线 / applyEvent / todo·jobs 钉底与提交去重 / 表格·代码块·推理块 / 节流与 flush 并发 / extmark 卡片范围
- 审计对象：`/Users/zhangyong/workspace/deepseek/neovim-tui/src/feed/feed.ts`（1704 行，已用 read 全文读完）
- 关联核对文件：`src/feed/table.ts`、`src/feed/diff.ts`、`src/feed/whale.ts`、`src/feed/stats.ts`、`src/boot/session-events.ts`、`src/subagents/index.ts`、`src/sessions/services.ts`、`src/statusline/index.ts`、`src/ext-api/index.ts`、`src/commands/core.ts`、`nvim/lua/dsh_tui/api.lua`、`nvim/lua/dsh_tui/session.lua`、`scripts/smoke.ts`
- 方法：
  1. 全文精读 + 全局 grep 查证调用方/引用（凡判定死代码均附 grep 证据）；
  2. 行为探针（不改源码）：用 `lib/feed/feed.js`（与 src 同步、工作树干净）+ stub `NeovimClient` 直接驱动 `FeedRenderer`，打印 `lastView` / RPC 调用序列（脚本见 `/tmp/feedaudit/probe*.mjs`）；
  3. 用真实 nvim 0.12.5 验证 API 语义（`nvim_buf_set_lines` 的换行拒绝、extmark 区间端点是否含尾行、`nvim_buf_set_text` 负索引）。

结论：**发现 11 项**（bug 6 / deadcode 1 / risk 3 / missing-feature 1），按严重度排序。

---

## F1. base 中的多行字符串会让整条渲染管线永久失效（E5108）— bug / 高

**位置**：`src/feed/feed.ts:363-366`（`pushWorkflow`）、`948-950`（`workflowPhase`）、`952-955`（`workflowEnd`）、`934`（`subagentStart`）、`941`（`subagentEnd`）、`908-923`（`tool-workflow/*` 的 label/phase/outcome/stopReason）、`445`（ext-card 动作标签）；对照已加固的 `304-313`（`appendNotice`）、`528-532`（`pushError`）。

**机制**：`base` 的每一条元素都会被当作 nvim 的一"行"直接喂给 `nvim_buf_set_lines`（`1454`；增量路径 `1418-1419` 用 `nvim_buf_set_text`）。nvim 明确拒绝含 `\n` 的行，实测：

```
$ nvim --headless -u NONE -i NONE -n --clean \
  -c 'lua local ok,err=pcall(vim.api.nvim_buf_set_lines,0,0,-1,false,{"ok","a\nb"}); print(ok,err)'
set_lines ok: false err: 'replacement string' item contains newlines
```

`appendNotice`/`pushError` 正是为此做了 `String(text).replace(/\s+/g,' ').trim()`，并且文件头注释（`304-308`）记录了历史事故（"/subagents E95 failure notice was invisible this way and every later render that included it silently failed"）。但下列入口**没有**做同样处理，且它们的输入全部来自宿主/模型（workflow 脚本是模型写的）：

```ts
// 363-366
pushWorkflow(line: string): void { this.base.push('', line); this.schedule() }
// 952-955  ← err 原样拼接，不 truncate、不折叠
workflowEnd(_info: unknown, result: { stopReason?: string; error?: string }): void {
  const err = result?.error
  this.pushWorkflow(`◈ workflow · ${result?.stopReason ?? 'ended'}${err ? ` · ${err}` : ''}`)
}
// 948-950  ← 模型脚本自定的阶段标题
workflowPhase(_info: unknown, title: string): void { this.pushWorkflow(`◈ ─ ${title}`) }
// 445      ← 插件自定的按钮文案
lines.push(`  ${actions.slice(0, 4).map((a, i) => `[${i + 1}] ${a.label}`).join('  ')}`)
```

调用链：`transcript/index.ts:312/322/360`（host events `workflow/*`）→ `feed.workflowPhase(payload, title as string)` / `workflowEnd(payload, outcome)`，`title`、`outcome.error` 均为未校验的宿主字符串（`outcome.error` 通常是 Error 的 message/格式化文本，天然可能多行）。

**后果（探针实测，stub 复刻 nvim 的换行拒绝契约）**：

```
1) healthy flush ok, rows = ["· boot ok"]
   base tail = ["◈ workflow · failed · scan failed\n  - step 1: timeout"]
2) flush THREW: 'replacement string' item contains newlines
3) every later flush THROWS: ... | lastView = []
4) workflowPhase(title with \n) → THROWS | base = ["","◈ ─ 阶段一\n扫描文件"]
```

坏行永远留在 `base` 里（没有任何清理路径），且 `1510-1516` 的 catch 只做 `this.lastView = []` 后 rethrow，`schedule()` 的 catch（`1067-1069`）只 `console.error`。于是：**该会话的 chat 缓冲从此冻结在最后一次成功渲染的内容上**；连 `pushError`/`appendNotice` 也无法把诊断画出来（它们同样走 base）；用户侧零感知。stderr 里会反复出现 `[dsh-nvim-tui] render flush failed: ... item contains newlines`。

**复现路径**：让一个 workflow 脚本 `throw` 一个多行错误的 `Error`（或 `phase("阶段一\n扫描")`），或让任一 host 事件的 label/stopReason 含换行。

**建议修法**：在唯一的渲染入口做一次性归一化——`applyEvent`/各 push* 汇总到 `pushLine()` 时统一 `String(x).replace(/[\r\n]+/g,' ')`，或（更稳）在 `flush()` 构造 `lines` 之后、写缓冲之前加 `lines = lines.map(l => l.includes('\n') ? l.replace(/\s+/g,' ') : l)`。这样所有入口一次覆盖，且顺带解决 `pushSubagent/pushWorkflow/pushTool/pushExtCard` 的同类风险。

---

## F2. `toolActivity` 在 turn/end 不清除：孤儿 tool/call 之后底部永久挂着假"运行中"行 + 500ms 自续 flush 死循环 — bug / 高

**位置**：`761`（置位）、`794`（tool/result 清除）、`808`（turn/start 清除）、`811-821`（**turn/end 未清除**）、`1134-1140`（活动行渲染）、`1522-1533`（ticker 续命）。

**机制**：

```ts
// 1522-1532（flush 的 finally）
} else if (this.reasoningTail !== '' || this.toolActivity !== null ||
  this.subagents.size > 0 || (this.turnStartedAt !== null && ...)) {
  this.ticker = setTimeout(() => { this.ticker = null; this.schedule() }, 500)
}
```

`toolActivity !== null` 时每 500ms 自续一次 flush；活动行：

```ts
// 1134-1140
} else if (this.toolActivity !== null) {
  const elapsed = (Date.now() - this.toolActivity.startedAt) / 1000
  activityLines = [`🔧 ${this.toolActivity.name} · ${elapsed.toFixed(1)}s`]
}
```

而 `toolActivity` 只在 `tool/result`（794）与下一次 `turn/start`（808）清除。**turn/end 分支完全没有清理**（`811-821` 只做 commitReasoning/commitTail/推 marker/清 turnStartedAt）。

宿主侧确认"tool/call 可能永远没有 result"：`src/boot/session-events.ts:110-164` 专门为这种孤儿调用兜底（注释原文：*"The turn ended while tool calls were still pending: the tool scheduler crashed after committed tool/call events and no result will ever arrive"*），它只向**会话历史**补写错误结果（`synthesizeToolResult`），并不会回灌一条 `tool/result` 会话事件，所以 feed 永远等不到 `tool/result`。同理 `assistant/chunk` 的 error-finish 中断、用户 Esc 中止回合等路径也不会补齐 result。

**实测**（probe2 第 2 段）：

```
--- view after orphaned tool/call + turn/end ---
  3 "🔧 bash({\"cmd\":\"ls\"})"
  4 "── turn end ──"
  5 "🔧 bash · 0.0s"          ← 假"运行中"行钉在视图最底
   toolActivity = {"name":"bash",...}  ticker armed = true
   after 700ms: ticker armed = true  (a 500ms self-rearming loop is live)
```

即：一整个空闲会话持续以 500ms 周期跑全量 parse+diff+extmark 刷新（CPU/JSON-RPC 白烧），并且界面上永远显示一个根本没在跑的工具。

**建议修法**：`case 'turn/end'` 里补 `this.toolActivity = null`（以及下面 F3 的 `this.subagents.clear()`）；若要保留"这个工具被中断"的信息，可在 `turn/end` 时对仍在 `calls` 里未配对的 callId 推一条 `✗ name · interrupted`。

---

## F3. `subagentStart`/`subagentEnd` 的 map key 兜底不一致（`'?'` vs `''`）：无 runId 的子代理永久泄漏，产生幽灵活动行 + 500ms 死循环 — bug / 高

**位置**：`933` vs `940`（同一函数对，两处兜底值不同），消费点 `1141-1152`、`1523`。

```ts
// 931-935
subagentStart(info: { runId?: string; provider?: string; id?: string }): void {
  this.subagents.set(info.runId ?? '?', { provider: info.provider ?? '?', startedAt: now })
```
```ts
// 937-942
subagentEnd(info: {...}): void {
  const run = info.runId ? this.subagents.get(info.runId) : undefined   // ← 这里用 falsy 判定
  ...
  this.subagents.delete(info.runId ?? '')                                // ← 这里兜底是空串
```

**无 runId 时**：start 写入 key `'?'`，end 删除 key `''` → 删除落空，条目永久驻留。`src/kernel/types.ts:118-123` 明确 `runId?: string`（可选），而调用方 `src/subagents/index.ts:291`、`321` 自己就用 `payload?.id ?? payload?.runId` 取 key，说明"只有 id、没有 runId"的载荷是被预期的。条目一旦泄漏：视图底部常驻 `◇ provider · Ns`（秒数无限增长），且 `flush()` 的 finally 里 `this.subagents.size > 0`（1523）永远成立 → 500ms 自续 flush 死循环（与 F2 同一机制）。

**实测**（probe2 第 3 段）：

```
--- view after subagent start+end (no runId) ---
  1 "◇ subagent deepseek-code · child-1"     ← start
  3 "◇ subagent deepseek-code · completed"   ← end（正常落屏）
  4 "◇ deepseek-code · 0.0s"                 ← 幽灵活动行，永远不消失
   subagents.size = 1   keys = [ '?' ]        ticker armed = true
   control (with runId): subagents.size = 0   ticker armed = false
```

**建议修法**：抽一个 `const subKey = (i) => i.runId ?? i.id ?? '?'`，start/end（以及 `938` 的 elapsed 查找）统一用它；另外在 `turn/end` 里对 `subagents` 做一次清理（子代理不会跨回合存活于主 feed 的活动槽）。

---

## F4. 交互卡片 extmark 尾行不含：光标停在卡片最后一行（动作提示行）时 1-9 / Enter 失效 — bug / 中

**位置**：`feed.ts:473-476`（置 mark）与 `nvim/lua/dsh_tui/api.lua:488-506`（`API.card_activate`，命中判定在 `500-502`）。

```ts
// 473-476
const markId = await this.nvim.request('nvim_buf_set_extmark', [
  this.bufId, ns, range.startRow, 0,
  { end_row: range.endRow, end_col: 0, priority: 1 },
]) as number
```
```ts
// 1374-1377：endRow 的语义是"卡片最后一行"（含）
const first = rowStartOfRaw[rec.start] ?? 0
const endRow = (afterEnd < raw.length ? rowStartOfRaw[afterEnd] : parsed.length) - 1
```
```lua
-- api.lua
local endRow = (m[4] and m[4].end_row) or (startRow + 1)
if row >= startRow and row < endRow then markId = m[1]; break end
```

extmark 区间是**左闭右开**：`end_col = 0` 的终点意味着 `endRow` 那一行不在覆盖范围内（Lua 侧 `row < endRow` 与之一致），而 TS 侧把 `endRow` 当成"最后一行（含）"算出。于是卡片最后一行查不到 mark。

**真实 nvim 验证**（复刻 feed 的 mark + api.lua 的查询，行 0..3 = 空行/标题/正文/动作提示）：

```
mark id=1 start=0 end_row=3
cursor row 0 ("")                -> card activates: true
cursor row 1 ("▣ smoke · 卡片")   -> card activates: true
cursor row 2 ("  正文")           -> card activates: true
cursor row 3 ("  [1] x")          -> card activates: false   ← 动作提示行无效
```

卡片行结构由 `extCardLines`（`440-448`）固定为 `['', '▣ 标题', '  body…', '  [1] … [2] …']`，最后一行恰恰是**动作提示行**——用户把光标移过去按数字键的直觉位置。smoke 只断言了标题行命中（`scripts/smoke.ts:2817` 用 header 行做 cursor）与 `end_row >= intHeaderRow`，没有覆盖尾行，所以一直没暴露。

**建议修法**：终点改为覆盖 `endRow` 整行，例如 `{ end_row: range.endRow, end_col: <该行字节长度>, priority: 1 }`（Lua 侧 `row < endRow` 不变即可命中尾行）；或 `end_row: Math.min(range.endRow + 1, lineCount - 1)` 并把 Lua 判定改为 `row <= endRow`（两处必须同时改，否则新的 off-by-one）。

---

## F5. 流式围栏代码块永远拿不到语法高亮 token（增量窗口把块起始行排除在外）— bug / 中

**位置**：注册处 `1296-1303`；消费处 `1467`（全量路径）、`1490-1499`（token RPC）。

```ts
// 1296-1303：代码块只在"遇到收尾围栏"那一刻注册，row = 第一行代码行
} else {
  if (fenceLang !== '' && fenceCode.length > 0 && fenceCode.length <= 200 && ...) {
    codeBlocks.push({ lang: fenceLang, row: fenceRow, col: 0, lines: fenceCode })
  }
```
```ts
// 1467-1469：只重绘"本次改动起点及之后"的块
const tokenBlocks = codeBlocks.filter((b) => b.row >= startRow)
```

流式场景下（模型先吐代码、再吐收尾 ```` ``` ````，这是常态），收尾围栏在**新的一行**上，`startRow`（首个与 `lastView` 不同的行）= 收尾围栏所在行 = `fenceRow + fenceCode.length`，恒大于 `b.row`，于是 `tokenBlocks` 为空，`highlight_syntax` 根本没被调用；而代码行早在之前的 flush 里就以"围栏未闭合"状态写进缓冲（当时 `codeBlocks` 里还没有这个块），只带了扁平 `DshTuiCode` 组。之后每次 flush 的 `startRow` 只会在更后方（内容都是尾部追加），所以**这个块在有生之年都不会被补上 token**。

**实测**（probe2/probe3，抓 `highlight_syntax` 的 Lua RPC）：

```
A. STREAMED fence close:        highlight_syntax calls = []                       ← 丢高亮
B. WHOLE block in one flush:    calls = [[{lang:"js",row:2,col:0,lines:[...]}]]   ← 有高亮
C. in-place close:              calls = []  (nvim_buf_set_text 走了 in-place 分支)
probe3: 流式闭合后强行改动更早的行 → calls = [[{lang:"js",row:5,...}]]           ← 证明块已注册、只是被 row 过滤剔除
```

对照：diff 卡片（`pushDiff` 一次性把 blank+header+行都推进 base）不受影响，实测 `D. pushDiff single-row block: syntax = [{lang:"ts",row:2,col:2,...}]`。smoke 里只断言 `highlight_syntax` 不抛异常（`scripts/smoke.ts:2232-2236`），断言不到"是否被调用"。

**建议修法**：把"是否已高亮"从"行 >= startRow"改成"块与改动区间相交"，即 `b.row + b.lines.length >= startRow`；更彻底的做法是给每个 codeBlock 记一个 `highlighted` 标记，在 `tokenNs` 里按块 id 维护已应用状态。

---

## F6. 步骤进度块被提升到"它前面的正文"之上：消息块序被倒置 — bug / 中

**位置**：提取 `1099-1115`，拼装 `1164`。

```ts
// 1099-1115
const STEP_MARK_RE = /^\s*[-*•]?\s*[✅⏳⬜]/
...
if (incomplete && headerIsHeader) {
  progressLines = [headerRow, ...tailLines.slice(stepStart)]
  restTail = tailLines.slice(0, stepStart - 1)
}
```
```ts
// 1164
const raw = [...this.base, ...progressLines, ...restTail, ...panelLines, ...activityLines]
```

`restTail` 是**排在进度块之前**的正文，`progressLines` 是被提升的尾部块，但拼装时把 `progressLines` 放在了 `restTail` 前面 → 只要任一步骤未完成（这正是"动态区"存在的整段时间），消息里"正文/标题"和"进度块"的相对顺序就是反的。

**实测**（probe 第 1 段，输入 `'先说结论：改动很小。\n任务进度：\n- ✅ 实现\n- ⏳ 测试'`）：

```
  2 "任务进度："            ← 被提升的块跑到前面
  3 "- ✅ 实现"
  4 "- ⏳ 测试"
  5 "先说结论：改动很小。"   ← 原本在块之前的正文落到后面
  6 "·· thinking · 0.0s"
```

smoke 的进度块用例（`scripts/smoke.ts:858-897`）里 tail **只有**块本身，`restTail` 为空，因此测不出这个顺序倒置。

**建议修法**：保持原序即可同时满足"钉在 thinking 行之上"的诉求——`raw = [...this.base, ...restTail, ...progressLines, ...panelLines, ...activityLines]`。

---

## F7. deadcode：in-place 分支的 `codeBlocks.filter((b) => b.row === inPlaceRow)` 永远为空 — deadcode / 低-中

**位置**：`1439-1449`。

```ts
// 1439-1449（in-place 路径内）
const tokenBlocks = codeBlocks.filter((b) => b.row === inPlaceRow)
if (tokenBlocks.length > 0) { ...require("dsh_tui").highlight_syntax... }
```

**结构性证据（该 filter 不可能命中）**：

- `codeBlocks` 只有两个 push 点（grep 全文件仅此两处）：`1300`（围栏）与 `1194`（diff 块）。
- 围栏：`fenceRow = parsed.length + 1` 是**第一行代码行**；闭合标记行 = `fenceRow + fenceCode.length`，且 push 的前提是 `fenceCode.length > 0`（`1297`）→ 闭合行 ≥ `fenceRow + 1`。in-place 路径只会在 `startRow === lines.length - 1`（即最后一行）时触发，若此刻正是围栏闭合，则 `inPlaceRow` = 闭合行 > `b.row`，永不相等。
- diff 块：`diffRow` 是"第一个被收集的 +/-/context 行"，而 in-place 要求"仅最后一行变化且行数不变"；diff 块由 `pushDiff` 一次性追加（至少 3 行）或已存在于历史视图中，无法同时满足"块起始行 == 最后一行 && 该行是唯一变化行"。

**实测佐证**：probe2 C 段刻意构造"围栏在最后一行闭合"（未加新行）→ 走了 in-place 分支（`nvim_buf_set_text` 为 true），`highlight_syntax` 调用次数 = 0，与 filter 恒空一致。

**影响**：这是一段永不生效的"补救代码"，同时意味着"最后一行 in-place 重写导致某代码块内容变化"时不会有 token 刷新（与 F5 同源）。

**建议修法**：删除该死分支，或按 F5 的建议改成"块区间与 `inPlaceRow` 相交/未高亮即重绘"。

---

## F8. 推理面板无自愈路径：缓冲被 wipe/重建后，面板静默永久停更 — risk / 中

**位置**：`1540-1545`（吞异常）、`1547-1553`（用 `this.reasoningBuf`/`this.ns` 直接写）、`296-300`、`802-807`（`panelFlushed` 只在 clear/turn-start 重置）；对照 `1687-1703`（`moveCursor` 有 idsProvider 重取 + 重试）、`1513-1516`（`lastView` 自愈）。

```ts
async flushReasoningBuffer(): Promise<void> {
  if (this.reasoningBuf === null) return
  try { await this.flushReasoningBufferInner() } catch {}     // ← 全部吞掉，无重取、无降级、无提示
}
```

`reasoningBuf` 只在构造时从 `ensureReasoning` 取一次（`src/sessions/services.ts:37-38`）。一旦该缓冲被 `:bwipeout`/重建（Lua 侧 `SE.ensure_reasoning` 会为无效 id 新建缓冲，`nvim/lua/dsh_tui/session.lua:42-70`），feed 仍指向旧 id：所有面板 RPC 抛错 → 被 `catch {}` 吞 → `panelFlushed` 永久停留在旧水位，于是"面板永远是空的/停在旧内容"，且用户与日志都看不到任何异常（chat 侧因为同样的水位问题还有 `full.length >= startRow` 的越界写隐患，同样被吞）。这与 chat 侧专门做的两级自愈（idsProvider 重取、失败即 `lastView=[]` 全量重绘）形成明显不对称。

**建议修法**：`flushReasoningBuffer` 的 catch 里做一次重取（`idsProvider` 或新增 `reasoningBufProvider`）并重置 `panelFlushed = 0; lastPanelVersion = -1`；或至少在连续失败 N 次后推一条 `⚠ 推理面板已失效` 通知（走 chat base）。

---

## F9. `syncCardMarks` 串行 + 单点 `.catch(()=>{})`：一次失败即中断整批卡片同步且无任何诊断 — risk / 中

**位置**：`462-484`（串行 await 循环，无 per-card try）、`1508`（`await this.syncCardMarks(newCardRows).catch(() => {})`）。

循环里任何一次 `nvim_buf_set_extmark`/`nvim_buf_del_extmark` 抛错都会让整个 promise reject：① 后续卡片的 mark 不更新（新卡片直接不可交互）；② `479-483` 的"删除已消失卡片 mark"循环根本不会执行，`this.cardRanges` 与缓冲里的真实 mark 进入不一致状态；③ 失败完全没有提示（`nvim` 侧 `card_activate` 只会静默 `return false`）。触发面包括缓冲被外部修改（mark 越界）、后台会话缓冲被删、`ns` 失效等，都是本模块其他位置已显式防御过的场景（如 `moveCursor`、`flushReasoningBuffer`）。

**建议修法**：把两个循环体各自包 `try/catch`（单卡片失败不影响其余），失败累计时推一条 feed 通知。

---

## F10. `commitJobsBoard` 不幂等，去重责任外置到调用方 — risk / 低-中

**位置**：`380-386`（`setJobsBoard` 有 key 去重）vs `390-395`（`commitJobsBoard` 无任何 key 守卫）。

```ts
setJobsBoard(rows: string[]): void {
  const key = rows.join('\n')
  if (key === this.jobsLiveKey) return          // ← live 板有去重
  ...
}
commitJobsBoard(rows: string[]): void {
  if (rows.length > 0) this.base.push(...rows)   // ← 直接落 base，重复调用即重复落屏
  this.jobsLiveRows = []
  this.jobsLiveKey = ''                          // ← 清 key 反而让下一次 live 板重新入场
  this.schedule()
}
```

实测（probe 第 6 段）：连续两次 `commitJobsBoard(相同 rows)` → 视图中出现两份 `⚙ 任务 1 项 … / ✓ lint`。当前之所以没炸，是因为调用方自己做了一次性 key：`src/statusline/index.ts:158-168`（`rec.committedJobsKey` + `committedJobKeys` + 清 cache）。这是典型的跨模块状态耦合：任何新调用方（如 `/tasks` 面板、子代理 feed、未来的 ext API）重复提交都会污染会话记录，而且写进 base 的内容无法再撤回。

**建议修法**：把去重下沉到 feed——`commitJobsBoard` 内部维护 `committedJobsKey`（在 `commitJobsBoard` 里比较 `rows.join('\n')`，相同则直接清 live 槽并 return），调用侧的 key 逻辑可保留作双保险。

---

## F11. i18n 缺口：子代理/注入上下文行与回合分隔行绕过 `t()` — missing-feature / 低

**位置**：`667`（`` `◇ 子代理已结束 · ${source.summary}` ``）、`678`（`◇ 子代理 ${sender} → 本会话`）、`687`（`'· 注入上下文'`）、`799/817`（`'── turn ──'`/`'── turn end ──'`）、`934/941`（`◇ subagent …`）。

同一个 `applyEvent` 的其他行都走 `t()`（如 `842` 的 `${t('📋 待办')}`、`864`、`875`、`900`），`src/kernel/i18n.ts` 的契约是"用户可见串一律写成 zh 字面量并过 `t()`，en 词典命中则翻译、未命中回退 zh"。这些串从不经过 `t()`，因此 en locale 下永远显示中文（不是"词典缺条目"的优雅降级，而是完全绕过翻译层）。

**建议修法**：这些字面量接入 `t()`（`'· 注入上下文'`、`'◇ 子代理已结束 · {0}'` 这类带参串可拆成 `t('◇ 子代理已结束') + ' · ' + summary`）。

---

## 复核过但判定"不是问题"的点（避免后续重复排查）

- **flush 并发/节流协议**（`1063-1071`、`1073-1084`、`1409-1534`）：占位 promise 预留槽位 → `dirty` 标记 → finally 链式重跑，逻辑闭合；timer 只在回调里置 null，事件丢失路径有 timer 兜底。未发现丢更新或交错写。
- **增量 diff / `lastActivityCount`**（`1382-1407`）：只在"已提交前缀"里比对、瞬时活动行不参与比对，`startRow == lines.length` 的空切片语义等价于"截断到该行"，正确。
- **todo 钉底与提交去重**（`373-375`、`822-861`）：`committedTodos` + 非完成状态回退删除的组合，实测 5a/5b/5c 三个序列（进行中 → 全完成提交 → 原样重发）无重复落屏、无未绑定增长。
- **表格开闭边框**（`1269-1281`、`1214`）：`closed = j < raw.length - trailingStatic || !streamOpen` 对"流式中表格保留底边"与"turn/end 后补齐底边"两种场景实测均正确。
- **`nvim_buf_set_text(..., end_col = -1)`**（`1418-1419`、`1624`）：真实 nvim 0.12.5 支持负索引（实测 `set_text(-1): true`），in-place 行重写无 API 误用。
- **`cardRanges`/`extCards` 偏移维护**（`412-456`）：`shiftExtCards` 只影响 `start > afterStart` 的卡片，`update/dismiss` 的 splice 语义正确；`base` 只在尾部追加，卡片的 base 偏移不会自然漂移。
- **静态工具方法**（`messageImages`/`messageReasoning`/`structuredHits`/`argsPreview`）虽无外部调用方，但均在 `feed.ts` 内部被使用（`694/705/774/754`），非死代码。
- **`rowStartOfRaw` 未赋值项默认 0**（`1168` + 表格分支 `i = j - 1` 跳过中间行）：理论上可让"紧邻卡片之后的那一行恰好是表格内部行"时卡片范围被误算成 `-1` 并删除其 mark，但所有 base 生产路径（`pushUser/pushTool/pushBlock/pushDiff/commitTail/各 marker`）都在块前插入空行，实测无法构造，暂不列为发现。

---

## 附：探针脚本要点（可复现）

```js
// /tmp/feedaudit/probe2.mjs 骨架：stub nvim，记录 RPC
const nvim = {
  request: async (name, args) => {
    if (name === 'nvim_create_namespace') return 7
    if (name === 'nvim_win_get_width') return 120
    if (name === 'nvim_win_get_height') return 44
    return undefined
  },
  lua: async (code, args) => rpc.push({ code, args }),
}
const feed = new FeedRenderer(nvim, 1, 2, { flushDelayMs: 5 })
feed.applyEvent({ type: 'turn/start', time: 1000, data: {} })
feed.applyEvent({ type: 'assistant/chunk', time: 1100, data: { chunk: { type: 'text-delta', text: '看代码：\n```js\nconst a = 1' } } })
await feed.flush()
feed.applyEvent({ type: 'assistant/chunk', time: 1200, data: { chunk: { type: 'text-delta', text: '\n```' } } })
await feed.flush()
// filter(r => r.code.includes('highlight_syntax')) → []（F5）
```

- F1 的 nvim 契约实测：`nvim --headless -u NONE -i NONE -n --clean -c 'lua local ok,err=pcall(vim.api.nvim_buf_set_lines,0,0,-1,false,{"ok","a\nb"}); print(ok,err)' -c 'qa!'`
- F4 的 extmark 端点实测：`nvim --headless … -c 'luafile cardrow.lua'`（复刻 feed 的 `end_row/end_col` 与 api.lua 的 `row < endRow` 判定）
- 探针全部使用 `lib/feed/feed.js`（与 `src/feed/feed.ts` 同步、`git status` 干净），未改动任何源码文件。
