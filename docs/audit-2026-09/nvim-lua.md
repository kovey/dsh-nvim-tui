# 审计报告：nvim-lua（dsh-nvim-tui v0.3.5，适配 dsh 0.1.5-rc.1）

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（HEAD `a14c7a7`，工作区干净）
- 审计单元：`nvim-lua`（Neovim Lua 侧插件）
- 必读文件（已用 `read` **完整通读**，共 5332 行）：

| 文件 | 行数 | 文件 | 行数 |
| --- | --- | --- | --- |
| `nvim/lua/dsh_tui/init.lua` | 396 | `nvim/lua/dsh_tui/popups.lua` | 780 |
| `nvim/lua/dsh_tui/api.lua` | 1097 | `nvim/lua/dsh_tui/popup_core.lua` | 550 |
| `nvim/lua/dsh_tui/autocmds.lua` | 415 | `nvim/lua/dsh_tui/subagent_chat.lua` | 334 |
| `nvim/lua/dsh_tui/cmd_menu.lua` | 273 | `nvim/lua/dsh_tui/highlight.lua` | 259 |
| `nvim/lua/dsh_tui/at_menu.lua` | 195 | `nvim/lua/dsh_tui/session.lua` | 179 |
| `nvim/lua/dsh_tui/input.lua` | 171 | `nvim/lua/dsh_tui/layout.lua` | 156 |
| `nvim/lua/dsh_tui/state.lua` | 126 | `nvim/lua/dsh_tui/full_input.lua` | 117 |
| `nvim/lua/dsh_tui/keymaps.lua` | 96 | `nvim/lua/dsh_tui/rpc.lua` | 87 |
| `nvim/lua/dsh_tui/buffer.lua` | 64 | `nvim/lua/dsh_tui/statusline.lua` | 37 |

- 调用方/引用交叉核验（grep + read）：`src/**`（runner）、`lib/**`（编译产物）、`scripts/smoke.ts`、`examples/nvim/git-panel.lua`、`README.md`、`REQUIREMENTS.md`、`docs/EXT-API.md`、`docs/REVIEW-2025-09.md`、`CHANGELOG.md`
- 宿主/运行时契约核对（本机 nvim 0.12.5）：`/opt/homebrew/share/nvim/runtime/doc/api.txt:2371`（`on_lines` 返回 lua-truthy 才 detach）、`/opt/homebrew/share/nvim/runtime/lua/vim/_core/editor.lua:269-276`（`vim.schedule_wrap` 丢弃返回值）、`docs` 中 `nvim_get_hl`/`title`/`footer`/`virt_text_pos='inline'` 的版本要求（对照 `README.md:106` 的最低版本承诺 **0.9**）
- 实测验证（只读，未改任何文件）：`nvim --headless -u NONE` 复现 `hi default link` 被前置定义吞掉（见 §8）；纯 Lua 复算 `at_menu.accept()` 的字节切片数学（见 §3）
- 未修改任何源码文件；本报告（`.dsh/audit/nvim-lua.md`）为唯一新增文件

结论：**2 条高危**（同族浮窗孤儿化 + `q` 关错窗口；picker 顶掉审批/提问浮窗导致 runner 回合永久挂起）、**5 条中危**（@ 提及接受后残留片段拼接、bottom 停靠槽遮挡输入框、`on_lines` detach 意图失效、`buildingLayout` 无异常复位、会话列表浮窗整族死代码）、**5 条低危**（`DshTuiQuote` link 恒失效、`<0.9` 死分支、`S.subagentView` 模块加载期重置、无会话时 `<C-o>` 泄漏缓冲、`API.panel_reflow` 零调用方）。

> 去重说明：并行单元的既有报告（`commands-a/b/core`、`feed-core/parts`、`kernel-core/features`）均为 TS 侧单元，本单元条目与其无重叠。

---

## 1. [bug / high] `show_skill` / `show_lines_float` 不关闭同族旧浮窗：孤儿窗口 + `q`/`Esc` 关错窗口（旧窗可能关不掉）

**位置**
- `nvim/lua/dsh_tui/popups.lua:18-57`（`P.show_skill`，第 56 行才写 `S.skillWin = win`）
- `nvim/lua/dsh_tui/popups.lua:387-442`（`P.show_lines_float`，第 438 行才写 `S.linesWin = win`）
- 关闭侧：`nvim/lua/dsh_tui/popups.lua:60-67`（`close_skill`）、`444-450`（`close_lines_float`）——**只操作 `S.skillWin` / `S.linesWin` 这一个字段**

**机制（确定因果链）**

同文件里其他"单例浮窗"在打开前都会先收掉自己：`show_dir_picker` → `P.close_dir_picker()`（287）、`show_progress` → `P.close_progress()`（459）、`show_session_list` → `P.close_session_list()`（547）、`show_input_history` → `P.close_input_history()`（677）、`open_subagent_view` → 先关旧 view + subagent chat（84-90）、`popup_core.open_float` → `P.close_float(true)`（187）。**只有 `show_skill` 和 `show_lines_float` 没有这一步**：

