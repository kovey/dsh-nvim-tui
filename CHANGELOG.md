# Changelog

本文件记录 dsh-nvim-tui 各版本的改动与新增。版本号遵循语义化约定，
每个版本标签的附注与本表对应条目一致。

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
