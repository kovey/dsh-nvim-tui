# 审计报告：kernel-runtime

- 仓库：`/Users/zhangyong/workspace/deepseek/neovim-tui`（dsh-nvim-tui v0.3.5，适配 dsh 0.1.5-rc.1）
- 审计单元：`kernel-runtime`
- 必读文件（已**完整**通读）：
  - `src/kernel/lifecycle.ts`（217 行）
  - `src/kernel/headless.ts`（68 行）
  - `src/kernel/term.ts`（45 行）
  - `src/kernel/apikey.ts`（47 行）
  - `src/kernel/subagent-clean.ts`（84 行）
  - `src/kernel/i18n.ts`（337 行）
  - `src/kernel/rpc.ts`（37 行）
  - `src/kernel/host-events.ts`（41 行）
  - `src/kernel/bridge.ts`（214 行）
  - `src/kernel/ext-types.ts`（262 行）
- 调用方/宿主交叉验证（grep + 读码）：
  - `src/boot/boot.ts`、`src/boot/session-events.ts`、`src/boot/onboarding.ts`、`src/index.ts`、`src/kernel/app.ts`、`src/kernel/types.ts`
  - `src/sessions/index.ts`、`src/subagents/commands/subagents.ts`、`src/commands/index.ts`、`src/commands/core.ts`、`src/commands/commands/*.ts`
  - `nvim/lua/dsh_tui/*.lua`（`dsh-*` 通知 1:1 对账）
  - `node_modules/@deepseek-ai/cordis/lib/index.js`（`on`/`emit`/`waterfall`/`effect` 语义）、`node_modules/@deepseek-ai/dsh-session/lib/index.js`（`SessionStore` = `sessions` 服务，方法使用 `this`）、`node_modules/@deepseek-ai/dsh-user-approval/lib/index.js`（`approval/request` waterfall 的失败兜底）、`node_modules/@deepseek-ai/cordis`（服务为 class 实例）
  - 文档对照：`README.md`、`REQUIREMENTS.md`、`CHANGELOG.md`、`docs/REVIEW-2025-09.md`（v0.3.3 旧审查，用于区分「新发现 / 旧已知未修」）
- 复现手段：静态追踪为主；i18n 覆盖面用 node 脚本对 `EN_DICT` 与全库 `t('…')` 调用点做集合差（见第 5 条）；`dsh-*` 通知用 `grep -rhoE "dsh-[a-z0-9-]+"` 双向对账（结论：Lua 发出 23 个 ↔ Node 注册 23 个，无缺口）。
- **未修改任何源码文件**（仅新增本报告）。

结论：**1 条高危 bug**（`/restart` 后继进程失败被当成成功，dsh 静默退出且无后继）、**4 条中危 bug**（关闭 nvim 的「已死」保证未强制 / 退出清理预算自相矛盾且与文档不符 / 会话持久化 flush 链三重静默 / i18n 字典键与调用点漂移）、**1 条中危 missing-feature**（`truncateStored` 截断清理并不存在）、**6 条低危**（2 bug + 3 risk + 1 deadcode）。通知面（Lua↔Node 23:23）与 nvim 请求面未发现缺口。

| # | 类别 | 严重度 | 位置 | 一句话 |
|---|------|--------|------|--------|
| 1 | bug | high | lifecycle.ts:189-201 | `/restart` 后继 spawn 失败（缺 python3 等）被当成「后继已退出」→ 静默退出，无后继 |
| 2 | bug | medium | lifecycle.ts:52-61,163-192 | `closeNvimWindow` 声称「返回时子进程必死」但最后一次 SIGKILL 后不再校验 → 后继可能抢在活着的旧 nvim 前抢终端 |
| 3 | bug | medium | lifecycle.ts:152-164 | 硬退出兜底 2000ms < 文档承诺的 2.5s 清理上限，且 < `closeNvimWindow` 自身最坏 1950ms → flush/dispose 被截断 |
| 4 | bug | medium | lifecycle.ts:100-115 | flush 链三重静默：逐会话失败仍置 `flushed=true`、服务方法被脱 `this` 调用、全程无诊断 |
| 5 | bug | medium | i18n.ts:26-29,98,41,76,106 | 字典键与调用点大面积漂移（精确匹配），英文模式静默退回中文 |
| 6 | bug | low | headless.ts:45-47,54 | dump 失败兜底自身可抛 → `void` 掉 → 宿主 fail-loud 直接杀进程、无 dump |
| 7 | bug | low | bridge.ts:112-138（配合 boot.ts:121） | dispose 撞上 `await spawnNvim` 时子 nvim 被孤儿化并占住 tty |
| 8 | missing-feature | medium | subagent-clean.ts:1-11 | 文件头宣称用 `truncateStored` 截断思考链；该 API 全库不存在，0.1.5 上清理只剩「隐藏」 |
| 9 | risk | low | rpc.ts:31-34 | 未知通知逐条同步 `appendFileSync`，无去重/限速（外部输入驱动的无界日志） |
| 10 | risk | low | host-events.ts:30-39 | 守护只覆盖同步 throw；注释宣称的「不会杀死宿主」对 async handler 不成立 |
| 11 | risk | low | term.ts:31-43 | 终端模式重置不全（缺 `?1000l/?1005l/?1015l`）；kitty 用「弹栈」而非无条件清零 |
| 12 | deadcode | low | subagent-clean.ts:23-30 | `encodeSessionLog` 的 events 编码分支无任何调用方（唯一调用点传 `[]`） |

