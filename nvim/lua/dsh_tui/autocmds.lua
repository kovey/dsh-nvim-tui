--- dsh_tui.autocmds: the autocmd layer — the input buffer's own hooks
--- (text change → resize + menus, insert leave → close menus, completion
--- opt-out retries, frame sync), plus the global self-heal / ownership /
--- plugin-isolation net: WinEnter keymap re-assert + insert-drag snap,
--- WinClosed input rebuild, input-buffer clone guard, window-option
--- re-assert, reasoning panel re-anchor, colorscheme re-highlight, window
--- ownership discipline, and the post-startup flash guard.
local S = require('dsh_tui.state')
local I = require('dsh_tui.input')
local CM = require('dsh_tui.cmd_menu')
local AM = require('dsh_tui.at_menu')
local L = require('dsh_tui.layout')
local SE = require('dsh_tui.session')
local SL = require('dsh_tui.statusline')
local K = require('dsh_tui.keymaps')
local H = require('dsh_tui.highlight')
local B = require('dsh_tui.buffer')
local API = require('dsh_tui.api')
local A = {}

--- Buffer-scoped input autocmds (re-registered whenever the input buffer is
--- rebuilt — its bufhidden=hide keeps the buffer alive, but a plugin may
--- wipe its b: vars and hooks, so this must be re-runnable).
function A.install_input()
  -- Idempotent: a plugin may hijack the input window's buffer and wipe its
  -- surface; the WinEnter self-heal re-runs this — the augroup clears any
  -- previous hooks so nothing stacks.
  local grp = vim.api.nvim_create_augroup('dsh_tui_input', { clear = true })
  vim.api.nvim_create_autocmd('TextChanged', {
    group = grp,
    buffer = S.input_buf,
    callback = function()
      I.resize()
      CM.update()
      if not CM.open() then AM.update() end
    end,
  })
  vim.api.nvim_create_autocmd('TextChangedI', {
    group = grp,
    buffer = S.input_buf,
    callback = function()
      I.resize()
      CM.update()
      if not CM.open() then AM.update() end
    end,
  })
  -- Leaving insert mode (second <Esc>, <C-c>, a float taking focus…) closes
  -- the completion menus; re-entering refreshes them against the input text.
  vim.api.nvim_create_autocmd('InsertLeave', {
    group = grp,
    buffer = S.input_buf,
    callback = function()
      CM.close()
      AM.close()
    end,
  })
  -- Completion plugins lazy-load (nvim-cmp on InsertEnter); retry the
  -- per-buffer disable at every later opportunity until it sticks.
  vim.api.nvim_create_autocmd('User', {
    group = grp,
    pattern = 'VeryLazy',
    once = true,
    callback = function() B.disable_external_completion() end,
  })
  vim.api.nvim_create_autocmd('InsertEnter', {
    group = grp,
    buffer = S.input_buf,
    callback = function()
      vim.defer_fn(function()
        B.disable_external_completion()
        CM.update()
      end, 50)
    end,
  })
  -- Keep the frame's right edge in sync with the input rows (typing, undo,
  -- paste, history) — clearing and re-adding a handful of extmarks.
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
    group = grp,
    buffer = S.input_buf,
    callback = function() I.refresh_frame() end,
  })
end

