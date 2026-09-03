# Changelog

本文件记录 dsh-nvim-tui 各版本的改动与新增。版本号遵循语义化约定，
每个版本标签的附注与本表对应条目一致。

## [Unreleased]

- **新增：/deps 依赖体检 + 一键装配**。50+ 命令的宿主/第三方依赖集中体检：
  - 主机插件 10 项（agent-presets / cordis-host-runner / file-reference /
    workspace / plugin-inventory / message-feedback / session-reference /
    session-stats / code-runtime / subagent-model-selection-settings）按
    运行时服务键实查；配置生效性 3 项（/search 索引 openAt、vision-bridge、
    feishu 凭据）；系统命令 2 项（pnpm、本地 OCR 二进制 feishu-ocr）。
  - `/deps` 浮窗分组报告 ✓/✗/⚠；`/deps install` picker 选择后把缺失行
    幂等写入 profile 的 cordis.patch.yml（结构行解析忽略注释、防重复 id、
    包存在性先探 dsh 安装目录），loader 用户补丁 watcher 热重载生效。
  - 冒烟覆盖：patch 行解析（注释不算行）、包探针（真/假包）。
  - check / build / smoke 全绿，真实 harness 冷启动零错误。

- **修复：/workspace、/archive 与 /sessions 工作区分组不可用（服务键名错误）**。
  命令核查看板发现 TUI 消费 `ctx.get('workspaces')`，而 alpha.5 的
  `dsh-workspace` 注册键是 `workspaceRegistry`（profile 装配行本身正确）——
  `/workspace` 恒报「服务未装配」、`/archive` 恒「归档不可用」、`/sessions`
  静默退化为无分组列表。4 处消费点 + ServiceMap 键名已改为
  `workspaceRegistry`；方法签名逐一对齐 alpha.5 WorkspaceRegistry
  （list/create/delete/archiveSession/archivedSessionIds/实体 setTitle），
  全部匹配无需改动。顺带启用 `/search`：profile patch 覆盖
  `session-query-sqlite` 为 `openAt: first-search` + 持久化路径
  `dshHomePath('session-query.db')`（dsh-base 默认 :memory: + never 库从不
  建立，搜索恒空）；首次搜索触发全量索引。check/build/smoke 全绿，
  dump-config 验证 100 行 0 重复。

- **移除：历史会话恢复失败的本地兜底（boot 自动恢复 catch → 新建会话）**。
  dsh 0.1.2-alpha.5 的持久化读取已官方修复损坏日志的处理——扫描器遇到
  seq gap 时保留连续前缀并持久化截断修复（不再硬失败），此前
  「恢复失败 → 静默新建会话」的本地 workaround 会掩盖真实错误；现已移除，
  恢复失败将如实上抛（真故障 loud-fail，损坏日志由官方修复路径正常打开）。

- **重构：runner 侧 index.ts 拆分（4440 行 → 领域模块）**。共享状态与核心
  服务收拢为单一 `App` 对象（`src/app.ts`，对应 nvim 侧 `state.lua` 的角色）：
  index.ts 降为纯组合根（对应 `init.lua` 门面），行为域拆入
  `statusline.ts`（状态栏/glance/whale 动画）、`sessions.ts`（会话生命周期 +
  会话类命令）、`subagents.ts`（子代理目录/回放/对话窗）、`transcript.ts`
  （转录修复/导出/trajectory/rewind/queue）、`commands.ts`（消息发送 + 通用
  斜杠命令）、`market-install.ts`（插件市场安装）、`boot.ts`（nvim 启动/通知
  循环/宿主事件接线）。模块通过 `app.registerCommands()` 注册自己的命令、
  install 阶段填充跨模块槽位（late binding），新增功能只需落进所属模块——
  纯重构，行为不变，check/build/smoke 全绿。顺带修复 onCommand 里
  `/skills:` 前缀重复调用两次的旧 bug。

