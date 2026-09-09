--- dsh_tui.session: per-session buffers and the reasoning panel — creating /
--- looking up the chat and reasoning buffers the runner's renderer writes
--- into, the right-edge thinking panel (<C-o>), the active-session switch,
--- and the ids() surface the renderer polls.
local S = require('dsh_tui.state')
local B = require('dsh_tui.buffer')
local PC = require('dsh_tui.popup_core')
local PP = require('dsh_tui.popups')
local I = require('dsh_tui.input')
local SE = {}

--- Create (or return) the chat buffer for one session.
--- Returns { chatBuf, chatWin } — chatWin is the shared chat window.
function SE.ensure_chat(id)
  local buf = S.chats[id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    B.chat_buffer_options(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '…' })
    -- <C-o> toggles the reasoning panel from the chat buffer too.
    vim.api.nvim_buf_set_keymap(buf, 'n', '<C-o>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    -- Interactive ext cards: cursor on a card + 1-9 fires its action,
    -- Enter opens the action picker (both no-op elsewhere — the chat
    -- stays display-only).
    vim.api.nvim_buf_set_keymap(buf, 'n', '<Enter>',
      '<Cmd>lua require("dsh_tui.api").card_activate()<CR>', { noremap = true })
    for i = 1, 9 do
      vim.api.nvim_buf_set_keymap(buf, 'n', tostring(i),
        string.format('<Cmd>lua require("dsh_tui.api").card_activate(%d)<CR>', i),
        { noremap = true })
    end
    PC.lock_display_keys(buf) -- chat output is display-only (renderer writes via API)
    vim.api.nvim_buf_set_name(buf, 'dsh-chat-' .. tostring(id))
    S.chats[id] = buf
  end
  return { chatBuf = buf, chatWin = S.chat_win }
end

--- Create (or return) the reasoning (thinking) buffer for one session.
--- Returns { reasoningBuf, reasoningWin, reasoningOpen }.
function SE.ensure_reasoning(id)
  local buf = S.reasoningBufs[id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    B.chat_buffer_options(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '·· 思考与工具记录（<C-o> 收起）' })
    vim.api.nvim_buf_set_keymap(buf, 'n', '<C-o>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    vim.api.nvim_buf_set_keymap(buf, 'n', 'q',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    vim.api.nvim_buf_set_keymap(buf, 'n', '<Esc>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    -- The panel can take focus (<C-w>w cycling): <C-o> closes it (mapped
    -- above), but <C-i>/<C-^> must not swap the panel into another buffer
    -- (the float inherited the jumplist).
    vim.keymap.set('n', '<C-i>', '<Nop>', { buffer = buf })
    vim.keymap.set('n', '<C-^>', '<Nop>', { buffer = buf })
    PC.lock_display_keys(buf) -- reasoning panel is display-only
    vim.api.nvim_buf_set_name(buf, 'dsh-reasoning-' .. tostring(id))
    S.reasoningBufs[id] = buf
  end
  return {
    reasoningBuf = buf,
    reasoningWin = S.reasoningWin,
    reasoningOpen = S.reasoningOpen,
  }
end

--- Reasoning panel float geometry: hugs the RIGHT screen edge, spanning
--- three quarters of the screen height (a panel, not a full-height column —
--- it may overlay the input area only when multi-line input grows tall).
--- The chat keeps its full width (the panel overlays its right side, like
--- the other popups). Shared formula with the ext panel slot (P2).
function SE.reasoning_panel_geometry()
  return require('dsh_tui.api').panel_geometry(0, ' 思考与工具记录 ', ' C-o 收起面板 · q 关闭 ')
end

--- Open/close the reasoning panel (a popup hugging the right edge). <C-o>.
--- FLOAT GUARD: the toggle only responds from the TUI's own split windows
--- (chat / input / the panel itself). From inside any OTHER float (subagent
--- chat input, pickers, approvals, fullscreen editor…) it would open the
--- panel behind/over the popup and I.focus() would yank focus into the main
--- input — the popup's content and keys are the user's context, so the
--- press is a NO-OP there.
function SE.toggle_reasoning()
  local cur = vim.api.nvim_get_current_win()
  local inPanel = S.reasoningWin ~= nil and vim.api.nvim_win_is_valid(S.reasoningWin)
    and cur == S.reasoningWin
  if cur ~= S.chat_win and cur ~= S.input_win and not inPanel then
    return
  end
  if S.reasoningWin and vim.api.nvim_win_is_valid(S.reasoningWin) then
    pcall(vim.api.nvim_win_close, S.reasoningWin, true)
    S.reasoningWin = nil
    S.reasoningOpen = false
  else
    local buf = S.activeId and S.reasoningBufs[S.activeId]
    if not (buf and vim.api.nvim_buf_is_valid(buf)) then
      if S.activeId then
        -- Canonical path: registers the buffer, locks the display keys and
        -- names it — a fallback-created ghost buffer would leak and stay
        -- editable (runner's idsProvider would never see it either).
        buf = SE.ensure_reasoning(S.activeId).reasoningBuf
      else
        buf = vim.api.nvim_create_buf(false, true)
        B.chat_buffer_options(buf)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '·· 思考与工具记录（<C-o> 收起）' })
      end
    end
    local cfg = SE.reasoning_panel_geometry()
    cfg.border = 'rounded'
    cfg.style = 'minimal'
    cfg.zindex = 30 -- above the chat, below menus/approvals
    S.reasoningWin = vim.api.nvim_open_win(buf, false, cfg)
    vim.wo[S.reasoningWin].number = false
    vim.wo[S.reasoningWin].signcolumn = 'no'
    vim.wo[S.reasoningWin].cursorline = false
    S.reasoningOpen = true
    -- Focus back on typing.
    I.focus()
  end
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-reasoning-toggled', S.reasoningOpen)
  end
  -- The reasoning panel participates in the region docks (LAST on the
  -- right — the deliberately claimed ext regions keep the top): re-lay.
  require('dsh_tui.api').region_reflow()
  return S.reasoningOpen
end

--- Evict one session's chat buffer (runner-side LRU reclamation): close
--- any window showing it, wipe the buffer, drop the registry entry.
function SE.close_chat(id)
  local buf = S.chats[id]
  if buf and vim.api.nvim_buf_is_valid(buf) then
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) == buf then
        pcall(vim.api.nvim_win_close, win, true)
      end
    end
    pcall(vim.api.nvim_buf_delete, buf, { force = true })
  end
  S.chats[id] = nil
