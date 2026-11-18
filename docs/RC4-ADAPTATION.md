# dsh 0.2.2-rc.4 适配记录（rc.2 → rc.4）

> **结论先行**：TUI 在 rc.4 宿主上**能启动**（最小 profile 下 rc4 peer 全绑定、headless
> exit 0；完整 profile 可能混合 rc2 peer，那种组合只证明宿主能起），并且 **TUI 源码零改动**
> ——rc.2 → rc.4 的 TUI 消费面只有一个**新增**错误码
> `CONTENT_REFUSED`，没有 breaking change；本仓库需要改的只是依赖锚点（peer / engines /
> dev）与文档。rc.4 新增的可见能力（DeepSeek 官网会话导入）、LiveShare 修复、桌面安装器
> 与 CI 改动都在 **Web / Desktop / 发布链路**，**TUI 不支持**，本文件也不把它们算进 TUI。

- 适配日期：2026-11-18
- 目标宿主：`@deepseek-ai/dsh@0.2.2-rc.4`（npm）
- 被测 TUI：`dsh-nvim-tui` 0.6.7（工作区 `lib/` 构建产物）。与验证时 profile 里那份
  `dsh-nvim-tui` 只做到 **`lib/` 逐文件 diff 为空**；那份的 `package.json` 仍是旧锚点
  （`peerDependencies` / `engines.dsh` / devDependencies 都还写 `0.2.2-rc.1`），因此
  **不能**据此说整包一致，也**不能**说验证时 profile 里的 manifest 已锚定 rc.4。
- 对照宿主：`0.2.2-rc.2`（本机全局安装，用作 rc2→rc4 的对比基线）

## 支持范围

| 面 | rc.4 上的状态 | 说明 / 证据 |
|---|---|---|
| TUI 进程 headless 启动（rc4 宿主 + rc4 peer 全绑定，**仅最小 profile**） | ✅ 已验证 | 最小 profile（`@deepseek-ai/dsh-base` + `dsh-nvim-tui`）`EXIT=0`；dump 有 banner / 会话 / statusline；`quit code=0`、`nvim-exit code=0` |
| TUI 启动（完整 profile，peer 混了 rc.2） | ⚠️ 只证明宿主能起 | `exit 0` ×2，但 ESM trace 里同时出现 rc.4 与全局 rc.2 路径 → 不能据此说 peer 全量绑 rc.4 |
| rc4 类型编译 | ✅ 已验证 | `tsc -p node_modules/.probe-rc4/tsconfig.rc4.json --noEmit` exit 0（path 映射到 rc.4 的 `lib/types`，覆盖整个 `src/`） |
| 真实模型对话 | ❌ 未验证 | 隔离 `DSH_HOME` 无凭据，按任务要求未做；不声称 rc.4 上跑过真模型 |
| 子代理 / AgentTeam / worktree / MCP / 工具错误码 / batch append | ⚠️ 未在 rc.4 上重跑 | 这些包的 `lib/`、`lib/types/` 在 rc.2 与 rc.4 之间逐字节一致；能力验证基线仍是 rc.1 |
| DeepSeek 官网会话导入（rc3） | ❌ 非 TUI | 官方入口只有浏览器 UI，无 TUI / CLI 入口（上传路由是浏览器前端用的 Host 端点，见下） |
| LiveShare 分享 | ❌ 非 TUI | 浏览器 / 桌面能力；rc4 只修了桌面端 tunnel worker 的 Electron Node 模式 |
| 依赖锚点（peer / engines / dev / lock） | ✅ 已完成 | `>=0.2.2-rc.4 <0.3.0`，dev 钉 `0.2.2-rc.4` |

## 验证环境与复现

```bash
# 隔离宿主（仓库内前缀，不污染全局）
npm --prefix node_modules/.probe-rc4 install @deepseek-ai/dsh@0.2.2-rc.4
node_modules/.probe-rc4/node_modules/.bin/dsh --version    # 0.2.2-rc.4

# 最小 profile：只含 dsh-base + dsh-nvim-tui（rc4 全绑定），headless 启动
bash node_modules/.probe-rc4/home-c/run-headless-c.sh      # EXIT=0

# rc4 类型（path 映射到 rc4 d.ts，覆盖 src/）
node_modules/.bin/tsc -p node_modules/.probe-rc4/tsconfig.rc4.json --noEmit   # exit 0
```

