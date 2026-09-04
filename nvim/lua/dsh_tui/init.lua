--- dsh_tui: the Neovim-side UI of dsh-nvim-tui.
---
--- Window layout (the runner drives everything over msgpack-RPC):
---   +-----------------------------------------------------------+
---   | chat (active session)                    [reasoning panel]|
---   |                                           (optional float)|
---   +-----------------------------------------------------------+
---   | input (buftype=nofile, frame furniture, hint bar)         |
---   +-----------------------------------------------------------+
---
--- The Node runner attaches its channel via attach(), creates one chat
--- buffer per session (ensure_chat), renders DSH events into the right chat
--- buffer, switches the visible chat (set_active), and receives user input /
--- slash commands / session selection as rpcnotify.
---
--- ARCHITECTURE — init.lua is the PUBLIC FACADE only: it forwards the full
--- M.* API surface (runner + keymaps + smoke tests) and composes the few
--- cross-module intents (submit, menu routing). Every behavior domain lives
--- in its own module, with a strict one-way dependency graph:
---
---   state      shared mutable state — every module reads window/buffer
---              handles from here (the single source of truth)
---   buffer     buffer primitives (display-buffer options, input text,
---              completion-plugin opt-out)
---   highlight  DshTui* highlight groups + dim palette + treesitter tokens
---   statusline chat statusline + terminal title (OSC 2)
---   cmd_menu   slash-command completion float
---   at_menu    @-mention completion float (shares cmd_menu geometry)
---   input      input buffer: text get/set, dynamic height, frame marks,
---              history, fill/append, focus restore
---   session    chat/reasoning buffers, reasoning panel, set_active, ids
---   layout     window layout: input window build, mount, takeover, presets
---   rpc        runner-channel ops (attach/quit/bell/theme/…)
---   keymaps    input-buffer keymaps (re-runnable for the self-heal layer)
---   autocmds   self-heal + window-ownership + plugin-isolation autocmds
---   popup_core generic float family (approval / questions / picker)
---   popups     dedicated popups (skill, subagent, dir, lines, progress,
---              session list)
---
--- Back-compat: every M._xxx field the runner/tests introspect (M._cmdWin,
--- M._progress, M._sessWin, …) is a LAZY alias of the matching state field
--- (S.cmdWin, S.progress, S.sessWin, …) — see the metatable below.

-- ===========================================================================
-- Submodule preloading: bridge.ts registers dsh_tui itself in package.preload
-- (dofile on an absolute path) so require() works even when a user config
-- rebuilds runtimepath (lazy.nvim) or vim.loader's cache never scanned our
-- rtp entry. Submodules must survive the same rebuilds — register each of
-- them the same way, relative to this file.
-- ===========================================================================
do
  local src = debug.getinfo(1, 'S').source:gsub('^@', '')
  local dir = src:match('^(.*)[/\\]') or '.'
  local submodules = {
    'state', 'buffer', 'highlight', 'statusline', 'cmd_menu', 'at_menu',
    'input', 'session', 'layout', 'rpc', 'keymaps', 'autocmds',
    'popup_core', 'popups', 'subagent_chat', 'api',
  }
  for _, name in ipairs(submodules) do
    local key = 'dsh_tui.' .. name
    if package.preload[key] == nil then
      local path = dir .. '/' .. name .. '.lua'
      package.preload[key] = function() return dofile(path) end
    end
  end
end

local S = require('dsh_tui.state')
local B = require('dsh_tui.buffer')
local SL = require('dsh_tui.statusline')
local H = require('dsh_tui.highlight')
local R = require('dsh_tui.rpc')
local CM = require('dsh_tui.cmd_menu')
local I = require('dsh_tui.input')
local AM = require('dsh_tui.at_menu')
local PC = require('dsh_tui.popup_core')
local PP = require('dsh_tui.popups')
local SAC = require('dsh_tui.subagent_chat')
local SE = require('dsh_tui.session')
local L = require('dsh_tui.layout')
local K = require('dsh_tui.keymaps')
local A = require('dsh_tui.autocmds')
local API = require('dsh_tui.api')

