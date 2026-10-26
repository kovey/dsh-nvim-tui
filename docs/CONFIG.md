# 配置参考

runner 行的 `config:` 写在 profile 的 `cordis.patch.yml` 里：

```yaml
# ~/.dsh/profiles/tui/cordis.patch.yml
- insert:
    - id: nvim-tui-runner
      name: 'dsh-nvim-tui'
      config:
        locale: zh
```

## Runner 配置项

| 配置项 | 默认 | 说明 |
|---|---|---|
| `loadUserConfig` | `true` | 是否加载你的 nvim 配置与插件；`false` 等价 `-u NONE`（环境变量 `DSH_NVIM_TUI_LOAD_USER_CONFIG=0`） |
| `theme` | 无 | 高亮组覆盖表，见[主题](#主题) |
| `headless` | `false` | 无 TTY 测试模式：nvim 以 `--headless` 启动（环境变量 `DSH_NVIM_TUI_HEADLESS=1`） |
| `watchdogMs` | `120000` | headless 模式的兜底超时（环境变量 `DSH_NVIM_TUI_WATCHDOG_MS`） |
| `dumpPath` | `/tmp/dsh-nvim-tui-e2e-<pid>.txt` | headless 模式聊天区转储路径（环境变量 `DSH_NVIM_TUI_DUMP`） |
| `prompt` | 无 | headless 模式下自动发送的首条消息（环境变量 `DSH_NVIM_TUI_PROMPT`） |
| `resumeLatest` | `true` | 启动时自动续上次活跃会话（环境变量 `DSH_NVIM_TUI_RESUME_LATEST=0` 关闭） |
| `resumeSessionId` | 无 | 显式指定要恢复的会话（优先于 `resumeLatest`；环境变量 `DSH_NVIM_TUI_RESUME`） |
| `locale` | `zh` | 界面语言 `zh` / `en`（环境变量 `DSH_NVIM_TUI_LOCALE`，运行时 `/locale` 切换） |
| `todoGuard` | `true` | 待办清单纪律守卫，见[待办清单守卫](#待办清单守卫)（环境变量 `DSH_NVIM_TUI_TODO_GUARD=0` 关闭） |
| `difficultyRouting` | 无 | 难度路由配置，见[难度路由](#难度路由) |

## 环境变量

| 变量 | 等效配置 | 说明 |
|---|---|---|
| `DSH_NVIM_TUI_HEADLESS=1` | `headless: true` | 无 TTY 测试模式 |
| `DSH_NVIM_TUI_PROMPT` | `prompt` | headless 自动发送的首条消息 |
| `DSH_NVIM_TUI_DUMP` | `dumpPath` | headless 聊天区转储路径 |
| `DSH_NVIM_TUI_WATCHDOG_MS` | `watchdogMs` | headless 兜底超时 |
| `DSH_NVIM_TUI_LOAD_USER_CONFIG=0` | `loadUserConfig: false` | 不加载用户 nvim 配置 |
| `DSH_NVIM_TUI_RESUME_LATEST=0` | `resumeLatest: false` | 不自动续会话 |
| `DSH_NVIM_TUI_RESUME=<id>` | `resumeSessionId` | 恢复指定会话 |
| `DSH_NVIM_TUI_LOCALE=zh\|en` | `locale` | 界面语言 |
| `DSH_NVIM_TUI_TODO_GUARD=0` | `todoGuard: false` | 关闭待办守卫 |

状态与日志都在 `$DSH_HOME`（默认 `~/.dsh`）：`dsh-nvim-tui-state.json` 记录上次
活跃会话与界面偏好，`nvim-tui-errors.log` 是错误日志。

## 可选宿主行

TUI profile 只保证 `dsh-base` 的核心行。以下能力依赖可选 host 行，用 `/deps`
体检并一键装配（写入当前 profile 的 `cordis.patch.yml`，HMR/重启生效）：

| 能力 | 需要的行 |
|---|---|
| `/schedule` 定时提醒 | `dsh-schedule` |
| `/terminal` 持久终端 | `dsh-terminal` + `dsh-terminal-bash` |
| `/changes` 宿主快照 | `dsh-workspace-changes` |
| `/preset`、Cordis 检查 | `dsh-agent-presets`、`dsh-cordis-host-runner` |
| `/workspace`、`/archive` | `dsh-workspace` |
| `/fb`、`@session`、TTFT | `dsh-message-feedback`、`dsh-session-reference`、`dsh-session-stats` |
| `/plugins` | `dsh-host-plugin-inventory` |

## 命令行参数

TUI profile 不挂 `dsh-cmdline`，但启动器之后的参数会被解析（等价于
`ctx.cmdlineArgs`；未挂时回退 argv）：

```bash
dsh --profile tui --resume <session-id>
dsh --profile tui --continue --model deepseek/deepseek-flash
dsh --profile tui --permission read-only
```

| 参数 | 作用 |
|---|---|
| `--resume <id>` | 恢复指定会话（优先于自动续会话） |
| `--continue` / `-c` | 恢复上次活跃会话（默认行为，显式写出便于脚本） |
| `--model <provider/model>` | 会话就绪后切换模型（持久化为默认） |
| `--permission <name>` | 会话就绪后应用权限预设（如 `read-only`） |
| `--help` / `-h` | 打印 TUI 帮助并退出 |
| `--version` / `-v` | 打印版本并退出 |

未知参数会打印错误并以 2 退出，不会被静默忽略。

## 主题

`config.theme` 是 `高亮组 → 属性` 映射，每组可给 `{ fg, bg, bold, italic,
underline }`（颜色 `#rrggbb`）或 `{ link: '内置组' }`。不覆盖的组保持默认，自动
适配你的 colorscheme；正文跟随主题的 `Comment`，亮色主题下自动回退为不刺眼的
暗灰。

```yaml
- insert:
    - id: nvim-tui-runner
      name: 'dsh-nvim-tui'
      config:
        theme:
          DshTuiUser: { fg: '#7aa2f7', bold: true }
          DshTuiTool: { fg: '#e0af68' }
          DshTuiReasoning: { fg: '#565f89', italic: true }
          DshTuiError: { link: 'ErrorMsg' }
```

常用组：`DshTuiUser`（用户消息）· `DshTuiAssistant`（模型输出）·
`DshTuiNotice`（提示）· `DshTuiDivider`（分隔线）· `DshTuiDim`（列表等未高亮文本）·
`DshTuiError` · `DshTuiTool` · `DshTuiSubagent` · `DshTuiWorkflow` ·
`DshTuiCode`（行内代码 / 代码块）· `DshTuiBold` · `DshTuiReasoning`（思考）·
`DshTuiExt`（扩展卡片）· `DshTuiPrompt`（输入行 `❯`）· `DshTuiStatus`（状态栏）·
`DshTuiActiveSession`。

运行时也可用内置预设：`/theme default|dim|vivid|contrast|mono`。预设选择会持久化，
下次启动自动恢复；`config.theme` 优先。

## 难度路由

`/difficulty` 在发送前按任务难度临时切换会话模型，**回合结束自动切回**全局默认
（与识图临时切换同一套机制，`agentDefaultModel` 持久化默认永不被污染）。

```yaml
- insert:
    - id: nvim-tui-runner
      name: 'dsh-nvim-tui'
      config:
        difficultyRouting:
          mode: auto            # auto | off
          tiers:
            easy:   { model: <快模型>, effort: off }
            medium: { model: <默认模型> }   # 可省略 = 不切换
            hard:   { model: <强模型>, effort: max }
          classifier: { enabled: true, model: <打分模型>, timeoutMs: 8000 }
          subagentPolicy: true  # 同步官方 subagent-model-selection 闸门
```

- **定档**：手动钉住 `/difficulty easy|medium|hard` → 规则评估（计划模式 / 活跃目标 /
  本回合工具失败 / 关键词 / 消息长度）→ 可选 LLM 分类器（`classifier.enabled`，
  用便宜模型在发送前打分，任何失败回退规则）。
- **状态栏**：`🟢/🟡/🔴` 前缀显示当前回合档位；`/difficulty` 无参可查看配置与状态。
- **手动切模型**：`/model` 会暂停本会话的自动路由，`/difficulty auto` 恢复；
  `/difficulty off` 全局关闭。
- **子代理**：`subagentPolicy: true` 时子代理可继承主会话模型并在档位模型集中自选。

## 待办清单守卫

`todo_write` 是整表重写语义，客户端只能按事件实时渲染。为了让「逐项更新」成为
硬性要求而不是依赖模型自觉，TUI 在每个 agent 作用域注入三道确定性约束
（`src/kernel/todo-guard.ts`）：

1. **常驻 system-prompt 段落**（`nvim-tui-todo-discipline`）：开始一项立即标
   `in_progress`，完成一项立即标 `completed`，禁止攒到最后一次性更新，回合结束
   不得留下失实的 `in_progress`；
2. **逐步提醒**（`agent/pre-step`）：某步用了工具却没写清单、而清单仍有未完成项
   时，向下一次请求注入具体提醒（每回合上限 3 条）；
3. **收尾闸**（`agent/turn-stopping`）：回合即将结束时仍有未完成项，再引导一次，
   避免清单半途而废、待办板永远钉在底部。

关闭：`config.todoGuard: false` 或 `DSH_NVIM_TUI_TODO_GUARD=0`。

## Headless / CI

headless 模式不需要真实终端，走完整的 host → agent → 渲染链路，首个 turn 结束后
把聊天区转储到 `dumpPath` 再退出：

```bash
DSH_NVIM_TUI_HEADLESS=1 \
DSH_NVIM_TUI_PROMPT='请只回复两个字：好的' \
DSH_NVIM_TUI_DUMP=/tmp/e2e-dump.txt \
dsh --profile tui
```

该模式会自动隔离 XDG 目录；`scripts/e2e.ts`（`npm run e2e`）在此之上跑真模型回归。
