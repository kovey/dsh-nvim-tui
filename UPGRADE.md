# 升级指南：dsh 0.1.1-rc.2 → 0.1.2-alpha.2

dsh-nvim-tui v0.2.7 全面适配 DeepSeek Harness **v0.1.2-alpha.2**。本指南覆盖
宿主升级、插件更新、profile patch 修正、第三方插件兼容、验证与回滚的全部步骤
（每一步均经真实环境实测）。

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
