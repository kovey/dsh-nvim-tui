# Changelog

本文件记录 dsh-nvim-tui 各版本的改动与新增。版本号遵循语义化约定，
每个版本标签的附注与本表对应条目一致。

## Unreleased（main）

- **diff 样式收敛**：只有真正的 diff 区域（紧跟 `✎ 修改/新增/删除 <路径>
  (+N −M)` 标题之后、尚未闭合的行）才应用 +/− 前景与红绿背景——普通
  内容里以 `- ` / `+ ` 开头的行（markdown 列表、git log 输出等）按普通
  文本渲染，不再被误染成 diff 行；删除为旧面板预留的死角色条目。

- **活动行防堆叠**：瞬态活动行（`·· thinking…`/`🔧 运行中`）不再因下方
  内容变化（如输入即回显的用户气泡）被固化进聊天缓冲——旧活动行总是被
  覆盖，不会再堆出第二条 thinking 记录。

- **输入框加固**：ZZ/ZQ 在输入框失效（不再误关输入框）；输入框被任何
  途径关闭后（:q/插件）自动重建（缓冲改 bufhidden=hide，未发送草稿不丢）；
  窗口间切换（<C-w>↑/↓）保持命令模式不再强拉回 insert；`:sp`/`:vsp`
  在输入框上开出的同缓冲分身在下一拍自动关闭（其余缓冲的分屏不受影响）；
  守卫扩展 ModeChanged（状态栏插件在模式切换时重写不再吞掉边框与提示条）；
  鼠标点击聊天区时插入模式拖带被弹回（聊天区回 normal、输入框恢复
  insert，不打断正在输入的状态）。

- **/todo 命令**：dsh 的待办清单是 agent 专属（todo_write 工具拒绝非
  agent 调用方，官方 Web 同样只读）——`/todo <内容>` 按官方姿势让 agent
  更新清单（保留其余项），`/todo` 无参弹窗展示当前清单（○ 待办 / ◐ 进行中
  / ✓ 完成）；自然语言「添加任务 XX」「待办」直达。

## [v0.2.4（2026-08-27）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.4)

