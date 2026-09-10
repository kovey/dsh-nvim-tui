# 审计报告 · 单元 `docs-claims`（文档宣称 vs 代码实现 + smoke 断言缺口）

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（dsh-nvim-tui v0.3.5，宿主 dsh 0.1.5-rc.1）
- 审计范围（必读文件，均已完整通读）：
  `REQUIREMENTS.md`(430) · `README.md`(536) · `UPGRADE.md`(462) · `CHANGELOG.md`(1318) ·
  `scripts/smoke.ts`(3030) · `scripts/check-arch.mjs`(186) · `scripts/app-ops-check.mjs`(148) · `scripts/e2e.ts`(113)
- 审计方法：文档逐条 → 源码/宿主类型取证（grep 全局引用、`npm ls`、`npx tsc`、实跑两个 guard 脚本）→ 只保留有确凿代码证据的条目。
- 未修改任何源码文件；本报告是本次审计唯一的写入。

实跑取证（本机现状）：
```
$ node scripts/check-arch.mjs     → ✓ arch-check: ... (exit 0)
$ node scripts/app-ops-check.mjs  → ✓ app-ops-check: 78 domain ops all injected (exit 0)
$ npx tsc --noEmit                → exit 0（注意：类型来自 0.1.2-rc.1 的包，见 F7）
$ npm ls @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm @deepseek-ai/dsh-tools --depth=0
  ├── @deepseek-ai/dsh-agent@0.1.2-rc.1 invalid: "^0.1.5-rc.1" from the root project
  ├── @deepseek-ai/dsh-llm@0.1.2-rc.1   invalid: "^0.1.5-rc.1" from the root project
  └── @deepseek-ai/dsh-tools@0.1.2-rc.1
```

---

## F1 · `/rewind` 在受支持的宿主上恒不可用，但 README/REQUIREMENTS 把它写成已交付的截断回退

- 类别：missing-feature ｜ 严重度：high ｜ 置信度：high
- 证据：
  - `src/transcript/commands/rewind.ts:12-16` 是命令的第一道闸门：
    ```ts
    const session = app.liveSessions.get(rec.id)
    if (session === undefined || typeof session.truncate !== 'function') {
      app.notice(t('会话截断不可用：宿主 dsh-session 不支持 truncate（可用 /fork 派生替代）'))
      return
    }
    ```
  - 宿主（peer 锚定 `^0.1.5-rc.1`，仓库内实装 0.1.2-rc.1，两代同一结论）**根本不存在 truncate**：
    `grep -rn "truncate" node_modules/@deepseek-ai/dsh-session/lib/` → 0 命中；`src/sessions/index.ts:114`
    亦注释 “0.1.5 owns its storage (no raw artifacts / no truncate API)”。
  - 文档却把它当可用功能：
    `README.md:223`「`/rewind [第N条]` 回退：选择一条用户消息边界，**截断其后的会话内容并重建界面**」；
    `REQUIREMENTS.md:195` 同表格同措辞，且 `REQUIREMENTS.md:8` 声明「**全部需求已实现**」；
    `REQUIREMENTS.md:378`（M6 验收行）把 `/rewind 回退重建` 标为 ✅ 完成。
  - 只有 `UPGRADE.md:457-462`（文末附注，README 未引用该节）承认：「当前宿主编排层未公开该符号，因此命令会提示『会话截断不可用』并建议 `/fork` 派生替代」。
  - 连带后果：`rewind.ts:35-59` 的“数字参数从开头计数 + 确认弹窗”正是 `CHANGELOG.md:81-83`（v0.3.4「/rewind 数据安全」）宣称修复的行为，但它位于该闸门**之后**，在受支持宿主上永远执行不到。
- 复现：任意会话执行 `/rewind` → 恒定输出「会话截断不可用…」，无任何回退能力。
- 建议修法：README/REQUIREMENTS 把 `/rewind` 标注为「宿主未公开 truncate 前不可用（等同 `/fork`）」；或在无 truncate 时用 `agents.create({seed})`（`/fork` 已有实现，`src/sessions/services.ts:258-300`）实现“回退语义”的派生替代；smoke 增加一条断言把该降级路径固定下来。

## F2 · `/search` 开箱即空：插件自身 bundle patch 未启用索引，文档却按“已可用”宣传

