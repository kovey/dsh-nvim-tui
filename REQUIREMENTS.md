# dsh-nvim-tui 需求规格说明书

| 项 | 内容 |
|---|---|
| 文档版本 | 0.1.0 |
| 对应代码版本 | dsh-nvim-tui 0.1.0 |
| 来源 | 由仓库 README.md（开发期功能说明）整理转化而来 |
| 状态 | **全部需求已实现**（里程碑 M0–M7 均完成，见 §8） |

---

## 1. 背景与目标

给 [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh) 提供一个
**Neovim 风格的终端交互界面（TUI）**：

- 以 **Neovim 作为终端渲染壳**——内置 TUI 免费提供分屏、模态编辑、extmark 高亮等全部能力，不自行实现网格渲染；
- 一个 **Node runner 作为 DSH 桥**：把 agent 的事件流渲染进 nvim 缓冲区，把 nvim 的输入回传给 agent。

本项目的目标读者是 dsh 的使用者与维护者；本文档把已实现的交互方式固化为可追溯的需求基线。

## 2. 总体架构需求

### R-ARCH-1 组合结构

```
dsh --profile nvim-tui
└─ DSH host 组合 (dsh-base + nvim-tui-runner)
    └─ nvim-tui-runner (Node, Cordis 插件行)
        ├─ inject: agents / agentDefaultModel，订阅 session/event
        └─ spawn: nvim -u NONE --listen <unix-socket>
             ├─ nvim 内置 TUI 渲染你的终端
             ├─ Lua UI (nvim/lua/dsh_tui)：chat buffer + prompt 输入窗 + 键位
             └─ msgpack-RPC 双向通信
                  Node → nvim: buf_set_lines 流式渲染 DSH 事件
                  nvim → Node: rpcnotify（输入、退出）→ agent.followup
```

### R-ARCH-2 runner 职责

- runner 是**纯展示层**：所有 agent 状态均来自宿主服务与事件
  （`agents`、`agentDefaultModel`、`session/event`、`appExit`），不持有模型逻辑。
- 通过 `ctx.inject(['agents', 'agentDefaultModel', 'sessions'])` 接入宿主运行时。
- 启动后静默本进程的 `console.log/warn/error`，避免 DSH 日志污染 TUI 画面。

### R-ARCH-3 RPC 协议

- `Node → nvim`：`buf_set_lines` 流式渲染；`attach` / `ensure_chat` / `set_active` /
  `show_session_list` / `set_commands`（命令补全目录）/ `apply_theme` 等 Lua 驱动。
- `nvim → Node`：`rpcnotify`——`dsh-input`（输入）、`dsh-command`（斜杠命令）、
  `dsh-session-select` / `dsh-session-new`（会话浮窗）、`dsh-approval-decided`（审批）、
  `dsh-questions-answered` / `dsh-questions-cancelled`（用户提问）、
  `dsh-picker-selected` / `dsh-picker-cancelled`（选择浮窗）、`dsh-paste-image`、
  `dsh-abort`、`dsh-reasoning-toggled`。

## 3. 部署与安装需求

### R-DEP-1 一键安装

```bash
dsh plugin --profile nvim-tui add dsh-nvim-tui   # 安装 + 自动加入 bundles
dsh --profile nvim-tui                            # 启动（真实终端里）
```

`dsh plugin add` 自动把声明了 `dsh.bundle` 的依赖调和进 profile 的 bundles 层栈
（无需手改 package.json）。

### R-DEP-2 profile 首次初始化

首个 profile 首次使用时自动初始化：bundle 层为 `@deepseek-ai/dsh-base`，从 dsh 安装锚点解析。

### R-DEP-3 开发安装（本地仓库直链）

```bash
mkdir -p ~/.dsh/profiles/nvim-tui
#   package.json 依赖 "dsh-nvim-tui": "link:<本仓库绝对路径>"，
#   dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-nvim-tui"]
#   cordis.yml = []，cordis.patch.yml = []，pnpm-workspace.yaml（见仓库内模板）
dsh plugin --profile nvim-tui install
dsh --profile nvim-tui
```

### R-DEP-4 bundle 自描述

仓库根目录即 bundle 本身：`cordis.patch.yml` 挂载 `nvim-tui-runner` 行
（稳定插件 id），package.json 的 `dsh.bundle.patch` 声明了它。

## 4. 配置需求

