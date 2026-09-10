# 审计报告：feed-parts（`src/feed/{table,diff,images,stats,whale}.ts`）

- 单元：`feed-parts` — markdown 表格框线化（宽度/折行/对齐）、diff 解析与截断、图片读取/魔数/标签、用量·成本统计、鲸鱼像素动画帧
- 审计对象（全部用 read 全文读完）：
  - `/Users/zhangyong/workspace/deepseek/neovim-tui/src/feed/table.ts`（251 行）
  - `/Users/zhangyong/workspace/deepseek/neovim-tui/src/feed/diff.ts`（231 行）
  - `/Users/zhangyong/workspace/deepseek/neovim-tui/src/feed/images.ts`（170 行）
  - `/Users/zhangyong/workspace/deepseek/neovim-tui/src/feed/stats.ts`（93 行）
  - `/Users/zhangyong/workspace/deepseek/neovim-tui/src/feed/whale.ts`（167 行）
- 关联核对：`src/feed/feed.ts`、`src/commands/core.ts`、`src/commands/commands/{image,attach}.ts`、`src/statusline/index.ts`、`src/statusline/commands/cost.ts`、`src/transcript/index.ts`、`src/kernel/types.ts`、`nvim/lua/dsh_tui/highlight.lua`、`scripts/smoke.ts`、`REQUIREMENTS.md`、`CHANGELOG.md`
- 宿主侧核对（dsh v0.1.5-rc.1 实际安装包）：
  - `/Users/zhangyong/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`（默认模型）
  - `.../dsh-llm-deepseek/lib/index.js`（`DEFAULT_MODELS`、`TokenUsage` 语义）
  - `.../dsh-attachment-local/lib/index.js`（`saveImage`/`inspectMetadata` 的真实校验口径）
  - `.../dsh-agent-default-model/lib/index.js`（`currentSelection()` 返回原始 model id）
- 方法：
  1. 全文精读 + 全局 grep 查证调用方/引用（凡判死代码均附 grep 证据与命中清单）；
  2. **行为探针（不改任何源码）**：Node v24.18.0 直接以 type-stripping 加载 `src/**/*.ts`（`node --input-type=module -e "import ... from './src/feed/xxx.ts'"`）复现每条结论，涉及输出见各条"复现"；
  3. 交叉验证宿主包（上列）中的真实模型目录、`TokenUsage` 字段、附件校验口径，避免把"猜"当证据。

结论：**发现 12 项**（bug 5 / risk 3 / missing-feature 2 / deadcode 3），按严重度排序。

---

## F1. `splitImageDataUrls` 只剥离第一个 data URL，且把后面的正文吞进 URL / 从提示词里删掉 — bug / 高

**位置**：`src/feed/images.ts:74`（`DATA_URL_RE`）、`96-103`（`splitImageDataUrls`）；受害调用方 `src/commands/core.ts:206-215`（提交路径）、`src/commands/core.ts:416`（用户回显路径）。

**机制**：正则定义为

```ts
// 72-74
// NOTE: no /g flag — used with .exec AND .replace; a sticky regex would
// corrupt repeated parses (lastIndex leaks across calls).
const DATA_URL_RE = /data:(image\/png|image\/jpeg|image\/webp|image\/gif);base64,([A-Za-z0-9+/=\s]+)/
```

两个缺陷叠加：

1. **无 `/g`** → `text.replace(DATA_URL_RE, cb)`（`98-101`）只替换**第一个**匹配；重复的 data URL 原样留在文本里发给模型。
2. **group 2 的字符类 `[A-Za-z0-9+/=\s]+` 含字母数字与空白** → 贪心吞掉 URL 之后的所有 ASCII 词（base64 字母表就是 `A-Za-z0-9+/=`），只有遇到 `:` `,` 或中文等非 base64 字符才停。被吞掉的那段既进了 `images[]`（`whole` 整体 push，`99`），又因为 `replace` 返回空串而从用户文本里**永久删除**。

**复现（探针实测）**：

