# dsh-nvim-tui

给 [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的
**Neovim 风格 TUI**：以 Neovim 作为终端渲染壳（内置 TUI 提供分屏、模态编辑、
extmark 等全部能力），一个 Node runner 作为 DSH 桥，把 agent 的事件流渲染进
nvim 缓冲区、把 nvim 的输入回传给 agent。

```
dsh --profile nvim-tui
└─ DSH host 组合 (dsh-base + nvim-tui-runner)
    └─ nvim-tui-runner (Node, Cordis 插件行)
        ├─ inject: agents / agentDefaultModel，订阅 session/event
        └─ spawn: nvim --listen <unix-socket>
             ├─ nvim 内置 TUI 渲染你的终端
             ├─ Lua UI (nvim/lua/dsh_tui)：chat buffer + prompt 输入窗 + 键位
             └─ msgpack-RPC 双向通信
                  Node → nvim: buf_set_lines 流式渲染 DSH 事件
                  nvim → Node: rpcnotify（输入、退出）→ agent.followup
```

## 特性速览

- **Neovim 原生体验**：聊天区就是普通 nvim buffer——搜索、复制、可视模式选择、
  你自己的 colorscheme / statusline / LSP 全部生效
- **流式渲染**：`·· thinking · 12.3s` 浮动活动指示 + `<C-o>` 右侧面板收思考与
  工具记录；工具卡片、subagent/workflow 卡片、GFM 表格框线渲染；子代理思考链
  回放**边思考边实时输出**
- **状态栏**：权限模式 · 模型 · effort · 缓存命中% · 上下文占用 · Σ token ·
  TTFT/吞吐 · 时长 · 预估成本 · provider 路由 · ⏳ 排队 / ⚙ jobs / 📋 待办 ·
  `⇢` 子代理寻址
- **转录增强**（对齐官方客户端）：📋 待办条、⋯ 压缩检查点、↻ 重试状态行、
  workflow 转录内嵌套回放、结构化工具结果逐条渲染
- **会话管理**：`/sessions` 工作区分组浏览器（📁 分组 + 未分组 + 归档隐藏）、
  `/fork` 分叉、启动自动续上次活跃会话（claude --continue 式）、`/rewind` 回退、
  `/search` 跨会话搜索、`/archive` 归档、`/queue` 消息队列
- **引用与补全**：`@` 文件引用 + **@session 会话引用**（官方规范 mention）；
  `/` 补全菜单含全部命令 + 技能条目
- **多模态识图**：原生 image 直发，或经 `dsh-vision-bridge` 本地 OCR 转文字；
  `<C-v>` 剪贴板读图、`/image <路径>`、粘贴 data URL
- **i18n**：runner 侧界面字典化，`/locale zh|en` 即时切换
- **斜杠命令**：50+ 命令，`/` 自动弹出补全菜单（命令名 + 说明实时过滤）

## 安装 / 运行

**一键安装**（npm 发布后，或私有 registry）：

```bash
dsh plugin --profile nvim-tui add dsh-nvim-tui   # 安装 + 自动加入 bundles
dsh --profile nvim-tui                            # 启动（真实终端里）
```

`dsh plugin add` 会自动把声明了 `dsh.bundle` 的依赖调和进 profile 的
bundles 层栈（无需手改 package.json）。首个 profile 首次使用时自动初始化
（bundle 层为 `@deepseek-ai/dsh-base`，从 dsh 安装锚点解析）。

**开发安装**（本地仓库直链）：

```bash
mkdir -p ~/.dsh/profiles/nvim-tui
#   package.json 依赖 "dsh-nvim-tui": "link:<本仓库绝对路径>"，
#   dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-nvim-tui"]
#   cordis.yml = []，cordis.patch.yml = []，pnpm-workspace.yaml（见仓库内模板）
dsh plugin --profile nvim-tui install
dsh --profile nvim-tui
```

> 本仓库根目录就是 bundle 本身：`cordis.patch.yml` 挂载 `nvim-tui-runner` 行，
> package.json 的 `dsh.bundle.patch` 声明了它。

启动后聊天区会显示版本横幅：`dsh-nvim-tui 0.1.0 (build YYYY-MM-DD HH:mm) · channel N`。
输入 `/help` 随时查看全部命令。

## 配置

runner 行的 config（profile 的 `cordis.patch.yml`，环境变量兜底）：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `config.loadUserConfig` | `true` | `false` → `-u NONE` 不加载用户 nvim 配置；环境变量 `DSH_NVIM_TUI_LOAD_USER_CONFIG=0` 等效 |
| `config.theme` | 无 | 高亮组覆盖表，见下 |
| `config.headless` | `false` | `true` 或 `DSH_NVIM_TUI_HEADLESS=1` → nvim `--headless`（无 TTY 测试模式） |
| `config.watchdogMs` / `config.dumpPath` | 120000 / `/tmp/dsh-nvim-tui-e2e-<pid>.txt` | headless 模式的兜底超时与聊天转储路径（env：`DSH_NVIM_TUI_WATCHDOG_MS` / `DSH_NVIM_TUI_DUMP`） |
| `config.resumeLatest` | `true` | 启动自动续上次活跃会话；`DSH_NVIM_TUI_RESUME_LATEST=0` 关闭，`DSH_NVIM_TUI_RESUME=<id>` / `config.resumeSessionId` 显式指定 |
| `config.locale` | `zh` | 界面语言 `zh`/`en`；环境变量 `DSH_NVIM_TUI_LOCALE` 等效，运行时 `/locale` 切换 |

**主题**：`config.theme` 是一个 `高亮组 → 属性` 映射，每组可给
`{ fg, bg, bold, italic, underline }`（颜色 `#rrggbb`）或 `{ link: '内置组' }`。
不覆盖的组保持默认（自动适配你的 colorscheme）。正文类内容默认跟随主题的
`Comment` 组（暗色观感），角色内容跟随对应组；亮色主题下自动回退为
Normal 混合的暗灰，不刺眼。

```yaml
# ~/.dsh/profiles/nvim-tui/cordis.patch.yml
- insert:
    - id: nvim-tui-runner
      name: 'dsh-nvim-tui'
      config:
        theme:
          DshTuiUser: { fg: '#7aa2f7', bold: true }
          DshTuiTool: { fg: '#e0af68' }
          DshTuiReasoning: { fg: '#565f89', italic: true }
          DshTuiError: { link: 'ErrorMsg' }
```

可用组：`DshTuiUser`（用户消息）· `DshTuiAssistant`（模型输出）·
`DshTuiNotice`（提示）· `DshTuiDivider`（分隔/表框）· `DshTuiDim`（列表等
未高亮文本）· `DshTuiError` · `DshTuiTool` · `DshTuiSubagent` ·
`DshTuiWorkflow` · `DshTuiCode`（行内代码/代码块）· `DshTuiBold` ·
`DshTuiReasoning`（思考）· `DshTuiPrompt`（输入行 `❯`）·
`DshTuiStatus`（状态栏）· `DshTuiActiveSession`。
也可用内置预设 `/theme default|dim|vivid|contrast|mono` 即时切换。

## 布局与键位

双窗布局：`对话区 / 输入窗`（会话列表是 `/sessions` 浮窗）。输入窗每行行首有
REPL 风格的 `❯` 提示符——它渲染在窗口的 status column 里，**不属于输入内容**：
不会被提交、也删不掉。运行中发送的消息会排队在当前回合结束后处理（对话区有
"已排队"提示 + 状态栏 ⏳ 计数，`/queue` 可查看/编辑/删除排队消息；想不排队
可用 `/btw` 侧问）。

| 键 | 作用 |
|---|---|
| 输入框直接输入 + `Enter` | 发送消息到当前会话（输入窗聚焦时自动处于 insert 模式） |
| 输入框 `<C-cr>` | 插入换行（多行输入，窗口高度自动 1..6 行跟随） |
| 输入框 `<Up>` / `<Down>` | 行尾处循环输入历史（可恢复草稿） |
| 输入框 `/` | 自动弹出**命令补全菜单**（浮动窗：全部命令 + 说明，随输入实时过滤） |
| 补全菜单 `<Tab>` / `<C-n>` / `<S-Tab>` / `<C-p>` | 下/上一个候选项（循环，超出 10 行自动滚动） |
| 补全菜单 `Enter` | 前缀时补全选中命令（再次 Enter 执行）；命令名已完整时直接执行 |
| 补全菜单 `<Esc>` | 关闭菜单并留在 insert 模式（再次 Esc 才退出 insert）；菜单未开时 `<C-p>`/`<C-n>` 同 `<Up>`/`<Down>` 循环历史 |
| 输入框 `<C-v>` | **剪贴板读图**（macOS）：把复制的图片（截图/拷贝的图片）排入待发送队列，回车随消息一起发送；`/image clear` 清空队列 |
| 输入框 `<C-c>` | **停止当前回合**（运行中中止、空闲时提示；等效 `/stop`） |
| `<C-o>` | 展开/收起活动面板（思考 + 工具记录，右侧 52 列，可滚动，仅覆盖本插件 buffer 的默认行为） |
| `/sessions` 浏览器：`j/k` 移动、`Enter` 打开会话 / 进入工作区操作（新建会话于此 / 重命名）、`Esc` 取消 | 工作区分组的会话浏览器（完整会话 id，归档隐藏） |
| 审批浮窗：`y` 允许 / `n` 或 `Esc` 拒绝 | 权限请求 |
| 提问浮窗：`j/k` 移动、`Space` 多选、`Enter` 确认/下一题、`Esc` 取消 | 用户提问 |
| `<Esc>` / `j` `k` | 回到 normal 模式、滚动 chat 窗口 |
| 聊天窗 normal 模式：`/` 搜索、`n/N` 下一个、`G` 跳到底部、`gg` 顶部、`y` 复制（可视模式选择）、`<C-o>` 面板 | 聊天区是普通 nvim buffer，搜索/复制/滚动原生可用 |
| `<C-q>` | 退出（通知 runner 销毁 agent 并退出 dsh） |
| `:qa` | 直接退出 nvim（runner 会跟着退出整个 dsh） |
| 终端标题栏 | 跟随活跃会话标题（`dsh · <会话标题>`，OSC 2，由 nvim 写回终端） |

## 斜杠命令

输入 `/` 即弹出补全菜单（命令名 + 说明，随输入过滤）；命令目录由 runner 启动时
推送给 nvim，与 `/help`、命令分发表共用同一份注册表，不会漂移。

| 分组 | 命令 | 作用 |
|---|---|---|
| 系统 | `/exit` `/quit` `/restart` | 退出（清理有 2.5s 上限 + 强制兜底）/ 重启 dsh 进程 |
| 系统 | `/help` `/sessions` `/panel` | 分组列出全部命令 / 工作区分组会话浏览器 / 活动面板 |
| 系统 | `/settings [edit \| set <ns> <key.path> <value>]` `/bell [on\|off]` | 设置总览（官方 descriptor 形状渲染 + 用户覆盖星标，i/o 直接打开 settings.yaml 编辑）/ 类型化写入 / 回合结束响铃开关 |
| 会话 | `/new [目录]` `/clear` | 新建会话（可指定 cwd，含目录选择器浮窗）/ 清屏 |
| 会话 | `/fork [directive]` `/branch` | 分叉当前会话（继承历史 + 血缘），directive 作为首条消息 |
| 会话 | `/btw <问题>` | 侧问：分叉新会话发送该问题，不打断当前对话 |
| 会话 | `/stop` | 中止当前回合（agent.cancel，清空排队与引导；等效 `<C-c>`） |
| 会话 | `/steer <directive>` | 引导注入：把指令排队给最近一步（空闲时会直接开一轮） |
| 会话 | `/compact` | 手动压缩上下文（compaction 引擎；返回压缩条数与 token 数） |
| 会话 | `/goal [new <目标>\|pause\|resume\|complete\|clear]` | 查看/管理目标（状态栏同步显示 🎯 进度） |
| 会话 | `/plan [on\|off\|status]` | 计划模式开关（状态栏显示 📋） |
| 会话 | `/rewind [第N条]` | 回退：选择一条用户消息边界，截断其后的会话内容并重建界面 |
| 会话 | `/rename <新标题>` | 钉住会话标题 |
| 会话 | `/search <关键词>` | 跨会话全文搜索（session-query-sqlite），命中可一键恢复 |
| 会话 | `/tasks [kill <job-id>]` | 任务（jobs）列表/取消单个 |
| 会话 | `/skills [技能名]` | 技能目录浏览（浮窗查看详情） |
| 会话 | `/fb up\|down [备注]` | 对最后一条助手消息点赞/点踩（message-feedback） |
| 会话 | `/subagents` | 子代理目录（思考链只读回放 + continuable 续聊 `subagents.followup`） |
| 会话 | `/workflow` | 工作流运行视图（阶段树 + agent 序列 + 日志；转录内嵌套回放） |
| 会话 | `/queue` | 消息队列：查看/编辑/删除排队消息、清空（agent inbox 投影，状态栏 ⏳ 计数） |
| 会话 | `/workspace [add <目录> [标题] \| delete <id>]` | 工作区管理（dsh-workspace：分组/排序/归档） |
| 会话 | `/archive [会话id]` | 归档会话（从所有列表隐藏，非破坏性） |
| 会话 | `/locale [zh\|en]` | 界面语言切换（runner 侧字典化；Lua 按键提示保持中文） |
| 信息 | `/context` | 上下文组成分解（≈used/capacity · system/tools/messages · claim 窗口，读 sessionProjections） |
| 信息 | `/plugins` | 宿主插件清单（loader 条目只读投影） |
| 模型 | `/models` | 模型/供应商目录（活路由 + 可配置 provider 清单 + 当前选择） |
| 会话 | `/attach [路径]` | 附加文件/目录（图片 = durable attachment，其余 = @ 路径引用）；`@` 输入即文件引用补全 |
| 会话 | `/image <路径> [提示]` | **多模态识图**：本地图片（png/jpg/webp/gif，支持 `~/`）随提示发送；macOS 无参数时读剪贴板图片；`/image clear` 清空 `<C-v>` 队列 |
| 模型 | `/model [provider/model]` | 无参浮窗选择，带参直接切换；热切 + 持久化默认 |
| 模型 | `/effort off\|high\|max\|auto` | 推理等级 |
| 模型 | `/preset [id]` | agent 预设（需 agent-presets 行；官方空白规则：仅未开始回合的会话可切换） |
| 审批 | `/yolo on\|off` | 审批策略全放行/逐项询问 |
| 审批 | `/permission [name]` | 权限预设（沙箱模式 + 审批策略组合）；危险全访问预设先弹确认 |
| 显示 | `/density` | 紧凑模式（工具卡片仅标题行） |
| 显示 | `/glance <cache\|context\|tokens\|cost\|elapsed\|total>` | 状态栏段显隐 |
| 显示 | `/theme default\|dim\|vivid\|contrast\|mono` | 内置高亮预设（不覆盖则跟随 colorscheme） |
| 显示 | `/layout default\|panel` | 布局预设（无参循环切换） |
| 信息 | `/cost` `/export` `/config` `/status` `/doctor` | 用量成本 / 导出转录 md / 配置摘要 / 会话快照 / 终端诊断 |
| 信息 | `/mcp` | MCP server 工具统计（按 server 分组） |
| 信息 | `/deliverables` | 本回合交付物（nvim 新标签页打开产物文件） |
| 信息 | `/trajectory` | 回合步骤轨迹 |
| 记忆 | `/remember <text>` `/memory [delete <id>]` | 项目记忆写入/浏览/删除（.dsh/memory/） |

依赖的宿主服务未装配时，对应命令会给出明确提示。

## 多模态识图

图片经 harness 的 durable attachment 管线发送——TUI 读字节 →
`attachments.saveImage()` 校验并落库 → 用户消息携带稳定 `image` 块 →
LLM 适配器在请求时解析为 data URL。两条能力路径：

1. **原生识图**：模型目录声明 `inputModalities: [text, image]`，且网关对模型
   透传 `image_url`（自建 text-only 网关会以
   `unknown variant image_url, expected text` 拒绝）；
2. **识图桥**（text-only 模型/网关推荐）：装配 `dsh-vision-bridge`（提供
   `visionBridge` 服务），图片在进入模型前经本地 macOS Vision OCR
   （`~/.dsh/scripts/feishu-ocr`，零成本离线；可选远程视觉模型兜底）转成
   文字描述注入，模型读文字"看图"。此时模型目录应保持 `[text]`，否则桥会
   按"原生识图"跳过转换。

发送前 TUI 会预检：模型原生识图 → 直发；有识图桥 → 提示"经识图桥转成文字
描述后发送"；两者皆无 → 明确报错而不是让回合死在适配器里。

> 旧会话遗留：装桥之前失败发送留下的带图消息会永久留在会话历史里，导致该会话
> 后续每轮都被适配器拒绝——用 `/rewind` 回退到带图消息之前即可修复（新会话
> 不会再产生这类残留）。

## 会话管理

- 每个会话独立的 chat buffer 与事件流；`/sessions` 是**工作区分组浏览器**
  （对齐官方侧栏）：`📁 工作区` 头 + 缩进会话 + 未分组区 + 持久化历史
  （标记 `历史`），标题 + **完整会话 id** 展示
- **工作区**（需 `dsh-workspace`/适配器服务）：`/workspace add|delete` 管理，
  工作区行内可新建会话于此 / 重命名；`/archive [id]` 归档会话（非破坏性，
  从所有分组隐藏）
- 子代理/派发会话（裸 UUID id，无 `session-` 前缀）不出现在列表，经
  `/subagents` 目录进入
- 退出时 flush 全部活跃会话（jsonl.zstd 持久化）；下次启动历史会话出现在列表，
  `Enter` 选中即通过 `agents.resume` 恢复并重放转录
- **自动续会话（claude --continue 式）**：启动时默认恢复本项目的"上次活跃会话"
  （状态记录在 `$DSH_HOME/dsh-nvim-tui-state.json`，无记录则回退到最新的
  持久化会话）；`/new` 随时开新。关闭：环境变量 `DSH_NVIM_TUI_RESUME_LATEST=0`
  或 `config.resumeLatest: false`；显式 `DSH_NVIM_TUI_RESUME=<id>` 优先
- 回合失败（缺凭据、网关错误等）以 `⚠` 行显式渲染在对话区，不再静默消失

## 状态栏与活动面板

- **状态行左侧**：动态权限模式（`sandbox/mode` → read-only / normal /
  full-access + `approval/policy` → ask / never）+ 快捷键提示
  （`/ 命令 · ctrl+o 面板 · ctrl+p 历史`）
- **状态行右侧**：模型 · effort（`◎max`）· 缓存命中%（会话累计）·
  上下文占用% + `◧ 已用/窗口`（最近一步的 billed 输入）· `Σ` 会话累计 token ·
  **TTFT / tok/s**（读官方 sessionStats 投影）· 会话时长 · 预估成本
  （内置公开定价表，未知模型诚实降级不显示）· provider 路由 · ⏳ 排队计数 ·
  ⚙ 运行中 jobs · 📋 待办计数 · `⇢` 子代理寻址；running 时带旋转动画 +
  运行时长，180ms 刷新；idle 30s 低频刷新
- **活动面板（`<C-o>`）**：思考过程 + 工具使用记录收进右侧面板，聊天区只显示
  浮动活动指示（`·· thinking · 12.3s` / `🔧 bash · 2.1s`），活动结束即消失、
  不写入聊天记录。面板按回合组织：思考块（全文 + `── thinking end · Ns ──`
  页脚）与工具卡片（🔧 调用 / ✓✗ 结果 · 耗时）按时间线累积，新回合自动清空，
  历史重放保留全量；turn 开始 800ms 仍无内容时显示跳动的 `·· thinking… Ns`
- **渲染层**：extmark 角色着色（用户/提示/工具/错误/子代理/工作流各自颜色，
  `default link` 自动适配你的 colorscheme）；`**粗体**`、`` `行内代码` ``、
  ```围栏代码块``` 剥离标记后以高亮 span 渲染；流式更新对上次视图做 diff
  后增量 `set_lines`
- **Markdown 表格**（Claude-TUI 风格）：GFM 表格渲染为对齐的框线表格
  （`┌┬┐ ├┼┤ └┴┘`）——**整表统一加粗**（单元格/`│`/`─`/转角同 weight，
  消除字体渲染造成的粗细不一）、数字列右对齐、显式 `:--:` 居中；列宽按
  **显示宽度**计算（中文/emoji 占 2 列）；流式输出期间无底边框，流结束自动补上
- **官方客户端对齐的转录元素**：`todo/write` → 📋 待办条（✓/…/· 标记）；
  `compaction/summary` → ⋯ 压缩检查点（条数 + ≈tokens + 摘要块）；
  `llm/retry` → ↻ 重试状态行（次数/上限/倒计时/失败原因）；
  `tool-workflow/*` → ◈ workflow 嵌套成员行；JSON 结构化工具结果逐条 itemize

聊天记录缓冲区禁用了 undo（`undolevels=-1`），在对话区按 `u` 不会撤销内容。

## 用户配置与插件

默认加载你自己的 nvim 配置和插件（colorscheme / statusline / LSP 等全部生效）：
dsh_tui 在 `VimEnter`（用户配置加载完成后）接管窗口布局，并会在 300ms/1.2s 时
检查布局是否被插件（如 dashboard）顶掉并自动重建。
如需纯净启动（不加载用户配置），给 runner 行加 `config: { loadUserConfig: false }`；
沙箱/CI 的 headless 测试模式会自动隔离 XDG 目录。

## 开发

```bash
npm install                      # neovim 客户端（+ dsh peer 依赖用于本地解析）
npm run build                    # TypeScript (src/) → lib/（strict，tsc，含 .d.ts）
npm run dev                      # tsc --watch（改动即重编，dsh hmr 随即热载）
npm run check                    # src + scripts 双 tsconfig 全量类型检查
npm run smoke                    # 无头冒烟：RPC 往返 + Lua 插件 + 事件渲染
                                 # （scripts/*.ts 经 Node ≥23.6 原生 type-stripping 直跑）
```

**端到端无头验证**（不需要真实终端，走完整 host→agent→渲染链路）：

```bash
DSH_HOME=$PWD/.dsh-test \
DSH_NVIM_TUI_HEADLESS=1 \
DSH_NVIM_TUI_PROMPT='请只回复两个字：好的' \
DSH_NVIM_TUI_DUMP=/tmp/e2e-dump.txt \
dsh --profile nvim-tui
# 首个 turn 结束后 chat buffer 全量落盘到 /tmp/e2e-dump.txt 并退出
```

**真模型回归**（需要 dsh 凭据）：

```bash
npm run e2e -- "你好，请只回复：收到"   # headless 跑一轮真回合并校验 dump
```

> `.dsh-test/` 是工作区内的 DSH_HOME 测试副本（profiles 的共享 node_modules
> 以符号链接复用 `~/.dsh/profiles/node_modules`），用于在沙箱/CI 里 boot。

## 发布

```bash
npm publish        # prepublishOnly 门禁：check（双 tsconfig）→ build → smoke
```

`files` 白名单已裁剪（lib / nvim / cordis.patch.yml / README）；peer 依赖
（`@deepseek-ai/dsh-agent`、`dsh-llm`）由 profile 内的 dsh-base 提供。

## 目录结构

```
src/                          TypeScript 源码（strict，唯一手写源）
  index.ts    Cordis 插件入口：spawn nvim → RPC → agent 生命周期 → 事件桥
  feed.ts     转录渲染器：DSH 事件 → chat buffer 行模型（节流刷新）
  types.ts    共享类型层：SessionEvent 判别联合 + 宿主服务结构接口
  i18n.ts     界面字典（zh 字面量 → en 查表，未知键回退中文）
  bridge.ts   nvim spawn / socket 连接（自建 socket + error 处理）
  table.ts    GFM 表格 → 框线表格转换（显示宽度对齐）
  stats.ts    状态栏统计：token/缓存/成本/时长 折叠与格式化
  images.ts   图片读取：文件 / macOS 剪贴板 / data URL 解析
lib/                          tsc 编译产物（.js + .d.ts；dsh 加载入口 main → lib/index.js）
nvim/lua/dsh_tui/init.lua     nvim 侧 UI：窗口布局、prompt 输入、键位、RPC
scripts/smoke.ts              无头冒烟测试（Node ≥23.6 直跑）
scripts/e2e.ts                真模型端到端回归
tsconfig.json / tsconfig.scripts.json   主构建 / scripts 检查配置
cordis.patch.yml              bundle patch：insert nvim-tui-runner 行
```

## 关键设计决策

- **不用 `nvim --embed`**：它会隐式 headless，网格渲染就得自己做。
  这里正常启动 nvim，用 `--listen` socket 驱动，内置 TUI 渲染终端。
- **默认加载用户配置**（`-u NONE` 仅是开关）：dsh_tui 在 VimEnter 后接管
  布局；headless/沙箱模式通过 XDG 隔离实现干净环境。
- **runner 行的 effect disposer 只拆 UI 不退出进程**：hmr 重载该行时
  dsh 继续运行，下一次 apply 会 spawn 新的 nvim。只有用户主动退出、
  nvim 退出、致命错误、信号才会走 `appExit`。
- **消息只从 `session/event` 渲染**（不本地回显），避免与转录重复。
- **TypeScript 源码 → 编译产物**：`src/*.ts` 经 tsc（strict）输出 `lib/`，
  dsh 按 npm 包入口加载编译产物；`.ts` 不能直接作入口（Node 对 node_modules
  内 `.ts` 拒绝 type-stripping，发布形态必挂）。scripts 用 Node ≥23.6 原生
  type-stripping 直跑，不进发布包。

## License

MIT

> 需求基线见 [REQUIREMENTS.md](./REQUIREMENTS.md)（由本仓库早期 README 转化，
> 按里程碑 M0–M7 记录需求与验收状态）。