### R-CFG-1 runner 行 config（profile 的 `cordis.patch.yml`，环境变量兜底）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `config.loadUserConfig` | `true` | `false` → `-u NONE` 不加载用户 nvim 配置；环境变量 `DSH_NVIM_TUI_LOAD_USER_CONFIG=0` 等效 |
| `config.theme` | 无 | 高亮组覆盖表，见 R-CFG-3 |
| `config.headless` | `false` | `true` 或 `DSH_NVIM_TUI_HEADLESS=1` → nvim `--headless`（无 TTY 测试模式） |
| `config.watchdogMs` / `config.dumpPath` | 120000 / `/tmp/dsh-nvim-tui-e2e-<pid>.txt` | headless 模式的兜底超时与聊天转储路径（env：`DSH_NVIM_TUI_WATCHDOG_MS` / `DSH_NVIM_TUI_DUMP`） |
| `config.resumeLatest` | `true` | 启动自动续上次活跃会话；`DSH_NVIM_TUI_RESUME_LATEST=0` 关闭，`DSH_NVIM_TUI_RESUME=<id>` / `config.resumeSessionId` 显式指定 |
| `config.prompt` | 无 | headless e2e 模式自动发送的首条消息（env：`DSH_NVIM_TUI_PROMPT`） |

### R-CFG-2 主题覆盖

`config.theme` 是一个 `高亮组 → 属性` 映射，每组可给
`{ fg, bg, bold, italic, underline }`（颜色 `#rrggbb`）或 `{ link: '内置组' }`。
不覆盖的组保持默认（自动适配你的 colorscheme）。

### R-CFG-3 默认暗色内容

正文类内容（模型输出、思考文本、提示、分隔线、会话列表中的非活动条目、输入行）
**跟随主题的 `Comment` 组**（molokai 下即其自带的暗灰蓝调）；仅当主题的 Comment
比正文还亮（或缺失）时，TUI 才回退为从 Normal 混合出的暗灰，保证亮色主题下也不刺眼。
角色点缀（用户消息、工具、错误、粗体、代码等）跟随主题对应组。

### R-CFG-4 主题配置示例

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

可用组：`DshTuiUser`（用户消息）· `DshTuiAssistant`（模型输出，默认暗色）·
`DshTuiNotice`（提示）· `DshTuiDivider`（分隔/表框）· `DshTuiDim`（列表等
未高亮文本）· `DshTuiError` · `DshTuiTool` · `DshTuiSubagent` ·
`DshTuiWorkflow` · `DshTuiCode`（行内代码/代码块）· `DshTuiBold` ·
`DshTuiReasoning`（思考）· `DshTuiPrompt`（输入行 `❯`）·
`DshTuiStatus`（状态栏）· `DshTuiActiveSession`。

### R-CFG-5 内置主题预设（`/theme`）

`default` / `dim` / `vivid` / `contrast` / `mono` 五档，不覆盖则跟随 colorscheme。

## 5. 功能需求

### 5.1 布局与输入交互

- **R-UI-1 双窗布局**：`对话区 / 输入窗`（无常驻会话列表；`/sessions` 弹出会话浮窗，
  展示**完整会话 id**）。
- **R-UI-2 REPL 提示符**：输入窗每行行首有 `❯`——它渲染在窗口的 status column 里，
  **不属于输入内容**：不会被提交、也删不掉。
- **R-UI-3 消息排队**：运行中发送的消息会排队在当前回合结束后处理
  （对话区有"已排队"提示）；想不排队可用 `/btw` 侧问。

键位需求：