```
$ node --input-type=module -e "import {splitImageDataUrls,parseImageDataUrl} from './src/feed/images.ts'; ..."

# (a) 单图 + 英文正文：正文被吞进 payload（9 字节 PNG → 解码 20 字节，多出 11 字节）
url  = data:image/png;base64,iVBORw0KGgov          # 9 字节裸 payload，无 '=' 填充
in   = 'look ' + url + ' and more text here'
text => "look"                                      # “and more text here” 被删
decoded bytes => 20  (extra=[106,119,102,162,183,173,123,27,97,122,183])  # 英文被当成 base64 解进图片

# (b) 两张图：第二张整条丢失，残渣留在提示词里
in   = 'A ' + url + ' B ' + url + ' C'
text => "A :image/png;base64,iVBORw0KGgo= C"        # 第二张 URL 的 data 前缀被第一张吞掉
images.length => 1                                  # 只提取到 1 张
```

补充：若 payload 带 `=` 填充，Node 的 base64 解码会在 `=` 处停止，图片本身侥幸不脏（但仍会吃掉正文）；无填充时就真的把正文编码进图片字节。

**后果**：用户粘贴 1 张图并附带英文/拼音/代码说明 → 说明文字静默消失；粘贴 2 张图 → 只有第一张成功，第二张的 base64 残渣作为纯文本进入模型上下文（`core.ts:206-215` 的 `clean` 就是发给宿主的内容）。属于"静默数据丢失 + 附件丢失"。

**建议修法**：
- 正则加 `/g`（`String.replace` 配 `/g` 不会残留 `lastIndex`，原注释担心的 sticky 问题只存在于 `.exec`；若仍要复用同一个正则做 `.exec`，就为 replace 单独建一个 `new RegExp(DATA_URL_RE.source, 'g')` 或用 `matchAll` 一次性收集）；
- 收紧 payload 字符集：不允许裸 `\s`（要支持折行粘贴就先把文本按 `\s` 折叠再匹配），或要求 payload 为 `[A-Za-z0-9+/]{16,}={0,2}` 并校验长度/填充；
- **只剥离能通过 `parseImageDataUrl` 校验的候选**（sniff 结果与声明类型一致才替换），校验失败的候选保留原文 → 不会再出现"文本被删、图却没发出去"。
- `smoke.ts:2483` 的用例只覆盖"单图 + 中文正文"，建议补 `两张图` / `URL 后跟英文` 两个断言。

---

## F2. 鲸鱼动画帧引用了 6 个**未定义**的高亮组：像素用默认色渲染并在帧间闪烁 — bug / 中

**位置**：`src/feed/whale.ts:55-58`（组名生成）、`71`（预渲染基准行）、`129-131`（`whaleFrames()`）；对照定义处 `nvim/lua/dsh_tui/highlight.lua:113-121`。

**机制**：半块字形按"上像素/下像素"拼组名，nvim 侧用 `highlight default` 静态定义这些组（`highlight.lua:113-121` 共 **9** 个）：

```ts
// whale.ts:55-58
if (t === '.') { ch = '▄'; group = `DshTuiWhale-${b}` }
else if (b === '.') { ch = '▀'; group = `DshTuiWhale${t}-` }
else if (t === b) { ch = '█'; group = `DshTuiWhale${t}${b}` }
else { ch = '▀'; group = `DshTuiWhale${t}${b}` }
```

`grep -rn "Whale" nvim/` 只命中 `highlight.lua:113-121`（无任何动态生成/兜底建组），而把 4 帧全部渲染出来枚举实际用到的组，得到 **15** 个，缺 6 个：

```
used   : -B -E -W B- BB BE BP BW EB EE PP PW W- WB WW
defined: -B    B- BB    BW    EE PP    W- WB WW        →  缺 -E -W BE BP EB PW
```

**后果（逐像素定位，探针实测）**：未定义的 `hl_group` 被 nvim 直接忽略 → 该字形用默认 fg/bg 渲染（蓝鲸身上出现"透明/默认色"的洞），且因为帧间用组不同而**闪烁**：

```
frame0/frame1 : row1 "▄"@2 = DshTuiWhale-W            （共 3 处：白浪花/背脊像素）
frame2/frame3 : row1 "▄"@2  = DshTuiWhale-W
                row3 "▀"@25/@28 = DshTuiWhaleBE
                row4 "▀"@21/@24 = DshTuiWhaleBP ; @27/@30/@33 = DshTuiWhaleEB
                row5 "▀"@21/@24 = DshTuiWhalePW       （每帧 10 处）
```

即 4 帧循环里，基准帧已有 3 处缺色，两个"下沉帧"（`bobDown`，占动画一半时长）有 10 处缺色 —— 正是眼睛/腮红/白肚皮与身体的交界像素。`scripts/smoke.ts:2039` 只断言"存在以 DshTuiWhale 开头的组"，因此测试全绿。

