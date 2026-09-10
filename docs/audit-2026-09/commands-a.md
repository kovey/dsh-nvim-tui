# 审计报告 · 单元 commands-a（dsh-nvim-tui @ v0.3.5 / dsh 0.1.5-rc.1）

> 审计对象：`src/commands/commands/` 下的 18 个斜杠命令 + `src/deps/commands/deps.ts`
> 方法：完整通读必读文件（`read` 全文）→ 追调用方/被调方（`grep` 全仓）→ 与宿主契约（`src/kernel/*.ts`）、Lua 前端（`nvim/lua/dsh_tui/*.lua`）、守卫脚本（`scripts/check-arch.mjs`）、文档（README / docs/REVIEW-2025-09.md）交叉验证。
> 全程只读，未修改任何源码；本报告为唯一新增文件。

## 0. 范围说明（与任务书的一处不一致）

任务书「必读文件」中的 `src/commands/commands/deps.ts` **不存在**；`/deps` 实际实现在
`src/deps/commands/deps.ts`（由 `src/deps/index.ts:14-19` → `src/index.ts:47,88` 装配，`grep "installDeps"` 有唯一调用链，非死代码）。
已按该真实路径完成审计：`deps.ts` 参数校验（`install` / 其他 → 用法提示 / 空 → 报告）与
`show_lines_float` 失败吞异常（第 44 行）属下述 F12 同类模式，未单列。其余 17 个文件路径与任务书一致。

---

## 1. 发现清单（按严重度排序）

### F1 · bug / high · 无活跃会话时「降级提示」全部被静默吞掉（本单元 7 处命中）

**位置**
- 本单元：`src/commands/commands/compact.ts:13`、`context.ts:15`、`deliverables.ts:12`、`fb.ts:11`、`goal.ts:12`、`image.ts:26`、`difficulty.ts:12`
- 跨模块同类（同一机制，共 20+ 处）：`src/commands/core.ts:222,244`、`status.ts:12`、`todo.ts:14`、`mcp.ts:11`、`permission.ts:13`、`skills.ts:11`、`steer.ts:17`、`tasks.ts:11`、`plan.ts:11`、`src/subagents/index.ts:110`、`subagents/commands/subagents.ts:10`、`transcript/commands/rewind.ts:9`、`trajectory.ts:10`、`queue.ts:10`、`sessions/commands/rename.ts:14`

**机制（确定的因果链，不是猜测）**

唯一 notice 实现把消息写进「当前活动会话的 feed」：

```ts
// src/kernel/app.ts:542-546
app.slices.ui.activeFeed = () => {
  const rec = app.slices.sessions.activeId === null ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  return rec?.feed                       // ← 无活动会话 → undefined
}
app.notice = (text: unknown): void => { app.slices.ui.activeFeed()?.appendNotice(text) }
```

而每个守卫分支取的 `rec` 与 `activeFeed()` 取的 `rec` **完全同一个表达式**：

```ts
// 例：src/commands/commands/compact.ts:11-14
const rec = app.slices.sessions.activeId === null ? undefined
  : app.slices.sessions.live.get(app.slices.sessions.activeId)
if (!rec) { app.notice(t('无活跃会话')); return }   // ← 这条 notice 必然落到 undefined 上
```

即：**进入 `!rec` 分支 ⇒ `activeFeed()` 必为 undefined ⇒ 提示被 `?.` 静默丢弃**。7 个命令（/compact /context /deliverables /fb /goal /image /difficulty）在该状态下表现为「输入命令 → 界面毫无反应」。`bell.ts`/`config.ts`/`doctor.ts`/`help.ts`/`history.ts`/`dir.ts`/`lines.ts`/`attach.ts`(部分) 不依赖会话，故不受影响。

**可达窗口（非理论）**：nvim 在 `spawnNvim` 后即连接并接受输入（`dsh-input`/`dsh-command` 在 `src/commands/core.ts:564,593` 注册，与 `activeId` 无关），而 `activeId` 仅在 `src/sessions/services.ts:214` 一处被赋值、初值为 `null`（`src/sessions/index.ts:153`），`resumeOrCreate()` 在 `src/boot/boot.ts:219` 才执行（建会话/恢复会话需数次 await+IO）。启动后立即输入 `/context` 即命中；恢复会话失败走 `createSession()` 抛错时（`src/sessions/index.ts:327-337`，其中 335 行再次 `createSession()` 失败即上抛至 boot catch）也会停留在无会话态。

