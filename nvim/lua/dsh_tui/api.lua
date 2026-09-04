--- dsh_tui.api: the PUBLIC extension surface for third-party nvim plugins
--- running inside the TUI instance (the user's config IS loaded here).
---
--- This module is the ONLY stable Lua surface — require('dsh_tui')'s M.*
--- facade stays internal (runner + smoke tests). Everything here is
--- registration-driven: `api.register{ id = ... }` opens an ext entry in
--- S.extReg, and the ownership/self-heal layers (autocmds.lua) exempt
--- registered windows/buffers from their guards.
---
--- Surface: register/unregister, handles(), event emission (User autocmds +
--- api.last_event), managed floats (float_open/close), the right-edge panel
--- slot (panel_claim/release), input primitives, the dsh-ext RPC bus
--- (rpc_call/rpc_register/rpc_dispatch/rpc_event), before_submit hooks,
--- Lua-side slash commands, and the session-event mirror.
local S = require('dsh_tui.state')
local API = {}

--- Extension API version (semver; handshakes against the Node EXT_API_VERSION).
API.version = '0.1.0'

--- Emit a User autocmd event: `User DshTui<event>`. The payload is BOTH
--- passed as nvim_exec_autocmds `data` and parked in S.lastEvent — the
--- `data` option does not reach vim.v.event on every nvim version, so
--- consumers inside the autocmd must read api.last_event() (version-proof).
--- Events: Ready / Attach / ActiveSession / LayoutRebuilt / Shutdown /
--- ExtRegistered / ExtWindowClosed / ExtEvent / SessionEvent.
function API.emit(event, data)
  S.lastEvent = data
  S.lastEvents[event] = data
  pcall(vim.api.nvim_exec_autocmds, 'User', {
    pattern = 'DshTui' .. event,
    data = data,
  })
end

--- Payload of the most recent api.emit() (see emit).
function API.last_event()
  return S.lastEvent
end

--- One-shot initialization state for LATE-loading extensions (lazy.nvim
--- VeryLazy plugins register after the User events already fired): read
--- this at register time instead of relying on DshTuiReady/Attach/… which
--- are NOT replayed.
function API.snapshot()
  local ids = API.handles()
  return {
    started = S.started,
    attached = S.channel ~= nil,
    activeSession = S.activeId,
    runnerVersion = S.extRunnerVersion,
    layoutName = S.layoutName,
    chatWin = ids.chatWin,
    chatBuf = ids.chatBuf,
    inputWin = ids.inputWin,
    inputBuf = ids.inputBuf,
    panelWin = ids.panelWin,
    panelBuf = ids.panelBuf,
  }
end

local function valid_id(id)
  return type(id) == 'string' and id ~= '' and id:match('^[%w_%.-]+$') ~= nil
end

--- Register a third-party extension. Returns its registry table on success,
--- or nil + an error message. Duplicate ids are rejected.
---   spec = { id, name?, version?, events? = { 'assistant/message', ... },
---            on_ready? = fn(reg, { ready, runnerVersion }),
---            on_active_session? = fn(reg, { id }) }
--- `events` omitted, empty, the literal string 'all', or a list containing
--- 'all' = receive EVERY session event kind (mirror).
--- `on_ready` / `on_active_session` fire SYNCHRONOUSLY during register when
--- the TUI already booted — the late-load alignment path (User events are
--- never replayed).
function API.register(spec)
  if type(spec) ~= 'table' or not valid_id(spec.id) then
    return nil, 'api.register: spec.id (string) is required'
  end
  local id = spec.id
  if S.extReg[id] ~= nil then
    return nil, 'already registered: ' .. id
  end
  -- Normalize the event subscription: nil = all kinds.
  local events = spec.events
  if type(events) == 'string' then
    if events ~= 'all' then events = { events } else events = nil end
  elseif type(events) == 'table' then
    local kinds = {}
    local all = false
    for _, e in ipairs(events) do
      if type(e) == 'string' then
        if e == 'all' then all = true else kinds[#kinds + 1] = e end
      end
    end
    -- NOTE: `all and nil or kinds` would return kinds — Lua evaluates the
    -- `or` branch when the first operand is truthy. Explicit if instead.
    if all then events = nil else events = kinds end
  else
    events = nil
  end
  local reg = {
    id = id,
    name = tostring(spec.name or id),
    version = tostring(spec.version or '0'),
    windows = {},   -- win -> kind ('float' | 'panel' | 'tab')
    buffers = {},   -- buf -> true
    panel = nil,    -- { win, buf, width, title } (P2)
    rpc = {},       -- method -> fn (P3)
    submitHooks = {}, -- before_submit fns (P3)
    eventKinds = events,
    sessionCbs = {},  -- session-event mirror callbacks (P3)
  }
  S.extReg[id] = reg
  API.emit('ExtRegistered', { id = id, name = reg.name, version = reg.version })
  -- Tell the runner about the subscription (mirrors its event filter).
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-ext-register',
      { id = id, name = reg.name, version = reg.version, events = events })
  end
  -- LATE-LOAD REPLAY: User events are a LIVE-only stream (never replayed —
  -- replay would double-fire for every earlier subscriber). Extensions
  -- registering after boot (lazy.nvim VeryLazy) align their initial state
  -- through the spec's synchronous callbacks (invoked here exactly once)
  -- and api.snapshot().
  if S.started and S.channel ~= nil and type(spec.on_ready) == 'function' then
    local ok, err = pcall(spec.on_ready, reg, {
      ready = true,
      runnerVersion = S.extRunnerVersion,
    })
    if not ok then
      API.emit('ExtHookError', { id = id, error = tostring(err) })
    end
  end
  if S.activeId ~= nil and type(spec.on_active_session) == 'function' then
    local ok, err = pcall(spec.on_active_session, reg, { id = S.activeId })
    if not ok then
      API.emit('ExtHookError', { id = id, error = tostring(err) })
    end
  end
  return reg
end

--- Unregister: close every registered window/panel, drop the extension's
--- Lua-side commands from the completion catalog, then drop the entry.
--- Returns true, or nil + error when unknown.
function API.unregister(id)
  local reg = S.extReg[id]
  if reg == nil then
    return nil, 'not registered: ' .. tostring(id)
  end
  for win, _ in pairs(reg.windows) do
    if type(win) == 'number' and vim.api.nvim_win_is_valid(win) then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
  if reg.panel ~= nil and reg.panel.win ~= nil
    and vim.api.nvim_win_is_valid(reg.panel.win) then
    pcall(vim.api.nvim_win_close, reg.panel.win, true)
  end
  -- Remove this extension's slash commands (a dead owner must not leave
  -- catalog entries behind).
  for name, c in pairs(S.extCommands) do
    if c.owner == id then
      S.extCommands[name] = nil
    end
  end
  S.extReg[id] = nil
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-ext-unregister', id)
  end
  return true
