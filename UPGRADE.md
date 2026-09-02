# 升级指南：dsh 0.1.2-alpha.3 → 0.1.2-alpha.4

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
  `isSeeded` + `inheritedEventCount`——nvim-tui 不直接消费这些字段，无
  破坏。
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
dsh plugin --profile nvim-tui update --latest kovey/dsh-nvim-tui
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
dsh plugin --profile nvim-tui update --latest kovey/dsh-nvim-tui
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
   dsh plugin --profile <name> update --latest kovey/dsh-nvim-tui
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
dsh plugin --profile nvim-tui update --latest kovey/dsh-nvim-tui

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