证据文件（都在 `node_modules/.probe-rc4/` 下，属于本地诊断产物，不入库）：

- `home-c/run-headless-c.sh`、`home-c/dump-c.txt`、`home-c/nvim-tui-errors.log`、
  `home-c/trace-resolved-copies.txt`（最小 profile）。注意该脚本带 `NODE_DEBUG=esm`，
  会写出一份**全量模块解析 trace**（`home-c/launch-c.err`，本次约 417 MB）；只需要结论时
  可 `grep -c` 后删除，不要把它提交进仓库。
- `home/run-headless.sh`、`home/dump.txt`、`home/nvim-tui-errors.log`、
  `home/trace-resolved-copies.txt`、`home/EVIDENCE.md`（完整 profile）
- `tsconfig.rc4.json`（rc4 类型路径映射）

本次（2026-11-18）重跑最小 profile 后的 trace 统计：`@deepseek-ai/` 解析命中
probe rc.4 路径 **689,356** 次、全局 rc.2 路径 **0** 次（`launch-c.err` 里 `grep -c`）。

## rc2 → rc4 逐项对比

### 1. TUI 消费面：4 个静态导入包

本仓库 `src/` 只静态导入 4 个 `@deepseek-ai/*` 包：`cordis`、`dsh-agent`、`dsh-llm`、
`dsh-tools`（`scripts/` 没有 `@deepseek-ai` 静态导入）。逐个对比 rc.2 与 rc.4 的 `lib/`：

| 包 | rc.2 → rc.4 | 差异 | 对 TUI 的影响 |
|---|---|---|---|
| `@deepseek-ai/cordis` | 4.1.0 → 4.1.0 | 无 | 无 |
| `@deepseek-ai/dsh-agent` | 0.2.2-rc.2 → 0.2.2-rc.4 | `lib/`、`lib/types/` 逐字节一致 | 无 |
| `@deepseek-ai/dsh-tools` | 0.2.2-rc.2 → 0.2.2-rc.4 | `lib/`、`lib/types/` 逐字节一致 | 无 |
| `@deepseek-ai/dsh-llm` | 0.2.2-rc.2 → 0.2.2-rc.4 | 只在 `LlmErrorCode` 枚举里新增 `CONTENT_REFUSED`（`lib/types/error.d.ts`、`lib/types/error.js`、`lib/index.js`） | 非 breaking：TUI 不本地映射 LLM 错误码，错误文本随会话事件原样显示 |

⇒ **TUI 消费面无 breaking change，`src/` 不需要任何适配改动。**

### 2. DeepSeek 官网会话导入（rc3，commit `b8c33a15`）

- **它是什么**：把 DeepSeek 官网导出的 `deepseek_data-*.zip` 上传到 Host，导入成所选
  工作区里的会话。包名 `@deepseek-ai/dsh-deepseek-chat-import`；对比 rc.2 与 rc.4 两份
  安装的 `@deepseek-ai/` 包清单，它是 rc.2 → rc.4 之间**唯一新增**的包。
- **官方入口只有浏览器 UI**（无 TUI / CLI 入口）：
  - Host 侧是给浏览器前端用的端点：owner-only 上传路由
    `/api/deepseek-chat-import/archive`；远程方法 `deepseekChatImport/limits(signal)`
    （仅 owner，其他 principal 一律拒绝）；依赖注入 `typert` / `connection` /
    `sessionPersistence` / `workspaceRegistry`。路由存在**不等于**给 TUI / 脚本的
    公开导入 API——它是浏览器前端调用的 Host 端点。
  - 浏览器：`sidebar.session.action` HOC 槽位，在「新建会话」行右侧加一个上传按钮 +
    导入对话框；按钮只对能调用 `deepseekChatImport/limits` 的 Peer 显示。