--- Public facade table. Every M._xxx field the Node runner / smoke tests
--- introspect is an ALIAS of the matching state field, resolved lazily
--- through __index so it stays correct across nil↔value transitions and
--- whole-table swaps (S.progress / S.subagentView are REPLACED as a unit
--- when their floats open/close — an eager alias would go stale).
local M = setmetatable({}, {
  __index = function(_, key)
    if type(key) == 'string' and key:sub(1, 1) == '_' then
      return S[key:sub(2)]
    end
    return nil
  end,
})

--- The STABLE public extension surface for third-party nvim plugins
--- (register / ownership / events / primitives). The rest of M.* is
--- internal — runner + smoke tests only, no stability promise.
M.api = API

-- ---------------------------------------------------------------------------
-- Forwarded API — grouped by owning module. The runner (src/index.ts), the
-- keymaps and scripts/smoke.ts call every function through this facade.
-- ---------------------------------------------------------------------------

-- dsh_tui.highlight: groups + theme-adaptive dim palette + treesitter tokens
M.applyHighlights = H.applyHighlights
M.applyDimPalette = H.applyDimPalette
M.syntax_ft = H.syntax_ft
M.highlight_syntax = H.highlight_syntax

-- dsh_tui.statusline
M.set_statusline = SL.set
M.set_title = SL.set_title
M.reschedule_statusline = SL.reschedule

-- dsh_tui.cmd_menu
M.set_commands = CM.set_catalog
M.close_cmd_menu = CM.close
M.cmd_menu_state = CM.state
M.update_cmd_menu = CM.update

-- dsh_tui.at_menu
M.at_menu_open = AM.open
M.close_at_menu = AM.close
M.set_at_menu = AM.set
M.at_next = AM.next
M.at_prev = AM.prev
M.at_accept = AM.accept
M.update_at_menu = AM.update

-- dsh_tui.input (+ buffer primitives)
M.disable_external_completion = B.disable_external_completion
M.fill_input = I.fill
M.append_input = I.append
M.history_move = I.history_move
M.resize_input = I.resize
M.refresh_input_frame = I.refresh_frame

-- dsh_tui.session
M.ensure_chat = SE.ensure_chat
M.ensure_reasoning = SE.ensure_reasoning
M.reasoning_panel_geometry = SE.reasoning_panel_geometry
M.toggle_reasoning = SE.toggle_reasoning
M.set_active = SE.set_active
M.ids = SE.ids

-- dsh_tui.layout
M.apply_layout = L.apply_layout

-- dsh_tui.rpc
M.attach = R.attach
M.channel = R.channel
M.quit = R.quit
M.paste_image = R.paste_image
M.abort_turn = R.abort_turn
M.bell = R.bell
M.open_file_tab = R.open_file_tab
M.apply_theme = R.apply_theme

-- dsh_tui.popup_core: the generic float family
M.show_approval = PC.show_approval
M.approval_decide = PC.approval_decide
M.show_questions = PC.show_questions
M.redraw_questions = PC.redraw_questions
M.question_move = PC.question_move
M.question_toggle = PC.question_toggle
M.question_advance = PC.question_advance
M.questions_confirm = PC.questions_confirm
M.questions_cancel = PC.questions_cancel
M.show_picker = PC.show_picker
M.picker_move = PC.picker_move
M.picker_jump = PC.picker_jump
M.picker_confirm = PC.picker_confirm
M.picker_cancel = PC.picker_cancel