**附带文案缺陷**：`src/commands/commands/attach.ts:31-36` 在同一分支里用

```ts
if (!rec || typeof attachments?.saveImage !== 'function') { app.notice(t('附件服务未装配')); return }
```

把「没有活跃会话」误报成「附件服务未装配」（且和上面一样被吞掉）。

**复现**：`dsh` 启动瞬间（会话列出现前）输入 `/context`、`/compact`、`/image` 任意一条 → 无任何输出；`attach.ts` 若在无会话时给图片路径 → 无任何输出。
**建议**：`app.notice` 增加无会话兜底 sink（例如 `activeFeed()` 为空时退到 `app.luaCall('require("dsh_tui").echo_notice(...)')` 或状态栏一次性提示），或在 boot 完成前拒绝命令分发并提示「会话初始化中」；`attach.ts:34` 拆分两种原因。

---

### F2 · bug / medium · 目录选择器「取消」永不结算 → `/dir`、`/lines`、`/attach`（无参）永久挂起

**位置**：`src/commands/core.ts:260-265`（挂起方）；`nvim/lua/dsh_tui/popups.lua:321-322, 356-365, 367-377`（取消方不发通知）

**机制**：Node 侧的 promise 只有两个 settle 来源 —— RPC 通知 `dsh-dir-selected` 或 `luaCall` reject：

```ts
// src/commands/core.ts:260-265
export const openDirPicker = (app: App, startPath: string): Promise<string | null> => new Promise((resolve) => {
  if (app.slices.agent.dirSettle !== null) app.slices.agent.resolveDirPicker(null)
  W(app.slices.agent).dirSettle = resolve
  void app.luaCall('require("dsh_tui").show_dir_picker(...)', [startPath ?? process.cwd()])
    .catch(() => { W(app.slices.agent).dirSettle = null; resolve(null) })
})
```

Lua 侧所有「取消」路径都只调 `P.close_dir_picker()`，该函数**没有任何 rpcnotify**：

```lua
-- nvim/lua/dsh_tui/popups.lua:367-377
function P.close_dir_picker()
  detach_footer()
  if S.dirWin and vim.api.nvim_win_is_valid(S.dirWin) then pcall(vim.api.nvim_win_close, S.dirWin, true) end
  S.dirWin = nil; S.dirBuf = nil; S.dirPath = nil; S.dirRows = {}; S.dirIdx = 1
end
```

调用点：`k('q', ...close_dir_picker)`、`k('<Esc>', ...close_dir_picker)`（`popups.lua:321-322`）、`dir_up()` 到根（`popups.lua:356-365`）、目录不可读时 `render_dir_picker` 的 `entries == nil` 分支（`popups.lua:252-255`）。
对照：通用 picker 明确发取消通知 —— `popup_core.lua:543-548 picker_cancel()` → `rpcnotify('dsh-picker-cancelled')`，`popup_core.lua:152` 同样。而 `popups.lua:213-215` 注释与 `popups.lua:246` footer 文案（`[Esc] 取消`）都宣称支持取消 —— **声明与实现不符**。

**影响/复现**：`/dir`（`dir.ts:15`）、`/lines`（`lines.ts:17`）、`/attach`（`attach.ts:19`）无参版本 → 在浮窗按 `Esc`/`q` → 命令无任何反应（await 永不返回；无超时、无提示）。同类调用方还有 `src/sessions/commands/new.ts:17`、`workspace.ts:71`。
**建议**：`close_dir_picker` 末尾补 `if S.channel then vim.rpcnotify(S.channel, 'dsh-dir-selected', vim.NIL) end`（Node 侧 `core.ts:652-656 → index.ts:185 resolveDirPicker(picked ?? null)` 已能处理 null），并给 `openDirPicker` 加超时兜底。

---

### F3 · bug / medium · 文档承诺的 `~/` 支持失效（C5 修复引入的回归；`readImageFile` 的 `~/` 分支已成死代码）

