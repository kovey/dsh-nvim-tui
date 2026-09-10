# 审计报告：subagents-market-deps

> 审计对象（8 个必读文件，全部 `read` 全文读完）：
> `src/subagents/index.ts`、`src/subagents/commands/subagents.ts`、`src/market/index.ts`、
> `src/market/progress.ts`、`src/market/commands/market.ts`、`src/deps/index.ts`、
> `src/deps/services.ts`、`src/deps/commands/deps.ts`
> 版本：`dsh-nvim-tui 0.3.5` / 已适配 `dsh 0.1.5-rc.1`。
> 交叉验证：全仓 `grep` 调用方、`src/kernel/{app,types,profile,host-events,lifecycle}.ts`、
> `src/boot/session-events.ts`、`src/commands/{index,core}.ts`、`src/sessions/*`、
> `nvim/lua/dsh_tui/{popups,subagent_chat,init}.lua`、`scripts/{check-arch.mjs,smoke.ts}`、
> 宿主实现（`~/.nvm/.../lib/node_modules/@deepseek-ai/dsh/lib/{bin,plugin-*}.js` 与各 host 插件包）、
> 真实 profile（`~/.dsh/profiles/*/package.json`、`cordis.patch.yml`）。
> **全程只读，未修改任何源码；本文件为本次唯一新增文件。**
> 实测脚本均落在 `/tmp/tartest/`，未进入仓库。

结论摘要：market/deps 两条「自动化」主链路各有一处 high 级缺陷——`/deps install` 在本机/标准 profile
安装拓扑下**恒为空操作**（F1），`/market` 的入口自修复链在候选源全失败时会把插件**留在已卸载状态**
却报告「已安装」（F2）。其余为中等/低的误判、泄漏、数据丢失与文档漂移。

---

## 1. [bug / high] `/deps install` 在本机实测为恒空操作：`packageExists` 的「dsh 安装根」永远解析不到宿主包所在目录

**位置** `src/deps/services.ts:144-173`（`findInstallRoot` 148-157、`packageExists` 159-173），消费点 `:328-331`；测试绕过点 `scripts/smoke.ts:1771-1776`

**机制**

```ts
// services.ts:148-157
const findInstallRoot = (): string | undefined => {
  let dir = dirname(fileURLToPath(import.meta.url)) // lib/deps
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'node_modules'))) return dir   // ← 第一个「有 node_modules 的祖先」就返回
    const parent = dirname(dir); if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}
// :165-169 只探两处
const candidates = [
  join(installRoot, 'node_modules', rel),
  join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', rel),  // ← 要求 root 是 <dsh全局根>/lib
]
```

walk-up 在**首个**含 `node_modules` 的祖先停止。本机真实拓扑（`ls -la` 证据）：

- profile 依赖是链接：`~/.dsh/profiles/nvim-tui/package.json` → `"dsh-nvim-tui": "link:/Users/zhangyong/workspace/deepseek/neovim-tui"`，`~/.dsh/profiles/nvim-tui/node_modules/dsh-nvim-tui -> ../../../../workspace/deepseek/neovim-tui`。ESM 解析 realpath ⇒ `import.meta.url` 落在仓库 ⇒ `installRoot = /Users/zhangyong/workspace/deepseek/neovim-tui`（仓库 `node_modules/@deepseek-ai` 只有 cordis/dsh-agent/dsh-llm… 等 peer，**没有任何** ROW_TEMPLATES 包）。
- 即使是 pnpm 常规安装（包体在 `<profile>/node_modules/.pnpm/...`），walk-up 也停在 **profile 目录**（`existsSync(<profile>/node_modules)` 为真），而 `@deepseek-ai/*` 宿主插件并不在 profile 的 node_modules（`ls -d ~/.dsh/profiles/nvim-tui/node_modules/@deepseek-ai` → `No such file or directory`；profile manifest 只声明 dsh-context/dsh-feishu/dsh-nvim-tui）。
- 这些包真实位置在 **dsh 全局安装内部**：`~/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`（11 个模板包全部 present，已逐个 `ls` 验证）。candidate#2 正是为这种嵌套布局写的，但它要求 `installRoot = <…>/node/vX/lib`，而 walk-up 从 profile/仓库出发**永远到不了那里**。

**实测（用仓库编译产物，与 src 该函数逐行一致，已 diff）**

```
$ node --input-type=module -e "import { packageExists } from '…/neovim-tui/lib/deps/services.js'; …"
--- no env override (runtime behaviour) ---
@deepseek-ai/dsh-agent-presets        -> false
@deepseek-ai/dsh-workspace            -> false
@deepseek-ai/dsh-host-plugin-inventory-> false
@deepseek-ai/dsh-tool-subagent        -> false
@deepseek-ai/dsh-session-query-sqlite -> false
--- with DSH_NVIM_TUI_INSTALL_ROOT=/…/node/v24.18.0/lib (smoke 的注入口径) ---
@deepseek-ai/dsh-agent-presets        -> true   （5/5 全部 true）
```

