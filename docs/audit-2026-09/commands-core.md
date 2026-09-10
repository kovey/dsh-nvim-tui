# 审计报告：commands-core

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（dsh-nvim-tui v0.3.5，适配 dsh 0.1.5-rc.1）
- 审计单元：`commands-core`
- 必读文件（已完整通读）：
  - `src/commands/index.ts`（292 行）
  - `src/commands/core.ts`（731 行）
  - `src/commands/nlcmd.ts`（327 行）
- 交叉验证（grep + 运行内置 matcher）：
  - `src/kernel/app.ts`、`src/kernel/difficulty.ts`、`src/kernel/vision.ts`、`src/kernel/rpc.ts`、`src/kernel/host-events.ts`、`src/kernel/types.ts`
  - `src/boot/session-events.ts`、`src/sessions/services.ts`、`src/subagents/index.ts`、`src/ext-api/index.ts`、`src/commands/commands/*.ts`
  - `nvim/lua/dsh_tui/init.lua`、`autocmds.lua`、`at_menu.lua`、`popup_core.lua`
  - `node_modules/@deepseek-ai/dsh-user-approval`（`ApprovalRequestEvent`）、`dsh-agent`（`ModelSelectionRef` / `Inbox`）
- 复现手段：`node --input-type=module -e "import {matchIntent} from './lib/commands/nlcmd.js'; ..."`（`lib/` 是已构建产物，与 `src/` 同源）
- 未修改任何源码文件。

结论：**2 条高危 bug**（自然语言路由劫持聊天并产生状态副作用；`@` 补全的 `start` 参数在 App slot 包装层被丢弃导致补全菜单几乎永不弹出），4 条中危（卡片输入被绕过、审批「总是」静默降级、`fileReferences` 失败无降级、无超时的不可中断调用），4 条低危/死代码。

---

## 1. [bug / high] 自然语言路由的「带参模式」缺少问句/句子护栏，普通聊天气泡被静默改写成状态变更命令

**位置**
- `src/commands/nlcmd.ts:114-119`（`/model` 模式：`{ re: /^模型[:： ]*(.+)$/i }`）
- `src/commands/nlcmd.ts:204`（`/goal`：`{ re: /^(?:新建目标|创建目标|目标)[:： ]*(.+)$/i, arg: (m) => \`new ${m[1]}\` }`）
- `src/commands/nlcmd.ts:198`（`/memory`：`arg: (m) => \`delete ${m[1]}\``）、`nlcmd.ts:152`（`/theme`）、`nlcmd.ts:234`（`/skills`）、`nlcmd.ts:248`（`/permission`）
- 执行侧：`src/commands/core.ts:391-413`

**机制**

`matchIntent()` 的三重护栏只覆盖了输入形式的边界，没有覆盖「句子 vs 命令」的语义边界：

```ts
// nlcmd.ts:297-302
if (input === '' || input.length > 60) return null
if (/[？?]$/.test(input)) return null          // 只认「结尾」问号
if (/^[>“”"'“‘]/.test(input)) return null
// nlcmd.ts:305-311  patterns/exact 阶段（无任何句子护栏）
let hit = matchOnce(input, false)
```

而句子护栏 `SENTENCE_RE`（`nlcmd.ts:320`）**只在最末的 loose/contains 阶段生效**（`matchOnce(candidate, true)`，`nlcmd.ts:283-290` 内部的 `withContains` 分支）：

```ts
// nlcmd.ts:320-325
const SENTENCE_RE = /[了吗呢吧啊呀哦]|[是有不没别]|怎么|如何|为什么|什么/
for (const candidate of [input, strippedLead, strippedBoth]) {
  if (candidate === '' || SENTENCE_RE.test(candidate)) continue
  hit = matchOnce(candidate, true)   // 只有这里受 SENTENCE_RE 保护
```

同时多个 pattern 用 `[:： ]*`（**允许零分隔符**）+ 贪婪 `(.+)` 捕获整句，因此「以关键词开头」的中文句子会被整句吃掉。执行侧 `core.ts:410-413` 无条件执行，原始文本被丢弃（只留一行 `→ 命令:` notice，`core.ts:411`），**不会**回落到 agent：