- **没有** TUI 命令、**没有** CLI 子命令——rc.4 的 CLI **没有** import 入口
  （这里只给结论，不列 `--help` 全量）、**没有** TUI 可调用的导入 API。
  默认还是「已安装但未启用」的可选实验 bundle：`dsh-official-bundles` 把它登记进
  可选 bundle 列表，`dsh-tool-cordis` 只是把 `deepseekChatImport` 写进服务目录。
- **TUI 结论：不支持，也不伪装支持。** 即使把 bundle 挂进 profile，TUI 也没有上传按钮 /
  命令；官方路径上唯一能触发导入的是浏览器 UI，TUI 没有可调用入口。详见
  `dsh-deepseek-chat-import/README.zh.md`。

### 3. `llm-deepseek` 内容安全审核与拒答（rc3 → rc4）

- **行为变化**：DeepSeek 以 `stop_reason: "refusal"` 结束流时，适配器**先 yield `usage`**
  （拒答前消耗的 token 已计费，保留）**再抛 `CONTENT_REFUSED`**；错误消息带提供方说明
  （例如哪些图片被拦截）。rc.2 对同一停止原因报 `MALFORMED_RESPONSE`。
  默认重试策略把拒答当终结，不重试；Web 会撤回已流式显示的回复，Session 把它保存在
  `assistant/attempt`，模型历史不含这段回复。
- **权威说明**：rc.4 包内自带升级指南
  `@deepseek-ai/dsh/docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md`。
- **TUI 影响**：无源码改动。TUI 按会话事件渲染，不按错误码分支，因此用户会直接看到
  `CONTENT_REFUSED` 的错误文本；如果外部脚本按 `MALFORMED_RESPONSE` 分类拒答，需要改判。
- **关于 `safetyCheck` 开关**：rc.2 → rc.4 的 compare 列表里有
  `feat(llm-deepseek): add safetyCheck switch`、`feat(llm-deepseek): always request the
  content safety check` 两个提交，但 **`dsh-v0.2.2-rc.4` tag 里 `config.ts` /
  `serialize.ts` / `wire-types.ts` / `types.ts` 与 rc.2 逐字节一致**，发布包里也检索不到
  `safetyCheck` 配置键（这两个提交的改动在发布前已被后续的
  `fix(llm-deepseek): handle refusals without requesting safety review` 抵消）。
  ⇒ rc.4 实际发布的是**拒答处理**，不是「安全审核开关」或「始终请求审核」；
  不要按该开关写配置。

### 4. LiveShare（rc4，commit `f0f05ba7`）

- **它改了什么**：启动 tunnel worker 时把宿主进程的 `ELECTRON_RUN_AS_NODE` 原样传给
  worker（新增 `workerNodeModeEnv`）。原因是桌面端 worker 跑在 `process.execPath`
  （即 Electron 本体）上，不继承 Node 模式就会被单实例锁当 GUI 应用杀掉，表现为
  「桌面端无法创建分享」。
- **对 TUI**：纯 Node 宿主下该环境变量为 `undefined` → 返回空对象，是 **no-op**。
  TUI 没有 LiveShare 的分享 UI，也没有消费其服务；不声称 TUI 支持分享。

### 5. 发布 / CI / Desktop 安装器

- `fix(ci): cache the verified bubblewrap archive and bound its download`：只改
  `.github/workflows/*` 与 `scripts/ci-*`，缓存并限定 bubblewrap 下载；无运行时 API。
- `fix/release-0.2.2-restart-status-cwd`（PR #8385）：只改 `apps/desktop` 的 Windows
  安装器 `restart-status` 与夹具；Desktop 专属。
- `release(dsh): 0.2.2-rc.4`：版本提交。TUI 侧没有需要跟随的发布脚本变化。

### 6. 其余运行时变动（与 TUI 无直接关系）

