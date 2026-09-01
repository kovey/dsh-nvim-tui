--- dsh_tui.popups: the TUI's dedicated popups (skill detail, subagent
--- transcript view, directory picker, file-diff lines float, live progress
--- float, session list). The @-mention menu moved to dsh_tui.at_menu.
local S = require('dsh_tui.state')
local P = {}

local PC = require('dsh_tui.popup_core')
local lock_popup_buffer = PC.lock_popup_buffer
local lock_display_keys = PC.lock_display_keys
local centered_row = PC.centered_row
local centered_col = PC.centered_col
local attach_footer = PC.attach_footer
local detach_footer = PC.detach_footer
local I = require('dsh_tui.input')

local SKILL_HINT = '[q]/[Esc] 关闭'

function P.show_skill(info)
  local lines = { '🛠 ' .. tostring(info.name or '') .. ' — ' .. tostring(info.description or '') }
  if info.whenToUse ~= nil and info.whenToUse ~= '' then
    lines[#lines + 1] = '适用: ' .. tostring(info.whenToUse)
  end
  lines[#lines + 1] = ''
  for _, l in ipairs(vim.split(tostring(info.content or ''), '\n', { plain = true })) do
    lines[#lines + 1] = l
  end
  local cap = math.min(32, math.max(5, vim.o.lines - 4))
  local height = math.min(cap, #lines)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  local cfg = {
    relative = 'editor',
    row = centered_row(height),
    col = centered_col(math.min(120, math.max(40, vim.o.columns - 4))),
    width = math.min(120, math.max(40, vim.o.columns - 4)),
    height = height,
    border = 'rounded',
    style = 'minimal',
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 技能详情 '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_skill()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_skill()<CR>', { buffer = buf })
  lock_popup_buffer(buf)
  vim.api.nvim_win_set_cursor(win, { 1, 0 })
  attach_footer(win, SKILL_HINT)
  vim.cmd('stopinsert') -- the input window hands over in insert mode
  S.skillWin = win
end

--- Close the skill-detail float (also restores focus to the input).
function P.close_skill()
  detach_footer()
  if S.skillWin and vim.api.nvim_win_is_valid(S.skillWin) then
    pcall(vim.api.nvim_win_close, S.skillWin, true)
  end
  S.skillWin = nil
  I.focus()
end

-- ---------------------------------------------------------------------------
-- Subagent transcript view: one read-only float whose buffer the runner's
-- FeedRenderer replays a child session into (reasoning inline + chat + tool
-- cards). q/Esc close; editing keys are Nop'd (the buffer stays modifiable
-- because the renderer writes through the API, which respects 'modifiable').
S.subagentView = { buf = nil, win = nil }

function P.open_subagent_view(title)
  -- Replace any previous view silently (the runner initiated the swap).
  -- The old buffer must be wiped too: with 'hide' it survives the window
  -- close, and the NEXT open's nvim_buf_set_name would collide on
  -- 'dsh-subagent-view' (E95) — the second open silently failed.
  local prev = S.subagentView
  if prev.win and vim.api.nvim_win_is_valid(prev.win) then
    pcall(vim.api.nvim_win_close, prev.win, true)
  end
  if prev.buf and vim.api.nvim_buf_is_valid(prev.buf) then
    pcall(vim.api.nvim_buf_delete, prev.buf, { force = true })
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, 'dsh-subagent-view')
  vim.bo[buf].buftype = 'nofile'
  -- 'wipe' not 'hide': the view buffer is single-use — wiping it on close
  -- is what keeps the buffer name free for the next open.
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  -- Same popup logic as /sessions: content-fitted height (grows with the
  -- replayed transcript), footer hint bar below the window, G/gg jumps.
  local cap = math.min(40, math.max(8, vim.o.lines - 4))
  local cfg = {
    relative = 'editor',
    row = centered_row(1),
    col = centered_col(math.min(120, math.max(40, vim.o.columns - 4))),
    width = math.min(120, math.max(40, vim.o.columns - 4)),
    height = 1,
    border = 'rounded',
    style = 'minimal',
    zindex = 45,
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 子代理 · ' .. tostring(title or '') .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.cmd('stopinsert') -- input window hands over in insert mode
  for _, k in ipairs({ 'i', 'a', 'o', 'O', 'I', 'A', 'r', 'R', 's', 'S', 'c', 'C', 'd', 'D', 'x', 'X', 'p', 'P', '<Insert>', ':' }) do
    vim.keymap.set('n', k, '<Nop>', { buffer = buf })
  end
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_subagent_view()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_subagent_view()<CR>', { buffer = buf })
  vim.keymap.set('n', 'G', '<Cmd>lua require("dsh_tui").subagent_view_jump("last")<CR>', { buffer = buf })
  vim.keymap.set('n', 'gg', '<Cmd>lua require("dsh_tui").subagent_view_jump("first")<CR>', { buffer = buf })
  attach_footer(win, '[q]/[Esc] 关闭')
  S.subagentView = { buf = buf, win = win }
  -- Grow/shrink the window with the transcript and keep the footer anchored
  -- (deferred: window ops are restricted inside the on_lines callback).
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = vim.schedule_wrap(function()
      local sv = S.subagentView
      if not (sv.win and sv.buf and vim.api.nvim_win_is_valid(sv.win) and vim.api.nvim_buf_is_valid(sv.buf)) then
        return true
      end
      local lines = vim.api.nvim_buf_get_lines(sv.buf, 0, -1, false)
      local h = math.max(1, math.min(cap, #lines))
      if vim.api.nvim_win_get_height(sv.win) ~= h then
        vim.api.nvim_win_set_height(sv.win, h)
        vim.api.nvim_win_set_config(sv.win, {
          relative = 'editor', anchor = 'NW',
          row = centered_row(h), col = centered_col(vim.api.nvim_win_get_width(sv.win)),
          width = vim.api.nvim_win_get_width(sv.win), height = h,
        })
        attach_footer(sv.win, '[q]/[Esc] 关闭')
      end
      return true
    end),
  })
  return { buf = buf, win = win }
end

function P.subagent_view_jump(where)
  local sv = S.subagentView
  if not (sv.win and sv.buf and vim.api.nvim_win_is_valid(sv.win) and vim.api.nvim_buf_is_valid(sv.buf)) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(sv.buf, 0, -1, false)
  local row = where == 'last' and math.max(1, #lines) or 1
  vim.api.nvim_win_set_cursor(sv.win, { row, 0 })
end

--- User-facing close (q/Esc): notify the runner so it stops routing events.
function P.close_subagent_view()
  detach_footer()
  local sv = S.subagentView
  if sv.win and vim.api.nvim_win_is_valid(sv.win) then
    pcall(vim.api.nvim_win_close, sv.win, true)
  end
  if sv.buf and vim.api.nvim_buf_is_valid(sv.buf) then
    -- Wipe the single-use replay buffer so a later open never hits
    -- E95 (buffer name already exists) on 'dsh-subagent-view'.
    pcall(vim.api.nvim_buf_delete, sv.buf, { force = true })
  end
  S.subagentView = { buf = nil, win = nil }
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-subagent-view-closed')
  end
  I.focus()
end

--- Current view ids (for the runner's FeedRenderer idsProvider).
function P.subagent_view_ids()
  local sv = S.subagentView
  if sv.win and vim.api.nvim_win_is_valid(sv.win) then
    return { buf = sv.buf, win = sv.win }
  end
  return nil
end

--- Settled replays land on the FIRST thinking block: the window otherwise
--- opens scrolled to the transcript tail (the final answer), so the thinking
--- details look missing. Returns the 1-based row it landed on.
function P.subagent_view_goto_thinking()
  local sv = S.subagentView
  if not (sv.win and vim.api.nvim_win_is_valid(sv.win)) then
    return nil
  end
  local lines = vim.api.nvim_buf_get_lines(sv.buf, 0, -1, false)
  local row = 1
  for i, l in ipairs(lines) do
    if vim.startswith(l, '·· thinking') then
      row = i
      break
    end
  end
  vim.api.nvim_win_set_cursor(sv.win, { row, 0 })
  return row
end

-- ---------------------------------------------------------------------------
-- Directory picker: navigable float. Enter descends / selects, <BS> goes up,
-- q/Esc cancel. Selection returns via 'dsh-dir-selected'.
S.dirWin = nil
S.dirBuf = nil
S.dirPath = nil
S.dirRows = {}   -- display rows
S.dirIdx = 1

local function dir_entries(path)
  local ok, names = pcall(vim.fn.readdir, path)
  if not ok then return nil end
  local dirs, files = {}, {}
  for _, n in ipairs(names) do
    local full = path .. '/' .. n
    if vim.fn.isdirectory(full) == 1 then dirs[#dirs + 1] = { name = n, dir = true } end
  end
  for _, n in ipairs(names) do
    local full = path .. '/' .. n
    if vim.fn.isdirectory(full) ~= 1 then files[#files + 1] = { name = n, dir = false } end
  end
  table.sort(dirs, function(a, b) return a.name < b.name end)
  table.sort(files, function(a, b) return a.name < b.name end)
  local out = {}
  for _, d in ipairs(dirs) do out[#out + 1] = d end
  for _, f in ipairs(files) do out[#out + 1] = f end
  return out
end

local DIR_HINT = '[j/k] 移动  [Enter] 进入/选择  [BS] 上级  [Esc] 取消'

function P.render_dir_picker()
  local win = S.dirWin
  if not (win and vim.api.nvim_win_is_valid(win)) then return end
  local entries = dir_entries(S.dirPath)
  if entries == nil then
    P.close_dir_picker()
    return
  end
  S.dirRows = entries
  if S.dirIdx > #entries then S.dirIdx = math.max(1, #entries) end
  if #entries == 0 then S.dirIdx = 0 end
  -- Plain buffer: every entry is a real line, so nvim's own scrolling keys
  -- (j/k/G/gg/C-d/C-u) work as expected; the hint lives in the footer bar.
  local rows = { '📁 ' .. S.dirPath .. '/', '' }
  for _, e in ipairs(entries) do
    rows[#rows + 1] = '  ' .. e.name .. (e.dir and '/' or '')
  end
  local cap = math.min(14, math.max(6, vim.o.lines - 8))
  local height = math.min(cap, #rows)

  vim.bo[S.dirBuf].modifiable = true
  vim.api.nvim_buf_set_lines(S.dirBuf, 0, -1, false, rows)
  vim.bo[S.dirBuf].modifiable = false
  if vim.api.nvim_win_get_height(win) ~= height then
    vim.api.nvim_win_set_height(win, height)
    vim.api.nvim_win_set_config(win, {
      relative = 'editor', anchor = 'NW',
      row = centered_row(height), col = centered_col(72),
      width = 72, height = height,
    })
  end
  attach_footer(win, DIR_HINT)
  if S.dirIdx > 0 then
    vim.api.nvim_win_set_cursor(win, { 2 + S.dirIdx, 0 })
  end
end

--- startPath: absolute or relative directory to start in.
function P.show_dir_picker(startPath)
  P.close_dir_picker()
  S.dirPath = vim.fn.fnamemodify(startPath or vim.fn.getcwd(), ':p'):gsub('/$', '')
  if vim.fn.isdirectory(S.dirPath) ~= 1 then
    S.dirPath = vim.fn.getcwd()
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.b[buf].ministatusline_disable = true
  S.dirBuf = buf
  S.dirIdx = 1
  S.dirWin = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    row = centered_row(math.min(14, math.max(6, vim.o.lines - 8))),
    col = centered_col(72),
    width = 72,
    height = math.min(14, math.max(6, vim.o.lines - 8)),
    border = 'rounded',
    style = 'minimal',
    title = ' 目录选择 ',
    title_pos = 'center',
  })
  vim.wo[S.dirWin].cursorline = true
  vim.wo[S.dirWin].number = false
  vim.wo[S.dirWin].signcolumn = 'no'
  vim.cmd('stopinsert') -- input window hands over in insert mode
  local k = function(key, cmd)
    vim.keymap.set('n', key, '<Cmd>lua ' .. cmd .. '<CR>', { buffer = buf })
  end
  -- j/k/G/gg scroll the plain buffer natively; Enter picks the cursor row.
  k('<CR>', 'require("dsh_tui").dir_enter()')
  k('<BS>', 'require("dsh_tui").dir_up()')
  k('q', 'require("dsh_tui").close_dir_picker()')
  k('<Esc>', 'require("dsh_tui").close_dir_picker()')
  k('G', 'require("dsh_tui").dir_jump("last")')
  k('gg', 'require("dsh_tui").dir_jump("first")')
  lock_popup_buffer(buf)
  P.render_dir_picker()
end

function P.dir_jump(where)
  if #S.dirRows == 0 then return end
  S.dirIdx = where == 'last' and #S.dirRows or 1
  P.render_dir_picker()
end

function P.dir_enter()
  -- Derive the index from the cursor so native j/k/G/gg navigation works
  -- (G lands on the hint row → clamp to the last entry).
  local row = vim.api.nvim_win_get_cursor(S.dirWin)[1]
  local idx = math.max(1, math.min(#S.dirRows, row - 2))
  S.dirIdx = idx
  local e = S.dirRows[idx]
  if e == nil then return end
  if e.dir then
    S.dirPath = S.dirPath .. '/' .. e.name
    S.dirIdx = 1
    P.render_dir_picker()
  else
    local full = S.dirPath .. '/' .. e.name
    P.close_dir_picker()
    if S.channel then
      vim.rpcnotify(S.channel, 'dsh-dir-selected', full)
    end
  end
end

function P.dir_up()
  local parent = S.dirPath:match('^(.*)/[^/]+$')
  if parent == nil or parent == '' then
    P.close_dir_picker()
    return
  end
  S.dirPath = parent
  S.dirIdx = 1
  P.render_dir_picker()
end

function P.close_dir_picker()
  detach_footer()
  if S.dirWin and vim.api.nvim_win_is_valid(S.dirWin) then
    pcall(vim.api.nvim_win_close, S.dirWin, true)
  end
  S.dirWin = nil
  S.dirBuf = nil
  S.dirPath = nil
  S.dirRows = {}
  S.dirIdx = 1
end

-- ---------------------------------------------------------------------------
-- Generic scrollable info float (workflow view, settings overview, …).
-- ---------------------------------------------------------------------------
--- Generic read-only lines float (workflow / settings / trajectory).
--- Plain buffer: all lines are real lines, so nvim's own scrolling keys
--- (j/k/G/gg/C-d/C-u) work as expected; the hint is the last line and the
--- window height fits the content. `editPath` (optional): map i/o to open
--- that file in a new tab. Without it i/o are Nop'd so a read-only float
function P.show_lines_float(title, lines, editPath)
  local all = lines or {}
  local hint = type(editPath) == 'string' and editPath ~= ''
    and '[i/o] 打开文件编辑  [q]/[Esc] 关闭'
    or '[q]/[Esc] 关闭'
  local rows = {}
  for _, l in ipairs(all) do
    rows[#rows + 1] = l
  end
  if #rows == 0 then rows = { '（空）' } end
  local cap = math.min(36, math.max(5, vim.o.lines - 4))
  local height = math.min(cap, #rows)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  local cfg = {
    relative = 'editor',
    row = centered_row(height),
    col = centered_col(math.min(110, math.max(40, vim.o.columns - 4))),
    width = math.min(110, math.max(40, vim.o.columns - 4)),
    height = height,
    border = 'rounded',
    style = 'minimal',
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' ' .. tostring(title or '') .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_lines_float()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_lines_float()<CR>', { buffer = buf })
  lock_popup_buffer(buf) -- i/o below override the Nops when editPath is set
  if type(editPath) == 'string' and editPath ~= '' then
    vim.keymap.set('n', 'i', function()
      vim.cmd('tabedit ' .. vim.fn.fnameescape(editPath))
      P.close_lines_float()
    end, { buffer = buf })
    vim.keymap.set('n', 'o', function()
      vim.cmd('tabedit ' .. vim.fn.fnameescape(editPath))
      P.close_lines_float()
    end, { buffer = buf })
  else
    -- Read-only float: an edit attempt must not surface a raw E21.
    vim.keymap.set('n', 'i', '<Nop>', { buffer = buf })
    vim.keymap.set('n', 'o', '<Nop>', { buffer = buf })
  end
  vim.cmd('stopinsert') -- input window hands over in insert mode
  S.linesWin = win
  vim.api.nvim_win_set_cursor(win, { 1, 0 })
  attach_footer(win, hint)
  return { buf = buf, win = win }
end

function P.close_lines_float()
  detach_footer()
  if S.linesWin and vim.api.nvim_win_is_valid(S.linesWin) then
    pcall(vim.api.nvim_win_close, S.linesWin, true)
  end
  S.linesWin = nil
end

-- ---------------------------------------------------------------------------
-- Live progress float (plugin install / update-all / …): the runner streams
-- log lines + a bottom bar row; the window tails the latest lines so a long
-- operation never looks stuck. q/Esc hide it (the operation keeps running).
S.progress = { win = nil, buf = nil }

function P.show_progress(title, lines)
  P.close_progress()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines or { '' })
  vim.bo[buf].modifiable = false
  local width = 76
  local cap = math.min(16, math.max(6, vim.o.lines - 12))
  local cfg = {
    relative = 'editor',
    row = centered_row(cap),
    col = centered_col(width),
    width = width,
    height = cap,
    border = 'rounded',
    style = 'minimal',
    zindex = 60,
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' ' .. tostring(title or '进度') .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_progress()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_progress()<CR>', { buffer = buf })
  lock_popup_buffer(buf)
  vim.cmd('stopinsert')
  S.progress = { win = win, buf = buf }
  return { buf = buf, win = win }
end

--- Replace the visible tail with the newest log lines + the bottom bar row
--- (styled as a statusline). The window height stays put; content tails.
function P.progress_update(lines, bar)
  local st = S.progress
  if not (st and st.win and vim.api.nvim_win_is_valid(st.win)) then return end
  local height = vim.api.nvim_win_get_height(st.win)
  local maxLog = math.max(1, height - 1) -- last row is the bar
  local src = lines or {}
  local rows = {}
  for i = math.max(1, #src - maxLog + 1), #src do
    rows[#rows + 1] = src[i]
  end
  rows[#rows + 1] = bar or ''
  vim.bo[st.buf].modifiable = true
  vim.api.nvim_buf_set_lines(st.buf, 0, -1, false, rows)
  vim.bo[st.buf].modifiable = false
  local width = vim.api.nvim_win_get_width(st.win)
  local text = rows[#rows]
  local pad = math.max(0, width - vim.fn.strdisplaywidth(text))
  if pad > 0 then
    text = text .. string.rep(' ', pad)
    -- Explicit range: nvim_buf_set_lines(-1, -1) INSERTS past the last line
    -- instead of replacing it (negative -1 = index past the end).
    vim.bo[st.buf].modifiable = true
    vim.api.nvim_buf_set_lines(st.buf, #rows - 1, #rows, false, { text })
    vim.bo[st.buf].modifiable = false
  end
  vim.api.nvim_buf_clear_namespace(st.buf, S.ns, 0, -1)
  vim.api.nvim_buf_set_extmark(st.buf, S.ns, #rows - 1, 0, {
    end_row = #rows - 1, end_col = #text, hl_group = 'DshTuiStatus', priority = 4096,
  })
end

function P.close_progress()
  if S.progress.win and vim.api.nvim_win_is_valid(S.progress.win) then
    pcall(vim.api.nvim_win_close, S.progress.win, true)
  end
  S.progress = { win = nil, buf = nil }
end

-- ---------------------------------------------------------------------------
-- Layout presets (no resident session list — sessions live in the /sessions
-- float): default (chat + input) / panel (reasoning panel open).
--- Session list float (/sessions): entries { {id, title, active, kind} } with
--- FULL session ids. j/k move, <CR> selects (dsh-session-selected), <C-n> asks
--- for a new session, q/Esc close.
S.sessWin = nil
S.sessBuf = nil
S.sessEntries = {}
S.sessIdx = 1

function P.show_session_list(entries)
  P.close_session_list()
  S.sessEntries = entries or {}
  local n = #S.sessEntries
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.b[buf].ministatusline_disable = true
  S.sessBuf = buf
  local idx = 1
  for i, e in ipairs(S.sessEntries) do
    if e.active then idx = i end
  end
  S.sessIdx = idx
  -- Window exactly fits the content: '' + entries; the hint lives in the
  -- footer bar below the window.
  local cap = math.min(16, math.max(5, vim.o.lines - 6))
  local height = n == 0 and 1 or math.min(cap, n + 1)
  S.sessWin = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    row = centered_row(height),
    col = centered_col(88),
    width = 88,
    height = height,
    border = 'rounded',
    style = 'minimal',
    title = ' 会话列表（/sessions） ',
    title_pos = 'center',
  })
  vim.wo[S.sessWin].cursorline = true
  vim.wo[S.sessWin].number = false
  vim.wo[S.sessWin].signcolumn = 'no'
  local k = function(key, cmd)
    vim.keymap.set('n', key, '<Cmd>lua ' .. cmd .. '<CR>', { buffer = buf })
  end
  -- j/k/G/gg scroll the plain buffer natively; Enter picks the cursor row.
  k('<CR>', 'require("dsh_tui").session_list_select()')
  k('<C-n>', 'require("dsh_tui").session_list_new()')
  k('q', 'require("dsh_tui").close_session_list()')
  k('<Esc>', 'require("dsh_tui").close_session_list()')
  k('G', 'require("dsh_tui").session_list_jump("last")')
  k('gg', 'require("dsh_tui").session_list_jump("first")')
  lock_popup_buffer(buf)
  vim.cmd('stopinsert') -- input window hands over in insert mode
  P.render_session_list()
end

function P.render_session_list()
  local buf = S.sessBuf
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local entries = S.sessEntries
  local n = #entries
  local rows = {}
  if n == 0 then
    rows = { '（没有会话）' }
  else
    rows[#rows + 1] = ''
    for i, e in ipairs(entries) do
      local title = type(e.title) == 'string' and e.title ~= '' and e.title or '（无标题）'
      local kind = e.kind == 'history' and ' 历史' or (e.active and ' 当前' or '')
      rows[#rows + 1] = '  ' .. title .. ' · ' .. tostring(e.id or '') .. kind
    end
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  attach_footer(S.sessWin, n == 0 and '[C-n] 新建会话  [Esc] 关闭'
    or '[j/k] 移动  [Enter] 切换  [C-n] 新建  [Esc] 关闭')
  if S.sessWin and vim.api.nvim_win_is_valid(S.sessWin) and n > 0 then
    vim.api.nvim_win_set_cursor(S.sessWin, { 1 + S.sessIdx, 0 })
  end
end

function P.session_list_move(dir)
  if #S.sessEntries == 0 then return end
  S.sessIdx = math.max(1, math.min(#S.sessEntries, S.sessIdx + dir))
  P.render_session_list()
end

function P.session_list_jump(where)
  if #S.sessEntries == 0 then return end
  S.sessIdx = where == 'last' and #S.sessEntries or 1
  P.render_session_list()
end

function P.session_list_select()
  -- Derive the index from the cursor so native j/k/G/gg navigation works
  -- (G lands on the hint row → clamp to the last entry).
  local row = vim.api.nvim_win_get_cursor(S.sessWin)[1]
  local idx = math.max(1, math.min(#S.sessEntries, row - 1))
  S.sessIdx = idx
  local e = S.sessEntries[idx]
  P.close_session_list()
  if e and S.channel then
    vim.rpcnotify(S.channel, 'dsh-session-select', e.id)
  end
end

function P.session_list_new()
  P.close_session_list()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-session-new')
  end
end

function P.close_session_list()
  detach_footer()
  if S.sessWin and vim.api.nvim_win_is_valid(S.sessWin) then
    pcall(vim.api.nvim_win_close, S.sessWin, true)
  end
  S.sessWin = nil
  S.sessBuf = nil
  S.sessEntries = {}
  S.sessIdx = 1
  I.focus()
end


return P