---

## 1. [bug / high] `/restart` 后继进程启动失败被当作成功：dsh 静默退出，没有后继

**位置**
- `src/kernel/lifecycle.ts:189-201`（后继 spawn + 等待退出 + `app.requestExit`）
- 失败分支：`src/kernel/lifecycle.ts:207-211`
- 入口：`src/commands/commands/restart.ts:20-22`（`setRestartPending(true)` → `quit(0)`）

**机制**

```ts
// lifecycle.ts:189-201
const next = spawn('/bin/sh',
  ['-c', 'sleep 2; exec python3 -c "import os,sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])" "$@"',
    'sh', process.argv[0], ...process.argv.slice(1)],
  { stdio: 'inherit' })
app.exitDiag('restart-spawned')
await new Promise<void>((resolve) => {
  let done = false
  const fin = (): void => { if (!done) { done = true; resolve() } }
  next.once('exit', fin)          // ← 完全不看 (code, signal)
  next.once('error', fin)
})
app.exitDiag('restart-successor-exited')
app.requestExit(code)             // ← 视为「重启完成」
```

后继进程链硬依赖 `python3`（`os.setsid()` + `os.execv()` 都写在 python 里）。仓库内 `python3` 只出现两处（`lifecycle.ts:190`、`term.ts:21`），README / REQUIREMENTS 从未声明该前置依赖。当 `python3` 不存在时：`/bin/sh` 执行 `exec python3 …` 失败 → sh 以 127 退出 → `next.once('exit', fin)` 立刻触发 → 代码把这次失败当作「后继已退出」→ `app.requestExit(code)` 让当前 dsh 正常退出。

用户可见结果：确认 `/restart` 后 TUI 关闭，**dsh 整个消失、没有任何后继进程**，终端回到 shell 提示符；原因只落在一行诊断日志（`app.exitDiag('restart-successor-exited')` / `restart-spawn-failed`，写进 `$DSH_HOME/nvim-tui-errors.log`），TUI 已经关闭所以不可能提示。同类失败还有 `spawn` 自身抛错（`/bin/sh` 缺失、EMFILE）——catch 里也只写日志，然后 `hard = setTimeout(() => process.exit(code), 2000)` + `requestExit(code)`，同样是「静默退出无后继」。

次要脆弱点（同一代码块）：`sleep 2` 在 `setsid()` **之前**执行，sh/sleep 仍留在前台进程组；用户在重启的这 2 秒里按 Ctrl-C，SIGINT 会打到整组（sh+sleep），后继链在 `python3` 启动前就死掉 → 与上面完全相同的「静默无后继」结局。

**复现路径**
1. 在无 `python3` 的容器/最小系统里（或 `PATH` 中临时移除 python3）跑 dsh-nvim-tui。
2. 输入 `/restart` → 确认。
3. 观察：进程退出、无新 dsh；`$DSH_HOME/nvim-tui-errors.log` 里只有 `restart-spawned` + `restart-successor-exited`。

**建议修法**
- `next.once('exit', (code, signal) => …)` 收状态：`code !== 0`（尤其 127）或 `signal !== null` 时**不得**当作成功——应恢复终端、在 stderr 直接打印原因（此时 `console.*` 已被劫持成 silent，必须 `process.stderr.write`），并以非 0 退出码结束，让用户看得见。
- 给后继链加前置探测：`spawnSync('python3', ['-c', 'import os,sys'])` 失败时改走不依赖 python3 的兜底（例如 `spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: 'inherit' })` + 由父进程负责终端的 `flushTtyInput/resetTerminalModes`，即 CHANGELOG 里记录过的旧方案），或至少在 TUI 关闭前给出提示。
- `sleep 2` 与 `setsid` 解耦：把 `os.setsid()` 作为后继链的第一步（例如 `python3 -c "import os,sys,time; os.setsid(); time.sleep(2); os.execv(...)"`），避免用户按键打死后继。

---

## 2. [bug / medium] `closeNvimWindow` 的「返回时子进程必死」保证没有被强制，`quit()` 却无条件启动后继

**位置**
- `src/kernel/lifecycle.ts:52-61`（三级 kill，最后一级之后没有 `alive()` 复检）
- 承诺：`src/kernel/lifecycle.ts:32-36` 注释「RETURNS ONLY AFTER the child is actually dead」
- 使用方：`src/kernel/lifecycle.ts:163`、`172-192`（`/restart` 后继 spawn）

**机制**

```ts
// lifecycle.ts:54-61
await Promise.race([exited, app.sleep(400)])
if (!alive()) return
try { child!.kill() } catch { }
await Promise.race([exited, app.sleep(800)])
if (!alive()) return
try { child!.kill('SIGKILL') } catch { }
await Promise.race([exited, app.sleep(500)])
// ← 函数在这里结束：没有任何 `if (alive())` 断言 / 抛错 / 诊断
```

前两级都有 `if (!alive()) return`，第三级（SIGKILL）之后**直接返回**。`quit()` 随后执行的正是这段注释明确警告过的动作：

```ts
// lifecycle.ts:165-171（注释）
// ... Spawning earlier let the old instance's terminal cleanup clobber
// the new instance's tui negotiation: the input box filled with
// literal kitty-protocol sequences ("[108;1:3u" garbage) and the
// frame/hint bar broke.
if (app.slices.runtime.restartPending) { … spawn 后继 … }
```