| 包 | 变化 | 与 TUI 的关系 |
|---|---|---|
| `dsh-session-log-export` | 导出归档时容忍不可读的附件引用（记录 missing 清单而不是整体失败） | TUI 只在本仓库内镜像 JSONL 形状（`src/kernel/session-log.ts` 注释所指），不导入该包 |
| `dsh-official-bundles` | 把 `dsh-deepseek-chat-import` 登记进可选 / 可见实验 bundle 列表 | GUI 插件页用；TUI 的 `/plugin` 不因此多出导入入口 |
| `dsh-tool-cordis` | 服务目录新增 `deepseekChatImport` 条目 | cordis 工具 / API 目录；非 TUI |
| `dsh-api-session-controller`、`dsh-client-modules`、`dsh-client-ui-*`（workspace / sidebar / directory-picker / settings / plugin-manager） | 浏览器 UI 的槽位与目录选择器配合导入功能 | 浏览器界面；TUI 无消费面 |
| `dsh-experimental-cua-macos` | macOS 原生 helper 二进制更新 | 与本适配无关 |
| `dsh-llm` 的若干下游包（`dsh-repeat-tool-reminder`、`dsh-tmux-context`、`dsh-session-persistence-jsonl` 等） | 只是打包时内联了新的 `dsh-llm` 枚举（多一行 `CONTENT_REFUSED`） | 无 API 变化 |

### 7. 能力相关包：零差异

`dsh-session`、`dsh-session-projection`、`dsh-subagent`、`dsh-tool-subagent`、
`dsh-agent-team`、`dsh-mcp-client` / `dsh-mcp-manager` / `dsh-mcp-resources`、
`dsh-experimental-worktree` / `dsh-experimental-tool-worktree`：
rc.2 与 rc.4 的 `lib/` 与 `lib/types/` **逐字节一致**（逐包 `diff -rq` 结果为空）。
工具批量调度**没有独立包**：类型在 `@deepseek-ai/dsh-tools` 的
`lib/types/batch.d.ts`（`executeToolBatch`）与 `lib/types/executor.d.ts`
（`ToolBatchInput` / `ToolBatchResult`），追加事件走 `@deepseek-ai/dsh-session` 的
`Session.append`（`lib/types/index.d.ts` 的 `Session` 接口）——`dsh-tools` 属上面
4 个静态导入包，`dsh-session` 属本节这份零差异清单；rc.4 安装树里**不存在**
`dsh-tool-batch` 包。
这解释了为什么 rc.4 上「不需要改源码」，但**不等于**这些能力已在 rc.4 上重新做过
运行时 smoke——类型一致与运行时通过是两件事，后者未做（见下）。

## 依赖锚点变更