```ts
onCommand(app, `/${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`)
return
```

**实测（构建产物，与 src 同源）**

```
"目标是什么"   => {"name":"goal","arg":"new 是什么"}      // → /goal new 是什么
"目标完成了"   => {"name":"goal","arg":"new 完成了"}      // → /goal new 完成了
"模型能力怎么样" => {"name":"model","arg":"能力怎么样"}    // → /model 能力怎么样
"记忆删除了吗"  => {"name":"memory","arg":"delete 了吗"}  // → /memory delete 了吗
"主题曲不错"   => {"name":"theme","arg":"曲不错"}
"权限不够用"   => {"name":"permission","arg":"不够用"}
"搜索功能有问题" => {"name":"search","arg":"功能有问题"}
"预设是什么"   => {"name":"preset","arg":"是什么"}
```

**影响 / 复现路径**

1. 在输入框输入 `目标是什么` 回车（不带问号，或带问号以外的任何标点）。
2. `matchIntent` 返回非 loose 命中 → `onCommand('/goal new 是什么')`。
3. `src/commands/commands/goal.ts:34-41` 直接执行 `goals.create(agent, { objective: '是什么' })` 并 notice「目标已创建」——**聊天内容被丢弃，且产生无确认的状态变更**（goal 会进入 goal 轮次/驱动流程）。
4. 同类：`记忆删除了吗` → `/memory delete 了吗`（`memory.ts:17-38` 会弹「确认删除记忆」不可逆确认框）；`模型能力怎么样` → `/model 能力怎么样` → `model.ts:34-37` 报「未知模型」，用户的消息彻底消失（既没发给模型，也没有任何回退）。

注：同一张表里 `/model` 的**另一个**模式（`nlcmd.ts:116-119`）反而做了参数校验（`/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i.test(v)`），说明作者意识到了「参数必须是模型 id」，但 `^模型[:： ]*(.+)$` 这条漏掉了同等校验。

**建议修法**

1. 对「带参模式」同样施加句末/句中护栏：把 `SENTENCE_RE` 检查提前到 `matchOnce(..., false)` 之前（或至少对 `patterns` 捕获的 arg 做形态校验），命中句子的输入一律走 loose/agent。
2. 收紧 pattern：`/^模型[:： ]+(.+)$/`（要求至少一个分隔符）+ arg 需匹配模型 id 形态；`/goal`、`/memory delete` 的 arg 同样做形态校验（`new`/`delete` 之外的裸文本改走 `show`）。
3. 高风险命令（`goal new`、`memory delete`、`compact`、`yolo`）在 NL 路由命中时改为「先回填输入框并提示 Enter 执行」（`fill_input`），而不是直接执行。
4. 兜底：非 loose 命中执行前，若 arg 为空或形态可疑，把原句交给 agent（`followup`）而不是 `onCommand`。

---

## 2. [bug / high] `@` 补全的 `start` 参数在 App slot 包装层被丢弃 → 非行首 `@` 的补全菜单永不弹出

**位置**
- `src/commands/index.ts:238`：`app.slices.agent.atQuery = (query) => atQuery(app, query)`
- `src/commands/core.ts:294`：`export const atQuery = async (app: App, query: string, start = 0)`
- `src/commands/core.ts:322`：`await app.luaCall('require("dsh_tui").set_at_menu(...)', [items, start])`
- `src/commands/core.ts:657-662`：`return app.slices.agent.atQuery(query, start)`
- 类型允许两参：`src/kernel/app.ts:299`：`atQuery: (query: string, start?: number) => Promise<void>`
- Lua 侧消费：`nvim/lua/dsh_tui/at_menu.lua:97`

**机制**

Lua 的 `AM.update()` 会算出 `@` 的 0-based 字节偏移并随通知发送：

```lua
-- nvim/lua/dsh_tui/at_menu.lua:190-192
if S.channel then
  vim.rpcnotify(S.channel, 'dsh-at-query', { query = query, start = startCol })
end
```

runner 的通知处理器也把它取出来了：

```ts
// core.ts:657-662
const payload = (args?.[0] ?? {}) as { query?: unknown; start?: unknown }
const start = Number(payload.start ?? 0)
return app.slices.agent.atQuery(query, start)
```

但 App slot 的包装函数只转发第一个参数（`index.ts:238`），于是 `atQuery(app, query)` 永远走默认 `start = 0`（`core.ts:294`），Lua 收到的恒为 `set_at_menu(items, 0)`。

Lua 侧用 `start` 做「陈旧响应 + 正确插入点」判定与拼接：

```lua
-- at_menu.lua:97-100：'@' 必须正好落在 start 报告的列上，否则直接关闭菜单
if start > #curLine or curLine:sub(start + 1, start + 1) ~= '@' then
  AM.close()
  return
end
...
S.atStart = start or 0
-- at_menu.lua:154-155：接受时从 start 处拼接
local col = math.max(math.min(cur[2], #line), start)
local newline = line:sub(1, start) .. mention .. line:sub(col + 1)
```

`start` 恒为 0 时，守卫等价于「本行第 1 个字符必须是 `@`」。

**影响 / 复现路径**

1. 输入 `看 @src/`（`@` 不在行首）→ Lua `update()` 发送 `start = 3` → runner 丢弃 → `set_at_menu(items, 0)` → 守卫 `curLine:sub(1,1) ~= '@'` → `AM.close()`：**菜单完全不显示**（同时也拿不到候选，fileReferences/本地扫描的结果被白算一次）。
2. 只有 `@src`（`@` 位于行首）时菜单才正常——即 `@` 引用补全在绝大多数真实输入（「帮我改 @core.ts」）下不可用。
3. 次要后果：若菜单在行首场景下已经打开、随后用户把光标/文本移到行中，`S.atStart` 仍是 0，`accept()` 会从第 0 列拼接，把光标前的正文整段替换成 mention。

**为什么测试没抓到**：`scripts/smoke.ts:1901` / `:1915` 只直接调用 `set_at_menu(items, 7|0)` 验证 Lua 侧，从未经过 `app.slices.agent.atQuery` 这个丢参包装层。

**建议修法**

```ts
app.slices.agent.atQuery = (query, start) => atQuery(app, query, start)
```
并加一条端到端 smoke：模拟 `dsh-at-query{query:'@src', start:3}` 断言 `set_at_menu` 收到 `start=3`（或对 `AppSlices.agent.atQuery` 做参数透传单测）。

---

## 3. [bug / medium] 卡片的 input 交互在「以 `/` 开头」的输入上被绕过：文本被当成聊天发给模型，卡片却仍处于「等待输入」状态

**位置**
- 拦截逻辑只在 `dsh-input`：`src/commands/core.ts:569-589`
- `dsh-command` 分支：`src/commands/core.ts:593-601`
- `onInput` 内**没有** `pendingCardInput` 判定：`src/commands/core.ts:325-429`（首个分支即 `pendingQueueEdit`）
- 卡片 input 动作装载 pending：`src/ext-api/index.ts:569-580`（`if (kind === 'input')` 在 569，`setPendingCardInput` 在 576，`fill_input(inputDefault)` 在 578）
- Lua 前缀分流：`nvim/lua/dsh_tui/init.lua:307-317`

**机制**

```ts
// core.ts:593-601  注释声称「route it through the same interception as dsh-input」
registerNvimNotification('dsh-command', '命令', (app, args) => {
  if (app.slices.ext.pendingCardInput !== null) {
    try { app.slices.agent.onInput(String(args?.[0] ?? '')) } catch { /* handled inside */ }
    return
  }
  ...
```

但 `onInput`（`core.ts:325`）从头到尾没有读 `pendingCardInput`：真正的卡片拦截（`resolveCardAction` + `fireCardAction` + 清空 pending）写在**兄弟处理器** `dsh-input` 的闭包里（`core.ts:569-589`）。所以这条路径只是把文本当普通输入处理：回声 + `send()` 给主 agent。

Lua 侧对「以 `/` 开头」的行一律走 `dsh-command`：

```lua
-- nvim/lua/dsh_tui/init.lua:307-317
if text:match('^/') then ... vim.rpcnotify(S.channel, 'dsh-command', text)
else vim.rpcnotify(S.channel, 'dsh-input', text) end
```

**影响 / 复现路径**

1. 扩展卡片（`kind: 'input'`，`ext-api/index.ts:572`）装载 `pendingCardInput`，提示「✎ 输入…参数（Enter 提交）」；`inputDefault` 也可能通过 `fill_input` 预填（`ext-api/index.ts:578`）。
2. 用户输入任意以 `/` 开头的内容（绝对路径 `/Users/...`、`/tmp`，或直接敲一个 slash 命令）回车。
3. Lua 走 `dsh-command` → `onInput` → 该文本被**作为聊天消息发给主 agent**（`core.ts:423-429`），卡片动作从未 `fireCardAction`，扩展永远收不到答案。
4. 更糟：`pendingCardInput` 仍处于装载状态，随后**任意一条**普通输入会被 `core.ts:569-589` 当作卡片输入吞掉（`setPendingCardInput(null)` + `fireCardAction`），用户以为在跟 agent 说话，实际内容进了卡片回调。

**建议修法**

把卡片拦截抽成 `core.ts` 内的一个函数（如 `claimCardInput(app, raw)`），在 `dsh-input` 与 `dsh-command` 两个处理器里**先**调用；或者干脆在 `onInput` 开头做同样的判定，让两条通知路径共用一份实现（注释描述的语义就是这个）。

---

## 4. [bug / medium] 审批浮窗的「总是（自动模式）」对子代理审批静默降级为「允许一次」，且无任何提示

**位置**
- `src/commands/core.ts:607-635`（`dsh-approval-decided`），核心分支 `core.ts:609-627`
- 队列设计本身承认父子并发：`src/commands/index.ts:73-75`、`core.ts:685-687`
- 只对「已 attach 的主会话」可见：`src/sessions/services.ts:42`（`app.slices.sessions.live.set(id, …)` 仅此一处写入，调用方是 `attachSession`）
- 对照实现（两者都提示）：`src/commands/commands/yolo.ts:18-25`

**机制**

```ts
// core.ts:609-627
if (raw === 'always') {
  const sid = app.slices.agent.approvalReq?.agent?.session?.id
  if (sid !== undefined) {
    const rec = app.slices.sessions.live.get(sid)         // ← 子代理会话不在这个 map 里
    if (rec) {
      try {
        rec.handle.agent.session.append('approval/policy', { policy: 'never' })
        rec.policy = 'never'
        ...
      } catch { /* policy switch is best-effort */ }
    }
    // ← rec 为 undefined 时：没有任何 else、没有 notice、没有日志
  }
  app.slices.agent.settleApproval('allowed-once')          // 无论如何都只放行这一次
}
```

- `ApprovalRequestEvent.agent` 在宿主侧恒存在（`node_modules/@deepseek-ai/dsh-user-approval/lib/types/types.d.ts:55-76`），所以 `sid` 通常是有效的；但 `app.slices.sessions.live` 只包含 TUI attach 过的会话（`sessions/services.ts:42`），**子代理的子会话不在其中**（子代理由 `sessions.runningSubagents` / 子代理对话窗的独立 Feed 管理，见 `src/subagents/index.ts:100-180`）。
- 结果：当浮窗里显示的是**子代理**发起的审批（父子并发时完全可能，见 `index.ts:73-75` 的设计注释），用户按 `[a] 总是（自动模式）`（Lua 按钮见 `nvim/lua/dsh_tui/popup_core.lua:234`），既没有切到自动模式，也没有任何「本次仅允许一次」的提示，只放行了这一次。
- 后续同一子代理再次申请审批时仍会弹窗，用户会认为「我明明选了总是」——静默失败。
- 对比 `/yolo`：同样的 `session.append('approval/policy', …)` 机制，但成功/失败两条路径都有 notice（`yolo.ts:22-24`）。

**建议修法**

1. 直接用请求自带的 agent，而不是反查 live map：
   ```ts
   const agent = app.slices.agent.approvalReq?.agent
   agent?.session.append('approval/policy', { policy: 'never' })
   ```
   （`ApprovalRequest` 已带 `agent?: { session?: { id?: string } }`，可把类型放宽为 `{ session?: { id?: string; append?: (...) => void } }`。）
2. 无法切换策略时（无 agent / 无 append）必须 `app.notice('⚠ 无法切换自动审批模式（子代理会话），本条已按「允许一次」处理')`，不能静默。
3. 顺带修 `catch {}`：至少把错误写进 `app.errorLogPath`（同 `onCommand` 的做法，`core.ts:471-478`）。

---

## 5. [missing-feature / medium] `fileReferences.list` 调用失败时没有任何降级：`@` 菜单静默为空（文档只承诺「服务缺失」降级）

**位置**
- `src/commands/core.ts:298-306`
- 文档承诺：`REQUIREMENTS.md:302`（R-M7-3「`fileReferences` 服务缺失时降级为本地扫描」）
- 空结果静默关闭：`nvim/lua/dsh_tui/at_menu.lua:105-108`

**机制**

```ts
// core.ts:298-306
try {
  const fr = app.svc('fileReferences')
  if (typeof fr?.list === 'function' && agent) {
    const cands = await fr.list(agent, query, new AbortController().signal)
    items = (cands ?? []).map((c) => ({ path: c.path, mention: formatMention(c.path) }))
  } else {
    items = await localFileCandidates(activeSessionCwd(app), query)   // ← 只有「服务缺失」才走这里
  }
} catch {}                                                            // ← list() 抛错：items 保持 []
```

本地扫描的降级只在 `typeof fr?.list !== 'function'`（服务未装配）时触发；一旦服务已装配但调用抛错（索引未就绪、权限、宿主内部错误），异常被 `catch {}` 吞掉，`items` 保持空数组，随后 `set_at_menu([], start)` → Lua 直接 `AM.close()`（`at_menu.lua:105-108`）→ 用户看到的是「@ 菜单偶尔打不开」，且**没有任何 notice / 日志**。

**复现路径**

挂一个 `fileReferences.list` 会 reject 的 stub（或让其实现在索引构建期抛错），输入 `@a`：菜单不出现、无任何提示；把服务的 `list` 整个删掉（未装配）反而正常降级。两者行为不一致。

**建议修法**

```ts
try {
  const fr = app.svc('fileReferences')
  if (typeof fr?.list === 'function' && agent) {
    const cands = await fr.list(agent, query, new AbortController().signal)
    items = (cands ?? []).map(...)
  }
} catch (err) {
  app.exitDiag('at-query-service', err)        // 不静默
} finally {
  if (items.length === 0) {
    try { items = await localFileCandidates(activeSessionCwd(app), query) } catch {}
  }
}
```

---

## 6. [risk / medium] 三处「永不 abort 的 AbortController + 无超时」：`@` 查询与子代理续聊可能永久挂起且无任何反馈

**位置**
- `src/commands/core.ts:301`（`fr.list(agent, query, new AbortController().signal)`）
- `src/commands/core.ts:310`（`sessionRef.listCandidates(agent, query, 8, new AbortController().signal)`）
- `src/commands/core.ts:158`（`subagents.prompt({...}, new AbortController().signal)`）
- `src/commands/core.ts:176`（pre-0.1.5 路径同样）
- 反馈时机：`src/commands/core.ts:193-201`（`await` **之后**才 notice）
- 对照：项目里已有超时范式 `src/kernel/difficulty.ts:107-110`（`AbortSignal.timeout(timeoutMs)`）

**机制**

三处都新建了 `AbortController` 但从不 `abort()`，也没有 `Promise.race` 超时：

- `atQuery`：两个服务调用都位于同一条 keystroke 触发的异步链上；若服务 hang，`set_at_menu` 永不执行 → 用户每次输入 `@…` 都得不到菜单（且 `AM.update()` 会在每个 `TextChangedI` 再发一次，堆积多个挂起 promise）。
- `queueSubagentPrompt`：`subagents.prompt(...)` 若因宿主队列/子代理状态迟迟不 settle，`send()` 里的 IIFE（`core.ts:193-201`）既不会 notice 成功也不会 notice 失败——用户按回车后**界面毫无反应**（对比子代理对话窗路径会先做乐观回声 + 「⏳ 已排队」，`src/subagents/index.ts:209-215`）。

**建议修法**

给两个调用各加超时（例如 `AbortSignal.timeout(5000)` 或自建 controller + `setTimeout(abort)`），超时后在 `atQuery` 里吞掉并回落到本地扫描（见第 5 条）；在 `queueSubagentPrompt` 里超时即抛错，让 `send()` 的 catch 打出「子代理续聊超时」notice。另外把「已发送给子代理」的 notice 提前到 `await` 之前（或改为乐观回声 + 失败回滚），避免无反馈窗口。

---

## 7. [bug / low] `SENTENCE_RE` 护栏覆盖不到它自己文档里举的例子：「帮我看看记忆」仍会被注入 `tui_command` 路由提示

**位置**
- 护栏与文档：`src/commands/nlcmd.ts:318-325`（`SENTENCE_RE` 在 `nlcmd.ts:320`）
- 提示注入：`src/commands/core.ts:392-408`

**机制**

注释（`nlcmd.ts:318-319`）明确写：**「a sentence with particles («状态栏不见了», «帮我看看记忆») is chat for the agent, never a command hint」**。但：

```ts
const SENTENCE_RE = /[了吗呢吧啊呀哦]|[是有不没别]|怎么|如何|为什么|什么/
```

「帮我看看记忆」不含上述任何字符（`看`/`帮`/`我` 都不在集合里），因此通过护栏，最终命中 loose（`contains: ['记忆','memory']`）。

**实测**

```
"帮我看看记忆" => {"name":"memory","loose":true}     // 与注释承诺相反
"状态栏不见了" => null                                 // 这条确实被拦住（含「不」）
```

**影响 / 复现路径**

输入「帮我看看记忆」回车 → `core.ts:392-406` 走 loose 分支：把 `（TUI 操作判定：这句话可能是想执行命令 /memory。若确实如此，请调用 tui_command 工具…）` 前缀拼进用户消息（`core.ts:401`）并 `followup` 给模型。用户的普通提问被塞入一段「可能是命令」的引导，模型有实际概率去调用 `tui_command` 打开记忆面板而不是回答问题；同时该前缀也会被写入会话历史（`nlRec.feed.pushUser(hint, [])`）。

**建议修法**

把 `SENTENCE_RE` 扩到「第二人称 + 看/查/问/说」等句法线索（如 `看|问|帮|我|你|能|可以|吗|么|怎样|如何|是否`），或改成「命中 loose 前要求输入是纯名词短语（无动词/代词）」的白名单判定；至少让注释与实现一致（若「帮我看看记忆」确实想走 hint，就修正注释）。

---

## 8. [bug / low] `/subagents → 继续对话` 的输入被乐观回声到**父会话** feed，父会话 transcript 出现从未收到的用户气泡

**位置**
- 回声（在 `send()` 之前）：`src/commands/core.ts:415-429`
- 重定向到子代理：`src/commands/core.ts:187-202`
- 对照（子代理对话窗路径按 childId 记账）：`src/subagents/index.ts:209-215`
- 装载 pending：`src/subagents/commands/subagents.ts:74-75`

**机制**

`onInput` 在路由完之后统一按「活跃会话」做乐观回声：

```ts
// core.ts:415-429
const echoRec = ...activeId...
if (echoRec !== undefined && pendingImages.length === 0 && split.images.length === 0) {
  echoRec.feed.pushUser(split.text, [])
  const q = app.slices.ui.pendingEchoes.get(app.slices.sessions.activeId as string) ?? []
  q.push(split.text); ... 
}
send(app, trimmed)                      // ← send 内部才判断 pendingSubagentFollowup
```

而 `send()` 在 `pendingSubagentFollowup !== null` 时把这条文本发给了**子代理**并 `return`（`core.ts:190-201`）。于是：

- 父会话 feed 出现一条用户气泡，但父会话的 durable history 里没有这条消息（重新加载会话后气泡消失）；
- 父会话 `pendingEchoes` 里留下一条永不匹配的条目（得益于「任意位置匹配」的自愈去重 `src/boot/session-events.ts:293-305`，不会造成后续丢气泡，但会一直占位直到长度上限 16 被挤出）；
- 用户无法从界面上分辨这条消息是发给了主 agent 还是子代理（唯一的线索是 `subagents.ts:75` 的一次性 notice 与状态栏 `⇢ label`）。

**建议修读**：在 `onInput` 里把回声/去重记账改为按「真实目标会话」：`pendingSubagentFollowup !== null` 时不要给父 feed 推用户气泡（或推到目标子代理的记账队列，与 `subagents/index.ts:209-215` 保持同一套键）。

---

## 9. [deadcode / low] 三个 owner op 无任何调用方（被同模块的直接写切片绕过）

**位置**
- `src/commands/index.ts:71`：`A.setApproval = (entry, settle) => { A.approvalReq = entry; A.approvalSettle = settle }`
- `src/commands/index.ts:130`：`A.setQuestions = (r) => { A.questionsResolve = r }`
- `src/commands/index.ts:184`：`A.setDirSettle = (fn) => { A.dirSettle = fn }`
- 类型声明（同样无人调用）：`src/kernel/app.ts:330`、`app.ts:334`、`app.ts:337`

**证据（grep 全仓 `src/` + `scripts/`，排除 node_modules）**

```
$ grep -rn "\.setApproval("   --include=*.ts src scripts   → 无输出
$ grep -rn "\.setQuestions("  --include=*.ts src scripts   → 无输出
$ grep -rn "\.setDirSettle("  --include=*.ts src scripts   → 无输出
# 仅有的提及是定义处与一条历史注释：
src/commands/index.ts:71 / :130 / :184
src/commands/core.ts:639  （注释：「the old inline resolve + setQuestions(null) …」）
```

对照：其余同族 op 都有真实调用方——`setPickerSettle`（`kernel/app.ts:554`）、`settlePicker`（`core.ts:647,650`）、`setPendingRename`（`sessions/commands/sessions.ts:84` 等）、`setPendingQueueEdit`（`transcript/commands/queue.ts:58`）、`setLivePopup`（`commands/todo.ts:40`）、`clearPendings`（`sessions/services.ts:212`）。

`setDirSettle` 尤其能说明问题：它自己的模块在 `core.ts:260-265` 直接写切片字段 `W(app.slices.agent).dirSettle = resolve`，绕过了这个 op。

**影响**：不是运行时缺陷，但 `AppSlices.agent` 宣称的「跨模块只能通过 owner op 改状态」的契约被这三处空实现削弱（其中 `setApproval` 还是**旧单槽语义**：若将来有人调用它，会在有排队条目时直接覆盖 `approvalReq`/`approvalSettle`，正是 `index.ts:73-75` 注释警告过的那类回归）。

**建议修法**：删除这三个赋值与对应的接口成员（或把 `core.ts:260-265` 改为调用 `setDirSettle`，并把 `setApproval`/`setQuestions` 明确标注为 deprecated 且改为转发到 `enqueue*`）。

---

## 10. [risk / low] `send()` 先清空 `pendingImages` 再调用可能中途 return 的 `followup` → 附加失败时用户排队的图片被丢弃

**位置**
- 清空：`src/commands/core.ts:212-215`
- 可能提前 return 的分支：`core.ts:60-64`（attachments 服务缺失）、`core.ts:76-80`（目录无识图模型）、`core.ts:114-126`（`saveImage` 抛错）

**机制**

```ts
// core.ts:212-215
const all = [...parsed, ...app.slices.agent.pendingImages]
W(app.slices.agent).pendingImages = []      // ← 先清空
void followup(app, rec, clean, all)         // ← 内部可能直接 return
```

`followup` 上述三个分支都会 `app.notice(...) + return`（不发消息）。此时 `<C-v>` 累积的剪贴板图片已经不在 `pendingImages` 里、也不在 `all` 的任何可回收位置，用户必须重新截图/复制。虽然每种失败都有 notice（不是全静默），但状态丢失没有回滚。

**建议修法**：把「消费 pendingImages」推迟到 `followup` 真正进入发送路径之后（例如 `followup` 返回一个布尔/结果，或在 `send()` 里 `await followup` 并在返回值表示未发送时把 `all` 中来源为 `pendingImages` 的部分写回）；至少把「图片已丢弃，请重新附加」写进失败 notice。

---

## 附：已核查但**未**认定为缺陷的点（避免误报记录）

| 观察点 | 结论 |
| --- | --- |
| `core.ts:52-54` `await routeDifficultyForTurn(...)` 未包 try/catch（注释称「失败不阻断发送」） | **非缺陷**：`kernel/difficulty.ts:246-297` 全函数 try/catch 且注释「Never throws」，任何内部异常都会 notice 后返回 |
| `core.ts:247` `rec.status !== '● running'`（严格相等）与 `core.ts:47` / `difficulty.ts:256` 的 `startsWith('● running')` 不一致 | **暂不改判**：全仓 `rec.status` 只有 `statusline/index.ts:368/371` 两个写入点，值恒为 `'● running'` / `'○ idle'`；`'● running ◇N'`（`statusline/index.ts:93`）只是 badge 显示串，不写入 `rec.status` |
| `core.ts:91-96` `else if (rec.visionTmp !== null) rec.visionTmp.switchAt = ...` 对 `undefined` 会抛 | **非缺陷**：`sessions/services.ts:63` 建记录时初始化 `visionTmp: null` |
| `core.ts:341-343` 队列编辑 `inbox.replace(messageId, msg)` 是否与宿主签名一致 | **一致**：宿主 `Inbox.replace(messageId, newMessage): boolean`（`node_modules/@deepseek-ai/dsh-agent/lib/types/inbox.d.ts:64`），`pendingQueueEdit.list` 不参与调用是宿主 API 本来如此 |
| `core.ts:150-160` `subagents.prompt` 请求体形状 | **一致**：`{requestId, parentSessionId, childSessionId, mode:'continuable', delivery:'queue', content}` 与 `kernel/types.ts:154-161`、`UPGRADE.md:13-16` 的 0.1.5 说明逐一对应；两条 face 的分支顺序（先 public `prompt`，再 symbol 队列）合理 |
| `core.ts:279-289` `requeuePromptKey` 绑定 `this` 调用 | 正确：`.call(subagentsSvc, …)`（注释记录的崩溃场景已规避） |
| `index.ts:246` 注释「the 40 slash commands」而实际 41 个 `install*` 调用；`index.ts:63` 与 `229-230` 注释重复/错位 | 纯文档瑕疵，未计入发现（41 个安装调用与 `src/commands/commands/*.ts` 一一对应，无漏装） |
| `index.ts:71/130/184` 之外，命令注册装配完整性 | 已脚本核对：`src/commands/commands/` 下 41 个文件的 `installXxxCommand` 全部出现在 `index.ts`；`TUI_COMMAND_WHITELIST`（`core.ts:482-492`）中 25 个名字全部在 `installCommands` 之前由 statusline/sessions/subagents/transcript/commands 模块注册 |
| `core.ts:539-551` `tui_command.execute` 无条件返回 `{executed:true}` | 潜在误导（`onCommand` 是 fire-and-forget，未知命令也会返回 true），但当前白名单内名字全部已注册，无实际误报路径，未计入 |
| `index.ts:76-127` 审批/提问队列（并发父子） | 设计正确：`showXxxFloat` 的 catch 做身份校验后 settle，`settleXxx` 内部 `advanceXxx()`，`abortXxx` 标记 `cancelled` 由 `advanceXxx` 跳过；`kernel/lifecycle.ts:87-88` 在拆卸时 `drainApprovals/drainQuestions` 兜底 |
