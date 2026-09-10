# 审计报告 — 单元 `commands-b`（后半批命令）

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（dsh-nvim-tui v0.3.5，适配 dsh v0.1.5-rc.1）
- 分支/HEAD：`a14c7a7`（工作区干净，未修改任何源码）
- 审计时间：本轮会话
- 审计对象：`src/commands/commands/` 后半批命令（mcp, memory, model, models, panel, permission, plan, plugins,
  preset, quit, remember, restart, search, settings, skills, status, steer, stop, tasks, theme, todo, workflow, yolo）
- 宿主契约证据来源（只读，未安装/未改动）：
  - `~/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（0.1.5-rc.1 全量宿主包）
  - `/private/tmp/dsh015/node_modules/@deepseek-ai/`（0.1.5-rc.1 第二份拷贝，交叉验证）
  - 仓库内 `nvim/lua/dsh_tui/*.lua`（RPC 落地端）、`src/kernel/*`、`src/feed/*`、`src/boot/*`（调用方/落点）

## 覆盖范围说明

- 清单中的 `src/commands/commands/rewind.ts` **不存在**：`/rewind` 实现在 `src/transcript/commands/rewind.ts`
  （属 transcript 单元）。已顺带核验其降级守卫有效：0.1.5-rc.1 `dsh-session` 无 `truncate` 符号，
  `rewind.ts:13` 能力探测后提示 `/fork` 替代，与 `UPGRADE.md:457-464` 文档一致 —— 非缺陷。
- 上述 23 个 `commands-b` 文件均已 **完整通读**；`src/commands/index.ts`、`src/commands/core.ts`、
  `src/kernel/{app,types,lifecycle,bridge}.ts`、`src/feed/{feed,stats}.ts`、`src/boot/{boot,session-events}.ts`、
  `nvim/lua/dsh_tui/{init,rpc,popups,popup_core,session,layout,api}.lua` 作为调用方/落点交叉阅读。

## 发现（按严重度排序）

---

### 1. [high / bug] `/model`、`/models` 的模型目录读取名字空间合成错误 —— 默认 provider 下整个“可切换模型”列表消失

- 文件/行：`src/commands/commands/models.ts:12-16`（`configuredModels`）、`models.ts:58-70`（live provider 分支）、
  `src/commands/commands/model.ts:33-37`、`model.ts:56-57`、`model.ts:71`
- 机制：
  ```ts
  // models.ts:15
  const wanted = new Set<string>([`llm-${providerId}.models`])
  ```
  `providerId` 来自 `llm.listProviders()[].id`，即 **provider route key**。0.1.5-rc.1 内置 deepseek 适配器的
  route key 与 settings 段名**不是** `llm-<路由>` 关系：
  - `dsh-llm-deepseek/lib/index.js:1840`：`const PROVIDER = "deepseek-official"`
  - 同文件 `:1837`：`const NS = "llm-deepseek"`
  - 同文件 `:2067-2072`（官方目录条目，显式给出二者映射）：
    ```js
    ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "DeepSeek",
                                             settingsNs: NS, settingsPath: [] }])
    ```
  - 官方前端就是按映射匹配的：`dsh-client-ui-settings-models/lib/client.js:1090`
    `entry.provider === "deepseek-official" && entry.settingsNs === "llm-deepseek"`。
  - 本机真实配置 `~/.dsh/settings.yaml`：`agent-default-model.provider: deepseek-official`，模型目录写在
    `llm-deepseek:` 段 —— 即 `llm-${providerId}` = `llm-deepseek-official`，**不存在该段**。
- 后果（`modelCatalogRows`）：
  - `configuredModels(app,'deepseek-official')` 恒返回 `[]`（`settings.describe()` 里没有 `llm-deepseek-official`）
    → `models.ts:59` 的 `if (models.length > 0)` 永不成立 → 每个 live provider 只落进 `:69` 的
    “（用 /model <id>/<模型名> 切换）”信息行，**没有任何 `switch:` 行**。
  - `/model`（`model.ts:56-57`）的 pickable 只剩 `act:current` 表头 + `prov:` 信息行 → 选中信息行时打印
    `model.ts:71`「该 provider 未装配或模型目录不可枚举（settings.yaml 配置后 /restart）」**误导**（目录其实已配置）。
    这正是 `model.ts:10-12` 注释自称已修好的“decorative picker”。
  - `model.ts:33-37` 的「目录不含该模型」校验被静默跳过（`models.length===0` 分支），`/model deepseek-official/任意串`
    会直接写进 `agent-default-model` 持久化。
  - 讽刺点：`models.ts:76` 给“未装配”provider 打印的 `settingsNs`（`p.settingsNs`）就是正确段名，而 live 分支
    却去猜 `llm-<id>`；且 `models.ts:74` 会把 live provider 从 configurable 目录里 `continue` 掉，正确信息被丢弃。
- 复现：默认 profile（deepseek 内置适配器）启动 → `/model` 回车 → 浮窗只有「▸ 当前模型」，无模型可选；
  `/models` 同样只有信息行。改 `settings.yaml` 之外的任何模型都无法从 picker 切换。
- 建议修法：用宿主目录解析段名，而不是拼字符串：
  ```ts
  const nsOf = (pid: string): string | undefined =>
    llm.listConfigurableProviders?.().find((p) => String(p.provider ?? '') === pid)?.settingsNs
  const models = configuredModels(app, id, nsOf(id))
  ```
  `configuredModels(app, providerId, settingsNs?)` 的第三参已存在（见发现 8），传入后即为活代码；
  `models.ts:74` 的 `continue` 也应改为“用目录段名取模型”，而不是直接丢弃。

---

### 2. [medium / risk] `/permission` 的“危险预设”确认只按预设**名字**正则判定，自定义预设表可静默绕过

- 文件/行：`src/commands/commands/permission.ts:36-50`（判定在 `:40`）
- 机制：
  ```ts
  const opt = permission.optionOf(name)
  const danger = /full|danger/i.test(name) || /全|危险/.test(opt?.name ?? '')
  if (danger && name !== current) { /* openPicker 二次确认 */ }
  ```
  判定输入只有「表键」与「显示名」，而真正决定危险性的是预设的**旋钮组合**。0.1.5-rc.1 `dsh-permission-presets`
  文档明确：`Config.presets?: Record<string, PresetSpec>` 是用户可配的任意表，`PresetSpec = { sandbox: SandboxMode;
  approval: ApprovalPolicy; name?; description? }`（`lib/types/index.d.ts:46-58,100-104`），并暴露
  `resolve(name): PresetSpec`（同文件 `:138-142`，“@throws when name is not in the table”）。因此一个
  `presets: { free: { sandbox: 'danger-full-access', approval: 'never' } }` 的部署里，`/permission free`
  既不匹配 `/full|danger/i` 也不匹配 `/全|危险/` → 直接 `permission.set()`，全访问沙箱零确认。
- 附带：`src/kernel/types.ts:283-288` 的 `PermissionPresetsService` 未声明 `resolve`，所以现有类型面根本拿不到旋钮；
  修法需同时补类型（`resolve: (name: string) => { sandbox?: string; approval?: string }`）。
- 复现：在 profile patch 的 `permission-presets` 行加 `presets: { free: { sandbox: danger-full-access, approval: never } }`
  → `/permission free` 无确认即切换。
- 建议修法：把 `danger` 判定改成读旋钮：
  ```ts
  const spec = permission.resolve?.(name)
  const danger = spec?.sandbox === 'danger-full-access' || spec?.approval === 'never'
  ```
  名字/文案正则最多作为 `resolve` 缺失时的兜底。

---

### 3. [medium / bug] `/settings set` 把写入值原样回显，`role('secret')` 字段（API key）明文进聊天区

- 文件/行：`src/commands/commands/settings.ts:31-46`（回显在 `:46`）
- 机制：
  ```ts
  let value: unknown = raw
  ...
  const patch = {...}; node[path.at(-1)] = value
  await settings.update(ns, patch)
  app.notice(`已更新设置 ${ns}.${m[2]} = ${JSON.stringify(value)}`)   // :46 —— 原样回显
  ```
  同一条命令的概览路径刻意做了脱敏（`settings.ts:66` `settings.describe?.({ redactSecrets: true })`、
  `:70-71` 注释「presence check … never prints the value」），`:46` 却把用户敲的字符串直接打进 feed。
  宿主确实有被声明为机密的设置项：`dsh-web-search-deepseek/lib/index.js:244-245`
  `const Config = z.object({ apiKey: z.string().role("secret"), ... })`，
  `dsh-settings/lib/types/redact.js` 的 `redactSecrets()` 就是为这些 `role('secret')` 位置服务的，
  `describe()` 的 `secrets?: RedactedSecret[]`（`lib/types/index.d.ts:71-72,81`）只在 `redactSecrets` 下出现。
- 影响面（精确）：`app.notice` → `FeedRenderer.appendNotice` → `feed.ts:309-313` 只 push 进内存 `base`，**不进 session log**
  （切会话重建 feed 即消失）；但明文会停留在 nvim 缓冲区（可被 yank/截图）、headless e2e dump 文件、终端回滚缓冲区。
  即：命令自己刚宣称“不打印机密”，下一条路径就打印了。
- 复现：`/settings set web-search-deepseek apiKey sk-XXXX` → 聊天区出现 `已更新设置 web-search-deepseek.apiKey = "sk-XXXX"`。
- 建议修法：回显前过一层判定——若 `describe({redactSecrets:true})` 中该 ns 的 `secrets[].path` 命中
  写入路径（或键名匹配 `/key|token|secret|password/i`），回显改为 `***`（只报“已更新”，不回显值）。

---

### 4. [medium / bug] `/preset` 绕过 `agentPresets.select()`：丢失 per-session 串行化，且自实现的空白判定与宿主不同源

- 文件/行：`src/commands/commands/preset.ts:35-41`
- 机制：
  ```ts
  if (app.slices.trans.sessionEvents(agent.session).some((e) => e.type === 'turn/start')) { ...拒绝... }  // :35
  const applied = await presets.recompose(agent.ctx, a)                                                  // :39
  agent.session.append('agent-preset/selected', { agentPreset: applied.id })                             // :40
  ```
  宿主 0.1.5-rc.1 提供了正是这条流程的官方入口，且两处关键保护都挂在它上面：
  - `dsh-agent-presets/lib/types/index.d.ts:349`：`recompose(agentCtx, id)`，文档明确
    **“The CALLER owns that check — this method does not read session history.”** 也就是说宿主不在
    `recompose` 里兜底锁检查（`preset.ts:35` 是唯一防线，且用的是原始日志扫描）。
  - 同文件 `:369` `select(agent, agentPreset)` + 实现 `lib/index.js:1731-1743`：per-session 串行化
    （`this.switches`，注释原文：“Two concurrent selects would both pass the blank check, and the second
    re-link would then find the record the first already replaced — **leaving two compositions registered
    into one agent layer**”），并在 `swap()` 内用宿主自己的判定
    `sessionProjections.stateOf(session,'turnBoundary')` + `openTurnStartSeq !== null || lastTurn > 0`
    抛 `agent-preset/locked`（`lib/index.js:1743-1746`）。
  - TUI 的命令派发**不串行**：`src/commands/core.ts:469-471` 是 `void Promise.resolve().then(() => spec.fn(rest))`，
    用户连打 `/preset A` + `/preset B`（会话仍空白、无 turn/start）时两个 `recompose` 并发进入 —— 正是宿主文档
    描述的“一个 agent 层注册两份 composition”。同时自实现的判定与宿主的 `turnBoundary` 投影不同源，
    一旦日志/投影出现视图差异，就会出现「TUI 放行 → 宿主无兜底 → 已产出内容的会话被换 composition」
    （宿主注释：会留下新 composition 无法发出的 tool call）。
- 复现：空白会话里快速执行两次 `/preset <不同 id>`（或并发触发 tui_command preset）。
- 建议修法：直接 `const appliedId = await presets.select(agent, a)`（返回记录的 preset id），删除自实现的
  空白检查与手工 append；`resolve`/`list` 保持现状。类型面在 `src/kernel/types.ts:395-398` 补 `select`。

---

### 5. [low / bug] `/theme default` 是空操作：预设只叠加不复位，旧主题属性永久残留

- 文件/行：`src/commands/commands/theme.ts:9-15`（`default: {}`）、`theme.ts:22`
- 机制：`/theme default` 把 `{}` 交给 Lua：
  ```ts
  void app.luaCall('require("dsh_tui").apply_theme(...)', [theme]).catch(() => {})   // theme.ts:22
  app.notice(`主题: ${name}`)
  ```
  `nvim/lua/dsh_tui/rpc.lua:64-86` 的 `apply_theme` 只做 `pairs` 遍历 + `nvim_set_hl` 覆盖，**没有任何复位/
  重新 link 基类的路径**；空表即零次迭代。于是 `dim`（`DshTuiReasoning/DshTuiNotice` italic）或 `vivid`
  （`DshTuiUser` bold）切回 `default` 后属性仍在，且提示照样打印“主题: default”（静默失败）。
- 复现：`/theme dim` → `/theme default` → 思考面板仍是斜体；`/theme vivid` → `/theme mono` → `DshTuiUser` 同时 bold+underline。
- 建议修法：`apply_theme` 增加“先复位”语义（例如发送 `{__reset=true}` 时对预设涉及的全部高亮组执行
  `nvim_set_hl(0, group, {})`，或让 theme 表显式带 `bold=false/italic=false/underline=false` 全量下发），
  `default` 走复位分支。

---

### 6. [low / bug] `/steer` 的引导指令在实时聊天区渲染两次（➤ 行 + 用户气泡），回放时只剩一次

- 文件/行：`src/commands/commands/steer.ts:21-26`
- 机制：
  ```ts
  rec.handle.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))  // :21-24
  rec.feed.pushBlock('steer', text)   // :25 → feed.ts:319-320 渲染 "➤ text"
  ```
  这条 steering 消息会在宿主 step 边界被消费并**作为 `user/message` 落日志**（`dsh-agent-loop/lib/index.js:1028`：
  `if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, {surfaceOp:'append'})`；
  `next-step` 收件箱即 steering，见同文件 `:85-105`）。事件回到 TUI 时：
  - `src/boot/session-events.ts:287-305` 的去重只匹配 `pendingEchoes` 队列，而 steer.ts 从不入队 → `echoed=false`；
  - `session-events.ts:310-315` 照常 `feed.applyEvent(event)`；
  - `feed.ts:695` `source.kind === 'user'` → `pushUser(text)` → 第二条 `> text` 气泡。
  结果是同一条指令实时显示两遍（`➤ 换个方案试试` 与 `> 换个方案试试`），而 resume 回放只显示气泡一遍。
  `scripts/smoke.ts:1095-1101` 只直接调用 `pushBlock('steer', …)` 断言 ➤ 行存在，没走命令链路，所以没覆盖到重复。
- 建议修法：steer.ts 与提交路径对齐 —— 入 `app.slices.ui.pendingEchoes`（键为 activeId，值为 text）并只渲染一次；
  或保留 ➤ 行但在 `session-events.ts` 的 user/message 分支按文本匹配跳过该条（后者更脆弱，推荐前者）。

---

### 7. [low / bug] `/memory` 列表只枚举顶层 `.md`，项目记忆的主体（`lessons/` 子树）不可见

- 文件/行：`src/commands/commands/memory.ts:45-47`
- 机制：
  ```ts
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) app.notice(`- ${f}`)   // :45-47
  ```
  `readdirSync` 不递归，且子目录名不以 `.md` 结尾 → 直接过滤掉。而同一命令的删除分支支持子路径
  （`:17-25` 用 `resolve(dir, name)` + `startsWith(base+sep)` 守卫，`delete lessons/xxx` 合法可用），
  说明“浏览”能力只是漏实现。真实目录（本仓库 `.dsh/memory/`）：
  ```
  .dsh/memory/global.md  .dsh/memory/MEMORY.md
  .dsh/memory/lessons/*.md   ← 20+ 条教训条目，/memory 里一条都看不到
  ```
  用户的记忆协议（`~/.dsh/memory/MEMORY.md`「目录协议/使用协议」：读 `MEMORY.md` + `lessons/`）正是以
  `lessons/` 为主体，所以 `/memory` 实际上“浏览不到要删的东西”，用户只能靠猜 id 走 `delete`。
- 建议修法：递归枚举（`readdirSync(dir, {withFileTypes:true})`，目录下钻并打印相对路径），或在列表里至少打印
  `lessons/（N 个条目，用 /memory delete lessons/<id> 删除）`。

---

### 8. [low / deadcode] `configuredModels(app, providerId, settingsNs?)` 的第三参数无任何调用方

- 文件/行：`src/commands/commands/models.ts:12`、`:16`
- 证据（全局 grep）：
  ```
  $ grep -rn "configuredModels(" --include=*.ts .            # 排除定义处
  src/commands/commands/model.ts:33:  const models = configuredModels(app, provider)
  src/commands/commands/models.ts:58: const models = configuredModels(app, id)
  ```
  两个调用点都是 2 参 → `:16` 的 `if (settingsNs !== undefined && settingsNs !== '') wanted.add(settingsNs)`
  在现网不可达（编译产物 `lib/commands/commands/models.d.ts:6` 也保留了该可选参数）。
- 说明/修法：这不是无害冗余 —— 它正是发现 1 的修法接口（把 provider→settingsNs 映射喂进来即可让该分支变活），
  建议按发现 1 修复，而不是删除参数。

---

### 9. [low / missing-feature] `/settings` 的自述用法与实现语法不一致（`set` 缺 ns），注册 usage 也只写 `[edit]`

- 文件/行：`src/commands/commands/settings.ts:97`（提示文案）、`:105`（注册 usage）
- 机制：实现要求 `/settings set <ns> <key.path> <value>`（`settings.ts:18-30` 的
  `rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/)` 把第一段当 ns，且 `:25` 的用法提示是三段式），
  但同一命令结尾的自述行写的是两段式：
  ```
  :97  '… /settings set <key.path> <value> 即时写入；…'
  :105 usage: t('[edit]')      // 完全没有 set
  ```
  照 `:97` 输入 `/settings set model deepseek-v4-pro` 会把 `model` 当 ns → `settings.update('model', …)`
  抛 `TypeError`（未注册段）→ 用户只看到「设置更新失败」。`/help`/补全菜单里也看不到 `set` 子命令。
- 建议修法：`:97` 改为 `/settings set <ns> <key.path> <value>`，`:105` 的 usage 改成 `[edit|set …]`。

---

### 10. [low / risk] `/yolo` 手写 `approval/policy` 事件，绕过官方 `userApproval.setPolicy()`（无去重、无模型侧变更通知）

- 文件/行：`src/commands/commands/yolo.ts:19-22`
- 机制：
  ```ts
  rec.handle.agent.session.append('approval/policy', { policy })   // :19
  rec.policy = policy; app.slices.ui.updateStatusline()            // :20-21
  ```
  策略本身通过日志 fold 生效（宿主 `dsh-user-approval/lib/index.js:149-168` `effectivePolicy → overrideOf`
  倒扫 `approval/policy`；`:141` `never → 'rejected'`，与文案一致），所以功能可用。但官方写入口
  `ApprovalService.setPolicy(agent, policy)`（`lib/types/index.d.ts:102-108`）额外做了两件事，
  这里都没做：`if (previous === policy) return`（重复 `/yolo on` 会不断追加同值事件污染日志），
  以及 `agent.inject(... "The approval policy changed from X to Y (changed by the user)")` 的模型侧变更通知。
  （注：官方 `permission-presets` 的预设切换同样用 log-only 写入 `setApprovalPolicy`，所以此项严重度低，
  但 TUI 是“手写事件”而非调用任一官方入口，且 `src/kernel/types.ts` 也未建模该服务。）
- 建议修法：优先 `app.svc('userApproval')?.setPolicy?.(rec.handle.agent, policy)`，缺失时回退当前 append；
  至少在写前比对 `rec.policy === policy` 直接返回。

---

### 11. [low / risk] `/panel` 是“无反馈 + 全吞异常”的裸 RPC，Lua 侧在非 TUI 窗口下是显式 no-op

- 文件/行：`src/commands/commands/panel.ts:10`
- 机制：
  ```ts
  fn: () => app.luaCall('require("dsh_tui").toggle_reasoning()', []).catch(() => {})
  ```
  两头都没有可观测性：(a) `.catch(() => {})` 吞掉 RPC 失败（nvim 未连、Lua 报错都无声）；(b) 命令本身不打印
  任何 notice，用户/agent 无法判断是否生效；(c) Lua 端 `nvim/lua/dsh_tui/session.lua:86-92` 有明确守卫 ——
  当前窗口既不是 chat/input 也不是面板本身（例如焦点在浮窗、picker、`tabedit` 出来的文件 tab）时**直接 return**。
  于是 agent 通过 `tui_command panel`（`src/commands/core.ts:483` 白名单含 `/panel`）在浮窗/文件 tab 焦点下调用，
  工具仍返回 `executed: true`（`core.ts:546-547`）而屏幕上什么都没发生 —— 典型静默失败。
- 建议修法：`toggle_reasoning` 返回布尔（是否执行），命令据此 notice「已展开/已收起」或「请先回到输入框(<C-o>)」；
  `.catch` 改为打日志 + notice，而不是空吞。

---

## 附录 A — 已逐条核验为**正确**的宿主契约（同批文件的可疑点已排除）

| 位置 | 核验结论（证据） |
| --- | --- |
| `mcp.ts:20-24` | MCP 工具名前缀确为 `mcp__<server>__<tool>`（`dsh-mcp-client/lib/index.js:121`），`slice(5).split('__')[0]` 取 server 正确；`tools.schemas(scope)` 的 scope 就是 agent（`dsh-tools/lib/types/index.d.ts:670-676`） |
| `tasks.ts:26,48` | `jobs.kill(id, caller, reason)` 返回值词表 `'requested' \| 'already-finished'`（`dsh-jobs/lib/types/index.d.ts:100-103`；`dsh-jobs-local/lib/index.js:202,208`）与文案分支完全一致；`JobSnapshot.startedAt` 必填、`JobStatus` 含 `stopping`（`:88-110`） |
| `tasks.ts:35` | `JobStatus = 'running'\|'stopping'\|'completed'\|'killed'\|'failed'`：icon 映射覆盖 4 种，`stopping` 落默认 `·`（可接受） |
| `permission.ts:22-36` | `names`（getter，readonly string[]）、`current(session)`、`optionOf(name)`（对非表键抛错，但调用前已 `names.includes` 校验）签名一致（`dsh-permission-presets/lib/types/index.d.ts:31-150`） |
| `plan.ts:20-30` | `get(agent) → {active, pending?}`、`set(agent, on) → 'committed'\|'queued'\|'cancelled'\|'noop'`（`dsh-plan-mode/lib/types/index.d.ts:112,132`）；待生效语义与 `（变更待生效）` 文案一致 |
| `plugins.ts:12-27` | `pluginInventory` 确为 ctx 服务（`dsh-host-plugin-inventory/lib/index.js:91-92` `static inject=["loader"]` + `super(ctx,"pluginInventory")`），`list()` 异步返回 `{entries:[{entryId,moduleName,enabled,fiberPhase}]}`，字段名全部对得上 |
| `skills.ts:22-44` | `skills.get(name,{scope})`/`list({scope})` 的 scope 就是 Agent 对象（宿主自身 `dsh-tool-skill/lib/index.js:143,177,210` 亦传 `scope: agent`）；`SkillDefinition` 的 `whenToUse/content` 字段名正确（`dsh-skill/lib/types/index.d.ts:44-79`） |
| `search.ts:21-36` | `searchSessions({query,eventFilters,limit})` 合法；`{kind:'type',values:['user/message','assistant/message']}` 是合法 `SessionEventMetadataFilter`（`dsh-session-query/lib/types/types.d.ts:189-206`，事件名 ∈ `SessionEventType = keyof SessionEventMap`）；`hits[].header.id` 必填、`bestMatch.snippet` 必填；`selectSession` 对持久化会话会 `resumeSession`（`src/sessions/services.ts:245-257`） |
| `settings.ts:53-98` | `prepareDocument()`/`documentPath`/`writable`/`describe({redactSecrets})`/`update(ns,patch,expectedRevision?)` 全部匹配 `dsh-settings` 0.1.5 签名；`show_lines_float(title, lines, editPath)` 三参形态与 `nvim/lua/dsh_tui/popups.lua:387` 一致（`null` 第三参为 `vim.NIL`，Lua 侧用 `type()=='string'` 判定，安全） |
| `models.ts:18-35` | `llm-deepseek` 段 `models` 为对象数组（`dsh-llm-deepseek/lib/index.js:1896` `z.array(catalogModel)`），`extract()` 的 `v.models[].id` 分支正确 —— 唯一问题是段名（发现 1） |
| `model.ts:25-38` | `llm.listProviders/listConfigurableProviders/listModels/resolveModelInfo` 在 0.1.5 全部存在（`dsh-llm/lib/types/index.d.ts:156,267,281,354`） |
| `todo.ts:26-31` | `sessionProjections.stateOf(session,'todos')` 签名与 projection key 正确（`dsh-session-projection/lib/types/index.d.ts:175`；`dsh-tool-todo/lib/types/types.d.ts:34-44`，值可空且已做 `Array.isArray` 兜底） |
| `workflow.ts:10-28` | `trans.workflowRuns` 的写入端字段（name/id/startedAt/phases/agents{seq,label,outcome}/logs/running/stopReason）与读取端一一对应（`src/transcript/index.ts:298-361`） |
| `steer.ts:21` / `stop.ts` / `status.ts` | `agent.steer(message)` 存在且语义为“最近一步引导”（`dsh-agent/lib/types/runtime-types.d.ts:118-126`）；`/stop` 的 `rec.status !== '● running'` 与 statusline 的唯一赋值点（`src/statusline/index.ts:368,371`）严格一致；`modeLabel(undefined) → '?'`（`src/feed/stats.ts:86-92`） |
| `quit.ts` / `restart.ts:19-21` | `setRestartPending(true)` 由 `src/boot/boot.ts:48` 提供，`quit()` 在 nvim 释放终端 + teardown 之后才 spawn successor（`src/kernel/lifecycle.ts:152-200`），与注释一致；`quitting` 幂等 |
| `nlcmd.ts` 路由 | 43 个自然语言 intent 名与全仓已注册命令名做集合差：**无悬空路由**（全部 `comm -23` 为空） |
| `rewind`（清单误列路径） | 实际在 `src/transcript/commands/rewind.ts`，能力探测降级符合 `UPGRADE.md:457-464` 的文档化行为 |

## 附录 B — 考虑过但未立案（证据不足或属设计取舍）

1. `/remember` 写入 `.dsh/memory/global.md`（`remember.ts:20`）：该文件名不在本项目记忆协议的读取路径
   （`~/.dsh/memory/MEMORY.md` 的「目录协议/使用协议」只读 `MEMORY.md` + `lessons/`，仓库内 `global.md` 为空文件），
   存在“写了但没人读”的嫌疑；但记忆协议属用户级工具约定、且 README 只承诺“写入 `.dsh/memory/`”，故未立案。
2. `models.ts:22` 的 `extract()` 在 `Array.isArray(v)` 分支对“无 `id` 的对象元素”会产出 `[object Object]`
   （过滤只排 `''`/`'undefined'`）；但 0.1.5 各 adapter 的 `models` 段都是 `{models:[{id,…}]}` 形态，
   该分支在现网不可达，证据不足。
3. `search.ts:31-36` 忽略 `page.nextCursor`：`/search` 静默截断在 20 条、无翻页入口（`dsh-session-query` 支持游标）。
   属功能缺口但影响轻微，未占条目。
4. `panel.ts` 的 Lua 守卫设计（浮窗焦点下 no-op）本身是**有意**的（`session.lua:79-85` 注释解释避免抢焦点），
   发现 11 只针对“无反馈 + 吞异常”这一可观测性缺陷。