**建议修法**：在 `highlight.lua` 补齐 6 个组（语义：`guifg`=上像素色、`guibg`=下像素色，`-` 表示对应半边 NONE，例如 `DshTuiWhaleBE guifg=#4d6bfe guibg=#14204a`、`DshTuiWhale-E guifg=NONE guibg=#14204a`）。更稳的做法是在 lua 侧用调色板表 **生成全部 4×4+2×4 组合**，并在 `smoke.ts` 增加断言：`whaleFrames()` 用到的组集合 ⊆ `highlight.lua` 定义的组集合（可直接 grep lua 文件比对）。

---

## F3. 空文件 diff：凭空多出一行 `+ ` 且 `+1 −0`；`''` 与 `null` 两条路径口径不一致 — bug / 中

**位置**：`src/feed/diff.ts:65-73`（`addOnly`）、`75-83`（`delOnly`）、`106-112`（`diffTexts` 的 null 分派）；受害调用方 `src/transcript/index.ts:260-269`。

**机制**：`''.split('\n')` 得到 `['']`（一个空行），`addOnly` 直接 `raw.slice(0, room).map(l => '+ ' + l)`，于是空文件的"新增"卡片渲染出一行只有 `+ ` 的 diff 行，统计也把这一行算作新增：

```ts
// 65-73
function addOnly(text: string, maxLines: number): DiffBlock {
  const raw = text.split('\n')            // '' → ['']
  ...
  const lines = keep.map((l) => '+ ' + l) // ['+ ']
  ...
  return { lines, stats: { added: raw.length, removed: 0 }, truncated }  // added: 1
}
```

`transcript/index.ts:261` 只在 `added === 0 && removed === 0` 时丢弃整块，因此这一块会真的画到聊天区（`✎ 新增 <path> (+1 −0)` + 一行空 `+ `）。

**复现（探针实测）**：

```
diffTexts(null, '')  => lines ["+ "],  stats {added:1, removed:0}, truncated=false
diffTexts('', null)  => lines ["- "],  stats {added:0, removed:1}
diffTexts('', 'x')   => lines ["- ", "+ x"], stats {added:1, removed:1}   ← 走 LCS 路径，凭空多一条 "−1"
```

第三条暴露的是**同一根因的第二症状**：`before = ''`（文件存在但为空）与 `before = null`（文件不存在）在语义上应等价（创建文件），但前者走 LCS、报 `−1 +1`，后者走 `addOnly`、报 `+1 −0`，同一操作两个口径。`wholeReplace`/`LCS` 分支也会把 `''` 当成一行参与匹配。

**建议修法**：在 `diffTexts` 入口统一零行模型——`const split = (s: string) => (s === '' ? [] : s.split('\n'))`，并让 `addOnly/delOnly/整段 LCS` 都用它；若 `before === ''` 与 `after === ''` 同为空则提前返回空块。顺带 `''` 与 `null` 的空判断（`110-112`）可归一到 `(before ?? '').trim() === ''` 一层。

---

## F4. `estimateCost` 的定价表不含 dsh 默认模型 `deepseek-flash` 与识图模型 → 状态栏/`/cost` 静默不显示成本 — missing-feature / 中

**位置**：`src/feed/stats.ts:13-16`（`MODEL_PRICES`）、`44-53`（`estimateCost`）；消费方 `src/statusline/index.ts:286-289`、`src/statusline/commands/cost.ts:16-19`。

**机制**：

```ts
// stats.ts:13-16 —— 只有两个 key
const MODEL_PRICES: Record<string, ...> = {
  'deepseek-v4-flash': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-v4-pro':   { input: 0.55, output: 2.19, cacheRead: 0.14 },
}
// 45-46
const price = modelName === undefined ? undefined : MODEL_PRICES[modelName]
if (price === undefined) return undefined
```

