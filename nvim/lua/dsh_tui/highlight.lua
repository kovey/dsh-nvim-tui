--- dsh_tui.highlight: highlight groups, the theme-adaptive dim palette, and
--- the treesitter token pass for fenced/diff code blocks in the chat.
local S = require('dsh_tui.state')
local H = {}

--- Fence language / file extension → nvim filetype (nil = unsupported).
function H.syntax_ft(lang)
  if type(lang) ~= 'string' then return nil end
  local l = lang:lower():gsub('[^%w_+-]', '')
  if l == '' then return nil end
  local aliases = {
    -- short/alias forms
    js = 'javascript', jsx = 'javascriptreact', ts = 'typescript', tsx = 'typescriptreact',
    py = 'python', rb = 'ruby', sh = 'sh', bash = 'sh', zsh = 'sh',
    yml = 'yaml', yaml = 'yaml', json = 'json', jsonc = 'jsonc',
    md = 'markdown', markdown = 'markdown', html = 'html', css = 'css', scss = 'scss',
    vue = 'vue', svelte = 'svelte', go = 'go', rs = 'rust', c = 'c', h = 'c',
    cpp = 'cpp', hpp = 'cpp', java = 'java', kt = 'kotlin', lua = 'lua', vim = 'vim',
    sql = 'sql', toml = 'toml', ini = 'ini', dockerfile = 'dockerfile',
    -- nvim-treesitter renamed grammars: `php` IS the phpdoc parser; the real
    -- PHP code grammar is `php_only`.
    php = 'php_only', php_only = 'php_only',
    swift = 'swift', zig = 'zig', tf = 'terraform', hcl = 'hcl',
    cs = 'csharp', fs = 'fsharp', scala = 'scala', r = 'r', dart = 'dart',
    perl = 'perl', elixir = 'elixir', erl = 'erlang', hs = 'haskell',
    -- full filetype names (fences spell the language, e.g. ```python)
    python = 'python', javascript = 'javascript', javascriptreact = 'javascriptreact',
    typescript = 'typescript', typescriptreact = 'typescriptreact', ruby = 'ruby',
    rust = 'rust', kotlin = 'kotlin', csharp = 'csharp', fsharp = 'fsharp',
    haskell = 'haskell', erlang = 'erlang', terraform = 'terraform',
  }
  if aliases[l] then return aliases[l] end
  -- Unknown language: no highlight (the flat code color stays) — the real
  -- parser gate happens inside highlight_syntax's pcall anyway.
  return nil
end

--- Apply treesitter highlight marks for code blocks onto `bufnr` (ns must be
--- the feed's token namespace). blocks = {{ lang, row, col, lines }} — row/col
--- are the block's origin in the TARGET buffer; lines are the code strings.
function H.highlight_syntax(bufnr, ns, blocks)
  if not (bufnr and vim.api.nvim_buf_is_valid(bufnr)) then return end
  local okSetup = pcall(require, 'nvim-treesitter')
  if not okSetup then return end -- no treesitter: keep the flat code color
  local scratch = S.syntaxScratch
  if not (scratch and vim.api.nvim_buf_is_valid(scratch)) then
    scratch = vim.api.nvim_create_buf(false, true)
    S.syntaxScratch = scratch
  end
  local targetLines = vim.api.nvim_buf_line_count(bufnr)
  for _, blk in ipairs(blocks or {}) do
    local lang, row, col, lines = blk and blk.lang, blk and blk.row, blk and blk.col, blk and blk.lines
    if type(lang) == 'string' and type(row) == 'number' and type(lines) == 'table'
      and #lines > 0 and row >= 0 and row < targetLines then
      local ft = H.syntax_ft(lang)
      if ft ~= nil then
        pcall(function()
          vim.bo[scratch].filetype = ft
          vim.api.nvim_buf_set_lines(scratch, 0, -1, false, lines)
          local parser = vim.treesitter.get_parser(scratch, ft)
          parser:parse(true)
          local query = vim.treesitter.query.get(ft, 'highlights')
          if query == nil then return end
          local root = parser:parse()[1]:root()
          local col0 = col or 0
          for id, node in query:iter_captures(root, scratch, 0, -1) do
            local r1, c1, r2, c2 = node:range()
            local lineText = lines[r1 + 1]
            if lineText ~= nil and row + r1 < targetLines then
              local s = col0 + c1
              local e = math.min(col0 + #lineText, col0 + c2)
              if e > s then
                pcall(vim.api.nvim_buf_set_extmark, bufnr, ns, row + r1, s,
                  { end_col = e, hl_group = '@' .. query.captures[id], priority = 4097 })
              end
            end
          end
        end)
      end
    end
  end
end

--- Role/span highlight groups: `default link` adapts to the user's colorscheme.
function H.applyHighlights()
  vim.cmd('highlight default link DshTuiActiveSession Title')
  vim.cmd('highlight default link DshTuiNotice Comment')
  vim.cmd('highlight default link DshTuiUser MoreMsg')
  vim.cmd('highlight default link DshTuiAssistant Comment') -- harness output: dimmer than Normal
  vim.cmd('highlight default link DshTuiDivider Comment')
  vim.cmd('highlight default link DshTuiError ErrorMsg')
  vim.cmd('highlight default link DshTuiTool Special')
  vim.cmd('highlight default link DshTuiSubagent Type')
  vim.cmd('highlight default link DshTuiWorkflow Identifier')
  vim.cmd('highlight default link DshTuiExt Structure')
  vim.cmd('highlight default link DshTuiCode Special')
  -- The popup bottom hint rows borrow the statusline look: floating windows
  -- get no real statusline, so the hint row is styled like one.
  vim.cmd('highlight default link DshTuiStatus StatusLine')
  -- Embedded popup footers (hints in the bottom border, nvim >= 0.10) keep
  -- the same statusline look instead of the default dim border color.
  vim.cmd('highlight default link FloatFooter DshTuiStatus')
  -- The input frame (winbar / statuscolumn / right-edge marks / statusline).
  vim.cmd('highlight default link DshTuiBorder WinSeparator')
  -- File-change diff blocks (✎ header + +/− lines): GitHub-style add/del
  -- foregrounds; the row FILLS (theme-blended backgrounds) are applied in
  -- applyDimPalette so they adapt to the colorscheme's editor background.
  vim.cmd('highlight default DshTuiDiffAdd guifg=#3fb950 guibg=#16301e ctermfg=71 ctermbg=22')
  vim.cmd('highlight default DshTuiDiffDel guifg=#f85149 guibg=#3a1d1b ctermfg=203 ctermbg=52')
  -- Blue whale pixel art (chat wallpaper/watermark): one group per
  -- half-block color pair (fg=top pixel, bg=bottom pixel) — brand blue
  -- #4d6bfe body, near-white belly, dark eye, blush.
  vim.cmd('highlight default DshTuiWhale-B guifg=NONE guibg=#4d6bfe ctermfg=NONE ctermbg=63')
  vim.cmd('highlight default DshTuiWhaleB- guifg=#4d6bfe guibg=NONE ctermfg=63 ctermbg=NONE')
  vim.cmd('highlight default DshTuiWhaleBB guifg=#4d6bfe guibg=#4d6bfe ctermfg=63 ctermbg=63')
  vim.cmd('highlight default DshTuiWhaleBW guifg=#4d6bfe guibg=#f2f5fa ctermfg=63 ctermbg=255')
  vim.cmd('highlight default DshTuiWhaleEE guifg=#14204a guibg=#14204a ctermfg=17 ctermbg=17')
  vim.cmd('highlight default DshTuiWhalePP guifg=#f5a8b8 guibg=#f5a8b8 ctermfg=217 ctermbg=217')
  vim.cmd('highlight default DshTuiWhaleW- guifg=#f2f5fa guibg=NONE ctermfg=255 ctermbg=NONE')
  vim.cmd('highlight default DshTuiWhaleWB guifg=#f2f5fa guibg=#4d6bfe ctermfg=255 ctermbg=63')
  vim.cmd('highlight default DshTuiWhaleWW guifg=#f2f5fa guibg=#f2f5fa ctermfg=255 ctermbg=255')
  vim.cmd('highlight default link DshTuiBold Bold')
  vim.cmd('highlight default link DshTuiPrompt DshTuiUser') -- input-line '❯'
  -- Slash-command completion menu: the selection reuses the pum look.
  vim.cmd('highlight default link DshTuiCmdName MoreMsg')
  vim.cmd('highlight default link DshTuiCmdDesc Comment')
  vim.cmd('highlight default link DshTuiCmdSel PmenuSel')
  vim.cmd('highlight default link DshTuiCmdSelName PmenuSel')
  vim.cmd('highlight default link DshTuiCmdSelDesc PmenuSel')
  -- Markdown structure: headings stand out, quotes dim italic, links underline.
  vim.cmd('highlight default link DshTuiHeading Title')
  vim.cmd('highlight default DshTuiQuote gui=italic cterm=italic')
  vim.cmd('highlight default link DshTuiQuote Comment')
  vim.cmd('highlight default DshTuiLink gui=underline cterm=underline')
  H.applyDimPalette()
end

--- The TUI's palette: statusline fills + explicit dim foregrounds for plain
--- content (assistant output, thinking text, notices, dividers, list windows,
--- menu descriptions, typed input). The plain content FOLLOWS the theme's
--- Comment (the pre-regression look — molokai's tinted dim gray, not a flat
--- blend); only when the theme's Comment is bright or missing do we fall back
--- to blending Normal toward its background, so a white-Comment theme can
--- never glare again.
--- Re-applied on ColorScheme so late/lazy colorscheme applications (or a
--- mid-session switch) cannot wash the dims back to pure white.
function H.applyDimPalette()
  local normal_hl = vim.api.nvim_get_hl(0, { name = 'Normal' })
  local status_hl = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
  local comment_hl = vim.api.nvim_get_hl(0, { name = 'Comment' })
  local function blend24(c1, c2, t)
    if type(c1) ~= 'number' or type(c2) ~= 'number' then return c1 end
    local function ch(c, s)
      return math.floor((c / 2 ^ s) % 256)
    end
    local r = math.floor(ch(c1, 16) + (ch(c2, 16) - ch(c1, 16)) * t + 0.5)
    local g = math.floor(ch(c1, 8) + (ch(c2, 8) - ch(c1, 8)) * t + 0.5)
    local b = math.floor(ch(c1, 0) + (ch(c2, 0) - ch(c1, 0)) * t + 0.5)
    return r * 65536 + g * 256 + b
  end
  -- nvim_get_hl returns colors as 24-bit numbers OR hex strings depending on
  -- how the colorscheme declared them — normalize so blends never bail out
  -- on a string color and silently fall back to the bright theme color.
  local function color24(c)
    if type(c) == 'number' then return c end
    if type(c) == 'string' then
      local r, g, b = c:match('^#(%x%x)(%x%x)(%x%x)$')
      if r then
        return tonumber(r, 16) * 65536 + tonumber(g, 16) * 256 + tonumber(b, 16)
      end
    end
    return nil
  end
  local function luma(c)
    return (math.floor(c / 65536) % 256) * 0.299
      + (math.floor(c / 256) % 256) * 0.587
      + (c % 256) * 0.114
  end
  local status_fg = color24(status_hl.fg)
  local normal_fg = color24(normal_hl.fg)
  local normal_bg = color24(normal_hl.bg) or 0x1e1e1e
  local comment_fg = color24(comment_hl.fg)
  -- nil → keep the theme's Comment link; a number → blend fallback (used
  -- only when the theme's Comment is missing or brighter than Normal text).
  local plain_fg = nil
  if type(normal_fg) == 'number' then
    if type(comment_fg) ~= 'number' or luma(comment_fg) > luma(normal_fg) then
      plain_fg = blend24(normal_fg, normal_bg, 0.55)
    end
  end
  -- The statusline ROW FILL uses StatusLine (active) / StatusLineNC
  -- (inactive) — bright in many themes (the white-bar illusion). This nvim
  -- instance IS the TUI, so both groups get the editor background here.
  vim.api.nvim_set_hl(0, 'StatusLine', { fg = status_fg or 0xa8a8a8, bg = normal_bg })
  vim.api.nvim_set_hl(0, 'StatusLineNC', { fg = status_fg or 0x8a8a8a, bg = normal_bg })
  vim.api.nvim_set_hl(0, 'DshTuiStatus', {
    fg = (status_fg and normal_fg and blend24(status_fg, normal_fg, 0.45)) or 0xc8c8c8,
    bg = normal_bg,
    bold = true,
  })
  -- The frame around the input box: dim neutral on the editor background so
  -- the border reads as a frame, never as a bright bar, and the '❯' accent
  -- still pops. Theme-adaptive: blends Normal toward its background.
  local border_fg = nil
  if normal_fg then border_fg = blend24(normal_fg, normal_bg, 0.45) end
  if border_fg == nil and status_fg then border_fg = blend24(status_fg, normal_bg, 0.6) end
  vim.api.nvim_set_hl(0, 'DshTuiBorder', { fg = border_fg or 0x8a8a8a, bg = normal_bg })
  -- Popup surfaces: the float background (which the rounded borders and
  -- their corner areas render on) follows the EDITOR background — many
  -- themes shade NormalFloat darker than Normal, which makes every popup
  -- border look like a dark frame floating on the chat. Flat, unobtrusive.
  vim.api.nvim_set_hl(0, 'NormalFloat', { bg = normal_bg })
  local floatBorderHl = vim.api.nvim_get_hl(0, { name = 'FloatBorder', link = false })
  vim.api.nvim_set_hl(0, 'FloatBorder', {
    fg = floatBorderHl.fg,
    bg = normal_bg,
  })
  -- The popup TITLE (the text on the top border) must sit on the same flat
  -- background: themes like this one give FloatTitle a literal black bg,
  -- which paints a dark block behind every title bar.
  local floatTitleHl = vim.api.nvim_get_hl(0, { name = 'FloatTitle', link = false })
  floatTitleHl.bg = normal_bg
  vim.api.nvim_set_hl(0, 'FloatTitle', floatTitleHl)
  -- Diff row colors FOLLOW THE THEME: read the colorscheme's own DiffAdd /
  -- DiffDelete (the user's normal diff look) so switching themes re-tints
  -- the +/− rows too. Only when the theme leaves a background empty do we
  -- blend the foreground into the editor bg (Claude-style filled rows on
  -- ANY theme). The row group carries the BACKGROUND ONLY — the text color
  -- belongs to the syntax tokens (priority 4097), which keeps token colors
  -- from fighting a row-level fg on the same text.
  local diffAddHl = vim.api.nvim_get_hl(0, { name = 'DiffAdd', link = false })
  local diffDelHl = vim.api.nvim_get_hl(0, { name = 'DiffDelete', link = false })
  local function diffRow(theme, fallbackFg, ratio)
    local fg = color24(theme.fg) or fallbackFg
    local bg = color24(theme.bg)
    if bg == nil then
      bg = blend24(normal_bg, fg, ratio)
    end
    return { bg = bg }
  end
  vim.api.nvim_set_hl(0, 'DshTuiDiffAdd', diffRow(diffAddHl, 0x3fb950, 0.20))
  vim.api.nvim_set_hl(0, 'DshTuiDiffDel', diffRow(diffDelHl, 0xf85149, 0.18))
  local function setDimGroup(group, ratio)
    if plain_fg == nil then
      vim.cmd('highlight default link ' .. group .. ' Comment')
    else
      vim.api.nvim_set_hl(0, group,
        { fg = ratio == 0.55 and plain_fg or blend24(normal_fg, normal_bg, ratio) })
    end
  end
  setDimGroup('DshTuiAssistant', 0.55) -- chat plain text (the bulk of content)
  setDimGroup('DshTuiReasoning', 0.50) -- thinking text / panel body
  setDimGroup('DshTuiNotice', 0.65) -- runner notices ('· …')
  setDimGroup('DshTuiDivider', 0.72) -- '── turn ──' separators
  setDimGroup('DshTuiCmdDesc', 0.65) -- completion-menu descriptions
  setDimGroup('DshTuiDim', 0.60) -- unhighlighted text in list windows
end

return H