**复现路径** `/deps` → 「可一键装配 N 项」→ `/deps install` → 「全部缺失项(N 项)」→ 逐条
`跳过 X: 包 … 不在当前 dsh 安装中（升级 dsh 后重试）`（`services.ts:328-331`），最终
`appended.length === 0` → `没有可写入的行`（`:338-341`）→ **一行都不写、不重启、功能等于没做**。
`app.notice` 落 `activeFeed()`（`kernel/app.ts:546`），所以用户看到的是每个目标各一行
`跳过 X: 包 … 不在当前 dsh 安装中（升级 dsh 后重试）`（10 个 `host()` 项 + 可能的 `search-override`，
逐个 `notice`，见 `services.ts:234-253`）。

**为什么测试没抓到**：`findInstallRoot` 未导出，`scripts/smoke.ts:1771-1776` 自己拼了一个
`~/.nvm/versions/node/<ver>/lib/node_modules/@deepseek-ai` 探测路径并**注入 `DSH_NVIM_TUI_INSTALL_ROOT`**
再断言 `packageExists(...) === true`——即测试用环境变量替换掉了被测逻辑；产品侧没有任何地方设置该变量
（`grep -rn DSH_NVIM_TUI_INSTALL_ROOT src/` 只有 `services.ts:161` 读它）。

**建议修法**（任一即可，建议同时做 ①②）
① 用宿主侧的真实安装根替换 walk-up：`createRequire(import.meta.url)` 在宿主包内不可用时，取
`realpath(which dsh)` → `<global>/lib`，或直接在 `dsh` 包内 `require.resolve('@deepseek-ai/dsh-base/package.json')`
（`@deepseek-ai/dsh/node_modules` 是宿主插件唯一权威位置）；把该根做成候选列表逐个探测
（`installRoot` 候选集：`<global lib>`、`<profile>`、`<repo>`）。
② 探测失败时**不要静默跳过**：把「根不可解析」与「包不存在」区分开，前者应照常写行（让 loader 报真实错误）
或降级为提示「无法自动判定安装根，请手动确认后重试」，而不是用一句「升级 dsh 后重试」把功能藏起来。
③ 给 `findInstallRoot` 加导出 + 一个「无 env 注入」的回归测试，堵住 smoke 的绕过。

---

## 2. [bug / high] `/market` 入口自修复链先 `remove` 再 `add`：候选源全失败时插件被留在「已卸载」，却报「已安装但入口缺失」

**位置** `src/market/progress.ts:578-613`（remove 602 / add 603 / 终局 611），调用方 `src/market/commands/market.ts:194-196`

**机制**

```ts
// progress.ts:598-613
for (const c of candidates) {
  if (runs.has(c.spec) || c.spec === spec) continue
  await runPluginCliP(profileName, ['remove', missing], pg)        // ① 先卸载（返回值完全不看）
  const r = await runPluginCliP(profileName, ['add', c.spec], pg)  // ② 再装候选源
  runs.add(c.spec)
  if (r.code === 0 && installedMainMissing(profileName, c.spec) === null) { …return true }
  pg.log(`✗ ${c.label} 安装后仍未通过校验`)                          // ③ add 失败：不回落、不重装原 spec
}
pg.bar('⚠ 已安装但入口缺失（建议反馈给插件作者）')                     // ④ 状态描述失真
return false
```

失败语义：候选 `add` 失败（网络/404/allowBuilds 被拦，`dsh plugin` 只把 pnpm 结果透传，见
`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js` 的 `runPlugin`）时，① 的 `remove` **已经生效**：profile
`package.json` 里该依赖消失、`dsh.profile.bundles` 也被 `reconcilePlugins` 摘掉（同一文件 `:47-110`），
而 ④ 却告诉用户「已安装」。下一轮 `remove` 找不到包（静默），循环结束后 profile 处于「插件已卸载」的半损状态；
若候选源指向 npm 发布版，用户还会以为装的是源码版。另外 `remove` 的退出码从未检查（连日志都没有）。

**串联放大**：`market.ts:194-196`

```ts
await installWithRepair(app, entry, profileName, spec, pg)   // 返回 boolean
pg.close(1500)
app.notice(`${entry.name} 安装流程结束（结果见进度窗；多数插件重启 dsh 后生效）`)
```

`installWithRepair` 的返回类型是 `Promise<void>`（`progress.ts:617-623`），内部 `verifyOrRepairMain(...)`
返回的 boolean 只在 `:636`、`:695` 两处被原地丢弃、从不外传 ⇒ 调用方**在类型上就不可能**知道成功/失败/半损，
于是 `market.ts:194-196` 无论哪种结局都只打同一句「流程结束」；用户只能从进度窗（1.5s 后自动关闭，
`progress.ts:539-541`）逐行看日志。