而宿主 dsh v0.1.5-rc.1 实际下发的 model id 有 4 个（`.../dsh-llm-deepseek/lib/index.js:1841-1871` 的 `DEFAULT_MODELS`）：`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`。其中 **`deepseek-flash` 就是 dsh-base 的出厂默认**（`.../dsh-base/cordis.patch.yml:75-79`：`id: agent-default-model` → `provider: deepseek-official` / `model: deepseek-flash`），而 `agentDefaultModel.currentSelection()` 原样返回配置里的 id（`.../dsh-agent-default-model/lib/index.js:26-32,57-59`），插件把它写进 `rec.model`（`src/sessions/services.ts:44`）。于是：**未覆盖 settings.yaml 的出厂配置下，`estimateCost` 恒返回 undefined，状态栏 `$x.xx` 段与 `/cost` 的"预估 $"整段消失**（两者都是 `cost !== undefined` 才输出）。

同一缺口还命中插件**自己的识图流程**：`src/commands/core.ts:76-89` 在发图时把会话临时切到 `deepseek-flash` / `deepseek-v4-flash-vision-exp`，这两个 id 都不在表里；即使切回，成本也是用**当前模型价**乘**会话累计 token**（`statusline/index.ts:287` 传 `rec.model` + `rec.usage`），而难度路由（`core.ts:52-54`）与识图切换都会在会话中途换模型 → 多模型会话的 `$` 精确度没有任何保证。

**证据边界（诚实说明）**：本机 `~/.dsh/settings.yaml:1-4` 已把默认模型覆盖为 `deepseek-v4-flash`（表内命中），所以当前环境**看起来**正常；但出厂配置（以及任何走识图模型的回合）必然缺省。`REQUIREMENTS.md:268` 只承诺"未知模型诚实降级不显示"，因此这属于"定价表覆盖面没跟上宿主目录"的缺口，而非实现违背需求。

**建议修法**：把 4 个 catalog id（含 `deepseek-v4-pro-0813` / `deepseek-v4-flash-0731` 这类日期别名，宿主目录里存在）补进表；更彻底的是按 `assistant/message` 事件的 `usage` 逐条记录 (model, usage) 再求和，而不是用会话累计 × 当前模型价。

---

## F5. 声明类型与字节 sniff 不一致的 data URL 被静默丢弃：URL 文本已从提示词删掉，图没发出去，零提示 — bug / 中

**位置**：`src/feed/images.ts:90-92`（`parseImageDataUrl` 的严格相等校验）；受害调用方 `src/commands/core.ts:206-214`。

**机制**：

```ts
// images.ts:90-92
const mediaType = sniffMediaType(decoded)
if (mediaType === null || mediaType !== m[1]) return null   // ← 声明 != 实际 → null
```

```ts
// core.ts:206-214 —— URL 文本已在这一步被剥离，null 只是被 continue 跳过
const { text: clean, images } = splitImageDataUrls(text)
const parsed: Array<SaveImageAttachment> = []
for (const url of images) { const p = parseImageDataUrl(url); if (p !== null) parsed.push(p) }
```

`data:image/jpeg;base64,<PNG 字节>`（网页复制图片时很常见的错标）或任何声明/字节不一致的粘贴，结果都是：**提示词里那段 URL 消失、图片没进附件、没有任何 notice**。对比之下，若把字节交给宿主，宿主会给出可见错误：`dsh-attachment-local/lib/index.js:292-300` 的 `inspectMetadata` 会抛 `IMAGE_TYPE_MISMATCH`，`src/commands/core.ts:124` 会 `app.notice('图片附加失败: ...')`（`/attach` 同理见 `src/commands/commands/attach.ts:42`）。也就是说客户端这层"严格校验"把一条本可诊断的失败改成了静默失败，而且是与宿主重复的实现（宿主用 `detectImage` 自行判定类型）。

**复现**：`parseImageDataUrl('data:image/jpeg;base64,' + <png base64>)` → `null`；沿 `core.ts:206-215` 走一遍即得到"文本被删 + 无图 + 无提示"。

**建议修法**：`parseImageDataUrl` 不因声明类型不符而返回 null，而是**以 sniff 出的类型为准**返回 `{ data, mediaType: sniffed }`（宿主本来就会再判一次）；若要保持严格，则把失败原因回传给调用方，由 `core.ts` 的循环对 `null` 项 `app.notice('图片无法识别（data URL 声明 %s 与字节不符）')`，避免静默丢内容。

---

## F6. `maxWidth` 契约被调用方破坏：用户回显多加 `> ` 前缀、首次 flush 用过期的 100 列、列数过多时仍溢出 — risk / 中