**位置**：`src/commands/commands/image.ts:29-42`（37 行 join、38 行读取）、`src/commands/commands/attach.ts:22,28`、`src/feed/images.ts:58-60`、`README.md:244`

**机制**：`readImageFile` 自己会展开 `~`：

```ts
// src/feed/images.ts:58-60
export function readImageFile(path: string, _knownMediaType?: string | null): SaveImageAttachment {
  const resolved = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  const raw = readFileSync(resolved)
```

但两个调用方**先**把路径钉成了会话 cwd 下的相对路径：

```ts
// src/commands/commands/image.ts:37-38
const abs = isAbsolute(m[1]) ? m[1] : join(activeSessionCwd(app), m[1])
image = readImageFile(abs)
```

`isAbsolute('~/a.png') === false`（已用 `node -e` 验证），于是变成 `<cwd>/~/a.png` → `readFileSync` 抛 ENOENT。
全仓 `readImageFile` 调用点只有这两个（`grep -rn "readImageFile" src/`：`image.ts:38`、`attach.ts:28`），因此 `images.ts:59` 的 `~/` 展开分支**对现有全部调用方不可达 → 死代码**。

**文档面**：`README.md:244` 明确写 `/image <路径> [提示]` …「本地图片（png/jpg/webp/gif，**支持 `~/`**）」。
**回归来源**：`git log -p -- src/commands/commands/image.ts` 显示 `1f36ecd`（docs/REVIEW-2025-09.md 的 C5 修复）把 `image = readImageFile(m[1])` 改为先 `join(activeSessionCwd(app), m[1])`，把原本可用的 `~/` 展开挡在门外。

**复现**：`/image ~/Desktop/a.png 看一下` → `读取图片失败: ENOENT: no such file or directory, open '<cwd>/~/Desktop/a.png'`。
**建议**：先展开 `~` 再判 `isAbsolute`（抽成 kernel 帮助函数，boot/attach/lines 共用），或让 `readImageFile` 只接受绝对路径并把展开责任显式交给调用方。

---

### F4 · bug / medium · `/attach` 把「读取失败」当成「非图片」，且 luaCall 失败仍报成功

**位置**：`src/commands/commands/attach.ts:26-29`（吞异常）、`48-50`（无条件成功提示）、`49`（吞 luaCall 失败）

**机制一（误报成功）**：`readImageFile` 在「文件不存在 / 不可读 / EISDIR / 魔数与扩展名都不支持」时**都抛错**（`feed/images.ts:60,66-68`），注释也承认「it throws for non-images, which is how we tell …」（`attach.ts:23-25`）。但 catch 丢弃了 err：

```ts
try { img = await readImageFile(abs) } catch { /* not a readable image → fall through to @-mention */ }
…
await app.luaCall('require("dsh_tui").append_input(...)', [formatMention(rel) + ' ']).catch(() => {})
app.notice(`已引用: ${rel}（@ 路径会随消息发送，模型按需读取）`)   // ← 无条件
```

后果：`/attach /tmp/nope.png`（不存在）、`/attach shot.heic`（存在但格式不支持，`images.ts:66-68` 的「不支持的图片格式」永不可见）、`/attach /etc`（目录）都会被提示成「已引用」。注意 `image.ts:39-42` 对同一 API 是区分并报错的 —— 两处行为不一致。

**机制二（假成功）**：`append_input` 的失败被 `.catch(() => {})` 吞掉后仍打印同一句成功提示 —— 输入框里其实什么都没插入（例如 nvim 通道异常 / 输入窗未就绪），用户却被告知「已引用」。

**复现**：`/attach /tmp/definitely-missing.png` → 提示「已引用: /tmp/definitely-missing.png（@ 路径会随消息发送，模型按需读取）」。
**建议**：catch 里区分 `err.code`（ENOENT/EACCES/EISDIR 直接 `notice('无法读取 …')` + return；仅「魔数与扩展名均非图片」才降级为 @ 引用）；`append_input` 改为 `const ok = await …catch(() => false)`，仅 `ok === true` 才打印成功。

---

### F5 · bug / medium · `/locale` 切换后命令目录仍是旧语言（`refreshCommandCatalog` 重发的是安装期冻结的字符串）