**复现路径**：`/market` → 选一个只有源码（无 npm 发布版、无 `tarball`）的插件 → 安装成功但入口缺失
（pnpm≥10 拦 `prepare`）→ 自动修复链进入 `/dsh plugin remove <pkg>` → `/dsh plugin add <npm spec>`；
断网或 npm 404 ⇒ 插件从 profile 消失，界面显示「已安装但入口缺失（建议反馈给插件作者）」。

**建议修法**
① 候选安装失败时**回滚**：重新 `add <原 spec>`（或在 remove 前先 `add` 候选、成功后再 remove 旧 spec，
即先装后卸）；② `remove` 的退出码必须检查并记日志；③ 终局文案按真实状态分叉
（`已换源失败并回滚` / `已卸载且未能重装（profile 已回退：请重跑 /market 安装）`）；
④ `installWithRepair` 的布尔结果在 `market.ts` 里必须消费（成功/失败/半损三种 notice），
并延长 `pg.close` 或把结论写进聊天区（`app.notice`）。

---

## 3. [bug / medium] `installedMainMissing` 只认 `main`（默认 `index.js`）：`exports`-only 的包被判「缺入口」，进而触发破坏性换源

**位置** `src/market/progress.ts:439-456`

```ts
const manifest = JSON.parse(readFileSync(join(dir,'node_modules',pkgName,'package.json'),'utf8')) as { main?: string }
const main = manifest.main ?? 'index.js'
if (!existsSync(join(dir, 'node_modules', pkgName, main))) return pkgName   // ← 只按 main 判定
} catch { return pkgName }                                                  // ← 任何读取失败也判「缺」
```

**机制**
- 现代 ESM-only 包普遍只声明 `exports`（`{"exports":{".":"./lib/index.js"}}`，Node 完全合法且 `main` 可缺省）。
  这类包 `main === undefined` ⇒ 探测 `<pkg>/index.js` ⇒ 不存在 ⇒ 返回 `pkgName`（「缺入口」）。
- 调用者把这个返回值当成**健康度结论**：`progress.ts:588-596` 打印「⚠ 缺少入口文件 → 自动寻找可用的预构建包」，
  随后进入 F2 的 `remove` + 换源链。即一次**误判**会升级成一次 profile 改动（换源/卸载）。
- `catch { return pkgName }` 让「读不到 manifest」（路径拼错、权限、pnpm 布局差异）与「确实缺入口」
  得到同一结论——默认答案是「坏」，这是危险方向。

**复现思路**：让 profile 装一个 `main` 缺省、只有 `exports` 的插件（或临时把某插件的 `main` 改名以观察），
`/market` 安装该插件 ⇒ 安装成功后立即出现「⚠ 缺少入口文件」，随后进入换源链。

**建议修法** 判定顺序改为：`exports` 存在时用 Node 自己的解析（`createRequire(profilePkgJson).resolve(pkgName)`
或 `import.meta.resolve`）验证入口是否真的可解析；无法解析时按 `exports`/`main`/`module`/`types` 多字段回退；
「manifest 读取失败」必须与「入口缺失」区分（返回 `'unknown'`），`unknown` 时只提示、不进入换源/卸载链。

---

## 4. [bug / medium] `installedMainMissing` 的 spec→包名模糊匹配：URL/tarball spec（或作用域名不在 URL 中）匹配不上，`pnpm remove <URL>` 静默失败 + 健康安装被误报

**位置** `src/market/progress.ts:440-446`（匹配）、`:602`（消费）

```ts
let pkgName = depKey
if (!installed.deps.has(depKey)) {           // depKey 常常是 URL/git/name@version spec，必然不在 deps 键里
  for (const key of installed.deps.keys()) {
    if (key.includes(depKey) || depKey.includes(key)) { pkgName = key; break }   // ← 纯子串启发
  }
}
```

**机制** `readInstalledPlugins`（`:237-252`）的 `deps` 键是 package.json 的**依赖名**（pnpm 用包名做键，
值才是 spec），而这里传入的 `spec` 来自 `market.ts:178`（`installSpec(entry)` = `repoRoot(url)` 或 `entry.tarball`），
是 URL。子串匹配只在「包名恰好是 URL 的子串」时成立：

- 命中（常见）：`spec=https://github.com/deepseek-ai/dsh-context`，key=`dsh-context` → `depKey.includes(key)` 真。
- 落空：`entry.url=https://github.com/foo/bar` 而包名是 `@foo/dsh-bar`（registry 的 `name:` 与包名不同，
  且 `parsePluginYaml` 的 `name` 取自 yaml/文件名，见 `:79-95`）⇒ 两条 includes 都为假 ⇒ `pkgName` 保持原 URL ⇒
  `join(dir,'node_modules','https://github.com/foo/bar','package.json')` 抛错 ⇒ `catch { return pkgName }` ⇒
  「缺入口」。