```lua
-- popups.lua:387-442（无任何 close_* 前置调用）
function P.show_lines_float(title, lines, editPath)
  ...
  local win = vim.api.nvim_open_win(buf, true, cfg)   -- 新窗口，旧窗口继续存在
  ...
  S.linesWin = win                                     -- 旧句柄被直接覆盖
  attach_footer(win, hint)
  return { buf = buf, win = win }
end
```

于是连续两次调用（runner 侧有 7 个生产调用点，全是"用户再点一次命令"即可触发）就得到两个同时存在的浮窗：

- `src/commands/commands/lines.ts:26`、`src/commands/commands/settings.ts:98`、`src/commands/commands/plugins.ts:27`、`src/commands/commands/workflow.ts:28`、`src/commands/commands/difficulty.ts:17`、`src/transcript/commands/trajectory.ts:42`、`src/deps/commands/deps.ts:44`（`show_lines_float`）
- `src/commands/commands/skills.ts:27`（`show_skill`）

后果有两层，都由"关闭侧只认最新句柄"导出：

1. **孤儿窗口/缓冲区泄漏**：旧浮窗（`bufhidden='wipe'` 的 buffer + 窗口）不再被任何字段引用，`M.start()`/`unregister` 之外的代码永远不会关它；`attach_footer` 只把 footer 挂到新窗口，旧窗口连提示条都没有。
2. **旧窗的 `[q]/[Esc] 关闭` 是坏的**：旧窗 buffer 上的键位是全局函数（`popups.lua:420-421`、`50-51`），`close_lines_float()` 关的是 `S.linesWin` = **新窗口**。用户在新窗按 `q` → 新窗关闭、`S.linesWin = nil`；此后在旧窗按 `q`/`<Esc>` → `S.linesWin` 为 nil ⇒ 纯 no-op。旧窗此时只剩 `<C-w>c` 一条出路（`:q`/`:` 已被 `lock_popup_buffer` 的 EDIT_KEYS 里 `':'` 项 Nop 掉，见 `popup_core.lua:9-13/33-39` + `popups.lua:422`），即在"无分屏、无 tabline"的 TUI 里留下一个挡着聊天区的死窗口。

**复现路径**
1. `/workflow`（打开 `show_lines_float`）→ 再用 `/trajectory`（第二个 `show_lines_float`）：两个浮窗同时可见。
2. 在**上层（新）**浮窗按 `q` → 新窗关闭。
3. 在下层（旧）浮窗按 `q` / `<Esc>` → 无任何反应（提示条还写着 `[q]/[Esc] 关闭`）。
4. 同理 `/skills foo` 连按两次 → 两个"技能详情"浮窗，旧的那个永久残留。
5. smoke 覆盖不到：仓库里 `close_lines_float` / `close_skill` 的调用方只有 `scripts/smoke.ts:1969`、`1978`、`1114`（每次都先关再开），runner 侧（`src/`、`lib/`）**零调用**。

**建议修法**：在两个函数体首行分别加 `P.close_lines_float()` / `P.close_skill()`（与 `show_progress` 等保持同一约定）；更稳的做法是把"单例浮窗"的句柄统一收进 `S.float` 家族或加一个 `close_lines_float()` 幂等前置断言，避免以后新增浮窗再漏。

---

## 2. [bug / high] `P.show_picker` 用 `close_float()`（缺 `notify_replaced`）：被顶掉的审批/提问浮窗永不结算，回合挂死

**位置**
- `nvim/lua/dsh_tui/popup_core.lua:423-424`（`P.show_picker` 的关闭调用，**无参**）
- 对照与契约：`nvim/lua/dsh_tui/popup_core.lua:142-164`（`close_float(notify_replaced)` 的结算分支）、`186-187`（`open_float` 传 `true`）

**机制（确定因果链）**

```lua
-- popup_core.lua:142-154
function P.close_float(notify_replaced)
  -- A float being REPLACED (open_float over an existing one) settles the
  -- runner's pending promise with a cancel — otherwise the displaced
  -- approval/questions/picker would hang its turn forever.
  if notify_replaced and S.float.kind and S.channel then
    if S.float.kind == 'approval' then
      vim.rpcnotify(S.channel, 'dsh-approval-decided', 'n')
    elseif S.float.kind == 'questions' then
      vim.rpcnotify(S.channel, 'dsh-questions-cancelled')
    elseif S.float.kind == 'picker' then
      vim.rpcnotify(S.channel, 'dsh-picker-cancelled')
    end
  end
  ...
```

`open_float` 走的是 `P.close_float(true)`（187，即 `show_approval`/`show_questions` 顶掉旧浮窗时会结算），但 **`show_picker` 走的是 `P.close_float()`（424）**：

```lua
-- popup_core.lua:423-424
function P.show_picker(title, items)
  P.close_float()          -- ← 无 notify_replaced：kind/state 被清空，但 runner 端没人结算
  ...
  S.float.kind = 'picker'  -- 新浮窗就位
```