**位置**：`src/feed/table.ts:215-216`（`maxWidth` 文档："total display-width cap"）、`100-115`（`MIN_COL = 3` 地板 + 收缩循环）、`21-24`（模块头部承诺"EVERY physical line carries the `│` borders … the frame never breaks"）；调用方 `src/feed/feed.ts:334-336`、`268`、`1086-1090`、`1275`。

**机制（三条同源证据）**：

1. **用户回显**：`feed.ts:334-336` 用整窗宽度渲染，然后**每一行加 2 列 `> ` 前缀**：

```ts
for (const entry of transformTables(text.split('\n'), false, 0, this.lastWinW)) {
  this.base.push(`> ${entry.table ? entry.text : entry.raw}`)   // ← 渲染后 +2 列
}
```

自然宽度贴近窗宽的表格（`renderTable` 判定"没超"因而不收缩）加前缀后超过窗口 → nvim 软折行 → 右框线被折到下一屏行，正是该特性要消灭的"框线弯折"。

2. **首屏宽度是过期值**：`lastWinW` 初值 100（`feed.ts:268`），刷新靠 `flush()` 里 **fire-and-forget + 2s 节流**的探针（`feed.ts:1086-1090`：`void this.winSize()`），而同一轮 `flush()` 的解析循环（`1275`）紧接着就用它渲染表格。窄窗口（<100 列）下，启动后第一轮及其后 2s 内的 flush 全部按 100 列封顶 → 表格超宽并被软折行；若这轮之后没有新事件触发 flush（例如历史回放后静止），弯折的表格会一直留在屏幕上。

3. **列数地板**：`contentBudget`/`widths` 的下限是 `MIN_COL = 3`，当 `cols * 3 + 1 > maxWidth` 时收缩循环 `break`，注释自陈"minimal overflow wins"（`112`）。实测：5 列表格 `maxWidth=12..24` 一律渲染 30 列；2 列表格 `maxWidth=10/12` 渲染 13 列；5 列 `maxWidth=20` 渲染 21 列。窄浮窗（思考面板宽度被 clamp 到 30..52，`feed.ts:1560-1572`）里的宽表格因此照旧弯折。

**建议修法**：`feed.ts:334` 传 `this.lastWinW - 2`（或在 `transformTables` 增加 `prefixWidth` 参数并在渲染色宽预算内扣除）；表格渲染前确保 `lastWinW` 已就绪（首轮 `await this.winSize()`，或探针返回后置 `dirty` 重渲一次）；当 `cols*3+1 > maxWidth` 时**直接放弃框线化**（退回原始 markdown，交给 nvim 折行）比画一个注定断裂的框更符合模块自述的目标。

---

## F7. 剪贴板读图：`osascript`/`sips` 无超时（同步阻塞事件循环），`.png` 临时文件在异常路径泄漏 — risk / 中

**位置**：`src/feed/images.ts:127-144`（`execFileSync('osascript', …)`）、`152-168`（TIFF→PNG 与临时文件清理）。

**机制**：两处 `execFileSync` 都是**同步**调用且未传 `timeout`/`signal`：

```ts
// 127-144
label = execFileSync('osascript', ['-e', `...`], { maxBuffer: 1024 * 1024 }).toString().trim()
...
// 156
execFileSync('sips', ['-s', 'format', 'png', outPath, '--out', pngPath], { stdio: 'ignore' })
```

- 剪贴板被别的 App 持有 / AppleScript 弹权限对话框 / `sips` 卡在慢速卷时，**整个 Node runner 的事件循环被同步阻塞**：nvim RPC、流式渲染、状态栏刷新全部停摆（用户只看到界面卡死，没有超时、没有诊断）。
- 临时文件清理不完整：`${base}.png`（`155`）只在 `157` 读成功后于 `158` 删除；若 `readFileSync(pngPath)` 抛错（sips 写了空/半截文件）或 `sniffMediaType` 之后走 `164` 的 catch，`pngPath` 不会被删——`finally`（`166-168`）只 `unlinkSync(outPath)`。反复失败会在 `tmpdir()` 里堆积残留文件。

**建议修法**：`execFileSync(..., { timeout: 5000, killSignal: 'SIGKILL' })`（osascript 那条同时把超时错误转成用户可见 notice，如"剪贴板读图超时"）；把 `outPath`/`pngPath` 一起纳入 `finally` 清理；`/image`、`<C-v>` 是交互命令，同步阻塞可接受但必须有上限。

---

## F8. `wrapText` 每个单元格都构造一个 `Intl.Segmenter`，落在流式热路径上 — risk / 低-中