| 编号 | 键 | 需求 |
|---|---|---|
| R-UI-K1 | 输入框直接输入 + `Enter` | 发送消息到当前会话（输入窗聚焦时自动处于 insert 模式） |
| R-UI-K2 | 输入框 `<C-cr>` | 插入换行（多行输入，窗口高度自动 1..6 行跟随） |
| R-UI-K3 | 输入框 `<Up>` / `<Down>` | 行尾处循环输入历史（可恢复草稿） |
| R-UI-K4 | 输入框 `/` | 自动弹出**命令补全菜单**（浮动窗：全部命令 + 说明，随输入实时过滤） |
| R-UI-K5 | 补全菜单 `<Tab>` / `<C-n>` / `<S-Tab>` / `<C-p>` | 下/上一个候选项（循环，超出 10 行自动滚动） |
| R-UI-K6 | 补全菜单 `Enter` | 前缀时补全选中命令（再次 Enter 执行）；命令名已完整时直接执行 |
| R-UI-K7 | 补全菜单 `<Esc>` | 关闭菜单并留在 insert 模式（再次 Esc 才退出 insert）；菜单未开时 `<C-p>`/`<C-n>` 同 `<Up>`/`<Down>` 循环历史 |
| R-UI-K8 | 输入框 `<C-v>` | **剪贴板读图**（macOS）：把复制的图片排入待发送队列，回车随消息一起发送；`/image clear` 清空队列 |
| R-UI-K9 | 输入框 `<C-c>` | **停止当前回合**（运行中中止、空闲时提示；等效 `/stop`） |
| R-UI-K10 | `<C-o>` | 展开/收起活动面板（思考 + 工具记录，右侧 45% 屏宽（30–52 列），可滚动，仅覆盖本插件 buffer 的默认行为） |
| R-UI-K11 | `/sessions` 浮窗：`j/k` 移动、`Enter` 切换/恢复会话、`<C-n>` 新建、`q`/`Esc` 关闭 | 会话管理（完整会话 id 展示） |
| R-UI-K12 | 审批浮窗：`y` 允许 / `n` 或 `Esc` 拒绝 | 权限请求 |
| R-UI-K13 | 提问浮窗：`j/k` 移动、`Space` 多选、`Enter` 确认/下一题、`Esc` 取消 | 用户提问 |
| R-UI-K14 | `<Esc>` / `j` `k` | 回到 normal 模式、滚动 chat 窗口 |
| R-UI-K15 | 聊天窗 normal 模式：`/` 搜索、`n/N` 下一个、`G` 跳到底部、`gg` 顶部、`y` 复制（可视模式选择）、`<C-o>` 面板 | 聊天区是普通 nvim buffer，搜索/复制/滚动原生可用 |
| R-UI-K16 | `<C-q>` | 退出（通知 runner 销毁 agent 并退出 dsh） |
| R-UI-K17 | `:qa` | 直接退出 nvim（runner 会跟着退出整个 dsh） |
| R-UI-K18 | 终端标题栏 | 跟随活跃会话标题（`dsh · <会话标题>`，OSC 2，由 nvim 写回终端） |

### 5.2 斜杠命令

- **R-CMD-1 补全与注册表一致**：输入 `/` 即弹出补全菜单（命令名 + 说明，随输入过滤）；
  命令目录由 runner 启动时推送给 nvim，与 `/help`、命令分发表共用同一份注册表
  （`commandSpecs`），不会漂移。

命令清单（按注册表分组）：

