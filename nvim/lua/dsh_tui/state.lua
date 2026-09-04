--- dsh_tui.state: the single shared state every module operates on.
--
-- Public compatibility: init.lua exposes every M._xxx field the runner /
-- smoke tests introspect (M._progress, M._cmdWin, …) as a LAZY alias of the
-- matching field here (M._progress → S.progress). Modules mutate these
-- tables, so the aliases stay in sync automatically — including nil↔value
-- transitions and whole-table swaps (S.progress / S.subagentView are
-- REPLACED as a unit when their floats open/close).
--
-- Window/buffer handles are NOT allowed to live in modules: anything that
-- needs chat_win / input_buf / input_win reads them from here.
--
-- RELOAD SAFETY (vim.loader.enable / rtp rebuilds clear package.loaded):
-- a re-run of this file MUST yield the SAME table — every module captures
-- S at load time, so a second instance would split the registry across
-- modules (registered exts invisible to the guards). The instance is
-- pinned on a Lua global (_G — vim.g round-trips tables through Dict
-- conversion and would lose identity) and fields initialize ONCE.

local S = _G.__dsh_tui_state
if S == nil then
  S = {}
  _G.__dsh_tui_state = S
  S._initialized = true
end

if S._initialized == true then
  S._initialized = false

-- TUI core handles (set by layout.lua / input.lua)
S.chat_win = nil
S.input_buf = nil
S.input_win = nil

-- runner channel + lifecycle
S.channel = nil
S.started = false
S.quitting = false
S.buildingLayout = false
S.bootGuardUntil = nil
S.mainTab = nil

-- extension registry (dsh_tui.api): extId -> registry table. The
-- ownership/self-heal guards (autocmds.lua) exempt registered windows and
-- buffers; everything unregistered keeps the strict behaviour.
S.extReg = {}
-- The occupied right-edge panel slot (owned by exactly one extension).
S.extPanel = nil
-- Lua-side extension commands: '/name' -> { name, desc, owner, fn }.
-- Merged into the completion catalog by cmd_menu.entries().
S.extCommands = {}
-- Payload of the most recent api.emit() — the version-proof event carrier:
-- nvim_exec_autocmds' `data` option does not land in vim.v.event on every
-- nvim version, so consumers read api.last_event() inside User autocmds.
S.lastEvent = nil
-- Payload of the most recent emit per event name (the late-load snapshot
-- source for api.snapshot()/register callbacks).
S.lastEvents = {}
-- Runner's EXT_API_VERSION as reported by the boot handshake.
S.extRunnerVersion = nil

-- per-session registry
S.chats = {}          -- session id -> chat buffer
S.reasoningBufs = {}  -- session id -> reasoning buffer
S.reasoningWin = nil  -- the (optional) reasoning panel window
S.reasoningOpen = false
S.activeId = nil

-- namespaces (shared: feed marks, input frame furniture, syntax tokens)
S.ns = vim.api.nvim_create_namespace('dsh_tui')
S.frameNs = vim.api.nvim_create_namespace('dsh_tui_input_frame')

-- window furniture text (re-asserted by the autocmd layer)
S.statuslineText = nil
S.inputWinbar = nil
S.inputStatusline = nil
S.inputFillchars = nil

-- input state
S.history = {}
S.histIdx = nil
S.draft = nil

-- popup / panel / menu state (public M._* aliases)
S.footer = { win = nil, buf = nil, mainWin = nil }
S.syntaxScratch = nil
S.cmdCatalog = nil        -- { { name = ..., desc = ... }, ... } from the runner
S.cmdWin = nil            -- floating command-menu window
S.cmdBuf = nil
S.cmdMatches = {}         -- entries matching the current prefix
S.cmdIdx = 0              -- 1-based selection index
S.cmdTop = 1              -- first visible row
S.subagentView = { buf = nil, win = nil }
S.subagentChat = { buf = nil, win = nil, inputBuf = nil, inputWin = nil, hist = {}, histIdx = nil, draft = nil }
S.atWin = nil
S.atBuf = nil
S.atItems = {}            -- { path, mention }
S.atIdx = 0
S.atTop = 1
S.atStart = 0             -- byte offset of '@' in the input line (0-based)
S.dirWin = nil
S.dirBuf = nil
S.dirPath = nil
S.dirRows = {}            -- display rows
S.dirIdx = 1
S.progress = { win = nil, buf = nil }
S.layoutName = 'default'
S.sessWin = nil
S.sessBuf = nil
S.sessEntries = {}
S.sessIdx = 1
S.float = { win = nil, buf = nil, kind = nil, state = nil } -- approval/questions/picker

S.skillWin = nil
S.linesWin = nil
end -- first-run initialization

return S