于是链路变成：安装**成功**的插件 → 报「⚠ 缺少入口文件（https://github.com/foo/bar）」→
`runPluginCliP(profileName, ['remove', 'https://github.com/foo/bar'])`（pnpm 找不到该依赖名，非 0 退出，
**代码不看退出码**）→ 再 `add` 候选（npm spec 若与首次解析相同会被 `c.spec === spec` 跳过 ⇒ `candidates` 为空 ⇒
一条都不试，直接落到 F2 的 ④「已安装但入口缺失」）。用户看到的是一个健康插件的假缺陷报告。

**建议修法** 不要在 spec 上做子串匹配：改为从 profile `package.json` 的 **键值对反向索引**
（`value` 归一化后与 spec 全等/前缀相等即得其 `key`），或直接读安装后目录（先 `pnpm list --json` /
遍历 `node_modules/*/package.json` 的 `name`）。匹配不到时返回 `'unknown'`（见 F3 修法），
绝不用 URL 当包名去 `remove`。

---

## 5. [bug / medium] 子代理会话读取句柄在 `handle.read()` 抛错时泄漏（视图与对话两条路径重复同一段）

**位置** `src/subagents/index.ts:38-56`（`openSubagentView`）与 `:124-142`（`openSubagentChat`，逐行重复）

```ts
try {
  const persistence = app.svc('sessionPersistence')
  if (typeof persistence?.open === 'function') {
    const handle = await persistence.open(childId, 'read')          // 拿到读句柄
    const result = handle === undefined ? undefined : await handle.read?.()   // ← 这里抛错
    events = (result?.events ?? []) as SessionEvent[]
    if (handle !== undefined) { try { await handle.close?.() } catch {} }     // ← 只有成功路径才 close
  } else { … }
} catch (err) {
  app.notice(`读取子代理会话失败: ${(err as Error).message}`)
  return                                                            // ← 直接 return，句柄未释放
}
```

**机制** `handle.read()`（损坏日志 / 读配额 / I/O 错误 / 宿主校验收紧）reject 时控制流跳到外层 catch，
`handle.close()` 永不执行；handle 是 0.1.5 的 **open('read') 读句柄**（注释自述「open a read handle,
read the validated log, close the handle」，`:41`、`:127`），其底层是文件描述符/存储锁。
每次失败打开（用户在 `/subagents` 里对同一个损坏子代理反复回车即可）泄漏一个；fd/锁累积到上限后
后续所有会话读取（含 `/rewind`、`/trajectory`、子代理回放）都开始失败。同一段代码被复制两份，
修一处不修另一处会留下同样的洞。

**复现思路** 让一个子会话日志不可读（例如手工截断/损坏该 session 的存储文件，或断点命中 `read()` 抛错），
`/subagents` → 选中它 → 「查看思考链回放」/「打开对话窗口」各重复 N 次，观察 `lsof -p <runner-pid> | wc -l` 单调增长。

**建议修法** 用 `try { … } finally { await handle?.close?.().catch(()=>{}) }`（把 open 放在 try 外、
close 放进 finally），并把这段抽成一个 `readChildEvents(app, childId): Promise<SessionEvent[]>` 帮助函数，
两条路径共用（顺便消除重复代码）。

---

## 6. [bug / medium] 运行 profile 的 `cordis.patch.yml` 不存在时，`findProfilePatchPath` 回退成目录扫描 → `/deps install` 可能写进**另一个 profile**

**位置** `src/deps/services.ts:86-112`

```ts
const running = runningProfileName(app)
if (running !== undefined) {
  const patch = join(profilesDir, running, 'cordis.patch.yml')
  if (existsSync(patch)) return patch        // ← 只有「文件已存在」才认运行 profile
}
try {
  for (const name of readdirSync(profilesDir)) {           // ← 否则按 readdir 顺序挑第一个
    … if ((pkg.dsh?.profile?.bundles ?? []).includes('dsh-nvim-tui')) return join(profilesDir, name, 'cordis.patch.yml')
  }                                        // ↑ 这里返回的路径不检查存在性，appendFileSync 会直接创建
} catch {}
```

**机制** 运行 profile 的 patch **不存在**是完全正常的（patch 是用户覆盖层；`dsh-nvim-tui` 自带的
`cordis.patch.yml` 是 bundle 层，二者不同）。此时 `running` 明明已解析出来（`kernel/profile.ts` 文档也强调
它是权威），却被当成「未解析」并退化到目录扫描——扫描取的是 `readdirSync` 顺序里第一个 bundle 了
`dsh-nvim-tui` 的 profile。本机**同时存在两个**这样的 profile：
`~/.dsh/profiles/nvim-tui/` 与 `~/.dsh/profiles/tui/`（均已 `grep` 验证 `package.json` 含 `dsh-nvim-tui`）。
⇒ 在 `tui` profile 中运行、且该 profile 首次使用（无 patch）时执行 `/deps install`，行会被写进
`~/.dsh/profiles/nvim-tui/cordis.patch.yml`：当前进程的 loader 不会看到任何变化（HMR 不触发），
`waitFixLive` 6s 超时 → 还会**自动重启 dsh**（`:354-361`），重启后依然什么都没装配，而且污染了另一 profile 的配置。
注意 `market.ts:19-26` 的注释明确把「写别的 profile」列为禁止项，deps 这里与之相矛盾。