| 分组 | 命令 | 需求 |
|---|---|---|
| 系统 | `/exit` `/quit` `/restart` | 退出（清理：`closeNvimWindow` 最坏 ~1.95s + teardown 2.5s 上限，硬兜底 5s；restart 9s）/ 重启 dsh 进程 |
| 系统 | `/help` `/sessions` `/panel` | 分组列出全部命令 / 会话浮窗 / 活动面板 |
| 系统 | `/settings [edit]` `/bell [on\|off]` | 设置总览（可打开 settings.yaml）/ 回合结束响铃开关（审批始终响铃） |
| 会话 | `/new [目录]` `/clear` | 新建会话（可指定 cwd，含目录选择器浮窗）/ 清屏 |
| 会话 | `/fork [directive]` `/branch` | 分叉当前会话（继承历史 + 血缘），directive 作为首条消息 |
| 会话 | `/btw <问题>` | 侧问：分叉新会话发送该问题，不打断当前对话 |
| 会话 | `/stop` | 中止当前回合（agent.cancel，清空排队与引导；等效 `<C-c>`） |
| 会话 | `/steer <directive>` | 引导注入：把指令排队给最近一步（空闲时会直接开一轮） |
| 会话 | `/compact` | 手动压缩上下文（compaction 引擎；返回压缩条数与 token 数） |
| 会话 | `/goal [new <目标>\|pause\|resume\|complete\|clear]` | 查看/管理目标（状态栏同步显示 🎯 进度） |
| 会话 | `/plan [on\|off\|status]` | 计划模式开关（状态栏显示 📋） |
| 会话 | `/rewind [第N条]` | 回退：选择一条用户消息边界**截断**其后内容并重建界面。**宿主能力依赖**：`session.truncate` 在 dsh 0.1.5-rc.1 已移除 → 该宿主上命令只提示降级（不再提供截断），请在旧宿主使用或改用 `/fork` + 新会话 |
| 会话 | `/rename <新标题>` | 钉住会话标题 |
| 会话 | `/search <关键词>` | 跨会话全文搜索（`session-query-sqlite`）。**默认未启用**：该行默认 `openAt: never`，用 `/deps install`（或用 `/settings set session-query-sqlite openAt startup`）启用索引后才能命中 |
| 会话 | `/tasks [kill <job-id>]` | 任务（jobs）列表/取消单个 |
| 会话 | `/skills [技能名]` | 技能目录浏览（浮窗查看详情） |
| 会话 | `/fb up\|down [备注]` | 对最后一条助手消息点赞/点踩（message-feedback） |
| 会话 | `/subagents` | 子代理目录（思考链只读回放 + continuable 续聊 `subagents.followup`） |
| 会话 | `/workflow` | 工作流运行视图（阶段树 + agent 序列 + 日志） |
| 会话 | `/attach [路径]` | 附加文件/目录（图片 = durable attachment，其余 = @ 路径引用）；`@` 输入即文件引用补全（fileReferences 服务 + 本地扫描降级） |
| 会话 | `/image <路径> [提示]` | **多模态识图**：见 §5.3；`/image clear` 清空 `<C-v>` 待发送队列 |
| 模型 | `/model [provider/model]` | 无参浮窗选择，带参直接切换；热切 + 持久化默认 |
| 模型 | `/effort off\|high\|max\|auto` | 推理等级 |
| 模型 | `/difficulty [easy\|medium\|hard\|auto\|off]` | **按难度自动选模型**（见 §5.8）：规则定档 + 可选 LLM 分类器，临时切换档位模型，回合结束切回；状态栏档位徽标；`subagentPolicy` 同步官方子代理模型闸门 |
| 模型 | `/preset [id]` | agent 预设（标准/PTC/极简/创造，需 agent-presets 行；官方空白规则：仅未开始回合的会话可切换） |
| 审批 | `/yolo on\|off` | 审批策略全放行/逐项询问 |
| 审批 | `/permission [name]` | 权限预设（permissionPresets 服务：沙箱模式 + 审批策略组合） |
| 显示 | `/density` | 紧凑模式（工具卡片仅标题行） |
| 显示 | `/glance <cache\|context\|tokens\|cost\|elapsed\|total>` | 状态栏段显隐 |
| 显示 | `/theme default\|dim\|vivid\|contrast\|mono` | 内置高亮预设（不覆盖则跟随 colorscheme） |
| 显示 | `/layout default\|panel` | 布局预设 |
| 信息 | `/cost` `/export` `/config` `/status` `/doctor` | 用量成本 / 导出转录 md / 配置摘要 / 会话快照 / 终端诊断 |
| 信息 | `/mcp` | MCP server 工具统计（按 server 分组） |
| 信息 | `/deliverables` | 本回合交付物（nvim 新标签页打开产物文件） |
| 信息 | `/trajectory` | 回合步骤轨迹 |
| 记忆 | `/remember <text>` `/memory [delete <id>]` | 项目记忆写入/浏览/删除（.dsh/memory/） |

服务未装配时，对应命令给出明确提示（不静默失败）。

### 5.3 多模态识图

- **R-IMG-1 传输管线**：图片经 harness 的 durable attachment 管线发送——TUI 读字节 →
  `attachments.saveImage()` 校验并落库 → 用户消息携带稳定 `image` 块 →
  LLM 适配器在请求时解析为 data URL。
- **R-IMG-2 原生识图**：模型目录声明 `inputModalities: [text, image]`，且网关对模型
  透传 `image_url`（自建 text-only 网关会以 `unknown variant image_url, expected text` 拒绝）。
- **R-IMG-3 识图（OCR 桥已移除）**：`dsh-vision-bridge` 桥已在 v0.3.2 移除，不再推荐装配；
  当前路径见 README「图片消息」小节（原生多模态优先，其次 catalog 中 image 能力的官方模型）。
  （历史描述：装配 `dsh-vision-bridge`（提供
  `visionBridge` 服务），图片在进入模型前经本地 macOS Vision OCR
  （`~/.dsh/scripts/feishu-ocr`，零成本离线；可选远程视觉模型兜底）转成文字描述注入。
  此时模型目录应保持 `[text]`，否则桥按"原生识图"跳过转换。
