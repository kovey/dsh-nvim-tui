-- dsh_tui: the Neovim-side UI of dsh-nvim-tui.
--
-- Three-window layout:
--   +--------------+---------------------------+
--   | sessions     | chat (active session)     |
--   | (24 cols)    |                           |
--   |              +---------------------------+
--   |              | input (buftype=prompt)    |
--   +--------------+---------------------------+
--
-- The Node runner drives this side over msgpack-RPC: it hands us its channel
-- id via attach(), creates one chat buffer per session (ensure_chat), renders
-- the session list (set_sessions), switches the visible chat (set_active),
-- renders DSH events into the right chat buffer (buf_set_lines), and receives
-- user input / slash commands / session selection as rpcnotify.

local M = {}

local chat_win
local input_buf, input_win

M._channel = nil
M._started = false
M._chats = {}          -- session id -> chat buffer
M._reasoningBufs = {}  -- session id -> reasoning buffer
M._reasoningWin = nil  -- the (optional) reasoning panel window
M._reasoningOpen = false
M._activeId = nil
M._ns = vim.api.nvim_create_namespace('dsh_tui')

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
local function lock_popup_buffer(buf)
  vim.bo[buf].modifiable = false
  for _, k in ipairs(EDIT_KEYS) do
    vim.keymap.set('n', k, '<Nop>', { buffer = buf })
  end
end

--- Display-only buffers (chat / reasoning) are written by the renderer through
--- the API, so they MUST stay modifiable — but the user must never edit them:
--- Nop the edit keys without touching 'modifiable'.
local function lock_display_keys(buf)
  for _, k in ipairs(EDIT_KEYS) do
    vim.keymap.set('n', k, '<Nop>', { buffer = buf })
  end
end

--- Every popup opens centered on the editor (a shared formula so no window
--- drifts to a corner): vertically mid-screen (slightly above center) and
--- horizontally centered, clamped to the top-left when space is short.
local function centered_row(height)
  return math.max(0, math.floor((vim.o.lines - height) / 2) - 2)
end

local function centered_col(width)
  return math.max(0, math.floor((vim.o.columns - width) / 2))
end

-- ===========================================================================
-- Popup footer: the operation hints for popups. nvim >= 0.10 embeds them
-- INTO the popup's bottom border via the native `footer` config (like the
-- title in the top border) — no detached bar, no extra row, and the float
-- stays self-contained on terminal resize. Older nvim gets the legacy
-- 1-row floating bar below the window.
-- ===========================================================================
M._footer = { win = nil, buf = nil, mainWin = nil }

local function detach_footer()
  if M._footer.win and vim.api.nvim_win_is_valid(M._footer.win) then
    pcall(vim.api.nvim_win_close, M._footer.win, true)
  end
  M._footer = { win = nil, buf = nil, mainWin = nil }
end

--- Attach (or update) the hint footer on `mainWin`: hints live in the bottom
--- border (left-aligned, like the title in the top border) on nvim >= 0.10.
local function attach_footer(mainWin, text)
  detach_footer()
  if not (mainWin and vim.api.nvim_win_is_valid(mainWin)) then return end
  if vim.fn.has('nvim-0.10') == 1 then
    local ok = pcall(vim.api.nvim_win_set_config, mainWin, {
      footer = text,
      footer_pos = 'left',
    })
    if ok then
      M._footer = { win = nil, buf = nil, mainWin = mainWin }
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
  M._footer = { win = win, buf = buf, mainWin = mainWin }
end

M._statuslineText = nil

local function apply_statusline()
  if chat_win and vim.api.nvim_win_is_valid(chat_win) and M._statuslineText ~= nil then
    -- pcall: a malformed string must never pop the E539 hit-enter prompt.
    pcall(vim.api.nvim_win_set_option, chat_win, 'statusline', M._statuslineText)
  end
end

--- Set the chat window statusline (Node drives the content). The text is
--- stored so window events can re-apply it — statusline plugins
--- (mini.statusline, lualine, …) rewrite the option on every WinEnter.
function M.set_statusline(text)
  M._statuslineText = text or ''
  apply_statusline()
end

--- Terminal title (OSC 2): the runner keeps it in sync with the active
--- session so the terminal tab/window title shows what you're working on.
function M.set_title(text)
  vim.o.titlestring = (text ~= nil and text ~= '') and ('dsh · ' .. text) or 'dsh'
end

--- Re-apply after the event batch (the LAST writer wins).
function M.reschedule_statusline()
  vim.schedule(function() apply_statusline() end)
end

local function chat_buffer_options(buf)
  vim.bo[buf].buftype = 'nofile'
  -- Display-only: clicking the chat while the input is in insert mode can
  -- drag the insert state along (nvim keeps it on the focus switch) — snap
  -- the display buffers straight back to normal mode.
  vim.api.nvim_create_autocmd('InsertEnter', {
    buffer = buf,
    callback = function()
      vim.schedule(function()
        if vim.api.nvim_get_current_buf() == buf then
          -- A real <Esc> keypress: :stopinsert can silently no-op right
          -- after a focus switch (same class as the restore's startinsert).
          vim.api.nvim_input('<Esc>')
        end
      end)
    end,
  })
  -- 'hide' not 'wipe': these buffers must survive being hidden — the
  -- reasoning panel's buffer is hidden whenever the panel closes and each
  -- chat buffer is hidden when another session becomes active. 'wipe' would
  -- unload them, invalidate the ids the runner captured, and silently break
  -- every later flush (no highlights, dead panel).
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undolevels = -1 -- chat history must never be undoable ('u')
  -- Statusline plugins (mini.statusline, lualine, …) re-render the statusline
  -- on every event and would overwrite our per-window option. mini.statusline
  -- documents a per-buffer opt-out; lualine ignores disabled buffers too.
  vim.b[buf].ministatusline_disable = true
end

--- Disable the user's completion plugins (nvim-cmp etc.) for the input
--- buffer. cmp.setup.buffer applies to the CURRENT buffer, so this runs
--- inside nvim_buf_call; cmp itself lazy-loads on InsertEnter, so callers
--- retry at several later points until the override sticks.
function M.disable_external_completion()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  vim.api.nvim_buf_call(input_buf, function()
    vim.bo.completefunc = ''
    vim.bo.omnifunc = ''
    local ok, cmp = pcall(require, 'cmp')
    if ok and type(cmp) == 'table' and type(cmp.setup) == 'table'
      and type(cmp.setup.buffer) == 'function' then
      pcall(cmp.setup.buffer, { enabled = false })
    end
  end)
end

local function make_input_buffer()
  input_buf = vim.api.nvim_create_buf(false, true)
  -- 'hide' not 'wipe': if anything closes the input WINDOW (ZZ / :q / a
  -- plugin), the buffer — typed draft included — survives and the WinClosed
  -- safety net just re-attaches it.
  vim.bo[input_buf].bufhidden = 'hide'
  vim.bo[input_buf].swapfile = false
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { '' })
  -- Statusline plugins (mini.statusline et al.) must not render on our
  -- windows — the per-buffer opt-out applies to every dsh_tui buffer.
  vim.b[input_buf].ministatusline_disable = true
  M.disable_external_completion()
end

M._history = {}
M._histIdx = nil
M._draft = nil

local function input_text()
  return table.concat(vim.api.nvim_buf_get_lines(input_buf, 0, -1, false), '\n')
end

