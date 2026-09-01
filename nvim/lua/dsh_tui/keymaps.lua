--- dsh_tui.keymaps: the input-buffer keymaps (plus the inert ZZ/ZQ guard).
--- Everything routes through the require("dsh_tui") facade so the mappings
--- stay stable even as the facade's implementation is re-composed. The
--- self-heal layer (autocmds.lua) re-runs install() whenever a plugin wiped
--- the mappings.
local S = require('dsh_tui.state')
local K = {}

function K.install()
  local quit_cmd = '<Cmd>lua require("dsh_tui").quit()<CR>'
  vim.api.nvim_buf_set_keymap(S.input_buf, 'i', '<C-q>', quit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', '<C-q>', quit_cmd, { noremap = true })
  -- ZZ/ZQ would CLOSE the input window in normal mode — the TUI has no
  -- meaning without a prompt; make them inert (quit = <C-q> or /quit).
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', 'ZZ', '<Nop>', { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', 'ZQ', '<Nop>', { noremap = true })

  -- Input buffer (insert mode): <CR> submits, <C-CR> inserts a literal
  -- newline (multi-line input), <Up>/<Down> cycle history; <Tab>/<C-n>/
  -- <C-p>/<S-Tab> navigate the slash-command completion menu while it is
  -- open, <Esc> closes it first (a second <Esc> leaves insert mode).
  local submit_cmd = '<Cmd>lua require("dsh_tui").submit()<CR>'
  vim.api.nvim_buf_set_keymap(S.input_buf, 'i', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'i', '<C-CR>', '<CR>', { noremap = true })
  vim.keymap.set('i', '<Up>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').at_prev()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_prev()
    else
      require('dsh_tui').history_move(-1)
    end
  end, { buffer = S.input_buf })
  vim.keymap.set('i', '<Down>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').at_next()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_next()
    else
      require('dsh_tui').history_move(1)
    end
  end, { buffer = S.input_buf })
  vim.keymap.set('i', '<C-n>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').at_next()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_next()
    else
      require('dsh_tui').history_move(1)
    end
  end, { buffer = S.input_buf })
  vim.keymap.set('i', '<C-p>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').at_prev()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_prev()
    else
      require('dsh_tui').history_move(-1)
    end
  end, { buffer = S.input_buf })
  vim.keymap.set('i', '<Tab>', function() require('dsh_tui').cmd_next() end, { buffer = S.input_buf })
  vim.keymap.set('i', '<S-Tab>', function() require('dsh_tui').cmd_prev() end, { buffer = S.input_buf })
  -- <C-v> queues the macOS clipboard image for the next submit (runner side
  -- reads pbpaste). Text paste (Cmd+V / bracketed paste) is unaffected.
  vim.api.nvim_buf_set_keymap(S.input_buf, 'i', '<C-v>',
    '<Cmd>lua require("dsh_tui").paste_image()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', '<C-v>',
    '<Cmd>lua require("dsh_tui").paste_image()<CR>', { noremap = true })
  -- <C-c> asks the runner to abort the running turn (idle → notice).
  vim.api.nvim_buf_set_keymap(S.input_buf, 'i', '<C-c>',
    '<Cmd>lua require("dsh_tui").abort_turn()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', '<C-c>',
    '<Cmd>lua require("dsh_tui").abort_turn()<CR>', { noremap = true })
  vim.keymap.set('i', '<Esc>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').close_at_menu()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').close_cmd_menu()
    else
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', false)
    end
  end, { buffer = S.input_buf })

  -- <C-o> toggles the activity panel (overrides jumplist/insert-default
  -- only inside our own buffers).
  local reason_cmd = '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>'
  vim.api.nvim_buf_set_keymap(S.input_buf, 'i', '<C-o>', reason_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(S.input_buf, 'n', '<C-o>', reason_cmd, { noremap = true })
end

return K