- **R-IMG-4 发送前预检**：模型原生识图 → 直发；有识图桥 → 提示"经识图桥转成文字
  描述后发送"；两者皆无 → 明确报错而不是让回合死在适配器里。
- **R-IMG-5 图片入口**：`/image <路径>`（png/jpg/webp/gif，支持 `~/`）、
  macOS 无参数时读剪贴板（pbpaste）、`<C-v>` 排队、粘贴
  `data:image/...;base64,...` 到输入框回车自动作为图片附件。
- **R-IMG-6 旧会话遗留**：装桥之前失败发送留下的带图消息会永久留在会话历史里，
  导致该会话后续每轮都被适配器拒绝——**旧宿主**可用 `/rewind` 回退到带图消息之前修复；
  0.1.5-rc.1 无 `session.truncate`，改用新会话或 `/fork` 规避
  （新会话不会再产生这类残留）。

### 5.4 会话管理（M2）

- **R-SESS-1 会话隔离**：每个会话独立的 chat buffer 与事件流。
- **R-SESS-2 会话列表**：`/sessions` 浮窗显示标题 + **完整会话 id**
  （`session/title` 事件，LLM/fallback 自动生成）与持久化历史（标记 `历史`）。
- **R-SESS-3 列表过滤**：`/sessions` 按工作区分组展示项目级会话（`session-` 前缀）；
  子代理/派发会话（裸 UUID id）不出现在列表（经 `/subagents` 进入）；**其他工作目录的
  会话以「（其他目录）」行显式展示并可恢复**（跨目录 resume 受宿主支持），归档会话从
  各分组隐藏。
- **R-SESS-4 持久化与恢复**：退出时 flush 全部活跃会话（jsonl.zstd 持久化）；
  下次启动历史会话出现在列表，`<CR>` 选中即通过 `agents.resume` 恢复并重放转录。
- **R-SESS-5 自动续会话（claude --continue 式）**：启动时默认恢复本项目的
  "上次活跃会话"（状态记录在 `$DSH_HOME/dsh-nvim-tui-state.json`，无记录则回退到
  最新的持久化会话）；`/new` 随时开新。关闭：`DSH_NVIM_TUI_RESUME_LATEST=0` 或
  `config.resumeLatest: false`；显式 `DSH_NVIM_TUI_RESUME=<id>` 优先。
- **R-SESS-6 失败可见**：回合失败（缺凭据、网关错误等）以 `⚠` 行显式渲染在对话区，
  不再静默消失；启动时历史会话恢复失败也必须降级为新建会话并提示，不得拖垮 TUI。

### 5.5 工具调用与流转可视化（M3）

- **R-VIZ-1 工具卡片**：`tool/call` → `🔧 name(参数摘要)`；`tool/result` →
  `✓/✗ name · 耗时 · 结果/错误摘要`。
- **R-VIZ-2 状态行（左）**：动态权限模式（`sandbox/mode` → read-only / normal /
  full-access + `approval/policy` → ask / never）+ 快捷键提示
  （`/ 命令 · ctrl+o 面板 · ctrl+p 历史`）。
- **R-VIZ-3 状态行（右）**：模型 · effort（`◎max`）· **缓存命中%**（会话累计）·
  **上下文占用% + `◧ 已用/窗口`**（**最近一步**的 billed 输入，与窗口同口径可比）·
  **`Σ` 会话累计 token** · 会话时长 · **预估成本**（内置公开定价表，未知模型诚实
  降级不显示）· provider 路由；running 时带旋转动画 + 运行时长，**450ms** 刷新；
  idle 30s 低频刷新。
- **R-VIZ-4 活动面板（`<C-o>`）**：思考过程 + 工具使用记录都收进右侧面板，聊天区
  只显示**浮动活动指示**（`·· thinking · 12.3s` / `🔧 bash · 2.1s`），活动结束即消失、
  不写入聊天记录。面板按回合组织：每个思考块（全文 + `── thinking end · Ns ──` 页脚）
  与工具卡片按时间线累积，新回合自动清空，历史重放保留全量；流式续写不截断
  （重叠行重写）。turn 开始 800ms 仍无内容时显示跳动的 `·· thinking… Ns`。
- **R-VIZ-5 子代理**：`◇ subagent provider · child · completed · 耗时`
  （按 parentSession 路由到父会话）。
- **R-VIZ-6 工作流**：`◈ workflow 名称` / `◈ ─ 阶段` / `◈ workflow · 结局`
  （路由到当前会话）。