end

--- Is this extension registered?
function API.registered(id)
  return S.extReg[id] ~= nil
end

--- Current TUI handles — ALWAYS re-resolve through here (the self-heal
--- layer rebuilds windows, so cached raw ids go stale). Includes the
--- occupied ext panel slot when one exists.
function API.handles()
  local ids = require('dsh_tui').ids()
  ids.panelWin = S.extPanel ~= nil and S.extPanel.win or nil
  ids.panelBuf = S.extPanel ~= nil and S.extPanel.buf or nil
  return ids
end

--- Boot handshake (called by the runner right after attach): compares the
--- runner's EXT_API_VERSION with this module's. Returns { ok = true } when
--- the major versions match, or { ok = false, error = message } (structured
--- like the rest of the RPC surface — only the first return value travels).
function API.handshake(runnerVersion)
  if type(runnerVersion) ~= 'string' then
    return { ok = false, error = 'handshake: version (string) required' }
  end
  local mine = tostring(API.version or '0')
  local major = mine:match('^(%d+)') or '0'
  local theirMajor = runnerVersion:match('^(%d+)') or '-1'
  if major ~= theirMajor then
    return { ok = false,
      error = 'ext api 版本不匹配: runner ' .. runnerVersion .. ' vs lua ' .. mine }
  end
  S.extRunnerVersion = runnerVersion
  return { ok = true }
end