即：只要旧 nvim 在 500ms 内没有被 SIGKILL 掉（D 状态不可中断、极端负载下 SIGKILL 投递延迟、`child` 已被 `app.slices.runtime.child` 之外的人引用等），函数就带着「假死」的旧进程返回，后继 nvim 立刻在同一 tty 上协商——正是 CHANGELOG「/restart 终端抢占根修」记录过的那类乱码回归。SIGKILL 之后也没有任何诊断（`exitDiag('close-timeout')` 之类），事后无法定位。

**复现路径**（难以稳定构造，但可用注入法验证）
1. 临时把 `closeNvimWindow` 里的 `child!.kill('SIGKILL')` 注释掉，模拟「杀不死」的场景。
2. `/restart` → 观察新旧两个 nvim 同时持有终端、输入框出现 kitty 编码乱码。

**建议修法**
- 第三级之后补终局判定：`if (alive()) { app.exitDiag('close-timeout', child.pid); return false }`，把返回类型改成 `Promise<boolean>`；`quit()` 在 `restartPending` 路径上收到 `false` 时**放弃 spawn 后继**（并 stderr 提示「旧 nvim 未能退出，已取消重启」），而不是硬上。
- 顺带把「子进程死了但没清理 tty」与「子进程没死」区分开，后者才需要阻止后继。

---

## 3. [bug / medium] 退出清理预算自相矛盾：硬退出 2000ms 早于 2.5s 清理窗口，且小于 `closeNvimWindow` 自身最坏耗时

**位置**
- `src/kernel/lifecycle.ts:152-153`（`hardMs = restartPending ? 6000 : 2000`）
- `src/kernel/lifecycle.ts:163-164`（`closeNvimWindow()` → `Promise.race([teardown(), sleep(2500)])`）
- `src/kernel/lifecycle.ts:44-60`（`closeNvimWindow` 各段上限：250 + 400 + 800 + 500 = 1950ms）
- 文档承诺：`README.md:211`「退出（**清理有 2.5s 上限** + 强制兜底）」

**机制**

`quit()` 先把硬退出定时器挂上（2000ms，非 restart 路径），再串行执行 `extNodeCleanup/extFire` → `await closeNvimWindow()` → `await Promise.race([teardown(), sleep(2500)])`。时间轴（最坏情况）：

| 时刻 | 事件 |
|------|------|
| t=0 | `hard = setTimeout(process.exit, 2000)` |
| t≤1950 | `closeNvimWindow` 三段 race 全部超时（`qa!` 无响应 → SIGTERM 无响应 → SIGKILL 无响应/慢） |
| t≈1950 | 才开始 `teardown()`：`recordState` → **会话 flush** → 逐会话 `handle.dispose()`（注释自承「would wait for LLM retries (minutes)」） |
| t=2000 | `process.exit(code)` 硬杀 → flush/dispose 被截断 |

也就是说：**注释与 README 承诺的 2.5s 清理窗口在非 restart 路径上根本到不了**（只有 restart 路径给了 6000ms）。这正是 `teardown()` 里那段注释想要避免的「zstd 尾帧写一半」数据损坏风险（`docs/REVIEW-2025-09.md` 的 K4 提过同类问题，此处给出精确的预算账）。另外 `process.exit` 发生在 `closeNvimWindow` 未能杀死子进程时，会留下孤儿 nvim 占住 tty（与第 2 条同源）。

**复现路径**
1. 起一个长回合（LLM 卡住/工具重试）时 `/exit` → 确认。
2. 观察 `$DSH_HOME/nvim-tui-errors.log` 中 `quit` 之后无 `*-complete` 类记录，且 `~/.dsh/sessions/*` 尾帧可能缺失；或直接在 `teardown()` 开头 `appendFileSync('/tmp/t0')`、结尾再写一次，对比 2000ms 截断。

**建议修法**
- `hardMs` 至少 `≥ 2500 + closeNvimWindow 上限`（建议 `4500`，restart 路径保持更大），或把兜底改成「先 race 清理、再 race 硬退出」的两段式；`README.md:211` 与实现必须统一。
- 硬退出前若 `alive()` 仍为真，先补一次 `child.kill('SIGKILL')` 并 `exitDiag('hard-exit-orphan')`。

---

## 4. [bug / medium] 退出时的会话持久化 flush 链三重静默失败

**位置**
- `src/kernel/lifecycle.ts:95-116`
- 契约：`src/kernel/types.ts:195-209`（`SessionPersistenceService` 只有 `list/inspect/open/readRaw/locate/supportsRawArtifacts`，**没有 `flush`**）
- 宿主实现参照：`node_modules/@deepseek-ai/dsh-session/lib/index.js:1750-1767`（`SessionStore#flush(session)` 内部使用 `this.liveEntryFor/this.ctx`）

**机制**

```ts
// lifecycle.ts:100-115
let flushed = false
try {
  const legacyStore = app.runtimeCtx.get('sessions') as … { flush?: (s: unknown) => Promise<unknown> }
  if (typeof legacyStore?.flush === 'function') {
    for (const session of app.liveSessions.list()) {
      try { await legacyStore.flush(session) } catch {}     // (a) 每个会话失败都被吞
    }
    flushed = true                                          // (b) 即使全部失败也置真
  }
} catch {}
if (!flushed) {
  const svcFlush = (app.svc('sessionPersistence') as … { flush?: () => Promise<unknown> })?.flush
  if (typeof svcFlush === 'function') {
    try { await svcFlush() } catch {}                       // (c) 方法被脱 this 调用 + 失败无诊断
  }
}
```