**位置**：`src/feed/table.ts:120-139`，尤其 `127`：

```ts
for (const { segment: ch } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text ?? '')) {
```

`wrapText` 被 `row()` 对**每个单元格**调用（`169`），即每次渲染 行数×列数 个 Segmenter 实例；`Segmenter` 是无状态、可复用的，构造却相当贵。实测（Node v24.18.0）：单个构造 ≈ **4.0µs**，31 行×6 列表格 `renderTable` ≈ **2.44ms/次**（186 个单元格 ≈ 0.75ms 纯构造开销），`transformTables`(430 行) ≈ 2.45ms/次。而 `feed.ts` 每收到一个流式 chunk 就重渲整视图（`1275`），鲸鱼 ticker 每 450ms 也整屏重渲（`feed.ts:1031/1336`）——表格越大，这条固定开销越显眼。

**建议修法**：模块级 `const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })` 复用（线程内无状态），或把 `Segmenter` 按需延迟创建一次。属性能优化，不改变语义。

---

## F9. 只认"两侧都有竖线"的 GFM 子集，且 `\|` 转义在单元格里不还原 — missing-feature / 低

**位置**：`src/feed/table.ts:4-5`（文档宣称 "Detects GFM table blocks"）、`35-36`（`isTableRow`/`isSeparator`）、`50-55`（`splitCells`，`53` 注释自陈转义处理）。

**机制**：`isTableRow = /^\s*\|.*\|\s*$/` 要求首尾都有 `|`，`splitCells`（`52`）同样 `if (!t.startsWith('|') || !t.endsWith('|')) return null`；而 GFM 规范里外层竖线是**可选**的。模型很常输出无外框风格，这类表格完全不会被框线化（分隔行 `--- | ---` 原样显示）。另外 `splitCells` 用 `(?<!\\)\|` 正确避免了把 `\|` 当分隔符，但**从不把 `\|` 还原成 `|`**，单元格里会显示多余反斜杠。

**复现（探针实测）**：

```
transformTables(['日期 | AQI | 等级','--- | --- | ---','今天 | 29 | 🟢'], false, 0, 40)
  => 三条全部 {table:false}（原样输出，未框线化）

renderTable(['| a\|b | c |','|---|---|','| 1 | 2 |'], true, Infinity)
  => │ a\|b │ c │        ← 单元格里保留了字面反斜杠；期望 │ a|b │ c │
```

**建议修法**：`splitCells` 改为"存在外层竖线则剥掉，否则按未转义竖线切分"，并对分隔行做同样的宽容解析（`isSeparator` 相应放宽为"仅由 `:?-{2,}:?` 与竖线组成的行"）；`stripCellMarkup` 里补 `.replace(/\\\|/g, '|')` 还原转义。若有意只支持带外框风格，则应把 `4-5` 的 "GFM" 表述改成"带外框的表格子集"，避免文档与实现的口径差。

---

## F10. deadcode：`layoutWhaleRows` 无生产调用方（含 `WHALE_ROWS` 的导出）— deadcode / 低

**位置**：`src/feed/whale.ts:154-167`（`layoutWhaleRows`）、`20`（`WHALE_ROWS` 导出）。

**grep 证据（全局，含 scripts、nvim、docs）**：

```
$ grep -rn "layoutWhaleRows" -r src nvim scripts
src/feed/whale.ts:159:export function layoutWhaleRows(...)          ← 定义
scripts/smoke.ts:16:import { ..., layoutWhaleRows, WHALE_ROWS } ...  ← 仅测试脚本
scripts/smoke.ts:2023-2026:  assert ... layoutWhaleRows(30, 100) ...  ← 仅测试脚本
```

生产代码里唯一需要"居中 + 垂直留白"的地方是 `feed.ts:1332-1345` 的空状态 hero 块，它自己算 `topPad`（`1341`）并只用 `whaleRowsIndented`（`1336`）。也就是说：**同一份"垂直居中"逻辑存在两份实现**，`layoutWhaleRows` 那份（含 `width < 40 || height < WHALE_ROWS + 2` 下限与 `topPad` 算法）只被 smoke 覆盖，任何窗口尺寸变化都不会走到它。

**建议修法**：删除 `layoutWhaleRows`（连同 `WHALE_ROWS` 的 `export`，改为模块内常量），或反过来让 `feed.ts` 调用它，消除重复实现。删除需同步删 `smoke.ts:2023-2026` 两个断言。

