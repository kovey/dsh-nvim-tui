--- dsh_tui.popup_core: shared popup plumbing (buffer locks, footers,
--- centering) + the generic float family (approval / questions / picker).
local S = require('dsh_tui.state')
local I = require('dsh_tui.input')
local P = {}

--- Edit keys a read-only surface must silence (normal-mode entries plus the
--- in-place editors: join, case toggles, increments, insert-at-position).
local EDIT_KEYS = {
  'i', 'a', 'o', 'O', 'I', 'A', 'r', 'R', 's', 'S', 'c', 'C', 'd', 'D',
  'x', 'X', 'p', 'P', '<Insert>', ':', 'J', '~', 'g~', 'gu', 'gU', 'gi', 'gI',
  '<C-a>', '<C-x>',
}

--- Interactive popups are read-only: lock the buffer and Nop the edit keys so
--- an accidental i/x/dd can neither change the content nor raise a raw E21.
--- (Buffers re-rendered by the API toggle 'modifiable' around set_lines.)
function P.lock_popup_buffer(buf)
  vim.bo[buf].modifiable = false
  for _, k in ipairs(EDIT_KEYS) do
    vim.keymap.set('n', k, '<Nop>', { buffer = buf })
  end
end

--- Display-only buffers (chat / reasoning) are written by the renderer through
--- the API, so they MUST stay modifiable — but the user must never edit them:
--- Nop the edit keys without touching 'modifiable'.
function P.lock_display_keys(buf)
  for _, k in ipairs(EDIT_KEYS) do
    vim.keymap.set('n', k, '<Nop>', { buffer = buf })
  end
end

--- Every popup opens centered on the editor (a shared formula so no window
--- drifts to a corner): vertically mid-screen (slightly above center) and
--- horizontally centered, clamped to the top-left when space is short.
function P.centered_row(height)
  return math.max(0, math.floor((vim.o.lines - height) / 2) - 2)
end

function P.centered_col(width)
  return math.max(0, math.floor((vim.o.columns - width) / 2))
end

-- ===========================================================================
-- Popup footer: the operation hints for popups. nvim >= 0.10 embeds them
-- INTO the popup's bottom border via the native `footer` config (like the
-- title in the top border) — no detached bar, no extra row, and the float
-- stays self-contained on terminal resize. Older nvim gets the legacy
-- 1-row floating bar below the window.
-- ===========================================================================
function P.detach_footer()
  if S.footer.win and vim.api.nvim_win_is_valid(S.footer.win) then
    pcall(vim.api.nvim_win_close, S.footer.win, true)
  end
  S.footer.win = nil
  S.footer.buf = nil
  S.footer.mainWin = nil
end

--- Attach (or update) the hint footer on `mainWin`: hints live in the bottom
--- border (left-aligned, like the title in the top border) on nvim >= 0.10.
function P.attach_footer(mainWin, text)
  P.detach_footer()
  if not (mainWin and vim.api.nvim_win_is_valid(mainWin)) then return end
  if vim.fn.has('nvim-0.10') == 1 then
    local ok = pcall(vim.api.nvim_win_set_config, mainWin, {
      footer = text,
      footer_pos = 'left',
    })
    if ok then
      S.footer.win = nil
      S.footer.buf = nil
      S.footer.mainWin = mainWin
      return
    end
  end
  -- Legacy detached bar (nvim < 0.10, or set_config footer unsupported):
  -- 1 footer row + 2 border rows must fit below the window's top row.
  local cfg = vim.api.nvim_win_get_config(mainWin)
  local height = cfg.height
  local avail = vim.o.lines - 3
  if height > avail then
    height = math.max(1, avail)
    vim.api.nvim_win_set_height(mainWin, height)
  end
  local row = math.max(0, math.min(cfg.row, vim.o.lines - height - 3))
  if row ~= cfg.row then
    vim.api.nvim_win_set_config(mainWin, {
      relative = 'editor', anchor = 'NW', row = row, col = cfg.col, width = cfg.width, height = height,
    })
  end
  local width = cfg.width
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  local pad = math.max(0, width - vim.fn.strdisplaywidth(text))
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { text .. string.rep(' ', pad) })
  vim.bo[buf].modifiable = false
  local win = vim.api.nvim_open_win(buf, false, {
    relative = 'editor',
    anchor = 'NW',
    row = row + height + 2,
    col = cfg.col,
    width = width,
    height = 1,
    border = 'none',
    style = 'minimal',
    zindex = (cfg.zindex or 50) + 1,
    focusable = false,
  })
  vim.wo[win].winhighlight = 'Normal:DshTuiStatus,NormalNC:DshTuiStatus'
  S.footer.win = win
  S.footer.buf = buf
  S.footer.mainWin = mainWin