三个独立缺陷叠加，且**整段没有任何 `app.exitDiag`**（对比同文件其它失败路径都有诊断）：

1. `flushed = true` 在逐会话循环**之后无条件**执行——循环里每个 `flush` 都被 `catch {}` 吞掉，所以「全部会话 flush 都失败」和「全部成功」走的是同一条路：跳过服务级兜底。
2. 服务级兜底把方法**取出来再调用**（`svcFlush()`），丢掉 `this`。dsh 的服务是 class 实例且实现里普遍使用 `this`（证据：`dsh-session` 的 `SessionStore` 注册为 `sessions` 服务，其 `flush(session)` 内部调用 `this.liveEntryFor(session)`）；一旦真走到这条分支且实现依赖 `this`，抛出的 TypeError 会被空 catch 吞掉，得到的仍是「什么都没 flush」。
3. 这条分支在 0.1.5 上大概率是死路径：`SessionPersistenceService` 并未声明 `flush`；而只要 `sessions` 服务在（当前 `dsh-session` 仍然注册 `sessions`），`flushed` 就已是 `true`，兜底永不执行。两个子情形都意味着：**「退出前落盘」这件事没有任何可验证的保证，也没有任何失败痕迹**。

**复现路径**
1. 在 `svcFlush` 分支插桩（临时 `appendFileSync('/tmp/flush-hit')`），用当前宿主跑 `/exit`：观察该分支是否被命中。
2. 把 `legacyStore.flush` 强制改成抛错（或用只读 session 目录制造 flush 失败），观察退出后没有任何日志/提示，且 `flushed` 仍为 true 导致兜底被跳过。

**建议修法**
- 逐会话 flush 统计成功数：`let ok = 0; … catch (e) { app.exitDiag('session-flush-failed', id, e) }`；只有 `ok === list.length` 才置 `flushed = true`。
- 兜底调用改为绑定形式：`await svc.flush()`（保持对象引用，不要先取方法），并 `catch (e) { app.exitDiag('persistence-flush-failed', e) }`。
- 在 `SessionPersistenceService` 类型里补上可选 `flush?(): Promise<unknown>`，如果宿主确实没有该 API 就删掉这条死分支并改由 `handle.dispose()` 承担（当前注释也是这么说的），避免「看起来有兜底、其实不会跑」。

---

## 5. [bug / medium] i18n：字典键与调用点大面积漂移，英文模式静默退回中文（并留下大量死键）

**位置**
- `src/kernel/i18n.ts:26-29`（`t()` 精确匹配：`return EN_DICT[zh] ?? zh`）
- 代表性命中：`src/kernel/i18n.ts:98` vs `src/sessions/commands/archive.ts:9`、`src/sessions/commands/sessions.ts:91`
- 死键代表：`src/kernel/i18n.ts:41`、`src/kernel/i18n.ts:76`、`src/kernel/i18n.ts:106`
- 必然查不到字典的调用点：`src/boot/session-events.ts:160-161`（模板字符串 + 插值）

**机制**

`t()` 是「zh 字面量作键、精确查表」，因此**调用点字符串只要有一个字符不同（哪怕只是服务名从 `workspaces` 改成 `workspaceRegistry`），翻译就静默失效**；`t(\`…${x}…\`)` 这种带插值的调用在数学上不可能命中字典。

用脚本对 `EN_DICT`（300 键）与全库 `t('…')` 调用点做集合差，结果：

- **142 / 300** 个字典键**全库无任何 `t()` 调用点**（死键）；
- **151** 个 `t()` 调用点的字符串**不在字典里**（英文模式原样显示中文）；
- 其中 2 处是模板字符串（`session-events.ts:160-161`），永远不可能命中。

已逐一复核的代表（不是统计噪声）：

| 字典侧 | 调用侧 | 结果 |
|--------|--------|------|
| `i18n.ts:98` `'归档不可用（workspaces 服务未装配）'` | `archive.ts:9` / `sessions.ts:91` `t('归档不可用（workspaceRegistry 服务未装配）')` | 键漂移：英文模式下仍是中文 |
| `i18n.ts:41` `'未知命令'` | `core.ts:479` `` app.notice(`未知命令 ${name || line}（/help 查看可用命令）`) `` — **且根本没包 `t()`** | 死键 + 未翻译 |
| `i18n.ts:76` `'无标题'` | `kernel/headless.ts:30`、`commands/commands/status.ts:15` 用的是 `'（无标题）'`（连字面量都不同，也没包 `t()`） | 死键 + 未翻译（本单元内即有一处） |
| `i18n.ts:106` `'上下文占用'` | `commands/commands/context.ts:28,38` 模板字符串未包 `t()` | 死键 + 未翻译 |

`i18n.ts:1-10` 的文件头把「未知键退回 zh」描述为「partial coverage degrades gracefully」，但实际不止是覆盖不全：**字典与调用点已经不同步，且没有任何机制能发现不同步**（没有测试、没有类型约束、没有 `t()` 的编译期键校验）。

**复现路径**
```bash
DSH_NVIM_TUI_LOCALE=en npm run smoke    # 或 /locale en 后执行 /workspace（未装配 workspaceRegistry 的 profile）
# 期望英文，实际仍是「归档不可用（workspaceRegistry 服务未装配）」
```
（本次审计用等价脚本复现集合差：解析 `EN_DICT` 键集 + 全库 `t('…')` 字面量集合求差。）