- 类别：missing-feature ｜ 严重度：high ｜ 置信度：medium-high
- 证据：
  - `src/deps/services.ts:246-252`（体检项：配置生效性）明确写下未启用时的状态：
    ```ts
    const searchCfg = loaderEntryConfig<{ openAt?: string }>(app, 'session-query-sqlite')
    const searchOn = searchCfg?.openAt !== undefined && searchCfg.openAt !== 'never'
    detail: searchOn ? `openAt=${searchCfg!.openAt}，索引持久化于 DSH_HOME`
                    : 'session-query-sqlite 配置为 :memory: + never（库从不建立，搜索恒空）',
    fixId: searchOn ? undefined : 'search-override',
    ```
    对应可装配行模板 `src/deps/services.ts:62-65`：`path: !!js dshHomePath('session-query.db')` + `openAt: first-search`。
  - 本仓库的 bundle patch **只有 runner 一行插入**，没有任何 `session-query-sqlite` 覆盖：`cordis.patch.yml`（全文 11 行，仅 `- insert: id: nvim-tui-runner`）。
  - `src/commands/commands/search.ts:14-17` 只在服务缺失时提示；服务在但索引 `never` 时走 `searchSessions()` → 恒 0 命中 → `app.notice('没有匹配的会话')`。
  - `CHANGELOG.md:635-639`（v0.2.14）自己记过同一根因与修法：「dsh-base 默认 :memory: + never 库从不建立，搜索恒空；profile patch 覆盖 session-query-sqlite 为 openAt: first-search + 持久化路径」；`UPGRADE.md:200-219` 的“推荐装配 5 行”里**不含**这一行。
  - 文档无前置条件说明：`README.md:225`、`REQUIREMENTS.md:197` 均写「跨会话全文搜索（session-query-sqlite），命中可一键恢复」。
- 复现：默认 profile 启动，输入 `/search 关键词` → 恒「没有匹配的会话」（或服务未装配提示），除非手工 `/deps install` / 手写 patch。
- 建议修法：把 `search-override` 模板行并入 bundle patch（或 README/REQUIREMENTS 明写“需先 `/deps install`”）；e2e 增加一条 `/search` 断言。

## F3 · REQUIREMENTS 把已删除的 `dsh-vision-bridge` OCR 桥写成推荐识图路径（代码零引用）

- 类别：missing-feature ｜ 严重度：medium ｜ 置信度：high
- 证据：
  - `REQUIREMENTS.md:230-241`（R-IMG-3 / R-IMG-4 / R-IMG-6）规定：装配 `dsh-vision-bridge`（提供 `visionBridge` 服务），图片经本地 macOS Vision OCR（`~/.dsh/scripts/feishu-ocr`）转文字注入；发送前预检分支为「原生识图 → 直发 / 有识图桥 → 提示经桥转换 / 两者皆无 → 报错」。
  - 代码中不存在该实现：`grep -rni "visionbridge\|vision-bridge\|feishu-ocr" src nvim` → **0 命中**（仅 README/REQUIREMENTS 命中）。
  - `README.md:280-281` 已声明该路径在 v0.3.2 移除；现行实现是官方识图模型临时切换：`src/kernel/vision.ts:1-43`（`PREFERRED_VISION_MODEL_IDS` + `llm.listModels` 目录扫描）+ `src/commands/core.ts` 的 `findVisionModel` 调用。
  - 加重项：`REQUIREMENTS.md:8` 宣告“全部需求已实现”，且 `package.json` 的 `files` 白名单包含 `REQUIREMENTS.md`（`package.json:13-22`、`:20`），即该失实章节会随 npm 包发给用户。
- 建议修法：删除/改写 R-IMG-3、R-IMG-4，替换为 `src/kernel/vision.ts` 的官方识图模型切换语义（含 `UNSUPPORTED_CONTENT` fail-fast）。

## F4 · “逐项更新硬约束”与难度路由的运行时路径零自动化覆盖，且守卫失败被全量吞掉

