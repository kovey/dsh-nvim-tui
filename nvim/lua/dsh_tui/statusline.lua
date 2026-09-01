--- dsh_tui.statusline: the chat window's statusline (the Node runner drives
--- the content) and the terminal title (OSC 2). The text is stored in state so
--- the autocmd layer can re-apply it whenever a statusline plugin rewrites
--- the option.
local S = require('dsh_tui.state')
local SL = {}

local function apply()
  if S.chat_win and vim.api.nvim_win_is_valid(S.chat_win) and S.statuslineText ~= nil then
    -- pcall: a malformed string must never pop the E539 hit-enter prompt.
    pcall(vim.api.nvim_win_set_option, S.chat_win, 'statusline', S.statuslineText)
  end
end

--- Re-apply the stored statusline now (layout mount, WinClosed self-heal).
SL.apply = apply

--- Set the chat window statusline (Node drives the content). The text is
--- stored so window events can re-apply it — statusline plugins
--- (mini.statusline, lualine, …) rewrite the option on every WinEnter.
function SL.set(text)
  S.statuslineText = text or ''
  apply()
end

--- Terminal title (OSC 2): the runner keeps it in sync with the active
--- session so the terminal tab/window title shows what you're working on.
function SL.set_title(text)
  vim.o.titlestring = (text ~= nil and text ~= '') and ('dsh · ' .. text) or 'dsh'
end

--- Re-apply after the event batch (the LAST writer wins).
function SL.reschedule()
  vim.schedule(function() apply() end)
end

return SL
