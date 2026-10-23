# 斜杠命令参考

输入 `/` 弹出补全菜单（命令名 + 说明随输入过滤；`Tab` / `<C-n>` 切换候选，
`Enter` 补全或执行）。命令目录由 runner 启动时推给 nvim，与 `/help`、命令分发
表共用同一份注册表，不会漂移。

本页是 **67 个内置命令** 的完整清单（含 `/quit`、`/branch` 两个别名）。宿主或其
他插件经 `ctx.commands` 注册的命令也会进补全目录，用 `/commands` 查看；依赖的
宿主服务未装配时，命令会给出明确提示，而不是静默失败。

## 系统

| 命令 | 说明 |
|---|---|
| `/exit` | 退出 dsh（确认弹窗；teardown 上限 2.5s，硬兜底 5s） |
| `/quit` | `/exit` 别名 |
| `/restart` | 重启 dsh 进程（硬兜底 9s） |
| `/help` | 弹出全部命令（`Enter` 填入输入框） |
| `/sessions [all\|only]` | 工作区分组 + 未分组 + 归档筛选的会话浏览器：打开 / 重命名 / 归档 / 移入工作区，`all` 含归档、`only` 只看归档 |
| `/panel` | 展开 / 收起活动面板（同 `<C-o>`） |
| `/settings [edit \| set <ns> <key.path> <value>]` | 设置总览；`edit` 在新标签页打开 `settings.yaml`；`set` 类型化写入（值按 JSON/布尔/数字解析，密钥回显打码） |
| `/deps [install]` | 依赖体检（缺什么 / 一键装配）；`/search` 的索引服务也由它装配 |
| `/locale [zh\|en]` | 界面语言（runner 侧文案；nvim 侧按键提示仍为中文） |

## 会话

| 命令 | 说明 |
|---|---|
| `/new [目录]` | 新建会话（可指定 cwd；无参弹目录选择器） |
| `/clear` | 清空当前会话屏幕（不删历史） |
| `/fork [directive]` | 分叉当前会话（继承历史与血缘），directive 作为首条消息 |
| `/branch` | `/fork` 别名 |
| `/btw <问题>` | 侧问：分叉新会话发送该问题，不打断当前对话 |
| `/stop` | 中止当前回合（清空排队与引导；同 `<C-c>`） |
| `/steer <directive>` | 引导注入：把指令排队给最近一步（空闲时直接开一轮） |
| `/compact` | 手动压缩上下文（返回压缩条数与 token 数） |
| `/goal [new <目标>\|pause\|resume\|complete\|clear]` | 查看 / 管理目标（状态栏同步 🎯 进度） |
| `/plan [on\|off\|status]` | 计划模式开关（状态栏显示 📋） |
| `/rewind [第N条]` | 回退到某条用户消息；宿主不支持 `session.truncate` 时提示改用 `/fork` |
| `/rename <新标题>` | 钉住会话标题 |
| `/search <关键词>` | 跨会话全文搜索（需 `dsh-session-query-sqlite` 服务；未装配时提示） |
| `/tasks [kill <job-id>]` | 任务列表弹窗（打开期间实时刷新，选中即取消）+ 钉底任务板 |
| `/todo [任务内容]` | 添加 / 查看待办（弹窗实时同步 + 钉底待办板 + 状态栏计数） |
| `/skills [技能名]` | 技能目录浏览（浮窗看详情） |
| `/fb up\|down [备注]` | 对最后一条助手消息点赞 / 点踩 |
| `/subagents` | 子代理目录：思考链回放 + 对话窗（continuable 子代理可续聊） |
| `/workflow` | 工作流运行视图（阶段树 + agent 序列 + 日志） |
| `/history` | 输入历史浏览（`Enter` 回填输入框，多行条目原样恢复） |
| `/queue` | 消息队列：查看 / 编辑 / 删除 / 清空（状态栏 ⏳ 计数） |
| `/workspace [add <目录> [标题] \| delete <id>]` | 工作区管理（分组 / 排序 / 归档） |
| `/archive [会话id]` | 归档会话（从所有列表隐藏，非破坏性） |
| `/attach [路径]` | 附加文件 / 目录：图片进附件队列，其余转为 `@` 路径引用 |
| `/image <路径> [提示]` | 发送本地图片（png/jpg/webp/gif，支持 `~/`）；macOS 无参读剪贴板；`/image clear` 清空 `<C-v>` 队列 |