- 类别：risk ｜ 严重度：medium ｜ 置信度：high
- 证据：
  - smoke 只导入纯函数：`scripts/smoke.ts:27-28`
    ```ts
    import { estimateByRules } from '../lib/kernel/difficulty.js'
    import { latestTodos, todoGuardReminder, MAX_NUDGES_PER_TURN } from '../lib/kernel/todo-guard.js'
    ```
    断言也只在纯函数层：`scripts/smoke.ts:1782-1807`（`estimateByRules` 9 例、`latestTodos/todoGuardReminder` 6 例）。
  - `grep -n "installTodoGuard\|routeDifficultyForTurn\|applyTierSwitch\|restoreDifficulty\|difficultyStatusLines\|agent/pre-step\|systemPrompt" scripts/smoke.ts scripts/e2e.ts` → **0 命中**：真正的装配链（`src/sessions/services.ts:113-117` 的 `installTodoGuard(agentCtx, …)`、`src/commands/core.ts:53` 的 `routeDifficultyForTurn(app, rec, text, …)`、`src/boot/session-events.ts:13` 的 `restoreDifficulty`、`src/kernel/difficulty.ts:225-232` 的 `resolveModelInfo` 校验）没有任何测试触达。
  - 这些注册全部包在空 catch 里，宿主 seam 变更时会**静默失效**：`src/kernel/todo-guard.ts:112-157`（`try { prompt?.section?.(…) } catch {}`、`ctx?.on?.('agent/pre-step', …)` 外层再 `catch {}`）；`src/kernel/difficulty.ts:82-131` 的分类器、`:186-196` 的模型校验也都 `.catch(() => undefined)` 后退化。
  - 文档把它当硬保证：`README.md:314-329`（“让逐项更新成为**代码层面的硬性要求**”）+ `CHANGELOG.md:44-48`（“每回合上限 3 条 … **真机验证**：0.1.5 会话首条 `system/message` 已包含该段落”）。真机一次性验证不是回归门禁；`prepublishOnly`（`package.json:60`）只跑 check+build+smoke。
- 复现：把 `ctx.systemPrompt.section` 改名或让 `agent/pre-step` 不触发，`npm run smoke`、`e2e` 仍然全绿，而用户侧约束静默消失。
- 建议修法：在 smoke/app-ops-check 里用 fake agent ctx 断言 `section()` 收到 `nvim-tui-todo-discipline` 文本、`agent/pre-step` 处理器真的把提醒 append 进 `decision.messages`（并断言 3 条上限）；难度路由用 fake `llm.resolveModelInfo/listModels` 覆盖“档位模型不存在 → 跳过并提示”和 turn-end 切回。

## F5 · 命令补全目录“不会漂移”被硬编码 Lua 兜底清单打破（47 vs 62），smoke 反而把漂移写死

- 类别：risk ｜ 严重度：medium ｜ 置信度：high
- 证据：
  - 文档承诺单一注册表：`README.md:206-207`「命令目录由 runner 启动时推送给 nvim，与 `/help`、命令分发表**共用同一份注册表，不会漂移**」；`REQUIREMENTS.md:176-178` 同义（R-CMD-1）。
  - 实现有第二份手写清单：`nvim/lua/dsh_tui/cmd_menu.lua:20-29` 的 `FALLBACK`（47 条，无 desc），`:36-50` 的 `entries()` 在 `S.cmdCatalog` 为空时整表回落到它。
  - 实测差异（脚本比对 `src/**/name: '/xxx'` 与 FALLBACK）：
    ```
    fallback count 47 · registry count 62 specs 62
    missing from fallback: /queue /whale /workspace /archive /deps /market /history
                           /todo /locale /context /lines /difficulty /models /dir /plugins
    ```
    即 15 条（含本次版本新增的 `/difficulty`、以及 `/deps` `/market` `/todo` 等）在兜底期不可补全。
  - 该清单只在 catalog 推送成功前生效，而推送失败是静默的：`src/kernel/app.ts:516-530` 结尾 `await luaCall('require("dsh_tui").set_commands(...)', [entries]).catch(() => {})`，`src/boot/boot.ts:174` 又是 `void app.refreshCommandCatalog()` → 推送失败后 15 条命令永久缺席且无提示。
  - smoke 把漂移固化为期望：`scripts/smoke.ts:1177` `assert.equal(menuSt.names.length, 47, 'all 47 fallback commands listed')`——断言的是兜底清单本身，而不是“catalog == registry”。
  - 同一处计数文档也陈旧：`README.md:62` 写「**61 个内置命令**」，实际 `src/**` 注册 62 条 spec（`grep -rhoE "name: '(/[A-Za-z-]+)'" src | wc -l` = 62；README 自己的命令表也列出 62 个不同命令名）。
- 复现：runner 未推送 catalog（或 set_commands 抛错）时输入 `/di`+Tab → 菜单里没有 `/difficulty`；`/de` 也不出 `/deps`。
- 建议修法：删除 FALLBACK（改为“目录未就绪”占位）或由 `commandCatalog()` 生成一份随包 Lua 数据；smoke 断言改为 `catalog(names) ⊇ registry` 且数量等于 `commandSpecs.length`；README 计数改为 62。