**复现思路** `mv ~/.dsh/profiles/<running>/cordis.patch.yml{,.bak}` → 在 `<running>` profile 内 `/deps install`
→ 打开 `~/.dsh/profiles/nvim-tui/cordis.patch.yml`（另一个 profile）检查是否多出 `# [dsh-nvim-tui /deps] 自动装配行`。

**建议修法** `running` 解析成功即直接返回 `join(profilesDir, running, 'cordis.patch.yml')`（不要求文件存在——
`appendFileSync` 会创建；deps 的 `dshHome()` 目录也保证存在）；目录扫描只用于 `running === undefined`
的 loader-less 场景，且扫描到多候选时应报错/让用户选择，而不是取第一个。

---

## 7. [risk / medium] `readPatch` 任何读失败都返回 `''`，而 toggle 分支会用它**整文件重写** `cordis.patch.yml`（用户 patch 静默清空）

**位置** `src/market/progress.ts:274-277`（读）、`:335-338`（整文件写）+ `src/market/commands/market.ts:70,137-148`

```ts
// progress.ts:274-277
export function readPatch(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }   // ← EACCES/EIO/EMFILE 与 ENOENT 同待遇
}
// market.ts:70 → :145-146
const patchText = readPatch(patchPath(profileName))
const next = setDisabledRows(patchText, toggles)     // '' 时只回吐出 toggle 行
writePatch(patchPath(profileName), next)             // writeFileSync(path, text) —— 覆盖整文件
```

**机制** `writePatch` 是**全量覆盖**（`writeFileSync`），不追加。只要 `readPatch` 因非 ENOENT 的原因失败
（权限被改、磁盘/句柄瞬时错误、文件被换成目录外的挂载点等），`patchText` 变成 `''`，随后的热启停
（「启用/停用（热切换，HMR 免重启）」`market.ts:125,137-148`）就会把用户 patch 里所有内容一次性抹掉：
`/deps` 写入的 11 行 insert 装配、`session-query-sqlite` / `compaction-basic` 覆盖行、dsh-feishu 的凭据/config、
用户手写注释全部丢失（本机真实 patch 共 5410 字节、含 5 处 `- insert:` 与 2 处覆盖行，已 `cat` 验证）。
仓库自己的注释也承认 insert 是纯追加语义、重复 id 会抛错，所以这种丢失是「静默降级 + 难恢复」。

**建议修法**
① `readPatch` 区分 ENOENT（返回 `''`）与其他错误（抛出或返回 `null`），`market.ts` 在 `null` 时中止 toggle
并提示「patch 读取失败，已取消写入（避免覆盖）」；② `writePatch` 改为
「写临时文件 + `renameSync` 原子替换」，并在覆盖前把原文件备份为 `cordis.patch.yml.bak-<ts>`（`progress.ts:651-654`
已有同类备份习惯）；③ 校验写回内容：若原文非空而新文明显更短（例如丢掉了所有非 managed 行），拒绝写入。

---

## 8. [risk / medium] `runPluginCliP` 的 5 分钟「硬超时」只发 SIGTERM、无 SIGKILL/竞速兜底，且用 `'exit'` 而非 `'close'` 收尾 → 流程可永久挂起 / 尾日志截断

**位置** `src/market/progress.ts:545-576`

```ts
const killer = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 5 * 60_000)   // 只 SIGTERM
…
child.on('exit', (code) => {                                    // ← 'exit' 早于 'close'
  clearTimeout(killer)
  if (code === null && child.killed) pg.log('dsh CLI 超时已终止')
  resolve({ code, tail: out })                                  // ← 尾日志可能还在 pipe 里
})
```

**机制**
- 注释自述「A wedged CLI (lock wait / hung network / interactive prompt) must not hang the progress float
  forever: hard-stop after 5 minutes」，但实现只有一次 SIGTERM：pnpm 等待交互提示、被锁文件阻塞、
  或对 SIGTERM 有自定义处理的进程都会继续存活，`resolve` 永不触发 ⇒ `await installWithRepair(...)`
  永久 pending ⇒ 进度窗（`close` 从未调用）与 `/market` 命令会话永久卡住（用户无法再执行别的 market 操作）。
- `'exit'` 在 stdio 尚未排空时即触发：`tail`（失败分类的**唯一**输入，`classifyPnpmError(r.tail)`）可能截断，
  导致诊断/换源判断基于半行日志。`child.killed` 只表示「kill 被调用过」，不是「因超时被杀」。