| 位置 | 之前 | 现在 |
|---|---|---|
| `peerDependencies.@deepseek-ai/dsh-agent` | `>=0.2.2-rc.1 <0.3.0` | `>=0.2.2-rc.4 <0.3.0` |
| `peerDependencies.@deepseek-ai/dsh-llm` | `>=0.2.2-rc.1 <0.3.0` | `>=0.2.2-rc.4 <0.3.0` |
| `peerDependencies.@deepseek-ai/dsh-tools` | `>=0.2.2-rc.1 <0.3.0` | `>=0.2.2-rc.4 <0.3.0` |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0` | `>=0.2.2-rc.4 <0.3.0` |
| `devDependencies`（14 个 `@deepseek-ai/*`） | `0.2.2-rc.1` | `0.2.2-rc.4` |
| `package-lock.json` | rc.1 各包 | rc.4 各包；另补一个 rc.4 的 peer `@deepseek-ai/dsh-error@0.2.2-rc.4`（未写进 `package.json`，npm 自动补） |

注意：**本仓库当前的 `node_modules` 尚未重装，仍是 `0.2.2-rc.1` 的包**（lock 已锁 rc.4）。
因此本机 `npm run build/check/test` 用的是 rc.1 类型；rc.4 类型由上面的
`tsconfig.rc4.json` path-mapped `tsc` 单独验证。真实 `npm ci` / `npm install` 之后应重跑
一次 build/check/smoke，并确认 `lib/` 产物 diff 为空。

## TUI 侧需要改什么

- **源码：零改动。** 依据：4 个静态导入包中 3 个零差异，`dsh-llm` 只多一个枚举值；
  TUI 没有对错误码做本地分支。
- **没有可「适配」出来的 rc4 新能力。** rc4 唯一面向用户的新功能（DeepSeek 导入）只有
  浏览器入口，没有 TUI 可调用的 API——正确的做法是标注「不支持」，而不是造一个
  只能靠上传路由模拟的伪功能。
- **依赖与文档：** 已改 `package.json` / `package-lock.json` / `README.md` /
  `CHANGELOG.md` / `UPGRADE.md` / 本文件。版本号与 `BUILD_VERSION` 未改（仍是 0.6.7）。

## 未覆盖与风险

- 未做真实模型对话：隔离 `DSH_HOME` 无凭据。
- 未在 rc.4 上逐项跑能力 smoke（subagents / AgentTeam / worktree / MCP / 工具错误码 /
  batch append）。当前证据只有「类型面零差异 + rc.4 能启动」；这些能力的最近一次真机
  验证仍是 rc.1。
- 完整 profile（`engineering-suite` / `chat-interaction` 等插件）没有做 peer 全绑 rc.4 的
  启动验证：把整棵 profile 物化进隔离树时 `cp -RL` 会因包间符号链接循环失败。可行替代是
  把本地构建包以 tarball 装进隔离 profile，本次未做。
- 最小 profile 里那份 `dsh-nvim-tui` 与工作区**只有 `lib/` 一致**：它的 `package.json`
  仍是旧锚点（`peerDependencies` / `engines.dsh` / devDependencies 写 `0.2.2-rc.1`）。
  所以那次 headless 启动证明的是「工作区 `lib/` 产物 + rc.4 宿主 + rc4 peer」，**不是**
  「已发布的 `dsh-nvim-tui` 包 manifest 已锚定 rc.4」。
- 混合 peer 场景（rc.4 宿主 + rc.2 插件）能启动，但**不能**据此声称 rc.4 全量真机；
  该场景下 profile 作用域的模块路由不覆盖树外链接的包，裸导入按 Node 原生规则解析。
- 本文件只回答 rc.2 → rc.4。rc.1 仍是能力验证基线；rc.2 只做过结构适配
  （见 `UPGRADE.md` 的 v0.6.6 → v0.6.7 小节）。

## 附：rc.2 → rc.4 提交清单（14 个）

来自 GitHub compare `dsh-v0.2.2-rc.2...dsh-v0.2.2-rc.4`，并标注与 TUI 的关系：

| 提交 | 说明 | TUI |
|---|---|---|
| `68f83cc9` | `fix(ci)`: 缓存并限定 bubblewrap 下载 | 无关 |
| `bbad94f9` | 上述 PR 合并 | 无关 |
| `ac904e11` | Desktop Windows 安装器 `restart-status` 修复 | 无关（Desktop） |
| `b8c33a15` | rc3：DeepSeek 官网导出导入为会话 | 不支持（浏览器） |
| `4c1cf20c` / `38a6a5c9` | `release(dsh): 0.2.2-rc.3` 及其合并 | 版本 |
| `f250e232` | `feat(llm-deepseek)`: `safetyCheck` 开关（同提交加入 `CONTENT_REFUSED` 枚举与拒答处理初版） | 枚举保留；`safetyCheck` 开关**不在 rc.4 tag 树里** |
| `15762ffc` | `feat(llm-deepseek)`: 始终请求安全审核 | **被抵消**：tag 的 `serialize.ts` / `wire-types.ts` 与 rc.2 逐字节一致 |
| `e68c0334` | `fix(llm-deepseek)`: 拒答不请求安全审核、报 `CONTENT_REFUSED` | 已发布（本适配相关的唯一净变化）；TUI 兼容 |
| `74b0e1d9` | 上述 PR 合并 | — |
| `9176a089` | LiveShare 测试用真实时钟推导凭据期限 | 无关（测试） |
| `f0f05ba7` | LiveShare 桌面端 tunnel worker 继承 `ELECTRON_RUN_AS_NODE` | 无关（Desktop；纯 Node no-op） |
| `bc3bddff` / `3f321d32` | `release(dsh): 0.2.2-rc.4` 及其合并 | 版本 |