## F6 · `check-arch` 的“跨域状态写零容忍”只覆盖 15 个硬编码文件 + 字面量写法，别名写完全绕过

- 类别：risk ｜ 严重度：medium ｜ 置信度：high
- 证据：
  - `scripts/check-arch.mjs:87-103` 是**手写文件白名单**（15 个文件），`:112-124` 只遍历这张表：
    ```js
    for (const [file, owned] of Object.entries(STATE_OWNERS)) { … }
    ```
    且判定用字面量正则（`:117`）：`new RegExp(`app\.slices\.${dom}\.${f}\s*=(?!=)`)`。
  - 于是两类写法不可见：(a) 未列入表的文件（`src/` 下 62 个文件引用 `app.slices`，`grep -rl "app\.slices" src | wc -l` = 62）；(b) 同域别名 `WritableSlice` 写，如
    `src/subagents/commands/subagents.ts:74` `W(app.slices.agent).pendingSubagentFollowup = {…}`（该文件不在 STATE_OWNERS，文本上也不匹配正则）、`src/commands/core.ts:192,214,262,330,353`、`src/commands/commands/image.ts:20`。
    按 `README.md:509` / `CHANGELOG.md:213-215`（“跨域写扫描 … 8 项断言”“跨域状态写零容忍”）的口径，这些属于“非 owner 文件写 agent 域状态”，但脚本对其静默。
  - 副作用：任何**新增**的 src 文件默认逃过该守卫（表不会自动扩展），而 `README.md:509` 让读者以为违规必然失败。
- 复现：在 `src/<新模块>/foo.ts` 写 `app.slices.agent.bellOn = false`，或在 `src/commands/core.ts` 写 `W(app.slices.ui).pendingEchoes = …`，`npm run check` 依旧全绿。
- 建议修法：owner 表按“模块目录 → 域”派生（与 `scripts/app-ops-check.mjs` 从 d.ts 派生 op 的做法一致），扫描全部 `.ts`；同时把 `W(...)` 别名写入纳入检测（例如统一经 `setXxx` op，或让 WritableSlice 只在 owner 模块内可见）。

## F7 · 仓库依赖树与 lockfile 停留在 0.1.2-rc.1，与“已适配 0.1.5-rc.1 并逐包核对类型面”的文档结论不符

- 类别：risk ｜ 严重度：medium ｜ 置信度：high
- 证据：
  - `package.json:36-44` 声明 peer `@deepseek-ai/dsh-agent|dsh-llm|dsh-tools: ^0.1.5-rc.1`；实装与 lock 都是 0.1.2-rc.1：
    `npm ls` → `invalid: @deepseek-ai/dsh-agent@0.1.2-rc.1` / `dsh-llm@0.1.2-rc.1`；
    `node_modules/@deepseek-ai/{dsh-agent,dsh-llm,dsh-session,dsh-tools}/package.json` 版本均为 `0.1.2-rc.1`。
  - `package-lock.json:1-4` 仍是 `"version": "0.2.16"`，`:15-17`/`:30-33` 的 peer 段还是 `^0.1.2-rc.1` → 该 lock 是 v0.2.16 时代产物，之后抬锚未重装。
  - `package.json:62-66` devDependencies（dsh-tools 在 `:63`） 也仍钉 `@deepseek-ai/dsh-tools: ^0.1.2-rc.1`（CHANGELOG v0.2.14 曾声明 dev/peer 同步抬升）。
  - 门禁因此对着旧类型面通过：`npx tsc --noEmit` → exit 0。而 `README.md:99-114`、`UPGRADE.md:3-5`、`CHANGELOG.md:14-15`（“逐包核对官方 release notes / 22 个依赖包的类型面差异”）把它描述成对 0.1.5-rc.1 的已验证适配。
- 复现：`npm ci` 后 `npm run check` 全绿，但 tsc 解析的是 0.1.2-rc.1 的 `.d.ts`；0.1.5 的签名变更无法被门禁发现。
- 建议修法：`npm install` 刷新 lock（含 devDependency dsh-tools 到同一锚点）并在 CI 里加 `npm ls --depth=0` 的 invalid 检查；UPGRADE/README 的“已核对”结论注明核验时的宿主版本与实装版本。

## F8 · `/locale zh` 在“以 en 启动”后无法还原中文：命令描述在安装期被冻结，字典是单向的

