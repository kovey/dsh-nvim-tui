--- dsh_tui.buffer: buffer primitives shared by every module — display-buffer
--- options (chat / reasoning / panel), the per-buffer completion-plugin
--- opt-out, and reading the input buffer's text. Pure leaf module: no window
--- handles live here; callers read them from state.lua.
local S = require('dsh_tui.state')
local B = {}

--- Chat / reasoning / display buffers: nofile + 'hide' (they must survive
--- being hidden — the reasoning panel's buffer hides whenever the panel
--- closes and each chat buffer hides when another session becomes active;
--- 'wipe' would unload them, invalidate the ids the runner captured, and
--- silently break every later flush), no swap, no undo (chat history must
--- never be undoable with 'u'), and the mini.statusline per-buffer opt-out.
function B.chat_buffer_options(buf)
  vim.bo[buf].buftype = 'nofile'
  -- Display-only: clicking the chat while the input is in insert mode can
  -- drag the insert state along (nvim keeps it on the focus switch) — snap
  -- the display buffers straight back to normal mode.
  vim.api.nvim_create_autocmd('InsertEnter', {
    buffer = buf,
    callback = function()
      vim.schedule(function()
        if vim.api.nvim_get_current_buf() == buf then
          -- A real <Esc> keypress: :stopinsert can silently no-op right
          -- after a focus switch (same class as the restore's startinsert).
          vim.api.nvim_input('<Esc>')
        end
      end)
    end,
  })
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undolevels = -1
  -- Statusline plugins (mini.statusline, lualine, …) re-render the statusline
  -- on every event and would overwrite our per-window option. mini.statusline
  -- documents a per-buffer opt-out; lualine ignores disabled buffers too.
  vim.b[buf].ministatusline_disable = true
end

--- Disable the user's completion plugins (nvim-cmp etc.) for the input
--- buffer. cmp.setup.buffer applies to the CURRENT buffer, so this runs
--- inside nvim_buf_call; cmp itself lazy-loads on InsertEnter, so callers
--- retry at several later points until the override sticks.
function B.disable_external_completion()
  if S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then
    return
  end
  vim.api.nvim_buf_call(S.input_buf, function()
    vim.bo.completefunc = ''
    vim.bo.omnifunc = ''
    local ok, cmp = pcall(require, 'cmp')
    if ok and type(cmp) == 'table' and type(cmp.setup) == 'table'
      and type(cmp.setup.buffer) == 'function' then
      pcall(cmp.setup.buffer, { enabled = false })
    end
  end)
end

--- The input buffer's whole text (lines joined with '\n').
function B.input_text()
  return table.concat(vim.api.nvim_buf_get_lines(S.input_buf, 0, -1, false), '\n')
end

return B
