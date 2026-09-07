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
