--- dsh_tui.file_view: file-tree browser and preview helpers.
---
--- The tree is nvim's own netrw `:Explore` (shipped with nvim), not a custom
--- listing: it already supports create/rename/delete, marks, and familiar
--- keys. It is registered with the layout guard so the boot guard does not
--- treat the split as a foreign window and wipe it.
--- @module dsh_tui.file_view

local M = {}

local function ensure_reg()
  local API = require('dsh_tui.api')
  local S = require('dsh_tui.state')
  local reg = S.extReg['dsh-file-tree']
  if reg == nil then
    reg = API.register({ id = 'dsh-file-tree', name = 'file tree' })
  end
  return reg
end

--- Open netrw rooted at `path` in a split. Returns true, or false + reason.
function M.tree(path)
  if vim.fn.exists(':Explore') == 0 then
    return false, 'netrw is disabled in this nvim'
  end
  pcall(vim.cmd, 'noautocmd split')
  local win = vim.api.nvim_get_current_win()
  local ok, err = pcall(vim.cmd, 'noautocmd Explore ' .. vim.fn.fnameescape(path))
  if not ok then
    pcall(vim.api.nvim_win_close, win, true)
    return false, tostring(err)
  end
  local buf = vim.api.nvim_get_current_buf()
  local reg = ensure_reg()
  if reg ~= nil then
    reg.windows[win] = 'tab'
    reg.buffers[buf] = true
  end
  pcall(vim.cmd, 'resize 20')
  return true
end

return M
