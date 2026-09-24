# 升级指南

本文件按"宿主版本轴"记录升级步骤与注意事项。**先读与你自己相关的那一段**：

> ## ⚠️ v0.4.2 / v0.4.3 存在崩溃级回归，请升级到 v0.4.4
>
> 那两版的终端通知（OSC 9 / 777）在**非 TTY** 场景会把转义序列写进输出流：
> 终端显示乱码，且终端对序列的设备属性应答无人读取，滞留字节污染 nvim RPC 流，
> 表现为**会话跑一会儿就异常退出**（日志里可能是 `nvim_buf_set_lines:
> 'replacement string' item contains newlines` 或 `write EPIPE`）。
> v0.4.4 增加了 `stdout_is_tty()` 守卫（只覆盖非 TTY 场景）；**v0.4.5 起该功能
> 与 `/bell` 命令已整体移除** —— 插件所在 nvim 为 `--embed`，其 stdout 是 RPC
> socket，从 Lua 侧没有任何通道能到达终端。

> **git/tag 依赖怎么升级（实测结论，2026-09-16）**：`pnpm update` 与
> `update --latest` **都不会**推进 `github:owner/repo#tag` —— `--latest` 只重写
> npm semver 范围，不改 git ref。唯一有效的是**用 `add` 带新 ref 重写**：
> `dsh plugin --profile <p> add "owner/repo#vX.Y.Z"`（TUI 内：
> `/plugin update owner/repo#vX.Y.Z`）。`update` 只对 npm 依赖有意义。