runner 侧的结算只发生在收到通知时（`src/commands/index.ts:97-113`：`A.settleApproval`/`advanceApproval` 只由 `dsh-approval-decided`、`A.abortApproval`、`drainApprovals` 推动；`src/commands/index.ts` 全文无 `setTimeout` 看门狗，`showApprovalFloat` 的 `.catch` 只在 **luaCall 本身失败**时结算）。因此：审批浮窗被 picker 顶掉 ⇒ `dsh-approval-decided` 永不发出 ⇒ 该工具的 approval promise 永久 pending、`advanceApproval()` 也不再推进队列 ⇒ **整回合永久挂起**，用户既看不到审批 UI（窗口已被 picker 关闭并 `S.float.kind` 覆盖）也无法再回答。

触发路径（同一回合内并发工具调用 / 子代理 + 命令驱动）：
- 工具 A 触发审批 → `show_approval`（`src/commands/index.ts:78`）浮窗挂起等待；
- 同一批次里的工具 B（runner 的 `tui_command` / `slices.ext` 的 `picker()`，见 `src/kernel/app.ts:548-566`、`src/ext-api/index.ts:330-333`）调用 `openPicker` ⇒ `show_picker`；
- picker 落地瞬间按 424 行把 approval 浮窗静默关掉，且不发 `dsh-approval-decided`。

同类第二例：`questions` 挂起时被 picker 顶掉 ⇒ `dsh-questions-cancelled` 不发出，`questionsResolve` 同样永久 pending。

**复现路径**
1. 造一个需要审批的工具调用（让 approval 浮窗出现，**不要**回答）。
2. 让 runner 打开任意 picker（`tui_command`/扩展 `picker()`，或 `/sessions`、`/skills` 这类命令路径）。
3. 观察：approval 浮窗消失，picker 正常；`/steer`、`<C-c>`（abort）之外无任何途径让回合继续；日志里既无 `dsh-approval-decided` 也无 rejected 记录。
4. Lua 侧最小复现（不需要 runner）：`show_approval{...}` → `show_picker('t',{})`，然后在 `S.channel` 上抓通知，只能看到 `dsh-picker-*`，没有 `dsh-approval-decided`。

**建议修法**：`popup_core.lua:424` 改为 `P.close_float(true)`（一行）。语义上也建议让 `close_float` 默认 `notify_replaced = true`，把"显式不需要结算"的两个内部调用点（`approval_decide`/`questions_*`/`picker_*` 这些**自己随后就发通知**的路径）显式传 `false`，使漏传不再是"静默挂死"这一类故障模式。

---

## 3. [bug / medium] `at_menu.accept()` 的裁剪点钳到 `@` 起点而非 token 终点：光标落在 token 内/左侧时残留片段被拼回输入行

**位置**：`nvim/lua/dsh_tui/at_menu.lua:140-160`（关键第 151-158 行）

**机制（确定因果链）**

```lua
-- at_menu.lua:151-158
  -- Cursor may have drifted LEFT of the token (menus stay open on cursor
  -- moves): splice from at least the token's end, never behind `start`,
  -- or the mention concatenates with the leftover @fragment.
  local col = math.max(math.min(cur[2], #line), start)
  local newline = line:sub(1, start) .. mention .. line:sub(col + 1)
```

注释声称"至少从 token 终点切片"，但代码钳的下界是 `start`（`@` 的**起点** 0-based 偏移），不是 token 终点（`start + 1 + #query`）。`line:sub(1, start)` 已经吃掉了 `@`，而 `line:sub(col + 1)` 保留 `col` 之后的字符——只要 `col < start + 1 + #query`，未被吃掉的 query 尾巴就会**接在 mention 后面**，正是注释想避免的"leftover @fragment"。

用 nvim 自带 Lua 复算（`line = 'hi @sr'`，`start = 3`，`mention = '@src/a.txt'`，复算脚本与 `accept()` 同式）：

| 光标插入位 col（0-based） | 结果 |
| --- | --- |
| 6（行尾，smoke 覆盖的用例） | `hi @src/a.txt` ✅ |
| 5 | `hi @src/a.txtr` ❌ |
| 4 | `hi @src/a.txtsr` ❌ |
| 3（`@` 上） | `hi @src/a.txt@sr` ❌ |
| 2（`@` 左侧） | `hi @src/a.txt@sr` ❌ |

可达性：菜单在光标移动时**不会**关闭——`nvim/lua/dsh_tui/` 全目录 grep 无 `CursorMoved`/`CursorMovedI`，只有 `InsertLeave` 关菜单（`autocmds.lua:48-55`），smoke 自己也断言 "at-menu stays open through navigation"（`scripts/smoke.ts:1929`）。用户按 `<Left>` 回到 token 中间再按 `<CR>`（`init.lua:286-288` 分支）即触发。

**复现路径**
1. 输入 `请读 @sr` → 等 `dsh-at-query` 返回候选（`AM.set`，光标仍在行尾则菜单打开）。
2. 按 `<Left>` 两下把光标移进 token（`@s|r`）。
3. 按 `<CR>` → 输入行变成 `请读 @src/a.txtsr`（本该是 `请读 @src/a.txtr` 或整段替换后的 `请读 @src/a.txt`）。
4. smoke 只覆盖"光标在 token 末尾"（`scripts/smoke.ts:1901-1906`，`col=10` = 行尾），故 CI 绿。

**建议修法**：把下界从 `start` 换成"token 终点"——即从 `start+1` 起向后吃掉 `[^%s"'@]*`：