- **R-VIZ-7 渲染层**：extmark 角色着色（`default link` 自动适配 colorscheme）；
  `**粗体**`、`` `行内代码` ``、```围栏代码块``` 剥离标记后以高亮 span 渲染；
  流式更新对上次视图做 diff 后增量 `set_lines`；标题/引用/链接/行内码增强渲染。
- **R-VIZ-8 Markdown 表格**（Claude-TUI 风格）：自动识别 GFM 表格并渲染为对齐的
  框线表格（`┌┬┐ ├┼┤ └┴┘`）——表头加粗、边框暗色、数字列右对齐、显式 `:--:` 居中；
  列宽按**显示宽度**计算（中文/emoji 占 2 列）；流式输出期间无底边框，流结束自动补上。
- **R-VIZ-9 undo 禁用**：聊天记录缓冲区 `undolevels=-1`，对话区按 `u` 不撤销内容。

### 5.6 用户配置与插件兼容

- **R-PLUG-1 默认加载用户配置**：colorscheme / statusline / LSP 等全部生效；
  dsh_tui 在 `VimEnter`（用户配置加载完成后）接管窗口布局（`apply_layout`）。
  布局被 dashboard 一类插件顶掉时**不会自动重建**——用 `/restart` 或重新
  `:lua require("dsh_tui").apply_layout()` 恢复（`config.loadUserConfig: false` 可纯净启动）。
- **R-PLUG-2 纯净启动**：给 runner 行加 `config: { loadUserConfig: false }`。
- **R-PLUG-3 沙箱/CI 隔离**：headless 测试模式自动隔离 XDG 目录，实现干净环境。

### 5.7 官方能力对齐（M7）

- **R-M7-1 子代理目录** `/subagents`：思考链只读回放 + continuable 续聊
  （`subagents.followup`）。
- **R-M7-2 权限预设** `/permission`：`permissionPresets` 服务（沙箱模式 + 审批组合）。
- **R-M7-3 文件附加** `/attach` + `@` 补全：图片 = durable attachment，其余 =
  @ 路径引用；`fileReferences` 服务缺失时降级为本地扫描。
- **R-M7-4 交付物** `/deliverables`：本回合产物在 nvim 新标签页打开。
- **R-M7-5 工作流视图** `/workflow`：阶段树 + agent 序列 + 日志。
- **R-M7-6 设置** `/settings [edit]`：设置总览/打开 settings.yaml。
- **R-M7-7 轨迹** `/trajectory`：回合步骤轨迹（assistant 消息 + 工具调用/结果）。
- **R-M7-8 布局预设** `/layout default|panel`。
- **R-M7-9 响铃** `/bell`：回合结束响铃开关（审批始终响铃）。
- **R-M7-10 目录新建会话** `/new [目录]`：指定 cwd 建会话，含目录选择器浮窗。

### 5.8 难度路由（按任务难度选模型）

- **R-DIFF-1 档位模型**：`easy|medium|hard` 三档 → `{provider?, model, effort?}`，
  配置在 runner 行 `config.difficultyRouting.tiers`（HMR）；provider 缺省继承当前，
  档位未配置 = 不切换（用默认模型）。
- **R-DIFF-2 定档来源**：手动钉住（`/difficulty <tier>`，优先）→ LLM 分类器
  （`classifier.enabled`，任何失败回退规则）→ 规则评估（计划模式 / 活跃目标 /
  本回合工具失败数 / 关键词 / 消息长度）。
- **R-DIFF-3 切换语义**：发送前临时改写会话 `modelRef`，**回合结束自动切回**
  全局默认（复用识图临时切换的 switchAt/turn-end 恢复点；连续同档消息延长切换
  窗口）；`agentDefaultModel` 持久化默认永不被难度路由改写。
- **R-DIFF-4 用户意图优先**：手动 `/model` 暂停本会话自动路由；`/difficulty off`
  关闭；`/difficulty auto` 恢复。
- **R-DIFF-5 可见性**：状态栏档位徽标（🟢/🟡/🔴）；切换/切回 notice 明示原因
  （钉住/分类/规则）与目标模型；`/difficulty` 无参显示档位配置与状态。
- **R-DIFF-6 子代理联动**：`subagentPolicy: true` 时同步官方
  `subagent-model-selection` 闸门为档位模型集（子代理默认继承主会话模型，可
  在档位集内自选）；关闭路由时关闸。