| 你的现状 | 读这一节 |
|---|---|
| nvim-tui v0.4.6（宿主 0.1.5-rc.2） | [v0.4.6 → v0.4.7（**宿主 0.1.5-rc.2 → 0.1.7-rc.1**，含破坏性适配）](#v046--v047宿主-015-rc2--017-rc1) |
| nvim-tui v0.4.5（宿主 0.1.5-rc.2） | [v0.4.5 → v0.4.6（发布物修正 + 门禁加固，零破坏）](#v045--v046发布物修正--门禁加固零破坏) |
| nvim-tui v0.4.4（宿主 0.1.5-rc.2） | [v0.4.4 → v0.4.5（移除 /bell 与终端通知，零破坏）](#v044--v045移除-bell-与终端通知零破坏) |
| nvim-tui v0.4.3（宿主 0.1.5-rc.2） | [v0.4.3 → v0.4.4（**崩溃修复**，零破坏）](#v043--v044崩溃修复零破坏) |
| nvim-tui v0.4.2（宿主 0.1.5-rc.2） | [v0.4.2 → v0.4.3（插件升级，零破坏）](#v042--v043插件升级零破坏) |
| nvim-tui v0.4.1（宿主 0.1.5-rc.2） | [v0.4.1 → v0.4.2（插件升级，零破坏）](#v041--v042插件升级零破坏) |
| nvim-tui v0.4.0（宿主 0.1.5-rc.1 或 rc.2） | [v0.4.0 → v0.4.1（插件升级，零破坏）](#v040--v041插件升级零破坏) |
| nvim-tui 已适配 0.1.5（宿主 0.1.5-rc.1） | [宿主 0.1.5-rc.1 → 0.1.5-rc.2（零破坏）](#宿主-015-rc1--015-rc2零破坏) |
| nvim-tui ≤ v0.3.4（宿主 0.1.2-rc.1） | [v0.3.4 → v0.4.0（含宿主 0.1.2-rc.1 → 0.1.5-rc.1）](#v034--v040含宿主-012-rc1--015-rc1) |
| nvim-tui v0.4.0 已升（宿主仍 0.1.2-rc.1） | 同上（宿主段落必读：peer 锚点已改为 `^0.1.5-rc.1`） |
| 仅升级宿主 dsh（插件版本不变） | 见下方历史小节 |

---

## v0.4.6 → v0.4.7（宿主 0.1.5-rc.2 → 0.1.7-rc.1）

> **结论先行**：这是**跨宿主版本**的升级，**不是**零破坏。插件与宿主必须一起动，
> 且升级后**必须重启**。若你暂时不想动宿主，**请留在 v0.4.6**（它锚定 0.1.5-rc.2）。

### 升级步骤

```bash
# 1) 先升宿主（0.1.7-rc.1 在 next dist-tag 上）
npm i -g @deepseek-ai/dsh@0.1.7-rc.1

# 2) 再升插件（git 依赖用 add 带新 tag，update/--latest 推不动 git ref）
dsh plugin --profile <name> add "kovey/dsh-nvim-tui#v0.4.7"

# 3) 重启
dsh --profile <name>
```

### 为什么是破坏性的：锚点语义变了

0.1.5 时期 peer 是**区间**（`^0.1.5-rc.2`），于是 rc.1 与 rc.2 可互换。
0.1.7 的 peer 改成**精确版本**：

```
"@deepseek-ai/dsh-agent": "0.1.7-rc.1"    ← 无 ^
```

本插件随之精确锚定，**不能再跨 rc 混用**。若插件声明 0.1.7-rc.1 而宿主仍是
0.1.5-rc.2，peer 不匹配，且类型面已按 0.1.7 校验，运行可能报错。

### 本次适配的三处改动

1. **`source.kind` 的 `'plugin'` 被官方移除**（真破坏性变更）。
   `MessageSourceMap` 改为「每个生产者在自己的模块里声明自己的 kind」，
   官方注释明确 *there is no shared catch-all `plugin` kind*。
   本插件按官方范例（`dsh-tools` 的 `tool-registry`）用 module augmentation
   自建 `'nvim-tui-todo-guard'`，并交叉 `ContextFormed` 以保留
   `form: 'notice'` + `summary`（渲染层靠这对字段把注入内容折叠成一行 dim notice，
   而不是伪装成用户输入）。
2. **PTC 服务改名**：`dsh-code-runtime*` 止于 0.1.5-rc.3，0.1.7 换成
   `dsh-ptc-runtime`（服务名 `ctx.codeRuntime` → `ctx.ptcRuntime`）。
   服务清单**双列两代**，因此 0.1.5 与 0.1.7 宿主都能正确报告 `/deps` 状态。
3. **peer 锚点精确化** + devDependencies 补齐 0.1.7 新增的 peer 集
   （`dsh-workspace` / `dsh-sandbox(-policy)` / `dsh-ptc-runtime` /
   `dsh-scope` / `dsh-session(-projection)` / `dsh-system-prompt` /
   `dsh-typert-protocol` / `dsh-invariants` / `dsh-util-values` /
   `dsh-user-approval` / `cordis ~4.0.4`）。本地装需 `--legacy-peer-deps`
   （这些包互相 peer 依赖同一精确版本，npm 严格解析无解；运行时由宿主提供）。

### 本版修复：startup 警告不再画到输入框

升到 0.1.7 后，`dsh: warning: 1 entry did not activate` 会出现在**输入框那一行**并把
光标顶到状态栏上。根因：`dsh` 进程自己持有终端（`fd0/1/2 → /dev/ttysNNN`），
而插件跑在它 spawn 的 `nvim --embed` 里（fd 全是 unix socket）；宿主用
`process.stderr.write` 写激活诊断，裸字节直接落到我们正在画的终端上（这些字节
**不在任何 buffer 里**，只在终端字节层）。

本版在**模块顶层**接管 `process.stderr.write`（警告来自 dsh 重写 `cordis.yml`
触发的 reload，发生在插件求值之后，故顶层足够早），缓冲后**回放进聊天区**。
**诊断不丢**；`DSH_NVIM_TUI_HOST_STDERR=raw` 可关闭接管。

> 你仍会看到那行警告 —— 但它现在**在聊天区**（带 `· `前缀），而不是画在输入框上。

### 本版未做的适配（有意）

0.1.7 的新功能 —— MCP 资源发现与 URI 模板、headless `--json`、插件管理页、
侧边栏预览等 —— **绝大多数是宿主/Web 侧实现**。TUI 通过既有服务面
（如 `tools.schemas()`，签名未变）自然获得，**不需要 TUI 侧改动**。
Agent Team 面板、Word/Excel 预览、语音转写等为 Web 专有，TUI 不涉及。

### 验证

- 类型面：`check`（含 arch-check / app-ops-check）/ `smoke` / `i18n`
  对着 0.1.7-rc.1 的真实类型面全绿（`tsc --noEmit` 0 错）。
- **真机 e2e**：隔离 `DSH_HOME` 内装 0.1.7-rc.1 宿主 + link 本插件，headless 跑通
  （`EXIT=0`、dump 正常、版本横幅 / history replay / turn 开合 / 状态栏渲染均正确）。

## v0.4.5 → v0.4.6（发布物修正 + 门禁加固，零破坏）

> **结论先行**：只升插件即可，不需要动宿主、不需要改 `cordis.patch.yml`。
> peer 锚点仍为 `^0.1.5-rc.2`。**若你已装 v0.4.5 可不必升级**（残留文件无人引用，
> 不影响运行）；**新装请用本版**。

### 升级步骤

```bash
dsh plugin --profile <name> add "kovey/dsh-nvim-tui#v0.4.6"
dsh --profile <name>     # 重启生效
```

### 本版修正

- v0.4.5 的包里残留了两个已删除功能的编译产物
  （`lib/commands/commands/bell.{js,d.ts}`）—— 因为 `lib/` 既提交进 git
  也随包发布，而 **tsc 不会清理已删源文件的产物**。本版已清除。
- 为此在 `check-arch` 增加第 9 条规则：`lib/` 下每个产物都必须有对应源文件，
  否则门禁失败。以后这类残留不会再流到发布物。

## v0.4.4 → v0.4.5（移除 /bell 与终端通知，零破坏）

> **结论先行**：只升插件即可，**不需要动宿主、不需要改 `cordis.patch.yml`**。
> peer 锚点仍为 `^0.1.5-rc.2`（本版未改）。

### 升级步骤

```bash
dsh plugin --profile <name> add "kovey/dsh-nvim-tui#v0.4.5"
#   TUI 内等价命令：/plugin update kovey/dsh-nvim-tui#v0.4.5

dsh --profile <name>     # 重启生效
```

### 本版变更

- **`/bell` 命令已删除**，响铃与终端通知（OSC 9 / 777）功能一并移除。
  原因：插件所在的 nvim 以 `--embed` 启动，其 `fd 0/1/2` 是 nvim↔宿主的 unix
  socket（`vim.uv.guess_handle(1)` 报 `"pipe"`），**从 Lua 侧没有任何通道能到达
  终端** —— 写转义不但无效，还会摧毁终端显示（v0.4.2 的真实事故：表现为「TUI
  窗口消失」但进程没死）。若你之前配置过 `/bell`，该设置不再有任何作用。
- 命令总数 47 → 46。`/help` 与补全里不再出现 `/bell`。
- **`check-arch` 规则 3c 修复两处盲区**（只遍历已登记文件、正则漏 `W()` 写法）。
  修好后暴露出 7 处此前静默的跨域写，已按既有模式显式登记归属。这对使用者无行为
  影响，但意味着以后命令层的架构违规不会再被门禁放过。

### 若你在 v0.4.2 / v0.4.3 上遇到过显示异常

那些版本的终端通知会向 RPC 通道写转义序列并透传到终端，导致显示被摧毁、乱码
（`64;1;2;4;6;17;18;21;22c` 这类设备属性应答滞留回显）。升级到本版即可根治
（功能已不存在）。

## v0.4.3 → v0.4.4（崩溃修复，零破坏）

> **结论先行**：只升插件即可，**不需要动宿主、不需要改 `cordis.patch.yml`**。
> peer 锚点仍为 `^0.1.5-rc.2`（本版未改）。**这是崩溃修复，建议尽快升级。**

### 升级步骤

```bash
# git 依赖：用 add 带新 tag 重写 ref（update/--latest 推不动 git ref）
dsh plugin --profile <name> add "kovey/dsh-nvim-tui#v0.4.4"
#   TUI 内等价命令：/plugin update kovey/dsh-nvim-tui#v0.4.4

dsh --profile <name>     # 重启生效
```

### 本版修复

- **非 TTY 不再发射转义序列**（v0.4.2 引入的回归）。原 `raw()` 无条件往 `io.stdout`
  写 OSC/BEL，未检查 stdout 是否为终端；在管道 / headless / 重定向场景泄漏出去的
  序列会让终端产生**无人读取的设备属性应答**，滞留字节污染 nvim RPC 流，导致会话
  异常退出。现加 `stdout_is_tty()` 守卫，两侧保守（探测失败即拒绝发射）。
- 若你曾在终端见到类似 `64;1;2;4;6;17;18;21;22c` 的乱码，那正是该应答 —— 升级后
  不再出现。

### 排查提示

该崩溃**不会留下有用的错误日志**（字节层即被打断，`uncaughtException` 上下文不足）。
若以后再遇到「会话莫名退出」，优先看**终端里的乱码**而不是日志。

## v0.4.2 → v0.4.3（插件升级，零破坏）

> **结论先行**：只升插件即可，**不需要动宿主、不需要改 `cordis.patch.yml`**。
> peer 锚点仍是 `^0.1.5-rc.2`（本版未改）。

### 升级步骤

```bash
# git 依赖：必须用 add 带新 tag 重写 ref（见文首说明；update/--latest 都推不动）
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.4.3"
#   TUI 内等价命令：/plugin update kovey/dsh-nvim-tui#v0.4.3

dsh --profile nvim-tui     # 重启生效
```

### 本版新增

- **`/plugin update`**：补齐安装的对称操作。此前 `/plugin` 只有 install/remove，
  目录外插件在 TUI 里没有更新入口。npm 依赖用 `update [--latest]`；
  **git/tag 依赖用 `update <owner/repo#新ref>`**（内部路由到 `add`）。
- `/market update-all` 现在会**点名哪些 git/tag 依赖未被推进** —— 它跑的
  `pnpm update` 不带 `--latest`，对 git 依赖无效，此前会让人误以为「全部已更新」。

### 本版修复

- **更正了本文档此前 9 处关于 git 依赖升级的错误说法**（原写「必须带 `--latest`」）。
  实测：`update --latest` 对 `github:…#tag` **无效**（只重写 npm semver 范围），
  且它会**成功退出却什么都不改**。唯一有效的是 `add` 带新 ref。

## v0.4.1 → v0.4.2（插件升级，零破坏）

> **结论先行**：只升插件即可，**不需要动宿主、不需要改 `cordis.patch.yml`**。
> peer 锚点仍是 `^0.1.5-rc.2`（本版未改），宿主 0.1.5-rc.2 无需变动。

### 升级步骤

```bash
# git 依赖：必须用 add 带新 tag 重写 ref（update/--latest 都推不动 git ref —— 已实测）
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.4.2"
#   TUI 内等价命令：/plugin update kovey/dsh-nvim-tui#v0.4.2

dsh --profile nvim-tui     # 重启生效
```

> 本版改动了 Lua 侧模块（含 `rpc.lua`、新增 `goto_file.lua`）与 nvim 启动期
> 预加载列表，**必须重启**才能生效 —— 运行中的实例不会热加载。

### 本版新增

- **鲸鱼重做**：从**官方 logo 矢量路径**离线光栅化（不再是手绘网格），按窗口宽度
  分 24/32/48 列三档，含呼吸浮动 + 喷气动效。
- **待办清单闭环**：新增回合收尾闸，未完成项会真正走完「实时更新 → 落盘 → 清槽」；
  并修掉状态栏徽标在清单结束后不清的缺陷。
- **审批历史** `/approvals`：本会话的批准/拒绝记录，**按会话落盘、重启后仍在**。
- **会话日志健康检查**：`/doctor` 现在会点名曾有日志故障的会话（依据 host 留下的
  `.corrupt-backup`），并给出可执行的出路（`/fork` / `/export`）。
- **从转录行跳到文件**：`<C-w>f` / `gF` 打开光标所在行引用的文件（支持 `:LINE`）。

### 本版修复

- **响铃无声**：`R.bell()` 原先用 `vim.api.nvim_out_write`，该 API 把文本当 **UI
  消息**派发、不写 fd，因此响铃自写下起就是无声的。（**后续处置**：该功能连同其
  OSC 通知已在 v0.4.5 整体移除 —— 插件所在的 nvim 以 `--embed` 运行，stdout 是
  RPC socket 而非终端，任何原始转义都到不了 tty，反而破坏显示。）
- **审批点缺提醒**：`/bell` 的两个调用点（回合结束、审批请求）此前只接了一个。

### 已知问题（不影响升级）

- **终端级完成通知（OSC 9 / 777）在本机实测无效**：插件所在的 nvim 以 `--embed`
  启动，其 stdout 是与宿主通信的管道，字节到不了终端。`/bell` 的响铃同样受影响。
  代码已放在正确方向（`io.stdout`），但接通需由持有 tty 的进程发射，**本版未完成**。
  已在 `rpc.lua` 标注 `NOT WORKING — UNRESOLVED`，不重复试错。

## v0.4.0 → v0.4.1（插件升级，零破坏）

> **结论先行**：只升插件即可，**不需要动宿主、不需要改 `cordis.patch.yml`**。
> peer 锚点从 `^0.1.5-rc.1` 改为 `^0.1.5-rc.2`，而该区间**仍接受
> 0.1.5-rc.1**（下界 rc.2、上界 `<0.2.0`），所以 rc.1 与 rc.2 宿主都可用。

### 升级步骤

```bash
# git 依赖：用 add 带新 tag 重写 ref
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.4.1"

dsh --profile nvim-tui     # 重启生效
```

### 本版新增

- **`/plugin` 命令（新）**：市场目录之外的插件直装入口：
  `/plugin install <spec>`（npm 包名 / `owner/repo` / git URL）、
  `/plugin remove <spec>`、`/plugin list`。`/market` 只覆盖精选目录里的
  2140+ 插件，小众/私有插件搜不到时用这条。
  命令**不在** `TUI_COMMAND_WHITELIST` 内，agent 侧无法调用它。

### 本版修复

- **`/deps install` 不再全量跳过**：安装根探测补上 dsh 自带的 store
  （`<dshDir>/node_modules/@deepseek-ai/*`）与共享 store
  （`$DSH_HOME/profiles/node_modules`），并修掉一处候选根层级错误
  （旧写法展开成 `…/node_modules/node_modules/…`，永不命中）。
  另把「定位不到安装根」与「包确实不存在」区分开，提示不再误导。
- **e2e 无凭证时不再假报 PASS**：判定排除用户回显与注入上下文，并补中文
  `未检测到 API key` 标记（此前只认英文，中文宿主漏判）。
  同时修掉一处反向缺陷：以 `· ` 项目符号作答的正常回合曾被整段误判为
  「无助手内容」而 FAIL。

### 从源码开发时

```bash
npm run check          # tsc 双 tsconfig + 架构/域操作门禁
npm run smoke          # 无头冒烟（含 e2e 判定与安装根候选的回归断言）
npm run e2e -- "你好"  # 真机 e2e（需凭证：本机 API key 在 ~/.zshrc，需先 source）
npm run i18n:report    # i18n 漂移报告
```

---

## 宿主 0.1.5-rc.1 → 0.1.5-rc.2（零破坏）

> **结论先行**：这次宿主升级**不需要任何插件代码改动**。rc.1 与 rc.2 的
> 发布包**运行时代码与类型面逐字节相同**，差异只有版本号与 peer 区间。

### 为什么是零破坏（核实方法可复现）

按仓库既有约定（"双版本 tarball diff + scratch 宿主真机 e2e"）逐层核对：

```bash
# 1) 取两版全部 15 个 @deepseek-ai 包的 tarball
#    https://registry.npmjs.org/@deepseek-ai/<pkg>/-/<pkg>-<ver>.tgz
# 2) 逐文件 sha256 比对
```

核对结果（15 个包 / 212 个文件）：

| 项 | 结果 |
|---|---|
| 文件内容逐字节相同 | **197** |
| 仅版本号变动（均为 `package.json`） | **15** |
| 运行时代码 / `lib/types/*.d.ts` 差异 | **0** |
| 仅单侧存在的文件 | **0** |

`package.json` 的差异也只是 `version` 字段与内部 peer/依赖区间
（`^0.1.5-rc.1` → `^0.1.5-rc.2`）；忽略键序后**全部内容等价**，无依赖增删。

官方侧同样印证：release notes 只列两项 **web UI** 体验优化（消息反馈弹窗
确认、交付文件卡片排版与图标），commit 区间 `dsh-v0.1.5-rc.1...dsh-v0.1.5-rc.2`
仅 4 个提交，非 `package.json` 的改动全部落在 `apps/web/tests/*` 与
`packages/client/*`（Web 客户端 React 组件，不随 npm 包发布）。

### 升级步骤

```bash
# 1) 升级宿主（rc.2 目前挂在 next dist-tag 上）
npm i -g @deepseek-ai/dsh@next
dsh --version                      # 期望 0.1.5-rc.2

# 2) 依赖树对齐（仅从源码开发时需要）
cd <本仓库> && npm install         # peer 锚点已改为 ^0.1.5-rc.2
```

> ⚠️ **`rc.2` 是预发布版，不是稳定版**。npm 的 `latest` dist-tag 仍停在
> `0.1.0-rc.6`，`0.1.5-rc.2` 只挂在 `next` 上 —— 安装时必须显式 `@next`，
> 否则会装到旧的 `latest`。

### 兼容性说明

- **peer 区间**：`^0.1.5-rc.2` 本身**仍接受** `0.1.5-rc.1`（以及 rc.3、
  最终 0.1.5）—— 语义化版本里 `^0.1.5-rc.N` 的下界是 `0.1.5-rc.N`，
  上界是 `<0.2.0`。因此 rc.1 宿主不会被这次锚点变更拒之门外。
- **无需回滚预案**：两版代码同构，升/降级只影响宿主版本号本身。
- **会话日志**：rc.2 **没有**引入新的日志格式变更，V3 迁移结论与 rc.1 相同。

---

## v0.3.4 → v0.4.0（含宿主 0.1.2-rc.1 → 0.1.5-rc.1）

> **版本说明**：原计划的 `v0.3.5` 未单独打标签发布，其内容并入 v0.4.0。
> v0.4.0 的 peer 依赖锚点是 **`^0.1.5-rc.1`**：与 0.1.2-rc.1 宿主**不混用**
> （0.1.2 宿主请留在 v0.3.4）。

### 必须做的三步

```bash
# 1) 升级宿主（next dist-tag 当前即 0.1.5-rc.1）
npm i -g @deepseek-ai/dsh@next
dsh --version                      # 期望 0.1.5-rc.1

# 2) 升级插件到 v0.4.0（git 依赖用 add 带 tag，见文首说明）
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.4.0"

# 3) 依赖树对齐（v0.4.0 起 devDependency/lockfile 也锚定 0.1.5-rc.1；
#    只有从源码开发才需要）
cd <本仓库> && rm -rf node_modules package-lock.json && npm install

dsh --profile nvim-tui             # 重启生效（HMR 不足以换掉 peer 依赖）
```

### 行为变化（升级后你会看到）

- **会话日志迁移到 V3**：宿主首次启动会迁移既有日志；`nvim-tui` 的历史/恢复/
  分叉消费面已随迁（旧日志仍可读，但**不要**用旧版插件读新日志）。
- **默认模型换代**：新会话默认 `deepseek-flash`（自带 image 模态）；识图候选
  优先 `deepseek-flash`，并对目录中任意 image 模态模型兜底。
- **`/rewind` 在新宿主降级**：0.1.5-rc.1 移除了 `session.truncate`，命令改为
  明确提示不可用；规避方式：`/fork` 派生新会话，或留在 0.1.2 宿主。
- **待办清单纪律默认开启**：每个 agent 作用域注入常驻 system-prompt 段落 +
  `agent/pre-step` 逐步提醒（每回合最多 3 条）。关闭方式：
  `config.todoGuard: false` 或环境变量 `DSH_NVIM_TUI_TODO_GUARD=0`。
- **`/difficulty` 更严格**：档位模型切换前会做目录（`listModels`）与
  `reasoningEffort` 兼容校验，不匹配时跳过并提示，而不是让回合报适配器错误。
- **`/theme`、`/density` 偏好持久化**到 `$DSH_HOME/dsh-nvim-tui-state.json`
  （与"上次活跃会话"同一文件）；`/theme default` 现在会真正清除上一预设。
- **`/deps install` 真正可用**：此前因安装根解析错误而**恒为空操作**（宿主包在
  dsh 安装根的 `node_modules` 下，旧实现只查 profile 根）；同时 `pnpm` 版本探测
  修复。装配后按运行 profile 写入，等待热重载，必要时自动重启。
- **`/locale zh|en` 双向**：en 模式覆盖已补全（628 键 / 0 未翻译 / 0 死键），
  且切回中文可用（此前在 en 启动后无法还原）。

### 从源码开发时新增的门禁

```bash
npm run check          # src + scripts 双 tsconfig（TypeScript 严格性已拉满）+ 架构/域操作门禁
npm run smoke          # 无头冒烟（含 0.1.5 双宿主兼容断言）
npm run i18n:report    # i18n 漂移报告（死键 / 未翻译 / 未包装字面量）
```

TypeScript 严格性：`strict` + `noUnusedLocals/Parameters` +
`noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` +
`exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `noImplicitOverride` +
`noFallthroughCasesInSwitch` + `noImplicitReturns` + `allowUnreachableCode:false`。
宿主边界用**条件展开**表达"缺省 ≠ 显式 undefined"。

### 宿主侧破坏性变更（插件已适配，供排查用）

- **`ctx.sessions` 服务移除**：live 会话存储并入 `ctx.agents`（`agents.get/list`
  返回的 Agent 携带 `.session`）。TUI 注入面改为 `['agents','agentDefaultModel']`
  并自建 sessions 适配器。
- **Session 生命周期 / V3 日志**：`sessionPersistence` 改为 `list()`（快照
  `{header,revision,…}`）+ `open(id,'read').read()` 的 SessionHandle 模型；
  surface replace 拼写改为 `startSeq/endSeq`；新增 `system/message` 事件。
  TUI 的会话历史 / 子代理冷读 / 自愈修复全部随迁。
- **subagents 续聊**：符号键 `queueSubagentPrompt` 移除，改为公开
  `subagents.prompt({requestId, parentSessionId, childSessionId,
  mode:'continuable', delivery:'queue'|'steer', content}, signal)`
  （旧宿主仍走符号键路径兼容）。
- **默认模型换代**：新会话默认 `deepseek-flash`（DeepSeek-V41-Flash，自带
  image 模态）。

```bash
npm i -g @deepseek-ai/dsh@next   # next dist-tag 现为 0.1.5-rc.2（rc.1 亦可）
dsh --version                    # 应输出 0.1.5-rc.2（运行中的进程需重启生效）
# 插件侧（git 依赖）：dsh plugin --profile <name> add "kovey/dsh-nvim-tui#<tag>"
```

> 当前 `next` dist-tag 已从 0.1.5-rc.1 前进到 **0.1.5-rc.2**；两者对本插件
> 等价（逐字节同代码），rc.2 的锚点更新见文首
> [宿主 0.1.5-rc.1 → 0.1.5-rc.2](#宿主-015-rc1--015-rc2零破坏)。

> 会话日志由宿主自动迁移到 V3 格式（旧文件保留）；升级后的会话不支持降级
> 读取，回退宿主版本前请先导出需要保留的会话。

---

---

# 历史指南：dsh 0.1.2-alpha.5 → 0.1.2-rc.1

dsh-nvim-tui v0.2.14 将 peer 依赖锚点抬升至 **`^0.1.2-rc.1`**。升级前已做
全量 API 核对：rc.1 与 alpha.5 的类型面**逐文件零差异**（dsh-agent /
dsh-llm / dsh-tools / dsh-session 等 14 个包的 lib/types 全部 diff 为空），
TUI 消费的宿主服务方法（jobs.onJobsChanged/onJobDone、subagents.listChildren、
workspaceRegistry、agentPresets、permissionPresets、fileReferences、settings、
sessionQuery、messageFeedback put/list/delete、goals get/create/pause/resume/
complete/clear、tools.schemas、pluginInventory.list、agentDefaultModel
currentSelection/saveSelection 等）逐一在 rc.1 定义中存在且签名一致。
真机验证：rc.1 宿主冷启动零错误 + 真实模型 e2e 回合 PASS。

升级步骤：

```bash
npm i -g @deepseek-ai/dsh@next   # next dist-tag 即 0.1.2-rc.1
dsh --version                    # 应输出 0.1.2-rc.1（运行中的进程需重启生效）
# 插件侧（git 依赖）：dsh plugin --profile <name> add "kovey/dsh-nvim-tui#<tag>"
```

---

# 历史指南：dsh 0.1.2-alpha.4 → 0.1.2-alpha.5

dsh-nvim-tui v0.2.14 将 peer 依赖锚点抬升至 **`^0.1.2-alpha.5`**。本次升级
对 TUI 消费面**零破坏**（alpha.5 的 SessionSeq 移除 `Session.events` 等破坏
性变更在 v0.2.12 已适配完成），主要收益：

- **损坏会话日志官方修复**：持久化扫描器遇到 seq gap 时保留连续前缀并
  持久化截断修复（不再硬失败）——TUI 的历史恢复本地兜底已随之移除；
- 官方识图模型目录（`deepseek-v4-flash-vision-exp`，text+image）进入
  dsh-llm-deepseek 默认目录，TUI 图片消息自动切换该模型处理；
- jobs 服务补齐 `onJobsChanged`/`onJobDone` 观察者（状态栏后台任务徽章）。

升级步骤：

```bash
npm i -g @deepseek-ai/dsh@alpha
dsh --version        # 应输出 0.1.2-alpha.5（运行中的进程需重启生效）
# 插件侧（git 依赖）：dsh plugin --profile <name> add "kovey/dsh-nvim-tui#<tag>"
```

---

# 历史指南：dsh 0.1.2-alpha.3 → 0.1.2-alpha.4

> **修正（v0.2.12 之后）**：下文"无破坏性变化 / nvim-tui 消费面零改动适配"
> 的结论有误——alpha.4 的 SessionSeq 品牌化重构同时移除了 `Session.events`
> 公共属性，v0.2.12 在恢复旧会话时会抛
> `TypeError: Cannot read properties of undefined (reading 'length')`，
> `/fork` 亦失效。已修复：历史恢复等 7 处消费改走 `snapshotEvents()`
> （alpha.3 `events` 兜底），`/fork` 重写为 alpha.4 官方种子契约
> （`seed` + `inheritedEventCount` + `meta.isSeeded`），真机恢复旧会话
> 验证通过。升级插件请用含该修复的版本。

dsh-nvim-tui v0.2.12 全面适配 DeepSeek Harness **v0.1.2-alpha.4**。逐包 diff
结论：

- **父子代理双向通信（核心变化）**：`followup`（父→子）与 `reportFrom`
  （子→父，alpha.3 的 `subagent-report` source + `SubagentReportOptions`
  已被移除）合并为通用 **`sendMessage(sender, targetId, …)`**——相邻 Agent
  互发消息，Steer 语义（运行中目标在最近步界接收、空闲目标起新回合）；
  source 统一为 `agent-message`；`queuePrompt` 供宿主侧人类消息入队。
  标准子代理提示词改为指示子代理 `send_message({ agent_id, message })`
  把结果发回父代理（父代理不自动接收子代理转录/工具输出/推理）。
- **SessionSeq 品牌化重构**：session 事件序列号全线改为 branded number
  （`SessionSeq`/`SessionLogOffset`/`OptionalSessionSeq`），`seedLength` →
  `isSeeded` + `inheritedEventCount`，且 `Session.events` 公共属性被移除
  （改用 `snapshotEvents()` / `ownEvents()` / `eventAt()`）。nvim-tui 的
  历史恢复 / 分叉消费面需相应适配（见 CHANGELOG 未发布条目）。
- 其余家族包为配套重构（invariant 模块归并、typert host 调整）。

**无破坏性变化**（nvim-tui 消费面零改动适配）；peer 依赖锚点抬升至
`^0.1.2-alpha.4`，版本横幅 0.2.12。新增功能面：子代理消息高亮渲染 +
子代理文件修改实时 diff 同步到父聊天区（见 CHANGELOG）。

## 升级步骤

```bash
# 1. 升级宿主
npm i -g @deepseek-ai/dsh@alpha
dsh --version        # 应输出 0.1.2-alpha.4（首次启动 profile 时共享 store
                     # 自动抬升到 alpha.4；运行中的进程需重启生效）

# 2. 更新 nvim-tui 插件
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#<tag>"
# 或固定版本
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.2.12"

# 3. cordis.patch.yml 无需改动——alpha.4 未新增/删除 loader entry，
#    alpha.3 时代的装配行（含 web-app 5 服务补全）原样可用。
```

## 验证

```bash
cd <仓库>
npm run check && npm run build && npm run smoke
npm run e2e -- "请只回复两个字：就绪"
```

**判定标准**：e2e 输出 `E2E PASS`，dump 内 `── turn ──` 与 `── turn end ──`
之间有真实助手回复（alpha.4 真机实测通过）。

**回滚**：`npm i -g @deepseek-ai/dsh@0.1.2-alpha.3`，插件退回
`kovey/dsh-nvim-tui#v0.2.11`。

---

# 历史指南：dsh 0.1.2-alpha.2 → 0.1.2-alpha.3

dsh-nvim-tui v0.2.11 全面适配 DeepSeek Harness **v0.1.2-alpha.3**。alpha.3 是
全家族（40+ 包）的**协同版本号抬升**，逐包 diff 结论：

- **19 个核心包**（dsh-agent / dsh-llm / dsh-tools / dsh-session /
  dsh-user-approval / dsh-code-runtime / dsh-scope / dsh-system-prompt /
  dsh-typert-protocol / dsh-typert-registry / dsh-brand / dsh-timeout /
  dsh-util-crypto / dsh-util-values …）`lib/` **与 alpha.2 逐字节相同**，仅
  package.json 版本号与依赖范围抬升；
- **dsh-session-projection**：行为微调——change feed 只在某单元 raw view
  按 `Object.is` 变化时通知（原来是每次 state 引用变化都通知，语义收敛，
  纯去重、非破坏）。nvim-tui 只读 `stateOf()`，不受影响；
- **dsh-attachment**：新增浏览器上传 API `admitPromptContent` +
  `PromptContentPart` / `AdmittedPromptContentPart` 类型（纯增量）。
  nvim-tui 用到的 `saveImage()` 未变；
- **dsh-invariants**：仅 README 修订。

**结论：无破坏性变化**，nvim-tui 源码零改动即可适配——本次变更只有 peer
依赖锚点抬升（`^0.1.2-alpha.2` → `^0.1.2-alpha.3`）、版本横幅（0.2.11）
与真机验证。

## 升级步骤

```bash
# 1. 升级宿主（alpha dist-tag 当前即 0.1.2-alpha.3）
npm i -g @deepseek-ai/dsh@alpha
dsh --version        # 应输出 0.1.2-alpha.3
# 首次启动任意 profile 时 boot 会把共享 store（~/.dsh/profiles/node_modules）
# 抬升到 alpha.3；正在运行的 dsh 进程仍在内存里跑旧代码，需重启才生效。

# 2. 更新 nvim-tui 插件（发布版）
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#<tag>"
# 或固定版本
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.2.11"

# 3. 无需修正 cordis.patch.yml —— alpha.3 未新增/删除 loader entry，
#    旧 profile 的 patch 原样可用（与 alpha.2→alpha.3 的零破坏结论一致）。
```

## 4. 推荐：profile 装配补全（激活 TUI 已有功能）

v0.2.11 的功能对比核查确认 5 个官方宿主服务是 **dsh-web-app bundle 独有**、
nvim-tui 宿主组合（dsh-base + dsh-nvim-tui）未装配的——runner 的消费面早已
实现，缺装配时对应功能空转。在 profile 的 cordis.patch.yml 追加即可（依赖
全部落在 dsh-base 已有的 storage / sessionQuery / sessionProjection 上，
无需额外行；包本体在共享 store 里已随宿主安装）：

```yaml
# /fb 消息反馈（此前提示"服务未装配"）
- insert:
    - id: message-feedback
      name: '@deepseek-ai/dsh-message-feedback'
      config:
        maxNoteBytes: 8192
# @ 提及的跨会话引用（此前静默失效）
    - id: session-reference
      name: '@deepseek-ai/dsh-session-reference'
# 状态栏 TTFT / tok-s 统计（此前投影单元不存在，永不显示）
    - id: session-stats
      name: '@deepseek-ai/dsh-session-stats'
# PTC 预设的 run_code 执行 seam（此前 /preset ptc 挂起不可用）
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
# 子代理独立模型选择设置
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
```

装配后 headless 启动一次验证（alpha.2 起 boot 把 pending 条目视为致命错误，
能正常启动即证明全部激活）。

## 验证

```bash
cd <仓库>
npm run check && npm run build && npm run smoke
npm run e2e -- "请只回复两个字：就绪"   # 真机：全局 dsh (alpha.3) + nvim-tui profile
```

**判定标准**：e2e 输出 `E2E PASS`，dump 里 `── turn ──` 与 `── turn end ──`
之间有真实助手回复（alpha.3 真机实测通过）。

**回滚**：`npm i -g @deepseek-ai/dsh@0.1.2-alpha.2`，插件退回
`kovey/dsh-nvim-tui#v0.2.10`。

---

# 历史指南：dsh 0.1.1-rc.2 → 0.1.2-alpha.2

dsh-nvim-tui v0.2.7 全面适配 DeepSeek Harness **v0.1.2-alpha.2**。本指南覆盖
宿主升级、插件更新、profile patch 修正、第三方插件兼容、验证与回滚的全部步骤
（每一步均经真实环境实测）。以下内容保留作历史参考。

> **v0.2.8 重要更新（会话卡死 400 insufficient tool messages）**：见
> [§0. v0.2.8：修复工具调度器崩溃与已毒化会话的自愈](#0-v028修复工具调度器崩溃与已毒化会话的自愈)。
> 升级到 v0.2.8 后按该节清理 profile 中残留的第二份 `@deepseek-ai/dsh-tools`。
>
> **v0.2.9 补充**：崩溃后又发过消息的会话（历史中间夹杂用户消息）在
> v0.2.8 下仍会 400——v0.2.9 改为按 surface 位置外科修复（就地改写悬空
> tool-calls 的 assistant 消息并中和错位结果），直接升级到 ≥ v0.2.9 再
> 打开旧会话即可自愈。

## 0. v0.2.8：修复工具调度器崩溃与已毒化会话的自愈

**症状**：agent 调用工具（如 bash）后回合崩于
`Cannot read properties of undefined (reading 'prepare')`，此后该会话**每一
轮**都被 API 以 `An assistant message with 'tool_calls' must be followed by
tool messages responding to each 'tool_call_id'. (insufficient tool messages
following tool_calls message)` 400 拒绝，会话永久卡死。

**根因**：v0.2.7 及更早把 `@deepseek-ai/dsh-tools` 声明为**普通依赖**。pnpm
安装时把它 hoist 进 profile 的 `node_modules`，与宿主自带的 dsh-tools 形成
两份物理拷贝；loader 从 profile 解析 `tools` bundle entry → `tools` 服务用
插件副本构造，`dsh-agent-loop`（宿主副本）持有的 scheduler unique symbol
对不上 → 工具派发在 tool/call 已落盘后崩溃 → 悬空 tool_call 让历史永远
重放一条没有 tool 结果的消息 → API 永久 400（宿主编排层已知问题，社区
#1337/#1633/#1665/#1677/#1697/#1959 同签名）。

**修复**：

1. 插件升级到 **v0.2.8+**（dsh-tools 改为 optional peerDependency，不再把
   第二份拷贝带进 profile）：

   ```bash
   dsh plugin --profile <name> add "kovey/dsh-nvim-tui#<tag>"
   # 或固定版本
   dsh plugin --profile <name> add "kovey/dsh-nvim-tui#v0.2.8"
   ```

2. 清理旧版本残留的第二份拷贝（升级后仍会留在 profile 里）：

   ```bash
   cd ~/.dsh/profiles/<name>
   pnpm why @deepseek-ai/dsh-tools   # 确认谁在引入副本（应为"无"或仅宿主）
   pnpm dedupe                       # 收敛重复版本
   # 若 dedupe 后仍存在 node_modules/@deepseek-ai/dsh-tools 实体目录（非
   # 指向宿主的软链），删除后重装：rm -rf node_modules && pnpm install
   ```

   验证（`tui` profile 实测命令）：profile 的
   `node_modules/@deepseek-ai/dsh-tools` 应为**指向宿主安装的软链**
   （`~/.dsh/profiles/node_modules/…` 的共享 fallback），而不是 pnpm 装出的
   实体目录。

3. **旧会话自愈（无需重建）**：v0.2.8 打开会话时自动扫描并补写悬空
   tool_call 的合成错误结果（`TOOL_OUTCOME_UNKNOWN`），毒化历史重新配对，
   原会话继续可用；回合内再次崩溃时也会在回合末自动补写并提示根因。

## 版本对应（peer 范围不混用）

| dsh-nvim-tui | 宿主 dsh | peer 依赖范围 |
|---|---|---|
| **v0.2.7+** | **0.1.2-alpha.2**（npm `alpha` dist-tag） | `^0.1.2-alpha.2` |
| ≤ v0.2.6 | 0.1.1-rc.2（npm `latest`） | `^0.1.1-rc.2` |

> ⚠️ 不要混用：v0.2.7 的 user-questions 走 `user-questions/request` waterfall
> 事件（rc.2 宿主没有该事件，问答会静默失效）；`permission.current` 的传参
> 也不同（session vs events）。升级必须**宿主与插件同时**切换。

## 1. 升级宿主 dsh

```bash
npm i -g @deepseek-ai/dsh@alpha
dsh --version        # 应输出 0.1.2-alpha.2
```

- alpha.2 修复了 Node 24.0–24.11.1 的启动/HMR 问题。
- 正在运行的 dsh 进程（含 `dsh web` GUI）仍在内存里跑旧代码，需**重启**
  才生效。

## 2. 更新 nvim-tui 插件

```bash
# 直链开发 profile（依赖为 "dsh-nvim-tui": "link:<仓库路径>"）
git -C <仓库> pull && cd <仓库> && npm install && npm run build
# profile 直链 lib/，无需重装依赖

# 发布版（git 依赖必须带 --latest，否则 pnpm 不重新解析分支 HEAD）
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#<tag>"

# 或固定版本（git ref 语法，@version 会被 pnpm 当作别名报错）
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.2.7"
```

## 3. 修正 profile 的 cordis.patch.yml

alpha.2 有两处组合层面的破坏性变化，旧 profile 的 patch 会启动失败或功能失效：

### 3.1 删除重复的 storage 行（启动崩溃）

alpha.2 的 **dsh-base 已自带 `storage` / `storage-json` / `storage-domain`**
三行。旧 patch 里照搬 dsh-web-app 配方的这四行（storage 三件套 + workspace）
会报 `duplicate loader entry id: storage`，整个 profile 起不来。

只保留 `workspace` 行（它依赖的 storageDomain 与 sessionPersistence 均由
dsh-base 提供）：

```yaml
# dsh 0.1.2-alpha.2 起 dsh-base 已自带 storage/storage-json/storage-domain
# 三行，patch 不得再重复 insert；workspace 行保留即可。
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
```

### 3.2 删除失效的 shipped 预设根（/preset 功能）

旧注释「profile-boot 会自动追加 `dsh/config/agent-presets`」已过时——alpha.2
起 shipped 预设**随 `@deepseek-ai/dsh-agent-presets` 包自带**
（`includeShippedRoot` 默认开启，先于任何配置根）。patch 里显式写的
`roots: [{ path: '<dsh安装路径>/config/agent-presets/', trust: system }]`
指向的目录在 alpha.2 已不存在，整个 `roots` 配置应删除：

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
```

### 3.3 pending entry 致命化：补齐依赖行（启动崩溃）

alpha.2 的 boot 把「未激活（pending）的 loader entry」视为**致命错误**
（`plugin tree failed to load: 1 entry did not activate`），旧版本里
pending 插件只是静默不可用。典型症状：

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
dsh-workspaces-adapter: pending (waiting for service: workspaceRegistry)
```

bundles 里有 `dsh-workspaces-adapter` 的 profile，patch 必须补上它依赖的
`workspace` 行（dsh-base alpha.2 已自带 storage 三件套与
sessionPersistence，只加这一行即可）：

```yaml
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
```

排查方法：headless 启动一次（`DSH_NVIM_TUI_HEADLESS=1 dsh --profile <p>`），
日志里 `pending (waiting for service: X)` 指向缺哪个服务，就按同样方式补
提供 X 的官方行（行名可在 `dsh --profile <p> --dump-config` 的
`@deepseek-ai/dsh-base` 段里查）。

## 4. 第三方插件兼容性

按启动日志逐条排查 `does not provide an export named ...`：

- **dsh-context**：`< 0.38.5` 的版本 import 了 dsh-settings 已移除的
  `settingsNamespace` 导出 → `SyntaxError`。profile 的 package.json 改为
  `"dsh-context": "^0.38.5"` 后 `pnpm install --no-frozen-lockfile` 重装。
- 其他插件同理：报缺失导出就查该插件是否有适配 0.1.2 的新版本；没有则
  暂时从 bundles 移除该插件再逐次加回。

## 5. 验证

```bash
cd <仓库>
npm run check && npm run build && npm run smoke
npm run e2e -- "请只回复两个字：就绪"      # 默认走 PATH 的 dsh + nvim-tui profile
```

**判定标准**：e2e 输出 `E2E PASS`，且 dump 里出现真实助手回复（`── turn ──`
与 `── turn end ──` 之间有回复文本，不是 `⚠` 错误行）。

**安全试跑**（不污染真实 `~/.dsh`，升级宿主前先验证代码兼容性）：

```bash
# 1. scratch 安装 alpha 宿主
npm i --prefix /tmp/dsh-alpha @deepseek-ai/dsh@alpha

# 2. scratch DSH_HOME + 最小测试 profile
mkdir -p /tmp/dsh-a2-home/profiles/nvim-tui-a2
#    profile/package.json:
#      { "name": "dsh-profile-nvim-tui-a2", "private": true,
#        "dependencies": { "dsh-nvim-tui": "link:<仓库绝对路径>" },
#        "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-nvim-tui"] } } }
#    profile 内再放 pnpm-workspace.yaml (packages: ['.']) 并 pnpm install
cp ~/.dsh/settings.yaml /tmp/dsh-a2-home/settings.yaml   # 复用模型配置

# 3. 用覆盖项跑 e2e
DSH_HOME=/tmp/dsh-a2-home \
DSH_BIN=/tmp/dsh-alpha/node_modules/.bin/dsh \
DSH_NVIM_TUI_PROFILE=nvim-tui-a2 \
npm run e2e -- "请只回复两个字：就绪"
```

（`DSH_BIN` / `DSH_NVIM_TUI_PROFILE` 是 v0.2.7 起 e2e 脚本支持的覆盖项；
macOS 没有 `timeout` 命令，e2e 超时用 `DSH_NVIM_TUI_E2E_TIMEOUT` 控制。）

## 6. 回滚

```bash
npm i -g @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile nvim-tui add "kovey/dsh-nvim-tui#v0.2.6"
```

并恢复 cordis.patch.yml 中被删除的行（storage 三件套 + 旧 shipped 预设根
roots 配置），重启 dsh 进程。


## /rewind 的宿主能力说明（v0.3.2+）

`/rewind`（回退到某条消息）依赖宿主 `dsh-session` 的 `session.truncate`
原语；当前宿主编排层未公开该符号，因此命令会提示「会话截断不可用」并
建议 `/fork` 派生替代。若宿主未来公开 truncate，本插件无需改动即自动
启用该路径（代码已按能力探测降级）。