**建议修法** SIGTERM 后给 5s 宽限再 `SIGKILL`；用 `Promise.race` + 兜底 resolve（`{ code: null, tail, timeout: true }`），
并在 `'close'`（而非 `'exit'`）里 resolve/清 timer；把超时事实写进返回结构，让上层提示「CLI 超时，结果未知，请手动检查 profile」。

---

## 9. [missing-feature / medium] 提示宣称「/subagents 可取消」但没有任何取消实现：pending 寻址会静默把下一条输入发给子代理

**位置** `src/subagents/commands/subagents.ts:73-76`（提示文案），状态写入者全集见下

```ts
W(app.slices.agent).pendingSubagentFollowup = { childId: sel, label: … }
app.notice(`下一条输入将发给子代理 …（/subagents 可取消，直接输入即发送）`)   // ← 「/subagents 可取消」不存在
```

全仓 `grep -rn pendingSubagentFollowup src/` 的**全部**写入点：

| 位置 | 动作 |
| --- | --- |
| `subagents/commands/subagents.ts:74` | 置位（「继续对话」） |
| `subagents/index.ts:241` | 装配默认值 `null` |
| `subagents/index.ts:155` | 打开对话窗时清空 |
| `subagents/index.ts:275` | 关闭对话窗的 nvim 通知里清空 |
| `commands/core.ts:190-192` | 消费（下一条输入发给子代理后清空） |
| `commands/index.ts:189-194`（`clearPendings`） | 仅在 `sessions/services.ts:205-212`（`switchTo`）被调用 |

⇒ 再次执行 `/subagents`（无论选「查看思考链回放」还是别的）都**不会**清掉寻址；唯一退路是切会话
（`switchTo` 会清并提示「未完成的输入操作已取消」）、打开对话窗、或把消息真的发给子代理。
实际后果：用户用 `/subagents → 继续对话` 后改主意，又跑了一次 `/subagents` 只是回放了一个链，
接着输入的正常提问会被 `commands/core.ts:190-201` 直接转发给子代理（主会话看不到这条消息），
只有状态栏的 `⇢ <label>`（`statusline/index.ts:263-264`）暗示当前寻址对象。

**建议修法** 二选一：① 在 `subagentsCommand` 入口清空 `pendingSubagentFollowup`（并 notice「已取消子代理寻址」），
与提示文案一致；② 给命令加显式子命令（`/subagents cancel`）或在 picker 顶部提供「✕ 取消子代理寻址」行。
另建议在 `subagent/end`（`subagents/index.ts:317-326`）对「非 continuable 的目标」也清一次寻址，避免消息发向已终结的子代理。

---

## 10. [bug / low] `/deps` 的 pnpm 探测用 `stdio:'ignore'`，版本号恒为空（实测 `stdout === null`），且同步阻塞事件循环最长 5s

**位置** `src/deps/services.ts:283-290`

```ts
const pnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore', timeout: 5000 })
…
detail: pnpm.status === 0 ? `pnpm ${String(pnpm.stdout ?? '').trim()}（/market 安装器可用）` : …
```

**实测**（本机）

```
$ node -e "const{spawnSync}=require('child_process');const r=spawnSync('pnpm',['--version'],{stdio:'ignore',timeout:5000});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}))"
{"status":0,"stdout":null,"stderr":null}
```

⇒ 报告永远渲染成 `✓ pnpm — pnpm （/market 安装器可用）`（版本位为空），无从判断 pnpm 版本是否
满足 `dsh plugin`（pnpm≥10 的 allowBuilds 行为差异正是 market 误报的根源之一）。

**附带**：`spawnSync` 是**同步**调用，卡在 TUI 主线程上，超时上限 5s ⇒ `/deps` 在 pnpm 启动慢/卡住时
会冻结整个界面（repl/渲染/spinner 全停）最长 5s；`/deps` 是只读体检命令，不值得这个代价。

**建议修法** `stdio: ['ignore','pipe','ignore']` 读取版本（或解析 `pnpm --version` 用 `execFile` 异步版），
并把 `status === 0` 的字符串改成 `pnpm v${ver}`；异步化后可顺带把探测放进 `Promise.all` 与其它检查并发。

---

## 11. [risk / low] `/deps install` 的幂等去重只看 patch 文件，而宿主 loader 对**跨层**重复 id 直接抛错

**位置** `src/deps/services.ts:316`（`const ids = readPatchRowIds(patchPath)`）、`:327`（`if (ids.has(rowId)) skip`）、`:345`（写 `- insert:` 块）

**机制** `readPatchRowIds` 只解析**用户 patch**；`ROW_TEMPLATES` 的装配方式却是 `- insert:`（纯追加语义）。
仓库自己维护的真实 patch 文件头把这一风险写得很清楚（`~/.dsh/profiles/nvim-tui/cordis.patch.yml:6-9`）：

