# dsh-nvim-tui

用 **Neovim 当渲染壳** 的 [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh)
TUI：聊天区就是普通 nvim buffer——搜索、复制、可视模式、你的 colorscheme / statusline /
LSP 全部生效。Node runner 通过 msgpack-RPC 把 agent 事件流渲染进去，把输入回传给 agent。

```
dsh --profile tui
└─ nvim-tui-runner（Node / Cordis 插件）
    ├─ 订阅 session/event，注入 agents / agentDefaultModel
    └─ spawn nvim --listen <socket>（内置 TUI 渲染终端）
         └─ msgpack-RPC 双向：事件 → buffer，输入 → agent.followup
```

## 快速开始

```bash
# 安装到 dsh 官方 tui profile
dsh plugin --profile tui add kovey/dsh-nvim-tui
dsh --profile tui
```

也可以装进任意自定义 profile（如 `nvim-tui`），两者等价：

```bash
dsh plugin --profile nvim-tui add kovey/dsh-nvim-tui
dsh --profile nvim-tui
```

`dsh plugin add` 会把声明了 `dsh.bundle` 的依赖并入该 profile 的 bundles 层栈，
无需手改 `package.json`。启动后输入 `/help` 查看命令，输入 `/` 弹出补全。

### 更新

```bash
# git 依赖用 #tag 重写 ref；update / --latest 推不动 git ref
dsh plugin --profile tui add "kovey/dsh-nvim-tui#<tag>"
```

宿主与插件版本的对应关系、逐版本升级步骤见 [UPGRADE.md](./UPGRADE.md)。