**位置**：`src/commands/commands/locale.ts:20-24`（22 行 refresh）、`locale.ts:28` 及全部注册点、`src/kernel/app.ts:515-529`、`src/kernel/i18n.ts:26-29`

**机制**：`desc`/`usage` 在**注册那一刻**就调用 `t()` 求值成普通字符串并存入 `app.commandSpecs`（例：`locale.ts:28 desc: t('语言 (zh/en)')`；注册唯一入口 `src/index.ts:86 installCommands(app)`，进程内只跑一次）：

```ts
// src/kernel/app.ts:516-529
refreshCommandCatalog: async (): Promise<void> => {
  const entries = app.commandSpecs.map(({ name, desc }) => ({ name, desc }))   // ← 冻结后的中文串，无 t()
  …
```

而 `t()` 只在调用时查字典（`i18n.ts:26-29`）。因此 `/locale en` 之后：notice（运行期 `t()`）→ 英文；`/help` 列表（`help.ts:24` 读 `s.desc`）与 Lua 命令补全菜单（`set_commands` 收到的同一批 desc）→ 仍是中文。`locale.ts:22` 调用 `refreshCommandCatalog()` 的**目的正是刷新这份目录，但刷新是无效的**（`README.md:145` 宣称「运行时 `/locale` 切换」）。

**复现**：`/locale en` → `/help` 打开：分组标题（`s.group`）与每行 `usage · desc` **全部仍是中文**（group/usage/desc 三者在注册期一起冻结），只有运行期 `t()` 的 notice 变成英文 —— 同一屏中英混杂。
**建议**：注册时保留 zh 原文（或把 `desc` 改成 `() => t(zhKey)` 惰性求值），在 `commandCatalog()`/`refreshCommandCatalog()`/`help.ts` 渲染处再翻译。

---

### F6 · risk / medium · `openDirPicker` 失败兜底无条件清槽 —— 与已修复的 picker K5 同类竞态

**位置**：`src/commands/core.ts:261-264`；对照 `src/kernel/app.ts:548-563`（K5 修复 + 注释）；`src/commands/index.ts:184-185`

**机制**：`core.ts:261` 先结算旧请求并把槽位换成本次 `resolve`（`index.ts:185 resolveDirPicker` 会置 `dirSettle = null`）：

```ts
if (app.slices.agent.dirSettle !== null) app.slices.agent.resolveDirPicker(null)
W(app.slices.agent).dirSettle = resolve
void app.luaCall(…).catch(() => { W(app.slices.agent).dirSettle = null; resolve(null) })   // ← 无条件清槽
```

若**第 1 次**调用的 `luaCall` 迟到失败（nvim 已退出 / 通道 wedged / Lua 报错），第 264 行会把**第 2 次**调用刚写入的 settle 抹成 `null` → 用户在第 2 个浮窗里选中文件 → `dsh-dir-selected` 到达 → `resolveDirPicker` 取到 `null` → **选择被丢弃，第 2 个 await 永不返回**（叠加 F2 时全程静默）。

**证据（同类已修）**：`app.ts:556-562` 的注释逐字描述了这个故障模式 —— "a STALE picker's failed open must not cancel its successor (pre-review: the unconditional settlePicker(null) settled picker #2 when picker #1's luaCall rejected late — the user's #2 choice was silently discarded)"，修复方式是身份校验 `if (app.slices.agent.pickerSettle === resolve)`；dir picker 侧漏改。对应 docs/REVIEW-2025-09.md 的 K5（缺 1）。
**复现**：让第 1 次 `/lines` 的 luaCall 失败（nvim 侧 Lua 抛错即可），随即第 2 次 `/lines` 正常打开浮窗 → 选中文件无任何反应。
**建议**：与 picker 对齐：`if (app.slices.agent.dirSettle === resolve) { W(app.slices.agent).dirSettle = null; resolve(null) }`。

---

### F7 · risk / medium · `/compact` 无超时、无取消通道（`AbortController` 即用即弃）

**位置**：`src/commands/commands/compact.ts:21-31`（关键行 23）

