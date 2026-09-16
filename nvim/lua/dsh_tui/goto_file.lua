--- dsh_tui.goto_file: open the file referenced by the line under the cursor.
---
--- Reading a tool card ("✎ 修改 README.md", "🔧 read … src/feed/feed.ts") and
--- wanting to look at that file is one of the most common things to do in a
--- transcript, and until now the only way was to read the path by eye and type
--- it. The transcript is a real buffer, so this is just `gf` with a parser that
--- knows the TUI's own line shapes.
---
--- Opens in a NEW tab (the TUI layout stays untouched, `gt`/`gT` reaches it) —
--- the same mechanism the deliverables/settings documents already use.
local R = require('dsh_tui.rpc')
local S = require('dsh_tui.state')
local G = {}

--- File-ish token: needs a dot extension so prose and bare words are ignored.
--- The prefix is greedy up to the LAST slash, so a path containing spaces
--- ("my dir/a.ts") still resolves as far back as the line allows.
local FILE_RE = '([%w%._%-/]*[%w%_%-]%.[%w]+)'

--- Change-card / tool-card decoration that must not become part of the path.
local CARD_PREFIX = { '✎', '🔧', '%(.*%)' }

--- Transcript chrome that must not be treated as content.
--- Matched with plain `sub()` on WHOLE prefixes, never a Lua character class:
--- a class of multibyte glyphs like '[✓✗…]' matches UTF-8 CONTINUATION bytes,
--- so '✎' (E2 9C 8E) matched '[✓]' (✓ = E2 9C 93) part-way through — the change
--- card was discarded as "chrome" and every jump from it failed.
-- NOTE: '✎' (change card) is deliberately NOT chrome — those cards are the
-- primary place you want to jump FROM. It is stripped as decoration instead,
-- via CARD_PREFIX below.
--
-- Known limit: a '✓'-prefixed row is skipped. Those rows are the todo list
-- (pending/in-progress/completed items always carry a mark), and the same mark
-- also fronts successful tool-result cards — so a `✓` result card that names a
-- file is not jumpable. Kept this way on purpose: filing todo items under the
-- jump feature would put a file open on a line that is about a task, not a file.
local CHROME_PREFIXES = { '|', '>', '·', '✓', '✗', '…', '◎', '◇', '◈', '📋', '⚙', '─' }

local function starts_with(line, prefix)
  return line:sub(1, #prefix) == prefix
end

local function is_chrome(line)
  local t = line:gsub('^%s+', '')
  for _, p in ipairs(CHROME_PREFIXES) do
    if starts_with(t, p) then return true end
  end
  return false
end

--- The path under the cursor, or nil. Pure: takes the line, returns a string.
--- @param line string one transcript line
--- @return string|nil path
function G.path_from_line(line)
  if type(line) ~= 'string' or line == '' then return nil end
  if is_chrome(line) then return nil end
  local path = line:match(FILE_RE)
  if path == nil then return nil end
  -- Trim decoration that may have been swallowed by the greedy prefix.
  path = path:gsub('^[%s:：,，、]+', '')
  for _, deco in ipairs(CARD_PREFIX) do
    path = path:gsub(deco .. '%s*$', '')
  end
  path = path:gsub('^[%s]+', ''):gsub('[%s]+$', '')
  if path == '' or path:find('%.%.') then return nil end
  -- URL shapes. A slash is NOT enough to prove a path: in "https://example.com"
  -- the greedy prefix swallows the "//", so the match is "//example.com" — it
  -- contains a slash yet leads nowhere on disk, and opening it just fails.
  if path:sub(1, 2) == '//' or path:match('^%a+://') then return nil end
  -- Bare hostname (no directory part) is the other URL shape: "example.com" and
  -- "a.ts" are indistinguishable by shape, so filter by the common TLDs.
  if not path:find('/') and path:match('%.(%a%a%a?%a?)$') then
    local tld = path:match('%.(%a+)$')
    if tld and ({ com = true, org = true, net = true, io = true, dev = true, ai = true, cn = true, edu = true, gov = true })[tld:lower()] then
      return nil
    end
  end
  return path
end

--- Line number hint on the same line: `:123`, `:123:45` or ` 123` at the end.
--- @return number|nil
function G.line_from_line(line)
  if type(line) ~= 'string' then return nil end
  -- Order matters: in "a.ts:42:7" the FIRST pattern would match the trailing
  -- ":7" (the column) and jump to line 7. The LINE:COL form must win.
  local n = line:match(':(%d+):%d+') or line:match(':(%d+)%s*$')
  if n == nil then return nil end
  local v = tonumber(n)
  if v == nil or v < 1 then return nil end
  return v
end

--- Resolve a possibly-relative path against the active session's cwd, then the
--- editor's cwd, and finally the transcript's own directory. Returns the first
--- candidate that exists, so a relative card path still lands on the real file.
function G.resolve(path)
  local cands = {}
  local base = S.activeCwd
  if type(base) == 'string' and base ~= '' then
    cands[#cands + 1] = base .. '/' .. path
  end
  cands[#cands + 1] = path
  cands[#cands + 1] = vim.fn.getcwd() .. '/' .. path
  for _, c in ipairs(cands) do
    if vim.fn.filereadable(c) == 1 then return c end
  end
  return nil
end

--- Open the file under the cursor in a new tab. Returns true when it opened.
--- @param win integer|nil window to inspect (defaults to the current one)
function G.goto_file(win)
  local w = win or vim.api.nvim_get_current_win()
  local row = vim.api.nvim_win_get_cursor(w)[1]
  local buf = vim.api.nvim_win_get_buf(w)
  local ok, lines = pcall(vim.api.nvim_buf_get_lines, buf, row - 1, row, false)
  if not ok then return false end
  local text = (lines and lines[1]) or ''
  local path = G.path_from_line(text)
  if path == nil then
    if S.channel then vim.rpcnotify(S.channel, 'dsh-goto-none') end
    return false
  end
  local full = G.resolve(path)
  if full == nil then
    if S.channel then vim.rpcnotify(S.channel, 'dsh-open-failed', path) end
    return false
  end
  local opened = R.open_file_tab(full)
  if opened then
    local ln = G.line_from_line(text)
    if ln ~= nil then pcall(vim.api.nvim_win_set_cursor, 0, { ln, 0 }) end
  end
  return opened
end

--- Install the buffer-local map. `<C-w>f` mirrors vim's "open in split" family
--- while staying out of the way of plain `gf` for users who want the default.
function G.install(buf)
  if buf == nil or not vim.api.nvim_buf_is_valid(buf) then return end
  local function map(lhs)
    vim.api.nvim_buf_set_keymap(buf, 'n', lhs, '', {
      noremap = true, silent = true,
      callback = function() G.goto_file() end,
      desc = 'dsh: open the file on this line in a new tab',
    })
  end
  map('<C-w>f')
  map('gF')
end

return G