**建议修法**
- 短期：修正漂移键（`i18n.ts:98` 等），把 `core.ts:479 / context.ts:28,38 / status.ts:15 / headless.ts:30 / session-events.ts:160-161` 全部改成键稳定的写法（`t('未知命令') + ' ' + name` 形式的拼接，或先 `t()` 再插值），删除 142 个死键。
- 中期：把字典键做成类型（`const EN_DICT = {…} as const` + `type MsgKey = keyof typeof EN_DICT`，`t(zh: MsgKey)`），让漂移在 `tsc` 阶段暴露；再补一个「字典键 ↔ 调用点」双向对账的脚本进 `npm run check`。

---

## 6. [bug / low] headless dump 的失败兜底自身会抛，且两个调用点都用 `void` 丢弃 → 宿主 fail-loud 直接杀进程

**位置**
- `src/kernel/headless.ts:22-49`（try/catch；catch 里再 `writeFileSync`）
- `src/kernel/headless.ts:53-55`（`void dumpAndQuit()`）
- `src/boot/session-events.ts:317-320`（`.catch(...)` 里 `void headlessDump()`）
- 后果依据：`src/kernel/app.ts:573-576`（注释：alpha.4 起宿主对任何 unhandledRejection 直接 `process.exit`）

**机制**

```ts
// headless.ts:45-47
} catch (err) {
  writeFileSync(app.dumpPath, `# dump failed: ${(err as Error).message}\n`)   // ← 这里也可能抛
}
await app.quit(0)
```

`app.dumpPath` 来自 `config.dumpPath ?? DSH_NVIM_TUI_DUMP ?? /tmp/dsh-nvim-tui-e2e-<pid>.txt`（`app.ts:442`），完全由外部指定。若它指向不存在/不可写的目录（CI 里把 dump 写到只读挂载或已被清理的临时目录），第一段 `writeFileSync`（第 38 行）抛错进入 catch，catch 里的第二次 `writeFileSync` **同样抛错并逃出函数**；而两个调用点分别是 `void dumpAndQuit()` 和 `void headlessDump()`，没有 `.catch()` 兜底 → 产生 unhandled rejection → 按仓库自己的注释（`app.ts:573-576`），宿主 fail-loud 会 dispose 整棵树并硬退出：既没有 dump 文件，退出码也不是 e2e 预期的 0，诊断信息还只留在 errorLog 里。一个「诊断兜底失败」被升级成了进程级失败。

**复现路径**
```bash
DSH_NVIM_TUI_HEADLESS=1 DSH_NVIM_TUI_DUMP=/nonexistent-dir/dump.txt \
  DSH_NVIM_TUI_WATCHDOG_MS=1000 DSH_NVIM_TUI_PROMPT=hi node lib/index.js   # 或 npm run e2e 的等价调用