```ts
app.notice(t('正在压缩上下文…'))
try {
  const result = await compaction.compactNow(rec.handle.agent, new AbortController().signal)  // 信号无任何引用 → 永不 abort
  …
} catch (err) { app.notice(`压缩失败: ${(err as Error).message}`) }
```

**机制**：`new AbortController().signal` 创建后不被任何变量持有，运行期不可能被 abort；命令也没有超时。若宿主 `compactNow` 长时间不 settle（模型调用挂住、宿主内部关闭），第 22 行的 try 不会命中，用户永远停在「正在压缩上下文…」——既无超时提示也无法中止：`/stop` 走 `agent.cancel`（`core.ts:241-257`），与 compaction 完全无关。命令在 `onCommand` 中不 await（`core.ts:469-478`），UI 不冻结，因此**没有任何可观察的失败信号**。
**建议**：持有 controller + 有界超时（超时 `abort()` 并 notice「压缩超时」），或把该 controller 注册进 `/stop` 的取消集合。

---

### F8 · risk / medium · `/attach` 对任意用户路径做无上限同步全量读（阻塞事件循环 / 内存放大）

**位置**：`src/commands/commands/attach.ts:22-29`（28 行）→ `src/feed/images.ts:58-70`（60 行 `readFileSync`）

**机制**：`readImageFile` 为嗅探 12 字节魔数（`images.ts:27-45`）把**整个文件**同步读入 Buffer，无任何大小上限：

```ts
const raw = readFileSync(resolved)      // images.ts:60 —— 全量、同步
let mediaType = sniffMediaType(raw)     // 只需要前 12 字节
```

而 `/attach` 的语义是「任意路径」（`attach.ts:16-22`），用户完全可能给出 GB 级视频/ISO：Node 主线程同步阻塞数秒~数十秒（期间 TUI 事件、RPC、spinner 全停），并一次性巨额分配（OOM 风险）。对照：`/lines` 走的 `readFileSnapshot` 有 256KB 上限（`src/transcript/index.ts:228-236`）。
**已知未修**：`docs/REVIEW-2025-09.md:147` 已把「image.ts / attach.ts readFileSync 无大小上限阻塞主线程」列为次要问题；本次复核该问题**仍然存在**（`image.ts:38` 同一路径）。
**建议**：先 `stat`（`isFile` + 大小上限，如 32MB），超限直接报错；嗅探改用 fd 只读前 16 字节。

---

### F9 · bug / low · `/fb` 把「list 失败」当成「没有反馈记录」，并带 `ifVersion: null` 继续写

**位置**：`src/commands/commands/fb.ts:29-38`（clear）、`40-49`（put）

**机制**：`const item = list.ok ? list.value.items.find(…) : undefined`。`list.ok === false`（反馈存储/服务报错）与「该消息确实没有反馈记录」被压成同一个 `undefined`：

- clear 路径 → 打印「该回答没有反馈记录」（**错误结论**，`fb.ts:36`）；
- up/down 路径 → 以 `ifVersion: item?.version ?? null`（`fb.ts:48`）提交，等于丢掉版本前置条件；若宿主因此拒绝，只显示 `反馈失败: ${r.error?.code ?? 'unknown'}`（`fb.ts:51`），用户无法区分「版本冲突」与「存储故障」。

`MessageFeedbackService` 的返回类型里没有 error/message 字段（`src/kernel/types.ts:382-392`），失败细节在契约层就被丢弃。
**建议**：先判 `if (!list.ok) { app.notice('读取反馈失败'); return }`；明确 `ifVersion` 缺省语义（无前置 vs 必须存在），并在 put 失败时提示可重试。

---

### F10 · bug / low · `/config` 的「用户配置 已加载」与实际生效值不一致

**位置**：`src/commands/commands/config.ts:13` vs `src/boot/boot.ts:101-102`、`README.md:139`

**机制**：boot 传给 nvim 的生效值是复合判断：

```ts
// src/boot/boot.ts:101-102
loadUserConfig: app.config.loadUserConfig !== false &&
  process.env.DSH_NVIM_TUI_LOAD_USER_CONFIG !== '0',
```

而 `/config` 只看配置字段：

```ts
// src/commands/commands/config.ts:13
… 用户配置 ${app.config.loadUserConfig !== false ? '已加载' : '关闭'} …
```

