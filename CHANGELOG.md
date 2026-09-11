# Changelog

本文件记录 dsh-nvim-tui 各版本的改动与新增。版本号遵循语义化约定，
每个版本标签的附注与本表对应条目一致。

## [v0.4.1（2026-09-11）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.4.1)

覆盖提交：
[`017f3f2`](https://github.com/kovey/dsh-nvim-tui/commit/017f3f2) ·
[`a46e8f0`](https://github.com/kovey/dsh-nvim-tui/commit/a46e8f0) ·
[`7b2afdd`](https://github.com/kovey/dsh-nvim-tui/commit/7b2afdd) ·
[`30daefd`](https://github.com/kovey/dsh-nvim-tui/commit/30daefd) ·
[`84cd00f`](https://github.com/kovey/dsh-nvim-tui/commit/84cd00f) ·
[`a7cd3ba`](https://github.com/kovey/dsh-nvim-tui/commit/a7cd3ba)

> **版本说明**：本版相对 v0.4.0 共 6 个提交，一个宿主版本对齐、一个新命令、
> 两处修复（含各自的自查返工）。**零破坏**：不需要动宿主、不需要改
> `cordis.patch.yml`。升级前请先读 [UPGRADE.md](UPGRADE.md)。

### 1. dsh v0.1.5-rc.2 对齐（peer 锚点 `^0.1.5-rc.2`）

逐包核对 15 个 `@deepseek-ai` 发布包（212 个文件逐文件 sha256）：

- **结论：运行时代码与类型面零差异** —— 197 个文件逐字节相同，15 个仅
  `package.json` 版本号变动（忽略键序后内容等价，无依赖增删）。
- 官方侧印证：release notes 只列两项 **web UI** 优化（消息反馈弹窗确认、
  交付文件卡片排版与图标）；commit 区间仅 4 个提交，非 `package.json` 的
  改动全在 `apps/web/tests` 与 `packages/client/*`（Web 客户端 React 组件，
  不随 npm 包发布）。**因此本版无源码改动，只对齐锚点与文档。**
- **锚点区间仍接受 rc.1**：`^0.1.5-rc.2` 的下界是 rc.2、上界是 `<0.2.0`，
  故 rc.1 与 rc.2 宿主可互换使用。
- **纠正一处常见误解**：`0.1.5-rc.2` 是**预发布版（release candidate），
  不是稳定版** —— npm 的 `latest` dist-tag 仍停在 `0.1.0-rc.6`，rc.2 只挂在
  `next` 上。安装必须显式 `@next`（或写死版本号），否则会装到旧的 `latest`。
  README/UPGRADE 已补此警告。

### 2. 新特性：`/plugin` —— 市场目录之外的插件直装入口

`/market` 是目录驱动的，只能安装 awesome-dsh-plugin 目录里列出的插件；
小众/私有/自建插件搜不到就无从下手。`/plugin` 直接对接官方 `dsh plugin` CLI：

- `/plugin install <spec>`：`spec` 可为 npm 包名 / `owner/repo` / git URL /
  含空格的本地路径，CLI 认得的写法原样透传。
- `/plugin remove <spec>`、`/plugin list`（列出该 profile 已装插件）。
- 目标 profile 取**本进程实际启动的那个**（`runningProfileName` → 配置回退），
  绝不猜 `nvim-tui` —— 装到别的 profile 对当前进程等于没装。
- 失败只做**一次有界补救**（按 `classifyPnpmError` 分型：cache 类换全新 npm
  cache 重试，network/lockfile 类重试一次）；`remove` 不补救。
- **安全**：该命令**不在** `TUI_COMMAND_WHITELIST` 内，agent 侧 `tui_command`
  工具无法调用它（装任意包＝任意代码执行，与 `/market`、`/deps install`
  一致地留在用户手里）。`spec` 以 `-` 开头一律拒绝（会被 CLI 当成 flag）。

### 3. 修复：`/deps install` 全量跳过 / 提示误导

用户实机反馈：`/deps install` 逐条「跳过 X: 包 … 不在当前 dsh 安装中」→
「没有可写入的行」，一行都没写入，而包其实都在。定位到三层问题：

- **安装根探测缺项**：候选根只有「dsh 包目录的祖父 / 插件自身根」，
  而宿主插件真正位于 dsh 自带的 store（`<dshDir>/node_modules/@deepseek-ai/*`）
  与共享 store（`$DSH_HOME/profiles/node_modules`）—— 两者都不在候选里。
  补上后 11 个模板包全部命中。
- **候选根层级错误**：`dirname(dirname(dshDir))` 展开成
  `…/node_modules/node_modules/…`，结构性错误路径、永不命中。首轮修复
  只因新增的 store 候选恰好在场才「看起来修好」，**换成别的 `DSH_HOME`
  或 store 尚未建立的首次启动会再次全量跳过** —— 该层是自查阶段才发现的。
- **提示把定位失败说成包缺失**：新增 `installRootResolved()` 区分
  「无法定位 dsh 安装根（重启 dsh 后重试）」与「包确实不在安装中」，
  不再用一句「升级 dsh 后重试」把功能藏起来。

### 4. 修复：e2e 无凭证时假报 PASS（并修掉其反向缺陷）

`scripts/e2e.ts` 在完全没有模型回合发生时会报 `E2E PASS`，两个独立缺陷叠加：

- 「有 assistant 内容」的判定只看 turn 标记之后是否非空，而宿主注入的
  runtime-context 块与用户自己的 prompt 回显都在标记之后 → 检查恒真。
- 判错正则只有英文 `no API key`，中文宿主的「未检测到 API key」不匹配。

修复后**反例确实失败**（无 key → `FAIL: no assistant content`，exit 1），
有 key 时仍 PASS 且 dump 内确认模型真答。

> **自查返工**：首版修复为排除注入上下文而**一刀切丢弃所有以 `·` 开头的行**，
> 但模型输出是整块 push、不带 gutter，于是「以 `· ` 项目符号作答」的正常回合
> 会被整段误判为「无助手内容」而 FAIL —— 修假阳性时引入了假阴性。已改为
> 按块排除注入块。两个细节由真机 dump 逼出：注入块内部空行渲染成**裸 `·`**
> （尾随空格被 trim），只认 `· ` 会让块提前结束；定界符 `── turn ──` 是收尾
> `── turn end ──` 的**子串**，未锚整行的 `lastIndexOf` 会取到错误起点。

### 5. 工程：把高风险判定抽为纯函数 + 变异验证

上述两处缺陷能溜进来，根因是判定规则**内联在脚本里、零覆盖**，只能靠真机
跑歪才发现。本版做了结构性补救：

- 抽出 `scripts/e2e-judge.ts`（`judgeDump`/`turnBody`/`assistantText` 纯函数，
  自带 `node scripts/e2e-judge.ts` 自测），`e2e.ts` 改为调用它。
- `parsePluginArgs` 抽为纯函数，覆盖动词/别名/含空格 spec 透传/缺 spec/
  未知动词/leading-dash 拒绝。
- smoke 增三组断言：e2e 判定（真实渲染形态必须 PASS，回显/注入块/错误标记
  必须 FAIL）、`/plugin` 参数解析、安装根候选集（必须含 dsh 自带 store，
  且任何候选根展开后不得出现双 `node_modules`）。
- **变异验证**（确认断言不是空转）：把块排除改回「过滤所有 `·` 行」→
  smoke 报 `accepts: regression: pure bullet answer` 失败；改回只认 `· ` →
  报 `rejects: no-key with blank injected lines` 失败；移除 `dshDir` 候选 →
  报 `dsh package dir is an install-root candidate` 失败。
- `tsconfig.scripts` 开 `allowImportingTsExtensions`（`scripts/` 不产出，
  Node 直接以 `.ts` 运行，脚本间导入需写 `.ts`）。
- `.gitignore` 补验证用临时 harness 目录（`.probe-home/` 等）。

> **测试方法学**：`packageExists` 的 smoke 断言原先**自行注入**
> `DSH_NVIM_TUI_INSTALL_ROOT` —— 用被测逻辑的替身做验证，正是该缺陷长期
> 漏网的原因。现改为不做任何 env 注入、直连真实 store 断言。

### 验证

`npm run check`（tsc 双 tsconfig + 架构 + 78 域操作）· `npm run smoke`
（含上述三组新断言，SMOKE PASS）· `npm run i18n:report`（死键 0 / 未翻译 0）
全绿；真机 e2e 正反例双跑（无 key FAIL / 有 key PASS）；11 个模板包经 store
根全部命中，反向对照包仍 false。

## [v0.4.0（2026-09-10）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.4.0)

覆盖提交：
[`5ff1b28`](https://github.com/kovey/dsh-nvim-tui/commit/5ff1b28) ·
[`7e27a05`](https://github.com/kovey/dsh-nvim-tui/commit/7e27a05) ·
[`aff0b0d`](https://github.com/kovey/dsh-nvim-tui/commit/aff0b0d) ·
[`6ddae4d`](https://github.com/kovey/dsh-nvim-tui/commit/6ddae4d) ·
[`63bbb69`](https://github.com/kovey/dsh-nvim-tui/commit/63bbb69) ·
[`82770e5`](https://github.com/kovey/dsh-nvim-tui/commit/82770e5) ·
[`2bb6855`](https://github.com/kovey/dsh-nvim-tui/commit/2bb6855) ·
[`fc797d8`](https://github.com/kovey/dsh-nvim-tui/commit/fc797d8) ·
[`a14c7a7`](https://github.com/kovey/dsh-nvim-tui/commit/a14c7a7) ·
[`d530126`](https://github.com/kovey/dsh-nvim-tui/commit/d530126) ·
[`1a9d5fe`](https://github.com/kovey/dsh-nvim-tui/commit/1a9d5fe) ·
[`c350c24`](https://github.com/kovey/dsh-nvim-tui/commit/c350c24) ·
[`386dbdd`](https://github.com/kovey/dsh-nvim-tui/commit/386dbdd) ·
[`09a5829`](https://github.com/kovey/dsh-nvim-tui/commit/09a5829) ·
[`986ed41`](https://github.com/kovey/dsh-nvim-tui/commit/986ed41) ·
[`637f809`](https://github.com/kovey/dsh-nvim-tui/commit/637f809) ·
[`5438bc6`](https://github.com/kovey/dsh-nvim-tui/commit/5438bc6) ·
[`5271090`](https://github.com/kovey/dsh-nvim-tui/commit/5271090) ·
[`e82ee37`](https://github.com/kovey/dsh-nvim-tui/commit/e82ee37)

> **版本说明**：原计划的 `v0.3.5` 未单独打标签发布，其全部内容并入本版；
> 本版相对 v0.3.4 共 19 个提交，涵盖 0.1.5-rc.1 适配、两个新特性、
> 一次全代码库审计（9 批 91 项修复）与 TypeScript 严格性拉满。
> 升级前请先读 [UPGRADE.md](UPGRADE.md)。

### 1. dsh v0.1.5-rc.1 全面适配（peer 锚点 `^0.1.5-rc.1`）

逐包核对官方 release notes / session V3 迁移文档 / 22 个依赖包的类型面差异：

- **`ctx.sessions` 移除**：live 会话存储并入 `ctx.agents`（`agents.get/list`
  返回的 Agent 携带 `.session`）。TUI 注入面改为 `['agents','agentDefaultModel']`，
  自建 `liveSessions` 适配器；**双宿主兼容**（0.1.2-rc.1 仍可用）。
- **sessionPersistence 新 API**：`list()` 快照（`{header,revision,…}`）归一化；
  冷读改 `open(id,'read').read()` + `close()`；`supportsRawArtifacts` 缺失时
  清理路径降级为仅隐藏。
- **Session V3 日志**：surface replace 改 `startSeq/endSeq`；新增
  `system/message` 事件；恢复回放补齐 `session/title`（标题不再丢）。
- **subagents 续聊**：改走公开 `subagents.prompt(...)`（requestId + queue/steer），
  保留旧符号键路径兼容旧宿主。
- **识图**：候选优先 `deepseek-flash`（0.1.5 新默认，自带 image）+ `llm.listModels`
  目录扫描兜底；识图切换会丢弃模型不支持的 `reasoningEffort`
  （避免 `UNSUPPORTED_REASONING_EFFORT`）。
- **工程**：`devDependencies`/lockfile 对齐 0.1.5-rc.1，并**在 0.1.5 类型面上**
  跑通 `tsc` + 架构/域操作门禁 + smoke（compile-time 不再对着 0.1.2）。

### 2. 新特性：`/difficulty` 按任务难度自动选模型（M1-M4）

- M1 显式档位 `easy|medium|hard|auto|off` + runner config `difficultyRouting.tiers`
  （HMR 生效）；M2 规则定档（计划模式/活跃目标/工具失败数/关键词/长度）；
  M3 可选 LLM 分类器（便宜模型打分，**分类失败/超时回退规则**，不再误判为 medium）；
  M4 子代理模型闸门同步（官方 `subagent-model-selection`）。
- 发送前临时切换会话模型，回合结束自动切回全局默认；状态栏档位徽标 🟢/🟡/🔴；
  手动 `/model` 暂停路由（`/difficulty auto` 恢复），`agentDefaultModel` 不被污染。
- **排队消息不再中途改模型**：回合运行中到达的消息只"停放"估算，turn/end 恢复后
  再为排队回合切换（此前会静默改掉运行中回合的后续步骤模型）。
- 档位模型切换前经 `listModels` 目录校验 + effort 兼容校验；`medium` 档位配置可生效；
  `tiers.*.effort` 与当前相同 provider/model 的 effort 差异也能触发切换。

### 3. 新特性：待办清单纪律守卫（逐项更新硬约束）

- 每个 agent 作用域注入常驻 system-prompt 段落 + `agent/pre-step` 逐步提醒：
  某一步有工具调用却没写清单、且仍有未完成项时，向**下一次请求**注入具体未完成项
  清单（每回合上限 3 条）——把"逐项更新"从模型自觉变成代码层面的硬性要求。
- 关闭：`config.todoGuard: false` 或 `DSH_NVIM_TUI_TODO_GUARD=0`。
- 回归保护：smoke 新增"回合内流式输出中连续 `todo/write` 中间态即时渲染"断言。

### 4. 新特性：英文模式（i18n）完整覆盖 + `/locale` 双向

- 补齐全部英译并清理死键，`npm run i18n:report` 现为 **628 键 / 631 引用 /
  0 死键 / 0 未翻译**；新增「未走 `t()`/`tf()` 的中文字面量」指标
  （489 → 169，余量均为不应翻译项：`nlcmd` 意图匹配表、模型侧提示、RPC 名、配置键）。
- 新增 `tf(zh, {vars})`：`t()` 用在模板字符串上永远命中不了字典（传入的是已插值串），
  这类调用在 en 模式恒显中文——已全部改为占位符模板（每个插值独立占位符，求值顺序
  与原代码逐字一致）。
- `/locale zh|en` **双向**：`t()` 维护反向索引、命令目录在推送时翻译，
  zh→en→zh 往返一致。

### 5. 全代码库审计（[docs/REVIEW-2026-09.md](docs/REVIEW-2026-09.md)，9 批 91 项）

14 个单元在 `deepseek-v4-flash` 上并行审计（157 条发现）+ 对抗性复核，随后分 9 批修复。
高危要点：

- **渲染管线阻断**：多行字符串（workflow 阶段/错误详情/卡片文案来自宿主与模型）
  会让 `nvim_buf_set_lines` 整体失败（E5108）→ 末行统一折叠；`toolActivity` 在
  turn/end 不清导致 500ms 自续 flush 死循环 + 幽灵"运行中"行 → 清理。
- **启动/退出安全**：入站监听提前到 `attach` 之前（此前 `User DshTuiAttach` 里的
  `rpcrequest` 无应答 → Lua 侧阻塞在 attach 内**双向死锁**）；启动失败退出码不再为 0；
  `/restart` 在旧 nvim 未死时**取消重启**；退出预算覆盖 closeNvimWindow 最坏耗时
  （此前 2000ms 早于 2.5s 清理窗口，flush 被截断）。
- **会话生命周期**：resume 回放失败整体回滚（半挂载记录会让会话永远打不开）；
  `disposeLiveSession` 改"先 dispose 后 delete"（消除 `session already exists` 竞态）；
  `/sessions` 的「未分组」真正实现（此前是死行）。
- **`/deps install` 恒为空操作**（根因）：`packageExists` 只按 profile 根解析，而
  11 个宿主插件全在 **dsh 安装根**下 → 所有装配行被跳过。现已按 dsh 包目录解析
  （实测 11/11 命中）。
- **`/market` 自修复链**：候选源全失败时恢复原安装（不再留下"已卸载"却报"入口缺失"）；
  入口判定支持 `exports`-only 包；spec→包名精确派生；CLI 超时补 SIGKILL + `'close'`。
- **用户 patch 保护**：`readPatch` 仅在 `ENOENT` 视为空，其余读失败**中止写入**
  （此前会把整份 `cordis.patch.yml` 改写成空）；运行 profile 可解析时不再回退目录扫描
  （避免写进另一个 profile）。
- **子代理**：running 语义修正（宿主 `activity` 只是"驻留"）；冷读句柄 `try/finally`
  关闭；`/subagents` 实现"可取消"。
- **其它**：`@` 补全服务抛错时降级本地扫描 + 4s/30s 有界超时；`~` 展开修复
  （`/image`/`/attach`）；`splitImageDataUrls` 全局扫描（第二张粘贴图不再漏发）；
  推理面板自愈；卡片 mark 逐卡隔离；`/rewind` 重建不再重复累加用量；`/deps` pnpm
  版本探测修复；`estimateCost` 补齐 0.1.5 catalog（含 `deepseek-flash`）+ 族名回退；
  `/theme` 切回 `default` 真正重置；`/density` 即时重绘并持久化；workflow 运行表按
  会话隔离且限界；`/fb` 不再把列表失败当"无反馈"；`/memory` 递归列举。
- 完整报告（含 14 个单元的全部发现、复现探针与"判定不是问题"的清单）随仓库发布于
  [docs/audit-2026-09/](docs/audit-2026-09/)。

### 6. TypeScript 严格性（按标准拉满）

- 移除 `SessionRec` 尾随索引签名（字段拼错不再静默通过）。
- 启用 `noUncheckedIndexedAccess`、`noPropertyAccessFromIndexSignature`、
  `exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noImplicitOverride`、
  `noFallthroughCasesInSwitch`、`noImplicitReturns`、`allowUnreachableCode:false`，
  并修完全部暴露点（索引访问 71 / 动态属性 63 / 可选属性 36）。
- 宿主边界（`ModelSelection.reasoningEffort`）改**条件展开**，保证"缺省 ≠ 显式
  undefined"；`ApprovalRequest.signal` 改用标准 `AbortSignal`，审批/问答的 abort
  监听器在结算时摘除。

### 7. 其它修复

- `/market` 行距：★ 与星数间加空格、星块与名称间隔加大（宽字形字体下星星不再遮挡数字）。
- `/deps install` 一步到位：写入后等待热重载就绪，超时自动重启 dsh；配置一律写入
  **启动时的真实 profile**（loader include 条目解析，删除硬编码 `nvim-tui` 回退）。
- 鲸鱼动画补齐 6 个未定义高亮组（不再回落默认色并帧间闪烁）；空文件 diff 不再
  多出 `+ ` 行；步骤进度块不再被提升到正文之上；表格 `\|` 反转义。

## [v0.3.4（2026-09-09）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.3.4)

覆盖提交：
[`1f36ecd`](https://github.com/kovey/dsh-nvim-tui/commit/1f36ecd) ·
[`c3ff1b2`](https://github.com/kovey/dsh-nvim-tui/commit/c3ff1b2) ·
[`c1cdd58`](https://github.com/kovey/dsh-nvim-tui/commit/c1cdd58) ·
[`284c9fe`](https://github.com/kovey/dsh-nvim-tui/commit/284c9fe) ·
[`d065e7f`](https://github.com/kovey/dsh-nvim-tui/commit/d065e7f) ·
[`6e629ab`](https://github.com/kovey/dsh-nvim-tui/commit/6e629ab)

覆盖：docs/REVIEW-2025-09.md 全面代码审查报告的 TOP15 修复清单（7 🔴 / 33 🟠 精选）。

- **修正 v0.3.3 的失实声明**：「live 会话 LRU 软上限 16」实际从未生效——session.lua
  中 `SE.close_chat` 因结构损坏（`toggle_reasoning` 丢失 `end`，函数被嵌套定义）
  从未导出，且 runner 侧无任何调用者。本批修复 `session.lua` 结构并落地
  `close_chat` + rename 后台恢复会话的 dispose 调用链。
- **并发审批/提问队列修复**：`dsh-approval-decided` 在 `settleApproval` 后无条件
  `setApproval(null,null)` 抹掉刚晋升的排队审批（并发父+子代理第二个审批永久挂起）；
  questions 处理器绕过 `settleQuestions`/`advanceQuestions`（同族挂起）。均修复。
- **ext-api 公共面修复**：`tui.ready` 永不 resolve（`fireExtReady` 置 null 不调用，
  readyWaiters 无人 push）——官方示例插件初始化链静默瘫痪；`luaExt.on` disposer
  无视 token 误删新 handler；`nvim.request`/`registerCommands` 入参守卫；
  执行层白名单契约三方对齐（`systemlist` 移出只读白名单，任意执行走 nvim.lua/ex）。
- **/rewind 数据安全**：数字参数从末尾计数颠倒为从开头计数（`/rewind 2` 曾删光
  除最后 2 条外全部历史），数字路径补确认弹窗；重建后 ✎ diff 块因去重缓存未随
  feed.clear 失效而消失的问题修复。
- **渲染修复**：diff 区域内的表格上下文行不再被表格检测抢先消费；ExtCard.update
  按上次合并态叠加（连续部分更新不再静默丢字段）；jobs 板去重不再被心跳重填抵消
  （旧板重复提交聊天流）；`??`→`||` 修复 0ms 假耗时。
- **进程生死竞态**：boot 每个 await 后检查 disposed（teardown 撞 spawn 窗口不再
  产生 ghost nvim/泄漏定时器）；nvim 启动失败退出码从 0 修正为非 0（fatal 改走
  stderr）；`nvim.channelId` 握手加超时；headless watchdog 提前布防；openPicker
  失败结算按身份校验。
- **安全/确认**：tui_command 白名单移除 `/settings`、`/memory`（破坏性参数路径）；
  `/quit` `/exit` `/restart` 加确认，nlcmd 删除单字符 `q` 路由；`/memory delete`
  加确认；market 自卸载保护修复（过滤顺序致保护恒假）。
- **Lua 前端**：`vim.uv` → `(vim.uv or vim.loop)`（0.9 崩溃）；input buffer 自愈
  重建补窗口挂载；top/bottom region q/Esc 显式传 side；at_menu 陈旧响应守卫；
  full_input footer 0.10 守卫；region_claim pcall + `{err}` 契约；reasoning 兜底
  走 ensure_reasoning（不再泄漏幽灵 buffer）。
- **命令层**：yolo 自然语言路由带固定参数（方向不再 50% 反）+ 无效参数报用法；
  /model 复用 /models 目录（真实选择器 + provider/model 校验）；/image 相对路径
  按 activeSessionCwd 解析；/new 无参走目录选择器（兑现 README 承诺）；workspace
  可选服务不再假成功；refreshHistory 存储失败可见。
- **会话生命周期**：ensureLiveSession 并发去重；rename 后台恢复会话完成/取消后
  dispose；后台恢复不再触碰全局视图状态。
- **状态栏空白回归修复（2026-09-09）**：上一批 S6 修复让 boot 恢复路径的 attach
  走 `background: true`，不再设置全局视图指针——`chatWinId` 恒为 null，
  `updateStatusline` 首行即返回，恢复会话后聊天状态栏（权限模式/模型/缓存/
  tokens/耗时/成本/spinner）整条空白。修复为 `switchTo` 在 `set_active` 后从
  Lua `ids()` 同步视图指针（chatWin 本就是共享窗口、reasoningWin 是全局面板
  状态，同步幂等），S6 的「行操作不移动可见视图」语义保留。headless dump 新增
  `## statusline` 段，使该回归可被 e2e 断言。
- **待办面板改为常驻钉住（2026-09-09）**：原实现把待办面板当「回合内状态」——
  `turn/start` 清空、`turn/end` 提交进转录，回合一结束待办块就被后续聊天内容
  顶进历史（且下回合的 todo/write 只在回合内实时更新）。现与任务板同一机制：
  未完成列表**跨回合钉在聊天区底部**（thinking 行之上），每次 todo/write 原位
  实时刷新；全部 ✓ 时一次性提交终态入转录（去重键跨回合，重复重放不再堆叠）；
  空列表只清钉住槽不入转录。smoke 断言同步更新（turn/end 不再提交、跨回合
  钉住、空列表清槽）。
- **待办落盘即清空（2026-09-09）**：宿主 `todo_write` 每次整表重发且常保留
  旧已完成项，导致面板与逐次提交的列表无限增长。修复：全部 ✓ 提交入转录后
  这些完成项进入 flushed 集合——后续整表重发不再显示、不再重复提交；重新
  打开（非 completed 状态）的项自动回归。状态栏计数与 /todo 浮窗同步使用
  flushed 视图。任务侧已由上一批 F4 的 `committedJobKeys` 保证同语义（
  jobs.list 永久返回终态任务，提交后不再混入新批次面板）。
- **弹窗内禁用 <C-o> 开面板（2026-09-09）**：光标在弹窗（/todo、/sessions、
  子代理对话…）里按 `<C-o>` 会破坏弹窗——根因两层：① 浮窗创建时继承了焦点
  窗口的 jumplist，裸 `<C-o>` 走默认跳转把浮窗 buffer 换成输入 buffer（内容
  丢失、弹窗键位失效），随后再按 `<C-o>` 命中的是输入 buffer 的面板映射 →
  面板在浮窗后打开且 `I.focus()` 抢走焦点；② 子代理输入弹窗曾显式映射
  `<C-o>` → toggle。修复：`toggle_reasoning` 加浮窗守卫（仅 chat/input/面板
  自身可触发）；`popup_core.lock_jump_keys` 对所有弹窗 buffer Nop
  `<C-o>`/`<C-i>`/`<C-^>`（`lock_popup_buffer` 内置 + 子代理视图/对话转录
  显式应用）；子代理输入与全屏编辑器 insert 模式 `<C-o>` Nop（防内置
  i_CTRL-O 吞下一键）。smoke 6g 升级为真实按键断言（jumplist 键不换
  buffer、面板不打开、内容完好、焦点不丢）。
- **首次启动 API key 引导（2026-09-09）**：boot 增加 `maybeOnboard`——
  按当前 provider 的凭证引用（deepseek→DEEPSEEK_API_KEY 等）镜像宿主 llm
  适配器的判定（credentials seam resolve → 环境变量）检查 key；未配置时
  首次启动在聊天区渲染一次性引导块（环境变量 export / 凭证文件
  ~/.dsh/.credentials.yaml 的 refs 段 / 官方 Models 页面三种方式），标记
  落盘 `~/.dsh/nvim-tui-onboarded.json`（`DSH_NVIM_TUI_ONBOARD_FILE` 可
  覆盖，供测试）；后续启动仅单行提醒不重复引导。/settings 概览新增
  「API key 凭证」段：路由→凭证引用、配置状态、凭证文件路径与配置方式。
  e2e 三路径实测：key 存在不引导、key 缺失首次引导块+标记、二次启动仅
  单行提醒。
- **/restart 终端抢占根修（2026-09-09）**：旧实现确认后立即 spawn 新 dsh 且
  `detached: true`，共四个缺陷叠加：(1) 新旧两个 nvim 并发持有终端，旧实例
  退出时的 alternate screen 恢复与 kitty keyboard protocol 关闭打在新实例的
  tui 协商上；(2) detached 后继落入独立孤儿进程组，旧 dsh 一退出 shell 立即
  判定前台作业结束、抢回终端（打印提示符、开始读键盘）——zsh 与后继 nvim
  抢键盘输入，kitty 编码序列被原样回显成 `[108;1:3u` 乱码、提示符画进 TUI；
  (3) nvim 的 `--listen` socket 在 `--cmd` 预载执行**之前**就应答 RPC——
  握手快时 attach 撞上 `module 'dsh_tui' not found`，后继只剩裸 nvim（无
  聊天框、只有 `~` 填充行）；(4) 旧 nvim 优雅退出失败走 SIGTERM/SIGKILL
  时，closeNvimWindow 在 SIGKILL 实际生效前就返回，spawn 早于旧进程死亡。
  修复四层：① `/restart` 只置 `runtime.restartPending`，`quit()` 在
  `closeNvimWindow`（**完整等待**旧 nvim 死亡，含逐级 kill 后的 exit 事件）
  + `teardown`（会话落盘）之后才拉起后继；② 后继经 `sleep 2` 延迟接管，
  **setsid 开新会话**（免疫 shell 作业组信号），而**旧 dsh 进程不退场**——
  作为 shell 前台作业的占位者存活到后继进程树退出为止（shell 持续等待、
  不打印提示符、不抢终端；后继退出时旧进程随即退出，提示符正常回归）；
  ③ boot 在 attach 前**有界轮询** `package.preload['dsh_tui']` 就位——nvim
  的 `--listen` socket 在 `--cmd` 预载执行前就应答 RPC，握手快时 attach
  撞上 `module 'dsh_tui' not found`（后继只剩裸 nvim，无聊天框、只有 `~`
  填充行）；④ 新增 `kernel/term.ts`：启动/重启前 `flushTtyInput`（tcflush
  清掉上一个死 nvim 遗留未消费的终端查询应答字节——它们会被下一个 nvim
  当按键吞掉）+ `resetTerminalModes`（重置 alt screen、kitty keyboard
  protocol、modifyOtherKeys、bracketed paste、focus/mouse 追踪等模式）；
  另为 nvim 启动失败增加 stderr 捕获（临时目录 nvim-stderr.log）与快速
  失败诊断。模拟终端（查询应答）与 script pty 全链路实测：首实例挂载 →
  /restart → 旧 nvim 完全退出 → 后继存活、preload 就位、TUI 完整挂载。
- **测试可信度**：smoke graceful-exit 不再静默放行（kill 路径硬失败）；
  面板宽度断言改为开面板前取样；`npm run smoke` 先构建；e2e 校验 harness 退出码。
- **优雅退出根修（REVIEW §8 专项排查）**：winbar `OptionSet` 重断言在 nvim 退出
  拆除阶段与选项重置形成永不收敛的循环（nvim 保持响应但永不退出，`:qa!`/`cquit`
  均中招，输入窗口自愈重建后必现）；新增 `QuitPre` 统一置 `S.quitting`（覆盖
  用户 `:qa!`/ZZ 路径）+ 重断言在退出时让位。
- **文档**：README 识图桥章节重写为官方识图模型自动切换；REQUIREMENTS 入库并随包
  发布（修复发布包内链接失效）；180ms→450ms、app-ops-check 动态派生、目录结构
  等陈旧项批量同步。

## [v0.3.3（2026-09-08）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.3.3)

覆盖提交：
[`f54bc46`](https://github.com/kovey/dsh-nvim-tui/commit/f54bc46) ·
[`ad01deb`](https://github.com/kovey/dsh-nvim-tui/commit/ad01deb) ·
[`6e3d1a0`](https://github.com/kovey/dsh-nvim-tui/commit/6e3d1a0) ·
[`6e71794`](https://github.com/kovey/dsh-nvim-tui/commit/6e71794) ·
[`b59c546`](https://github.com/kovey/dsh-nvim-tui/commit/b59c546) ·
[`920250b`](https://github.com/kovey/dsh-nvim-tui/commit/920250b) ·
[`4e2bfbc`](https://github.com/kovey/dsh-nvim-tui/commit/4e2bfbc) ·
[`a9a9e51`](https://github.com/kovey/dsh-nvim-tui/commit/a9a9e51) ·
[`38f0c23`](https://github.com/kovey/dsh-nvim-tui/commit/38f0c23) ·
[`2aaf439`](https://github.com/kovey/dsh-nvim-tui/commit/2aaf439) ·
[`4f4b743`](https://github.com/kovey/dsh-nvim-tui/commit/4f4b743) ·
[`21b7263`](https://github.com/kovey/dsh-nvim-tui/commit/21b7263) ·
[`2222bba`](https://github.com/kovey/dsh-nvim-tui/commit/2222bba) ·
[`e883e16`](https://github.com/kovey/dsh-nvim-tui/commit/e883e16) ·
[`ad72547`](https://github.com/kovey/dsh-nvim-tui/commit/ad72547) ·
[`d02d57f`](https://github.com/kovey/dsh-nvim-tui/commit/d02d57f) ·
[`c0507e4`](https://github.com/kovey/dsh-nvim-tui/commit/c0507e4) ·
[`895d81b`](https://github.com/kovey/dsh-nvim-tui/commit/895d81b) ·
[`16f7f8e`](https://github.com/kovey/dsh-nvim-tui/commit/16f7f8e) ·
[`a4e1639`](https://github.com/kovey/dsh-nvim-tui/commit/a4e1639) ·
[`66b42f8`](https://github.com/kovey/dsh-nvim-tui/commit/66b42f8) ·
[`600ac31`](https://github.com/kovey/dsh-nvim-tui/commit/600ac31) ·
[`682b81b`](https://github.com/kovey/dsh-nvim-tui/commit/682b81b)

- **目录分层重构（P1–P6）**。src 按模块建立子目录（kernel/feed/boot/
  commands/sessions/subagents/transcript/statusline/ext-api/deps/market），
  src 根仅保留 index.ts（架构守卫强制）；boot.ts 收为纯组合根
  （1024 → 175 行）；命令模块一命令一文件（40+ 个 installXxxCommand
  自注册），业务模块各自的命令文件同构；内核提供公共接口，模块间低
  耦合、模块内高内聚；新增 `scripts/check-arch.mjs`（kernel-only App
  接口、slice 域白名单、跨域写扫描、依赖方向、模块边界等 8 项断言）
  与 `scripts/app-ops-check.mjs`（域 op 注入运行时验证，op 清单从
  AppSlices 声明派生）。lib/ 干净重建，陈旧平铺产物全部清除。
- **六路并行全仓审计 + 分级修复（P1×10 / P2×25 / P3×12）**。六名审计
  代理对全部源码与 Lua 侧逐行深读、交叉实证，修复确认项：
  - P1：diff LCS DP 索引整体错位（尾部编辑整块错乱）；/attach 图片
    分支死代码 + 附件二次保存；连续图片消息第二张丢失识图模型切换；
    粘贴 data URL 未走字节契约 + 有状态正则；pendingImages 跨会话
    泄漏（新增 clearPendings op）；ui.float 全新会话必失败；/deps
    install 生产路径根推导错误；boot disconnect 无 disposed 守卫
    （hmr 重载误杀进程）；/glance 纯 no-op 接线；nvim 执行层注释
    诚实化（白名单仅存在于注释 → 明示全权信任面 + request 前缀 /
    call 只读白名单护栏 + unrestrictedExec 能力声明）。
  - P2：picker/dirPicker 单槽并发悬挂（先 settle 旧槽）；/memory
    delete 路径穿越；nlcmd「用 bash」误路由持久化损坏默认模型；
    dsh-ext 应答 msgpack 冻结；luaExt.on / registerCommands disposer
    所有权；market 卸载自保护 + CLI 超时；cleanSubagentChain 假成功；
    sendToSubagent 回显中毒；归档会话自动复活；host-events guard；
    watchdog NaN；feed flush 竞态窗口 + lastView 自愈；table 字素簇
    折行/参差行列/转义管道；任务板整板重复提交；diff 截断统计；
    Lua region bottom SW 锚点几何、at_menu 光标乱文、popups reload
    清句柄、输入 buffer wipe 自愈、boot guard 浮窗豁免、浮窗顶替补
    cancel 通知等。
  - P3：会话 cwd 语义（跨目录恢复不再读写错项目）、子代理零事件
    可打开、/archive 刷新、layoutIdx 初始态、check-arch marker
    fail-loudly、stats NaN 防线、文案括号、fb/bell 边界、e2e 加固、
    README/发布面包同步、smoke 回归用例扩充（含纠偏两条固化旧 bug
    期望的断言）。
- **设计级修复**。approval/questions 改队列（并发父+子代理请求不再
  互相覆盖挂死，teardown 全队列结算）；live 会话 LRU 软上限 16
  （冷会话 dispose + buffer 回收）；ext 状态 hmr 幂等（订阅/ready
  跨 reload 存活）；market 停用保配置（disabled 注入行体）；/sessions
  跨 cwd 会话可达；/glance vim.g 持久化；market notfound 换源链排除
  已失败源；/rewind 宿主能力依赖文档化。
- **livePopup 未播种根修（自动恢复全线失败的 reading 'kind' 家族）**。
  播种 livePopup: null、statusline 判空同挡 undefined，并复活自 P3 起
  静默假绿的 app-ops-check 探针（root ReferenceError 被自身
  uncaughtException 处理器吞掉）——现从 d.ts 派生 76 个域 op 全量
  断言 + readonly 状态字段播种探针。
- **新功能**：/models 改为 sessions 式弹窗目录（当前模型 + live
  provider 的 settings 模型目录，Enter 切换）；输入框全屏编辑模式
  （`<C-e>` 切换：近全屏浮窗像编辑普通文件，Enter 换行、Esc 命令
  模式、回车发送回常规输入框、q 丢弃）；输入框提示栏同步加入
  「C-e 全屏」。
- **启动健壮性**：dsh_tui 全部子模块预载进 package.preload，完全绕开
  vim.loader 字节码缓存（缓存污染时不再报误导性的 'loop or previous
  error loading module'）；回声去重文本与宿主存储逐字一致（连续空格
  折叠后比对，多行/缩进草稿不再重复显示）。

## [v0.3.2（2026-09-07）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.3.2)

覆盖提交：
[`de24a5e`](https://github.com/kovey/dsh-nvim-tui/commit/de24a5e) ·
[`1b1864b`](https://github.com/kovey/dsh-nvim-tui/commit/1b1864b) ·
[`2d46e9c`](https://github.com/kovey/dsh-nvim-tui/commit/2d46e9c) ·
[`656814c`](https://github.com/kovey/dsh-nvim-tui/commit/656814c) ·
[`8fdf1de`](https://github.com/kovey/dsh-nvim-tui/commit/8fdf1de) ·
[`cc038f3`](https://github.com/kovey/dsh-nvim-tui/commit/cc038f3) ·
[`e477c5f`](https://github.com/kovey/dsh-nvim-tui/commit/e477c5f) ·
[`1fd8e70`](https://github.com/kovey/dsh-nvim-tui/commit/1fd8e70) ·
[`86fec6c`](https://github.com/kovey/dsh-nvim-tui/commit/86fec6c) ·
[`b010056`](https://github.com/kovey/dsh-nvim-tui/commit/b010056) ·
[`bb13252`](https://github.com/kovey/dsh-nvim-tui/commit/bb13252) ·
[`1e15d42`](https://github.com/kovey/dsh-nvim-tui/commit/1e15d42) ·
[`096195b`](https://github.com/kovey/dsh-nvim-tui/commit/096195b) ·
[`9939404`](https://github.com/kovey/dsh-nvim-tui/commit/9939404) ·
[`728b6cb`](https://github.com/kovey/dsh-nvim-tui/commit/728b6cb) ·
[`9284a1b`](https://github.com/kovey/dsh-nvim-tui/commit/9284a1b) ·
[`187906a`](https://github.com/kovey/dsh-nvim-tui/commit/187906a) ·
[`7d62519`](https://github.com/kovey/dsh-nvim-tui/commit/7d62519) ·
[`fc0fb24`](https://github.com/kovey/dsh-nvim-tui/commit/fc0fb24) ·
[`3e3c8d9`](https://github.com/kovey/dsh-nvim-tui/commit/3e3c8d9) ·
[`39a8070`](https://github.com/kovey/dsh-nvim-tui/commit/39a8070) ·
[`4d2fa5c`](https://github.com/kovey/dsh-nvim-tui/commit/4d2fa5c)

- **架构切片重构（P0–P2 + I1/I2 + 跨域收口）**。app.ts 的 116 个平铺状态
  成员按域收拢为六个 slice（runtime/sessions/ui/ext/trans/agent），核心
  服务实现外移到 owner 模块，App 收敛为 kernel 原语（19 项）+ slice 壳，
  app.ts 794 → 498 行：
  - **P0 切片**：116 个历史平铺成员改 get/set 访问器转发进 slice
    （buildApp 重写为 slices 字面量 + FLAT_FIELDS 映射 + defineProperty
    转发），现有模块零改动、tsc 全绿；
  - **P1 落地**：删除平铺字段与访问器，全模块机械改写为
    `app.slices.<域>.field` 站点级访问，sessions 注册表改名 `live`
    （`app.slices.sessions.live`）；installMarketInstall/installDeps 试点
    签名收窄为 `(app, AppSlices['agent'])`，闭包链同步穿参；
  - **P2 边界守卫**：新增 `scripts/check-arch.mjs` 并入 `npm run check`
    ——App 接口 kernel-only（遗留平铺哨兵字段不得回归）、slice 域名白名单、
    src 模块零遗留平铺访问三项断言；
  - **I1 服务外移**：13 个核心服务实现搬入 owner 模块（sessions 的
    readState/recordState/refreshHistory/refreshList、transcript 的
    readFileSnapshot/maybePushFileDiff、subagents 的 feedForSubagent、
    commands 的 registerCommands/commandCatalog/refreshCommandCatalog、
    boot 的 exitDiag/closeNvimWindow/teardown/quit——boot 入口同步注入、
    任何 await 前就位），createApp 留壳；check-arch 增 MOVED_SERVICES
    哨兵，i1-services-check 运行时验证壳默认值 + 注入后各服务真实行为；
  - **I2 默认值外移**：slice 默认值由 owner 模块 install 时注入自己的域
    （runtime→boot 拆出 installRuntime 最先调用、ext→ext-api、
    sessions+ui.activeFeed→sessions、trans+ui.diff→transcript、ui 表面→
    statusline、ui.feedForSubagent+agent 子代理部分→subagents、agent 主体→
    commands），命令注册设施与 commandSpecs 存储回归 kernel（t=0 存在）；
    check-arch 增 MOVED_STATE 哨兵（createApp 不得再种 slice 初始状态）；
  - **跨域读收口**：slice 状态数据成员全部 readonly，owner 经 WritableSlice
    视图写入；21 个域操作方法（agent 13 / ext 2 / runtime 4 / boot 2 辅助）
    收口 38 处历史跨域状态写，check-arch 增非 owner 文件跨域写扫描；
  - **审查修复**：子代理注册表函数（listSubagentChildren/
    seedRunningSubagents/cleanSubagentChain/runningSubagentsOf + zstd
    判定）归位 sessions 域，install 期跨域注入清零；spinnerStep 补回帧
    取模（帧索引不再越界）；ext 域 setPendingCardInput/fireExtReady 此前
    只声明未注入（Object.assign 逃过 tsc，boot 的卡片输入/ready 路径会
    TypeError）——已在 installExtApi 注入，并新增
    `scripts/app-ops-check.mjs` 运行时守卫（19 个 ops 全量注入断言 +
    spinner 取模/卡片 pending 回环）并入 check 堵住该盲区；
  - **验证**：tsc check / build / smoke×3 全绿，完整 install 链探针
    （A–H 全通）+ services 探针 + panel-stack/table-wrap 回归通过。

- **EXT-API：ui.region 四边停靠槽 + Node 侧多块并发（slot 机制）**。
  - **region 四边停靠槽**：浮动窗口停靠从右/左两缘泛化为四边——右/左
    纵向列栈（panel 同款）、上/下横向行栈（显式 width 优先、权重分摊剩余
    预算、90% 屏宽挤压），每 ext 每边一块、同边重复 claim 拒绝、跨边并存；
    Lua 侧原语 `api.region_claim/release`，`panel_claim/release` 保留为
    right/left 别名，`region_reflow` 泛化原 panel_reflow（四边独立计数，
    reasoning 面板仍排右缘列底，VimResized/toggle/注销统一走它）；硬约束
    不变——仅 editor-relative 浮窗、聊天区/输入框布局永不改变、无分屏；
    capabilities 增 region，handles() 增 regions（固定边序、首边优先）；
    smoke 13l 覆盖四边栈几何与聊天/输入几何不变断言。
  - **Node 侧多块并发**：`ui.panel`/`ui.region` 增 slot 机制（槽名映射伪
    extId：default 沿用 `__node__` 兼容、其余 `__node_N`，`__node*` 前缀
    保留、Lua 侧 register 拒绝抢注）；同槽同边重复 claim = 释放旧块换新块
    （releaseClaim），panelRelease/regionRelease(slot?) 按槽释放（无参仅
    default）；句柄新增 slot + release()；`ui.panels()` 盘点全部面板；
    teardown 钩子 extNodeCleanup——quit/teardown 关窗前先释放槽位再广播。
    Lua 侧零改动；fake-app 验证多槽并发/替换语义/default 兼容/句柄释放/
    盘点/teardown 清理。

- **卡片动作确认/输入型交互（kind=confirm/input）**。ExtCardAction 增加
  kind 字段，`dsh-ext-card-activate` 分派按类型走三条路：plain 直发；
  confirm 弹选择器确认（条目补 ⚠/✎ 角标，先看到后果再触发）；input 进入
  pendingCardInput 单槽（输入框预填 inputDefault + notice 提示），
  `dsh-input` 拦截先于 `tui:input` 广播——空输入取消、卡片失效自动取消、
  分派入口统一清旧 pending（旧 pending 不再劫持下一次输入）；headless 下
  confirm/input 退化为 plain。动作 API 拆分为 resolveCardAction（渲染期）
  与 fireCardAction（触发期）；smoke 13i2 覆盖三种形态最终值断言。

- **待办/任务面板实时化 + 钉底化**。
  - **修复：待办清单状态实时更新（不再堆叠旧副本）**。todo 块此前每次
    重发全量清单都 append 新副本，状态更新被旧块淹没；现在 feed 跟踪当
    回合活块（todoBlockStart/todoBlockLen），重发时 base.splice 原位替换
    + shiftExtCards 偏移修正（复用 ext-card 模式），空清单移除块，
    turn/start 重置；smoke 6a2 断言单块/原位更新/旧行消失/空移除。
  - **/tasks 弹窗化 + 聊天区实时任务板**：tasksCommand 改弹窗列表
    （openPicker，选中 kill:<id> 即取消，保留 `/tasks kill <id>` 直呼
    路径）；feed 新增 setJobsBlock 常驻任务板（jobsBlockStart/Len/Key，
    同内容 no-op、变更原位 splice+shiftExtCards、空列表移除）；
    refreshBgJobs 由 onJobsChanged/onJobDone 事件驱动，把
    「⚙ 任务 N 项 · X 运行中 + 状态图标行」实时重发到活跃会话 feed。
  - **面板钉底化**：todoLiveRows/jobsLiveRows 钉底活行槽——flush 组装在
    activity 行之前（流式内容顶不走、永不遮挡 thinking）；todo 全 ✓ 才
    base.push 提交进聊天流，未完成留在钉底实时更新，turn/end 以最终状态
    提交；setJobsBoard 同内容 no-op，commitJobsBoard 终态落盘（替换原
    splice 机制）；rec.jobsCache 缓存 jobs.list 与 onJobDone 合并结果
    （live 列表掉落的运行态兜底 killed）。smoke 6a2/6a2b 重写：钉底位置
    （头部=len-4、thinking 恒为末行）、原位更新、全 ✓ 提交进流、turn/end
    兜底提交、终态提交。
  - **修复：终态面板被 30s idle 心跳反复重发**。jobs.list 终态后仍返回
    任务、缓存清空被心跳重新填充 → 终态板无限重复提交（实测 89/119/149s
    三连）；todo 全 ✓ 重发同列表同理。现在终态提交 key = id:status 排序
    拼接（不含 elapsed），rec.committedJobsKey 保证一批只提交一次（新批次
    新 id 自然重新走钉底→提交）；feed 的 lastTodoKey 回合内去重
    （turn/start 重置）；jobs-commit-probe 验证运行态三连钉底零提交 /
    终态三连只提交一次 / 新批次再走全流程。
  - **/tasks 与 /todo 弹窗实时同步**：openLivePicker + update_picker 原位
    重渲染（行集/取值表原位替换、窗口高度自适应、光标越界收敛、无 picker
    时 no-op）；弹窗打开期间 jobs 事件链与 todo/write foldEvent 推送最新
    行（图标/耗时/状态实时刷新）、结算时注销 updater；smoke 覆盖
    update_picker 全语义。

- 文档同步：ARCHITECTURE.md 固化切片方案与 install 体三原则；EXT-API.md
  补 region/slot/capabilities；README 命令数 60 → 61；check / build /
  smoke 全绿。

## [v0.3.1（2026-09-05）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.3.1)

覆盖提交：
[`cb2ba38`](https://github.com/kovey/dsh-nvim-tui/commit/cb2ba38) ·
[`a64a736`](https://github.com/kovey/dsh-nvim-tui/commit/a64a736) ·
[`b955980`](https://github.com/kovey/dsh-nvim-tui/commit/b955980) ·
[`1af0d92`](https://github.com/kovey/dsh-nvim-tui/commit/1af0d92) ·
[`7cb811e`](https://github.com/kovey/dsh-nvim-tui/commit/7cb811e)

- **修复：启动时旧会话恢复失败导致整个 dsh 进程闪退**。
  （issue [#5](https://github.com/kovey/dsh-nvim-tui/issues/5)：0.3.0 安装后
  `dsh --profile nvim` 闪一下就退出——旧会话恢复失败直通 boot 外层 catch →
  `quit(1)`，整个 dsh 进程随 TUI 一起退出）。
  此前启动时恢复会话（`resumeSessionId` 显式指定或自动恢复上次会话）一旦
  reject（旧版本/不兼容的会话日志等），rejection 直通 boot 外层 catch →
  `quit(1)`，整个 dsh 进程随 TUI 一起退出。现在 boot 恢复路径改为
  `resumeOrFresh` 兜底：恢复失败时先把错误写入错误日志（含会话 id 与原因，
  不再无痕），随后打开一个全新会话，并在新会话的聊天窗口提示
  「⚠ 恢复会话失败 <id> — <原因>（已新建会话）」；自动恢复成功仍显示原有
  「已自动恢复上次会话」提示，失败时不再误显示。旧会话仍在 `/sessions`
  列表中，可随时重试打开。新建会话本身失败仍视为致命错误（loud-fail）。

- **补全三个此前仅有占位目录、无处理器的命令**：
  - `/dir [路径]`：目录浏览浮窗（Enter 目录进入 / 文件在新标签页打开，
    gt/gT 切换）；
  - `/lines [路径]`：文件行视图（只读浮窗，`i` 打开编辑；无参弹目录选择器）；
  - `/history`：输入历史浏览（最新在前，多行条目以 ↵ 折叠展示、Enter 回填
    原文，q/Esc 关闭）。

## [v0.3.0（2026-09-04）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.3.0)

覆盖提交：
[`b2f51be`](https://github.com/kovey/dsh-nvim-tui/commit/b2f51be) ·
[`8b44f34`](https://github.com/kovey/dsh-nvim-tui/commit/8b44f34) ·
[`d050f9c`](https://github.com/kovey/dsh-nvim-tui/commit/d050f9c) ·
[`0459fe5`](https://github.com/kovey/dsh-nvim-tui/commit/0459fe5) ·
[`3ab46e5`](https://github.com/kovey/dsh-nvim-tui/commit/3ab46e5) ·
[`5d965d1`](https://github.com/kovey/dsh-nvim-tui/commit/5d965d1) ·
[`6db735c`](https://github.com/kovey/dsh-nvim-tui/commit/6db735c) ·
[`f9aaa87`](https://github.com/kovey/dsh-nvim-tui/commit/f9aaa87) ·
[`1574e7e`](https://github.com/kovey/dsh-nvim-tui/commit/1574e7e) ·
[`dc39bd6`](https://github.com/kovey/dsh-nvim-tui/commit/dc39bd6) ·
[`e051765`](https://github.com/kovey/dsh-nvim-tui/commit/e051765) ·
[`a50a07e`](https://github.com/kovey/dsh-nvim-tui/commit/a50a07e) ·
[`5cd0ded`](https://github.com/kovey/dsh-nvim-tui/commit/5cd0ded) ·
[`7447045`](https://github.com/kovey/dsh-nvim-tui/commit/7447045) ·
[`c7501ba`](https://github.com/kovey/dsh-nvim-tui/commit/c7501ba) ·
[`689d4af`](https://github.com/kovey/dsh-nvim-tui/commit/689d4af)

- **插件开放接口（EXT-API，P0–P4）**。本插件对外开放稳定接口，其他 dsh 插件
  与 nvim 插件可在 TUI 内渲染 UI、使用 nvim 窗口、读写输入、订阅会话事件：
  - Node 面（dsh 插件）：`ctx.get('nvim-tui')` → `TuiExtApi` —— nvim 执行层
    白名单（request/call/lua/ex，带超时）、ui 原语（card 可原地更新/关闭、
    float/picker/notice/statuslineSegment、右缘 panel 单槽）、斜杠命令注册
    （重名拒绝）、`tui:*` 生命周期事件（晚订阅补发）与 onSessionEvent 镜像
    订阅、dsh-ext 双向总线（luaExt.call/emit/on，**有界应答**：每条请求
    30s 内必回，超时回结构化错误、处理器后台继续）。
  - Lua 面（TUI 实例内的 nvim 插件）：`require('dsh_tui').api` —— 登记制
    register/unregister（所有权守卫放行已登记窗口，未登记维持严管）、
    float_open/close、panel_claim/release（单槽互斥、resize 重锚定、q/Esc
    释放）、before_submit 否决/改写、Lua 侧斜杠命令（并入 / 补全目录）、
    rpc_call/rpc_register 双向总线、session-event 镜像与
    `User DshTui*` 事件族（payload 经 api.last_event() 读取）。
  - 版本协商：boot handshake（EXT_API_VERSION 主版本比对，不匹配 notice）；
    状态表钉在 `_G.__dsh_tui_state` 单例（vim.g 走 Dict 转换丢同一性），
    vim.loader.enable / rtp 重建后模块重载仍共享同一注册表。
  - 文档与示例：docs/EXT-API.md；examples/nvim/git-panel.lua 与
    examples/dsh-plugin/（进入 npm files 白名单）；smoke 新增扩展接口全
    覆盖段（含 boot 守卫豁免、双向 RPC、钩子、命令目录合并、注销清理）。

- **扩展接口增强（1/2/3/4）**：
  - **dsh-ext 有界应答**：`vim.rpcrequest` 实测阻塞不可从 Lua 取消，但阻塞
    期间 nvim 继续处理事件（处理器内嵌套 nvim 调用安全，据此移除了错误的
    死锁守卫）；runner 对每条请求做超时竞速（默认 30s，`luaExt.on` 可
    per-handler 覆盖、`luaExt.call` 可 per-call 覆盖），超时回结构化错误、
    处理器后台继续、结果丢弃。
  - **Lua 侧晚订阅补发**：User 事件保持实时流不重放；晚加载插件
    （lazy.nvim VeryLazy）用 `api.snapshot()`（boot/会话/窗口句柄快照）+
    register 的 `on_ready`/`on_active_session` 同步回调对齐初始态。
  - **卡片交互化**：`ui.card` 的 actions + `onAction` 变成真交互——卡片在
    chat 缓冲获得渲染行块 extmark（flush 期跟踪 markdown 变换后的行范围），
    光标停在卡片上按 `1-9` 直接触发动作、`Enter` 弹出动作选择浮窗
    （复用 TUI picker）；`dsh-ext-card-activate` 路由到回调。
  - **多面板并发**：面板从单槽改为**列栈**——每个 extId 一块，按 claim 顺序
    自上而下堆叠（右缘，`side='left'` 支持左缘），`height` 显式行数或权重
    分摊剩余预算，超预算等比挤压；reasoning 面板入栈排在列底、toggle 与
    VimResized 统一走 `api.panel_reflow()`；注销/面板被外力关闭时出栈并
    重排。

- **/sessions 会话分组（移入工作区 / 移出分组）**。会话行操作菜单新增
  「移入工作区 / 移出分组」：列出全部工作区选择 attach（官方 registry 校验
  会话规范化 cwd === 工作区路径，不匹配的错误原样透出 notice），当前所在
  工作区时提供「移出分组」；`WorkspaceEntityLike` 类型补 attachSession/
  detachSession（配套 dsh-workspaces-adapter 需透传 attachSession）。

- **markdown 表格每行分割线**：每个数据行都带自己的 `├…┼…┤` 分割线
  （此前仅表头下有一条），末行分割线闭合为底框；流式期间末尾保留 `├…┤`
  作为「还有行」提示，回合结束替换为 `└…┘`。折行产生的续行不加分割线，
  保持同一逻辑行的视觉分组。

- **修复：markdown 表格超宽内容折行错乱**。列宽原先取整列最长单元格且无
  上限——超宽表格被 nvim 软折行后，续行没有 `│` 边框、框线错位。现在
  `renderTable` 增加最大宽度预算（chat 用视口宽度、思考面板用面板实际
  宽度，2s 节流缓存）：超宽时从最宽列开始收缩（下限 3），单元格按显示
  宽度（CJK/emoji 计 2 列）折行，**每一行续行都带完整 `│…│` 边框**，表
  格整体始终在视口内、不再触发软折行。

## [v0.2.16（2026-09-04）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.16)

覆盖提交：
[`482ad5c`](https://github.com/kovey/dsh-nvim-tui/commit/482ad5c) ·
[`bb19bd8`](https://github.com/kovey/dsh-nvim-tui/commit/bb19bd8)

- **会话管理：/sessions 行操作菜单 + 重命名持久化**。会话行新增操作菜单
  （打开 / 重命名 / 归档，官方 workspace browser 行菜单对齐；宿主无公开
  会话删除 API，归档即官方「从列表移除」方式）；重命名走「下一条输入作为
  新标题」流程，历史会话重命名**不切换视图**（拆出 ensureLiveSession：
  后台恢复 + 挂载 + 回放，不 switchTo）；修复重命名标题重启丢失——持久化
  SessionHeader 不含 title，历史行标题改读宿主 projection cache
  （`sessionProjectionCache.cachedSnapshot(header, inheritedEventCount,
  ['title'])`，零 IO，与官方 api-session-controller 同路径），refreshList
  历史条目不再硬编码空标题。

- **修复：diff 卡片内围栏标记导致其后 markdown 表格不再美化**。根因是
  表格转换曾是独立预扫描（transformTables 遍历整个视图），不认 diff
  区域——diff 卡片内逐字渲染的奇数个代码围栏行把预扫描的 fenceOpen 卡死
  为「围栏内」，此后所有 markdown 表格永远按原文渲染（症状：粗体/反引号
  被剥但表格未转框线，真实会话回放复现）。修复：表格检测并入渲染主循环，
  与 diff 区域/代码围栏共用同一状态机；思考面板与用户回显也补上表格美化
  （面板含表格时切全量重写、保持增量快路径；用户回显表格框线化并保留
  `> ` 引用前缀）。smoke 新增四个表格回归用例（助手消息 / 用户回显 /
  思考面板 / diff 围栏后表格）。

## [v0.2.15（2026-09-04）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.15)

覆盖提交：
[`c912e85`](https://github.com/kovey/dsh-nvim-tui/commit/c912e85) ·
[`e32d65f`](https://github.com/kovey/dsh-nvim-tui/commit/e32d65f) ·
[`c4cda22`](https://github.com/kovey/dsh-nvim-tui/commit/c4cda22) ·
[`6a1602f`](https://github.com/kovey/dsh-nvim-tui/commit/6a1602f) ·
[`ec2e66f`](https://github.com/kovey/dsh-nvim-tui/commit/ec2e66f) ·
[`483caac`](https://github.com/kovey/dsh-nvim-tui/commit/483caac) ·
[`188d695`](https://github.com/kovey/dsh-nvim-tui/commit/188d695)

- **修复：子代理链清理的截断分支是死路径（truncateStored 在 alpha.5/rc.1
  均不存在），存储从未真正释放**。改用官方 raw-artifact 面重写：
  `supportsRawArtifacts` + `locate()` 取物理路径 + `readRaw()` 取解码记录，
  把已结束子代理的日志重写为「仅 header」的 frame-per-record zstd 产物
  （tmp+rename 原子写，镜像后端写者；仅 zstd 魔数产物、仅非 live 会话，
  异常一律跳过）。实测真实子代理产物 1.17MB → 206B。清理后同时调用官方
  `workspaceRegistry.archiveSession` 隐藏（本地账本保留为列表过滤）。同时
  删除 /rewind 中不可达的 truncateStored 死块（rc.1 Session 无 truncate，
  /rewind 已由前置守卫优雅降级为 /fork 提示）。smoke 新增帧扫描器验证
  encodeSessionLog 的 frame-per-record 布局逐帧 round-trip。

- **升级：dsh 依赖锚点 alpha.5 → 0.1.2-rc.1 + 全量 API 核对**。
  peerDependencies（dsh-agent / dsh-llm / dsh-tools）与 devDependencies
  抬升至 `^0.1.2-rc.1`，workspace node_modules 同步刷新。适配核查：
  rc.1 与 alpha.5 的 14 个依赖包 lib/types 逐文件零差异；TUI 消费的宿主
  服务方法逐一在 rc.1 定义中验证（jobs / subagents / workspaceRegistry /
  agentPresets / permissionPresets / fileReferences / settings / sessionQuery
  / messageFeedback / goals / tools / pluginInventory / agentDefaultModel /
  sessionPersistence 等）。真机验证：rc.1 宿主冷启动零错误 +
  真实模型 e2e 回合 PASS。README/UPGRADE 同步 rc.1（next dist-tag）。

- **修复：@ 引用文件在输入行首位时不弹补全**。检测正则要求 @ 前存在一个
  非字母字符，行首没有前置字符 → 永不匹配。现在行首 token 用独立分支显式
  匹配（start=0）；同时把 @ 的 0-based 字节偏移随 dsh-at-query 通知传给
  runner 并回传给 set_at_menu（此前偏移从未传递，accept 的拼接位置恒为 0，
  行中引用会替换整段前缀）。smoke：行首/行中检测与偏移断言；waitNote 改为
  弹出语义 + drainNotes 辅助（消除陈旧通知导致的重复消费）。

- **修复：新会话没有主页介绍与鲸鱼动画**。空态判定只看「缓冲区是否为空」，
  而每个新会话的首条内容就是 attach 时的 boot banner notice（`· dsh-nvim-tui
  …`）→ 空态永远不成立，hero 欢迎块与鲸鱼壁纸从未渲染。现在**仅含 notice
  行（`· ` 前缀）的 feed 也算空态**：hero + 鲸鱼照常渲染，banner/「session X」
  等 notice 保留在英雄块下方可见；一旦出现真实内容（用户/助手行）即隐藏。
  顺带修复同块内 `parsed` 数组未清空、与 `lines` 长度错位的隐患。smoke
  新增空态三断言（banner-only 渲染 hero / notice 保留 / 真实内容后隐藏）。

- **修复：后台 bash 运行时状态栏误显「○ idle」**。此前 spinner 只由
  `agent/status` 驱动——后台任务（tool-jobs）在跑、agent 空闲时状态栏显示
  空闲，让人以为任务停了。现在订阅 `jobs.onJobsChanged`/`onJobDone`（+30s
  空闲兜底刷新），活动会话的 running/stopping 后台任务计数进 `rec.bgJobs`：
  空闲但 bgJobs>0 时鲸鱼继续旋转、徽章显示 `🔧 后台 N`；后台任务结束时
  在聊天区 notice 其 label 与结果。badge 组合抽为纯函数 `runningBadge`
  （smoke 覆盖四态）。

## [v0.2.14（2026-09-03）](https://github.com/kovey/dsh-nvim-tui/releases/tag/v0.2.14)

覆盖提交：
[`2e3b730`](https://github.com/kovey/dsh-nvim-tui/commit/2e3b730) ·
[`5f451e5`](https://github.com/kovey/dsh-nvim-tui/commit/5f451e5) ·
[`62ea542`](https://github.com/kovey/dsh-nvim-tui/commit/62ea542) ·
[`834b2c4`](https://github.com/kovey/dsh-nvim-tui/commit/834b2c4) ·
[`6b3cc34`](https://github.com/kovey/dsh-nvim-tui/commit/6b3cc34) ·
[`7b1a872`](https://github.com/kovey/dsh-nvim-tui/commit/7b1a872) ·
[`25ea711`](https://github.com/kovey/dsh-nvim-tui/commit/25ea711) ·
[`834327f`](https://github.com/kovey/dsh-nvim-tui/commit/834327f) ·
[`6b85e8f`](https://github.com/kovey/dsh-nvim-tui/commit/6b85e8f)

- **升级：@deepseek-ai peer 依赖锚点 alpha.4 → alpha.5**。
  peerDependencies（dsh-agent / dsh-llm / dsh-tools optional）与
  devDependencies（dsh-tools）抬升至 `^0.1.2-alpha.5`，workspace
  node_modules 同步刷新为 alpha.5（含 cordis 4.0.2）；check / build /
  smoke 全绿（TUI 消费面零改动适配——alpha.5 的 SessionSeq 移除
  `Session.events` 等破坏性变更在 v0.2.12 已适配，本次仅锚点抬升）。

- **移除 vision-bridge 依赖，识图改为官方识图模型自动切换**。
  清理自制 dsh-vision-bridge 插件（profile bundles/dependencies 已移除，
  TUI 的 ServiceMap、图片闸门、/deps 检查项全部下线）；新识图路径：图片
  消息发送时，当前模型声明 image 模态 → 直接发送；否则从目录中寻找官方
  识图模型（deepseek-v4-flash-vision-exp → deepseek-vl2 → deepseek-vl）
  临时切换（`rec.visionTmp` 记录原选择 + 切换时刻），回合结束按
  `turn/start` 时序自动切回（switchAt 判定保证排队的普通回合不受影响）；
  目录无识图模型时 fail fast 并给出 settings.yaml 装配提示。settings.yaml
  已加入 `deepseek-v4-flash-vision-exp`（inputModalities: [text, image]，
  dsh-llm-deepseek 默认目录同款）。历史带图消息警告文案同步去识图桥化。
  /deps 的「官方识图模型」检查替代原 vision-bridge/OCR 两项。
  check/build/smoke 全绿，dump-config 99 行 0 重复、vision-bridge 已卸载。

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
