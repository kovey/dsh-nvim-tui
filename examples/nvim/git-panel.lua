-- =============================================================================
-- 示例：一个 nvim 侧扩展（写入用户 nvim 配置，TUI 启动时会加载用户配置）。
-- 演示 dsh_tui.api 的注册、面板槽、before_submit 钩子、Lua 命令与 dsh-ext 总线。
--
-- 用法（放在 init.lua / lazy.nvim 插件里，dsh-nvim-tui 运行中生效）：
--   require('user.git_panel').setup()
-- 完整接口文档: docs/EXT-API.md
-- =============================================================================
local M = {}

local EXT_ID = 'git-panel'

function M.setup()
  local api = require('dsh_tui').api
  if api == nil then return end -- 不在 dsh TUI 实例里（普通 nvim 会话）

  local ok, err = api.register {
    id = EXT_ID,
    name = 'Git 面板',
    version = '1.0.0',
    events = { 'turn/end', 'tool/result' },
  }
  if not ok then return end

  -- 1) 右侧面板槽：单槽互斥，占用失败给 notice。
  local panel = api.panel_claim(EXT_ID, {
    width = 48,
    title = ' Git 面板 ',
    footer = ' q 关闭 · r 刷新 ',
    lines = { ' 面板内容通过 nvim_buf_set_lines 写入' },
  })
  if panel == nil then
    api.notice(EXT_ID, '⚠ 面板槽已被占用')
  else
    local function refresh()
      local ok2, branch = pcall(vim.fn.system, { 'git', 'branch', '--show-current' })
      local b = ok2 and vim.trim(branch) or '（不在 git 仓库）'
      vim.api.nvim_buf_set_lines(panel.buf, 0, -1, false, {
        ' 当前分支: ' .. b,
        '',
        ' - 面板 buffer 保持可写（编辑键已 Nop）',
        ' - 窗口由 TUI 负责 resize 重锚定',
      })
      vim.api.nvim_buf_set_keymap(panel.buf, 'n', 'r',
        string.format('<Cmd>lua require("user.git_panel").refresh()<CR>', EXT_ID),
        { noremap = true })
    end
    M.refresh = refresh
    refresh()
  end

  -- 2) 提交前钩子：拦截一个示例词（演示 veto / 改写）。
  api.before_submit(EXT_ID, function(text)
    if text == '禁止发送' then return nil end -- 否决：草稿留在输入框
    if text == '触发改写' then return '已被 git-panel 改写' end
    return text
  end)

  -- 3) Lua 侧斜杠命令：本地执行，并入 / 补全目录。
  api.register_command(EXT_ID, 'gitp', '打开/刷新 git 面板', function()
    api.notice(EXT_ID, 'git 面板示例命令执行')
    if M.refresh then M.refresh() end
  end)

  -- 4) 会话事件镜像（register 时声明了 events 才有投递）。
  api.on_session_event(EXT_ID, function(ev)
    if ev.type == 'turn/end' then
      api.notice(EXT_ID, '回合结束（git-panel 收到镜像事件）')
    end
  end)

  -- 5) dsh-ext 总线：
  --    Node → Lua: 某 dsh 插件调 tui.luaExt.call('git-panel', 'currentBranch')
  api.rpc_register(EXT_ID, 'currentBranch', function()
    local ok3, branch = pcall(vim.fn.system, { 'git', 'branch', '--show-current' })
    return ok3 and vim.trim(branch) or nil
  end)
  --    Node → Lua 事件: tui.luaExt.emit('git-panel', 'refresh', …)
  api.on_ext_event(EXT_ID, function(event)
    if event == 'refresh' and M.refresh then M.refresh() end
  end)

  -- 6) 活跃会话切换跟随（User autocmd + last_event 读取载荷）。
  vim.api.nvim_create_autocmd('User', {
    pattern = 'DshTuiActiveSession',
    callback = function()
      local id = api.last_event() and api.last_event().id
      if id then api.notice(EXT_ID, '切换到会话 ' .. id) end
    end,
  })
end

return M
