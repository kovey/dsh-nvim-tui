# 审计报告：kernel-features

**审计单元**：kernel-features（难度路由 / 识图选型 / 待办守卫 / profile 解析）
**审计对象**：`/Users/zhangyong/workspace/deepseek/neovim-tui`（v0.3.5，HEAD `a14c7a7`），已适配 dsh v0.1.5-rc.1
**必读文件（已完整读取）**：
- `src/kernel/difficulty.ts`（382 行，全读）
- `src/kernel/vision.ts`（43 行，全读）
- `src/kernel/todo-guard.ts`（158 行，全读）
- `src/kernel/profile.ts`（49 行，全读）

**宿主侧证据来源（用于确认 API 语义，非猜测）**：
- `/Users/zhangyong/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（dsh 0.1.5-rc.1 实际安装）：
  `dsh-agent-loop/lib/index.js`（回合/步进、inbox claim）、`dsh-agent/lib/index.js`（installModelSelection）、
  `dsh-llm/lib/index.js`（resolveModelInfo / prepareCall / resolveCallWithInfo / adapterStream）、
  `dsh-llm-deepseek/lib/index.js`、`dsh-llm-pi-ai/lib/index.js`（effort 元数据）、
  `dsh-tool-subagent/lib/{index.js,model-selection-settings.js}`（子代理模型闸门）、
  `dsh-settings/lib/index.js`（settings.update(ns, patch)）、
  `cordis-plugin-loader/lib/index.js`（Loader/EntryTree）、`dsh-app-boot/lib/index.js`（root include 创建）、
  `dsh-session/lib/index.js`（Session 事件日志）、`dsh-system-prompt/lib/index.js`（section 注册）。
- 本仓 `node_modules/@deepseek-ai/dsh-session@0.1.2-rc.1`（对照旧宿主 API）。
- `~/.dsh/settings.yaml`、`~/.dsh/profiles/nvim-tui/{cordis.yml,package.json}`（当前部署实际配置）。

**结论摘要**

| # | 类别 | 严重度 | 位置 | 一句话 |
|---|------|--------|------|--------|
| 1 | bug | 高 | `src/commands/core.ts:73-96` + `src/boot/session-events.ts:170-179` + `src/kernel/difficulty.ts:255` | 识图临时切换是"会话级单槽 + 时间闸门"，会被任意在其后开始的回合消费：运行中排队图片时当前回合剩余步被改模型；"先文本后图片"排队时图片回合跑在非识图模型上，被适配器 `UNSUPPORTED_CONTENT` 拒绝 |
| 2 | bug | 中 | `src/kernel/difficulty.ts:118-129` | 分类器失败/超时（宿主规范化为终结 finish chunk，不抛）被当成合法结论 `medium`，未回退规则，notice 还宣称"LLM 分类" |
| 3 | bug | 中 | `src/kernel/vision.ts:24-43` + `src/commands/core.ts:81` | 识图选型只看 image 模态、不过滤 `reasoningEffort`，切换时继承原模型 effort → 目标模型不支持时回合硬失败 `UNSUPPORTED_REASONING_EFFORT` |
| 4 | bug | 中 | `src/kernel/difficulty.ts:57-58, 224-231` | 档位"目录校验"只挡 provider 不挡 model（resolveModelInfo 明确不校验路由），`t.effort` 与继承 effort 完全不校验 → 配置错别字/不兼容 effort 仍让回合死掉，而非"降级用默认模型" |
| 5 | missing-feature / risk | 中 | `src/kernel/difficulty.ts:180-202, 347-360, 376-379` | M4 子代理闸门：对当前会话（及其子代理）实际不生效（宿主只在**新会话组合**时采样）；`off` 会用非法/破坏性 patch 覆盖用户全局设置且无回收；`auto` 不同步却宣称已同步；空路由集时每次切换都失败 |
| 6 | bug | 低 | `src/kernel/difficulty.ts:302-303, 320-322` | 识图切换挂起时，已 park 的难度估计被无条件丢弃，排队回合既不路由又跑在识图模型上 |
| 7 | bug | 低 | `src/kernel/difficulty.ts:284-292` | 悬空切换的恢复路径漏了 `rec.provider`（另三处恢复都设置了），状态栏右段显示过期 provider |
| 8 | bug | 低 | `src/kernel/profile.ts:26-41` | loader 回退分支 `loader.entries().find(...)` 必然 TypeError（宿主 `*entries()` 是生成器），被空 catch 吞掉后静默退到 argv —— 正是模块 doc 自称"非权威"的那条路 |
| 9 | deadcode | 低 | `src/kernel/todo-guard.ts:86-96` | `session.events` 回退分支在 0.1.2/0.1.5 都不可达（两个宿主版本都只有 `snapshotEvents()`/`ownEvents()`） |
| 10 | risk | 低 | `src/kernel/todo-guard.ts:110-115, 117-157` | 两处注册与整个回调路径全量吞异常，"代码级硬约束"若注册失败会完全静默消失（无 notice/日志） |

---

## 1. 识图临时切换会被"任意在其后开始的回合"消费 → 图片回合跑在非识图模型上直接失败（bug，高）

**主证据（本仓）**
- `src/commands/core.ts:73-96`：图片消息发送时才武装切换，`rec.visionTmp = { prev: sel, switchAt: Date.now() }`（:82），并且**只在"又一条图片消息"时延长窗口**（:91-96）。`sel` 取自 `rec.modelRef.current`，武装的同时就把 `rec.modelRef.current` 改成了识图模型（:81）。
- `src/boot/session-events.ts:170-179`：恢复条件只有一个时间闸门
  `if (rec.visionTmp !== null && (rec.lastTurnStartAt ?? 0) >= rec.visionTmp.switchAt)` —— **任何**在该切换之后"开始"的回合，结束时都会把切换消费掉并切回 `prev`。
- `src/kernel/difficulty.ts:255`：`if (rec.visionTmp !== null) return` —— 这段守卫只能阻止难度路由叠加，无法阻止上面的误消费。

**宿主语义（决定触发路径，已核对源码）**
- `followup()` 的目标是 **next-turn**：`dsh-agent-loop/lib/index.js:789-791` `followup(input) { this.send(input, "next-turn", true) }`。
- 每个回合的**首个 pre-step** 只从 next-turn 领取 **1 条**消息：`dsh-agent-loop/lib/index.js:104-112`
  `claim(target, turn) { const claimed = this.mutate("next-step", 0, this.nextStep.length, [], false); if (target === "next-turn") claimed.push(...this.mutate("next-turn", 0, 1, [], false)); ... }`，而 `turn()` 里 `let target = "next-turn"`（:932），首个步之后才 `target = "next-step"`（:974）。
  ⇒ **排队消息按 FIFO 各自成一个回合**（仓库自己的"已排队：当前回合结束后处理"注释与 pending 设计也依赖这一点）。
- 会话模型在**每一步**的 prompt 组装时快照：`dsh-agent/lib/index.js:134-146`（`system-prompt/assemble` 里 `const selected = selection.current` → `selection.assembled = selected`），请求侧再写 `provider/model/reasoningEffort`（:148-159）。⇒ 运行中改 `modelRef.current` 会改到**当前回合并未结束的后续步**。
- 非识图模型收到图片内容会被硬拒：`dsh-llm-deepseek/lib/index.js:1620` `throw new LlmError(\`DeepSeek model "${options.model}" does not accept image input.\`, "UNSUPPORTED_CONTENT")`、:48。

**复现路径（前提：该会话当前模型是纯文本模型，如 `deepseek-v4-pro`，或难度档位指向纯文本模型）**
1. 回合 A 运行中（`rec.status === '● running'`）。
2. 用户先发一条**文本** T（排队，落 next-turn[0]），紧接着发一条**图片** I（排队，落 next-turn[1]）。
   - T 的 `followup`: `routeDifficultyForTurn` 走 running 分支，只 park `d.pending`，不动 `modelRef`（difficulty.ts:256-278）。
   - I 的 `followup`: 先 park `d.pending`（覆盖 T 的），随后识图块判定当前模型非 image → `rec.modelRef.current = {...M, model: V}`、`visionTmp = {prev: M, switchAt: t2}`（core.ts:74-88）。
3. **回合 A 剩余步**：下一步的 prompt 组装的快照变成 V ⇒ 一个纯文本/工具回合在运行中被静默切到识图模型（difficulty.ts:257-261 明确写了"绝不能发生"的那件事）。
4. 回合 A 结束：`lastTurnStartAt(A) < t2` → 不恢复（正确，保护排队图片）。
5. 回合 T 开始（`lastTurnStartAt = t3 > t2`）→ 跑在 V 上 → **回合 T 结束即消费掉切换并切回 M**。
6. 回合 I 开始 → 请求模型是 M（非 image）→ 适配器 `UNSUPPORTED_CONTENT`，**图片消息丢失**。
7. 若顺序为"图片 I 先排队、文本 T 后排队"，则 I 正常跑 V，T 跑 M（无路由）；只有"文本在前"这一种顺序会走到 5-6 的失败，但 3（运行中改模型）对任何"运行中发图"都成立。

**建议修法（任一，建议 1+3）**
1. 把切换与"待处理的图片回合"绑定：用计数/队列（`pendingImageTurns`）或"本期待识图消息 id 集合"替代 `switchAt` 时间闸门，只有真正承载图片的那个回合结束才恢复。
2. 在**任何** `followup` 排队时若 `visionTmp !== null` 就 `visionTmp.switchAt = Date.now()`（把 core.ts:91-96 的做法从"图片消息"扩展到"所有排队消息"）——最小改动，能消除 5-6。
3. 运行中（`rec.status` running）一律不动 `modelRef`：把识图切换也做成 pending（与难度 pending 同构），在 `turn/end` 之后再武装，避免 3。

---

## 2. 分类器失败/超时被当成合法的 `medium`，未回退规则（bug，中）

**证据**
- `src/kernel/difficulty.ts:84` 注释与 README/REQUIREMENTS（R-DIFF-2、R-DIFF-7）都承诺 "M3 — optional LLM classifier (falls back to rules on ANY failure)"、"分类器超时上限（默认 8s）"。
- `src/kernel/difficulty.ts:108-129`：`AbortSignal.timeout(timeoutMs)`（:109）→ `prepareCall`（:110）→ `for await (const chunk of prepared.stream(request)) assembler.push(chunk)`（:118）→ **只读 `assembler.blocks()` 的 text 块**（:119-123），从不检查 `assembler.finish`/`assembler.message()`：
  ```ts
  if (/hard|困难|复杂|难/.test(out)) return 'hard'
  if (/easy|简单|轻松/.test(out)) return 'easy'
  return 'medium'          // :126 —— 任何空输出/异常结束都落在这里
  ```
- 宿主把运行期失败**规范化成终结 finish chunk，不抛异常**：`dsh-llm/lib/index.js:2223` 起 `adapterStream`（文档："Adapter selection, dispatch, iterator construction, and iteration failures become one terminal failure chunk"），`adapterFailureChunk`（:2311-2324）产出 `{type:'finish', reason:{kind:'error'|'aborted', failure}}`。⇒ 超时/网络/鉴权/限流失败都不会进 `catch`（:127-129），而是 `out === ''` → `return 'medium'`。
- 后果链：`estimateDifficulty`（:145-146）把 `{tier:'medium', source:'classifier'}` 当权威结论返回，**规则评估（plan/goal/toolErrors → hard、CHATTY → easy）被跳过**；`applyTierSwitch` 的 notice 还会写"LLM 分类"（:239）。

**复现路径**：`difficultyRouting.classifier = { enabled: true, model: <不可达/无权限/会超时> }`，在 plan 模式或本回合有工具失败时发消息 → 规则本应 hard，实际得到 medium（并声称是 LLM 分类）。

**建议修法**
```ts
for await (const chunk of prepared.stream(request)) assembler.push(chunk)
if (assembler.finish.kind !== 'stop') return null      // error / aborted / max-tokens → 回退规则
const out = ...
if (out === '') return null
```
另外把正则判定改为**只接受词表结论**（例如 `const m = out.match(/\b(easy|medium|hard)\b/)`，未命中即 `null`），避免自由文本被误判。

---

## 3. 识图选型不考虑 `reasoningEffort` 兼容性（bug，中）

**证据**
- `src/kernel/vision.ts:24-43`：候选循环**只**判断模态
  ```ts
  const info = await llm.resolveModelInfo(provider, id)
  if (info?.inputModalities?.includes('image') === true) return id     // :29-31
  ```
  宿主返回的 `LlmResolvedModelInfo` 同时带 `reasoning?: { efforts, defaultEffort }`（`dsh-llm/lib/types/types.d.ts:296-305`），`vision.ts` 完全没用；`src/kernel/types.ts:481` 的本地鸭子类型也只声明了 `inputModalities`，于是编译期也发现不了。
- `src/commands/core.ts:81`：`rec.modelRef.current = { ...sel, model: visionModel }` —— **保留**原文本模型的 `reasoningEffort`。
- 宿主会在解析调用配置时硬失败：`dsh-llm/lib/index.js:2113-2121`
  ```js
  if (reasoning === void 0) { if (requested !== void 0) throw new LlmError(`provider ... does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT") }
  else { const effective = requested ?? reasoning.defaultEffort; ... if (!reasoning.efforts.some(e => e.id === effective)) throw ... }
  ```
  并且会话模型选择会把 effort 直接写进请求：`dsh-agent/lib/index.js:152-157`。
- 该错误不属于任何可重试码（`dsh-llm-retry/lib/index.js:160` 只重试 `policy.retryableCodes` 内的码）⇒ 回合直接失败，图片消息丢失。
- 真实可达性：`dsh-llm-pi-ai/lib/index.js:1691-1695`（`resolveReasoningLevel` 对不支持的 effort 直接抛）与 `:1712-1721`（`reasoningInfo` 按模型 `getSupportedThinkingLevels` 暴露 efforts；无 reasoning 元数据的模型**不暴露 reasoning**，此时任何显式 effort 都会被拒）。即使用户的 deepseek 部署（`~/.dsh/settings.yaml` 里 `agent-default-model.reasoningEffort: max`，deepseek 适配器对所有模型都给 off/low/high/max）目前不触发，只要换成 pi-ai/第三方 provider 或某个 provider 的识图模型没有 `max`，`/effort max` + 图片就会死在适配器边界。

**复现路径**：`/effort max`（或 settings 里默认 effort=max）→ 发图片 → 选中的识图模型 effort 集合不含 max → `UNSUPPORTED_REASONING_EFFORT`。

**建议修法**：候选循环里同时校验 effort：`const want = sel.reasoningEffort; if (want === undefined || info.reasoning?.efforts.some(e => e.id === want)) return id`；若所有候选都不支持该 effort，则返回候选 + 在调用处把 effort 置 `undefined`（= 模型默认，core.ts:81 写 `{ provider, model: visionModel }`），并 notice 说明"识图模型不支持当前推理等级，本回合按模型默认"。

---

## 4. 档位路由的"目录校验"挡不住错别字，effort 完全不校验（bug，中）

**证据**
- `src/kernel/difficulty.ts:222-231`：
  ```ts
  // 0.1.5: verify the tier model exists in the catalog — a missing model
  // would kill the whole turn with NO_ADAPTER instead of degrading.
  const info = await llm.resolveModelInfo(route.provider, route.model).catch(() => undefined)
  if (info === undefined || info === null) { notify(...'不在模型目录中'); return }
  ```
- 宿主对该 API 的承诺正好相反：`dsh-llm/lib/index.js:2036-2045`（`resolveModelInfo` 文档："catalog membership remains advisory and does not control request routing"），实现只是 `registration(provider)`（provider 未注册才抛 `NO_ADAPTER`）+ `adapter.resolveModel(...)`。
- deepseek 适配器对**未列出**的 model id 依然正常返回元数据（`dsh-llm-deepseek/lib/index.js:1579-1595`：`configured === undefined` 时 `{provider, id: model, name: model, inputModalities: ["text"]}`）⇒ `info !== null`，校验通过，回合随后死在 provider/网关侧（而不是"跳过 + 提示 + 用默认模型"）。
- effort 侧无任何校验：`:57-58`
  ```ts
  if (t.effort !== undefined && t.effort !== 'auto') route.reasoningEffort = t.effort
  else if (t.effort === undefined) route.reasoningEffort = current.reasoningEffort
  ```
  即 (a) 配置里 `tiers.hard.effort` 可以写任意字符串（`ReasoningEffortId` 只是 brand，运行时不做词表校验），(b) 档位模型会**继承**当前模型的 effort —— 两者都可触发第 3 条同一个宿主错误 `UNSUPPORTED_REASONING_EFFORT`（`dsh-llm/lib/index.js:2113-2121`）。

**复现路径**：`tiers: { hard: { model: deepseek-v4-prao } }`（错别字）→ 无"跳过"notice，回合在网关侧报错；`tiers: { easy: { model: <无 reasoning 元数据的模型>, effort: max } }` → `UNSUPPORTED_REASONING_EFFORT` 直接死。

**建议修法**
1. 成员判断改用 `llm.listModels(provider)`（`dsh-llm/lib/index.js:2015-2032`，返回适配器目录）做 `some(m => m.id === route.model)`，`resolveModelInfo` 只用于 provider 是否注册。
2. 把 effort 校验一起做掉：`const efforts = info.reasoning?.efforts; if (route.reasoningEffort !== undefined && !(efforts ?? []).some(e => e.id === route.reasoningEffort)) → notice + 去掉 reasoningEffort`（继承来的 effort 不兼容时降级为模型默认，而不是让回合死）。

---

## 5. M4 子代理模型闸门：对当前会话不生效、破坏性写入全局设置、状态行谎报（missing-feature + risk，中）

**证据（本仓）**
- `src/kernel/difficulty.ts:180-202` `syncSubagentPolicy`：直接 `settings.update('subagent-model-selection', enabled ? { enabled: true, allowedModels: allRoutes(...) } : { enabled: false, allowedModels: [] })`，去重键是**每会话**的 `rec.difficulty.syncedRoutesKey`（:186），成功 notice 宣称"子代理模型闸门已同步为难度档位模型"。
- `:347`（`/difficulty off` → 同步 `false`）、`:358`（钉住档位 → 同步 `true`）、`:376-379`（只要 `cfg.subagentPolicy === true` 就打印"子代理模型闸门: 同步档位模型"）；`:351-354`（`/difficulty auto` **不**同步）。

**证据（宿主语义）**
- 该设置只在**新会话组合子代理工具时采样一次**：`dsh-tool-subagent/lib/index.js:589-604`（`else if (freshSession) { const current = settings.current(); allowedModels = current.enabled ? current.allowedModels : void 0 }`），随后被记入 session projection；子代理（child）更是从父会话**已记录的策略**继承（同段 `parentId` 分支）。⇒ 会话运行中改设置**不会**影响该会话，也不会影响它的子代理——与 `/difficulty` 的 notice 和 README"子代理联动…模型可在其中自选"的承诺不符。
- 校验会拒绝"enabled 但空列表"：`dsh-tool-subagent/lib/model-selection-settings.js:92-95` `if (value.enabled && value.allowedModels.length === 0) throw new Error("enabled subagent model selection requires at least one allowed model")`。⇒ `subagentPolicy: true` 但 `tiers` 未配置（或全档未配 model 使 `allRoutes()` 为空，`difficulty.ts:162-174`）时，每次路由切换都走 catch 打 notice"子代理模型策略同步失败: enabled subagent model selection requires at least one allowed model"（:199-201），且 `syncedRoutesKey` 永不更新 ⇒ 反复重试、反复刷屏。
- `settings.update` 是**写用户文档**（`dsh-settings/lib/index.js:403-405` → `write(..., 'merge', ...)` → `persist`），命名空间是全局单例。⇒ 用户在 `settings.yaml` 里**自己**开启的 `subagent-model-selection` 会被 `/difficulty off` 静默改成 `{enabled: false, allowedModels: []}`（原 allowedModels 被清空、不可恢复）；进程退出/会话 dispose 时也没有任何回收逻辑（全仓 `subagent-model-selection` 仅出现在 difficulty.ts）。
- `syncedRoutesKey` 是每会话的、设置是全局的：两个会话若 `allRoutes(cfg, current)` 不同（`current` 取各自 `rec.modelRef.current`，:162-178），后写者覆盖前写者，而先写者因 key 相同不再重写 ⇒ 全局闸门内容与实际档位漂移。
- `/difficulty auto` 不重新同步（:351-354）而状态行（:379）无条件宣称"同步档位模型"⇒ 报告与实际不一致，直到下一次"非 no-op"的档位切换（`:220-221` 的同路由提前返回会跳过同步）才自愈。

**建议修法**
1. `subagentPolicy: true` 时把"生效时点"写进 notice/doc（"仅对之后新建的会话生效"），或改用宿主提供的 per-session 记录途径（`recordSubagentModelSelection` 是内部 API，需谨慎）。
2. 写设置前先读回原值（`settings.describe()`/`get(ns)`）并在关闭/退出时恢复，避免覆盖用户自有意愿；`/difficulty auto` 也调用 `syncSubagentPolicy(..., true)`。
3. `allRoutes() === []` 时改为写 `{enabled: false, allowedModels: []}`（或直接跳过 + 一次提示），不要发一个必然被 validate 拒绝的 patch。
4. 状态行按"是否真的同步过"（`rec.difficulty.syncedRoutesKey === routesKey(...)`）显示，而不是只看 `cfg.subagentPolicy`。

---

## 6. 识图切换挂起时，park 好的难度估计被丢弃（bug，低）

**证据**：`src/kernel/difficulty.ts:300-322`
```ts
const pending = d.pending
d.pending = null                       // :303 无条件清空
if (d.tmp !== null && ...) { ...切换回去... }
if (pending !== null && rec.visionTmp === null) {   // :320 仅此条件才应用
  void applyTierSwitch(app, rec, pending, notify).catch(() => {})
}
```
`rec.visionTmp !== null` 时（图片回合已在队列里、但**尚未开始**）park 的估计被直接丢掉，而不是留到下一个真正开始的回合；同一场景下 `routeDifficultyForTurn` 又因 `visionTmp !== null` 提前 return（:255），这条排队消息**永远不会**被重新估计。

**复现路径**：回合运行中先排队文本 T、再排队图片 I（同第 1 条的时序）→ turn/end 时 `pending`（T 的估计）被清空 → T 的回合既不路由，又（按第 1 条）跑在识图模型上。

**建议修法**：`d.pending` 只在被新估计覆盖或真正被消费后清空；`rec.visionTmp !== null` 时保留 pending（`d.pending = pending` 回写），等图片回合结束、`visionTmp` 清空后的那个 turn/end 再应用。

---

## 7. 悬空切换的恢复路径漏了 `rec.provider`（bug，低）

**证据**：`src/kernel/difficulty.ts:284-292`（发送前的"悬空 tmp"恢复）
```ts
rec.modelRef.current = prev
rec.model = prev.model        // 只恢复 model
// 缺 rec.provider = prev.provider
```
对比另外三处恢复都恢复了三个字段：`:309-311`（turn/end）、`:343-345`（`/difficulty off`）、以及 `applyTierSwitch` 设置时的 `:232-234`。
`rec.provider` 是状态栏右段的可见项：`src/statusline/index.ts:290` `right.push(escapeStatusline(rec?.provider ?? ...))`；它平时由 `request/context` 事件刷新（`statusline/index.ts:40`），因此在恢复后到下一次请求事件之间会显示档位 provider。

**复现路径**：档位切换生效后回合没跑起来（消息被 `/queue` 清掉、发送失败），下一次发送走 :284 的恢复分支 → 状态栏模型是默认模型、provider 仍是档位 provider。

**建议修法**：在该分支补 `rec.provider = prev.provider`（与另三处一致），或抽一个 `restoreSelection(rec, prev)` 帮助函数统一四处。

---

## 8. profile.ts 的 loader 回退分支必然抛异常且被静默吞掉（bug，低；同时是"doc 宣称的健壮性"缺口）

**证据**
- `src/kernel/profile.ts:27-33`：
  ```ts
  const loader = app.runtimeCtx.get('loader') as unknown as {
    resolve?: (id: string) => LoaderEntryLike | undefined
    entries?: () => Array<LoaderEntryLike>          // ← 鸭子类型谎报：实际是生成器
  } | undefined
  const entry = loader?.resolve?.('include') ??
    loader?.entries?.().find((e) => e.id === 'include' || e.options?.name === 'cordis:include')
  ```
- 宿主实现：`cordis-plugin-loader/lib/index.js:169-176` 是**生成器方法** `*entries() { for (const entry of Object.values(this.store)) { yield entry; ... } }` ⇒ `entries()` 返回 Generator，**没有 `.find`** ⇒ 一旦该分支被求值就 `TypeError: loader.entries(...).find is not a function`。
- 该 TypeError 被 `:41` 的 `catch {}` 吞掉 → 直接落到 argv 回退（`:42-48`），而模块 doc（:5-10）明确说 argv 只是 "fallback for loader-less contexts (tests/headless)"、loader 路径才是 "authoritative… for ANY launch spelling"。
- 可达性说明：0.1.5 的 root include entry id 恰为 `'include'`（`dsh-app-boot/lib/index.js:1335-1343`：`const rootInclude = { id: "include", name: "cordis:include", config: { path: pathToFileURL(absoluteConfigPath).href, ...}}`），因此 `resolve('include')` 正常时该分支不会被求值（潜在缺陷）；但 `resolve` 一旦抛错（id 变化、entry 被替换/事务回滚、未来宿主调整），本应救场的第二路必然失败——正是 doc 宣称要覆盖的场景。另：`resolve()` 缺失而 `entries()` 存在时也会走进这条路。
- 另附：`resolve(id)` 在 id 不存在时是**抛错**而非返回 undefined（`cordis-plugin-loader/lib/index.js:206-217` "cannot resolve entry"），该抛错同样被 `:41` 吞掉，静默降级。

**建议修法**
```ts
const listed = [...(loader?.entries?.() ?? [])]        // 生成器 → 数组
const entry = tryResolve('include') ?? listed.find(e => e.id === 'include' || e.options?.name === 'cordis:include')
```
并把 `catch {}` 换成一次性 `app.exitDiag('profile-resolve', err)`（或至少在 argv 回退时记一条诊断），避免"权威来源失败"完全无痕。

---

## 9. `todo-guard` 的 `session.events` 回退分支在受支持宿主上不可达（deadcode，低）

**证据**
- `src/kernel/todo-guard.ts:85-96`：
  ```ts
  /** Session log access (0.1.5 `snapshotEvents()`, pre-alpha.4 `events`). */
  function sessionEventsOf(session: unknown): SessionEventLike[] {
    const s = session as { snapshotEvents?: () => unknown; events?: unknown } | undefined
    ... if (Array.isArray(s?.events)) return s!.events as SessionEventLike[]
  ```
- 两个受支持宿主版本都**没有** `events` 属性，只有 `snapshotEvents()` / `ownEvents()`：
  - 0.1.5-rc.1：`dsh-session/lib/types/index.d.ts:184/189`；实现里同类字段为私有 `eventsSnapshot`（`dsh-session/lib/index.js:1090, 1109-1110`）。
  - 0.1.2-rc.1（本仓 `node_modules/@deepseek-ai/dsh-session`）：`lib/types/index.d.ts:184/189`，`lib/index.js:1325, 1344-1345` 同样是 `eventsSnapshot`。
- 全仓引用面：`installTodoGuard` 仅被 `src/sessions/services.ts:113/157/300` 调用；`sessionEventsOf` 为该文件私有函数（无其它引用），因此不存在"老宿主插件另设 `events`"的旁路。

**建议修法**：删除该分支（或改成 `s.ownEvents?.()` 的版本自适应），把注释里的 pre-alpha.4 兼容说明一并删掉，避免误以为有兼容网；若确实要保留，加一条 smoke 断言覆盖（当前 `scripts/smoke.ts` 只测纯函数，见下）。

---

## 10. 待办守卫的注册与运行路径全量吞异常，功能可能静默消失（risk，低）

**证据**：`src/kernel/todo-guard.ts`
- `:110-115` 常驻 prompt 段落注册：整段 `try { prompt?.section?.({...}) } catch {}` —— `SystemPrompt.section()` 在**重名**时会抛（宿主实现的错误文案见 `dsh-system-prompt/lib/index.js:188` "prompt section \"x\" is already registered…"），文件头部 `:24` 注释也承认 "Stable section name (a duplicate registration would throw)"，但失败没有任何 notice/日志。
- `:117-157` pre-step 瀑布注册与回调：外层 `try { ctx?.on?.(...)} catch {}`（:157），回调内 `try { ... } catch { return decision }`（:153-155），`sessionEventsOf` 内亦 `catch {}`（:94）。任何一步失效（宿主 API 形态变化、`ctx.on` 选项不支持、`decision.messages` 结构变化）都会让"逐步提醒"彻底消失，而 README/模块 doc（:8-18）对用户的承诺是"把逐项维护变成**代码层面的硬性要求**"。
- 补充：这是"fail-open"设计（不能因为守卫失败而破坏回合并），本身合理；问题在于**零可观测性**——用户在 UI 上无法区分"模型自觉更新清单"和"守卫根本没装上"。

**建议修法**：在 `installTodoGuard` 的每个 catch 里做一次性诊断（`app.exitDiag('todo-guard-section', msg)` 或首次 notice，可用模块级 boolean 去重），并在 `section()` 返回非函数（宿主返回值变化）时也记一条；可选：注册成功后 `app.notice` 一条 debug 级日志（或受 `DSH_NVIM_TUI_DEBUG` 控制）。

---

## 已核查、判定**不是**缺陷的点（供复核，避免重复排查）

1. **回调里加 `decision.messages` 是正确用法**：与宿主自带的 `modelSwitchNotice` 完全同构（`dsh-agent/lib/index.js:99-114`：`createUserMessage({content, source:{kind:'plugin', plugin, form:'notice', summary}})`，:160-171 同样是 pre-step + `{prepend:true}` + `{...decision, messages:[...decision.messages, notice]}`）。`todo-guard.ts:147-151` 的 source 形态合法（`ContextFormed` 的 `notice` 分支要求 `summary`，`dsh-llm/lib/types/message.d.ts:81-85`）。
2. **system-prompt 段落确实是 agent 作用域、随 agent 释放**：`SystemPrompt.section()` 用 `this.layers.effect(this.ctx, ...)`（`dsh-system-prompt/lib/index.js:238-241`），而 cordis 通过 traceable/shadow 机制让经 `agentCtx.systemPrompt` 调用的方法看到**调用方 ctx**（`cordis/lib/index.js:117-157` `createTraceable/createShadow`）⇒ `scopeOf(ctx)` 是 agent 作用域，不会与其它会话重名冲突、也不会泄漏到全局。
3. **运行中判定 `rec.status.startsWith('● running')` 可靠**：状态值只有两个字面量（`src/statusline/index.ts:367-371` `'● running'` / `'○ idle'`，来自宿主 `agent/status`），没有 spinner 前缀污染。
4. **`classifyViaLlm` 的 `prepareCall/stream` 参数形态正确**：`prepareCall(config, signal)` 与 `PreparedLlmCall.stream(GenerateOptions)` 匹配（`dsh-llm/lib/types/index.d.ts:380`、`types.d.ts:404-444`：`messages/sessionId/signal` 都是合法字段），`{...prepared.config}` 使 `callConfigEquals` 成立，不会触发 `INVALID_PREPARED_CALL`（`dsh-llm/lib/index.js:2164-2166`）；`BlockAssembler.push/blocks()` 在 0.1.5 仍存在（`dsh-llm/lib/types/assembler.d.ts:32, 49`）。
5. **`settings.update(ns, patch)` 是真实 API**（`dsh-settings/lib/index.js:403-405`），M4 调用不会因方法名不存在而静默跳过（其问题见第 5 条）。
6. **`findVisionModel` 对新目录的降级是对的**：适配器对未列出的 model id 返回 `inputModalities:['text']` ⇒ 偏好列表里过期的 id（如本部署 `settings.yaml` 未列 `deepseek-flash`）会被跳过，随后命中真正声明 image 的模型；`listModels` 扫描兜底也成立（0.1.5 本地目录里 `deepseek-flash`/`deepseek-v4-flash-vision-exp` 声明 image，`deepseek-v4-flash` 未声明 ⇒ `["text"]`，见 `dsh-llm-deepseek/lib/index.js:1841-1871`）。
7. **难度 pending 的"排队即 park、turn/end 再应用"与宿主回合语义一致**：排队 followup 确实各自成回合（第 1 条里的 claim 证据），且每回合首个 pre-step 只领 1 条。
8. **`routeDifficultyForTurn` 的 `await` 与 `followup` 的先后顺序正确**：`src/commands/core.ts:52-54` 在 `agent.followup` 之前应用档位，`d.tmp.switchAt` 必然早于该回合 `turn/start`（`src/boot/session-events.ts:81-88` 写 `lastTurnStartAt`），恢复闸门成立。

## 覆盖度与局限

- `scripts/smoke.ts:1780-1807` 只覆盖 `estimateByRules` 与 `latestTodos/todoGuardReminder` 两个纯函数；**路由应用/恢复时序、effort 兼容、vision 交织、M4 同步、profile 解析均无测试**（第 1/3/4/5/6/8 条都属于这类"只靠人工推理"的路径，建议按报告中的复现路径补时序单测）。
- 本次审计为静态分析 + 宿主源码核对，未在 nvim TUI 里实机复现（会话条件：需要运行中排队消息的时序）。第 1 条建议的验证方式：把 `classifier`/`tiers` 配好，把默认模型设为 `deepseek-v4-pro`（`inputModalities:[text]`），回合运行中先发文本再发图片，观察 feed 是否出现"DeepSeek model ... does not accept image input"。
- 未改动任何源码文件。