--- The global autocmd layer (once per start()).
function A.install()
  -- Window navigation preserves the mode: <C-w>↑/<C-w>↓ into the input no
  -- longer yanks it back to insert (an explicit user choice — the input
  -- CAN stay in normal mode). Every flow that NEEDS insert mode starts it
  -- itself (submit, popup close, fill_input…).
  -- BUT insert mode drags along a focus switch (clicking the chat while the
  -- input is in insert makes the chat insert WITHOUT firing InsertEnter) —
  -- display splits snap straight back to normal.
  vim.api.nvim_create_autocmd('WinEnter', {
    callback = function()
      local w = vim.api.nvim_get_current_win()
      if S.input_win and w == S.input_win then
        -- Self-heal: a plugin may have wiped the input surface (keymaps /
        -- hooks) while it had the window — re-assert them whenever focus
        -- returns to the input.
        if S.input_buf and vim.api.nvim_buf_is_valid(S.input_buf) then
          local hasSubmit = false
          for _, m in ipairs(vim.api.nvim_buf_get_keymap(S.input_buf, 'i')) do
            if m.lhs == '<CR>' and type(m.rhs) == 'string' and m.rhs ~= '' then
              hasSubmit = true
              break
            end
          end
          if not hasSubmit then
            K.install()
            A.install_input()
          end
        end
        return
      end
      local ok, cfg = pcall(vim.api.nvim_win_get_config, w)
      if ok and cfg.relative ~= '' and cfg.relative ~= nil then return end -- floats
      if vim.bo[vim.api.nvim_win_get_buf(w)].buftype ~= 'nofile' then return end
      if vim.api.nvim_get_mode().mode ~= 'i' then return end
      -- Insert state dragged onto a display split (mouse click while typing):
      -- snap the split back to normal, and restore the INPUT's insert if
      -- that is where it was — the click must not strand typing mid-flow.
      local inputWasInsert = false
      if S.input_win and vim.api.nvim_win_is_valid(S.input_win) then
        inputWasInsert = vim.api.nvim_win_call(S.input_win, function()
          return vim.api.nvim_get_mode().mode
        end) == 'i'
      end
      vim.schedule(function()
        if vim.api.nvim_get_mode().mode == 'i'
          and (S.input_win == nil or vim.api.nvim_get_current_win() ~= S.input_win) then
          vim.api.nvim_input('<Esc>')
        end
        if inputWasInsert and S.input_win and vim.api.nvim_win_is_valid(S.input_win) then
          local saved = vim.api.nvim_get_current_win()
          if saved ~= S.input_win then
            vim.api.nvim_set_current_win(S.input_win)
            -- 'x' executes the key NOW (queued keys would hit the window
            -- that has focus by processing time).
            pcall(vim.api.nvim_feedkeys, 'i', 'nx', false)
            vim.api.nvim_set_current_win(saved)
          end
        end
      end)
    end,
  })
  -- Safety net 1: if the input window ever gets closed (ZZ / :q / plugins),
  -- rebuild it on the next tick — the TUI has no meaning without a prompt.
  vim.api.nvim_create_autocmd('WinClosed', {
    callback = function()
      local closed = tonumber(vim.fn.expand('<afile>'))
      if closed ~= S.input_win then return end
      vim.schedule(function()
        pcall(function()
          if S.buildingLayout or S.quitting then return end
          if S.input_win and vim.api.nvim_win_is_valid(S.input_win) then return end
          if not (S.chat_win and vim.api.nvim_win_is_valid(S.chat_win)) then return end
          if not (S.input_buf and vim.api.nvim_buf_is_valid(S.input_buf)) then return end
          -- bufhidden=hide: the buffer (typed draft included) survives —
          -- just rebuild the window around it. Buffer keymaps/autocmds are
          -- still attached.
          vim.api.nvim_set_current_win(S.chat_win)
          L.build_input_window()
          SL.apply()
          -- Enter insert on a LATER tick via a real keypress: `:startinsert`
          -- silently no-ops right after a window close (nvim's insert-mode
          -- machinery is still settling), but the i key always works.
          vim.schedule(function()
            if S.input_win and vim.api.nvim_win_is_valid(S.input_win) then
              vim.api.nvim_set_current_win(S.input_win)
              vim.api.nvim_input('i')
            end
          end)
        end)
      end)
    end,
  })
  -- Safety net 2: never allow a CLONE of the input buffer — :sp / :vsp from
  -- the input window would open synced look-alikes (content mirrors the
  -- real one); close any new non-float window that shows the input buffer.
  -- Splits of OTHER buffers (chat browsing) stay allowed.
  vim.api.nvim_create_autocmd('WinNew', {
    callback = function()
      vim.schedule(function()
        if S.buildingLayout then return end
        if not (S.input_win and vim.api.nvim_win_is_valid(S.input_win)) then return end
        if not (S.input_buf and vim.api.nvim_buf_is_valid(S.input_buf)) then return end
        local w = vim.api.nvim_get_current_win()
        if w == S.input_win then return end
        -- Registered extension windows are exempt from the clone guard.
        if API.is_ext_win(w) then return end
        local ok, cfg = pcall(vim.api.nvim_win_get_config, w)
        if ok and cfg.relative ~= '' and cfg.relative ~= nil then return end
        if vim.api.nvim_win_get_buf(w) == S.input_buf then
          pcall(vim.api.nvim_win_close, w, true)
        end
      end)
    end,
  })
  -- Extension windows closed from OUTSIDE (user :q, another plugin):
  -- notify the owner, then prune the stale exemption — a dead handle must
  -- not leave a permanent guard bypass behind.
  vim.api.nvim_create_autocmd('WinClosed', {
    callback = function()
      local closed = tonumber(vim.fn.expand('<afile>'))
      if closed == nil then return end
      local owners = {}
      for id, reg in pairs(S.extReg) do
        if reg.windows[closed] ~= nil
          or (reg.panel ~= nil and reg.panel.win == closed) then
          owners[#owners + 1] = id
        end
      end
      vim.schedule(function()
        for _, id in ipairs(owners) do
          API.emit('ExtWindowClosed', { id = id, win = closed })
        end
        if API.prune_dead_handles() and #owners > 0 then
          API.emit('ExtWindowsPruned', {})
        end
      end)
    end,
  })
  A.install_input()
  -- The input window's winbar IS the frame's top edge: any plugin that sets
  -- `winbar` (its own or ours) gets snapped back to the TUI's on the input
  -- window. (The --cmd OptionSet guard deliberately does NOT blank winbar —
  -- `:set winbar=` would erase this very frame edge.)
  vim.api.nvim_create_autocmd('OptionSet', {
    pattern = 'winbar',
    callback = function()
      if S.inputWinbar ~= nil then
        vim.schedule(function()
          pcall(function() vim.wo[S.input_win].winbar = S.inputWinbar end)
        end)
      end
    end,
  })
  vim.api.nvim_create_autocmd({ 'WinEnter', 'BufEnter', 'TabEnter', 'VimEnter', 'ModeChanged' }, {
    callback = function()
      -- User configs / lazy plugins keep flipping showtabline back to 2:
      -- re-assert the TUI's no-tabline stance on every window event.
      -- ModeChanged included: statusline plugins (mini.statusline et al.)
      -- rewrite the options the moment the mode flips (pressing i in the
      -- input used to wipe the frame + hint bar).
      if vim.o.showtabline ~= 0 then vim.o.showtabline = 0 end
      -- Same for the mouse: lazy plugins (VeryLazy) re-enable mouse=a after
      -- start(); the TUI is keyboard-first — keep it off.
      if vim.o.mouse ~= '' then vim.o.mouse = '' end
      -- Plugins like mini.statusline keep rewriting our windows' statuslines
      -- (rendering the startup buffer name): re-assert the TUI's own — blank
      -- chat line until the runner pushes the real one, helper bar on input.
      pcall(function() vim.wo[S.chat_win].statusline = S.statuslineText or '' end)
      pcall(function() vim.wo[S.input_win].statusline = S.inputStatusline end)
      pcall(function() vim.wo[S.input_win].fillchars = S.inputFillchars end)
      if S.inputWinbar ~= nil then
        pcall(function() vim.wo[S.input_win].winbar = S.inputWinbar end)
      end
      SL.reschedule()
    end,
  })
  -- Terminal resize: the panel float is editor-relative — re-anchor it to
  -- the new right edge / height.
  vim.api.nvim_create_autocmd('VimResized', {
    callback = function()
      if S.reasoningWin and vim.api.nvim_win_is_valid(S.reasoningWin) then
        local cfg = SE.reasoning_panel_geometry()
        cfg.border = 'rounded'
        cfg.style = 'minimal'
        pcall(vim.api.nvim_win_set_config, S.reasoningWin, cfg)
      end
    end,
  })
  -- A colorscheme (re)applied after start() — lazy setups, mid-session
  -- switches — must not wash the highlights back to pure white.
  vim.api.nvim_create_autocmd('ColorScheme', {
    callback = function() H.applyHighlights() end,
  })
  -- Window ownership discipline: the chat and input windows may only ever
  -- show their own buffers. A plugin opening a file into one of them
  -- (nvim-tree select, :edit, :term…) gets the buffer RELOCATED into a
  -- fresh tab (focus follows) and the TUI window is restored. Plugin
  -- windows themselves are never touched — user plugins and the TUI stay
  -- isolated from each other.
  vim.api.nvim_create_autocmd({ 'BufWinEnter', 'WinEnter', 'WinNew', 'TabEnter' }, {
    callback = function()
      vim.schedule(function()
        if S.quitting or S.buildingLayout then return end
        local checks = {}
        if S.chat_win and vim.api.nvim_win_is_valid(S.chat_win) then
          checks[#checks + 1] = { 'chat', S.chat_win, (S.activeId and S.chats[S.activeId]) or nil }
        end
        if S.input_win and vim.api.nvim_win_is_valid(S.input_win) then
          checks[#checks + 1] = { 'input', S.input_win, S.input_buf }
        end
        for _, c in ipairs(checks) do
          local win, own = c[2], c[3]
          if own ~= nil and vim.api.nvim_buf_is_valid(own)
            and vim.api.nvim_win_get_buf(win) ~= own then
            local foreign = vim.api.nvim_win_get_buf(win)
            -- Restore the TUI window FIRST (even if the tab dance fails, the
            -- input box is back), then move the file into a fresh tab.
            pcall(vim.api.nvim_win_set_buf, win, own)
            vim.cmd('tabnew')
            pcall(vim.api.nvim_win_set_buf, 0, foreign)
          end
        end
        -- INPUT identity takeover: `:edit file` while the input is EMPTY
        -- renames the input buffer IN PLACE and loads the file into it (the
        -- buffer id never changes, so the window-swap check above cannot see
        -- it). Restore the input surface and open the file in a fresh tab.
        if S.input_win and vim.api.nvim_win_is_valid(S.input_win)
          and S.input_buf and vim.api.nvim_buf_is_valid(S.input_buf) then
          local taken = vim.bo[S.input_buf].buftype ~= 'nofile'
            or vim.api.nvim_buf_get_name(S.input_buf) ~= ''
          if taken then
            local path = vim.api.nvim_buf_get_name(S.input_buf)
            pcall(vim.api.nvim_buf_set_name, S.input_buf, '')
            pcall(function() vim.bo[S.input_buf].buftype = 'nofile' end)
            pcall(function() vim.bo[S.input_buf].bufhidden = 'hide' end)
            pcall(function() vim.bo[S.input_buf].swapfile = false end)
            pcall(vim.api.nvim_buf_set_lines, S.input_buf, 0, -1, false, { '' })
            pcall(function() vim.bo[S.input_buf].modified = false end)
            pcall(vim.api.nvim_win_set_buf, S.input_win, S.input_buf)
            -- The takeover wiped the buffer's locals (b: vars, mappings):
            -- re-assert the whole input surface.
            vim.b[S.input_buf].ministatusline_disable = true
            K.install()
            A.install_input()
            B.disable_external_completion()
            if path ~= '' then
              vim.cmd('tabnew')
              pcall(vim.cmd, 'edit ' .. vim.fn.fnameescape(path))
            end
          end
        end
      end)
    end,
  })
  vim.defer_fn(function() B.disable_external_completion() end, 300)
  vim.defer_fn(function() B.disable_external_completion() end, 1200)
end

--- Startup flash guard: plugins drawing right after VimEnter (alpha
--- dashboard, filetree, …) open a window in our freshly built layout. Close
--- any NON-floating window that is not part of the TUI in the SAME event
--- cycle, so their UI never gets a frame. Active for a few seconds only.
function A.boot_guard()
  vim.api.nvim_create_autocmd({ 'WinNew', 'BufWinEnter' }, {
    callback = function()
      -- Deferred: during WinNew the float's config is not applied yet, so a
      -- same-cycle check would misread our own floats as normal windows and
      -- close them. By the scheduled tick the config is final.
      vim.schedule(function()
        if S.bootGuardUntil == nil or vim.uv.now() > S.bootGuardUntil then return end
        local w = vim.api.nvim_get_current_win()
        -- Only police the TUI's own tab: windows the window-ownership guard
        -- relocated into a fresh tab belong to the plugin and stay put.
        if vim.api.nvim_win_get_tabpage(w) ~= S.mainTab then return end
        -- Registered extension windows are exempt: extensions opt into the
        -- layout through api.register, everything else keeps the strict
        -- startup behaviour.
        if API.is_ext_win(w) then return end
        local ok, cfg = pcall(vim.api.nvim_win_get_config, w)
        local isFloat = ok and cfg.relative ~= '' and cfg.relative ~= nil
        if not isFloat and w ~= S.chat_win and w ~= S.input_win then
          pcall(vim.api.nvim_win_close, w, true)
        end
        local b = vim.api.nvim_get_current_buf()
        if API.is_ext_buf(b) then return end
        local chatBuf = S.activeId and S.chats[S.activeId] or nil
        if b ~= chatBuf and b ~= S.input_buf and vim.bo[b].buflisted then
          pcall(vim.api.nvim_buf_delete, b, { force = true })
        end
      end)
    end,
  })
end

return A