## 运行依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) | `>=0.2.0-rc.2 <0.2.2` | 已实测 0.2.0-rc.2 / 0.2.1-rc.1 / 0.2.1-rc.2；0.2.2 与 0.3.0 未验证，故意不声明兼容 |
| [Neovim](https://neovim.io) | 0.9+（推荐 0.10+） | 0.10+ 完整体验（输入框四边框、弹窗提示嵌入边框）；0.9 可运行但降级 |
| Node.js | 23.6+ | 跟随 dsh 的 `engines` 要求，通常无需单独安装 |

- **Neovim 0.9–0.12 全系列支持**：代码里只有 `nvim-0.9` / `nvim-0.10` 两档闸门，
  0.11 / 0.12 自动走完整分支；已逐项核对 0.12.6 的 breaking changes，均未使用。
- **注意预发布版**：dsh 的 `next` dist-tag 是 release candidate，`latest` 可能更旧；
  安装时显式带版本或 `@next`，别让 `npm i -g @deepseek-ai/dsh` 装回旧版。

## 主要特性

- **Neovim 原生体验**：聊天区 / 输入窗都是普通 buffer；围栏代码块与 diff 用你的
  treesitter + 配色方案高亮。
- **流式渲染**：`·· thinking · 12.3s` 浮动活动指示；思考与工具记录收进 `<C-o>`
  右侧面板，聊天区保持全宽。工具卡、GFM 框线表格（按显示宽度对齐、超宽自动折行）、
  Claude 风格代码块。
- **转录增强**：📋 待办条与 ⚙ 任务板钉在聊天区底部（实时更新，全部完成才写入转录）、
  ⋯ 压缩检查点、↻ 重试状态行、workflow 嵌套回放、子代理思考链边跑边输出；待办
  逐项更新由守卫强制（[说明](./docs/CONFIG.md#待办清单守卫)）。
- **文件改动**：write / edit 等工具调用自动渲染 `✎ 路径 (+N −M)` 统一 diff；
  `/changes` 汇总本会话改动，`/diff` 左右对照审阅。
- **会话管理**：`/sessions` 工作区分组浏览器、`/fork` 分叉、`/btw` 侧问、
  `/queue` 消息队列、`/search` 跨会话搜索、`/cwd` 切换工作目录；启动自动续上次
  活跃会话（类似 `claude --continue`）。
- **子代理与工作流**：`/subagents` 目录 + 对话窗（边跑边看，可续聊 continuable
  子代理）；`/workflow` 查看阶段树。
- **多模态识图**：原生 image 直发；当前模型不支持图像时自动临时切到官方识图模型，
  回合结束切回。`<C-v>` 读剪贴板图片、`/image` 指定文件。
- **输入效率**：`@` 文件 / `@session` 引用；`/` 命令补全（含宿主与插件注册的命令）；
  精确短语走自然语言命令，模糊语句交给模型判断是否执行（`tui_command` 工具）。
- **模型与状态栏**：模型 · effort · 缓存命中 · 上下文占用 · TTFT / tok/s · 成本 ·
  权限模式 · 排队 / jobs / 待办；`/difficulty` 按任务难度自动选模型。
- **扩展与生态**：`/market` 插件市场（安装 / 更新 / 热启停）、`/plugin` 直装；
  [EXT-API](./docs/EXT-API.md) 允许其他 dsh 插件和 nvim 插件在 TUI 内渲染 UI、
  订阅会话事件。
- **可定制**：`/theme` 预设或自定义高亮组、`/density`、`/layout`、`/whale`、
  `/glance`；`/locale zh|en` 切换界面语言。

## 键位

聊天区 normal 模式下 `j` / `k`、`/` 搜索、`n` / `N`、`gg` / `G`、`y` 等原生操作
都可用。运行中发送的消息会排队到当前回合结束（状态栏 ⏳ 计数，`/queue` 管理）。

| 键 | 作用 |
|---|---|
| `Enter` | 发送消息（输入窗聚焦时自动处于 insert 模式） |
| `<C-CR>` | 输入换行（窗口高度 1–6 行自适应） |
| `<C-e>` | 全屏输入：`Enter` 换行，`Esc` 进命令模式；命令模式下回车发送、`q` 丢弃 |
| `↑` / `↓` | 行尾循环输入历史（可恢复草稿） |
| `/` | 命令补全浮窗（`Tab` / `<C-n>` 切换，`Enter` 补全或执行） |
| `@` | 文件 / 会话引用补全 |
| `<C-v>` | 剪贴板读图（macOS），随消息发送 |
| `<C-c>` | 停止当前回合（同 `/stop`） |
| `<C-o>` | 展开 / 收起活动面板 |
| 审批浮窗 `y` / `a` / `n` | 允许一次 / 总是允许 / 拒绝 |
| 提问浮窗 `j` `k` / `Space` / `Enter` | 移动 / 多选 / 确认 |
| `<C-q>` / `:qa` | 退出（`:qa` 直接退 nvim，runner 随之退出整个 dsh） |
| `<Esc>` / `j` `k` | 回到 normal 模式 / 滚动聊天区 |
| 扩展卡片 `1-9` / `Enter` | 触发卡片动作 / 弹出动作菜单 |

## 斜杠命令

输入 `/` 弹出补全，`/help` 查看全部。常用命令：

| 分组 | 命令 |
|---|---|
| 会话 | `/sessions` `/new` `/fork` `/btw` `/queue` `/compact` `/cwd` `/search` |
| 模型 | `/model` `/models` `/effort` `/difficulty` |
| 视图 | `/panel` `/theme` `/density` `/layout` `/whale` `/locale` |
| 运维 | `/settings` `/deps` `/doctor` `/plugins` `/market` `/plugin` `/mcp` |
| 信息 | `/help` `/status` `/context` `/cost` `/changes` `/diff` `/export` |

完整命令表（67 个内置命令，按分组）见 [docs/COMMANDS.md](./docs/COMMANDS.md)。
宿主与其他插件注册的命令也会进入补全目录，可用 `/commands` 查看。

## 配置

runner 行的 `config:` 写在 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: nvim-tui-runner
      name: 'dsh-nvim-tui'
      config:
        theme:
          DshTuiUser: { fg: '#7aa2f7', bold: true }
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `loadUserConfig` | `true` | 加载你的 nvim 配置；`false` 等价 `-u NONE` |
| `theme` | — | 高亮组覆盖 |
| `headless` | `false` | 无 TTY 测试模式 |
| `resumeLatest` | `true` | 启动自动续上次活跃会话 |
| `locale` | `zh` | 界面语言 `zh` / `en` |
| `todoGuard` | `true` | 待办清单逐项更新守卫 |
| `difficultyRouting` | — | 难度路由配置 |

完整配置项、环境变量、主题组、难度路由与 headless / CI 用法见
[docs/CONFIG.md](./docs/CONFIG.md)。

## 开发

```bash
npm install
npm run build    # src/（TypeScript strict）→ lib/
npm run check    # 双 tsconfig 类型检查 + 架构 / 域操作门禁
npm run smoke    # 无头冒烟：RPC 往返 + Lua 插件 + 事件渲染
npm run e2e -- "你好，请只回复：收到"   # 真模型回归（需 dsh 凭据）
```

发布用 `npm publish`；`prepublishOnly` 会依次跑 `check` → `build` → `smoke`。

本地仓库直链安装：在 profile 的 `package.json` 里把依赖写成
`"dsh-nvim-tui": "link:<仓库绝对路径>"`，`dsh.profile.bundles` 包含
`"dsh-nvim-tui"`，然后运行 `dsh plugin --profile nvim-tui install`，再用
`dsh --profile nvim-tui` 启动。

目录结构、模块分层与关键设计决策见 [docs/STRUCTURE.md](./docs/STRUCTURE.md)；
架构演进与领域划分见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/COMMANDS.md](./docs/COMMANDS.md) | 斜杠命令完整参考 |
| [docs/CONFIG.md](./docs/CONFIG.md) | 配置项、环境变量、主题、难度路由、headless |
| [docs/EXT-API.md](./docs/EXT-API.md) | 插件开放接口（Node / Lua 两面） |
| [docs/STRUCTURE.md](./docs/STRUCTURE.md) | 目录结构与设计决策 |
| [UPGRADE.md](./UPGRADE.md) | 宿主与插件版本升级指南 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更记录 |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 需求基线（M0–M7 验收状态） |

## License

MIT
