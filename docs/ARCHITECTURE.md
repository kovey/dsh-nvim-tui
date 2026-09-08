# 架构优化方案：模块化 + 插件化（待评审）

> 2026-09 提案。目标：解决 app.ts 平铺字段膨胀（116 字段、0 方法、无边界）与
> 模块高耦合问题；并利用已稳定的 EXT-API 把可独立的功能迁出核心（dogfooding）。
> 本方案只描述结构，不绑定任何行为变化——每个阶段独立提交、smoke 全绿推进。

## 一、现状诊断

- `App` = 116 个平铺字段 + 全部 install 函数槽，**0 个方法**；
- 每个模块 `installXxx(app: App)` 收整个 App，读写任意字段——耦合面无约束；
- 新功能 = App 加字段 + buildApp 加默认值 + build() 接线，三处膨胀；
- 反例也有：ext-api.ts 的 `nodeSlots` 闭包状态模式证明「模块私有状态 + 窄入口」
  可行且更干净——本方案把它推广为规范。

## 二、分层模型（kernel / features / plugins）

```
┌─ kernel（不可膨胀，只增稳定接口）──────────────────┐
│ App 根只保留全局原语（~20 字段）：                    │
│  nvim/lua 通道 · notice · picker 单槽 ·              │
│  sessions/feed 注册表 · 生命周期(quit/teardown) ·    │
│  服务表 svc/get · 内部事件总线（见下）               │
└────────────────────────────────────────────────────┘
   ▲ 方法调用/窄 slice 参数           ▲ 事件（域事件）
┌─ features（领域 slice，闭包状态）──┐ ┌─ plugins（EXT-API 消费方）────┐
│ sessions / commands / transcript / │ │ market / deps / deliverables / │
│ subagents / statusline / ext …     │ │ nlcmd / memory …（可装卸）      │
└────────────────────────────────────┘ └────────────────────────────────┘
```

## 三、第一问：模块化（App 拆分）

> **实施状态（2026-09）**：P0 ✅（`1fd8e70`）P1 ✅（`86fec6c`）P2 ✅。
> 落地偏差说明：签名收窄按「耦合面」取舍——单域模块
> （market-install、deps）收窄为 `(app, s: AppSlices['agent'])`；
> 跨 3-6 域的模块（boot/commands/sessions…）保留 `(app)` 签名，依赖面
> 在每处 `app.slices.<域>.` 引用处显式可见。App 平铺字段 116 → kernel 19。
> 边界守卫：`scripts/check-arch.mjs` 已并入 `npm run check`——App 接口
> 必须 kernel-only、slice 域名白名单校验、遗留平铺访问零容忍。

### 3.1 领域 slice 划分

| slice | 承载字段（示例） | 归属模块 |
|---|---|---|
| `app.runtime` | nvim/lua/channelId/headless/watchdog/disposed/quitting/boot/teardown | boot/bridge |
| `app.sessions` | activeId/sessions/history*/sessionEntries/switchTo/resumeSession/forkSession/… | sessions.ts |
| `app.ui` | activeFeed/feedForSubagent/reasoning/spinner/whale/welcome/… | feed/statusline |
| `app.ext` | extApi/extFire/extLuaSubs/extNodeHandlers/pendingCardInput/extNodeCleanup/… | ext-api/boot |
| `app.trans` | sessionEvents/repairOrphanToolCalls/pendingEchoes/renderedDiffCalls/… | transcript |
| `app.agent` | followup/send/approval/questions/pendingRename/subagent 队列/… | commands/subagents |
| `app.market` | market 状态与行 | market/market-install |

App 根（kernel）保留：nvim/lua、notice、openPicker 单槽、sessions 注册表、
生命周期字段、服务表、内部事件总线。

### 3.2 三条耦合军规

1. **模块私有状态进闭包**：`installXxx(app)` 只读 kernel + 自己的闭包状态；
   需要共享的状态注册到 kernel 服务表（`app.register('name', svc)`）。
2. **签名收窄**：模块函数只收自己 slice——`installSessions(app, app.sessions)`，
   编译期即可见耦合面（谁动谁一目了然）。