`README.md:139` 明确写「环境变量 `DSH_NVIM_TUI_LOAD_USER_CONFIG=0` 等效」（即 `-u NONE`），此时 `/config` 仍报「已加载」；headless（`isolateXdg`，`boot.ts:100`）同样实际未加载用户配置。一个以「诊断」为目的的命令给出了相反结论。
**建议**：把生效值抽成 kernel 单一函数（如 `effectiveLoadUserConfig(app)`），boot 与 `/config` 共用。

---

### F11 · risk / low · `bell.ts` / `image.ts` 绕过域操作直写 agent slice，`check-arch` 规则 3c 看不见

**位置**：`src/commands/commands/bell.ts:7,16-17`；`src/commands/commands/image.ts:12,19-21`；契约 `src/kernel/app.ts:352-355`；守卫 `scripts/check-arch.mjs:83-103,112-125`

**机制**：两个文件各自定义 `const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>`，然后

```ts
W(app.slices.agent).bellOn = arg === 'on'          // bell.ts:16
W(app.slices.agent).pendingImages = []             // image.ts:20
```

`app.ts:352-355` 的契约是「owners cast to it **inside their own files**… every other file sees readonly state and must go through the domain ops」；agent 域的 owner 是 `src/commands/index.ts`（`check-arch.mjs:95 'src/commands/index.ts': new Set(['agent'])`）。守卫漏检有两重原因：
1. 规则 3c 只遍历 `STATE_OWNERS`（`check-arch.mjs:87-103`）里的文件，`src/commands/commands/*.ts` **根本不在扫描集合**；
2. 即使被扫，正则 `` new RegExp(`app\\.slices\\.${dom}\\.${f}\\s*=(?!=)`) ``（`check-arch.mjs:117`）也匹配不到 `W(app.slices.agent).bellOn =` 这种包裹写法。

后果：`/image clear` 直接改 agent 域状态而绕过 `index.ts:189-194` 的 `clearPendings` 语义；`/bell` 无对应 op。属「架构守卫假绿」，非功能故障。
**建议**：为 agent 域补 `setBellOn`/`clearPendingImages` op 并改为调用；同时在 `check-arch.mjs` 覆盖 `src/commands/commands/**` 并把正则放宽到 `\.agent\.<field>\s*=`。

---

### F12 · risk / low · UI 类 luaCall 失败被静默吞掉，命令表现为「什么都没发生」

**位置**：`src/commands/commands/lines.ts:26`、`difficulty.ts:17`、`history.ts:10`、`help.ts:29`（同类：`src/deps/commands/deps.ts:44`）

```ts
await app.luaCall('require("dsh_tui").show_lines_float(...)', [abs, content.split('\n'), abs]).catch(() => {})  // lines.ts:26
await app.luaCall('require("dsh_tui").show_lines_float(...)', ['难度路由', difficultyStatusLines(app, rec)]).catch(() => {})  // difficulty.ts:17
void app.luaCall('require("dsh_tui").show_input_history()', []).catch(() => {})  // history.ts:10
await app.luaCall('require("dsh_tui").fill_input(...)', [`${sel} `]).catch(() => {})  // help.ts:29
```

浮窗/输入框操作失败（nvim 侧 Lua 报错、win 不可用、通道异常）时既无 notice 也无 `errorLogPath` 记录，用户视角就是「/lines /difficulty /history /help 没反应」。
对照：文件打开类有失败回执兜底 —— `nvim/lua/dsh_tui/rpc.lua:52-60` 在 `tabedit` 失败时 `rpcnotify('dsh-open-failed')`，Node 侧 `src/commands/core.ts:666-672` 转成 notice（`dir.ts:17`、`deliverables.ts:23` 因此有提示）。
**建议**：统一 `.catch((err) => app.notice(\`…失败: ${(err as Error).message}\`))`，或让 `show_lines_float`/`fill_input` 也具备失败回执。

---

## 2. 服务装配 / 降级矩阵（本次重点核对项）