- **新增：子代理对话窗**——`/subagents` 对 continuable 子代理打开对话窗口，
  像跟主代理聊天一样发消息：
  - 窗口上部为子代理实时转录（思考内联流式、回复、工具卡，复用
    FeedRenderer 只读回放渲染层），下部为内嵌单行输入（Enter 发送 ·
    Esc 关闭回主线 · `<C-CR>` 换行 · `<Up>/<Down>` 窗口内历史 · `<C-o>` 面板），
    输入多行时自动长高、转录窗同步缩短，整体占位不变。
  - 发送链路：`dsh-subagent-send` rpcnotify → 乐观回显气泡（与 harness 的
    user/message 回放 FIFO 去重，不双渲染）→ 官方 symbol 键 host prompt 队列
    `Symbol.for('dsh.subagent.queuePrompt')`（人机 prompt，source kind=user）：
    运行中子代理排队为下一回合（窗口内 `⏳ 已排队` 提示），已结束子代理自动
    冷恢复；主聊天同步 `➤ 已发给子代理 X` notice。
  - 修复：发送报「subagents 服务未装配」——服务实例上不存在公开 `followup`
    方法（此前调用的是幻影 API），改调 symbol 键的 `queueSubagentPrompt`
    host 队列，`/subagents` 快捷续聊路径一并修复。
  - 修复：发送报「Cannot read properties of undefined (reading
    'requireContinuations')」——symbol 键方法内部依赖 `this`
    （服务实例），必须以 `.call(service, …)` 绑定调用，不能提取为裸函数。
  - 修复：输入行无边框、与转录框之间留一行空隙——输入浮窗改为自带圆角边框
    （顶边紧贴转录框底边，构成一个连续完整的聊天框），操作提示移入输入行
    底边框；`resize` 改用局部配置合并，多行输入时保留标题/边框/提示。
  - 与只读思考链回放互斥（开一个关另一个）；`/subagents` 操作菜单新增
    「打开对话窗口」项，打开时清除「下一条输入发给子代理」快捷寻址。
  - 新模块 `nvim/lua/dsh_tui/subagent_chat.lua` + runner 侧
    `openSubagentChat` / `sendToSubagent` + smoke 全覆盖。

- **修复：活动指示（`·· thinking · Xs` / `🔧 工具 · Xs` / `◇ 子代理 · Xs`）
  被流式输出顶到聊天框中间**。指示行原先渲染在已提交内容与流式 tail 之间，
  内容在它下方持续流入时它随之上移。现在它固定渲染在视图**最底部**
  （tail 之后），内容始终在指示行上方流入，位置不受聊天内容影响；
  子代理运行 + 主线回复同时流式输出时，`◇` 指示行保持在聊天框最后一行。
  Markdown 表格的"流式无底边框"逻辑同步适配（表格后面跟的指示行不计入
  "表格之后仍有内容"的判定）。

## [v0.2.13（2026-09-02）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.13)