# 观察：进程以宿主 fail-loud 方式退出，无 dump 文件
```

**建议修法**
- catch 内部再包一层 `try { writeFileSync(...) } catch {}`（或先 `mkdirSync(dirname(dumpPath), {recursive:true})`），保证 `dumpAndQuit` **永不 reject**。
- 两个调用点改成 `.catch((e) => app.exitDiag('headless-dump-error', e))`；`dumpAndQuit` 内部末尾的 `await app.quit(0)` 也应包 try。

---

## 7. [bug / low] dispose 撞上 `await spawnNvim`：子 nvim 被孤儿化并占住 tty

**位置**
- `src/kernel/bridge.ts:112-138`（`spawnNvim` 把 child 交回调用方，自己不持有）
- 泄漏点：`src/boot/boot.ts:120-122`
  ```ts
  const spawned = await spawnNvim({ … })
  if (app.slices.runtime.disposed) return      // ← 这里返回，spawned.child 无人持有
  W(app.slices.runtime).child = spawned.child
  ```

**机制**

`closeNvimWindow()` 只能通过 `app.slices.runtime.child` 找到 nvim（`lifecycle.ts:38`），而 `runtime.child` 是在 `await spawnNvim(...)` **之后**才赋值的。若宿主在 `mkdtemp`+`writeFile`（`bridge.ts:68-74`）这段 await 期间 dispose 插件（`ctx.effect` 的 disposer → `app.teardown()`，见 `app.ts:596-608`；或启动期的信号 → `quit()`），boot 在第 121 行直接 return：**已经 spawn 出来的 nvim 进程没有任何引用，teardown 杀不掉它**。该进程 `stdio` 是 `inherit`（`bridge.ts:117`），于是它继续持有终端；当前进程退出后终端留给一个无主的 nvim，下一次启动再 spawn 第二个 nvim 抢同一个 tty——正是注释里反复强调的终端抢占/输入乱码场景。窗口很窄（毫秒级），但后果很脏，且修复成本极低。

**复现路径**
1. 在 `bridge.ts:68`（`mkdtemp` 之后）插 `await new Promise(r => setTimeout(r, 2000))` 拉宽窗口。
2. 启动后 1 秒内 `pkill -TERM` dsh（或让宿主 unload 该插件）。
3. 观察：`pgrep -a nvim` 仍有一个 nvim 存活并占有该 tty，dsh 已退出。

**建议修法**
- `spawnNvim` 增加「所有权移交」语义：要么让 `spawnNvim` 在返回前就把 child 写进 `app.slices.runtime.child`（把 app 传进去），要么在 boot 的 disposed 分支显式清理：`if (app.slices.runtime.disposed) { spawned.child.kill('SIGKILL'); return }`。
- 更稳妥：把 `spawnNvim` 的返回包在 `try/finally` 里，任何 boot 早退路径统一走一个 `killSpawned(spawned)`。

---

## 8. [missing-feature / medium] `subagent-clean` 宣称的截断清理不存在：0.1.5 上「清理」只剩隐藏，存储永不回收

**位置**
- `src/kernel/subagent-clean.ts:1-11`（文件头声明）
- 实际实现：`src/sessions/index.ts:112-147`（`cleanSubagentChain`）
- 相关导出：`src/kernel/subagent-clean.ts:23-31`

**机制**

文件头写的是：

```ts
// subagent-clean.ts:5-8
//  - expired settled chains are truncated via `sessionPersistence.truncateStored`
//    (keeps only the first event — the bulk of the stored chain is freed);
//  - cleaned ids are recorded in `$DSH_HOME/dsh-nvim-tui-subagent-clean.json`
```

但 `truncateStored` 在代码里**只出现在这条注释中**，全库没有任何调用：

```
$ grep -rn "truncateStored" src nvim scripts examples
src/kernel/subagent-clean.ts:6: *  - expired settled chains are truncated via `sessionPersistence.truncateStored`
$ grep -rn "\.truncateStored\|truncateStored(" --include=*.ts --include=*.js --include=*.lua . | grep -v node_modules
（无输出）
```

（仅 `docs/REVIEW-2025-09.md:163` 与 `CHANGELOG.md:539/546/1170/1256` 提到过它：CHANGELOG 记录该 API 曾在 alpha.5/rc.1 被移除、对应死分支已删除。）真正执行清理的 `cleanSubagentChain`：

```ts
// sessions/index.ts:119-133
if (persistence?.supportsRawArtifacts === true && app.liveSessions.get(childId) === undefined) {
  … writeFileSync(path + '.tmp', encodeHeaderOnlyLog(headerLine)); renameSync(path + '.tmp', path)
}
```

即：只有在**旧宿主**（`supportsRawArtifacts === true`，raw artifact 后端）才做物理重写；在当前 0.1.5 宿主上 `supportsRawArtifacts` 不为真，函数只剩「`workspaceRegistry.archiveSession` + 写本地账本」两件记账动作——思考链文件仍然完整留在磁盘上（同文件头自承「The dsh host persists settled child-session events forever and exposes no delete API」）。所以 `/subagents` 里的「🧹 清理全部已结束思考链」按钮的实际语义与用户预期（释放空间）不符：它只把行从列表里藏起来，**磁盘占用一点没少**。（`docs/REVIEW-2025-09.md:163` 在 v0.3.3 已记过同一处注释失实，本次复核仍未修，且给出了「0.1.5 上功能整体缺失」的结论。）

**复现路径**
1. 让某个父会话产生子代理（`subagent`/`workflow` 工具跑一轮），记录 `~/.dsh/` 下该 child 会话日志的字节数。
2. `/subagents` → 选「清理全部已结束思考链」→ 确认。
3. 再量字节数：不变（只有列表行消失、账本 JSON 多一条）。

**建议修法**
- 把 `subagent-clean.ts:5-8` 的文件头改为事实描述：0.1.5 上「隐藏 + 归档记账，不做物理截断（宿主不提供 API）」；`/subagents` 的确认文案（`subagents.ts:54`）同样要改口，避免让用户以为磁盘被回收。
- 若确实需要回收，走宿主公开面：`sessionPersistence.open(id,'write')` 的 `close()`/`truncate` 语义（若存在）或干脆提供「删除会话目录」的显式危险操作 + 二次确认，而不是继续维护一个只写着 `truncateStored` 的注释。

---

## 9. [risk / low] 未知 nvim 通知逐条同步写盘：无去重、无限速，日志可被外部输入打爆

**位置**
- `src/kernel/rpc.ts:31-35`
- 落盘实现：`src/kernel/lifecycle.ts:21-26`（`appendFileSync`）

**机制**

```ts
// rpc.ts:31-35
const entry = handlers.get(method)
if (entry === undefined) {
  app.exitDiag('unknown-notification', method)   // → appendFileSync(errorLogPath, …)
  return Promise.resolve()
}
```

`dispatchNvimNotification` 是 nvim→Node 通知的**唯一**入口（`boot.ts:195-198`：`nvim.on('notification', …)` 直接转交），方法名完全由 nvim 侧（含用户配置和任意第三方 Lua 插件）决定。任何未知方法都触发一次**同步**文件追加（`appendFileSync`，事件循环被阻塞），且没有去重/限速。一次版本错配（旧的 Lua bundle + 新的 Node bundle）或一个在按键回调里 `rpcnotify` 未知方法的插件，就能在输入热路径上持续做同步磁盘 IO，并把 `$DSH_HOME/nvim-tui-errors.log` 撑到无界（每次换行一条）。对比：本单元其它诊断路径（如 `exitDiag('quit')`）都是低频事件。

**复现路径**
```lua
-- nvim 侧
for i = 1, 20000 do vim.rpcnotify(ch, 'dsh-nonexistent-' .. i) end
```
然后观察 `$DSH_HOME/nvim-tui-errors.log` 行数与输入延迟。

**建议修法**
- 对未知方法做一次性集合去重：`const seenUnknown = new Set<string>()`，每个方法名只诊断一次；或按 N 秒窗口限速（令牌桶）。
- 诊断写入改为异步/批量（`appendFile` + 队列），至少不要放在通知热路径上同步阻塞。

---

## 10. [risk / low] `host-events` 的守护只覆盖同步 throw，注释宣称的「不会杀死宿主」对 async handler 不成立

**位置**
- `src/kernel/host-events.ts:30-39`
- 返回 Promise 的 handler：`src/commands/core.ts:679-703`（`approval/request`）、`src/commands/core.ts:709-731`（`user-questions/request`）
- 宿主派发语义：`node_modules/@deepseek-ai/cordis/lib/index.js:280-282`（`emit` 丢弃 listener 返回值）、`dsh-user-approval/lib/index.js:179`（approval 走 `waterfall` 且 `.then(…, () => 'unavailable')`）

**机制**

```ts
// host-events.ts:30-39
app.runtimeCtx.on(name, (...args: unknown[]) => {
  // A throwing handler must not kill the host (alpha.4 fail-loud turns
  // an unhandled rejection into process.exit) — diag-log and continue.
  try {
    return fn(app, ...args)          // ← 只保护同步 throw
  } catch (err) {
    app.exitDiag('host-event-error', name, …)
    return undefined
  }
})
```

注释明确以防「宿主 fail-loud」为目的，但 `try/catch` 抓不到 `fn` 返回的 promise 的 rejection。当前两个 async handler 恰好安全（宿主对 approval 用 `waterfall(...).then(…, () => 'unavailable')` 兜底；questions 的实现不在已安装包内，无法核验），而其它 host 事件（`agent/status`、`subagent/*`、`workflow/*`）的 handler 目前都写成同步函数——也就是说这条「保护」今天靠的是**调用方的纪律**，不是代码约束；同时 `teardown()` 会主动 `drainQuestions()` → `reject(new Error('UI torn down'))`（`commands/index.ts:178-183`），一旦某个 handler 由 `emit` 语义派发，rejection 就会变成 unhandled rejection 直接杀进程。

**复现路径**（构造性验证）
1. 临时把 `registerHostHandler('agent/status', async () => { throw new Error('x') })`。
2. 触发一次 agent 状态变更：同步 throw 会被记录，async throw 会冒到宿主；若该事件由 `emit` 派发则进程硬退出。

**建议修法**
- 守护改为 async 感知：`const r = fn(app, ...args); if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).catch((err) => { app.exitDiag(...) })`；或统一 `void Promise.resolve(fn(...)).catch(...)` 后再返回（注意 waterfall 语义需要原 promise，故推荐前者）。

---

## 11. [risk / low] 终端模式重置不全，且 kitty 关闭用的是「弹栈」而不是无条件清零

**位置**
- `src/kernel/term.ts:28-45`（`resetTerminalModes`，`\x1b[<u` 在 33 行）
- 调用点：`src/boot/boot.ts:96-97`、`src/kernel/lifecycle.ts:180-181`

**机制**

1. 关闭序列覆盖 `?1049l / <u / >4;0m / ?2004l / ?1004l / ?1002l / ?1003l / ?1006l / ?25h / 0m / ?1l`，但**缺 `?1000l`（普通鼠标跟踪，VT200）与 `?1005l`/`?1015l`（UTF-8/urxvt 鼠标编码）**。被 SIGKILL 的旧实例（正是本函数注释声称的目标场景）或其它 TUI 留下的 `?1000h` 会让新 nvim 收到点击转义序列并当作输入——与 `?1002/1003` 同类故障，注释里的「Reset the common modes」并不成立。
2. kitty 键盘协议关的是 `CSI < u`（**pop 一层栈**，`term.ts:33`），注释却写「kitty keyboard protocol OFF（the input-garbage root cause）」。pop 只在「栈里确实压着旧实例那一层」时才等价于关闭；栈为空时 kitty 规范规定为 no-op，栈里若有别的中间态则恢复到那个中间态（可能仍是 ON）。无条件关闭应使用 `CSI = 0 ; 1 u`（set flags=0）或 `CSI = 0 u`。
3. 末尾没有 `?1004l` 之外的焦点/括号粘贴遗漏检查——这两项已覆盖，无需改。

**复现路径**
1. 用一个会开 `?1000h` 的程序（或手工 `printf '\e[?1000h'`）后强杀，再启动 dsh：新 nvim 里点击会在输入框插入鼠标转义序列。
2. kitty/Ghostty 下强杀旧 nvim 两次（人为 nest 一次 push）后启动 dsh：`\x1b[<u` 只弹一层，键盘协议仍可能为 ON（按键显示为 `…u` 序列）。

**建议修法**
- 追加 `'\x1b[?1000l'`、`'\x1b[?1005l'`、`'\x1b[?1015l'`；把 `'\x1b[<u'` 换成/补充 `'\x1b[=0;1u'`（或连续多次 `\x1b[<u` + 最终 `=0;1u` 双保险），并同步修正注释措辞。

---

## 12. [deadcode / low] `encodeSessionLog` 的 events 编码分支没有调用方

**位置**
- `src/kernel/subagent-clean.ts:23-26`（`encodeSessionLog(headerLine, events)`）
- 唯一调用点：`src/kernel/subagent-clean.ts:29-31`（`encodeHeaderOnlyLog` → `encodeSessionLog(headerLine, [])`）
- 间接调用点：`src/sessions/index.ts:129`（`encodeHeaderOnlyLog(headerLine)`）

**机制 / grep 证据**

```
$ grep -rn "encodeSessionLog|encodeHeaderOnlyLog" src/
src/kernel/subagent-clean.ts:23: export function encodeSessionLog(headerLine, events) {…}
src/kernel/subagent-clean.ts:30:   return encodeSessionLog(headerLine, [])
src/sessions/index.ts:13:  import { encodeHeaderOnlyLog, readCleanedIds, writeCleanedIds } …
src/sessions/index.ts:129:  writeFileSync(path + '.tmp', encodeHeaderOnlyLog(headerLine))
```

仓库内 `encodeSessionLog` 的**唯一**调用点传入 `events = []`，因此 `events.map(JSON.stringify)` + `Buffer.concat` 的多帧分支从未被执行（也没有单测/脚本引用）。它同时出现在公共导出面（`src/kernel/index.ts:24` `export * from './subagent-clean.js'`，供外部消费者使用），所以「外部可能调用」无法用 grep 排除——但内部死分支性质成立：该路径既无调用方也无覆盖，且其存在暗示「保留首批事件」的语义（与 `encodeHeaderOnlyLog` 的实际用法矛盾，见第 8 条）。

**复现路径**
```bash
grep -rn "encodeSessionLog" src/ | grep -v "subagent-clean.ts"   # 无输出
```

**建议修法**
- 若确实没有「保留若干帧」的需求：删除 `encodeSessionLog` 的 `events` 参数（只留 header 编码），或把它降级为非导出的内部实现；同时给 `encodeHeaderOnlyLog` 补一个单测（zstd 帧可被宿主解码）。

---

## 附录 A：审计方法（可复核）

```bash
# 1) 通知面双向对账：Lua 发出的 dsh-* vs Node 注册的处理表
grep -rhoE "dsh-[a-z0-9-]+" nvim/lua/dsh_tui/*.lua | sort -u
grep -rhoE "registerNvimNotification\('[^']+'" src/ | sed "s/…//" | sort -u
#   结论：23 ↔ 23，1:1，无缺口/无死注册

# 2) i18n 覆盖率集合差（字典键 vs 全库 t('…') 字面量）
node --input-type=module -e "…解析 src/kernel/i18n.ts 的 EN_DICT 键集 + 遍历 src/**/*.ts 收集 t('…')…"
#   结论：字典 300 键中 142 无调用方；151 个 t() 键不在字典；2 处 t() 用模板串

