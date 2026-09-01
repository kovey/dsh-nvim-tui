--- dsh_tui.input: the input buffer — creation, text get/set, the dynamic
--- height (1..6 rows following the content), the frame's right-edge marks,
--- history cycling, fill/append helpers, and focus restore. The submit flow
--- itself lives in init.lua: it orchestrates the two completion menus and
--- the runner channel, which is facade territory.
local S = require('dsh_tui.state')
local B = require('dsh_tui.buffer')
local CM = require('dsh_tui.cmd_menu')
local I = {}

--- Create the input buffer. 'hide' not 'wipe': if anything closes the input
--- WINDOW (ZZ / :q / a plugin), the buffer — typed draft included — survives
--- and the WinClosed safety net just re-attaches it.
function I.make_buffer()
  S.input_buf = vim.api.nvim_create_buf(false, true)
  vim.bo[S.input_buf].bufhidden = 'hide'
  vim.bo[S.input_buf].swapfile = false
  vim.api.nvim_buf_set_lines(S.input_buf, 0, -1, false, { '' })
  -- Statusline plugins (mini.statusline et al.) must not render on our
  -- windows — the per-buffer opt-out applies to every dsh_tui buffer.
  vim.b[S.input_buf].ministatusline_disable = true
  B.disable_external_completion()
end

--- The input buffer's whole text (lines joined with '\n').
function I.text()
  return B.input_text()
end

--- Replace the input text and park the cursor at its end. Pure text write —
--- callers add resize / menu refresh where the change context needs it.
function I.set_text(text)
  local lines = vim.split(text, '\n', { plain = true })
  if #lines == 0 then
    lines = { '' }
  end
  vim.api.nvim_buf_set_lines(S.input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(S.input_win, { #lines, #(lines[#lines] or '') + 1 })
end

--- Dynamic input height: 1..6 rows following the content. The freed/taken
--- rows are applied to the CHAT window explicitly — nvim's split tree would
--- otherwise redistribute them to the sessions window, leaving a dead gap
--- row between the chat and the input.
function I.resize()
  local lc = vim.api.nvim_buf_line_count(S.input_buf)
  local n = math.min(6, math.max(1, lc))
  if S.input_win and vim.api.nvim_win_is_valid(S.input_win) then
    -- The window height counts the winbar row too: n text rows + winbar,
    -- plus the statusline hint bar below (the frame's bottom edge).
    vim.api.nvim_win_set_height(S.input_win, n + 1)
    -- Growing the window leaves nvim's leftover viewport offset from the
    -- pre-grow scroll (the cursor was on the bottom row, so the new text row
    -- renders as a bare `~` beyond-EOF row without the frame's │❯). Clamp
    -- the topline into the viewable range: snap to 1 when the buffer fits,
    -- keep the last n rows visible when it overflows the 6-row cap (a pasted
    -- block must not hide its own earlier lines).
    vim.api.nvim_win_call(S.input_win, function()
      local w0 = vim.fn.line('w0')
      local top = math.max(1, math.min(w0, lc - n + 1))
      if top ~= w0 then
        pcall(vim.fn.winrestview, { topline = top })
      end
    end)
    if S.chat_win and vim.api.nvim_win_is_valid(S.chat_win) then
      -- Row budget: chat text + chat statusline + input (winbar+n) + input
      -- statusline = lines - cmdheight.
      local chatH = vim.o.lines - vim.o.cmdheight - (n + 3)
      if chatH >= 1 then
        vim.api.nvim_win_set_height(S.chat_win, chatH)
      end
    end
  end
  I.refresh_frame()
end

--- The input frame's RIGHT edge: one right-aligned `│` mark per input row.
--- Splits take no borders, so the vertical edges are the statuscolumn on the
--- left and these marks on the right. Refreshed on every text change (cheap:
--- the input never exceeds a handful of rows).
function I.refresh_frame()
  if S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then return end
  vim.api.nvim_buf_clear_namespace(S.input_buf, S.frameNs, 0, -1)
  local n = math.max(1, vim.api.nvim_buf_line_count(S.input_buf))
  for i = 0, n - 1 do
    pcall(vim.api.nvim_buf_set_extmark, S.input_buf, S.frameNs, i, 0, {
      virt_text = { { '│', 'DshTuiBorder' } },
      virt_text_pos = 'right_align',
      hl_mode = 'combine',
      priority = 4096,
    })
  end
end

--- Fill the input line with `text` and hand back to the input in insert
--- mode (the command-completion menu's Enter logic, reused by /help).
function I.fill(text)
  if S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then return end
  I.set_text(text)
  I.resize()
  CM.update(text)
  I.focus()
end

--- Append text to the input line at the cursor (runner: /attach mentions).
function I.append(text)
  if S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(S.input_buf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(S.input_win)
  local line = lines[cur[1]] or ''
  lines[cur[1]] = line:sub(1, cur[2]) .. text .. line:sub(cur[2] + 1)
  vim.api.nvim_buf_set_lines(S.input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(S.input_win, { cur[1], cur[2] + #text })
  vim.cmd('startinsert')
  I.resize()
end

local function at_last_line_end()
  local cur = vim.api.nvim_win_get_cursor(S.input_win)
  local line = vim.api.nvim_buf_get_lines(S.input_buf, cur[1] - 1, cur[1], false)[1] or ''
  -- col 0 on an empty last line counts as its end (insert-mode cursor).
  return cur[1] == vim.api.nvim_buf_line_count(S.input_buf) and cur[2] >= #line
end

--- <Up>/<Down> history cycling (only at the last line's end; otherwise the
--- default movement is fed through).
function I.history_move(dir)
  if not at_last_line_end() then
    vim.api.nvim_feedkeys(
      vim.api.nvim_replace_termcodes(dir < 0 and '<Up>' or '<Down>', true, false, true), 'n', false)
    return
  end
  if S.histIdx == nil then
    S.draft = I.text()
    S.histIdx = #S.history
    if S.histIdx < 1 then
      S.histIdx = nil
      S.draft = nil
      return
    end
  else
    S.histIdx = S.histIdx + dir
  end
  if S.histIdx < 1 then
    S.histIdx = 1
  end
  if S.histIdx > #S.history then
    local txt = S.draft or ''
    I.set_text(txt)
    S.histIdx = nil
    S.draft = nil
    I.resize()
    CM.update(txt)
    return
  end
  I.set_text(S.history[S.histIdx])
  I.resize()
  CM.update(S.history[S.histIdx])
end

--- Hand the input window back to the user in insert mode (popup close,
--- panel toggle, fill_input…). Guarded: the input window may be mid-rebuild.
function I.focus()
  if S.input_win == nil or not vim.api.nvim_win_is_valid(S.input_win) then return end
  vim.api.nvim_set_current_win(S.input_win)
  vim.cmd('startinsert')
end

return I