```lua
local e = start + 1
while e <= #line and line:sub(e+1, e+1):match('[^%s"\'@]') do e = e + 1 end
local col = math.max(math.min(cur[2], #line), e)
```

（同时 `AM.set` 的 stale-response 守卫已确认 `line:sub(start+1,start+1) == '@'`，可用同一 `start` 复算 token 终点。）

---

## 4. [bug / medium] bottom 停靠区浮窗不随输入框增高重排 → 遮挡输入框，违反文档承诺

**位置**
- 缺口：`nvim/lua/dsh_tui/input.lua:45-75`（`I.resize()` 改输入/聊天窗口高度，**从不调用 `region_reflow`**）
- 依赖该几何的代码：`nvim/lua/dsh_tui/api.lua:668-674`（`inputTop` 只在 reflow 时取一次）、`api.lua:710-717`（`bottom` 行以 `row = inputTop - 1` 锚定）
- 文档承诺：`docs/EXT-API.md:229`「bottom 行锚定在输入框上方，**永不遮挡输入**」、`docs/EXT-API.md:231`（`region_claim(id,{side='bottom'})` 示例）、`nvim/lua/dsh_tui/api.lua:666-667` 同义注释
- 现有 reflow 触发点（grep 全仓）：`autocmds.lua:297-304`（仅 `VimResized`）、`session.lua:128`（`<C-o>` 面板）、`api.lua:855/894`（claim/release）、`api.lua:209/360`（unregister/prune）

**机制（确定因果链）**

```lua
-- api.lua:668-674（reflow 时算一次）
  local inputTop = vim.o.lines
  if S.input_win ~= nil and vim.api.nvim_win_is_valid(S.input_win) then
    local ok, pos = pcall(vim.api.nvim_win_get_position, S.input_win)
    if ok and pos ~= nil and type(pos[1]) == 'number' then inputTop = pos[1] end
  end
-- api.lua:713-717
      local bottomRow = math.max(0, inputTop - 1)          -- 输入框上一行
      local cfg = { ... anchor = side == 'bottom' and 'SW' or 'NW',
        row = side == 'bottom' and bottomRow or 0, ... }
      pcall(vim.api.nvim_win_set_config, p.win, cfg)
```

而输入框会**长高**：`I.resize()`（`input.lua:45-75`）把输入窗高度设为 `n+1`（n = 1..6 行内容），并把聊天窗高度压到 `vim.o.lines - vim.o.cmdheight - (n + 3)`——底部输入窗的顶行因此上移，`inputTop` 变小。`I.resize()` 被 `TextChanged`/`TextChangedI` 自动调用（`autocmds.lua:28-45`，粘贴多行、`<C-CR>` 换行、历史回填都会触发），但这条路径**只**做 `I.resize()` + `CM.update()`/`AM.update()`，没有任何 `API.region_reflow()`。于是已声明的 bottom 区域浮窗仍停在旧的 `inputTop-1`，新长出来的输入行（最多 5 行）被它盖住——用户看不到自己在打什么，正是文档禁止的形态。

**复现路径**
1. 用扩展 API 声明一个底栏：`require('dsh_tui.api').region_claim('demo', { side = 'bottom', size = 4, lines = {'x'} })`（等价于 `docs/EXT-API.md:231` 的 `git-panel` 示例，或 runner 侧 `ui.region({side:'bottom'})`，`src/kernel/ext-types.ts:146` 已把 `'bottom'` 列为合法取值）。
2. 在输入框里粘贴 4 行文本（或按 3 次 `<C-CR>` 换行）→ 输入框长到 5 行。
3. 观察：底栏浮窗位置不变，输入框顶部 4 行被浮窗覆盖；终端 resize 一下（触发 `VimResized`）才恢复。
4. 反向同理：内容删回 1 行后浮窗会悬在聊天区中部（不会跟着回落）。

**建议修法**：在 `I.resize()` 末尾（`refresh_frame()` 之前/之后）加一次 `require('dsh_tui.api').region_reflow()`；为免递归（`region_reflow` 里 `nvim_win_set_config` 会触发窗口事件），可加一个 `S.inRegionReflow` 重入位或只在 `height` 实际变化时调用。

---

## 5. [risk / medium] `on_lines = vim.schedule_wrap(...)` 里的 `return true` 无法 detach：注释宣称的"视图消失即解绑"从未发生

**位置**：`nvim/lua/dsh_tui/popups.lua:130-151`（`return true` 出现在 136 与 149 行）

**机制（确定因果链）**

```lua
-- popups.lua:132-151
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = vim.schedule_wrap(function()
      local sv = S.subagentView
      if not (sv.win and ... ) then
        return true              -- 136: 意图＝detach（视图已消失）
      end
      ...
      return true                -- 149: 每次成功缩放也 return true
    end),
  })
```

nvim 的契约是"**返回 lua-truthy 才 detach**"（`/opt/homebrew/share/nvim/runtime/doc/api.txt:2371`：`on_lines: ... Return a |lua-truthy| value to detach.`），但 `vim.schedule_wrap` 的实现把返回值丢掉：