- **R-DIFF-7 失效安全**：路由链任何异常不阻断消息发送（notice + 默认模型）；
  分类器超时上限（默认 8s）。

### 5.9 待办清单纪律（逐项更新硬约束）

- **R-TODO-1 常驻规则**：每个 agent 作用域注入 system-prompt 段落
  （`nvim-tui-todo-discipline`）：开始一项立即标 `in_progress`、完成一项立即
  `todo_write` 标 `completed`，禁止攒到最后一次性更新。
- **R-TODO-2 逐步提醒**：`agent/pre-step` 瀑布——某步有工具调用却未写清单且清单
  仍有未完成项时，向下一请求注入列出未完成项的具体提醒；每回合上限 3 条。
- **R-TODO-3 可视性**：提醒消息以 `source.form='notice'` 渲染为暗淡通知行，不伪装
  为用户输入；面板/状态栏/`/todo` 弹窗按每条 `todo/write` 事件实时刷新。
- **R-TODO-4 可关闭**：`config.todoGuard: false` 或 `DSH_NVIM_TUI_TODO_GUARD=0`。

## 6. 非功能需求

- **R-NFR-1 性能**：状态栏 running 时 450ms 刷新、idle 30s 低频刷新；流式渲染对上次
  视图 diff 后增量 `set_lines`；消息节流刷新。
- **R-NFR-2 可靠性**：退出清理 teardown 上限 2.5s + 硬兜底 5s（restart 9s，且旧 nvim 未退出时**取消重启**）；审批请求走瀑布回执 + 信号
  取消；历史会话恢复失败降级为新建会话（记错误日志 + `⚠` 提示），绝不拖垮整个 TUI；
  回合失败显式渲染。
- **R-NFR-3 可移植性**：无 TTY 环境（沙箱/CI）走 `--headless` 模式，XDG 隔离；
  支持 watchdog 兜底超时与聊天转储（`DSH_NVIM_TUI_DUMP`）。
- **R-NFR-4 发布质量**：`npm publish` 由 `prepublishOnly` 自动跑无头冒烟门禁；
  `files` 白名单裁剪（lib / nvim / docs / examples / cordis.patch.yml / README /
  UPGRADE / REQUIREMENTS）；peer 依赖
  （`@deepseek-ai/dsh-agent`、`dsh-llm`）由 profile 内的 dsh-base 提供。

## 7. 关键设计决策（约束）

- **D-1 不用 `nvim --embed`**：它会隐式 headless，网格渲染就得自己做。这里正常启动
  nvim，用 `--listen` socket 驱动，内置 TUI 渲染终端。
- **D-2 默认加载用户配置**（`-u NONE` 仅是开关）：dsh_tui 在 VimEnter 后接管布局；
  headless/沙箱模式通过 XDG 隔离实现干净环境。
- **D-3 runner 行的 effect disposer 只拆 UI 不退出进程**：hmr 重载该行时 dsh 继续
  运行，下一次 apply 会 spawn 新的 nvim。只有用户主动退出、nvim 退出、致命错误、
  信号才会走 `appExit`。
- **D-4 消息只从 `session/event` 渲染**（不本地回显），避免与转录重复。

## 8. 里程碑与验收状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 冒烟：spawn + socket RPC 往返 + Lua 插件加载 | ✅ 完成 |
| M1 | 最小闭环：chat buffer 流式渲染 + prompt 输入发送消息 | ✅ 完成 |
| M2 | 会话管理：双窗布局 + `/sessions` 会话浮窗（完整 id）、多会话切换/新建、历史恢复（`agents.resume`）、标题显示、退出 flush、失败回合可见渲染 | ✅ 完成 |
| M3 | 工具调用与流转可视化：工具卡片、状态行（statusline）、subagent/workflow 卡片、extmark 着色 + 轻 markdown、增量渲染 | ✅ 完成 |
| M4 | 交互能力：审批浮窗（`approval/request` 瀑布回执 + 信号取消）、用户提问浮窗（`userQuestions.registerProvider`，单选/多选/取消）、`/model` 浮窗选择与热切、`/fork` 分叉、`/sessions`、多行输入 + 历史 + 斜杠命令补全菜单（`/` 自动弹出，Tab/Enter/Esc 交互） | ✅ 完成 |
| M5 | 打磨与分发：主题覆盖（config.theme）、状态栏模型名、npm 发布准备（prepublish 冒烟门禁）、一键安装验证（dsh plugin add）、配置项文档化 | ✅ 完成 |
| M6 | 完整 TUI：`/stop` 中断、`/steer` 引导、`/compact` 压缩、`/goal` 目标管理（状态栏 🎯）、`/plan` 计划模式（状态栏 📋）、`/rewind` 回退重建、`/rename`、`/search` 跨会话搜索、`/tasks`、`/skills` 浏览、`/mcp` 统计、`/fb` 消息反馈、终端标题、多模态（原生识图模型自动切换；OCR 桥已于 v0.3.2 移除）、剪贴板读图、暗色主题、REPL 提示符与补全菜单 | ✅ 完成 |
| M7 | 子代理与官方能力对齐：`/subagents`、`/permission`、`/attach` + `@` 补全、`/deliverables`、`/workflow`、`/settings [edit]`、`/trajectory`、`/layout default|panel`、`/bell`、`/new [目录]` + 目录选择器、markdown 渲染增强（标题/引用/链接/行内码） | ✅ 完成 |