3. **跨域读走方法、跨域通知走事件**：slice 暴露方法而非裸字段；跨域交互
   （如 turn/end → statusline 刷新）走 kernel 内部事件总线（extFire 泛化，
   不做依赖注入/优先级/热重载——明确不造 cordis 克隆）。

### 3.3 迁移三阶段（每阶段行为零变化）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 切片** | types.ts 按域拆 slice interface；App = kernel + slices 组合；保留顶层 `app.xxx` 兼容 getter 转发 | 现有模块零改动，tsc + smoke 全绿 |
| **P1 状态归位** | 模块私有状态移闭包；App 字段 116 → ~20；install 签名收窄为 slice；删兼容 getter | smoke 全绿，`grep -c App` 字段数达标 |
| **P2 边界强制** | 新增字段必须进 slice（评审守则）；跨域直读改为方法调用 | CR 执行，可选 ESLint 守卫 |

## 四、第二问：插件化（核心功能迁出）

### 4.1 可行性矩阵

| 功能 | 可行性 | 依赖的 API 缺口 |
|---|---|---|
| 插件市场 market + 安装进度 UI | ✅ 完全可插件化 | 无（picker/notice/card/commands 齐备） |
| 依赖体检 /deps | ✅ | 无 |
| 交付物 /deliverables | ✅ | 无（tool/call 事件镜像已有） |
| 记忆 /remember、/memory | ✅ | 无（文件 IO 插件自带） |
| 自然语言命令路由 nlcmd | ✅ | **缺口 2**：Node 侧输入截获（tui:input 目前只读广播） |
| 子代理对话窗/目录 | 🟡 UI 与事件流可行 | **缺口 3**：feed 内嵌渲染原语（非卡片富文本块）+ 续聊队列暴露 |
| 状态栏成本统计/whale | 🟡 段已对外 | 成本投影需暴露 stats 快照 |
| 卡片/面板/region 生态 | ✅ 已是插件形态 | — |

### 4.2 不插件化（kernel 红线）

boot/自愈层、feed 渲染引擎、picker/审批/提问核心、面板与 region reflow
引擎、i18n 字典、msgpack 桥接、表格渲染——这些是「壳」，插件化只会把稳定面
变成依赖环。

### 4.3 插件化路线（按缺口分批）

1. **零缺口组先行**：market、deps、deliverables、memory 迁出为 profile 侧
   插件（examples/dsh-plugin 形态），核心删除对应模块——预计核心 −800~900 行，
   同时成为 EXT-API 的活文档。
2. **缺口 2**：EXT-API 增 `tui.input.intercept(fn) → { veto?, replace? }`
   （Lua before_submit 的 Node 对等面）→ nlcmd 迁出。
3. **缺口 3**：`tui.ui.block({ sessionId, lines, highlights })` 或等价原语 →
   子代理窗迁出。
4. **缺口 4（可选）**：capabilities 声明机制与 teardown 已够用，按需补齐。

### 4.4 收益与风险

- app.ts 116 字段 → kernel ~20 + 领域 slice；耦合面编译期可见；
- 核心行数 −15~25%；新功能默认先问「能否插件做」；
- 风险控制：每阶段行为零变化、smoke 全绿；P0/P1 不混入新功能；
- 明确不做：内部 cordis 克隆、Lua 侧重构（nvim/lua 模块化已达标）、
  破坏性 API 变更。

## 五、app.ts 瘦身：核心服务实现外移，模块反向注入（待评审）

> 用户观察：P0–P2 后 app.ts 行数几乎没变（806 → ~800）。原因：切片只改了
> **状态存放位置**，createApp 仍内联实现 13 个核心服务（state IO / 历史刷新 /
> 文件快照 / diff 推送 / 命令目录 / 退出诊断 / 生命周期）与 slices 全量默认值。

### 5.1 诊断