覆盖提交：
[`281ed22`](https://github.com/kovey/dsh-nvim-tui/commit/281ed22)

- **修复：alpha.4 下旧版会话打不开（自动恢复 / `/sessions` 恢复全部失败）**。
  alpha.4 的 SessionSeq 品牌化重构移除了 `Session.events` 公共属性（改用
  `snapshotEvents()` / `ownEvents()`），v0.2.12 适配时遗漏了消费面——
  `resumeSession` 读 `session.events.length` 直接抛
  `TypeError: Cannot read properties of undefined (reading 'length')`，
  每次打开旧会话都被兜底成新建会话。本次修复：
  - 统一 `sessionEvents()` 读取器（`snapshotEvents()` 优先、alpha.3 的
    `events` 兜底），覆盖全部 7 处消费：历史恢复、孤儿工具调用修复、
    `/trajectory`、`/rewind`、`/preset` 空白判定、子代理回放视图。
  - **`/fork` 重写为 alpha.4 官方种子契约**（对照
    dsh-api-session-controller 同款实现）：新鲜子会话 id +
    `agents.create({ seed, inheritedEventCount, meta.isSeeded })`——旧路径
    `sessions.fork() → child.events → meta.seedLength` 在 alpha.4 双重失效
    （fork 已把子会话注册进 store、`meta.seedLength` 为非法 header 字段）。
    种子切割规则：最后一个 `turn/end` 之后截到下一 `turn/start` 之前
    （保证平衡回合前缀，无开放回合/悬空工具调用），并用真实 alpha.4
    Session 校验器验证通过。
  - 验证：真机 headless 恢复 alpha.3 旧会话（41 事件全量回放）通过；
    check / build / smoke 全绿。
- **修复：交互中选择会话/执行命令时 dsh 整个进程退出（终端留下乱码，
  zsh 报 command not found）**。根因链：alpha.4 宿主新增 fail-loud——
  **任何 unhandledRejection 都会整体 dispose 并 `process.exit(1)`**（终端
  打印 `dsh: fatal load failure: …`，且因 runner 静音了 console、宿主直写
  stderr，任何日志都留不下）。而命令表里 `/sessions`、`/new`、`/fork`、
  `/model`、`/rewind` 等 20 个命令用 `fn: () => void cmd()` 火发即忘，
  `onCommand` 调用处也无异步 catch——`/sessions` → 选择会话 →
  `resumeSession` 一旦 reject（损坏的旧日志 / 任意宿主异常），rejection
  直接脱缰 → 宿主 fail-loud 杀进程。修复：
  - 命令分发统一异步护栏：`onCommand` 对 `fn(rest)` 加
    `Promise.resolve().then().catch()`，reject 只表现为聊天区 notice
    （`⚠ /xxx 失败: …`）+ 错误日志行，进程不再退出；
  - 全部命令 `fn` 改为返回 Promise（移除 `void` 包装）让护栏真正接住；
  - `quit()` 全程 try/catch、`/exit` 等不再可能因 quit 自身 reject 脱缰。
  - 新增诊断兜底：进程级 `unhandledRejection` / `uncaughtException` 监听
    （同步写入错误日志）与退出路径诊断（signal / nvim-exit / fatal /
    boot-complete 标记）——此前这类死法在日志中完全无痕。
- **修复：/sessions 列出的旧会话点开提示「未知会话」（跨工作目录打不开）**。
  v0.2.12 的 workspace 分组会话浏览器会列出**所有工作区**的会话，但
  `selectSession` 只允许打开当前 cwd 的历史会话（`historyHeaders` 按 cwd
  过滤）——在非项目目录启动 TUI 时，列表里的旧会话全部「未知会话」。
  现在 `/sessions` 可打开任意工作区的持久会话（新增全量 `historyById` +
  打开前刷新），列表标题也改为从全量历史取；同时 `recordState` 改为记录
  **会话自身的 cwd**（而非启动 shell 的 cwd），跨目录打开的旧会话下次在
  其项目目录启动时可正确自动恢复。真机跨目录恢复验证通过。

## [v0.2.12（2026-09-01）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.12)

覆盖提交：
[`1aa27f2`](https://github.com/kovey/dsh-nvim-tui/commit/1aa27f2) ·
[`75efe9c`](https://github.com/kovey/dsh-nvim-tui/commit/75efe9c)

- **全面适配 DeepSeek Harness v0.1.2-alpha.4 + 子代理修改同步到聊天区**。
  alpha.4 的核心变化：父子代理双向通信——`followup`（父→子）与
  `reportFrom`（子→父）合并为通用 `sendMessage(sender, targetId)`（相邻
  Agent 互发，Steer 语义：运行中目标在最近步界接收、空闲目标起新回合），
  消息 source 统一为 `agent-message`；标准子代理提示词指示子代理把结果
  `send_message` 回父代理。基于此：
  - **子代理消息高亮渲染**：父会话收到的子代理消息（`agent-message` /
    `subagent-settled` / `subagent-report` / `coordinator`）不再落入通用
    注入上下文样式——`◇ 子代理 <id> → 本会话` 头部行（DshTuiSubagent 色）
    + 暗色内容行；结算通知折叠为一行摘要行并保留子代理的收尾消息（去重
    首行）。内容行用 `· ` 前缀围栏安全化（绝不匹配 FENCE_RE，杜绝天蓝
    泄漏类回归）。
  - **子代理修改实时同步 + diff**：runner 新增 child→parent 持久路由
    （`childParent`，subagent/start 登记、容量上限 400、随 teardown 清
    空）——子代理会话的 `tool/result` 文件修改 diff 实时渲染进**父聊天区**
    （`✎ 子代理 <provider> <id> 修改 <path> (+n −m)`，meta.diffs 优先、
    工具调用前快照兜底、每 call 每 feed 去重），父代理共享工作区，
    子代理的编辑即刻可见。
  - peer 依赖锚点抬升至 `^0.1.2-alpha.4`，版本 0.2.12；`tsc check` /
    `build` / `smoke`（新增子代理渲染与围栏安全回归）全绿；alpha.4 真机
    e2e 通过。
- **修复：@ 提及菜单不能用导航键选择（只能选中第一项）**。`<Up>/<Down>/
  <C-n>/<C-p>` 此前只检查 / 命令菜单，@ 菜单打开时全部落入历史回退——真实
  会话里有历史时会把已输入的 @token 替换掉并关闭菜单（表现为"只能默认选
  第一个"）。现在四个导航键在任一补全菜单打开时优先路由到菜单（@ 菜单 →
  / 菜单 → 历史），与 / 菜单的键位语义完全一致；@ 菜单窗口同步补上
  「 @ 提及 」标题（与「命令补全」呼应）。冒烟测试新增 C-n/Down/Up/C-p
  四组按键回归断言（含菜单保持打开）。
- **Harness alpha.3 功能对比核查的 A/C 级补全**（对照官方 web profile 完整
  插件树逐项核查）：
  - **A 级·宿主服务装配**：确认 5 个 web-app 独有服务在 nvim-tui 宿主组合
    缺失导致已有功能空转——`message-feedback`（/fb 报"未装配"）、
    `session-reference`（@ 跨会话引用静默失效）、`session-stats`（状态栏
    TTFT/tok-s 永不显示）、`code-runtime-worker-thread`（/preset ptc 挂起）、
    `subagent-model-selection-settings`（子代理模型选择）。UPGRADE.md 增补
    官方装配行清单（profile patch 5 行 insert，依赖全落 dsh-base 已有
    seam）；已写入本机 nvim-tui profile 并真机 e2e 验证（boot 全激活）。
  - **C 级·事件契约补全**：`user/message` 按 `source.kind` 区分渲染——只有
    `kind: 'user'`（或无线索的旧事件）渲染为用户气泡；宿主注入的上下文
    （runtime snapshot、skill-catalog、subagent-report 等——kind 联合可被
    插件扩展，故正向判定而非黑名单）不再冒充用户输入：`notice` 形态折叠
    为一行暗色摘要，其余形态以「· 注入上下文」暗色块呈现；
    `assistant/message.interrupted` 回合末尾追加「⚠ 回合被中断」标记，被
    截断的前缀不再读起来像完整答案。冒烟测试新增两组回归用例（注入上下文
    无 DshTuiUser 着色、中断标记可见）。
  - **B 级结论**：schedule 官方 web 自身 disabled；webhook/ACP/SDK/持久
    PTY/hooks 桥属自动化挂载包，与交互式 TUI 无对应面——均不纳入。

## [v0.2.11（2026-09-01）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.11)

覆盖提交：
[`fb82a9c`](https://github.com/kovey/dsh-nvim-tui/commit/fb82a9c) ·
[`9156303`](https://github.com/kovey/dsh-nvim-tui/commit/9156303) ·
[`9ef5111`](https://github.com/kovey/dsh-nvim-tui/commit/9ef5111)

- **修复：diff 上下文行携带围栏标记导致全文染成天蓝**。文件编辑卡片的
  上下文行以 `  ` 前缀原样渲染——此前只收集进语法块而未 `continue`，继续
  落入 markdown 解析；当上下文恰好是代码围栏行（如编辑 README 时围栏本身
  是未变更的上下文 → `  ````）时，`/^\s*```/` 匹配并翻转视图围栏状态，
  之后所有非 diff 内容（助手文本、用户输入、提示行、工具卡片）全部染成
  DshTuiCode 天蓝。现在上下文行与 +/− 行一致：原样输出并跳过 markdown
  解析；冒烟测试新增「围栏标记上下文行不得泄漏代码色」回归用例。
- **全面适配 DeepSeek Harness v0.1.2-alpha.3**：peer 依赖锚点抬升至
  `^0.1.2-alpha.3`（dsh-agent / dsh-llm / dsh-tools）。逐包 diff 核对
  alpha.2 → alpha.3 的 40+ 包：19 个核心包 `lib/` 逐字节相同（纯版本号
  抬升）；dsh-session-projection 的 change feed 改为按 raw view 的
  `Object.is` 变化去重通知（nvim-tui 只读 `stateOf()`，不受影响）；
  dsh-attachment 新增浏览器上传 API `admitPromptContent`（纯增量，用到的
  `saveImage()` 未变）。**结论：零破坏性变化，源码零改动适配**。
  `tsc check` / `build` / `smoke` 全绿；alpha.3 真机 e2e 双通道通过
  （scratch 隔离 profile + 真实 nvim-tui profile，真实模型回复，版本横幅
  0.2.11）。
- **init.lua 按模块拆分（门面化）**：1484 行的 init.lua 收敛为 ~340 行的
  公共门面——只做三件事：转发完整的 M.* API（runner/键位/冒烟测试零改动）、
  编排跨模块意图（submit、cmd_next/cmd_prev 的双菜单路由）、start() 启动
  序列。行为域各归其位：`layout`（窗口/接管/预设）、`input`（文本/高度/边框/
  历史）、`cmd_menu`/`at_menu`（两种输入补全）、`session`（会话 buffer/思考
  面板）、`autocmds`（自愈/归属/插件隔离/启动守卫）、`keymaps`、`rpc`、
  `statusline`、`buffer`（buffer 原语）。依赖图严格单向无环，新增逻辑不再
  需要触碰 init.lua。
- **M._\* 字段惰性别名**：runner/测试内省的 M._cmdWin、M._progress、
  M._sessWin 等全部经元表 __index 惰性解析到 state 同名字段——nil↔value
  迁移和整表替换（S.progress / S.subagentView）都不会让别名过期，并修复了
  拆分中途的别名断链（会话列表/技能浮窗等测试一度读取到过期 nil）。
- **子模块 package.preload 注册**：bridge 原本只为 dsh_tui 根模块预注册
  dofile；现在 init.lua 按自身路径把全部子模块一并注册，用户配置重建
  runtimepath（lazy.nvim）后 require 依旧可用（冒烟测试「rtp reset」覆盖）。
- **顺带修复拆分期悬空引用**：popups 的 SKILL_HINT / dir_entries / 进度条
  extmark 命名空间（M._ns → S.ns）、popup_core 关闭浮窗后的输入焦点恢复
  （input_win → S.input_win）、启动守卫的 chat_buf 悬空全局（改为当前活跃
  会话 buffer）。

## [v0.2.10（2026-09-01）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.10)

覆盖提交：
[`42081f4`](https://github.com/kovey/dsh-nvim-tui/commit/42081f4) ·
[`1ed4dda`](https://github.com/kovey/dsh-nvim-tui/commit/1ed4dda)

- **子代理运行状态可视化**：有运行中子代理时聊天状态栏 idle 变为
  `● running ◇N`（鲸鱼 spinner 同步转动）；子代理徽章渲染在 thinking
  槽位——同一套瞬态活动行逻辑，实时计时、永不落盘，主 agent 有思考/
  工具活动时让位；完整思考链仍在 /subagents 查看。

- **任务步骤进度动态渲染**：流式内容尾部的 `- ✅/⏳/⬜ …` 步骤块（含
  标题行）在任一步骤未完成时动态渲染在 thinking 行上方，每版新消息
  原地替换；全部完成后回落到正常位置并随回合落盘，中间版本不进聊天
  记录，重启回放不丢失。

- **窗口归属守护（插件隔离）**：聊天/输入窗口只允许显示自己的 buffer——
  插件（nvim-tree 选文件、:edit、:term）塞入其他 buffer 时，先恢复 TUI
  窗口、再把 buffer 迁到新标签页（焦点跟随）；插件的窗口/浮窗一概不碰。
  顺带根治了 `:edit` 对空输入框的**身份接管**（未命名未修改的输入 buffer
  被原地改名并载入文件内容，导致回车失效、/ @ 补全失效）：检测到身份
  变化即恢复输入面（名字/类型/选项/键位/钩子/b:变量）并把文件在新标签页
  打开；输入框键位缺失时 WinEnter 自愈重挂；启动守卫限定主标签页。

- **死代码清理**：移除未引用的 `dir_move` 与 `WorkspaceEntityLike.
  detachSession` / `WorkspacesService.insertBefore` / `InboxLike.hasPending`。

## [v0.2.9（2026-08-31）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.9)

- **修复 v0.2.8 自愈在"崩溃后又发过消息"的会话上失效**。v0.2.8 把合成
  tool/result 追加到日志末尾，但 DeepSeek wire 格式要求 tool 消息**紧跟**
  在 assistant 的 tool_calls 消息之后、中间不得有任何其他消息——崩溃后再
  发过消息的会话（如 php/che-card-repo 的 263 轮长会话）追加位置错位，
  配对仍不成立，400 依旧。v0.2.9 改为按 surface 位置外科修复：
  - assistant 消息位于**历史末尾**：仍补写合成 tool/result（紧跟配对，
    与宿主 interrupted-turn closer 同形；无 tool/call 事件的块用
    `TOOL_NOT_STARTED` 且不带 sourceEventSeqs——崩溃可能发生在它之前的
    调用上）；
  - assistant 消息之后**已有后续消息**：用 surface replace 就地改写该
    assistant 消息（悬空的 tool-call 块换成文字说明，reasoning/健康块
    保留），并把由此失去配对的 tool/result 表面节点替换为普通文字消息
    （v0.2.8 错位的合成结果也一并中和）——不再产生悬空 tool_calls 或
    孤儿 role=tool 消息。
- **验证**：用宿主真实持久化读取器重建 4 个毒化会话（php 263 轮 /
  159k 事件 / 33 事件双 tool-call 块等），按 wire 判定逐条核对：修复前
  全部不通过、修复后全部通过；类型检查 + smoke 通过。

## [v0.2.8（2026-08-31）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.8)

- **修复「bash 执行后会话卡死 + 400 insufficient tool messages」**。根因是
  `@deepseek-ai/dsh-tools` 被声明为**普通依赖**：pnpm 安装本插件时把它
  hoist 到 profile 的 `node_modules/@deepseek-ai/dsh-tools`，与宿主自带的
  拷贝形成**两份物理副本**。cordis loader 从 profile 目录解析 bundle
  entry `tools`，于是 `tools` 服务由插件副本构造，而 `dsh-agent-loop`
  （宿主副本）用自己那份 `TOOL_RUNTIME_SCHEDULER` unique symbol 去取
  `ctx.tools[TOOL_RUNTIME_SCHEDULER]` → `undefined` → 工具派发在
  **tool/call 事件已落盘之后**崩于 `Cannot read properties of undefined
  (reading 'prepare')`。该悬空 tool_call 永远没有 tool/result，此后每一
  轮请求重放「带 tool_calls 却没有 tool 消息」的 assistant 消息，被
  DeepSeek API 以 `insufficient tool messages following tool_calls
  message` 永久 400 拒绝——会话毒化、无法自愈（宿主编排层已知问题，社区
  #1337/#1633/#1665/#1677/#1697/#1959 同签名）。
  - `@deepseek-ai/dsh-tools` 改为 **optional peerDependency**（构建期仍以
    devDependency 提供类型）：profile 不再安装第二份拷贝，插件运行期从
    宿主解析 `defineTool`，与 `tools` 服务/agent-loop 保持同一实例；
  - **会话自愈**：打开会话时全量扫描 `tool/call` 无配对 `tool/result`
    的孤儿调用并补写 isError 合成结果（形状对齐宿主的 interrupted-turn
    closer：`TOOL_OUTCOME_UNKNOWN`）；回合以 `reading 'prepare'` 崩溃收尾
    时同步在回合末补写悬空结果（延迟到 turn/end 发布边界外），被毒化的
    旧会话打开即可继续使用，无需重建；
  - 崩溃时在聊天区给出可操作的提示（`pnpm why @deepseek-ai/dsh-tools`
    → `pnpm dedupe`）。
- **验证**：类型检查 + smoke 通过；对用户侧两份毒化会话日志
  （`session-7856853f`、`session-5ed28f79`、`session-03df1039` 等）取证：
  均为 `tool/call bash` → turn/end error `reading 'prepare'` → 后续全部
  400，与修复逻辑一一对应。

## [v0.2.7（2026-08-31）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.7)

- **全面适配 DeepSeek Harness v0.1.2-alpha.2**：peer 依赖
  `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-tools`
  升至 `^0.1.2-alpha.2`（cordis 4.0.2）；逐项核对 0.1.1-rc.2 → 0.1.2-alpha.2
  的 40+ 个包的 API 与事件契约（alpha.1 的 15 项优化 + alpha.2 的
  连接重试/定时计划/`SessionEvent.ignorable` 恢复等改动一并覆盖），
  结论与修复如下：

  - **破坏性变化（3 处已修）**：
    ① `dsh-permission-presets.current(events)` 改为 `current(session)`——
    `/permission` 两处调用改传会话；
    ② `dsh-user-questions` 移除 `registerProvider`，改为 scoped waterfall
    事件 `user-questions/request`——runner 改为在宿主事件上认领请求
    （`next()` 委托、`{answers}` 结算、AbortSignal 中止），删除过时的
    `UserQuestionsService` 接口；
    ③ `dsh-host-plugin-inventory.list()` 改为 async——`/plugins` 补
    `await`。
  - **顺带修复的预存 bug（与版本无关，两版同病）**：
    ① `/compact` 首参传错——真实契约是 `compactNow(agent, signal)`，
    旧代码传 `{session, options}` 导致 `agent.runMaintenance is not a
    function`，压缩永远失败，改传 live agent；
    ② `/permission` 显示预设标签读 `optionOf().label`——真实字段是
    `name`，标签从此生效；
    ③ `/search` 结果读 `h.title/sessionId/id`——真实结构是
    `h.header.id`，改用之；
    ④ `goal/change` 事件里 `roundsStarted` 是 `data` 的兄弟字段而非
    `data.goal` 的成员——状态栏目标进度从此显示真实轮数；
    ⑤ `/todo` 增加 `todos` 整日志投影兜底（dsh-tool-todo 注册的
    `projections.stateOf(session, 'todos')`），恢复会话不带事件重放时
    清单不再丢失。
  - **核实为兼容、无需改动的面**：`createUserMessage`/`defineTool`/
    `installModelSelection` 三处直接编译 API 签名不变；`Agent` 接口
    （session/status/cancel/followup/steer/inbox/options）、`AgentStatus`
    取值、`agent/status`、`subagent/start|end`、`workflow/*`、
    `approval/request` 事件 payload 全部不变（subagent 的 provider/model/
    reasoningEffort 选择加在请求侧而非事件侧）；会话事件
    `turn/*`、`assistant/*`、`tool/call`、`tool/result`（含
    `meta.diffs` 呈现）、`compaction/*`、`goal/change`、`todo/write`、
    `tool-workflow/*` 契约不变（`todo/write` 类型声明迁到
    dsh-tool-todo、`CallId`→`ToolCallId` 品牌改名均不影响运行时）；
    `sessionStats`/`contextBreakdown` 投影形状不变；
    settings/workspace/skill/plan/session-query/session-title/
    message-feedback/session-reference/file-reference/attachment/
    agent-default-model/agent-presets/session-persistence 服务契约不变。
  - **验证**：类型检查 + smoke 通过；scratch 安装
    `@deepseek-ai/dsh@alpha`（0.1.2-alpha.2）真机 e2e 通过（真实模型
    回复正常渲染）。
  - **新增 [UPGRADE.md](./UPGRADE.md) 升级指南**：宿主升级、插件更新、
    profile cordis.patch.yml 修正（删除与 alpha.2 dsh-base 重复的
    storage 三件套行、删除失效的 shipped 预设根）、第三方插件兼容
    （dsh-context 需 ≥ 0.38.5）、scratch 安全试跑与回滚，全部步骤实测。
  - **注意**：宿主需升级到 0.1.2-alpha.2
    （`npm i -g @deepseek-ai/dsh@alpha`）后再更新本插件；peer 范围
    `^0.1.2-alpha.2` 与旧宿主 rc.2 不混用。

## [v0.2.6（2026-08-29）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.6)

覆盖提交：
[`272e68d`](https://github.com/kovey/dsh-nvim-tui/commit/272e68d) ·
[`499122a`](https://github.com/kovey/dsh-nvim-tui/commit/499122a) ·
[`b513c61`](https://github.com/kovey/dsh-nvim-tui/commit/b513c61) ·
[`a12f7c3`](https://github.com/kovey/dsh-nvim-tui/commit/a12f7c3) ·
[`9e1725f`](https://github.com/kovey/dsh-nvim-tui/commit/9e1725f) ·
[`9f14b1b`](https://github.com/kovey/dsh-nvim-tui/commit/9f14b1b)

- **TUI 禁用鼠标**：nvim 的插入模式跟随窗口焦点，输入框插入时鼠标点弹窗
  会把插入状态拖进弹窗（且不触发 InsertEnter，事件拦截不可靠）；TUI 本身
  没有任何鼠标功能，直接禁用——start() 关闭 mouse，启动参数 OptionSet
  守卫把 mouse 加入快照名单（懒加载插件改回 `a` 也会被立即拍掉），从
  源头消除整类问题；窗口切换走 `<C-w>`/键盘。

- **diff 块高亮三处修复**：超大单个改动块不再渲染成空块（超限时渲染
  头部并统计真实 +/−，避免 `+0 −0` 空卡片被丢弃、diff 完全消失）；diff
  行组只保留背景色、文字颜色交给语法 token（不再出现行级 fg 与 token
  颜色的同字打架）；语法着色起始行对齐到第一条上下文行（修复前置上下文
  导致 token 整体向下错位——标题行/空行背着上一行的 token）。

- **弹窗标题背景对齐**：浮窗标题（FloatTitle）背景与编辑器背景一致——
  部分主题给标题组纯黑背景，标题条后拖一块黑；前景/加粗保留主题原样。

- **启动 buffer 协作（issue #4）**：takeover 不再于 VimEnter 批次内同步
  删除 startup buffer——删除延迟到批次结束后（vim.schedule），scratch 按
  argv(0) 名字定位（headless 启动时窗口可能显示无名 buffer），并加
  buf_is_valid / bufwinid / 空参数守卫；其他 VimEnter 回调（如 nvim-tree
  自动打开模板读 data.buf）不再抛 E5111。

- **C-c 停止修复**：输入框 `<C-c>` 一直发送 `dsh-abort` 通知，但 runner
  从未注册该分支、通知被静默丢弃；补上分支复用 /stop 同路（运行中
  agent.cancel + 停止提示，空闲时提示无运行回合）。

- **自然语言路由交给大模型**：规则匹配仍负责零延迟快路（斜杠命令、
  模式、精确短语）；**模糊的名词匹配不再擅自执行**——消息带路由提示发给
  agent，并注册宿主工具 `tui_command`（白名单内的 UI/安全命令），由
  大模型判断「执行命令还是正常聊天」后决定调用与否；匹配结果携带
  loose 标记区分快路与模糊。

- **更新说明修正**：git 依赖的 `dsh plugin update` 必须带 `--latest`
  （否则 pnpm 不重新解析分支 HEAD，见 issue #3）；固定版本用
  `add "kovey/dsh-nvim-tui#vX.Y.Z"`（git ref 语法，`@version` 会被
  pnpm 当作别名而报错）。

## [v0.2.5（2026-08-28）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.5)

覆盖提交：
[`de45977`](https://github.com/kovey/dsh-nvim-tui/commit/de45977) ·
[`b36a3ef`](https://github.com/kovey/dsh-nvim-tui/commit/b36a3ef) ·
[`012ee41`](https://github.com/kovey/dsh-nvim-tui/commit/012ee41) ·
[`7a477e0`](https://github.com/kovey/dsh-nvim-tui/commit/7a477e0)

- **弹窗背景对齐**：所有浮窗（弹窗/面板/菜单）的边框背景改为与编辑器
  背景一致——多数主题把 NormalFloat 渲染得比 Normal 深，弹窗边框像
  深色框浮在聊天上；现改为扁平的编辑器背景色，换主题自动跟随。

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