```lua
-- /opt/homebrew/share/nvim/runtime/lua/vim/_core/editor.lua:269-276
function vim.schedule_wrap(fn)
  return function(...)
    local args = vim.F.pack_len(...)
    vim.schedule(function() fn(vim.F.unpack_len(args)) end)   -- 无 return
  end
end
```

即两个 `return true` 都是死代码，且语义自相矛盾：若真能生效，149 行的 `true` 会让回调在**第一次**内容变化后就解绑（与"随 transcript 增长持续缩放"的注释相反）；现在则一次都不解绑。当前实际危害有限（视图关闭时其 buffer 被 wipe，回调自然消失），但"视图失效即解绑 + 不再重排"这一意图完全没实现，后续若把该 buffer 改成 `bufhidden='hide'` 或复用，就会变成对已关浮窗的持续窗口操作。

**复现路径（读码即可确认，无需运行）**：在 `nvim --headless` 下 `local f = vim.schedule_wrap(function() return true end); print(select('#', f()))` → `0`（返回值为空）。

**建议修法**：把窗口操作留在 `vim.schedule` 里，但把回调本体直接给 `on_lines`（不做 schedule_wrap），在回调内用 `vim.schedule(function() ... end)` 做延迟窗口操作并 `return` detach 标志；或保留 schedule_wrap 但删掉无意义的 `return true` 并在注释里改为"buffer 随窗口 wipe 自动解绑"。

---

## 6. [risk / medium] `S.buildingLayout` 无异常复位：一次 `botright 1split` 失败即永久关闭自愈/所有权守卫

**位置**：`nvim/lua/dsh_tui/layout.lua:24-27`（`build_input_window`）、`layout.lua:75-81`（`build`）
**受影响的守卫**：`autocmds.lua:205`（输入缓冲克隆守卫 `if S.buildingLayout then return end`）、`autocmds.lua:319`（窗口所有权守卫 `if S.quitting or S.buildingLayout then return end`）、`autocmds.lua:175`（WinClosed 输入窗重建 `if S.buildingLayout or S.quitting then return end`）

**机制（确定因果链）**

```lua
-- layout.lua:24-28
function L.build_input_window()
  S.buildingLayout = true
  vim.cmd('botright 1split')     -- ← 无 pcall
  S.buildingLayout = false
```

`S.buildingLayout` 只在正常返回路径被复位。`vim.cmd` 抛错（小窗口下的 `E36: Not enough room`、被 `'winminheight'` 顶住、或命令触发的用户 autocmd 在 nvim 侧转为 Lua 错误）时，`S.buildingLayout` 永久为 `true`：`build()`（76-80 行）同样没有 `pcall`/`finally`，错误会继续冒泡穿过 `M.start()`（`init.lua:363-367` 在 `L.build()` **之后**才 `K.install()`/`A.install()`），结果是——

- 三个关键守卫全部变成恒 `return`，TUI 失去自愈能力（输入窗被关不再重建、插件把文件 edit 进输入窗不再被搬走、`:sp` 克隆输入缓冲不再被拦）；
- 键位与 autocmd 层可能根本没装上（`M.start()` 半途中断），而 `S.started` 已被置 `true`（`init.lua:337-340`），连重新 `start()` 的自愈路径都被幂等锁死。

**复现路径**
1. 极小终端（例如 `lines` 压到 3~4）或把 `winminheight` 调高后启动 dsh；
2. `botright 1split` 抛 `E36` → `:lua print(require('dsh_tui.state').buildingLayout)` 为 `true`；
3. 之后 `:q` 掉输入窗 → WinClosed 网（`autocmds.lua:169-197`）因 175 行直接 return，输入框再也不回来。

**建议修法**：用 `pcall` 包住 `vim.cmd('botright 1split')` 并在失败分支同样复位标志（或 `local ok, err = pcall(...); S.buildingLayout = false; if not ok then ... end`），`build()` 内部再包一层 `pcall` + 失败时 `S.started = false` 以便重试；这样至少不会把"自愈开关"卡死在关闭态。

---

## 7. [deadcode / medium] 会话列表浮窗整族无生产调用方（仅 smoke 可用），`/sessions` 已改走通用 picker

**位置**：`nvim/lua/dsh_tui/popups.lua:533-663`（`show_session_list` 546、`render_session_list` 595、`session_list_move` 621、`session_list_jump` 627、`session_list_select` 633、`session_list_new` 646、`close_session_list` 653；状态初始化 539-544）+ 转发层 `nvim/lua/dsh_tui/init.lua:207-213`

**无调用方的 grep 证据（全仓，排除 node_modules）**

- `show_session_list` 出现处：`nvim/.../popups.lua`（定义）、`nvim/.../init.lua`（转发）、`scripts/smoke.ts:165,692,1154,1162`（测试）——`src/**` 与 `lib/**` **零命中**；
- `session_list_move/jump/select/new`、`close_session_list`：仅 `scripts/smoke.ts:1158-1166, 179, 705`；
- 与之配套的两个 nvim→Node 通知 `dsh-session-select` / `dsh-session-new` 的**唯一发出点**是 `popups.lua:642/649`（grep `nvim/` 全目录），而 runner 仍在注册它们的处理器：`src/sessions/index.ts:302-305`——即生产路径下这两个通道永远不会被触发；
- 生产实现已换成通用 picker：`src/sessions/commands/sessions.ts:50` `const sel = await app.openPicker(t('会话（工作区分组 · Enter 打开）'), rows)`（`/sessions` 全程用 `openPicker`，含新建/重命名/归档/分组）。