---

## F11. deadcode：`readImageFile` 的 `_knownMediaType` 参数从未被读取，两个调用方也都只传 1 个实参 — deadcode / 低

**位置**：`src/feed/images.ts:58-70`（签名 `readImageFile(path: string, _knownMediaType?: string | null)`，文档 `54-55` 称"extension only as a fallback for pathless buffers"）。

**grep 证据**：

```
$ grep -rn "readImageFile" -r src nvim scripts | grep -v "src/feed/images.ts"
src/commands/commands/image.ts:5,38   import ...; image = readImageFile(abs)
src/commands/commands/attach.ts:5,28  import ...; img = await readImageFile(abs)
```

函数体内只出现 `path`（`59-69`），`_knownMediaType` 一次都没参与判断；`pathless buffers` 这条流程也不存在（两个调用方都在跑真实路径）。副作用是扩展名兜底会**把错标的 `.png`（其实是文本等）当成 `image/png` 返回**（`62-65`），最终由宿主的 `IMAGE_TYPE_MISMATCH` 报错收场（`attach.ts:41-43` 显示"附件失败"）。

**建议修法**：直接删掉该参数（`attach.ts:28`/`image.ts:38` 无需改动）；若要保留"调用方已知类型优先"的设计，则应在 sniff 失败时优先使用它而不是扩展名，并补上真正的 pathless 调用方。

---

## F12. deadcode：`parseImageDataUrl` 里 `Buffer.from(base64)` 的 `try/catch` 不可达 — deadcode / 低

**位置**：`src/feed/images.ts:83-89`。

**机制**：Node 的 base64 解码是宽容的——非法字符被跳过、`=` 视作结束，**任何字符串都不会抛异常**，所以 `catch { return null }`（`86-88`）是死分支；真正拦住坏数据的是下一行的长度判断。实测：

```
$ node -e "console.log(Buffer.from('!!!not base64!!!','base64').length)"   # => 6（不抛）
```

**建议修法**：删掉 `try/catch`，保留 `if (decoded.length === 0) return null`，并补一句注释说明宽松解码语义（免得后人以为这里在挡异常）。

---

## 复核过但判定"不是问题"的点（避免后续重复排查）