-- ===========================================================================
-- Ownership helpers (consulted by autocmds.lua's guards)
-- ===========================================================================

--- Is this window owned by a registered extension?
function API.is_ext_win(win)
  for _, reg in pairs(S.extReg) do
    if reg.windows[win] ~= nil then return true end
    if reg.panel ~= nil and reg.panel.win == win then return true end
  end
  return false
end

--- Is this buffer owned by a registered extension?
function API.is_ext_buf(buf)
  for _, reg in pairs(S.extReg) do
    if reg.buffers[buf] then return true end
    if reg.panel ~= nil and reg.panel.buf == buf then return true end
  end
  return false
end

--- Register an extension-owned window/buffer (called by the float/panel
--- primitives). Foreign windows that are NOT registered keep the guards'
--- current behaviour.
function API.own_window(id, win, kind)
  local reg = S.extReg[id]
  if reg == nil then return nil, 'not registered: ' .. tostring(id) end
  reg.windows[win] = kind or 'float'
  return true
end

--- Forget an extension-owned window (its WinClosed hook, or close()).
function API.disown_window(id, win)
  local reg = S.extReg[id]
  if reg == nil then return nil end
  reg.windows[win] = nil
  return true
end

--- Forget stale handles: every window/buffer handle that no longer exists
--- is pruned from the registries (an ext that closed its own window must
--- not leave a permanent exemption behind).
function API.prune_dead_handles()
  local changed = false
  for _, reg in pairs(S.extReg) do
    for win, _ in pairs(reg.windows) do
      if type(win) == 'number' and not vim.api.nvim_win_is_valid(win) then
        reg.windows[win] = nil
        changed = true
      end
    end
    for buf, _ in pairs(reg.buffers) do
      if type(buf) == 'number' and not vim.api.nvim_buf_is_valid(buf) then
        reg.buffers[buf] = nil
        changed = true
      end
    end
    if reg.panel ~= nil and reg.panel.win ~= nil
      and not vim.api.nvim_win_is_valid(reg.panel.win) then
      reg.panel = nil
      changed = true
    end
  end
  return changed
end

-- ===========================================================================
-- P1: managed float windows (registered → guards exempt) + input primitives
-- ===========================================================================

--- Minimal registry entry for callers that need ownership without a full
--- register() (the Node runner itself, owner id '__node__'). Internal: does
--- NOT emit events.
function API.ensure_registry(id)
  if S.extReg[id] == nil then
    S.extReg[id] = {
      id = id,
      name = id,
      version = '0',
      windows = {},
      buffers = {},
      panel = nil,
      rpc = {},
      submitHooks = {},
      eventKinds = nil,
      sessionCbs = {},
    }
  end
  return S.extReg[id]
end

--- Open a managed float owned by a registered extension. Returns
--- { win, buf }, or { err = message } on failure (the msgpack-RPC client
--- surfaces only the FIRST return value, so errors must be structured).
--- The window is registered, so the boot guard / clone guard exempt it;
--- `q`/`<Esc>` close it (the owner is told via User DshTuiExtWindowClosed).
---   opts = { lines, title?, relative? ('editor'|'cursor'), width?,
---            height?, row?, col? }
function API.float_open(id, opts)
  local reg = S.extReg[id]
  if reg == nil then
    return { err = 'not registered: ' .. tostring(id) }
  end
  opts = type(opts) == 'table' and opts or {}
  local lines = opts.lines
  if type(lines) ~= 'table' then lines = {} end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  local width = math.max(10, math.min(tonumber(opts.width) or 60, math.max(10, vim.o.columns - 2)))
  local height = math.max(1, math.min(tonumber(opts.height) or math.min(#lines, 12), math.max(1, vim.o.lines - 4)))
  local relative = opts.relative == 'cursor' and 'cursor' or 'editor'
  local row = tonumber(opts.row)
  local col = tonumber(opts.col)
  local cfg = {
    relative = relative,
    anchor = 'NW',
    row = row ~= nil and row or math.max(0, math.floor((vim.o.lines - height) / 2) - 2),
    col = col ~= nil and col or math.max(0, math.floor((vim.o.columns - width) / 2)),
    width = width,
    height = height,
    border = 'rounded',
    style = 'minimal',
    zindex = 45,
  }
  if type(opts.title) == 'string' and opts.title ~= '' and vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' ' .. opts.title .. ' '
    cfg.title_pos = 'center'
  end
  local ok, win = pcall(vim.api.nvim_open_win, buf, false, cfg)
  if not ok then
    pcall(vim.api.nvim_buf_delete, buf, { force = true })
    return { err = 'float_open failed: ' .. tostring(win) }
  end
  reg.windows[win] = 'float'
  reg.buffers[buf] = true
  -- Content stays writable through the API, edit keys are silenced, q/Esc
  -- close (display surfaces — the same discipline as the chat buffers).
  require('dsh_tui.popup_core').lock_display_keys(buf)
  vim.api.nvim_buf_set_keymap(buf, 'n', 'q', '<Cmd>close<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', '<Esc>', '<Cmd>close<CR>', { noremap = true })
  return { win = win, buf = buf }
end

--- Close a managed float: close the window, delete its buffer, drop the
--- ownership records.
function API.float_close(id, win)
  local reg = S.extReg[id]
  if reg == nil then
    return nil, 'not registered: ' .. tostring(id)
  end
  local buf = nil
  if type(win) == 'number' and vim.api.nvim_win_is_valid(win) then
    buf = vim.api.nvim_win_get_buf(win)
    pcall(vim.api.nvim_win_close, win, true)
  end
  reg.windows[win] = nil
  if buf ~= nil and vim.api.nvim_buf_is_valid(buf) then
    reg.buffers[buf] = nil
    pcall(vim.api.nvim_buf_delete, buf, { force = true })
  end
  return true
end

--- Input primitives (whitelisted internal surface).
function API.input_fill(text)
  require('dsh_tui.input').fill(text)
end

function API.input_append(text)
  require('dsh_tui.input').append(text)
end

function API.input_get()
  return require('dsh_tui.buffer').input_text()
end

-- ===========================================================================
-- P4-③: interactive card activation (chat keymaps → runner)
-- ===========================================================================

--- Resolve the interactive card under the chat cursor and route activation
--- to the runner (feed.activateCard). actionIdx nil = open the action
--- picker (Enter); 1-9 = fire that action directly. Returns true when a
--- card mark owned the cursor row (false = no card there, key falls
--- through as a no-op — the chat stays display-only).
function API.card_activate(actionIdx)
  if S.chat_win == nil or not vim.api.nvim_win_is_valid(S.chat_win) then
    return false
  end
  local buf = vim.api.nvim_win_get_buf(S.chat_win)
  local row = (vim.api.nvim_win_get_cursor(S.chat_win)[1] or 1) - 1
  local ns = vim.api.nvim_create_namespace('dsh_tui_extcards')
  -- Query the WHOLE namespace and filter by row: get_extmarks' row-range
  -- query does not intersect block marks that START above the range.
  local marks = vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })
  local markId = nil
  for _, m in ipairs(marks or {}) do
    local startRow = m[2]
    local endRow = (m[4] and m[4].end_row) or (startRow + 1)
    if row >= startRow and row < endRow then
      markId = m[1]
      break
    end
  end
  if markId == nil then
    return false
  end
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-ext-card-activate',
      { mark = markId, action = actionIdx })
  end
  return true
end

-- ===========================================================================
-- P2: the right-edge panel slot (the reasoning panel's geometry generalized)
-- ===========================================================================

--- Right-edge panel geometry shared by the reasoning panel and extension
--- panels. width <= 0 → the reasoning default (45% clamp, 30..52 cols);
--- a positive width is clamped to 24..60% of the screen. title/footer embed
--- into the border on nvim >= 0.9 / 0.10 respectively.
function API.panel_geometry(width, title, footer)
  local cols = vim.o.columns
  local w = tonumber(width)
  if w == nil or w <= 0 then
    w = math.max(30, math.min(52, math.floor(cols * 0.45)))
  else
    w = math.max(24, math.min(math.floor(w), math.max(24, math.floor(cols * 0.6))))
  end
  local height = math.max(3, math.floor(vim.o.lines * 0.75))
  local cfg = {
    relative = 'editor',
    anchor = 'NE',
    row = 0,
    col = cols - 1,
    width = w,
    height = height,
  }
  if vim.fn.has('nvim-0.9') == 1 and type(title) == 'string' and title ~= '' then
    cfg.title = title
    cfg.title_pos = 'center'
  end
  if vim.fn.has('nvim-0.10') == 1 and type(footer) == 'string' and footer ~= '' then
    cfg.footer = footer
    cfg.footer_pos = 'left'
  end
  return cfg
end

--- Claim the right-edge panel slot for a registered extension. ONE slot
--- exists (shared with no one — the reasoning panel is a separate float and
--- may overlay it, like it overlays the chat). Returns { win, buf }, or
--- { err = message } when the slot is taken. Content stays writable through
--- the API; the TUI re-anchors the panel on terminal resize.
---   opts = { width?, title?, footer?, lines? }
function API.panel_claim(id, opts)
  local reg = S.extReg[id]
  if reg == nil then
    return { err = 'not registered: ' .. tostring(id) }
  end
  if S.extPanel ~= nil then
    return { err = 'panel slot occupied by ' .. tostring(S.extPanel.id) }
  end
  opts = type(opts) == 'table' and opts or {}
  local lines = opts.lines
  if type(lines) ~= 'table' then lines = {} end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  require('dsh_tui.popup_core').lock_display_keys(buf)
  -- q/Esc release the slot (the panel is a display surface; closing is the
  -- one edit the owner does not need to Nop).
  vim.api.nvim_buf_set_keymap(buf, 'n', 'q',
    string.format('<Cmd>lua require("dsh_tui.api").panel_release(%q)<CR>', id),
    { noremap = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', '<Esc>',
    string.format('<Cmd>lua require("dsh_tui.api").panel_release(%q)<CR>', id),
    { noremap = true })
  local cfg = API.panel_geometry(opts.width, opts.title, opts.footer)
  cfg.border = 'rounded'
  cfg.style = 'minimal'
  cfg.zindex = 30 -- above the chat, below menus/approvals (reasoning tier)
  local win = vim.api.nvim_open_win(buf, false, cfg)
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.wo[win].cursorline = false
  local panel = { id = id, win = win, buf = buf, width = cfg.width,
    title = opts.title, footer = opts.footer }
  reg.panel = panel
  reg.windows[win] = 'panel'
  reg.buffers[buf] = true
  S.extPanel = panel
  require('dsh_tui.input').focus()
  return { win = win, buf = buf }
end

--- Release the panel slot (no-op when this extension holds no panel).
function API.panel_release(id)
  local reg = S.extReg[id]
  if reg == nil then
    return nil, 'not registered: ' .. tostring(id)
  end
  if reg.panel ~= nil then
    local p = reg.panel
    reg.panel = nil
    if S.extPanel == p then S.extPanel = nil end
    if p.win ~= nil and vim.api.nvim_win_is_valid(p.win) then
      pcall(vim.api.nvim_win_close, p.win, true)
    end
    if p.buf ~= nil and vim.api.nvim_buf_is_valid(p.buf) then
      reg.buffers[p.buf] = nil
      pcall(vim.api.nvim_buf_delete, p.buf, { force = true })
    end
    require('dsh_tui.input').focus()
  end
  return true
end

-- ===========================================================================
-- P3: the dsh-ext RPC bus + input/command hooks + session-event mirror
-- ===========================================================================

--- Lua → Node: call a method served by a Node-side extension (registered
--- via the Node api's luaExt.on). Blocks until the runner answers (nvim
--- rpcrequest semantics — uninterruptible, NOT cancellable from Lua);
--- returns value, or nil + error message.
---
--- FREEZE GUARANTEE: the runner answers EVERY request within its handler
--- timeout (default 30s) — slow/hung handlers get a structured timeout
--- error, so this call never blocks the UI indefinitely. Nested nvim calls
--- made BY the handler are safe (nvim keeps processing events while
--- blocked here).
function API.rpc_call(extId, method, args)
  if not S.channel then
    return nil, 'no runner channel'
  end
  local ok, res = pcall(vim.rpcrequest, S.channel, 'dsh-ext',
    { v = 1, id = extId, method = method, args = args or {} })
  if not ok then
    return nil, tostring(res)
  end
  if type(res) == 'table' then
    if res.ok == true then
      return res.value
    end
    return nil, tostring(res.error or 'unknown ext error')
  end
  return res
end

--- Serve a method for Node-side callers (Node api's luaExt.call).
function API.rpc_register(id, method, fn)
  local reg = S.extReg[id] or API.ensure_registry(id)
  if type(method) ~= 'string' or method == '' then
    return nil, 'rpc_register: method (string) is required'
  end
  if type(fn) ~= 'function' then
    return nil, 'rpc_register: fn (function) is required'
  end
  reg.rpc[method] = fn
  return true
end

--- Node → Lua dispatch entry (called by the runner's luaExt.call).
function API.rpc_dispatch(id, method, args)
  local reg = S.extReg[id]
  local fn = reg and reg.rpc[method]
  if type(fn) ~= 'function' then
    return { ok = false, error = 'no handler: ' .. tostring(id) .. '.' .. tostring(method) }
  end
  local ok, value = pcall(fn, args or {})
  if not ok then
    return { ok = false, error = tostring(value) }
  end
  return { ok = true, value = value }
end

--- Node → Lua event (the runner's luaExt.emit): fires User DshTuiExtEvent
--- with data { id, event, payload } and any api.on_ext_event callbacks.
function API.rpc_event(id, event, payload)
  local reg = S.extReg[id]
  if reg ~= nil and reg.eventCbs ~= nil then
    for _, cb in pairs(reg.eventCbs) do
      local ok, err = pcall(cb, event, payload)
      if not ok then
        API.emit('ExtHookError', { id = id, error = tostring(err) })
      end
    end
  end
  API.emit('ExtEvent', { id = id, event = event, payload = payload })
end

--- Subscribe to Node-emitted events for this extension. Returns a disposer.
function API.on_ext_event(id, fn)
  local reg = S.extReg[id] or API.ensure_registry(id)
  if type(fn) ~= 'function' then
    return nil, 'on_ext_event: fn (function) is required'
  end
  if reg.eventCbs == nil then reg.eventCbs = {} end
  table.insert(reg.eventCbs, fn)
  return function()
    for i, f in ipairs(reg.eventCbs or {}) do
      if f == fn then
        table.remove(reg.eventCbs, i)
        return true
      end
    end
    return false
  end
end

--- before_submit hook: runs on EVERY submission. Return nil/false to veto
--- (the draft stays in the input box), a string to replace the submission.
--- Returns a disposer.
function API.before_submit(id, fn)
  local reg = S.extReg[id] or API.ensure_registry(id)
  if type(fn) ~= 'function' then
    return nil, 'before_submit: fn (function) is required'
  end
  table.insert(reg.submitHooks, fn)
  return function()
    for i, f in ipairs(reg.submitHooks) do
      if f == fn then
        table.remove(reg.submitHooks, i)
        return true
      end
    end
    return false
  end
end

--- Register a Lua-side slash command (executed in nvim, never routed to
--- the runner). Merged into the / completion catalog. Duplicates rejected.
function API.register_command(id, name, desc, fn)
  local reg = S.extReg[id] or API.ensure_registry(id)
  if type(name) ~= 'string' or name == '' then
    return nil, 'register_command: name (string) is required'
  end
  name = name:match('^/') and name or ('/' .. name)
  if type(fn) ~= 'function' then
    return nil, 'register_command: fn (function) is required'
  end
  if S.extCommands[name] ~= nil then
    return nil, 'command exists: ' .. name
  end
  S.extCommands[name] = { name = name, desc = tostring(desc or ''), owner = id, fn = fn }
  return true
end

function API.unregister_command(id, name)
  name = name:match('^/') and name or ('/' .. tostring(name))
  local c = S.extCommands[name]
  if c ~= nil and c.owner == id then
    S.extCommands[name] = nil
    return true
  end
  return nil, 'no such command: ' .. tostring(name)
end

--- Transient notice: routed to the runner, which appends it to the active
--- session's feed (the Lua side owns no feed rendering).
function API.notice(id, text)
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-ext-notice', { id = id, text = tostring(text) })
  end
end

--- Session-event mirror entry (called by the runner for extensions whose
--- register() subscribed): invokes api.on_session_event callbacks, then
--- fires User DshTuiSessionEvent with data { ids, event }.
function API.session_event(ids, event)
  for _, id in ipairs(ids or {}) do
    local reg = S.extReg[id]
    if reg ~= nil and reg.sessionCbs ~= nil then
      for _, cb in pairs(reg.sessionCbs) do
        local ok, err = pcall(cb, event)
        if not ok then
          API.emit('ExtHookError', { id = id, error = tostring(err) })
        end
      end
    end
  end
  API.emit('SessionEvent', { ids = ids, event = event })
end

--- Subscribe to mirrored session events for this extension. Returns a
--- disposer. Delivery requires the extension's register() to declare
--- `events` (the kinds to receive, e.g. { 'turn/end' }) or 'all'.
function API.on_session_event(id, fn)
  local reg = S.extReg[id] or API.ensure_registry(id)
  if type(fn) ~= 'function' then
    return nil, 'on_session_event: fn (function) is required'
  end
  if reg.sessionCbs == nil then reg.sessionCbs = {} end
  table.insert(reg.sessionCbs, fn)
  return function()
    for i, f in ipairs(reg.sessionCbs or {}) do
      if f == fn then
        table.remove(reg.sessionCbs, i)
        return true
      end
    end
    return false
  end
end

return API
