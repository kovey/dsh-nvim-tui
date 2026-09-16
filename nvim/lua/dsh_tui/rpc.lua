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

--- Raw terminal escape passthrough. nvim owns the terminal (the bridge
--- deliberately does NOT pass `--embed`), so ONLY this process can reach it.
---
--- MUST be io.stdout, NOT `vim.api.nvim_out_write`: measured in this exact
--- architecture (nvim holding its own tty, stdout redirected to a file), an
--- `nvim_out_write` of an OSC 9 sequence wrote ZERO bytes to the terminal —
--- the API routes the text as a UI message, so it never reaches the tty. That
--- is why BOTH the bell and the notification were silent: `R.bell()` had used
--- `nvim_out_write` since it was written, so the bell had always been a no-op.
--- `io.stdout:write` + flush put the same bytes on the terminal (verified in
--- the same run).
local function raw(bytes)
  local ok = pcall(function()
    io.stdout:write(bytes)
    io.stdout:flush()
  end)
  return ok
end

--- Terminal bell (turn finished, approvals): BEL on the real terminal.
--- Goes through raw() — `nvim_out_write` is a UI message and never reached the
--- tty, so this bell had been silent for every user since it was written.
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
function R.notify_capability()
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
--- Distinct from R.bell() on purpose: BEL is audible and works everywhere,
--- OSC raises a desktop notification that also survives a muted terminal.
--- Returns the form actually emitted, or false when unsupported.
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