1. **表格对齐/折行本身没有算术错误**：用 5 组构造数据（CJK/emoji ZWJ 家族旗、超长无空格串、参差行、5 列 6 列）× 9 档 `maxWidth` 跑 `renderTable`，**没有任何一行宽度不一致**（所有物理行显示宽度相同），也没有触发 `' '.repeat(负数)` 抛错；换行按 grapheme 切分（ZWJ 家族 emoji 不被拆碎）符合注释承诺。超出 `maxWidth` 的情形只出现在"列数地板"场景（见 F6-3），且代码注释自陈是有意为之。
2. **`transformTables` 的"流式无底边框"判定**：`closed = j < lines.length - trailingStatic || !streamOpen`（`239`）与 `feed.ts:1277` 内联版本一致；`trailingStatic` 在生产调用方（`feed.ts:334`、`1572`）都传 0，但真正需要它的内联路径（`feed.ts:1215/1277` 传 `activityLines.length`）用的是自己的循环，故不构成缺陷。
3. **`foldUsage` 的字段名与宿主一致**：宿主 dsh 0.1.5-rc.1 自带的 `.../dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:131-148` 里 `TokenUsage` 正是 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`（注释明确 DISJOINT，"billed input = sum of the three"），仓库内 `node_modules/@deepseek-ai/dsh-llm`（0.1.2-rc.1）同名文件同样如此；`stats.ts:21-33` 的折叠与 `billedInput` 口径正确。
4. **`spinnerStep` 索引不会越界**：`boot.ts:47` 的 `(i + 1) % mod`，调用处传 `WHALE_EMOJI_FRAMES.length`（`statusline/index.ts:77`），索引恒 ∈ {0,1}（`WHALE_EMOJI_FRAMES` 长度 2）。
5. **`whaleFrames()` 每次调用重建 4 帧**：实测单次 ≈ 56µs（450ms ticker 调用一次），量级可忽略，不作为问题报出。
6. **`diffTexts` 的 LCS/上下文合并/截断上限**：`maxLines` 上限、`· 其余 N 行省略 ·` 计数、前缀后缀裁剪的重叠保护（`123-124` 的 `s < a.length - p`）在探针里都表现正确（含 `maxLines=5/6` 的截断路径、仅尾部换行差异、追加无末行换行等用例），未发现重复渲染同一源行或超出行数上限。
7. **`estimateCost` 数值本身正确**：`smoke.ts:2493` 对 `deepseek-v4-pro` 的 0.32 手算复核一致（500k×0.55 + 100k×0.14 + 12.6k×2.19 = 316,594/1e6 → 0.32）；问题只在覆盖面（F4）。
8. **`REQUIREMENTS.md:283-285`（R-VIZ-8）与实现的口径差**：文档仍写"表头加粗、边框暗色"，实现是全表统一 `DshTuiBold`（`table.ts:154-163`、`172-180`）——但 `CHANGELOG.md:1312` 明确记录了这是有意变更（"Markdown 表格整表统一加粗（消除 │/─/转角字体渲染粗细不一）"），属于需求文档未同步，不按代码缺陷计。
9. **`DiffBlock.truncated` 无外部读取**：grep 全仓仅 `diff.ts` 内部赋值（`72/82/102/230`），无消费方；因属"结构体字段未被读取"而非"无调用方的导出/函数"，未计入 deadcode（可顺手清理）。
10. **`stats.ts:69` 的 `formatElapsed` 在 `ms` 非法时会输出 `'NaNms'`**（`68` 行只对 `total` 用了 `safeNum`，`69` 行用原始 `ms`）：现有全部调用方（`statusline/index.ts:285`、`feed.ts:776/897/941`、`commands/workflow.ts:16/19`）传入的都是 `number` 或经 `typeof === 'number'` 守卫，取不到确凿可达路径，故仅记为潜在瑕疵，未进正式条目。修法：`69` 行改用 `safeNum(ms)`。

---

## 附：探针复现方式（不改源码）

仓库 `engines: node >= 23.6`，Node v24.18.0 默认开启 type stripping，可直接跑 TS 源：

```bash
cd /Users/zhangyong/workspace/deepseek/neovim-tui

# F1 / F5 / F12：图片 data URL 解析
node --input-type=module -e "
import { splitImageDataUrls, parseImageDataUrl } from './src/feed/images.ts'
const png = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x2f]).toString('base64')
console.log(splitImageDataUrls('look ' + png + ' and more text here'))
console.log(splitImageDataUrls('A ' + png + ' B ' + png + ' C'))
"

# F2：枚举鲸鱼帧实际使用的高亮组，和 highlight.lua 比对
node --input-type=module -e "
import { whaleFrames, WHALE_RENDER_ROWS } from './src/feed/whale.ts'
const used = new Set(); const c = rs => rs.forEach(r => r.spans.forEach(s => used.add(s.group)))
c(WHALE_RENDER_ROWS); whaleFrames().forEach(c); console.log([...used].sort().join(' '))
"
grep -o "DshTuiWhale[A-Z-]*" nvim/lua/dsh_tui/highlight.lua | sort -u

# F3：diff 空文件 / '' 与 null 口径
node --input-type=module -e "
import { diffTexts } from './src/feed/diff.ts'
for (const [a,b] of [[null,''],[ '',null],['','x']]) console.log(a,b,diffTexts(a,b))
"

# F6 / F9：表格宽度地板、转义竖线、无外框 GFM
node --input-type=module -e "
import { renderTable, transformTables } from './src/feed/table.ts'
const t = ['| 日期 | 城市 | AQI | 等级 | r |','|---:|---|---:|---:|---|','| 今天 | 北京 | 29 | 🟢 优 | 1 |']
for (const w of [24,20,16,12,10]) console.log(w, renderTable(t,true,w)[0].text.length)
console.log(renderTable(['| a\\\\|b | c |','|---|---|','| 1 | 2 |'],true,Infinity)[1].text)
console.log(transformTables(['日期 | AQI','--- | ---','今天 | 29'],false,0,40).map(e=>e.table))
"

# F8：Segmenter 构造与整表渲染耗时
node --input-type=module -e "
const t0=process.hrtime.bigint(); for(let i=0;i<20000;i++) new Intl.Segmenter(undefined,{granularity:'grapheme'}); const t1=process.hrtime.bigint()
console.log('new Segmenter avg us =', Number(t1-t0)/1000/20000)
"
```