**机制**：`/sessions` 命令重构时改用了 `openPicker`（带 workspace 分组、行内二级菜单），但 `popups.lua` 里的专用会话列表浮窗（含 `<C-n>` 新建、`Enter` 切换、全量 session id 展示）与其两个通知处理器都没有删除、也没有任何生产调用方；`REQUIREMENTS.md:49-51` 仍把 `show_session_list` 记为 Node→nvim 协议面、把 `dsh-session-select`/`dsh-session-new` 记为"会话浮窗"，文档与实现已经脱节（同处 537 行注释还把通知名写成 `dsh-session-selected`，实际是 `dsh-session-select`，可见该族代码已长期无人走）。

**复现路径**：`grep -rn "show_session_list" src/ lib/` → 空；`grep -rn "dsh-session-select" src/ nvim/` → 只有 runner 的处理器 + 这段死代码的发出点。

**建议修法**：二选一——(a) 承认通用 picker 是正式实现：删除 `popups.lua:533-663` 与 `init.lua:207-213` 转发，同时删掉 `src/sessions/index.ts:302-305` 的两个死通知处理器，并把 `REQUIREMENTS.md:49-51` 改成 `show_picker`；(b) 若保留专用浮窗（它有 picker 没有的"新建会话"入口），则把 `/sessions` 切回 `show_session_list`，避免两套会话 UI 并存。

---

## 8. [bug / low] `DshTuiQuote`：`hi default ... gui=italic` 之后的 `hi default link ... Comment` 恒不生效 → 引用块失去暗淡色

**位置**：`nvim/lua/dsh_tui/highlight.lua:130-133`

```lua
  -- Markdown structure: headings stand out, quotes dim italic, links underline.
  vim.cmd('highlight default link DshTuiHeading Title')
  vim.cmd('highlight default DshTuiQuote gui=italic cterm=italic')
  vim.cmd('highlight default link DshTuiQuote Comment')
```

**机制**：`:hi default` 的语义是"仅在组**尚未定义**时生效"。第 132 行已经把 `DshTuiQuote` 定义出来（gui/cterm=italic），第 133 行的 `default link` 因此被跳过，链接永远不会建立；而该组在每次 `applyHighlights()` 都被同样顺序重放（`hi clear` 之后也一样），所以不是"首次 vs 之后"的偶发，而是恒失效。

**实测证据（本机 nvim 0.12.5，只读）**

```
$ nvim --headless -u NONE \
  -c 'hi default DshTuiQuote gui=italic cterm=italic' \
  -c 'hi default link DshTuiQuote Comment' \
  -c 'lua print(vim.inspect(vim.api.nvim_get_hl(0,{name="DshTuiQuote",link=false})))'
{ cterm = { italic = true }, italic = true }      -- 无任何 fg
$ ... print(vim.api.nvim_get_hl(0,{name="DshTuiQuote"}).link)  →  nil
```

**影响面**：渲染器确实用该组渲染 Markdown 引用块（`src/feed/feed.ts:985` `group = 'DshTuiQuote'`，smoke `scripts/smoke.ts:1813` 只断言 mark 的组名、不断言其高亮），因此引用块在所有主题下都是"Normal 前景 + 斜体"，与注释/设计（"dim italic"，跟随主题 Comment 的暗淡色）不符；`applyDimPalette` 的暗淡策略（`highlight.lua:243-256`）也照顾不到它。

**复现路径**：会话里发一段 `> 引用文字` → 引用块颜色与正文相同（仅斜体），而 `DshTuiReasoning`/`DshTuiNotice` 等同类暗淡组明显更淡。

**建议修法**：让"链接 + 斜体"同时成立——`vim.api.nvim_set_hl(0,'DshTuiQuote',{ link='Comment', italic=true })`（本机 nvim 0.12.5 实测同时保留 `link="Comment"` 与 `italic=true`；若担心 0.9 上二者不可并存，可直接并入 `applyDimPalette` 的 `setDimGroup('DshTuiQuote', 0.72)` 家族获得主题自适应的暗淡前景 + 斜体），并删掉这两行互相打架的 `hi default`。

---

## 9. [deadcode / low] `layout.lua:58-66` 的 `has('nvim-0.9')` else 分支不可达，且该分支用的是 0.10 才有的 `virt_text_pos='inline'`

**位置**：`nvim/lua/dsh_tui/layout.lua:55-66`

```lua
  if vim.fn.has('nvim-0.9') == 1 then
    vim.wo[S.input_win].statuscolumn = '%#DshTuiBorder#│%s%#DshTuiPrompt#❯ '
  else
    vim.api.nvim_buf_set_extmark(S.input_buf, S.ns, 0, 0, {
      virt_text = { { '❯ ', 'DshTuiPrompt' } },
      virt_text_pos = 'inline',        -- nvim 0.10+ 才有；0.9 及以下会报 "Invalid 'virt_text_pos'"
      hl_mode = 'combine',
    })
  end
```