## 模型

| 命令 | 说明 |
|---|---|
| `/model [provider/model]` | 无参浮窗选择，带参直接切换；热切并持久化为默认 |
| `/models` | 模型 / 供应商目录（活路由 + 可配置 provider + 图像能力标记） |
| `/effort off\|high\|max\|auto` | 推理等级 |
| `/difficulty [easy\|medium\|hard\|auto\|off]` | 按任务难度自动选模型；回合结束自动切回（详见 [CONFIG.md](./CONFIG.md#难度路由)） |
| `/preset [id]` | agent 预设（需 agent-presets 行；仅未开始回合的会话可切换） |

## 审批

| 命令 | 说明 |
|---|---|
| `/yolo on\|off` | 审批策略：全放行 / 逐项询问 |
| `/permission [name]` | 权限预设（沙箱模式 + 审批策略组合）；危险全访问预设先弹确认 |

## 显示

| 命令 | 说明 |
|---|---|
| `/density` | 紧凑模式（工具卡片仅显示标题行） |
| `/glance <cache\|context\|tokens\|cost\|elapsed\|total>` | 状态栏分段显隐 |
| `/layout default\|panel` | 布局预设（无参循环切换） |
| `/theme default\|dim\|vivid\|contrast\|mono` | 内置高亮预设（不覆盖则跟随 colorscheme） |
| `/whale on\|off` | 蓝鲸背景 / 水印开关（官方 logo 矢量离线光栅化，按窗口宽度选 24/32/48 列） |

## 信息

| 命令 | 说明 |
|---|---|
| `/approvals` | 本会话审批历史（批准 / 拒绝；按会话落盘，重启后仍在） |
| `/changes [路径]` | 本会话改动过的文件汇总（次数 + 净行数）；选中即进入对照审阅 |
| `/commands [名称]` | 官方命令注册表（宿主 / 插件注册的命令） |
| `/config` | 配置摘要 |
| `/context` | 上下文组成分解（≈used/capacity · system/tools/messages · claim 窗口） |
| `/cost` | 用量与成本（会话累计 token、预估成本） |
| `/cwd [路径]` | 查看 / 切换本会话工作目录（dsh 0.2.1+；相对路径按 `cd` 语义） |
| `/deliverables` | 本回合交付物（在新标签页打开产物文件） |
| `/diff [路径]` | 左右对照审阅某个文件的改动（内容取自改动发生时的快照，不重读文件） |
| `/dir [路径]` | 目录浏览浮窗（`Enter` 进目录 / 文件在新标签页打开，`gt`/`gT` 切换） |
| `/doctor` | 终端 + 会话日志诊断（点名曾有日志故障的会话并给出修复出路） |
| `/export` | 导出转录 Markdown |
| `/lines [路径]` | 文件行视图（只读浮窗，`i` 打开编辑；无参弹目录选择器） |
| `/market [关键词 \| refresh \| update-all]` | 插件市场：精选目录按 GitHub ★ 倒序，安装 / 更新 / 卸载 + 热启停（HMR 免重启），磁盘缓存可离线 |
| `/mcp` | MCP server 工具统计（按 server 分组） |
| `/plugin [install\|update\|remove <spec> \| list]` | 市场目录之外的直装入口（npm 包名 / `owner/repo` / git URL）。更新 git/tag 依赖必须带新 ref，`--latest` 推不动 git ref |
| `/plugins` | 宿主插件清单（loader 条目只读投影） |
| `/status` | 会话快照 |
| `/trajectory` | 回合步骤轨迹 |

## 记忆

| 命令 | 说明 |
|---|---|
| `/remember <text>` | 写入项目记忆（`.dsh/memory/`） |
| `/memory [delete <id>]` | 浏览 / 删除项目记忆 |