覆盖提交：
[`e378590`](https://github.com/kovey/dsh-nvim-tui/commit/e378590) ·
[`45f6c02`](https://github.com/kovey/dsh-nvim-tui/commit/45f6c02) ·
[`6f1faf6`](https://github.com/kovey/dsh-nvim-tui/commit/6f1faf6) ·
[`af63b2d`](https://github.com/kovey/dsh-nvim-tui/commit/af63b2d) ·
[`2fc76da`](https://github.com/kovey/dsh-nvim-tui/commit/2fc76da) ·
[`9c4ebb8`](https://github.com/kovey/dsh-nvim-tui/commit/9c4ebb8)

- **思考面板弹窗化**：`<C-o>` 面板从右侧分屏改为**紧贴右缘的浮动弹窗**
  （复用弹窗样式：圆角边框 + 居中标题「思考与工具记录」+ 底部操作提示
  `C-o 收起面板 · q 关闭`、editor 相对锚点 NE、宽 45% 钳制 30–52 列、
  高度为屏幕的 3/4、zindex 低于菜单/审批）；聊天区保持全宽不再被挤；
  终端缩放自动重锚，接管重建时显式关闭浮层。

- **代码块 markdown 渲染**：聊天区不再原样显示 \`\`\` 围栏标记——开头围栏
  渲染为暗色语言小标（`▸ python`），结尾围栏为空行，代码内容原样高亮
  显示在两者之间（Claude 式）。

- **代码语法高亮**：聊天区的 ```lang 代码块与文件变更 diff 的行内容使用
  **用户自己的 nvim 配置**高亮——treesitter 在隐藏 scratch 缓冲上解析
  （无需窗口、不动聊天布局），捕获名映射到用户配色方案的 @xxx 组
  （@keyword.function/@string/@comment…）；无 treesitter/无对应 parser 时
  保持原有平色，绝不报错；diff 块按 ✎ 标题路径扩展名推断语言
  （含 nvim-treesitter 语法改名映射：php→php_only 等）。
- **diff 块重启保留**：会话恢复/分叉/回退重放历史事件时，按持久化事件
  自带的 meta.diffs 重新生成 ✎ 对比块（重启不再丢失）；按 callId 去重，
  重放与实时事件重叠也不会渲染两次。

- **输入即回显**：发送消息后用户气泡立即渲染进聊天区（不再等宿主的
  user/message 事件回环造成可见卡顿）；按会话 FIFO 去重队列保证事件到达时
  不重复渲染，带图消息不走回显（由事件渲染 📎 标签）。

- **文件变更 diff**：改动文件的工具调用（write/edit 等）在结果行下渲染
  `✎ 新增/修改/删除 <路径> (+N −M)` 高亮块——优先使用工具官方
  presentationMeta 的 `meta.diffs`（精确的 before/after，不受 cwd 影响），
  缺失时回退到工具执行前快照 + 执行后重读；LCS 差异、2 行上下文、40 行
  截断，绿色 `+` / 红色 `-` **始终直接渲染进聊天流**（思考面板保持紧凑
  活动日志）；大文件/二进制跳过。

- **diff 行主题背景色**：`+`/`-` 行整行填充背景色（Claude 式）——前景与
  背景取自主题的 DiffAdd/DiffDelete 高亮组，主题缺背景时按比例混入
  编辑器背景；换主题随 ColorScheme 事件自动重算。

## [v0.2.3（2026-08-27）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.3)

覆盖提交：
[`5de7ccd`](https://github.com/kovey/dsh-nvim-tui/commit/5de7ccd) ·
[`0e755b0`](https://github.com/kovey/dsh-nvim-tui/commit/0e755b0) ·
[`65a9770`](https://github.com/kovey/dsh-nvim-tui/commit/65a9770)

- **像素鲸鱼空态 hero**：空态改为「DSH NVIM TUI」大横幅 + 标题 + 16×24
  像素鲸鱼（tianshu-tui 移植，半块字形 ▀▄█ + 逐像素高亮组，左眼眨眼、
  头顶气泡、天空闪光，4 帧循环动画）；状态栏运行中鲸鱼表情循环
  🐳→🫧🐳；`/whale off` 可关（配置 `whaleArt: 'off'`），窗口过小自动隐藏。

- **输入框边框**：输入框加完整边框——winbar 上边 `╭─╮` + statuscolumn
  左边 `│❯` + 右对齐 extmark 右边 `│` + 状态栏底边 `╰ hints ╯`，
  底部提示文字两侧 `─` 补全至边角；`winfixheight` + 行高预算修正消灭
  标签栏闪烁带来的多余空行；视口 topline 复位修复首次换行新行渲染为
  无边框 `~` 行；空输入按 Enter 后底部栏消失 → 按键批次后调度完整
  redraw 补画。

- **弹窗提示嵌入边框**：弹出窗操作提示改用浮动窗口原生 `footer`
  （nvim ≥ 0.10，`footer_pos='left'`）直接嵌进底部边框，与嵌在上边框的
  标题对称；删除窗口下方独立的分离提示栏（弹窗矮一行、终端缩放不再
  漂移），`FloatFooter` 沿用状态栏风格；旧版 nvim 保留分离栏回退。

- **启动与状态栏修复**：`laststatus=2` 恢复（此前误钉 0 导致统计栏与
  提示栏整体消失）；scratch 缓冲接管清除 + `titlestring` 钉为 dsh 消灭
  启动标签闪烁；OptionSet 守卫不再误清输入框 winbar。

- **市场与弹窗**：`/market` 阶段 1+2（目录、搜索、依赖匹配、评分、
  安装进度 + 自动修复）；弹窗统一（底部提示、内容自适应高度、原生
  导航、只读锁定、屏幕居中）；`/plugins` `/subagents` `/help`
  `/workspace` 弹窗化；会话列表过滤；子代理 TTL 清理。

- **自然语言命令更聪明**：新增三级归一化匹配——先原文、再去口语引导词
  （打开/显示/查看/帮我/请/切换到…，中英双语）、再去尾部填充名词
  （面板/页面/窗口/列表/模式/模型…）——`打开帮助面板`→/help、
  `查看会话列表`→/sessions、`切换到 deepseek-chat 模型`→/model；
  同时给无参命令补齐「名词提示」兜底（帮助/会话/模型/主题/设置/插件/
  队列/记忆/目标/计划…），带参命令的捕获在兜底前优先执行。

- **聊天/思考面板只读修复**：聊天出口与思考面板此前可按 `i` 进入插入模式、
  用 `x`/`dd`/`J` 删除/合并内容——现在这些显示缓冲区全部 Nop 编辑键
  （i/a/o/r/s/c/d/x/p/J/~/gu/gU/gi/gI/C-a/C-x 等，仅键位屏蔽；缓冲区保持
  可写以便渲染器经 API 写入）。

- **/help 弹窗化**：全部命令弹窗展示，**按分组排列**（沿用原聊天分组，
  `── 分组 ──` 分隔行）且**组内按命令名字母排序**；sessions 式弹窗
  （标题/底部提示条/原生滚动/居中），Enter 把选中的命令**填入输入框**
  （与命令补全的 Enter 逻辑一致：补全菜单联动、光标到行尾、插入模式，
  二次回车执行），Esc 取消。

## [v0.2.2（2026-08-26）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.2)

完整修改日志见 [CHANGELOG](https://github.com/kovey/dsh-nvim-tui/blob/v0.2.2/CHANGELOG.md)。

覆盖提交：
[`3e3cb0c`](https://github.com/kovey/dsh-nvim-tui/commit/3e3cb0c) ·
[`3b9351a`](https://github.com/kovey/dsh-nvim-tui/commit/3b9351a) ·
[`1939f51`](https://github.com/kovey/dsh-nvim-tui/commit/1939f51)

- **依赖升级**：`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` peer 依赖
  升至 `^0.1.1-rc.2`（与宿主 dsh 0.1.1-rc.2 对齐，类型/运行时同版本）
  （[`3e3cb0c`](https://github.com/kovey/dsh-nvim-tui/commit/3e3cb0c)）；
- **/sessions 只列项目级会话**：列表只展示 `session-` 前缀的项目级会话，
  子代理子会话（裸 UUID / origin subagent）在 工作区分组、未分组、历史
  三处全部过滤，不再混入
  （[`3b9351a`](https://github.com/kovey/dsh-nvim-tui/commit/3b9351a)）；
- **dsh 0.1.1-rc.2 兼容性自检与修复**：逐项核对宿主 API 与事件契约
  （approval/questions/sessions/subagents/settings/projections/modelSelection/
  全部渲染事件均兼容）；修复两处不兼容——
  ① `compaction/summary.summary` 现为 ContentBlock[]，旧渲染 `.split` 会
  崩溃，改为字符串/块数组双形状渲染；
  ② 0.1.1-rc.2 无 `session.truncate`/`truncateStored`（日志 append-only）：
  `/rewind` 保持守卫降级提示，子代理 TTL 清理改为**列表隐藏不依赖存储截断**
  （台账照常生效，截断仅尽力而为）
  （[`1939f51`](https://github.com/kovey/dsh-nvim-tui/commit/1939f51)）。


## [v0.2.1（2026-08-25）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.1)

覆盖提交：
[`91ca1c8`](https://github.com/kovey/dsh-nvim-tui/commit/91ca1c8) ·
[`acb38a1`](https://github.com/kovey/dsh-nvim-tui/commit/acb38a1) ·
[`e838214`](https://github.com/kovey/dsh-nvim-tui/commit/e838214) ·
[`b45fae3`](https://github.com/kovey/dsh-nvim-tui/commit/b45fae3) ·
[`7eb34e4`](https://github.com/kovey/dsh-nvim-tui/commit/7eb34e4)

### 插件市场 `/market`（Phase 1 + Phase 2）

- **目录**：awesome-dsh-plugin 精选注册表（2140+ 插件，客户端无关），
  codeload tarball 一次拉全量（stars.json + 逐插件 yaml：名称/分类/双语描述/
  发布 tarball），磁盘缓存（`$DSH_HOME/nvim-tui/market-catalog.json`，TTL 可配，
  离线降级）；
- **列表**：按 GitHub ★ 倒序，`★N ✓ · owner/repo · 描述` 行，`/market <关键词>`
  按名称/描述/分类过滤，`/market refresh` 强制同步；
- **操作**：安装 / 更新 / 卸载走官方 `dsh plugin --profile <p> add|update|remove`
  （pnpm + bundles 调和，多数插件重启生效并如实提示）；卸载二次确认 + 保护
  TUI 自身；`打开 GitHub 页面`；
- **热启停**：已装插件的 loader 条目可停用/启用——写入 profile
  `cordis.patch.yml` 的 `- id: X` + `disabled: true|false` 行（幂等：替换同 id
  旧行、保留无关行），HMR ~1s 重新组合免重启；保护 `nvim-tui-runner` 自身；
- **更新感知**：`↑latest` 标记（npm registry 查最新 vs 已装版本，5 分钟内存
  缓存，link:/URL 依赖自动跳过）+ `/market update-all`（pnpm update 全量）；
- **匹配修正**：目录 url 可能带 `/tree/<branch>/<subdir>` 子路径——`repoRoot()`
  归一 + 安装 spec 取发布 tarball 或仓库根；已装依赖按 名称/目录 url/仓库根
  三路匹配；
- 状态行标记：`✓` 已装启用 / `⊘` 已装停用 / `↑` 有更新；
- **安装前 npm 优先解析（根因修复）**：对无预构建 tarball 的条目，安装前先读
  仓库 package.json（name/version/prepare）并核对 npm registry——有同版本
  发布包则直接装 `name@version`（dshmarket 的 repo-verified 策略）。
  `/market` 安装 dsh-context 实测解析为 `dsh-context@0.31.0`，lib/ 完整落盘。

### 弹窗体系定稿

- **统一形态**：所有弹窗 = 边框功能标题 + 高度贴合内容 + **窗口外底部操作
  提示条**（独立 1 行浮窗、状态栏配色，主窗滚动时始终可见、随主窗移动/缩放
  自动重锚定）+ 普通缓冲区原生导航（`j/k`、`G`、`gg`、`Ctrl-d/u`）；`G` 直达
  最后一条、`Enter` 取光标行；子代理回放窗/`/plugins` 同步对齐（
  [`91ca1c8`](https://github.com/kovey/dsh-nvim-tui/commit/91ca1c8)）；
- **全部弹窗屏幕居中**：共享 `centered_row/col` 公式，垂直居中偏上、水平
  居中；目录选择/子代理回放等动态高度窗口随内容增长保持居中
  （[`acb38a1`](https://github.com/kovey/dsh-nvim-tui/commit/acb38a1)）；
- **只读锁定**：弹窗缓冲区 `modifiable=false` + 编辑键全量 `<Nop>`
  （i/a/o/d/x/…/:）——按 `i` 不再进输入模式、`x`/`dd` 删不动内容，也不抛 E21；
- **审批弹窗新增 `[a] 总是（自动模式）`**：dsh 审批接口只有一次性授权
  （无 allow-always），按 `a` = 本请求放行 + 会话切换审批策略 `never`
  （不再弹窗、需要审批的操作由 dsh 自动拒绝，`/yolo off` 恢复）；同步修正
  `/yolo` 文案（原「全放行」与 dsh 实际 fail-closed 行为相反）。

### 市场安装进度浮窗 + 失败自动修复（智能体行为）

- **进度浮窗**：`dsh plugin` 输出实时滚动进浮窗（日志尾部视图 + 底部进度条
  行），`q/Esc` 可隐藏、后台继续；`update-all` 同用；
- **失败自动修复**：失败输出分类诊断（网络 / 404 / 锁文件 / 缓存权限 /
  git 权限），自动执行对应补救——网络重试、自动换源（npm 发布版 ⇄ Release
  tarball ⇄ 仓库根）、备份 `pnpm-lock.yaml` 重试、换临时 npm 缓存目录重试；
  **装成功但缺入口文件**（dsh-context 事故类）自动卸载改装 npm 发布版/预构建
  tarball 并重新校验；全程写进度窗、尝试次数封顶防死循环
  （[`91ca1c8`](https://github.com/kovey/dsh-nvim-tui/commit/91ca1c8)）。

### 自然语言命令路由

- **全部命令支持自然语言调用**：`src/nlcmd.ts` 意图表（中英双语别名 + 参数
  捕获正则），普通输入命中意图即执行对应斜杠命令，并在会话里回显
  `→ 命令: /xxx 参数`；示例：`会话列表`→/sessions、`切换模型 deepseek-chat`
  →/model、`主题换成 vivid`→/theme、`语言 英文`→/locale en、`记住 xx`
  →/remember、`删除工作区 abc`→/workspace delete、`反馈 up 很好用`→/fb；
- **防误拦截护栏**：问句（？/? 结尾）一律发给智能体；`>`/引号开头强制聊天
  逃生口；>60 字的长文本直接聊天；破坏性命令（清屏/停止/退出/重启/压缩/
  回退）只接受精确短语；`用中文回复我` 这类句式不会被当成模型切换
  （[`b45fae3`](https://github.com/kovey/dsh-nvim-tui/commit/b45fae3)）；
- `/workspace` 改为 sessions 式弹窗（工作区目录 + 目录选择新建 + 重命名/
  删除动作）（[`e838214`](https://github.com/kovey/dsh-nvim-tui/commit/e838214)）。

### 子代理思考链 TTL 清理

- 此前子代理思考链**永久累积**（宿主持久化无 TTL、无删除接口）——现在
  `/subagents` 打开时自动清理：已结束且超过保留期（`config.subagentTtlHours`，
  默认 72h，0 = 关闭）的思考链通过 `sessionPersistence.truncateStored` 截断
  （仅保留首条事件，释放存储），id 记入
  `$DSH_HOME/dsh-nvim-tui-subagent-clean.json` 并从列表隐藏；
- 列表行显示存续时间（`刚刚/5m前/2h前/3d前`）；顶部新增
  `🧹 清理全部已结束思考链（N 条）` 手动清理（二次确认）；运行中的子代理
  不受影响（[`7eb34e4`](https://github.com/kovey/dsh-nvim-tui/commit/7eb34e4)）。

## v0.2.0（2026-08-24）

### 工程形态

- **TypeScript 迁移**：全部源码移入 `src/*.ts`（strict 模式，`tsc` 编译输出
  `lib/*.js` + `.d.ts`，dsh 按 npm 包入口加载编译产物）；新增 `src/types.ts`
  共享类型层（SessionEvent 判别联合 + 宿主服务结构接口）；
- **scripts 转 TS**：`smoke`/`e2e` 测试脚本改为 `.ts`（Node ≥23.6 原生
  type-stripping 直跑，不进发布包）；`engines` 相应提升；
- **工具链**：`npm run build` / `dev`（watch）/ `check`（src+scripts 双
  tsconfig 全量类型检查）；`prepublishOnly` 门禁 = check → build → smoke；
- **i18n**：`src/i18n.ts` 字典化（zh 字面量 → en 查表，未知键回退中文），
  `/locale zh|en` 运行时切换（`config.locale` / `DSH_NVIM_TUI_LOCALE` 兜底）；
  Lua 按键提示保持中文（已知限制）。

### 对齐官方客户端（新增功能）

- **转录渲染**：📋 待办条（`todo/write`，状态栏同步计数）；⋯ 压缩检查点
  （`compaction/summary`：条数 + ≈tokens + 摘要块）；↻ 重试状态行
  （`llm/retry`：次数/上限/∞、倒计时、失败原因）；◈ workflow 转录内嵌套回放
  （`tool-workflow/*`）；JSON 结构化工具结果逐条 itemize；
- **引用与补全**：`@` 补全接入官方 **@session 会话引用**（规范 mention
  `@[标题](dsh-session:…)`，文件在前、会话在后）；skill 条目并入 `/` 补全菜单
  （`/skills:<name>` 直达详情）；
- **Workspace 会话管理**：`/sessions` 重建为工作区分组浏览器（📁 分组 + 未分组
  + 归档隐藏，工作区行内新建/重命名）；新增 `/workspace add|delete`、
  `/archive [id]`；重命名复用「下一条输入即新名称」交互；
- **消息队列**：`/queue` 查看/编辑/删除/清空排队消息（agent inbox 投影），
  状态栏 ⏳ 计数；
- **统计增强**：状态栏新增 TTFT avg / tok/s（官方 sessionStats 投影）、
  ⚙ 运行中 jobs 徽章、`⇢` 子代理寻址指示；新增 `/context` 上下文组成分解
  （≈used/capacity · system/tools/messages · claim 窗口）；
- **设置与清单**：`/settings` 按官方 `SettingsDescriptor` 形状渲染（命名空间 +
  美化打印值 + 用户覆盖星标），浮窗内 `i`/`o` 直接打开 settings.yaml 编辑；
  `/settings set <ns> <key.path> <value>` 类型化写入（热载）；新增 `/plugins`
  宿主插件清单、`/models` 模型/供应商目录；
- **权限与交互**：`/permission` 切换危险全访问预设先弹确认；只读浮窗 `i`/`o`
  改为 Nop（不再弹 E21 原始报错）。

### 修复

- 子代理思考链视图二次打开 E95（缓冲区名冲突）——关闭即清除缓冲；
- 子代理思考链**实时流式输出**（此前想完一次性输出）；
- 多行错误 notice 导致渲染 flush E5108 失效——notice/错误折叠为单行；
- `/models` 与图片发送的 `runtimeCtx.llm` 属性访问需 inject → 改 `get('llm')`；
- 通知分发加 try/catch 兜底（单个命令异常不再杀死整个 dsh）；
- headless dump 引用已删除的 `sessionsBuf` → 改用内存会话列表；
- `/settings set` 臆想命名空间 `local` → 显式 `<ns>` 三段语法；
- `/models` 臆想 provider 形状 → 真实 `{id, name}` + 可配置 provider 目录；
- Markdown 表格整表统一加粗（消除 `│`/`─`/转角字体渲染粗细不一）。

## v0.1.0（2026-08）

初始版本：Neovim 风格 TUI（双窗布局、流式渲染、状态栏、会话管理、审批/提问
浮窗、多模态识图、斜杠命令 40+），里程碑 M0–M7 全部完成（见早期 REQUIREMENTS
基线）。