local function set_input_text(text)
  local lines = vim.split(text, '\n', { plain = true })
  if #lines == 0 then
    lines = { '' }
  end
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(input_win, { #lines, #(lines[#lines] or '') + 1 })
  M.resize_input()
  M.update_cmd_menu()
end

--- Dynamic input height: 1..6 rows following the content. The freed/taken
--- rows are applied to the CHAT window explicitly — nvim's split tree would
--- otherwise redistribute them to the sessions window, leaving a dead gap
--- row between the chat and the input.
--- Fill the input line with `text` and hand back to the input in insert
--- mode (the command-completion menu's Enter logic, reused by /help).
function M.fill_input(text)
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then return end
  set_input_text(text)
  vim.api.nvim_set_current_win(input_win)
  vim.cmd('startinsert')
end

-- ===========================================================================
-- Chat code syntax highlighting: the user's own nvim setup (nvim-treesitter +
-- their colorscheme) colors fenced code and diff blocks. Treesitter runs on a
-- HIDDEN scratch buffer (parsers need no window), so the chat keeps its own
-- extmark pipeline; capture names map to the colorscheme's @xxx groups.
-- Any failure (no treesitter / no parser / no query) leaves the block on its
-- flat code color — the chat must never error on a highlight.
-- ===========================================================================
M._syntaxScratch = nil

--- Fence language / file extension → nvim filetype (nil = unsupported).
function M.syntax_ft(lang)
  if type(lang) ~= 'string' then return nil end
  local l = lang:lower():gsub('[^%w_+-]', '')
  if l == '' then return nil end
  local aliases = {
    -- short/alias forms
    js = 'javascript', jsx = 'javascriptreact', ts = 'typescript', tsx = 'typescriptreact',
    py = 'python', rb = 'ruby', sh = 'sh', bash = 'sh', zsh = 'sh',
    yml = 'yaml', yaml = 'yaml', json = 'json', jsonc = 'jsonc',
    md = 'markdown', markdown = 'markdown', html = 'html', css = 'css', scss = 'scss',
    vue = 'vue', svelte = 'svelte', go = 'go', rs = 'rust', c = 'c', h = 'c',
    cpp = 'cpp', hpp = 'cpp', java = 'java', kt = 'kotlin', lua = 'lua', vim = 'vim',
    sql = 'sql', toml = 'toml', ini = 'ini', dockerfile = 'dockerfile',
    -- nvim-treesitter renamed grammars: `php` IS the phpdoc parser; the real
    -- PHP code grammar is `php_only`.
    php = 'php_only', php_only = 'php_only',
    swift = 'swift', zig = 'zig', tf = 'terraform', hcl = 'hcl',
    cs = 'csharp', fs = 'fsharp', scala = 'scala', r = 'r', dart = 'dart',
    perl = 'perl', elixir = 'elixir', erl = 'erlang', hs = 'haskell',
    -- full filetype names (fences spell the language, e.g. ```python)
    python = 'python', javascript = 'javascript', javascriptreact = 'javascriptreact',
    typescript = 'typescript', typescriptreact = 'typescriptreact', ruby = 'ruby',
    rust = 'rust', kotlin = 'kotlin', csharp = 'csharp', fsharp = 'fsharp',
    haskell = 'haskell', erlang = 'erlang', terraform = 'terraform',
  }
  if aliases[l] then return aliases[l] end
  -- Unknown language: no highlight (the flat code color stays) — the real
  -- parser gate happens inside highlight_syntax's pcall anyway.
  return nil
end

--- Apply treesitter highlight marks for code blocks onto `bufnr` (ns must be
--- the feed's token namespace). blocks = {{ lang, row, col, lines }} — row/col
--- are the block's origin in the TARGET buffer; lines are the code strings.
function M.highlight_syntax(bufnr, ns, blocks)
  if not (bufnr and vim.api.nvim_buf_is_valid(bufnr)) then return end
  local okSetup = pcall(require, 'nvim-treesitter')
  if not okSetup then return end -- no treesitter: keep the flat code color
  local scratch = M._syntaxScratch
  if not (scratch and vim.api.nvim_buf_is_valid(scratch)) then
    scratch = vim.api.nvim_create_buf(false, true)
    M._syntaxScratch = scratch
  end
  local targetLines = vim.api.nvim_buf_line_count(bufnr)
  for _, blk in ipairs(blocks or {}) do
    local lang, row, col, lines = blk and blk.lang, blk and blk.row, blk and blk.col, blk and blk.lines
    if type(lang) == 'string' and type(row) == 'number' and type(lines) == 'table'
      and #lines > 0 and row >= 0 and row < targetLines then
      local ft = M.syntax_ft(lang)
      if ft ~= nil then
        pcall(function()
          vim.bo[scratch].filetype = ft
          vim.api.nvim_buf_set_lines(scratch, 0, -1, false, lines)
          local parser = vim.treesitter.get_parser(scratch, ft)
          parser:parse(true)
          local query = vim.treesitter.query.get(ft, 'highlights')
          if query == nil then return end
          local root = parser:parse()[1]:root()
          local col0 = col or 0
          for id, node in query:iter_captures(root, scratch, 0, -1) do
            local r1, c1, r2, c2 = node:range()
            local lineText = lines[r1 + 1]
            if lineText ~= nil and row + r1 < targetLines then
              local s = col0 + c1
              local e = math.min(col0 + #lineText, col0 + c2)
              if e > s then
                pcall(vim.api.nvim_buf_set_extmark, bufnr, ns, row + r1, s,
                  { end_col = e, hl_group = '@' .. query.captures[id], priority = 4097 })
              end
            end
          end
        end)
      end
    end
  end
end

--- The input frame's RIGHT edge: one right-aligned `│` mark per input row.
--- Splits take no borders, so the vertical edges are the statuscolumn on the
--- left and these marks on the right. Refreshed on every text change (cheap:
--- the input never exceeds a handful of rows).
M._frameNs = vim.api.nvim_create_namespace('dsh_tui_input_frame')
function M.refresh_input_frame()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then return end
  vim.api.nvim_buf_clear_namespace(input_buf, M._frameNs, 0, -1)
  local n = math.max(1, vim.api.nvim_buf_line_count(input_buf))
  for i = 0, n - 1 do
    pcall(vim.api.nvim_buf_set_extmark, input_buf, M._frameNs, i, 0, {
      virt_text = { { '│', 'DshTuiBorder' } },
      virt_text_pos = 'right_align',
      hl_mode = 'combine',
      priority = 4096,
    })
  end
end

function M.resize_input()
  local lc = vim.api.nvim_buf_line_count(input_buf)
  local n = math.min(6, math.max(1, lc))
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    -- The window height counts the winbar row too: n text rows + winbar,
    -- plus the statusline hint bar below (the frame's bottom edge).
    vim.api.nvim_win_set_height(input_win, n + 1)
    -- Growing the window leaves nvim's leftover viewport offset from the
    -- pre-grow scroll (the cursor was on the bottom row, so the new text row
    -- renders as a bare `~` beyond-EOF row without the frame's │❯). Clamp
    -- the topline into the viewable range: snap to 1 when the buffer fits,
    -- keep the last n rows visible when it overflows the 6-row cap (a pasted
    -- block must not hide its own earlier lines).
    vim.api.nvim_win_call(input_win, function()
      local w0 = vim.fn.line('w0')
      local top = math.max(1, math.min(w0, lc - n + 1))
      if top ~= w0 then
        pcall(vim.fn.winrestview, { topline = top })
      end
    end)
    if chat_win and vim.api.nvim_win_is_valid(chat_win) then
      -- Row budget: chat text + chat statusline + input (winbar+n) + input
      -- statusline = lines - cmdheight.
      local chatH = vim.o.lines - vim.o.cmdheight - (n + 3)
      if chatH >= 1 then
        vim.api.nvim_win_set_height(chat_win, chatH)
      end
    end
  end
  M.refresh_input_frame()
end

--- Submit the input buffer (keymap <CR>): route slash commands, else send.
--- With the completion menu open, <CR> first completes the selected command
--- (or executes it directly when its name is already typed in full).
function M.submit()
  local text = input_text():gsub('^%s+', ''):gsub('%s+$', '')
  if text == '' then
    M.close_cmd_menu()
    M.close_at_menu()
    -- The <Cmd>lua mapping draws the (hidden, cmdheight=0) cmdline over the
    -- input's statusline row — the hint bar IS the last screen row. With no
    -- buffer change on this path nothing redraws it, leaving the bottom bar
    -- blank until some unrelated redraw. The blanking happens when the
    -- hidden cmdline CLOSES (after this handler returns), so the redraw must
    -- be scheduled to run after the whole keypress batch.
    vim.schedule(function()
      vim.cmd('redraw')
    end)
    return
  end
  if M.at_menu_open() then
    M.at_accept()
    return
  end
  if M.cmd_menu_state().open then
    local sel = M._cmdMatches[M._cmdIdx]
    M.close_cmd_menu()
    if sel and text ~= sel.name then
      -- A bare prefix is being typed: fill the selected command and let the
      -- user continue with its arguments (a second <CR> executes it).
      set_input_text(sel.name .. ' ')
      return
    end
  end
  if M._channel then
    if text:match('^/') then
      vim.rpcnotify(M._channel, 'dsh-command', text)
    else
      vim.rpcnotify(M._channel, 'dsh-input', text)
    end
  end
  if M._history[#M._history] ~= text then
    table.insert(M._history, text)
  end
  M._histIdx = nil
  M._draft = nil
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { '' })
  M.resize_input()
end

local function at_last_line_end()
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = vim.api.nvim_buf_get_lines(input_buf, cur[1] - 1, cur[1], false)[1] or ''
  -- col 0 on an empty last line counts as its end (insert-mode cursor).
  return cur[1] == vim.api.nvim_buf_line_count(input_buf) and cur[2] >= #line
end

--- <Up>/<Down> history cycling (only at the last line's end; otherwise the
--- default movement is fed through).
function M.history_move(dir)
  if not at_last_line_end() then
    vim.api.nvim_feedkeys(
      vim.api.nvim_replace_termcodes(dir < 0 and '<Up>' or '<Down>', true, false, true), 'n', false)
    return
  end
  if M._histIdx == nil then
    M._draft = input_text()
    M._histIdx = #M._history
    if M._histIdx < 1 then
      M._histIdx = nil
      M._draft = nil
      return
    end
  else
    M._histIdx = M._histIdx + dir
  end
  if M._histIdx < 1 then
    M._histIdx = 1
  end
  if M._histIdx > #M._history then
    set_input_text(M._draft or '')
    M._histIdx = nil
    M._draft = nil
    return
  end
  set_input_text(M._history[M._histIdx])
end

-- ===========================================================================
-- Slash-command completion menu
-- ===========================================================================
-- Typing '/' opens a floating menu above the input line listing every
-- harness command with a description (catalog pushed by the Node runner via
-- set_commands; a builtin fallback keeps the menu useful before/without it).
-- Keystrokes filter the list live: <Tab>/<C-n> move the selection down,
-- <S-Tab>/<C-p> up, <CR> completes the selected command (or executes it when
-- its name is already typed in full), <Esc> closes the menu and stays in
-- insert mode.

M._cmdCatalog = nil        -- { { name = ..., desc = ... }, ... } from the runner
M._cmdWin = nil            -- floating menu window
M._cmdBuf = nil            -- floating menu buffer
M._cmdMatches = {}         -- entries matching the current prefix
M._cmdIdx = 0              -- 1-based selection index
M._cmdTop = 1              -- first visible row

local CMD_NS = vim.api.nvim_create_namespace('dsh_tui_cmd')
local CMD_MAX_H = 10 -- visible rows before the menu scrolls

-- Commands available before the runner pushes its catalog (names only).
local CMD_FALLBACK = {
  '/exit', '/quit', '/restart', '/help', '/clear', '/new', '/sessions',
  '/panel', '/fork', '/branch', '/btw', '/model', '/effort',
  '/preset', '/yolo', '/density', '/glance', '/cost', '/export',
  '/config', '/remember', '/memory', '/image', '/doctor', '/theme', '/status',
  '/tasks', '/subagents', '/workflow', '/skills', '/mcp', '/goal',
  '/compact', '/rewind', '/stop', '/steer', '/plan', '/search', '/rename', '/fb',
  '/permission', '/attach', '/deliverables', '/settings', '/trajectory',
  '/layout', '/bell',
}

--- Replace the completion catalog (called by the Node runner after attach).
function M.set_commands(list)
  M._cmdCatalog = list
end

local function cmd_entries()
  if type(M._cmdCatalog) == 'table' and #M._cmdCatalog > 0 then
    return M._cmdCatalog
  end
  local out = {}
  for _, n in ipairs(CMD_FALLBACK) do
    out[#out + 1] = { name = n, desc = '' }
  end
  return out
end

local function cmd_menu_open()
  return M._cmdWin ~= nil and vim.api.nvim_win_is_valid(M._cmdWin)
end

--- Close the completion menu (public: submit / keymaps / tests).
function M.close_cmd_menu()
  if M._cmdWin and vim.api.nvim_win_is_valid(M._cmdWin) then
    pcall(vim.api.nvim_win_close, M._cmdWin, true)
  end
  M._cmdWin = nil
  M._cmdBuf = nil
  M._cmdMatches = {}
  M._cmdIdx = 0
  M._cmdTop = 1
end

--- Introspection for keymaps and tests.
function M.cmd_menu_state()
  local names = {}
  for _, e in ipairs(M._cmdMatches) do
    names[#names + 1] = e.name
  end
  return {
    open = cmd_menu_open(),
    idx = M._cmdIdx,
    top = M._cmdTop,
    names = names,
    selected = M._cmdMatches[M._cmdIdx] and M._cmdMatches[M._cmdIdx].name or nil,
  }
end

local function cmd_win_config(count, width, extra)
  local cfg = {
    relative = 'win',
    win = input_win,
    anchor = 'NW',
    row = -count - 2, -- menu + border rows sit directly above the input
    col = 0,
    width = width,
    height = count,
    border = 'rounded',
    style = 'minimal',
    focusable = false,
  }
  -- Creation-only keys (nvim_win_set_config must not see them on older nvim).
  if extra and extra.noautocmd then
    cfg.noautocmd = true
  end
  if extra and extra.title and vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 命令补全 '
    cfg.title_pos = 'center'
  end
  return cfg
end

local function render_cmd_menu()
  local win = M._cmdWin
  if not (win and vim.api.nvim_win_is_valid(win)) then
    M._cmdWin = nil
    return
  end
  if not (input_win and vim.api.nvim_win_is_valid(input_win)) then
    M.close_cmd_menu()
    return
  end
  local buf = M._cmdBuf
  local n = #M._cmdMatches
  if n == 0 then
    M.close_cmd_menu()
    return
  end
  if M._cmdIdx < 1 then M._cmdIdx = 1 end
  if M._cmdIdx > n then M._cmdIdx = n end
  -- Scroll the window so the selection is always visible (CMD_MAX_H rows).
  local maxH = math.min(CMD_MAX_H, n)
  local top = M._cmdTop or 1
  if top > M._cmdIdx then top = M._cmdIdx end
  if top <= M._cmdIdx - maxH then top = M._cmdIdx - maxH + 1 end
  M._cmdTop = top
  local count = math.min(maxH, n - top + 1)
  local width = 24
  local rows = {}
  for i = 0, count - 1 do
    local e = M._cmdMatches[top + i]
    local line = e.name .. '  ' .. (e.desc or '')
    width = math.max(width, vim.fn.strdisplaywidth(line) + 2)
    rows[#rows + 1] = line
  end
  width = math.min(width, math.max(12, vim.o.columns - 4))
  for i, line in ipairs(rows) do
    rows[i] = line .. string.rep(' ', width - vim.fn.strdisplaywidth(line))
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, CMD_NS, 0, -1)
  for i = 0, count - 1 do
    local e = M._cmdMatches[top + i]
    local nameW = vim.fn.strdisplaywidth(e.name)
    local sel = (top + i) == M._cmdIdx
    if sel then
      vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
        hl_group = 'DshTuiCmdSel',
        end_row = i,
        end_col = width,
        priority = 10,
      })
    end
    vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
      hl_group = sel and 'DshTuiCmdSelName' or 'DshTuiCmdName',
      end_col = nameW,
      priority = 20,
    })
    vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, nameW + 2, {
      hl_group = sel and 'DshTuiCmdSelDesc' or 'DshTuiCmdDesc',
      priority = 20,
    })
  end
  vim.api.nvim_win_set_config(win, cmd_win_config(count, width))
end

local function open_cmd_menu()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undolevels = -1
  vim.b[buf].ministatusline_disable = true
  M._cmdBuf = buf
  M._cmdWin = vim.api.nvim_open_win(buf, false,
    cmd_win_config(math.min(CMD_MAX_H, #M._cmdMatches), 30, { noautocmd = true, title = true }))
  render_cmd_menu()
end

--- Refresh the menu from the current input text (TextChangedI hook + tests).
--- The menu is visible only while the input is a bare slash prefix (no args).
function M.update_cmd_menu()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  local text = input_text()
  local prefix = text:match('^(/[%w-]*)')
  if prefix == nil or #text ~= #prefix then
    M.close_cmd_menu()
    return
  end
  local matches = {}
  for _, e in ipairs(cmd_entries()) do
    if e.name:sub(1, #prefix) == prefix then
      matches[#matches + 1] = { name = e.name, desc = e.desc or '' }
    end
  end
  if #matches == 0 then
    M.close_cmd_menu()
    return
  end
  -- Keep the current selection when it survives the new filter, else start
  -- at the first match; a fully typed name always selects itself.
  local prev = M._cmdMatches[M._cmdIdx]
  M._cmdMatches = matches
  M._cmdIdx = 1
  if prev then
    for i, e in ipairs(matches) do
      if e.name == prev.name then
        M._cmdIdx = i
        break
      end
    end
  end
  for i, e in ipairs(matches) do
    if e.name == prefix then
      M._cmdIdx = i
      break
    end
  end
  if M._cmdTop > #matches then M._cmdTop = #matches end
  local ok = pcall(function()
    if not cmd_menu_open() then
      open_cmd_menu()
    else
      render_cmd_menu()
    end
  end)
  if not ok then
    M.close_cmd_menu() -- a broken menu must never break typing
  end
end

--- <Tab>/<C-n>: advance the selection. With no menu open, open it when the
--- input is a bare slash prefix; otherwise insert a literal <Tab>.
function M.cmd_next()
  if M.at_menu_open() then
    M.at_next()
    return
  end
  if not cmd_menu_open() then
    M.update_cmd_menu()
    if not cmd_menu_open() then
      vim.api.nvim_feedkeys(
        vim.api.nvim_replace_termcodes('<Tab>', true, false, true), 'n', false)
    end
    return
  end
  M._cmdIdx = M._cmdIdx % #M._cmdMatches + 1
  render_cmd_menu()
end

--- <S-Tab>/<C-p>: move the selection back.
function M.cmd_prev()
  if M.at_menu_open() then
    M.at_prev()
    return
  end
  if not cmd_menu_open() then
    return
  end
  M._cmdIdx = (M._cmdIdx + #M._cmdMatches - 2) % #M._cmdMatches + 1
  render_cmd_menu()
end

--- <C-v> clipboard-image paste: ask the runner to read the clipboard image
--- (macOS pbpaste) and queue it for the next submit.
function M.paste_image()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-paste-image')
  end
end

--- <C-c> stop: ask the runner to abort the running turn (no-op when idle).
function M.abort_turn()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-abort')
  end
end

--- Skill-detail float (from /skills). Esc/q closes. Plain buffer: every line
--- is a real line so nvim's own scrolling keys (j/k/G/gg/C-d/C-u) work; the
--- hint is the last line and the window height fits the content.
local SKILL_HINT = '[q]/[Esc] 关闭'

function M.show_skill(info)
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
  M._skillWin = win
end

--- Close the skill-detail float (also restores focus to the input).
function M.close_skill()
  detach_footer()
  if M._skillWin and vim.api.nvim_win_is_valid(M._skillWin) then
    pcall(vim.api.nvim_win_close, M._skillWin, true)
  end
  M._skillWin = nil
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

-- ---------------------------------------------------------------------------
-- Subagent transcript view: one read-only float whose buffer the runner's
-- FeedRenderer replays a child session into (reasoning inline + chat + tool
-- cards). q/Esc close; editing keys are Nop'd (the buffer stays modifiable
-- because the renderer writes through the API, which respects 'modifiable').
-- ---------------------------------------------------------------------------
M._subagentView = { buf = nil, win = nil }

function M.open_subagent_view(title)
  -- Replace any previous view silently (the runner initiated the swap).
  -- The old buffer must be wiped too: with 'hide' it survives the window
  -- close, and the NEXT open's nvim_buf_set_name would collide on
  -- 'dsh-subagent-view' (E95) — the second open silently failed.
  local prev = M._subagentView
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
  M._subagentView = { buf = buf, win = win }
  -- Grow/shrink the window with the transcript and keep the footer anchored
  -- (deferred: window ops are restricted inside the on_lines callback).
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = vim.schedule_wrap(function()
      local sv = M._subagentView
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

function M.subagent_view_jump(where)
  local sv = M._subagentView
  if not (sv.win and sv.buf and vim.api.nvim_win_is_valid(sv.win) and vim.api.nvim_buf_is_valid(sv.buf)) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(sv.buf, 0, -1, false)
  local row = where == 'last' and math.max(1, #lines) or 1
  vim.api.nvim_win_set_cursor(sv.win, { row, 0 })
end

--- User-facing close (q/Esc): notify the runner so it stops routing events.
function M.close_subagent_view()
  detach_footer()
  local sv = M._subagentView
  if sv.win and vim.api.nvim_win_is_valid(sv.win) then
    pcall(vim.api.nvim_win_close, sv.win, true)
  end
  if sv.buf and vim.api.nvim_buf_is_valid(sv.buf) then
    -- Wipe the single-use replay buffer so a later open never hits
    -- E95 (buffer name already exists) on 'dsh-subagent-view'.
    pcall(vim.api.nvim_buf_delete, sv.buf, { force = true })
  end
  M._subagentView = { buf = nil, win = nil }
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-subagent-view-closed')
  end
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

--- Current view ids (for the runner's FeedRenderer idsProvider).
function M.subagent_view_ids()
  local sv = M._subagentView
  if sv.win and vim.api.nvim_win_is_valid(sv.win) then
    return { buf = sv.buf, win = sv.win }
  end
  return nil
end

--- Settled replays land on the FIRST thinking block: the window otherwise
--- opens scrolled to the transcript tail (the final answer), so the thinking
--- details look missing. Returns the 1-based row it landed on.
function M.subagent_view_goto_thinking()
  local sv = M._subagentView
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
-- @-file-reference completion menu: typing `@` above the input line shows
-- file/directory candidates (pushed by the runner, official fileReferences
-- service or a local fs walk). <CR> accepts: the @token is replaced with the
-- formatted mention (@path / @"path with spaces").
-- ---------------------------------------------------------------------------
M._atWin = nil
M._atBuf = nil
M._atItems = {}   -- { path, mention }
M._atIdx = 0
M._atTop = 1
M._atStart = 0    -- byte offset of '@' in the input line (0-based)

local AT_MAX_H = 8

function M.at_menu_open()
  return M._atWin ~= nil and vim.api.nvim_win_is_valid(M._atWin)
end

function M.close_at_menu()
  if M._atWin and vim.api.nvim_win_is_valid(M._atWin) then
    pcall(vim.api.nvim_win_close, M._atWin, true)
  end
  M._atWin = nil
  M._atBuf = nil
  M._atItems = {}
  M._atIdx = 0
  M._atTop = 1
  M._atStart = 0
end

local function render_at_menu()
  local win = M._atWin
  if not (win and vim.api.nvim_win_is_valid(win)) then
    M._atWin = nil
    return
  end
  if not (input_win and vim.api.nvim_win_is_valid(input_win)) then
    M.close_at_menu()
    return
  end
  local n = #M._atItems
  if n == 0 then
    M.close_at_menu()
    return
  end
  if M._atIdx < 1 then M._atIdx = 1 end
  if M._atIdx > n then M._atIdx = n end
  local maxH = math.min(AT_MAX_H, n)
  local top = M._atTop or 1
  if top > M._atIdx then top = M._atIdx end
  if top <= M._atIdx - maxH then top = M._atIdx - maxH + 1 end
  M._atTop = top
  local count = math.min(maxH, n - top + 1)
  local width = 24
  local rows = {}
  for i = 0, count - 1 do
    local e = M._atItems[top + i]
    rows[#rows + 1] = e.path
    width = math.max(width, vim.fn.strdisplaywidth(e.path) + 2)
  end
  width = math.min(width, math.max(12, vim.o.columns - 4))
  for i, line in ipairs(rows) do
    rows[i] = line .. string.rep(' ', width - vim.fn.strdisplaywidth(line))
  end
  local buf = M._atBuf
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, CMD_NS, 0, -1)
  for i = 0, count - 1 do
    if (top + i) == M._atIdx then
      vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
        hl_group = 'DshTuiCmdSel', end_row = i, end_col = width, priority = 10 })
    end
    vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
      hl_group = (top + i) == M._atIdx and 'DshTuiCmdSelName' or 'DshTuiCmdName',
      end_col = vim.fn.strdisplaywidth(M._atItems[top + i].path),
      priority = 20 })
  end
  vim.api.nvim_win_set_config(win, cmd_win_config(count, width))
end

--- Candidates from the runner (dsh-at-query response). start = '@' offset.
function M.set_at_menu(items, start)
  M._atItems = items or {}
  M._atIdx = 1
  M._atTop = 1
  M._atStart = start or 0
  if #M._atItems == 0 then
    M.close_at_menu()
    return
  end
  local ok = pcall(function()
    if not M.at_menu_open() then
      local buf = vim.api.nvim_create_buf(false, true)
      vim.bo[buf].buftype = 'nofile'
      vim.bo[buf].bufhidden = 'wipe'
      vim.bo[buf].swapfile = false
      vim.b[buf].ministatusline_disable = true
      M._atBuf = buf
      M._atWin = vim.api.nvim_open_win(buf, false,
        cmd_win_config(math.min(AT_MAX_H, #M._atItems), 30, { noautocmd = true }))
    end
    render_at_menu()
  end)
  if not ok then M.close_at_menu() end
end

function M.at_next()
  if not M.at_menu_open() then return end
  M._atIdx = M._atIdx % #M._atItems + 1
  render_at_menu()
end

function M.at_prev()
  if not M.at_menu_open() then return end
  M._atIdx = (M._atIdx + #M._atItems - 2) % #M._atItems + 1
  render_at_menu()
end

--- Accept the selected @-mention: replace the token in the input line.
function M.at_accept()
  local sel = M._atItems[M._atIdx]
  local start = M._atStart
  M.close_at_menu()
  if sel == nil or input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(input_buf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = lines[cur[1]] or ''
  local mention = sel.mention
  local col = math.min(cur[2], #line)
  local newline = line:sub(1, start) .. mention .. line:sub(col + 1)
  lines[cur[1]] = newline
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(input_win, { cur[1], start + #mention })
  M.resize_input()
end

--- Detect an active @token before the cursor; asks the runner for candidates.
function M.update_at_menu()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    M.close_at_menu()
    return
  end
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = vim.api.nvim_buf_get_lines(input_buf, cur[1] - 1, cur[1], false)[1] or ''
  local before = line:sub(1, cur[2])
  local s, pre, query = before:match('()(%A)@([^%s"\'@]*)$')
  if s == nil then
    M.close_at_menu()
    return
  end
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-at-query', { query = query })
  end
end

-- ---------------------------------------------------------------------------
-- Directory picker: navigable float. Enter descends / selects, <BS> goes up,
-- q/Esc cancel. Selection returns via 'dsh-dir-selected'.
-- ---------------------------------------------------------------------------
M._dirWin = nil
M._dirBuf = nil
M._dirPath = nil
M._dirRows = {}   -- display rows
M._dirIdx = 1

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

local function render_dir_picker()
  local win = M._dirWin
  if not (win and vim.api.nvim_win_is_valid(win)) then return end
  local entries = dir_entries(M._dirPath)
  if entries == nil then
    M.close_dir_picker()
    return
  end
  M._dirRows = entries
  if M._dirIdx > #entries then M._dirIdx = math.max(1, #entries) end
  if #entries == 0 then M._dirIdx = 0 end
  -- Plain buffer: every entry is a real line, so nvim's own scrolling keys
  -- (j/k/G/gg/C-d/C-u) work as expected; the hint lives in the footer bar.
  local rows = { '📁 ' .. M._dirPath .. '/', '' }
  for _, e in ipairs(entries) do
    rows[#rows + 1] = '  ' .. e.name .. (e.dir and '/' or '')
  end
  local cap = math.min(14, math.max(6, vim.o.lines - 8))
  local height = math.min(cap, #rows)

  vim.bo[M._dirBuf].modifiable = true
  vim.api.nvim_buf_set_lines(M._dirBuf, 0, -1, false, rows)
  vim.bo[M._dirBuf].modifiable = false
  if vim.api.nvim_win_get_height(win) ~= height then
    vim.api.nvim_win_set_height(win, height)
    vim.api.nvim_win_set_config(win, {
      relative = 'editor', anchor = 'NW',
      row = centered_row(height), col = centered_col(72),
      width = 72, height = height,
    })
  end
  attach_footer(win, DIR_HINT)
  if M._dirIdx > 0 then
    vim.api.nvim_win_set_cursor(win, { 2 + M._dirIdx, 0 })
  end
end

--- startPath: absolute or relative directory to start in.
function M.show_dir_picker(startPath)
  M.close_dir_picker()
  M._dirPath = vim.fn.fnamemodify(startPath or vim.fn.getcwd(), ':p'):gsub('/$', '')
  if vim.fn.isdirectory(M._dirPath) ~= 1 then
    M._dirPath = vim.fn.getcwd()
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.b[buf].ministatusline_disable = true
  M._dirBuf = buf
  M._dirIdx = 1
  M._dirWin = vim.api.nvim_open_win(buf, true, {
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
  vim.wo[M._dirWin].cursorline = true
  vim.wo[M._dirWin].number = false
  vim.wo[M._dirWin].signcolumn = 'no'
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
  render_dir_picker()
end

function M.dir_move(dir)
  if M._dirIdx == 0 then return end
  M._dirIdx = math.max(1, math.min(#M._dirRows, M._dirIdx + dir))
  render_dir_picker()
end

function M.dir_jump(where)
  if #M._dirRows == 0 then return end
  M._dirIdx = where == 'last' and #M._dirRows or 1
  render_dir_picker()
end

function M.dir_enter()
  -- Derive the index from the cursor so native j/k/G/gg navigation works
  -- (G lands on the hint row → clamp to the last entry).
  local row = vim.api.nvim_win_get_cursor(M._dirWin)[1]
  local idx = math.max(1, math.min(#M._dirRows, row - 2))
  M._dirIdx = idx
  local e = M._dirRows[idx]
  if e == nil then return end
  if e.dir then
    M._dirPath = M._dirPath .. '/' .. e.name
    M._dirIdx = 1
    render_dir_picker()
  else
    local full = M._dirPath .. '/' .. e.name
    M.close_dir_picker()
    if M._channel then
      vim.rpcnotify(M._channel, 'dsh-dir-selected', full)
    end
  end
end

function M.dir_up()
  local parent = M._dirPath:match('^(.*)/[^/]+$')
  if parent == nil or parent == '' then
    M.close_dir_picker()
    return
  end
  M._dirPath = parent
  M._dirIdx = 1
  render_dir_picker()
end

function M.close_dir_picker()
  detach_footer()
  if M._dirWin and vim.api.nvim_win_is_valid(M._dirWin) then
    pcall(vim.api.nvim_win_close, M._dirWin, true)
  end
  M._dirWin = nil
  M._dirBuf = nil
  M._dirPath = nil
  M._dirRows = {}
  M._dirIdx = 1
end

-- ---------------------------------------------------------------------------
-- Generic scrollable info float (workflow view, settings overview, …).
-- ---------------------------------------------------------------------------
--- Generic read-only lines float (workflow / settings / trajectory).
--- Plain buffer: all lines are real lines, so nvim's own scrolling keys
--- (j/k/G/gg/C-d/C-u) work as expected; the hint is the last line and the
--- window height fits the content. `editPath` (optional): map i/o to open
--- that file in a new tab. Without it i/o are Nop'd so a read-only float
--- never answers an edit attempt with a raw E21 error.
function M.show_lines_float(title, lines, editPath)
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
      M.close_lines_float()
    end, { buffer = buf })
    vim.keymap.set('n', 'o', function()
      vim.cmd('tabedit ' .. vim.fn.fnameescape(editPath))
      M.close_lines_float()
    end, { buffer = buf })
  else
    -- Read-only float: an edit attempt must not surface a raw E21.
    vim.keymap.set('n', 'i', '<Nop>', { buffer = buf })
    vim.keymap.set('n', 'o', '<Nop>', { buffer = buf })
  end
  vim.cmd('stopinsert') -- input window hands over in insert mode
  M._linesWin = win
  vim.api.nvim_win_set_cursor(win, { 1, 0 })
  attach_footer(win, hint)
  return { buf = buf, win = win }
end

function M.close_lines_float()
  detach_footer()
  if M._linesWin and vim.api.nvim_win_is_valid(M._linesWin) then
    pcall(vim.api.nvim_win_close, M._linesWin, true)
  end
  M._linesWin = nil
end

-- ---------------------------------------------------------------------------
-- Live progress float (plugin install / update-all / …): the runner streams
-- log lines + a bottom bar row; the window tails the latest lines so a long
-- operation never looks stuck. q/Esc hide it (the operation keeps running).
-- ---------------------------------------------------------------------------
M._progress = { win = nil, buf = nil }

function M.show_progress(title, lines)
  M.close_progress()
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
  M._progress = { win = win, buf = buf }
  return { buf = buf, win = win }
end

--- Replace the visible tail with the newest log lines + the bottom bar row
--- (styled as a statusline). The window height stays put; content tails.
function M.progress_update(lines, bar)
  local st = M._progress
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
  vim.api.nvim_buf_clear_namespace(st.buf, M._ns, 0, -1)
  vim.api.nvim_buf_set_extmark(st.buf, M._ns, #rows - 1, 0, {
    end_row = #rows - 1, end_col = #text, hl_group = 'DshTuiStatus', priority = 4096,
  })
end

function M.close_progress()
  if M._progress.win and vim.api.nvim_win_is_valid(M._progress.win) then
    pcall(vim.api.nvim_win_close, M._progress.win, true)
  end
  M._progress = { win = nil, buf = nil }
end

-- ---------------------------------------------------------------------------
-- Layout presets (no resident session list — sessions live in the /sessions
-- float): default (chat + input) / panel (reasoning panel open).
-- ---------------------------------------------------------------------------
M._layoutName = 'default'

function M.apply_layout(name)
  M.close_lines_float()
  if chat_win == nil or not vim.api.nvim_win_is_valid(chat_win) then
    return
  end
  name = name or 'default'
  if name == 'panel' then
    if not M._reasoningOpen then
      M.toggle_reasoning()
    end
    M._layoutName = 'panel'
  else -- default (alias: full — chat already owns the whole screen)
    if M._reasoningOpen then
      M.toggle_reasoning()
    end
    M._layoutName = 'default'
  end
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
  return M._layoutName
end

--- Terminal bell (turn finished, approvals): BEL on nvim's stdout.
function M.bell()
  local ok = pcall(vim.api.nvim_out_write, '\x07')
  return ok
end

--- Append text to the input line at the cursor (runner: /attach mentions).
function M.append_input(text)
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(input_buf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = lines[cur[1]] or ''
  lines[cur[1]] = line:sub(1, cur[2]) .. text .. line:sub(cur[2] + 1)
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(input_win, { cur[1], cur[2] + #text })
  vim.cmd('startinsert')
  M.resize_input()
end

--- Open a file in a NEW nvim tab (deliverables / settings document) — the TUI
--- layout stays untouched; closing the tab returns to the TUI.
function M.open_file_tab(path)
  local ok = pcall(vim.cmd, 'tabedit ' .. vim.fn.fnameescape(path))
  if not ok then
    if M._channel then
      vim.rpcnotify(M._channel, 'dsh-open-failed', path)
    end
  end
  return ok
end

local function window_options(win)
  for _, opt in ipairs({ 'number', 'relativenumber', 'cursorline' }) do
    vim.api.nvim_win_set_option(win, opt, false)
  end
  vim.api.nvim_win_set_option(win, 'signcolumn', 'no')
  vim.api.nvim_win_set_option(win, 'foldcolumn', '0')
end

--- Build (or rebuild) the input window: the bottom one-row split with the
--- full frame furniture. Factored out of layout() so the WinClosed safety
--- net can restore the input if anything ever closes it (ZZ / :q / plugins).
local function build_input_window()
  M._buildingLayout = true
  vim.cmd('botright 1split')
  M._buildingLayout = false
  input_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(input_win, input_buf)
  window_options(input_win)
  vim.api.nvim_win_set_option(input_win, 'showmode', false)
  -- The input box keeps its exact rows: tabline flashes (bufferline sets
  -- showtabline=2 mid-startup) and startup plugins opening/closing windows
  -- otherwise redistribute a row INTO the input window (the extra blank row
  -- that disappeared on the first keystroke). Fixed height, always.
  vim.wo[input_win].winfixheight = true
  -- Typed text follows the dim palette too — the '❯' prompt (DshTuiPrompt)
  -- keeps its accent and stays the visual anchor.
  vim.wo[input_win].winhl = 'Normal:DshTuiDim'
  -- INPUT FRAME: nvim split windows take no float-style borders, so the
  -- frame is window furniture — winbar = top edge, statuscolumn = left edge,
  -- right-aligned extmarks = right edge (refresh_input_frame), statusline =
  -- bottom edge + hint bar. An empty statusline would render as a
  -- StatusLineNC block (a bright bar in most themes), so the hints start at
  -- the LEFT edge, aligned with the input box.
  M._inputWinbar = '%#DshTuiBorder#╭%{%repeat("─", max([winwidth(0)-2, 0]))%}╮'
  pcall(vim.api.nvim_win_set_option, input_win, 'winbar', M._inputWinbar)
  -- The bottom edge is one continuous line: the statusline's %= gap is
  -- filled with `─` (window-local fillchars, the chat stats bar is
  -- unaffected) so the border runs from the hints all the way to ╯.
  M._inputStatusline = '%#DshTuiBorder#╰─%#DshTuiStatus# Enter 发送 · C-cr 换行 · C-c 停止 · / 命令菜单 · C-o 面板 %#DshTuiBorder#%=─╯'
  vim.api.nvim_win_set_option(input_win, 'statusline', M._inputStatusline)
  M._inputFillchars = 'stl:─,stlnc:─'
  pcall(vim.api.nvim_win_set_option, input_win, 'fillchars', M._inputFillchars)
  -- REPL-style prompt: the '❯' lives in the window's STATUS COLUMN, outside
  -- the editable text — it can never be typed over, deleted, or submitted as
  -- message content. (nvim < 0.9: inline virtual-text fallback.)
  if vim.fn.has('nvim-0.9') == 1 then
    vim.wo[input_win].statuscolumn = '%#DshTuiBorder#│%s%#DshTuiPrompt#❯ '
  else
    vim.api.nvim_buf_set_extmark(input_buf, M._ns, 0, 0, {
      virt_text = { { '❯ ', 'DshTuiPrompt' } },
      virt_text_pos = 'inline',
      hl_mode = 'combine',
    })
  end
  M.resize_input()

  -- No resident session list: /sessions pops a selectable float with full
  -- session ids. The chat gets the whole screen.
end

local function layout()
  M._buildingLayout = true
  -- Main window (right, top): chat.
  chat_win = vim.api.nvim_get_current_win()
  window_options(chat_win)
  M._buildingLayout = false
  build_input_window()

  -- Start typing right away: the prompt buffer puts us in insert mode.
  vim.api.nvim_set_current_win(input_win)
  vim.cmd('startinsert')
  apply_statusline()
end

local function install_keymaps()
  local quit_cmd = '<Cmd>lua require("dsh_tui").quit()<CR>'
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-q>', quit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-q>', quit_cmd, { noremap = true })
  -- ZZ/ZQ would CLOSE the input window in normal mode — the TUI has no
  -- meaning without a prompt; make them inert (quit = <C-q> or /quit).
  vim.api.nvim_buf_set_keymap(input_buf, 'n', 'ZZ', '<Nop>', { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', 'ZQ', '<Nop>', { noremap = true })

  -- Input buffer (insert mode): <CR> submits, <C-CR> inserts a literal
  -- newline (multi-line input), <Up>/<Down> cycle history; <Tab>/<C-n>/
  -- <C-p>/<S-Tab> navigate the slash-command completion menu while it is
  -- open, <Esc> closes it first (a second <Esc> leaves insert mode).
  local submit_cmd = '<Cmd>lua require("dsh_tui").submit()<CR>'
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-CR>', '<CR>', { noremap = true })
  vim.keymap.set('i', '<Up>', function() require('dsh_tui').history_move(-1) end, { buffer = input_buf })
  vim.keymap.set('i', '<Down>', function() require('dsh_tui').history_move(1) end, { buffer = input_buf })
  vim.keymap.set('i', '<C-n>', function()
    if require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_next()
    else
      require('dsh_tui').history_move(1)
    end
  end, { buffer = input_buf })
  vim.keymap.set('i', '<C-p>', function()
    if require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_prev()
    else
      require('dsh_tui').history_move(-1)
    end
  end, { buffer = input_buf })
  vim.keymap.set('i', '<Tab>', function() require('dsh_tui').cmd_next() end, { buffer = input_buf })
  vim.keymap.set('i', '<S-Tab>', function() require('dsh_tui').cmd_prev() end, { buffer = input_buf })
  -- <C-v> queues the macOS clipboard image for the next submit (runner side
  -- reads pbpaste). Text paste (Cmd+V / bracketed paste) is unaffected.
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-v>',
    '<Cmd>lua require("dsh_tui").paste_image()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-v>',
    '<Cmd>lua require("dsh_tui").paste_image()<CR>', { noremap = true })
  -- <C-c> asks the runner to abort the running turn (idle → notice).
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-c>',
    '<Cmd>lua require("dsh_tui").abort_turn()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-c>',
    '<Cmd>lua require("dsh_tui").abort_turn()<CR>', { noremap = true })
  vim.keymap.set('i', '<Esc>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').close_at_menu()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').close_cmd_menu()
    else
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', false)
    end
  end, { buffer = input_buf })

  -- <C-o> toggles the activity panel (overrides jumplist/insert-default
  -- only inside our own buffers).
  local reason_cmd = '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>'
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-o>', reason_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-o>', reason_cmd, { noremap = true })
end

--- Buffer-scoped input autocmds (re-registered whenever the input buffer is
--- rebuilt — its bufhidden=wipe means closing the window destroys it).
local function install_input_autocmds()
  vim.api.nvim_create_autocmd('TextChanged', {
    buffer = input_buf,
    callback = function()
      M.resize_input()
      M.update_cmd_menu()
      if not M.cmd_menu_state().open then M.update_at_menu() end
    end,
  })
  vim.api.nvim_create_autocmd('TextChangedI', {
    buffer = input_buf,
    callback = function()
      M.resize_input()
      M.update_cmd_menu()
      if not M.cmd_menu_state().open then M.update_at_menu() end
    end,
  })
  -- Leaving insert mode (second <Esc>, <C-c>, a float taking focus…) closes
  -- the completion menus; re-entering refreshes them against the input text.
  vim.api.nvim_create_autocmd('InsertLeave', {
    buffer = input_buf,
    callback = function()
      M.close_cmd_menu()
      M.close_at_menu()
    end,
  })
  -- Completion plugins lazy-load (nvim-cmp on InsertEnter); retry the
  -- per-buffer disable at every later opportunity until it sticks.
  vim.api.nvim_create_autocmd('User', {
    pattern = 'VeryLazy',
    once = true,
    callback = function() M.disable_external_completion() end,
  })
  vim.api.nvim_create_autocmd('InsertEnter', {
    buffer = input_buf,
    callback = function()
      vim.defer_fn(function()
        M.disable_external_completion()
        M.update_cmd_menu()
      end, 50)
    end,
  })
  -- Keep the frame's right edge in sync with the input rows (typing, undo,
  -- paste, history) — clearing and re-adding a handful of extmarks.
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
    buffer = input_buf,
    callback = function() M.refresh_input_frame() end,
  })
end

local function install_autocmds()
  -- Window navigation preserves the mode: <C-w>↑/<C-w>↓ into the input no
  -- longer yanks it back to insert (an explicit user choice — the input
  -- CAN stay in normal mode). Every flow that NEEDS insert mode starts it
  -- itself (submit, popup close, fill_input…).
  -- BUT insert mode drags along a focus switch (clicking the chat while the
  -- input is in insert makes the chat insert WITHOUT firing InsertEnter) —
  -- display splits snap straight back to normal.
  vim.api.nvim_create_autocmd('WinEnter', {
    callback = function()
      local w = vim.api.nvim_get_current_win()
      if input_win and w == input_win then return end
      local ok, cfg = pcall(vim.api.nvim_win_get_config, w)
      if ok and cfg.relative ~= '' and cfg.relative ~= nil then return end -- floats
      if vim.bo[vim.api.nvim_win_get_buf(w)].buftype ~= 'nofile' then return end
      if vim.api.nvim_get_mode().mode ~= 'i' then return end
      -- Insert state dragged onto a display split (mouse click while typing):
      -- snap the split back to normal, and restore the INPUT's insert if
      -- that is where it was — the click must not strand typing mid-flow.
      local inputWasInsert = false
      if input_win and vim.api.nvim_win_is_valid(input_win) then
        inputWasInsert = vim.api.nvim_win_call(input_win, function()
          return vim.api.nvim_get_mode().mode
        end) == 'i'
      end
      vim.schedule(function()
        if vim.api.nvim_get_mode().mode == 'i'
          and (input_win == nil or vim.api.nvim_get_current_win() ~= input_win) then
          vim.api.nvim_input('<Esc>')
        end
        if inputWasInsert and input_win and vim.api.nvim_win_is_valid(input_win) then
          local saved = vim.api.nvim_get_current_win()
          if saved ~= input_win then
            vim.api.nvim_set_current_win(input_win)
            -- 'x' executes the key NOW (queued keys would hit the window
            -- that has focus by processing time).
            pcall(vim.api.nvim_feedkeys, 'i', 'nx', false)
            vim.api.nvim_set_current_win(saved)
          end
        end
      end)
    end,
  })
  -- Safety net 1: if the input window ever gets closed (ZZ / :q / plugins),
  -- rebuild it on the next tick — the TUI has no meaning without a prompt.
  vim.api.nvim_create_autocmd('WinClosed', {
    callback = function()
      local closed = tonumber(vim.fn.expand('<afile>'))
      if closed ~= input_win then return end
      vim.schedule(function()
        pcall(function()
          if M._buildingLayout or M._quitting then return end
          if input_win and vim.api.nvim_win_is_valid(input_win) then return end
          if not (chat_win and vim.api.nvim_win_is_valid(chat_win)) then return end
          if not (input_buf and vim.api.nvim_buf_is_valid(input_buf)) then return end
          -- bufhidden=hide: the buffer (typed draft included) survives —
          -- just rebuild the window around it. Buffer keymaps/autocmds are
          -- still attached.
          vim.api.nvim_set_current_win(chat_win)
          build_input_window()
          apply_statusline()
          -- Enter insert on a LATER tick via a real keypress: `:startinsert`
          -- silently no-ops right after a window close (nvim's insert-mode
          -- machinery is still settling), but the i key always works.
          vim.schedule(function()
            if input_win and vim.api.nvim_win_is_valid(input_win) then
              vim.api.nvim_set_current_win(input_win)
              vim.api.nvim_input('i')
            end
          end)
        end)
      end)
    end,
  })
  -- Safety net 2: never allow a CLONE of the input buffer — :sp / :vsp from
  -- the input window would open synced look-alikes (content mirrors the
  -- real one); close any new non-float window that shows the input buffer.
  -- Splits of OTHER buffers (chat browsing) stay allowed.
  vim.api.nvim_create_autocmd('WinNew', {
    callback = function()
      vim.schedule(function()
        if M._buildingLayout then return end
        if not (input_win and vim.api.nvim_win_is_valid(input_win)) then return end
        if not (input_buf and vim.api.nvim_buf_is_valid(input_buf)) then return end
        local w = vim.api.nvim_get_current_win()
        if w == input_win then return end
        local ok, cfg = pcall(vim.api.nvim_win_get_config, w)
        if ok and cfg.relative ~= '' and cfg.relative ~= nil then return end
        if vim.api.nvim_win_get_buf(w) == input_buf then
          pcall(vim.api.nvim_win_close, w, true)
        end
      end)
    end,
  })
  install_input_autocmds()
  -- The input window's winbar IS the frame's top edge: any plugin that sets
  -- `winbar` (its own or ours) gets snapped back to the TUI's on the input
  -- window. (The --cmd OptionSet guard deliberately does NOT blank winbar —
  -- `:set winbar=` would erase this very frame edge.)
  vim.api.nvim_create_autocmd('OptionSet', {
    pattern = 'winbar',
    callback = function()
      if M._inputWinbar ~= nil then
        vim.schedule(function()
          pcall(function() vim.wo[input_win].winbar = M._inputWinbar end)
        end)
      end
    end,
  })
  vim.api.nvim_create_autocmd({ 'WinEnter', 'BufEnter', 'TabEnter', 'VimEnter', 'ModeChanged' }, {
    callback = function()
      -- User configs / lazy plugins keep flipping showtabline back to 2:
      -- re-assert the TUI's no-tabline stance on every window event.
      -- ModeChanged included: statusline plugins (mini.statusline et al.)
      -- rewrite the options the moment the mode flips (pressing i in the
      -- input used to wipe the frame + hint bar).
      if vim.o.showtabline ~= 0 then vim.o.showtabline = 0 end
      -- Same for the mouse: lazy plugins (VeryLazy) re-enable mouse=a after
      -- start(); the TUI is keyboard-first — keep it off.
      if vim.o.mouse ~= '' then vim.o.mouse = '' end
      -- Plugins like mini.statusline keep rewriting our windows' statuslines
      -- (rendering the startup buffer name): re-assert the TUI's own — blank
      -- chat line until the runner pushes the real one, helper bar on input.
      pcall(function() vim.wo[chat_win].statusline = M._statuslineText or '' end)
      pcall(function() vim.wo[input_win].statusline = M._inputStatusline end)
      pcall(function() vim.wo[input_win].fillchars = M._inputFillchars end)
      if M._inputWinbar ~= nil then
        pcall(function() vim.wo[input_win].winbar = M._inputWinbar end)
      end
      M.reschedule_statusline()
    end,
  })
  -- Terminal resize: the panel float is editor-relative — re-anchor it to
  -- the new right edge / height.
  vim.api.nvim_create_autocmd('VimResized', {
    callback = function()
      if M._reasoningWin and vim.api.nvim_win_is_valid(M._reasoningWin) then
        local cfg = M.reasoning_panel_geometry()
        cfg.border = 'rounded'
        cfg.style = 'minimal'
        pcall(vim.api.nvim_win_set_config, M._reasoningWin, cfg)
      end
    end,
  })
  -- A colorscheme (re)applied after start() — lazy setups, mid-session
  -- switches — must not wash the highlights back to pure white.
  vim.api.nvim_create_autocmd('ColorScheme', {
    callback = function() M.applyHighlights() end,
  })
  vim.defer_fn(function() M.disable_external_completion() end, 300)
  vim.defer_fn(function() M.disable_external_completion() end, 1200)
end

--- Claim the UI: drop windows/buffers opened by the user's config or a
--- dashboard plugin, then rebuild our layout.
local function takeover()
  if M._reasoningWin and vim.api.nvim_win_is_valid(M._reasoningWin) then
    pcall(vim.api.nvim_win_close, M._reasoningWin, true)
  end
  pcall(vim.cmd, 'silent! only')
  M._reasoningWin = nil
  M._reasoningOpen = false
  -- Swap the current window to a fresh unnamed nofile buffer, THEN wipe every
  -- listed buffer — the startup scratch-file buffer included. Otherwise the
  -- file name keeps rendering in window statuslines (mini.statusline et al.)
  -- until the runner attaches: the startup "label flash".
  local fresh = vim.api.nvim_create_buf(false, true)
  vim.bo[fresh].buftype = 'nofile'
  vim.bo[fresh].bufhidden = 'wipe'
  pcall(vim.api.nvim_win_set_buf, 0, fresh)
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if b ~= fresh and vim.bo[b].buflisted then
      pcall(vim.api.nvim_buf_delete, b, { force = true })
    end
  end
end

--- ALL DshTui* highlight definitions (role links + dim palette) in one
--- re-appliable function. Lazy plugin managers can apply the user's
--- colorscheme AFTER our VimEnter mount — its `hi clear` wipes every custom
--- group and the whole TUI falls back to plain white. We re-apply on
--- ColorScheme and on deferred timers so the palette survives any ordering.
function M.applyHighlights()
  -- Role/span highlight groups; `default link` adapts to the user's colorscheme.
  vim.cmd('highlight default link DshTuiActiveSession Title')
  vim.cmd('highlight default link DshTuiNotice Comment')
  vim.cmd('highlight default link DshTuiUser MoreMsg')
  vim.cmd('highlight default link DshTuiAssistant Comment') -- harness output: dimmer than Normal
  vim.cmd('highlight default link DshTuiDivider Comment')
  vim.cmd('highlight default link DshTuiError ErrorMsg')
  vim.cmd('highlight default link DshTuiTool Special')
  vim.cmd('highlight default link DshTuiSubagent Type')
  vim.cmd('highlight default link DshTuiWorkflow Identifier')
  vim.cmd('highlight default link DshTuiCode Special')
  -- The popup bottom hint rows borrow the statusline look: floating windows
  -- get no real statusline, so the hint row is styled like one.
  vim.cmd('highlight default link DshTuiStatus StatusLine')
  -- Embedded popup footers (hints in the bottom border, nvim >= 0.10) keep
  -- the same statusline look instead of the default dim border color.
  vim.cmd('highlight default link FloatFooter DshTuiStatus')
  -- The input frame (winbar / statuscolumn / right-edge marks / statusline).
  vim.cmd('highlight default link DshTuiBorder WinSeparator')
  -- File-change diff blocks (✎ header + +/− lines): GitHub-style add/del
  -- foregrounds; the row FILLS (theme-blended backgrounds) are applied in
  -- applyDimPalette so they adapt to the colorscheme's editor background.
  vim.cmd('highlight default DshTuiDiffAdd guifg=#3fb950 guibg=#16301e ctermfg=71 ctermbg=22')
  vim.cmd('highlight default DshTuiDiffDel guifg=#f85149 guibg=#3a1d1b ctermfg=203 ctermbg=52')
  -- Blue whale pixel art (chat wallpaper/watermark): one group per
  -- half-block color pair (fg=top pixel, bg=bottom pixel) — brand blue
  -- #4d6bfe body, near-white belly, dark eye, blush.
  vim.cmd('highlight default DshTuiWhale-B guifg=NONE guibg=#4d6bfe ctermfg=NONE ctermbg=63')
  vim.cmd('highlight default DshTuiWhaleB- guifg=#4d6bfe guibg=NONE ctermfg=63 ctermbg=NONE')
  vim.cmd('highlight default DshTuiWhaleBB guifg=#4d6bfe guibg=#4d6bfe ctermfg=63 ctermbg=63')
  vim.cmd('highlight default DshTuiWhaleBW guifg=#4d6bfe guibg=#f2f5fa ctermfg=63 ctermbg=255')
  vim.cmd('highlight default DshTuiWhaleEE guifg=#14204a guibg=#14204a ctermfg=17 ctermbg=17')
  vim.cmd('highlight default DshTuiWhalePP guifg=#f5a8b8 guibg=#f5a8b8 ctermfg=217 ctermbg=217')
  vim.cmd('highlight default DshTuiWhaleW- guifg=#f2f5fa guibg=NONE ctermfg=255 ctermbg=NONE')
  vim.cmd('highlight default DshTuiWhaleWB guifg=#f2f5fa guibg=#4d6bfe ctermfg=255 ctermbg=63')
  vim.cmd('highlight default DshTuiWhaleWW guifg=#f2f5fa guibg=#f2f5fa ctermfg=255 ctermbg=255')
  vim.cmd('highlight default link DshTuiBold Bold')
  vim.cmd('highlight default link DshTuiPrompt DshTuiUser') -- input-line '❯'
  -- Slash-command completion menu: the selection reuses the pum look.
  vim.cmd('highlight default link DshTuiCmdName MoreMsg')
  vim.cmd('highlight default link DshTuiCmdDesc Comment')
  vim.cmd('highlight default link DshTuiCmdSel PmenuSel')
  vim.cmd('highlight default link DshTuiCmdSelName PmenuSel')
  vim.cmd('highlight default link DshTuiCmdSelDesc PmenuSel')
  -- Markdown structure: headings stand out, quotes dim italic, links underline.
  vim.cmd('highlight default link DshTuiHeading Title')
  vim.cmd('highlight default DshTuiQuote gui=italic cterm=italic')
  vim.cmd('highlight default link DshTuiQuote Comment')
  vim.cmd('highlight default DshTuiLink gui=underline cterm=underline')
  M.applyDimPalette()
end

--- The TUI's palette: statusline fills + explicit dim foregrounds for plain
--- content (assistant output, thinking text, notices, dividers, list windows,
--- menu descriptions, typed input). The plain content FOLLOWS the theme's
--- Comment (the pre-regression look — molokai's tinted dim gray, not a flat
--- blend); only when the theme's Comment is bright or missing do we fall back
--- to blending Normal toward its background, so a white-Comment theme can
--- never glare again.
--- Re-applied on ColorScheme so late/lazy colorscheme applications (or a
--- mid-session switch) cannot wash the dims back to pure white.
function M.applyDimPalette()
  local normal_hl = vim.api.nvim_get_hl(0, { name = 'Normal' })
  local status_hl = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
  local comment_hl = vim.api.nvim_get_hl(0, { name = 'Comment' })
  local function blend24(c1, c2, t)
    if type(c1) ~= 'number' or type(c2) ~= 'number' then return c1 end
    local function ch(c, s)
      return math.floor((c / 2 ^ s) % 256)
    end
    local r = math.floor(ch(c1, 16) + (ch(c2, 16) - ch(c1, 16)) * t + 0.5)
    local g = math.floor(ch(c1, 8) + (ch(c2, 8) - ch(c1, 8)) * t + 0.5)
    local b = math.floor(ch(c1, 0) + (ch(c2, 0) - ch(c1, 0)) * t + 0.5)
    return r * 65536 + g * 256 + b
  end
  -- nvim_get_hl returns colors as 24-bit numbers OR hex strings depending on
  -- how the colorscheme declared them — normalize so blends never bail out
  -- on a string color and silently fall back to the bright theme color.
  local function color24(c)
    if type(c) == 'number' then return c end
    if type(c) == 'string' then
      local r, g, b = c:match('^#(%x%x)(%x%x)(%x%x)$')
      if r then
        return tonumber(r, 16) * 65536 + tonumber(g, 16) * 256 + tonumber(b, 16)
      end
    end
    return nil
  end
  local function luma(c)
    return (math.floor(c / 65536) % 256) * 0.299
      + (math.floor(c / 256) % 256) * 0.587
      + (c % 256) * 0.114
  end
  local status_fg = color24(status_hl.fg)
  local normal_fg = color24(normal_hl.fg)
  local normal_bg = color24(normal_hl.bg) or 0x1e1e1e
  local comment_fg = color24(comment_hl.fg)
  -- nil → keep the theme's Comment link; a number → blend fallback (used
  -- only when the theme's Comment is missing or brighter than Normal text).
  local plain_fg = nil
  if type(normal_fg) == 'number' then
    if type(comment_fg) ~= 'number' or luma(comment_fg) > luma(normal_fg) then
      plain_fg = blend24(normal_fg, normal_bg, 0.55)
    end
  end
  -- The statusline ROW FILL uses StatusLine (active) / StatusLineNC
  -- (inactive) — bright in many themes (the white-bar illusion). This nvim
  -- instance IS the TUI, so both groups get the editor background here.
  vim.api.nvim_set_hl(0, 'StatusLine', { fg = status_fg or 0xa8a8a8, bg = normal_bg })
  vim.api.nvim_set_hl(0, 'StatusLineNC', { fg = status_fg or 0x8a8a8a, bg = normal_bg })
  vim.api.nvim_set_hl(0, 'DshTuiStatus', {
    fg = (status_fg and normal_fg and blend24(status_fg, normal_fg, 0.45)) or 0xc8c8c8,
    bg = normal_bg,
    bold = true,
  })
  -- The frame around the input box: dim neutral on the editor background so
  -- the border reads as a frame, never as a bright bar, and the '❯' accent
  -- still pops. Theme-adaptive: blends Normal toward its background.
  local border_fg = nil
  if normal_fg then border_fg = blend24(normal_fg, normal_bg, 0.45) end
  if border_fg == nil and status_fg then border_fg = blend24(status_fg, normal_bg, 0.6) end
  vim.api.nvim_set_hl(0, 'DshTuiBorder', { fg = border_fg or 0x8a8a8a, bg = normal_bg })
  -- Popup surfaces: the float background (which the rounded borders and
  -- their corner areas render on) follows the EDITOR background — many
  -- themes shade NormalFloat darker than Normal, which makes every popup
  -- border look like a dark frame floating on the chat. Flat, unobtrusive.
  vim.api.nvim_set_hl(0, 'NormalFloat', { bg = normal_bg })
  local floatBorderHl = vim.api.nvim_get_hl(0, { name = 'FloatBorder', link = false })
  vim.api.nvim_set_hl(0, 'FloatBorder', {
    fg = floatBorderHl.fg,
    bg = normal_bg,
  })
  -- Diff row colors FOLLOW THE THEME: read the colorscheme's own DiffAdd /
  -- DiffDelete (the user's normal diff look) so switching themes re-tints
  -- the +/− rows too. Only when the theme leaves a background empty do we
  -- blend the foreground into the editor bg (Claude-style filled rows on
  -- ANY theme). Token syntax marks (priority 4097) keep their fg and fall
  -- through to this row fill for their background.
  local diffAddHl = vim.api.nvim_get_hl(0, { name = 'DiffAdd', link = false })
  local diffDelHl = vim.api.nvim_get_hl(0, { name = 'DiffDelete', link = false })
  local function diffRow(theme, fallbackFg, ratio)
    local fg = color24(theme.fg) or fallbackFg
    local bg = color24(theme.bg)
    if bg == nil then
      bg = blend24(normal_bg, fg, ratio)
    end
    return { fg = fg, bg = bg }
  end
  vim.api.nvim_set_hl(0, 'DshTuiDiffAdd', diffRow(diffAddHl, 0x3fb950, 0.20))
  vim.api.nvim_set_hl(0, 'DshTuiDiffDel', diffRow(diffDelHl, 0xf85149, 0.18))
  local function setDimGroup(group, ratio)
    if plain_fg == nil then
      vim.cmd('highlight default link ' .. group .. ' Comment')
    else
      vim.api.nvim_set_hl(0, group,
        { fg = ratio == 0.55 and plain_fg or blend24(normal_fg, normal_bg, ratio) })
    end
  end
  setDimGroup('DshTuiAssistant', 0.55) -- chat plain text (the bulk of content)
  setDimGroup('DshTuiReasoning', 0.50) -- thinking text / panel body
  setDimGroup('DshTuiNotice', 0.65) -- runner notices ('· …')
  setDimGroup('DshTuiDivider', 0.72) -- '── turn ──' separators
  setDimGroup('DshTuiCmdDesc', 0.65) -- completion-menu descriptions
  setDimGroup('DshTuiDim', 0.60) -- unhighlighted text in list windows
end

--- Entry: runs at VimEnter (after the user's config/plugins loaded).
function M.start()
  if M._started then
    return -- idempotent (e.g. reloaded in dev)
  end
  M._started = true
  -- This nvim instance is the dsh TUI: statusline plugins must not manage
  -- ANY window here (they rewrite the option on every WinEnter). The user's
  -- normal nvim sessions are unaffected.
  vim.g.ministatusline_disable = true
  -- Terminal title: nvim owns the terminal, so it must emit the OSC 2 title
  -- itself (the runner pushes the content via set_title).
  vim.o.title = true
  vim.o.titlestring = 'dsh'
  -- The cmdline row is dead space here (notices render in the chat) — reclaim
  -- it so the input hint bar is the very last screen row (nvim 0.9+).
  if vim.fn.has('nvim-0.9') == 1 then
    vim.o.cmdheight = 0
  end
  -- No tabline chrome in the TUI at all: the chat never renders a stray
  -- [No Name] label, and file tabs (open_file_tab) stay reachable via gt/gT.
  vim.o.showtabline = 0
  -- Mouse OFF in the TUI: nvim's insert mode follows the focus, so a mouse
  -- click into a popup while the input is typing drags insert into the
  -- popup. Window navigation is <C-w>/keyboard-first anyway — disabling the
  -- mouse removes the whole failure class at the source.
  vim.o.mouse = ''
  M.applyHighlights()
  takeover()
  make_input_buffer()
  layout()
  install_keymaps()
  install_autocmds()

  -- Startup flash guard: plugins drawing right after VimEnter (alpha
  -- dashboard, filetree, …) open a window in our freshly built layout. Close
  -- any NON-floating window that is not part of the TUI in the SAME event
  -- cycle, so their UI never gets a frame. Active for a few seconds only.
  M._bootGuardUntil = vim.uv.now() + 3000
  vim.api.nvim_create_autocmd({ 'WinNew', 'BufWinEnter' }, {
    callback = function()
      -- Deferred: during WinNew the float's config is not applied yet, so a
      -- same-cycle check would misread our own floats as normal windows and
      -- close them. By the scheduled tick the config is final.
      vim.schedule(function()
        if M._bootGuardUntil == nil or vim.uv.now() > M._bootGuardUntil then return end
        local w = vim.api.nvim_get_current_win()
        local ok, cfg = pcall(vim.api.nvim_win_get_config, w)
        local isFloat = ok and cfg.relative ~= '' and cfg.relative ~= nil
        if not isFloat and w ~= chat_win and w ~= input_win then
          pcall(vim.api.nvim_win_close, w, true)
        end
        local b = vim.api.nvim_get_current_buf()
        if b ~= chat_buf and b ~= input_buf and vim.bo[b].buflisted then
          pcall(vim.api.nvim_buf_delete, b, { force = true })
        end
      end)
    end,
  })
  -- Some plugins open windows asynchronously after VimEnter (dashboards…).
  -- Re-claim the layout if one of our windows got replaced.
  local function reclaim()
    if not (chat_win and vim.api.nvim_win_is_valid(chat_win)
      and input_win and vim.api.nvim_win_is_valid(input_win)) then
      takeover()
      layout()
    end
  end
  vim.defer_fn(reclaim, 300)
  vim.defer_fn(reclaim, 1200)
  -- Belt-and-braces: lazy plugins can `hi clear` late without a ColorScheme
  -- event — re-assert the whole highlight set after the dust settles.
  vim.defer_fn(function() M.applyHighlights() end, 300)
  vim.defer_fn(function() M.applyHighlights() end, 1200)
end

--- Called by the Node runner once it has connected and knows its channel id.
function M.attach(channel_id)
  M._channel = channel_id
end

--- Create (or return) the chat buffer for one session.
--- Returns { chatBuf, chatWin } — chatWin is the shared chat window.
function M.ensure_chat(id)
  local buf = M._chats[id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    chat_buffer_options(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '…' })
    -- <C-o> toggles the reasoning panel from the chat buffer too.
    vim.api.nvim_buf_set_keymap(buf, 'n', '<C-o>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    lock_display_keys(buf) -- chat output is display-only (renderer writes via API)
    vim.api.nvim_buf_set_name(buf, 'dsh-chat-' .. tostring(id))
    M._chats[id] = buf
  end
  return { chatBuf = buf, chatWin = chat_win }
end

--- Create (or return) the reasoning (thinking) buffer for one session.
--- Returns { reasoningBuf, reasoningWin, reasoningOpen }.
function M.ensure_reasoning(id)
  local buf = M._reasoningBufs[id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    chat_buffer_options(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '·· 思考与工具记录（<C-o> 收起）' })
    vim.api.nvim_buf_set_keymap(buf, 'n', '<C-o>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    vim.api.nvim_buf_set_keymap(buf, 'n', 'q',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    vim.api.nvim_buf_set_keymap(buf, 'n', '<Esc>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    lock_display_keys(buf) -- reasoning panel is display-only
    vim.api.nvim_buf_set_name(buf, 'dsh-reasoning-' .. tostring(id))
    M._reasoningBufs[id] = buf
  end
  return {
    reasoningBuf = buf,
    reasoningWin = M._reasoningWin,
    reasoningOpen = M._reasoningOpen,
  }
end

--- Reasoning panel float geometry: hugs the RIGHT screen edge, spanning
--- three quarters of the screen height (a panel, not a full-height column —
--- it may overlay the input area only when multi-line input grows tall).
--- The chat keeps its full width (the panel overlays its right side, like
--- the other popups).
function M.reasoning_panel_geometry()
  local width = math.max(30, math.min(52, math.floor(vim.o.columns * 0.45)))
  local height = math.max(3, math.floor(vim.o.lines * 0.75))
  local cfg = {
    relative = 'editor',
    anchor = 'NE',
    row = 0,
    col = vim.o.columns - 1,
    width = width,
    height = height,
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 思考与工具记录 '
    cfg.title_pos = 'center'
  end
  -- Bottom operation hints embedded in the border (like the popups).
  if vim.fn.has('nvim-0.10') == 1 then
    cfg.footer = ' C-o 收起面板 · q 关闭 '
    cfg.footer_pos = 'left'
  end
  return cfg
end

--- Open/close the reasoning panel (a popup hugging the right edge). <C-o>.
function M.toggle_reasoning()
  if M._reasoningWin and vim.api.nvim_win_is_valid(M._reasoningWin) then
    pcall(vim.api.nvim_win_close, M._reasoningWin, true)
    M._reasoningWin = nil
    M._reasoningOpen = false
  else
    local buf = M._activeId and M._reasoningBufs[M._activeId]
    if not (buf and vim.api.nvim_buf_is_valid(buf)) then
      buf = vim.api.nvim_create_buf(false, true)
      chat_buffer_options(buf)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '·· 思考与工具记录（<C-o> 收起）' })
    end
    local cfg = M.reasoning_panel_geometry()
    cfg.border = 'rounded'
    cfg.style = 'minimal'
    cfg.zindex = 30 -- above the chat, below menus/approvals
    M._reasoningWin = vim.api.nvim_open_win(buf, false, cfg)
    vim.wo[M._reasoningWin].number = false
    vim.wo[M._reasoningWin].signcolumn = 'no'
    vim.wo[M._reasoningWin].cursorline = false
    M._reasoningOpen = true
    -- Focus back on typing.
    if input_win and vim.api.nvim_win_is_valid(input_win) then
      vim.api.nvim_set_current_win(input_win)
      vim.cmd('startinsert')
    end
  end
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-reasoning-toggled', M._reasoningOpen)
  end
  return M._reasoningOpen
end

--- Session list float (/sessions): entries { {id, title, active, kind} } with
--- FULL session ids. j/k move, <CR> selects (dsh-session-selected), <C-n> asks
--- for a new session, q/Esc close.
M._sessWin = nil
M._sessBuf = nil
M._sessEntries = {}
M._sessIdx = 1

function M.show_session_list(entries)
  M.close_session_list()
  M._sessEntries = entries or {}
  local n = #M._sessEntries
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.b[buf].ministatusline_disable = true
  M._sessBuf = buf
  local idx = 1
  for i, e in ipairs(M._sessEntries) do
    if e.active then idx = i end
  end
  M._sessIdx = idx
  -- Window exactly fits the content: '' + entries; the hint lives in the
  -- footer bar below the window.
  local cap = math.min(16, math.max(5, vim.o.lines - 6))
  local height = n == 0 and 1 or math.min(cap, n + 1)
  M._sessWin = vim.api.nvim_open_win(buf, true, {
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
  vim.wo[M._sessWin].cursorline = true
  vim.wo[M._sessWin].number = false
  vim.wo[M._sessWin].signcolumn = 'no'
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
  M.render_session_list()
end

function M.render_session_list()
  local buf = M._sessBuf
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local entries = M._sessEntries
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
  attach_footer(M._sessWin, n == 0 and '[C-n] 新建会话  [Esc] 关闭'
    or '[j/k] 移动  [Enter] 切换  [C-n] 新建  [Esc] 关闭')
  if M._sessWin and vim.api.nvim_win_is_valid(M._sessWin) and n > 0 then
    vim.api.nvim_win_set_cursor(M._sessWin, { 1 + M._sessIdx, 0 })
  end
end

function M.session_list_move(dir)
  if #M._sessEntries == 0 then return end
  M._sessIdx = math.max(1, math.min(#M._sessEntries, M._sessIdx + dir))
  M.render_session_list()
end

function M.session_list_jump(where)
  if #M._sessEntries == 0 then return end
  M._sessIdx = where == 'last' and #M._sessEntries or 1
  M.render_session_list()
end

function M.session_list_select()
  -- Derive the index from the cursor so native j/k/G/gg navigation works
  -- (G lands on the hint row → clamp to the last entry).
  local row = vim.api.nvim_win_get_cursor(M._sessWin)[1]
  local idx = math.max(1, math.min(#M._sessEntries, row - 1))
  M._sessIdx = idx
  local e = M._sessEntries[idx]
  M.close_session_list()
  if e and M._channel then
    vim.rpcnotify(M._channel, 'dsh-session-select', e.id)
  end
end

function M.session_list_new()
  M.close_session_list()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-session-new')
  end
end

function M.close_session_list()
  detach_footer()
  if M._sessWin and vim.api.nvim_win_is_valid(M._sessWin) then
    pcall(vim.api.nvim_win_close, M._sessWin, true)
  end
  M._sessWin = nil
  M._sessBuf = nil
  M._sessEntries = {}
  M._sessIdx = 1
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

--- Switch the visible chat to this session (the runner owns the entry list).
function M.set_active(id)
  M._activeId = id
  local buf = M._chats[id]
  if buf and vim.api.nvim_buf_is_valid(buf) and chat_win and vim.api.nvim_win_is_valid(chat_win) then
    vim.api.nvim_win_set_buf(chat_win, buf)
  end
  -- Keep the reasoning panel on this session's thinking buffer.
  if M._reasoningWin and vim.api.nvim_win_is_valid(M._reasoningWin) then
    local rbuf = M._reasoningBufs[id]
    if rbuf and vim.api.nvim_buf_is_valid(rbuf) then
      vim.api.nvim_win_set_buf(M._reasoningWin, rbuf)
    end
  end
  -- A session-list float tracking the old session is now stale: close it.
  M.close_session_list()
end

--- Buffer/window ids for the runner's renderer.
function M.ids()
  local chatBuf = M._activeId and M._chats[M._activeId] or nil
  return {
    chatBuf = chatBuf,
    chatWin = chat_win,
    inputBuf = input_buf,
    inputWin = input_win,
    reasoningWin = M._reasoningWin,
    reasoningOpen = M._reasoningOpen,
  }
end

--- Ask the runner to shut down (dispose agents + exit dsh).
function M.quit()
  M._quitting = true
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-quit')
  else
    vim.cmd('qa!')
  end
end

--- Apply theme overrides: map of highlight group -> attributes.
--- Each entry: { fg=, bg=, bold=, italic=, underline= } or { link = 'Group' }.
function M.apply_theme(theme)
  if type(theme) ~= 'table' then
    return
  end
  for group, attrs in pairs(theme) do
    if type(group) == 'string' and type(attrs) == 'table' then
      if type(attrs.link) == 'string' then
        pcall(vim.api.nvim_set_hl, 0, group, { link = attrs.link })
      else
        local spec = {}
        if type(attrs.fg) == 'string' then spec.fg = attrs.fg end
        if type(attrs.bg) == 'string' then spec.bg = attrs.bg end
        if type(attrs.bold) == 'boolean' then spec.bold = attrs.bold end
        if type(attrs.italic) == 'boolean' then spec.italic = attrs.italic end
        if type(attrs.underline) == 'boolean' then spec.underline = attrs.underline end
        if next(spec) ~= nil then
          pcall(vim.api.nvim_set_hl, 0, group, spec)
        end
      end
    end
  end
end

--- Accessor for tests.
function M.channel()
  return M._channel
end

-- ===========================================================================
-- Floating interaction windows (approval / questions / picker)
-- ===========================================================================

M._float = { win = nil, buf = nil, kind = nil, state = nil }

local function close_float()
  detach_footer()
  if M._float.win and vim.api.nvim_win_is_valid(M._float.win) then
    pcall(vim.api.nvim_win_close, M._float.win, true)
  end
  M._float = { win = nil, buf = nil, kind = nil, state = nil }
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

-- Rows a line occupies in a float of `width` cells (CJK glyphs count 2
-- cells; an empty line still takes one row). Floats do not auto-grow, so the
-- window height must be computed from the WRAPPED layout — sizing by the raw
-- line count clipped the bottom rows (the key hints) whenever a tool reason
-- or option description wrapped.
local function line_rows(line, width)
  return math.max(1, math.ceil(vim.fn.strdisplaywidth(line) / width))
end

-- Total visual height of `lines` wrapped at `width`, clamped to a sane
-- window size and to the editor, so the float always fits on screen.
local function float_height(lines, width)
  local h = 0
  for _, l in ipairs(lines) do
    h = h + line_rows(l, width)
  end
  local cap = math.min(24, math.max(3, vim.o.lines - 2))
  return math.max(3, math.min(cap, h))
end

local function open_float(lines, opts)
  close_float()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  local width = math.max(40, math.min(opts.maxWidth or 100, opts.width or 64))
  local height = float_height(lines, width)
  local cfg = {
    relative = 'editor',
    row = centered_row(height),
    col = centered_col(width),
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
  lock_popup_buffer(buf) -- read-only: i/x/dd must not edit or raise E21
  M._float.win = win
  M._float.buf = buf
  return buf, win
end

local function float_key(buf, key, cmd)
  vim.api.nvim_buf_set_keymap(buf, 'n', key, '<Cmd>lua ' .. cmd .. '<CR>', { noremap = true })
end

--- Approval request (from approval/request). entry: {toolName, reason}.
function M.show_approval(entry)
  local lines = {
    '工具: ' .. tostring(entry.toolName or '?'),
    '说明: ' .. tostring(entry.reason or '无'),
    '',
  }
  local buf = open_float(lines, { width = 72, title = '⚠ 审批请求' })
  M._float.kind = 'approval'
  attach_footer(M._float.win, '[y] 允许一次  [a] 总是（自动模式）  [n] 拒绝  [Esc] 拒绝')
  float_key(buf, 'y', 'require("dsh_tui").approval_decide("y")')
  float_key(buf, 'a', 'require("dsh_tui").approval_decide("always")')
  float_key(buf, 'n', 'require("dsh_tui").approval_decide("n")')
  float_key(buf, '<Esc>', 'require("dsh_tui").approval_decide("n")')
end

function M.approval_decide(value)
  if M._float.kind ~= 'approval' then
    return
  end
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-approval-decided', value)
  end
end

--- User questions. questions: { {id, question, detail, header, options: {{label, description}}, multiSelect} }.
function M.show_questions(questions)
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
  open_float({ '…' }, { width = 80, title = '用户提问' })
  M._float.kind = 'questions'
  M._float.state = { questions = qs, qIdx = 1, optIdx = 1, selected = {}, optRows = {} }
  M.redraw_questions()
  local function install()
    local buf = M._float.buf
    if not buf then
      return
    end
    float_key(buf, 'j', 'require("dsh_tui").question_move(1)')
    float_key(buf, 'k', 'require("dsh_tui").question_move(-1)')
    float_key(buf, '<Space>', 'require("dsh_tui").question_toggle()')
    float_key(buf, '<CR>', 'require("dsh_tui").question_advance()')
    float_key(buf, '<Esc>', 'require("dsh_tui").questions_cancel()')
  end
  install()
end

function M.redraw_questions()
  local st = M._float.state
  if not st or M._float.kind ~= 'questions' then
    return
  end
  local q = st.questions[st.qIdx]
  if not q then
    M.questions_confirm()
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

  vim.bo[M._float.buf].modifiable = true -- popup buffers are locked otherwise
  vim.api.nvim_buf_set_lines(M._float.buf, 0, -1, false, lines)
  vim.bo[M._float.buf].modifiable = false
  -- The float was created with a one-line placeholder: grow/shrink it to the
  -- question's real wrapped height, or the options and the key-hint footer
  -- stay clipped below the window (no visible hints).
  local fwin = M._float.win
  if fwin and vim.api.nvim_win_is_valid(fwin) then
    local cfg = vim.api.nvim_win_get_config(fwin)
    local height = float_height(lines, cfg.width)
    if cfg.height ~= height then
      vim.api.nvim_win_set_config(fwin, {
        relative = cfg.relative,
        row = centered_row(height),
        col = cfg.col,
        width = cfg.width,
        height = height,
      })
    end
  end
  st.optRows = optRows
  attach_footer(M._float.win, footerText)
  if #optRows > 0 then
    vim.api.nvim_win_set_cursor(M._float.win, { optRows[st.optIdx], 0 })
  end
end

function M.question_move(dir)
  local st = M._float.state
  local q = st.questions[st.qIdx]
  if #q.options == 0 then
    return
  end
  st.optIdx = math.max(1, math.min(#q.options, st.optIdx + dir))
  M.redraw_questions()
end

function M.question_toggle()
  local st = M._float.state
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
  M.redraw_questions()
end

function M.question_advance()
  local st = M._float.state
  local q = st.questions[st.qIdx]
  if not q.multiSelect and #q.options > 0 then
    local o = q.options[st.optIdx]
    st.selected[q.id] = { [o.label] = true }
  end
  if st.qIdx < #st.questions then
    st.qIdx = st.qIdx + 1
    st.optIdx = 1
    M.redraw_questions()
  else
    M.questions_confirm()
  end
end

function M.questions_confirm()
  local st = M._float.state
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
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-questions-answered', answers)
  end
end

function M.questions_cancel()
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-questions-cancelled')
  end
end

--- Generic picker. items: { {label, value, active} }.
--- Plain buffer: every entry is a REAL line, so nvim's own navigation keys
--- (j/k, G, gg, C-d/C-u) work exactly as in any buffer — G lands on the hint
--- row, and Enter clamps it to the last entry. The hint is the last line,
--- flush with the window bottom because the height fits the content.
local PICKER_HINT = '[j/k] 移动  [Enter] 选择  [Esc] 取消'

function M.show_picker(title, items)
  close_float()
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
    row = centered_row(height),
    col = centered_col(width),
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
  M._float.kind = 'picker'
  M._float.state = { values = values }
  M._float.buf = buf
  M._float.win = win
  float_key(buf, '<CR>', 'require("dsh_tui").picker_confirm()')
  float_key(buf, '<Esc>', 'require("dsh_tui").picker_cancel()')
  float_key(buf, 'q', 'require("dsh_tui").picker_cancel()')
  float_key(buf, 'G', 'require("dsh_tui").picker_jump("last")')
  float_key(buf, 'gg', 'require("dsh_tui").picker_jump("first")')
  lock_popup_buffer(buf)
  vim.api.nvim_win_set_cursor(win, { math.min(activeRow, #lines), 0 })
  attach_footer(win, PICKER_HINT)
  return buf, win
end

function M.picker_move(dir)
  local st = M._float.state
  if st == nil or M._float.kind ~= 'picker' or #st.values == 0 then return end
  local row = vim.api.nvim_win_get_cursor(M._float.win)[1]
  row = math.max(1, math.min(#st.values, row + dir))
  vim.api.nvim_win_set_cursor(M._float.win, { row, 0 })
end

function M.picker_jump(where)
  local st = M._float.state
  if st == nil or M._float.kind ~= 'picker' or #st.values == 0 then return end
  local row = where == 'last' and #st.values or 1
  vim.api.nvim_win_set_cursor(M._float.win, { row, 0 })
end

function M.picker_confirm()
  local st = M._float.state
  local row = vim.api.nvim_win_get_cursor(M._float.win)[1]
  row = math.max(1, math.min(#st.values, row)) -- G lands on the hint row: take the last entry
  local value = st.values[row]
  close_float()
  if M._channel and value ~= nil then
    vim.rpcnotify(M._channel, 'dsh-picker-selected', value)
  end
end

function M.picker_cancel()
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-picker-cancelled')
  end
end

return M