**机制**：`README.md:106` 声明最低支持 **Neovim 0.9**（`docs/REVIEW-2025-09.md:265` 亦确认"README 最低 0.9"），故 `has('nvim-0.9') == 1` 在受支持平台上恒真 ⇒ else 分支永远不会执行（死代码）；而该分支恰恰是"降级兜底"，一旦有人真在 0.8 上跑（README 未支持但代码到处留了 0.9/0.10 守卫，暗示作者仍在照 0.8 写），`nvim_buf_set_extmark` 会因未知的 `virt_text_pos` 值直接抛错，且此处**没有 pcall**，会把 `L.build_input_window()` → `L.build()` → `M.start()` 整条启动链打断（与 §6 叠加时后果更重：标志卡死 + 界面半成品）。

**复现路径**：`grep -n "nvim-0.9" nvim/lua/dsh_tui/layout.lua`（58 行）+:58 分支恒真即可确认；真机复现需要 nvim 0.8。

**建议修法**：既然最低 0.9，直接删掉 else 分支（保留 statuscolumn 实现），并在 `README.md:106`/`UPGRADE.md` 明确"<0.9 不支持"；若确实想保 0.8 降级，则把该 extmark 用 `pcall` 包住并改用 0.8 支持的 `virt_text_pos='overlay'`/`'eol'` 方案。

---

## 10. [risk / low] `S.subagentView` 在**模块加载期**被无条件重置：重载后丢失活浮窗句柄，并复现作者刚修掉的 E95 静默失败

**位置**：`nvim/lua/dsh_tui/popups.lua:74`（顶层语句，不在任何函数内）

```lua
S.subagentView = { buf = nil, win = nil }     -- 74 行：每次 dofile/重载都会执行
...
function P.open_subagent_view(title)
  ...
  local prev = S.subagentView                   -- 84：靠它才能回收旧 buffer
  if prev.win and vim.api.nvim_win_is_valid(prev.win) then ... end
  if prev.buf and vim.api.nvim_buf_is_valid(prev.buf) then
    pcall(vim.api.nvim_buf_delete, prev.buf, { force = true })   -- 88-90
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, 'dsh-subagent-view')            -- 92：名字必须空闲
```

**机制**：同文件对其它浮窗状态都做了"重载安全"守卫——`if S.dirWin == nil then ...`（218）、`if S.progress == nil then ...`（456）、`if S.sessWin == nil then ...`（539），`subagent_chat.lua:26-28` 亦同；`state.lua:13-18` 更把"重载必须拿到同一张 S、不得清掉活句柄"写成契约（`init.lua:44-66` 的 `package.preload` 桥就是为 rtp 重建/vim.loader 场景准备的）。唯独 74 行是无条件赋值：一旦 `dsh_tui.popups` 被重新 `dofile`（lazy.nvim 重建 rtp、`package.loaded` 被清、开发期 reload），正在显示的 subagent view 浮窗句柄即被抹掉，随后：

- `close_subagent_view()`（166-182）拿不到窗口/buffer → 用户 `q` 关不掉、`dsh-subagent-view-closed` 不发；
- 更关键的是 84-90 行的回收逻辑失效 ⇒ 旧 buffer（`bufhidden='wipe'`，但窗口还在所以没被 wipe）仍占用名字 `dsh-subagent-view` ⇒ 下次 `nvim_buf_set_name`（92）撞 E95 ——**正是注释 80-83 行描述的"第二次打开静默失败"**。

**复现路径**
1. 打开一个子代理只读视图（`open_subagent_view`）。
2. `:lua package.loaded['dsh_tui.popups']=nil; require('dsh_tui.popups')`（等价于 rtp 重建后的重载）。
3. 再打开一个子代理视图 → `nvim_buf_set_name` 抛 E95（旧窗口仍在、名字仍占用），新视图不出现；同时旧视图 `q` 失效。

**建议修法**：把 74 行改成与同族一致的守卫 `if S.subagentView == nil then S.subagentView = { buf = nil, win = nil } end`（或干脆删除该行，`state.lua:96` 已初始化该字段），并把 92 行的 `nvim_buf_set_name` 用 pcall 包住以免 E95 再次变成静默失败。

---

## 11. [risk / low] `S.activeId == nil` 时按 `<C-o>` 每次泄漏一个未登记显示缓冲（`bufhidden='hide'`，永不回收）

**位置**：`nvim/lua/dsh_tui/session.lua:97-110`

```lua
  else
    local buf = S.activeId and S.reasoningBufs[S.activeId]
    if not (buf and vim.api.nvim_buf_is_valid(buf)) then
      if S.activeId then
        buf = SE.ensure_reasoning(S.activeId).reasoningBuf   -- 规范路径：登记 + 命名
      else
        buf = vim.api.nvim_create_buf(false, true)           -- 106：无会话时的兜底
        B.chat_buffer_options(buf)                           -- → buftype=nofile, bufhidden='hide'
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '·· 思考与工具记录（<C-o> 收起）' })
      end
    end
```