end








function P.close_float()
  P.detach_footer()
  if S.float.win and vim.api.nvim_win_is_valid(S.float.win) then
    pcall(vim.api.nvim_win_close, S.float.win, true)
  end
  S.float.win = nil
  S.float.buf = nil
  S.float.kind = nil
  S.float.state = nil
  I.focus()
end

-- Rows a line occupies in a float of `width` cells (CJK glyphs count 2
-- cells; an empty line still takes one row). Floats do not auto-grow, so the
-- window height must be computed from the WRAPPED layout — sizing by the raw
-- line count clipped the bottom rows (the key hints) whenever a tool reason
-- or option description wrapped.
function P.line_rows(line, width)
  return math.max(1, math.ceil(vim.fn.strdisplaywidth(line) / width))
end

-- Total visual height of `lines` wrapped at `width`, clamped to a sane
-- window size and to the editor, so the float always fits on screen.
function P.float_height(lines, width)
  local h = 0
  for _, l in ipairs(lines) do
    h = h + P.line_rows(l, width)
  end
  local cap = math.min(24, math.max(3, vim.o.lines - 2))
  return math.max(3, math.min(cap, h))
end

function P.open_float(lines, opts)
  P.close_float()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  local width = math.max(40, math.min(opts.maxWidth or 100, opts.width or 64))
  local height = P.float_height(lines, width)
  local cfg = {
    relative = 'editor',
    row = P.centered_row(height),
    col = P.centered_col(width),
    width = width,
    height = height,
    border = 'rounded',
    style = 'minimal',
  }
  if vim.fn.has('nvim-0.9') == 1 and type(opts.title) == 'string' and opts.title ~= '' then
    cfg.title = ' ' .. opts.title .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.cmd('stopinsert') -- interactive float: normal-mode keys must work
  P.lock_popup_buffer(buf) -- read-only: i/x/dd must not edit or raise E21
  S.float.win = win
  S.float.buf = buf
  return buf, win
end

function P.float_key(buf, key, cmd)
  vim.api.nvim_buf_set_keymap(buf, 'n', key, '<Cmd>lua ' .. cmd .. '<CR>', { noremap = true })
end

--- Approval request (from approval/request). entry: {toolName, reason}.
function P.show_approval(entry)
  local lines = {
    '工具: ' .. tostring(entry.toolName or '?'),
    '说明: ' .. tostring(entry.reason or '无'),
    '',
  }
  local buf = P.open_float(lines, { width = 72, title = '⚠ 审批请求' })
  S.float.kind = 'approval'
  P.attach_footer(S.float.win, '[y] 允许一次  [a] 总是（自动模式）  [n] 拒绝  [Esc] 拒绝')
  P.float_key(buf, 'y', 'require("dsh_tui").approval_decide("y")')
  P.float_key(buf, 'a', 'require("dsh_tui").approval_decide("always")')
  P.float_key(buf, 'n', 'require("dsh_tui").approval_decide("n")')
  P.float_key(buf, '<Esc>', 'require("dsh_tui").approval_decide("n")')
end

function P.approval_decide(value)
  if S.float.kind ~= 'approval' then
    return
  end
  P.close_float()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-approval-decided', value)
  end
end

