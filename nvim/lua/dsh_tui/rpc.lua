--- dsh_tui.rpc: the runner-channel surface — attaching the channel, user
--- intent notifications (quit / image paste / abort), the terminal bell,
--- opening files in fresh tabs, and theme overrides. Everything here only
--- talks to the channel or the global editor options; no layout state.
local S = require('dsh_tui.state')
local R = {}

--- Called by the Node runner once it has connected and knows its channel id.
function R.attach(channel_id)
  S.channel = channel_id
  require('dsh_tui.api').emit('Attach', { channel = channel_id })
end

--- Accessor for tests.
function R.channel()
  return S.channel
end

--- Ask the runner to shut down (dispose agents + exit dsh).
function R.quit()
  S.quitting = true
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-quit')
  else
    vim.cmd('qa!')
  end
end

--- <C-v> clipboard-image paste: ask the runner to read the clipboard image
--- (macOS pbpaste) and queue it for the next submit.
function R.paste_image()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-paste-image')
  end
end

--- <C-c> stop: ask the runner to abort the running turn (no-op when idle).
function R.abort_turn()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-abort')
  end
end

--- Raw terminal escape passthrough.
---
--- ⚠️ STATUS: NOT WORKING — UNRESOLVED. Verified facts (2026-09-16), do not
--- restate these as guesses when revisiting:
---   · The plugin runs in an nvim launched with `--embed` whose fd 1 is a PIPE
---     (`vim.uv.guess_handle(1) == "pipe"`), so bytes written here do NOT reach
---     the terminal. Both OSC 9 and OSC 777 were sent from that instance and
---     produced no notification in iTerm (TERM_PROGRAM=iTerm.app, notifications
---     enabled).
---   · `vim.api.nvim_out_write` is also wrong for a different reason: it routes
---     the text as a UI message (msg_puts) and never touches the tty.
---   · The bell has therefore been INAUDIBLE for every user since it was
---     written — `/bell on` and approvals both stayed silent.
---   · A sibling nvim process DOES own the tty (the bridge's own `--listen`
---     invocation, matching bridge.ts: no `--embed`), but no RPC path reaches it
---     from here: that path is taken by the embedded instance, so
---     `nvim --server <sock>` always lands on the embedded one.
--- ⇒ The fix must emit from whichever process owns the tty (host/renderer
--- side), not from Lua. Do NOT "fix" this by switching between the two APIs
--- above again — both were measured. See memory lesson `ps-lsof.md`.
---
--- CAUTION when measuring: never probe with a test/embedded instance — the
--- smoke harness spawns `--headless` and its scratch dirs share the
--- `dsh-nvim-tui-XXXX` naming, so they are easy to mistake for the real TUI.
--- Is our stdout an actual terminal we may write escapes to?
--- CONSERVATIVE on both sides: if the handle cannot be probed we return false
--- (writing escapes into a pipe shows them as literal garbage), and a probe
--- that reports anything other than "tty" is refused.
local function stdout_is_tty()
  local ok, kind = pcall(function()
    return vim.uv.guess_handle(1)
  end)
  return ok and kind == 'tty'
end

local function raw(bytes)
  -- NEVER write escapes to a non-tty. Measured failure mode (v0.4.2): the
  -- notification was emitted unconditionally, so in a piped/headless run the
  -- OSC appeared as literal text AND the terminal's device-attributes reply
  -- (`CSI ?64;…c`) had no reader — that stray input corrupted the nvim RPC
  -- stream, which surfaced as `nvim_buf_set_lines: 'replacement string' item
  -- contains newlines` and `write EPIPE` crashes.
  if not stdout_is_tty() then return false end
  local ok = pcall(function()
    io.stdout:write(bytes)
    io.stdout:flush()
  end)
  return ok
end

--- Terminal bell (turn finished, approvals). Goes through raw(), which is
--- currently a NO-OP in practice (see the status note above): the plugin's
--- nvim is embedded, so its stdout is a pipe. The bell has been inaudible since
--- it was written; this function is kept so the call sites and the fix land in
--- one place once emission moves to the tty owner.
function R.bell()
  return raw('\x07')
end

--- Open a file in a NEW nvim tab (deliverables / settings document) — the TUI
--- layout stays untouched; closing the tab returns to the TUI.
function R.open_file_tab(path)
  local ok = pcall(vim.cmd, 'tabedit ' .. vim.fn.fnameescape(path))
  if not ok then
    if S.channel then
      vim.rpcnotify(S.channel, 'dsh-open-failed', path)
    end
  end
  return ok
end

--- Apply theme overrides: map of highlight group -> attributes.
--- Each entry: { fg=, bg=, bold=, italic=, underline= } or { link = 'Group' }.
function R.apply_theme(theme)
  if type(theme) ~= 'table' then
    return
  end
  for group, attrs in pairs(theme) do
    if type(group) == 'string' and type(attrs) == 'table' then
      if next(attrs) == nil then
        -- Empty spec = RESET this group (preset switching must clear the
        -- previous preset's attributes, which are only ever added).
        pcall(vim.api.nvim_set_hl, 0, group, {})
      elseif type(attrs.link) == 'string' then
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

--- Which OSC notification form this terminal understands, or nil when none is
--- known. Probing is best-effort by design: an unknown terminal simply gets no
--- notification (the BEL path is unaffected), because emitting an unrecognized
--- OSC on some terminals prints the payload as garbage text.
--- @param assume_tty boolean|nil test seam: forces the tty precondition so the
---   per-terminal mapping stays testable under a headless harness.
function R.notify_capability(assume_tty)
  -- A non-tty means we could not deliver an escape even if the terminal
  -- supports it, so report "unsupported" rather than a form we cannot send.
  if assume_tty ~= true and not stdout_is_tty() then return nil end
  local env = vim.env
  if env.TMUX ~= nil and env.TMUX ~= '' then
    -- tmux swallows OSC unless the passthrough wrapper is used; rather than
    -- guess tmux's version, skip (a wrong guess writes visible junk).
    return nil
  end
  local prog = env.TERM_PROGRAM
  if prog == 'iTerm.app' or prog == 'WezTerm' or prog == 'vscode' then
    return 'osc9'
  end
  if env.KITTY_WINDOW_ID ~= nil or env.GHOSTTY_RESOURCES_DIR ~= nil then
    return 'osc9'
  end
  if prog == 'Apple_Terminal' then
    -- Terminal.app has neither OSC 9 nor 777; BEL is all it offers.
    return nil
  end
  -- rxvt-unicode and friends: OSC 777 notify.
  local term = env.TERM or ''
  if term:match('^rxvt') or term:match('^urxvt') then return 'osc777' end
  return nil
end

--- Terminal-level attention notification (turn finished / needs an answer).
--- Distinct from R.bell() on purpose: BEL is audible-only, OSC raises a desktop
--- notification that also survives a muted terminal.
--- NOT WORKING in the current architecture — see the status note on raw()
--- above. Returns the form it TRIED to emit, or false when unsupported; it
--- cannot report whether the bytes actually reached the terminal.
--- @param title string short headline (e.g. "dsh")
--- @param body string one-line summary
function R.notify(title, body)
  local form = R.notify_capability()
  if form == nil then return false end
  -- Strip control bytes so a session title can never inject a second escape.
  local function clean(x)
    return (tostring(x or ''):gsub('%c', ' '))
  end
  if form == 'osc9' then
    return raw('\x1b]9;' .. clean(title) .. ': ' .. clean(body) .. '\x07')
  end
  return raw('\x1b]777;notify;' .. clean(title) .. ';' .. clean(body) .. '\x07')
end

return R
