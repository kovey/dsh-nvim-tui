# Changelog

本文件记录 dsh-nvim-tui 各版本的改动与新增。版本号遵循语义化约定，
每个版本标签的附注与本表对应条目一致。

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