| 命令 | 依赖 | 未装配时行为 | 结论 |
|---|---|---|---|
| `/compact` | `compaction` | `compact.ts:17-20` 明确提示「profile 加入 dsh-compaction」 | ✅ 合格（但见 F7 超时/取消） |
| `/goal` | `goals` | `goal.ts:16-19` 明确提示 dsh-goal | ✅ |
| `/fb` | `messageFeedback` | `fb.ts:14-18` 提示未装配 | ⚠ 见 F9（list 失败被吞） |
| `/context` | `sessionProjections`（可选） | `context.ts:18-38` 回退「按事件折叠」行 | ✅ 有降级 |
| `/image` `/attach` | `attachments` | `core.ts:60-64` / `attach.ts:32-35` 提示 | ⚠ attach 文案与「无会话」混淆（F1） |
| `/difficulty` | 无（`rec.difficulty` 恒 seed） | `difficulty.ts:11-14` 报「无活跃会话」 | ⚠ 条件不可达 + 文案错（见附录） |
| `/deliverables` `/dir` `/lines` `/history` `/help` `/bell` `/config` `/doctor` `/exit` `/effort` `/locale` | 无 | — | ✅ |

## 3. 附录 A：已排查但未列入发现（避免噪音）

1. `difficulty.ts:11` `rec.difficulty === undefined`：`SessionRec` 全仓只有**唯一**构造点 `src/sessions/services.ts:42-71`（`grep -rn "live\.set(" src/`），该点恒 seed `difficulty`（第 64 行），故该条件是**不可达防御**且复用「无活跃会话」文案；因不可达、无实际后果，不单列。
2. `usage` 字段语义混用（`config.ts:18 usage: t('配置')`、`doctor.ts:19 usage: t('终端诊断')`、`exit.ts:13 usage: t('退出')` → /help 出现「/doctor 终端诊断 · 终端诊断」）：`docs/REVIEW-2025-09.md:149` 已登记为已知次要问题，属纯文案，不重复上报。
3. `/help` 分组标题行可被 Enter 选中但无动作（`help.ts:22,28`）—— 纯 UX 小瑕。
4. `/effort` 不 trim 参数：`/effort max `（尾随空格）或 `/effort MAX` 会落进用法提示（`effort.ts:14`），而 `bell.ts:11`、`difficulty.ts:15` 都 trim 了。影响极小，未单列。
5. `/image` 参数正则 `^(\S+)(?:\s+([\s\S]*))?$`（`image.ts:29`）不支持带空格路径（`/attach` 支持），属可用性限制而非缺陷。
6. `/doctor` 的 `Unicode ✓` 为常量、truecolor 仅看 `COLORTERM === 'truecolor'`（`doctor.ts:14`）：诊断口径粗糙，但非功能缺陷。
7. `nlcmd.ts` 缺 `/dir` `/lines` `/history` 自然语言入口：`docs/REVIEW-2025-09.md:145` 已登记。
8. 全部 18 个 `installXxxCommand` 均在 `src/commands/index.ts` 被调用（`grep` 计数 18 导入 + 18 调用），本单元**未发现**无调用方的导出/恒真恒假分支类死代码；唯一确证的死分支是 `feed/images.ts:59` 的 `~/` 展开（已并入 F3）。

## 4. 附录 B：核对方式（可复核）

- 全文读取：`src/commands/commands/{attach,bell,compact,config,context,deliverables,difficulty,dir,doctor,effort,exit,fb,goal,help,history,image,lines,locale}.ts` + `src/deps/commands/deps.ts`
- 交叉验证：`src/kernel/app.ts`（notice/activeFeed/openPicker/registerCommands/refreshCommandCatalog）、`src/commands/core.ts`（openDirPicker/onCommand/通知注册）、`src/commands/index.ts`（装配）、`src/feed/images.ts`、`src/kernel/types.ts`、`src/kernel/i18n.ts`、`src/sessions/services.ts`、`src/boot/boot.ts`、`src/transcript/index.ts`
- Lua：`nvim/lua/dsh_tui/popups.lua`、`popup_core.lua`、`rpc.lua`、`init.lua`
- 脚本/文档：`scripts/check-arch.mjs`、`README.md`、`docs/REVIEW-2025-09.md`、`git log -p -- src/commands/commands/image.ts`
- 机械验证：`node -e "require('path').isAbsolute('~/a.png')"` → `false`（F3 关键前提）
