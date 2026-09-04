--- dsh_tui.api: the PUBLIC extension surface for third-party nvim plugins
--- running inside the TUI instance (the user's config IS loaded here).
---
--- This module is the ONLY stable Lua surface — require('dsh_tui')'s M.*
--- facade stays internal (runner + smoke tests). Everything here is
--- registration-driven: `api.register{ id = ... }` opens an ext entry in
--- S.extReg, and the ownership/self-heal layers (autocmds.lua) exempt
--- registered windows/buffers from their guards.
---
--- P0 scope: register/unregister, handles(), event emission (User
--- autocmds), and the ownership helpers the guards consult. Float/panel
--- primitives, the dsh-ext RPC bus and input/command hooks land in P1-P3.
local S = require('dsh_tui.state')
local API = {}

--- Extension API version (semver; handshakes against the Node EXT_API_VERSION).
API.version = '0.1.0'

--- Emit a User autocmd event: `User DshTui<event>` with `data` passed to
--- callbacks as vim.v.event. Events: Ready / Attach / ActiveSession /
--- LayoutRebuilt / Shutdown / ExtRegistered / ExtWindowClosed.
function API.emit(event, data)
  pcall(vim.api.nvim_exec_autocmds, 'User', {
    pattern = 'DshTui' .. event,
    data = data,
  })
end

local function valid_id(id)
  return type(id) == 'string' and id ~= '' and id:match('^[%w_%.-]+$') ~= nil
end

--- Register a third-party extension. Returns its registry table on success,
--- or nil + an error message. Duplicate ids are rejected.
---   spec = { id, name?, version?, events? = { 'assistant/message', ... } }
function API.register(spec)
  if type(spec) ~= 'table' or not valid_id(spec.id) then
    return nil, 'api.register: spec.id (string) is required'
  end
  local id = spec.id
  if S.extReg[id] ~= nil then
    return nil, 'already registered: ' .. id
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
    eventKinds = spec.events,
    sessionCbs = {},  -- session-event mirror callbacks (P3)
  }
  S.extReg[id] = reg
  API.emit('ExtRegistered', { id = id, name = reg.name, version = reg.version })
  -- Tell the runner about the subscription (mirrors its event filter).
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-ext-register',
      { id = id, name = reg.name, version = reg.version, events = spec.events })
  end
  return reg
end

--- Unregister: close every registered window/panel, drop the entry.
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
--- layer rebuilds windows, so cached raw ids go stale).
function API.handles()
  return require('dsh_tui').ids()
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
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, opts.lines or {})
  require('dsh_tui.popup_core').lock_display_keys(buf)
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

return API