-- dsh_tui.popups: the dedicated popups
M.show_skill = PP.show_skill
M.close_skill = PP.close_skill
M.open_subagent_view = PP.open_subagent_view
M.subagent_view_jump = PP.subagent_view_jump
M.close_subagent_view = PP.close_subagent_view
M.subagent_view_ids = PP.subagent_view_ids
M.subagent_view_goto_thinking = PP.subagent_view_goto_thinking
M.show_dir_picker = PP.show_dir_picker
M.dir_jump = PP.dir_jump
M.dir_enter = PP.dir_enter
M.dir_up = PP.dir_up
M.close_dir_picker = PP.close_dir_picker
M.show_lines_float = PP.show_lines_float
M.close_lines_float = PP.close_lines_float
M.show_progress = PP.show_progress
M.progress_update = PP.progress_update
M.close_progress = PP.close_progress
M.show_session_list = PP.show_session_list
M.render_session_list = PP.render_session_list
M.session_list_move = PP.session_list_move
M.session_list_jump = PP.session_list_jump
M.session_list_select = PP.session_list_select
M.session_list_new = PP.session_list_new
M.close_session_list = PP.close_session_list
M.show_input_history = PP.show_input_history
M.input_history_select = PP.input_history_select
M.input_history_jump = PP.input_history_jump
M.close_input_history = PP.close_input_history

-- dsh_tui.subagent_chat: the subagent chat window (transcript + input)
M.open_subagent_chat = SAC.open
M.subagent_chat_submit = SAC.submit
M.subagent_chat_history = SAC.history_move
M.subagent_chat_resize = SAC.resize
M.close_subagent_chat = SAC.close
M.subagent_chat_ids = SAC.ids
M.subagent_chat_jump = SAC.jump
M.subagent_chat_goto_thinking = SAC.goto_thinking

-- ===========================================================================
-- Cross-module intent routing (facade territory): the two completion menus
-- share the input line, so user intents dispatch between them here.
-- ===========================================================================

--- <Tab>/<C-n>: the @-mention menu has priority while open; otherwise the
--- slash-command menu (open/filter/advance, or a literal <Tab>).
function M.cmd_next()
  if AM.open() then
    return AM.next()
  end
  CM.next()
end

--- <S-Tab>/<C-p>: the same routing, backwards.
function M.cmd_prev()
  if AM.open() then
    return AM.prev()
  end
  CM.prev()
end