end

--- Switch the visible chat to this session (the runner owns the entry list).
function SE.set_active(id)
  S.activeId = id
  local buf = S.chats[id]
  if buf and vim.api.nvim_buf_is_valid(buf) and S.chat_win and vim.api.nvim_win_is_valid(S.chat_win) then
    vim.api.nvim_win_set_buf(S.chat_win, buf)
  end
  -- Keep the reasoning panel on this session's thinking buffer.
  if S.reasoningWin and vim.api.nvim_win_is_valid(S.reasoningWin) then
    local rbuf = S.reasoningBufs[id]
    if rbuf and vim.api.nvim_buf_is_valid(rbuf) then
      vim.api.nvim_win_set_buf(S.reasoningWin, rbuf)
    end
  end
  -- A session-list float tracking the old session is now stale: close it.
  PP.close_session_list()
  require('dsh_tui.api').emit('ActiveSession', { id = id })
end

--- Buffer/window ids for the runner's renderer.
function SE.ids()
  local chatBuf = S.activeId and S.chats[S.activeId] or nil
  return {
    chatBuf = chatBuf,
    chatWin = S.chat_win,
    inputBuf = S.input_buf,
    inputWin = S.input_win,
    reasoningWin = S.reasoningWin,
    reasoningOpen = S.reasoningOpen,
  }
end

return SE