--- User questions. questions: { {id, question, detail, header, options: {{label, description}}, multiSelect} }.
function P.show_questions(questions)
  local qs = {}
  for _, q in ipairs(questions or {}) do
    local opts = {}
    for _, o in ipairs(q.options or {}) do
      table.insert(opts, { label = tostring(o.label), description = o.description })
    end
    table.insert(qs, {
      id = tostring(q.id),
      question = tostring(q.question),
      detail = q.detail,
      header = q.header,
      options = opts,
      multiSelect = q.multiSelect == true,
    })
  end
  P.open_float({ '…' }, { width = 80, title = '用户提问' })
  S.float.kind = 'questions'
  S.float.state = { questions = qs, qIdx = 1, optIdx = 1, selected = {}, optRows = {} }
  P.redraw_questions()
  local function install()
    local buf = S.float.buf
    if not buf then
      return
    end
    P.float_key(buf, 'j', 'require("dsh_tui").question_move(1)')
    P.float_key(buf, 'k', 'require("dsh_tui").question_move(-1)')
    P.float_key(buf, '<Space>', 'require("dsh_tui").question_toggle()')
    P.float_key(buf, '<CR>', 'require("dsh_tui").question_advance()')
    P.float_key(buf, '<Esc>', 'require("dsh_tui").questions_cancel()')
  end
  install()
end