> 注意：insert 是纯追加语义，loader 不去重（EntryGroup.update 对重复 id 直接抛 "duplicate loader entry id"）。
> …dsh-base 已自带 storage/storage-json/storage-domain 三行，patch 不得再重复 insert。

而 `checkAll` 判「缺失」的依据是**服务是否 live**（`svcOk`，`:221-232`），不是「行是否存在」：一旦某行已由
bundle 层（如 `dsh-base` 新版）提供、但其服务因依赖缺失没起来，`host()` 会给出 `fixId`，`ids.has(rowId)`
为假（因为 patch 里没有该 id），`/deps install` 就会追加一条同 id 的 `insert` ⇒ loader 抛
`duplicate loader entry id`，HMR/重启都可能直接失败（比不装配更糟）。
产品内其实已有精确判据可用：`market.ts:72-73` 就在读 `app.svc('loader')?.entries()`。

**建议修法** 追加前同时检查 `loader.entries()` 里是否已存在该 `id`（或 `options.name` 相同的行）：
存在则跳过并提示「该行已由 bundle 层提供，服务未就绪的原因在别处（看 restart/日志）」；
把「服务未 live」与「行不存在」两种缺失在 `DepReport.detail` 里分开，避免误导用户一键装配。

---

## 12. [missing-feature / low] `src/market/index.ts` 模块头注释与实现漂移：宣称持有 progress float 驱动 / CLI runner / 修复链，实际只剩一行命令装配

**位置** `src/market/index.ts:1-19`

```ts
/**
 * dsh_tui plugin-market module: the live progress float driver, the `dsh
 * plugin …` CLI runner with the install diagnosis/repair chains, and the
 * /market command (catalog browser, install / update / uninstall / toggle).   ← ①②③ 都不在本文件
 */
…
/** /market [关键词 | refresh] — plugin marketplace: curated awesome-dsh-plugin
 *  catalog sorted by GitHub stars (desc), with install / update / uninstall
 *  through the official `dsh plugin` CLI. */                                  ← 孤儿注释：后面紧跟另一个 doc
/** Live progress float driver: streams log lines + a bottom bar into the
 *  enable/disable through the profile patch layer (HMR, no restart). */      ← 描述的是热启停，不是本函数
export function installMarketInstall(app: App): void { installMarketCommand(app) }   // 唯一实体
```

**机制** 实际实现在 `src/market/progress.ts`（其文件头 `:1-16` 自称「Plugin marketplace data layer」，
但里面同时住着 `openProgress`/`runPluginCliP`/`verifyOrRepairMain`/`installWithRepair` 与所有 patch/lock 修复逻辑），
README:484-485 也把它描述为「market/ index.ts + progress.ts（数据层 + 安装进度 UI）」。
⇒ 三个文件（index.ts 头注释、progress.ts 头注释、README 模块表）对同一模块的职责描述互不一致，
`installMarketInstall` 的 doc 说的是「热启停 HMR」，读者按注释去 index.ts 找安装修复链会一无所获
（本次审计的「市场抓取与安装修复链」全在 progress.ts）。注释声明的 `/market [关键词 | refresh]`
还漏了已实现的 `update-all`（`market.ts:42-53`，README:241 有写）。

**建议修法** 修 `src/market/index.ts` 头部为「模块装配入口：只注册 /market 命令；数据层与安装链在
`progress.ts`」，删除孤儿注释，把 `installMarketInstall` 的 doc 改为真实职责；同步把注册的
`usage` 改成 `[关键词 | refresh | update-all]`（`market.ts:239`）；或反过来把 progress.ts 拆成
`catalog.ts`（纯数据）+ `install.ts`（进度/修复链），让文件名与职责一致。

---

## 附：复核过但未单列的问题（低价值 / 证据不足 / 与其它单元重复）

1. `src/market/index.ts:17` 的导出名 `installMarketInstall` 与 `installDeps`/`installSubagents` 命名族不一致；
   `src/index.ts:69,89` 是唯一调用方，非死代码。
2. `src/deps/services.ts:221-224` 的 `key === undefined` 分支不可达：`:234-243` 的 10 个 `host(...)`
   调用**全部**传了第 4 个参数（`agentPresets`…`subagentModelSelection`），故 `patchIds.has(id) || svcOk(app,id)`
   这一行从未执行。已实测 10 个 key 与宿主插件注册的服务名**逐一相符**（在
   `@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib` 内 grep 命中），故不是缺陷，仅是一处死分支。
3. `src/deps/services.ts:246-253` 把「loader 里查不到该 entry」与「entry config 明确为 `never`」都判成
   `openAt` 未开，并输出「配置为 :memory: + never（库从不建立，搜索恒空）」这一**具体断言**；
   `loaderEntryConfig` 的 `catch {}`（`:129-139`）会吞掉任何取配置的异常 ⇒ 诊断可能指向错误原因，
   且 `search-override` 覆盖行会写给一个不存在的 id。属诊断措辞问题，未单列。