# 3) 死代码判定
grep -rn "truncateStored" src nvim scripts examples                          # 仅注释 1 处（无调用点）
grep -rn "encodeSessionLog" src/                                            # 唯一调用传 []

# 4) 宿主语义核验
sed -n '280,282p' node_modules/@deepseek-ai/cordis/lib/index.js        # emit 丢弃 listener promise
sed -n '1543,1550p;1750,1767p' node_modules/@deepseek-ai/dsh-session/lib/index.js  # sessions 服务 flush 用 this
sed -n '179p' node_modules/@deepseek-ai/dsh-user-approval/lib/index.js # approval waterfall 失败兜底
```

## 附录 B：已存在但**未修**的旧问题（来自 `docs/REVIEW-2025-09.md`，本次复核仍成立，不重复计入条目）

- `bridge.ts:68-74`：每次 spawn 泄漏一个 `mkdtemp` 临时目录（scratch/socket/nvim-stderr.log），`closeNvimWindow` 后不清理；反复 `/restart` 会在 `/tmp` 累积。
- `lifecycle.ts:138/163`：`quit()` 路径 `closeNvimWindow()` 被调用两次（先 `quit()` 里关窗，`teardown()` 末尾再调一次；第二次为快速 no-op，无害但语义冗余）。
- `app.ts:444` / `apikey.ts:16` / `subagent-clean.ts:52` / `onboarding.ts:21`：`process.env.DSH_HOME ?? join(homedir(), '.dsh')` 用 `??` 而非 `||`，`DSH_HOME=`（空串）时全部退化成**相对路径**——账本/错误日志/引导标记会写进当前工作目录，onboarding 生成的指引也会打印出相对的 `.credentials.yaml` 路径。
- `headless.ts:53`：watchdog 定时器未 `unref()`（布防时机已在 boot 修好）。
- `boot.ts:126-129`：`console.log/warn/error` 进程级劫持后永不恢复（`rpc.ts:22`、`host-events.ts:22` 的覆盖告警在第二次 apply 后不可见）。

## 附录 C：核查过但**证据不足、故未列为问题**的点

- `host-events` 注册的 `workflow/*`、`subagent/*`、`agent/status` 事件在当前 node_modules 中找不到派发方，但 CHANGELOG 记录作者已实测这些事件面未变（`dsh-agent`/`dsh-scope` 的 invariant 里也能看到 `subagent/start|end`、`agent/status`），**不作为死代码**上报。
- `apiKeyConfigured`（`apikey.ts:32-46`）先查 `process.env` 再查 credentials seam，与函数头注释/CHANGELOG 描述的「seam → env」顺序相反；但两条路径都会被检查，实际只在「env 有值而宿主忽略 env（OAuth 类 provider）」时产生假阳性，且 `credentials` 服务实现不在已安装包内，**证据不足以定性为缺陷**；另 `keyRefForProvider` 对非内置 provider 用 `${ID}_API_KEY` 猜测，可能给出与宿主 `apiKeyEnv` 不一致的引用，同样因缺宿主侧证据未列条。
- `term.ts:18-24` `flushTtyInput` 依赖 `python3` 且用 `spawnSync` 阻塞事件循环，但仅在 boot/restart 两个低频点调用，影响面小于第 1 条，未单独列条。
