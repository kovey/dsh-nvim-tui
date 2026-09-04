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

--- Terminal bell (turn finished, approvals): BEL on nvim's stdout.
function R.bell()
  local ok = pcall(vim.api.nvim_out_write, '\x07')
  return ok
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

return R