4. `src/market/progress.ts:372-378` `depMatchesEntry` 用 `depKey.includes(entry.name)` 等子串匹配，
   理论上可把无关依赖判成「已安装」进而对错误 depKey 执行 update/remove（例如 entry.name 是
   另一依赖名的子串）；因 registry 命名习惯（`owner/repo`）下误命中率低，未单列。
5. `src/market/progress.ts:68-95` 的手写 YAML 解析（`yamlField`/`yamlNestedField`）对
   `description: { zh: …, en: … }` 内联对象、多行块文案、键名含大写等写法不生效（静默退化为空描述）；
   `parsePluginYaml` 的 `file.replace(/__/,'/')` 只替换第一处 `__`（monorepo 路径 `a__b__c` 会残留）。
   影响仅描述文案/回退名，未单列。
6. `src/subagents/index.ts:249-257` `feedForSubagent` 在「找到了 child 但其父会话不在
   `sessions.live`」时兜底返回**当前活动会话**，会把子代理生命周期卡、`runningSubagents` 与
   `childParent`（进而该子代理的文件 diff 路由，`boot/session-events.ts:269-279`）记到错误的父会话上。
   因 dsh 的 agent 注册表按 session id 可查（`kernel/app.ts:423-436`），常态下第一分支即命中，
   兜底仅在父会话未被本 runner attach 时触发，可达性偏低，故降级为附注（若未来出现宿主侧后台
   会话派生 subagent，应改成「解析不到父会话就不登记」而非猜活动会话）。
7. `src/market/progress.ts:169-185` `fetchCatalog` 的 tar 流式解析（`tar.t` + `entry.on('data'/'end')`）
   经**实测**验证正确：把 `data/` 内文件放在归档末尾/中间两种顺序各试一次，`/tmp/tartest/t2.mjs`
   输出的 key 集合与 `stars.json` 内容都完整——即「parser end 早于最后一条 entry end」的竞态**不存在**
   （node-tar 12/7.5.22 的 `[PROCESSENTRY]` 会等 `entry 'end'` 再继续）。此前的怀疑已排除。
8. `src/subagents/index.ts:267-283` 的 nvim 通知与 `:286-326` 的 host handler 都有守卫
   （`kernel/host-events.ts:31-40` 的 try/catch + `boot/boot.ts:193-196` 的 notification 分发守卫），
   未发现「handler 抛错拖垮宿主」的问题。
9. 与其它审计单元重复、本次未重复计数：`commands-a.md` F1（无活跃会话时 notice 被
   `activeFeed()?.` 静默吞掉）同样命中本单元的 `subagents/commands/subagents.ts:10`；
   `sessions.md` 第 2 条（`activity==='running'` 误判导致 TTL 清理永不触发）会连带影响
   `subagents/commands/subagents.ts:17-28` 的 TTL 分支，根因在 `sessions/index.ts`。

---

## 附录 A：本次验证执行的关键命令（可复现，均只读）

```
# ① packageExists 根解析（F1 的核心证据）
node --input-type=module -e "import { packageExists } from '<repo>/lib/deps/services.js'; …"
  → 无 env：11/11 模板包 false；DSH_NVIM_TUI_INSTALL_ROOT=<nvm lib>：5/5 true
# ② 宿主插件真实位置 / profile 拓扑
ls -la ~/.dsh/profiles/nvim-tui/node_modules/dsh-nvim-tui     → -> <repo>（link:）
cat ~/.dsh/profiles/nvim-tui/package.json                    → link:/…/neovim-tui
ls -d ~/.dsh/profiles/nvim-tui/node_modules/@deepseek-ai        → No such file or directory
ls ~/.nvm/.../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai | grep dsh-agent-presets → present
grep -q dsh-nvim-tui ~/.dsh/profiles/{nvim-tui,tui}/package.json → 两个 profile 都命中（F6）
# ③ pnpm 探测（F10）
node -e "…spawnSync('pnpm',['--version'],{stdio:'ignore'})…"  → {"status":0,"stdout":null,"stderr":null}
# ④ tar 流式解析竞态排除（附注 7）
node /tmp/tartest/t2.mjs ; node /tmp/tartest/t2.mjs mdlast    → 两种顺序 key 集合均完整
# ⑤ 宿主服务键核对（附注 2）
for pair in "dsh-agent-presets agentPresets" … ; do grep -rl "$key" <pkg>/lib | wc -l ; done → 10/10 命中
# ⑥ 宿主 CLI 契约（F2 背景）
cat ~/.nvm/.../@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js        → pnpm 透传、退出码 0 才 reconcilePlugins
cat ~/.dsh/profiles/nvim-tui/cordis.patch.yml                 → insert 重复 id 抛错的在案警告（F11）
```
