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

return API