**机制**：106-109 行创建的缓冲既没有写进 `S.reasoningBufs`（不登记 ⇒ runner 的 `idsProvider`/renderer 永远看不到它，面板内容恒为占位文字），也没有 `nvim_buf_set_name`；`B.chat_buffer_options`（`buffer.lua:14-38`）给它设的是 `bufhidden='hide'` + 每次注册一条 `InsertEnter` autocmd。关闭面板只关窗口（93-96），缓冲永远隐藏存活；再按 `<C-o>` 又走一遍同一分支（`S.reasoningBufs[S.activeId]` 仍为空）⇒ **每按一次泄漏一个未命名 buffer + 一条 autocmd**，长会话里反复切面板/重启前会持续累积。

**复现路径**：`S.activeId` 为 nil 的窗口期（runner 尚未 `set_active`，例如 attach 之后、会话建立之前的启动瞬间；或任何没有活动会话的降级状态）连按 `<C-o>` N 次 → `:lua =#vim.api.nvim_list_bufs()` 每次 +1，`:ls!` 可见 N 个无名的 nofile 缓冲，面板内容始终是占位行。

**建议修法**：在无 `activeId` 时不要另建缓冲，直接 `return`（或临时用一个挂在 `S.reasoningBufs.__scratch` 上、可被 `close` 时 `nvim_buf_delete` 回收的单例缓冲），把"无会话"当作不可开面板的状态处理。

---

## 12. [deadcode / low] `API.panel_reflow` 全仓库零调用方

**位置**：`nvim/lua/dsh_tui/api.lua:746-749`

```lua
--- Back-compat alias: the right/left columns used to be "the panel slot".
function API.panel_reflow()
  return API.region_reflow()
end
```

**grep 证据（全仓，排除 node_modules）**：`panel_reflow` 仅出现在 `api.lua:747`（定义）、`state.lua:48`（注释）、`CHANGELOG.md:334/335/481`（历史说明）——`src/`、`lib/`、`scripts/`、`examples/`、`docs/EXT-API.md` 均无调用（`docs/EXT-API.md` 的 API 清单里只有 `panel_claim`/`panel_release`/`region_claim`/`region_release`）。对照：同为兼容别名的 `panel_claim`/`panel_release` 有真实调用方（`examples/nvim/git-panel.lua:26`、`scripts/smoke.ts:2560-2583`、`docs/EXT-API.md:222-224`），`region_reflow` 由 4 处内部路径调用（见 §4 列表）。

**机制**：纯转发别名，没有任何（含文档/示例）消费者 ⇒ 不可能是"给第三方插件的稳定面"（未进 `docs/EXT-API.md`），只能是历史残留；它与 `region_reflow` 并存还会误导读者以为两套 reflow 语义不同。

**复现路径**：`grep -rn "panel_reflow" --include=* . | grep -v node_modules` → 只有定义与注释/CHANGELOG。

**建议修法**：删除 `api.lua:746-749`（如需保留兼容面，就在 `docs/EXT-API.md` 的别名段里登记它并标明 deprecated，否则它既无文档也无调用方）。

---

## 已核查但**未**报告的点（避免噪音，仅列结论）

- 版本降级守卫：`vim.uv or vim.loop`（`init.lua:373`、`autocmds.lua:386`）、`footer/footer_pos` 0.10 守卫（`popup_core.lua:82`、`popups.lua:180`、`full_input.lua:80`）、`title/title_pos` 在 `show_dir_picker`/`show_session_list`/`show_input_history`/`full_input` 未加守卫但 `title` 是 0.9 特性、与 `README.md:106` 的最低版本一致——不算缺陷。
- `M.start()` 幂等（`S.started`）、`vim.g.ministatusline_disable`、`cmdheight=0`（0.9 守卫）、`mouse=''` 均只作用于本 TUI 实例，无跨会话污染。
- 缓冲/窗口卫生：浮窗缓冲统一 `bufhidden='wipe'`（`popup_core.lua:190` 等）、`lock_popup_buffer`/`lock_display_keys` 键位随缓冲销毁、`A.install_input()` 用 `{clear=true}` 的 augroup 可重复安装、`P.close_float` 显式清空 `win/buf/kind/state`——这些路径核查后无泄漏。
- `init.lua:272-285` 扩展 before_submit 钩子逐条 `pcall` 且失败走 `ExtHookError` 事件（不静默）；`API.*` 的返回值契约（`{err=...}` 结构、msgpack 只回传首值）与 `docs/EXT-API.md` 一致；`api.handshake` 的 major 版本比对、`snapshot()` 字段、`Ready/Shutdown` 事件由 runner 发出（`src/ext-api/index.ts:678`、`src/kernel/lifecycle.ts:134/161`）——均无缺环。
- `Session.lua` 的面板重定向（`set_active` 时切换 reasoning buf）核查后**不可达缺陷**：runner 在 `attachSession` 阶段就对每个会话调用 `ensure_reasoning`（`src/sessions/services.ts:30`），`set_active` 时该会话的 reasoning buffer 必然存在，故"面板显示上一会话思考"的分支实际走不到，未列入正式条目。
- `cmd_menu`/`at_menu` 的 `S.cmdIdx % #S.cmdMatches` 除零、菜单打开期间 matches 为空的组合，核查后不可达（`CM.update`/`render` 在 matches 为空时必定 `close()`），不计入。