- 类别：bug ｜ 严重度：medium-low ｜ 置信度：high
- 证据：
  - `src/kernel/i18n.ts:22-26` 只有 zh→en 单向查表：`t(zh) { if (current !== 'en') return zh; return EN_DICT[zh] ?? zh }`——没有 en→zh 反向表。
  - 启动时先 `setLocale`，再 install 各模块：`src/index.ts:74-88`（`setLocale(localeInit === 'en' ? 'en' : 'zh')` 在 `installCommands` 等之前）。而命令描述是**安装期求值**的常量，例如 `src/commands/commands/exit.ts:12` `desc: t('退出 dsh')`。
  - catalog 读取时原样返回冻结值：`src/kernel/app.ts:515` `commandCatalog: () => app.commandSpecs.map(({ name, desc }) => ({ name, desc }))`，`:516-530` 的 `refreshCommandCatalog` 同样不再翻译。
  - `/locale` 只改 locale 并重推同一批冻结串：`src/commands/commands/locale.ts:20-23`。
  - 文档承诺双向即时切换：`README.md:59`「i18n：runner 侧界面字典化，`/locale zh|en` **即时切换**」、`README.md:236`「界面语言切换」。
- 复现：`DSH_NVIM_TUI_LOCALE=en dsh --profile nvim-tui` → `/locale zh` → `/help`、`/` 补全菜单里命令说明仍是英文（同一进程内无法变回）。
- 建议修法：spec 存 zh 原文（`descKey`）并在 `commandCatalog()` 内 `t()` 翻译；或补 en→zh 反查表。

## F9 · REQUIREMENTS R-SESS-3 的“只显示当前 cwd 会话”与实现完全相反（代码刻意展示其他目录会话）

- 类别：missing-feature ｜ 严重度：low-medium ｜ 置信度：high
- 证据：
  - `REQUIREMENTS.md:248-249`：「**R-SESS-3 列表过滤**：只显示当前工作目录（`cwd` 匹配）的项目级会话；… **其他项目的会话不展示**」。
  - 实现刻意相反：`src/sessions/commands/sessions.ts:41-48`
    ```ts
    // Persisted sessions from OTHER working directories (historyById holds everything):
    rows.push({ label: `    ${h.title ?? ''} · ${h.id}（其他目录）`, … })
    ```
    且 `src/sessions/services.ts:249-254` 注释写明「Any persisted project session is openable — not just the current cwd's (the workspace browser lists sessions from every workspace)」，`selectSession` 对非本 cwd 历史会话走 `resumeSession`。
  - `CHANGELOG.md:733-740`（v0.2.13）记录了这次有意的行为变更（跨工作目录可打开）。README（`README.md:331-349`）已按新行为描述，只有 REQUIREMENTS 未同步。
- 建议修法：改写 R-SESS-3 为“列表按工作区分组 + 其他目录会话单独成行且可打开”。

## F10 · `/deps install` 的 profile 解析有“猜另一个 profile”的目录扫描回退，与 kernel 契约和 CHANGELOG 声明冲突

- 类别：risk ｜ 严重度：low-medium ｜ 置信度：medium-high
- 证据：
  - 契约在 `src/kernel/profile.ts:5-11`：「Nothing silently assumes a profile name — callers **must fail loud** when this returns undefined instead of guessing `nvim-tui`」。
  - `/market` 遵守契约：`src/market/commands/market.ts:19-26`「Target profile = the profile this process booted with … **NEVER guess `nvim-tui`: writing another profile's patch would silently do nothing for the running one**」并在无法解析时明确报错。
  - `/deps install` 不遵守：`src/deps/services.ts:88-110` 在 `runningProfileName()` 返回 undefined 时扫描 `$DSH_HOME/profiles/*`，返回**第一个** `bundles` 含 `dsh-nvim-tui` 的 profile 的 patch 路径；`installCommand`（`:299-303`）只在完全扫不到时才报错。
  - 而 README 自己就记录了两个都可能 bundle 本插件的 profile（`tui` 与 `nvim-tui`，`README.md:66-78`）；`readdirSync` 顺序下可能选中非当前 profile，把装配行写进错误的 patch。
  - `CHANGELOG.md:54-56`（v0.3.5）宣称：「一键装配与 `/market` **一律按启动时的真实 profile 写配置**（loader include 条目解析，删除硬编码 `nvim-tui` 回退，解析不到时**明确报错**）」。