app.ts 现状构成：
- kernel 原语（luaCall/svc/notice/openPicker/guard/sleep/信号接线）：~150 行，**应保留**
- slices 空默认值字面量：~150 行，可外移
- 核心服务实现（readState/recordState/refreshHistory/readFileSnapshot/
  maybePushFileDiff/feedForSubagent/refreshList/refreshCommandCatalog/
  exitDiag/closeNvimWindow/teardown/quit/registerCommands）：~450 行，**应外移**

### 5.2 所有权反转：实现跟 owner 走，install 时注入

原则：谁消费、谁拥有——实现代码写在 owner 模块文件里，install 时写回
slice 槽位（这正是现有「模块填槽」机制，只是核心服务还没走这条路；
**不引入通用服务注册表**——字符串键丢编译期检查、与宿主 cordis 职责
重叠，明确不做）。

| createApp 中的实现 | 新归属模块 | 注入点 |
|---|---|---|
| readState/recordState/refreshHistory/refreshList | sessions.ts | installSessions |
| readFileSnapshot/pendingFileSnaps/renderedDiffCalls/maybePushFileDiff | transcript.ts | installTranscript |
| feedForSubagent | subagents.ts | installSubagents |
| registerCommands/commandCatalog/refreshCommandCatalog | commands.ts | installCommands |
| exitDiag/closeNvimWindow/quit/teardown | boot.ts | boot() 入口 |
| 信号钩子 + ctx.effect disposer | 保留 createApp（需要 ctx），委托 teardown 槽位 | — |

app.ts 预期：806 → ~300 行（kernel + 壳 + 注入辅助）。

### 5.3 分阶段

> **实施状态（2026-09）**：I1 ✅（`096195b`）I2 ✅。app.ts 806 → **443 行**。
> 实施中确认的架构修正（已固化）：
> 1. **命令注册设施（registerCommands/commandCatalog/refreshCommandCatalog
>    + commandSpecs 存储）属于 kernel 引导设施**，不回 owner 模块——每个
>    install 体都会注册命令，机制必须从 t=0 存在（原方案映射表将其归
>    commands.ts，实测触发 install 期未定义调用）。
> 2. **runtime 域默认值由 installRuntime(app) 同步注入、index 最先调用**：
>   install 体会往 runtime.hostDisposers 推 disposer，boot() 注入太晚。
> 3. 推论规则（写入 5.4）：**install 体只允许「写自己的域 + 调 kernel」**，
>    install 期读他域 = 架构违规（本次实测抓到 2 处，全部是这类）。

- **I1 实现外移（纯搬移，行为零变化）**：13 个核心服务按表搬到 owner 模块；
  createApp 留壳；check-arch.mjs 增哨兵（createApp 函数体不得再出现业务
  实现——按函数名白名单校验）；smoke 全绿后提交。
- **I2 默认值外移**：slices 字面量的初始状态由各 owner 模块在 install 时
  注入（如 sessions 域 Map 由 installSessions 建）——app.ts 只剩 kernel。
  时序安全依赖既有「no-op until install」模式（installs 先于 boot）。
- **I3（不做）**：kernel 再拆（bridge/lifecycle 独立）——kernel 已是稳定面，
  拆分无收益。

### 5.4 风险（实施后固化为规则）

> **跨域读走方法——收口完成（2026-09）**：slice 状态字段全部 `readonly`，
> 只有 owner 文件经 `WritableSlice<T>` 视图写入；跨域变更一律走 owner
> 注入的**域操作方法**（agent 域：setApproval/settleApproval/setPickerSettle/
> settlePicker/setQuestions/settleQuestions/rejectQuestions/setDirSettle/
> resolveDirPicker/setPendingRename/setPendingQueueEdit/setSubagentView/
> setSubagentChat；ext 域：setPendingCardInput/fireExtReady；runtime 域：
> setChatWin/setReasoning/spinnerSet/spinnerStep）。类型层（readonly +
> WritableSlice 白名单视图）+ 检查层（check-arch 3c 跨域状态写扫描器）
> 双保险，38 处历史跨域状态写全部收敛为 ops 调用。