--- Submit the input buffer (keymap <CR>): route slash commands, else send.
--- With the completion menu open, <CR> first completes the selected command
--- (or executes it directly when its name is already typed in full).
function M.submit()
  local text = B.input_text():gsub('^%s+', ''):gsub('%s+$', '')
  if text == '' then
    CM.close()
    AM.close()
    -- The <Cmd>lua mapping draws the (hidden, cmdheight=0) cmdline over the
    -- input's statusline row — the hint bar IS the last screen row. With no
    -- buffer change on this path nothing redraws it, leaving the bottom bar
    -- blank until some unrelated redraw. The blanking happens when the
    -- hidden cmdline CLOSES (after this handler returns), so the redraw must
    -- be scheduled to run after the whole keypress batch.
    vim.schedule(function()
      vim.cmd('redraw')
    end)
    return
  end
  -- Extension before-submit hooks (P3): each may veto (nil/false — the
  -- draft stays in the input box) or rewrite (string) the submission.
  for _, reg in pairs(S.extReg) do
    if type(reg.submitHooks) == 'table' then
      for _, hook in pairs(reg.submitHooks) do
        local ok, result = pcall(hook, text)
        if not ok then
          API.emit('ExtHookError', { id = reg.id, error = tostring(result) })
        elseif result == nil or result == false then
          return -- vetoed
        elseif type(result) == 'string' then
          text = result
        end
      end
    end
  end
  if AM.open() then
    AM.accept()
    return
  end
  if CM.state().open then
    local sel = S.cmdMatches[S.cmdIdx]
    CM.close()
    if sel and text ~= sel.name then
      -- A bare prefix is being typed: fill the selected command and let the
      -- user continue with its arguments (a second <CR> executes it).
      I.set_text(sel.name .. ' ')
      I.resize()
      CM.update(sel.name .. ' ')
      return
    end
  end
  if S.channel then
    if text:match('^/') then
      -- Lua-side extension commands execute HERE (never routed to the
      -- runner); everything else is the runner's business.
      local name, rest = text:match('^(%S+)%s*(.*)$')
      local extCmd = S.extCommands[name or '']
      if extCmd ~= nil then
        local ok, err = pcall(extCmd.fn, rest or '')
        if not ok then
          API.emit('ExtHookError', { id = extCmd.owner, error = tostring(err) })
        end
      else
        vim.rpcnotify(S.channel, 'dsh-command', text)
      end
    else
      vim.rpcnotify(S.channel, 'dsh-input', text)
    end
  end
  if S.history[#S.history] ~= text then
    table.insert(S.history, text)
  end
  S.histIdx = nil
  S.draft = nil
  vim.api.nvim_buf_set_lines(S.input_buf, 0, -1, false, { '' })
  I.resize()
end

-- ===========================================================================
-- Entry point
-- ===========================================================================

--- Entry: runs at VimEnter (after the user's config/plugins loaded).
function M.start()
  if S.started then
    return -- idempotent (e.g. reloaded in dev)
  end
  S.started = true
  -- This nvim instance is the dsh TUI: statusline plugins must not manage
  -- ANY window here (they rewrite the option on every WinEnter). The user's
  -- normal nvim sessions are unaffected.
  vim.g.ministatusline_disable = true
  -- Terminal title: nvim owns the terminal, so it must emit the OSC 2 title
  -- itself (the runner pushes the content via set_title).
  vim.o.title = true
  vim.o.titlestring = 'dsh'
  -- The cmdline row is dead space here (notices render in the chat) — reclaim
  -- it so the input hint bar is the very last screen row (nvim 0.9+).
  if vim.fn.has('nvim-0.9') == 1 then
    vim.o.cmdheight = 0
  end
  -- No tabline chrome in the TUI at all: the chat never renders a stray
  -- [No Name] label, and file tabs (open_file_tab) stay reachable via gt/gT.
  vim.o.showtabline = 0
  -- Mouse OFF in the TUI: nvim's insert mode follows the focus, so a mouse
  -- click into a popup while the input is typing drags insert into the
  -- popup. Window navigation is <C-w>/keyboard-first anyway — disabling the
  -- mouse removes the whole failure class at the source.
  vim.o.mouse = ''
  H.applyHighlights()
  L.takeover()
  I.make_buffer()
  L.build()
  K.install()
  A.install()

  -- Startup flash guard: plugins drawing right after VimEnter (alpha
  -- dashboard, filetree, …) open a window in our freshly built layout. Close
  -- any NON-floating window that is not part of the TUI in the SAME event
  -- cycle, so their UI never gets a frame. Active for a few seconds only.
  S.bootGuardUntil = vim.uv.now() + 3000
  S.mainTab = vim.api.nvim_get_current_tabpage()
  A.boot_guard()
  -- Some plugins open windows asynchronously after VimEnter (dashboards…).
  -- Re-claim the layout if one of our windows got replaced.
  local function reclaim()
    if not (S.chat_win and vim.api.nvim_win_is_valid(S.chat_win)
      and S.input_win and vim.api.nvim_win_is_valid(S.input_win)) then
      L.takeover()
      L.build()
      -- Extension handles went stale with the rebuild: tell the exts to
      -- re-resolve via api.handles().
      API.emit('LayoutRebuilt', {})
    end
  end
  vim.defer_fn(reclaim, 300)
  vim.defer_fn(reclaim, 1200)
  -- Belt-and-braces: lazy plugins can `hi clear` late without a ColorScheme
  -- event — re-assert the whole highlight set after the dust settles.
  vim.defer_fn(function() H.applyHighlights() end, 300)
  vim.defer_fn(function() H.applyHighlights() end, 1200)
end

return M