- 复现：loader/argv 都解析不到（如宿主包一层 wrapper 启动）且本机同时存在 `tui`、`nvim-tui` 两个 profile 时，`/deps install` 可能写入 `nvim-tui` 的 patch 而进程跑在 `tui` 上（HMR 等不到服务 → 触发自动重启仍无效）。
- 建议修法：与 `/market` 对齐——优先 loader/argv，缺失时要求 `config.depsProfile` 显式指定，否则报错；扫描回退至多用于“只读报告”。

## F11 · REQUIREMENTS R-PLUG-1 的“300ms/1.2s 检查布局是否被顶掉并自动重建”与代码不符

- 类别：missing-feature ｜ 严重度：low ｜ 置信度：high
- 证据：
  - `REQUIREMENTS.md:290-292`：「dsh_tui 在 `VimEnter` … 接管窗口布局，并在 **300ms/1.2s** 时**检查布局是否被插件（如 dashboard）顶掉并自动重建**」。
  - 这两个定时器实际只做一件事：`nvim/lua/dsh_tui/autocmds.lua:371-372`
    ```lua
    vim.defer_fn(function() B.disable_external_completion() end, 300)
    vim.defer_fn(function() B.disable_external_completion() end, 1200)
    ```
    （禁用外部补全插件干扰，不涉及布局重建）。
  - 现行布局保护是事件驱动，README 已改对：`README.md:389-393`「布局保护是**事件驱动**的（启动守卫窗口期关闭外来窗、WinClosed 重建输入窗、窗口归属守卫；300ms/1.2s 的 defer_fn 用于禁用外部补全插件干扰）」。
- 建议修法：按 README 口径改写 R-PLUG-1。

## F12 · REQUIREMENTS 两处“状态栏 180ms 刷新”与代码 450ms 不符

- 类别：missing-feature ｜ 严重度：low ｜ 置信度：high
- 证据：
  - `REQUIREMENTS.md:269`（R-VIZ-3）与 `:345`（R-NFR-1）：「running 时带旋转动画 + 运行时长，**180ms** 刷新」/「状态栏 running 时 **180ms** 刷新」。
  - 代码是 450ms：`src/statusline/index.ts:79` `}, 450))`（spinner 定时器）。
  - README 正确：`README.md:361`「running 时带旋转动画 + 运行时长，**450ms** 刷新；idle 30s 低频刷新」；`CHANGELOG.md:178`（v0.3.4）已声明「**180ms→450ms**、app-ops-check 动态派生、目录结构等陈旧项批量同步」，但 REQUIREMENTS 的两处漏改（该文件随 npm 包发布）。
- 建议修法：REQUIREMENTS 两处改 450ms，或把定时器常量抽为单一来源供文档引用。

---

## 附：已核实但未计入上表（同源、影响更低）

1. `REQUIREMENTS.md:43` 仍写 `ctx.inject(['agents','agentDefaultModel','sessions'])`；实现为 `src/index.ts:74` `ctx.inject(['agents','agentDefaultModel'], …)`，`UPGRADE.md:7-9` 已说明 `ctx.sessions` 在 0.1.5 移除。
2. `REQUIREMENTS.md:201`、`:299` 的续聊 API 写作 `subagents.followup`；该符号在代码中不存在（`grep` 仅命中注释），实际走 0.1.5 公开 `subagents.prompt`（`src/commands/core.ts:148-158`）与 symbol 兜底（`src/kernel/types.ts:148-152`）；`CHANGELOG.md:670-672` 自己称之为“幻影 API”。`src/subagents/index.ts:104,188` 的注释也仍写 `subagents.followup`。
3. `README.md:450-452` 的 `files` 白名单清单漏列 `REQUIREMENTS.md`（`package.json:13-22` 实际包含它；`REQUIREMENTS.md:352-355` 的 R-NFR-4 是对的）。
4. `CHANGELOG.md:251` 称 app-ops-check「从 d.ts 派生 **76** 个域 op 全量断言」；实跑输出 `78 domain ops`（`scripts/app-ops-check.mjs`）。
5. `scripts/e2e.ts` 的断言面（`e2e.ts:78-101`：末回合标记 + 非空内容 + 错误标记黑名单）与 REQUIREMENTS R-TEST-3 描述一致，但它不验证任何 UI 结构（状态栏、待办板、diff 卡片）；`README.md:110` 提的“headless dump 新增 `## statusline` 段，使该回归可被 e2e 断言”（`src/kernel/headless.ts:35-42` 确已输出）目前**没有任何脚本消费**该段——状态栏空白类回归仍无自动断言。