## 9. 测试与验收

- **R-TEST-1 无头冒烟**：`npm run smoke`（`node scripts/smoke.ts`，先自动 tsc 构建）——RPC 往返 +
  Lua 插件 + 事件渲染，`prepublishOnly` 自动门禁。
- **R-TEST-2 端到端无头验证**（不需要真实终端，走完整 host→agent→渲染链路）：

```bash
DSH_HOME=$PWD/.dsh-test \
DSH_NVIM_TUI_HEADLESS=1 \
DSH_NVIM_TUI_PROMPT='请只回复两个字：好的' \
DSH_NVIM_TUI_DUMP=/tmp/e2e-dump.txt \
dsh --profile nvim-tui
# 首个 turn 结束后 chat buffer 全量落盘到 /tmp/e2e-dump.txt 并退出
```

- **R-TEST-3 真模型回归**：`npm run e2e -- "你好，请只回复：收到"`——真实 dsh +
  凭据下 headless 跑一轮，校验 dump 含本轮助手回复且无错误标记
  （超时 `DSH_NVIM_TUI_E2E_TIMEOUT`，默认 180s）。

> `.dsh-test/` 是工作区内的 DSH_HOME 测试副本（profiles 的共享 node_modules
> 以符号链接复用 `~/.dsh/profiles/node_modules`），用于在沙箱/CI 里 boot。

## 10. 目录结构

> 注：v0.3.3 起 lib/ 为 src/ 全树的 tsc 编译产物（lib/kernel/*.js、lib/feed/*.js
> 等），不再使用早期平铺的单文件结构；下方为 v0.1.x 时代的结构速览。

```
lib/
  index.js    Cordis 插件入口：spawn nvim → RPC → agent 生命周期 → 事件桥
  bridge.js   nvim spawn / socket 连接（自建 socket + error 处理）
  feed.js     转录渲染器：DSH 事件 → chat buffer 行模型（节流刷新）
  table.js    GFM 表格 → 框线表格转换（显示宽度对齐）
  stats.js    状态栏统计：token/缓存/成本/时长 折叠与格式化
  images.js   图片读取：文件 / macOS 剪贴板 / data URL 解析
nvim/lua/dsh_tui/           nvim 侧 UI（按职责拆分的 Lua 模块）
  init.lua      公共门面：M.* API 转发 + 跨模块意图编排 + start()
  state.lua     共享状态（窗口/buffer 句柄唯一来源，M._* 惰性别名）
  layout.lua    窗口布局 / 启动接管 / 布局预设
  input.lua     输入 buffer：文本、高度、边框、历史、焦点
  cmd_menu.lua  / 命令补全    at_menu.lua  @ 提及补全
  session.lua   会话 buffer + 思考面板 + set_active + ids
  autocmds.lua  自愈 / 窗口归属 / 插件隔离 / 启动守卫
  keymaps.lua   键位    rpc.lua  通道操作    statusline.lua  状态栏+标题
  highlight.lua 高亮/调色板/treesitter    buffer.lua  buffer 原语
  popup_core.lua 通用浮窗族（审批/提问/选择器）   popups.lua  专用浮窗
scripts/smoke.ts            无头冒烟测试
scripts/e2e.ts              真模型端到端回归
cordis.patch.yml            bundle patch：insert nvim-tui-runner 行
```