function P.redraw_questions()
  local st = S.float.state
  if not st or S.float.kind ~= 'questions' then
    return
  end
  local q = st.questions[st.qIdx]
  if not q then
    P.questions_confirm()
    return
  end
  local lines = {}
  if q.header then
    table.insert(lines, q.header)
  end
  table.insert(lines, 'Q' .. st.qIdx .. '/' .. #st.questions .. ': ' .. q.question)
  if q.detail then
    table.insert(lines, q.detail)
  end
  table.insert(lines, '')
  local optRows = {}
  for i, o in ipairs(q.options) do
    local mark = st.selected[q.id] and st.selected[q.id][o.label] and '●' or '○'
    table.insert(lines, (i == st.optIdx and '▸ ' or '  ') .. mark .. ' ' .. o.label)
    table.insert(optRows, #lines)
    if o.description then
      table.insert(lines, '    ' .. tostring(o.description))
    end
  end
  if #q.options == 0 then
    table.insert(lines, '（无选项，回车继续）')
  end
  local footerText = q.multiSelect and '[Space] 选择  [j/k] 移动  [Enter] ' ..
    (st.qIdx == #st.questions and '确认' or '下一题') .. '  [Esc] 取消'
    or '[j/k] 选择  [Enter] ' .. (st.qIdx == #st.questions and '确认' or '下一题') .. '  [Esc] 取消'

  vim.bo[S.float.buf].modifiable = true -- popup buffers are locked otherwise
  vim.api.nvim_buf_set_lines(S.float.buf, 0, -1, false, lines)
  vim.bo[S.float.buf].modifiable = false
  -- The float was created with a one-line placeholder: grow/shrink it to the
  -- question's real wrapped height, or the options and the key-hint footer
  -- stay clipped below the window (no visible hints).
  local fwin = S.float.win
  if fwin and vim.api.nvim_win_is_valid(fwin) then
    local cfg = vim.api.nvim_win_get_config(fwin)
    local height = P.float_height(lines, cfg.width)
    if cfg.height ~= height then
      vim.api.nvim_win_set_config(fwin, {
        relative = cfg.relative,
        row = P.centered_row(height),
        col = cfg.col,
        width = cfg.width,
        height = height,
      })
    end
  end
  st.optRows = optRows
  P.attach_footer(S.float.win, footerText)
  if #optRows > 0 then
    vim.api.nvim_win_set_cursor(S.float.win, { optRows[st.optIdx], 0 })
  end
end

function P.question_move(dir)
  local st = S.float.state
  local q = st.questions[st.qIdx]
  if #q.options == 0 then
    return
  end
  st.optIdx = math.max(1, math.min(#q.options, st.optIdx + dir))
  P.redraw_questions()
end

function P.question_toggle()
  local st = S.float.state
  local q = st.questions[st.qIdx]
  if not q.multiSelect or #q.options == 0 then
    return
  end
  local o = q.options[st.optIdx]
  st.selected[q.id] = st.selected[q.id] or {}
  if st.selected[q.id][o.label] then
    st.selected[q.id][o.label] = nil
  else
    st.selected[q.id][o.label] = true
  end
  P.redraw_questions()
end

function P.question_advance()
  local st = S.float.state
  local q = st.questions[st.qIdx]
  if not q.multiSelect and #q.options > 0 then
    local o = q.options[st.optIdx]
    st.selected[q.id] = { [o.label] = true }
  end
  if st.qIdx < #st.questions then
    st.qIdx = st.qIdx + 1
    st.optIdx = 1
    P.redraw_questions()
  else
    P.questions_confirm()
  end
end

function P.questions_confirm()
  local st = S.float.state
  local answers = {}
  for _, q in ipairs(st.questions) do
    local selected = {}
    for _, o in ipairs(q.options) do
      if st.selected[q.id] and st.selected[q.id][o.label] then
        table.insert(selected, o.label)
      end
    end
    if #selected == 0 and #q.options > 0 and not q.multiSelect then
      table.insert(selected, q.options[1].label)
    end
    table.insert(answers, { id = q.id, selected = selected })
  end
  P.close_float()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-questions-answered', answers)
  end
end

function P.questions_cancel()
  P.close_float()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-questions-cancelled')
  end
end

--- Generic picker. items: { {label, value, active} }.
--- Plain buffer: every entry is a REAL line, so nvim's own navigation keys
--- (j/k, G, gg, C-d/C-u) work exactly as in any buffer — G lands on the hint
--- row, and Enter clamps it to the last entry. The hint is the last line,
--- flush with the window bottom because the height fits the content.
local PICKER_HINT = '[j/k] 移动  [Enter] 选择  [Esc] 取消'

function P.show_picker(title, items)
  P.close_float()
  local values = {}
  local lines = {}
  local activeRow = 1
  for _, it in ipairs(items or {}) do
    if type(it) == 'table' and type(it.label) == 'string' then
      lines[#lines + 1] = it.label
      values[#values + 1] = it.value
      if it.active then activeRow = #lines end
    end
  end
  if #lines == 0 then lines = { '（无选项）' } end
  -- Adaptive width: fit the longest row (CJK counts 2 cells), clamped to the
  -- editor — long marketplace rows were clipped at the old fixed 72.
  local width = 72
  for _, l in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(l) + 4)
  end
  width = math.min(width, math.max(40, vim.o.columns - 4))
  local cap = math.min(22, math.max(4, vim.o.lines - 8))
  local height = math.min(cap, #lines)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  local cfg = {
    relative = 'editor',
    row = P.centered_row(height),
    col = P.centered_col(width),
    width = width,
    height = height,
    border = 'rounded',
    style = 'minimal',
  }
  if vim.fn.has('nvim-0.9') == 1 and type(title) == 'string' and title ~= '' then
    cfg.title = ' ' .. tostring(title) .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.cmd('stopinsert') -- input window hands over in insert mode
  S.float.kind = 'picker'
  S.float.state = { values = values }
  S.float.buf = buf
  S.float.win = win
  P.float_key(buf, '<CR>', 'require("dsh_tui").picker_confirm()')
  P.float_key(buf, '<Esc>', 'require("dsh_tui").picker_cancel()')
  P.float_key(buf, 'q', 'require("dsh_tui").picker_cancel()')
  P.float_key(buf, 'G', 'require("dsh_tui").picker_jump("last")')
  P.float_key(buf, 'gg', 'require("dsh_tui").picker_jump("first")')
  P.lock_popup_buffer(buf)
  vim.api.nvim_win_set_cursor(win, { math.min(activeRow, #lines), 0 })
  P.attach_footer(win, PICKER_HINT)
  return buf, win
end

function P.picker_move(dir)
  local st = S.float.state
  if st == nil or S.float.kind ~= 'picker' or #st.values == 0 then return end
  local row = vim.api.nvim_win_get_cursor(S.float.win)[1]
  row = math.max(1, math.min(#st.values, row + dir))
  vim.api.nvim_win_set_cursor(S.float.win, { row, 0 })
end

function P.picker_jump(where)
  local st = S.float.state
  if st == nil or S.float.kind ~= 'picker' or #st.values == 0 then return end
  local row = where == 'last' and #st.values or 1
  vim.api.nvim_win_set_cursor(S.float.win, { row, 0 })
end

function P.picker_confirm()
  local st = S.float.state
  local row = vim.api.nvim_win_get_cursor(S.float.win)[1]
  row = math.max(1, math.min(#st.values, row)) -- G lands on the hint row: take the last entry
  local value = st.values[row]
  P.close_float()
  if S.channel and value ~= nil then
    vim.rpcnotify(S.channel, 'dsh-picker-selected', value)
  end
end

function P.picker_cancel()
  P.close_float()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-picker-cancelled')
  end
end

return P