- I1 为纯搬移（已遵守：diff 仅代码位移 + 作用域适配）。
- **install 体三原则**：只写自己拥有的域；只调 kernel 原语；install 期
  不得读他域（违反即未定义调用——I2 实测两次踩中：installStatusline 调
  agent 域 registerCommands、写 runtime 域 hostDisposers，均以
  TypeError 静默挂掉为代价发现）。check-arch 的 MOVED_SERVICES/MOVED_STATE
  哨兵持续兜底。

## 六、boot.ts 瘦身：纯组合根（2026-09-07 实施）

### 6.1 现状与目标

boot.ts 曾以 1024 行承载：22 分支的 `dsh-*` 通知 if-else 链、session/event
长链（含 4 份重复的工具目标快照块）、11 段重复的 host 事件注册样板、生命
周期四件套与 headless 看门狗。重构后 boot.ts ~180 行，只做四件事：

1. 同步安装 lifecycle + headless 服务（任何 await 前就位）；
2. spawn nvim / 连接 / 握手 / 命令目录与主题下发；
3. 运行薄循环（见 6.2）；
4. 跑 boot 序列（会话恢复 → 看门狗 → 输入排空 → ready → headless kick）。

### 6.2 三条薄循环 + 一张注册表

| 面 | 归属模块 | boot 里的形态 |
| --- | --- | --- |
| nvim request（dsh-ext 总线） | ext-api.ts `handleDshExtRequest` | 一行转发 |
| nvim notification（`dsh-*`） | rpc.ts 注册表；各 owner 在 install 期 `registerNvimNotification`（commands 认领 input/command/abort/审批/提问/选择器/目录/at/paste-image，sessions 认领 select/new，subagents 认领 view/chat/send，ext-api 认领 register/unregister/notice/card-activate，boot= runtime 认领 quit/reasoning-toggled） | 一次查表 + `guard` 包络 |
| host 事件（agent/status、subagent/*、workflow/*、approval/questions） | host-events.ts 注册表；statusline/subagents/transcript/commands 在 install 期 `registerHostHandler` | 一个 for 循环订阅 |
| session/event 管线 | session-events.ts `makeSessionEventHandler`：扩展镜像 → 子代理 chat/view 路由（共享 `snapshotToolTarget` 快照助手）→ child→parent diff → 主会话 per-type hook 表（MAIN_EVENT_HOOKS，含 turn/start、tool/call、tool/result、turn/end、session/title、user/message、assistant/message、plan/mode、goal/change）→ fold 与 headless 结束判定 | 一次订阅 |

### 6.3 规则（防膨胀）

- boot.ts **不写行为分支**：新增 `dsh-*` 通知 / host 事件，必须在 owner
  模块 install 期注册进 rpc.ts / host-events.ts 表；boot 里出现新分支即
  违反本约定（code review 红线，不靠脚本哨兵）。
- 通知 handler 的异常一律由 `dispatchNvimNotification` 的 guard 包络
  （错误日志 + 聊天区 notice），handler 内部不再写各自的 try/catch 样板；
  此前无 catch 的分支（审批/提问/选择器等）从此不再有 unhandled
  rejection 杀进程的风险。
- 顺带修复（同批）：dsh-picker-selected/cancelled 的重复 settlePicker 死
  调用；dumpAndQuit 声明晚于 session/event 注册的 TDZ 隐患（现由
  installHeadless 提前注入）；check-arch 断言 1 因 bb13252 注释改动而
  锚点失配长期静默失效、commandSpecs 假阳性哨兵，均已修复（断言 1 现
  真实生效）。
- 全面复查后追加修复（同批）：注册表幂等覆盖（hmr 同进程二次 apply 不再
  throw，覆盖时留 console.warn 诊断）；handler 一律使用派发期 app 参数
  而非 install 期闭包捕获；watchdog 定时器经 hostDisposers 由 teardown
  统一清理（旧 app 不再被定时器滞留 120s）；app.ts 信号监听改为命名
  函数（原匿名箭头 off 永不命中，每次 apply 泄漏 3 个监听器）；补上
  Lua 侧一直发送但从未被处理的 dsh-open-failed 通知（/dir、/deliverables、
  /settings 打开文件失败时聊天区提示）；清理 dsh-dir-selected 的
  setDirSettle 死调用。

