/**
 * dsh-tui-ext-example —— 消费 dsh-nvim-tui 开放接口的 dsh 扩展示例。
 *
 * 消费方式：`ctx.get('nvim-tui')`（服务名冻结）。类型用结构类型
 * （`import type { TuiExtApi } from 'dsh-nvim-tui'`），运行时 duck-typing，
 * 不需要把 dsh-nvim-tui 声明为运行时依赖。
 *
 * 本文件是参考源码，不参与 dsh-nvim-tui 主仓库编译。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TuiExtApi } from 'dsh-nvim-tui'

export const name = 'dsh-tui-ext-example'

export function apply(ctx: Context, _config: unknown = {}): void {
  const tui = ctx.get('nvim-tui') as TuiExtApi | undefined
  if (tui === undefined) return // nvim-tui 未挂载（无 TUI 的宿主）

  const disposers: Array<() => void> = []

  // 1) boot 完成后挂 UI：状态栏段 + 命令 + 事件订阅。
  void tui.ready.then(() => {
    // 状态栏左侧追加一段（'' 移除；priority 升序排列）。
    tui.ui.statuslineSegment('ext-demo', '⎇ demo', 50)
    disposers.push(() => tui.ui.statuslineSegment('ext-demo', ''))

    // 斜杠命令：进入 / 补全目录与 /help；重名被拒绝（registerCommands 内部跳过）。
    disposers.push(tui.registerCommands([
      {
        name: 'ext:ping',
        desc: '扩展示例：响应',
        group: '扩展',
        fn: () => tui.ui.notice('🏓 ext-demo 在线'),
      },
      {
        name: 'ext:card',
        desc: '扩展示例：渲染/更新卡片',
        group: '扩展',
        fn: (arg) => {
          const card = tui.ui.card({
            plugin: 'ext-demo',
            title: '扩展卡片',
            body: `参数: ${arg || '（空）'}`,
            actions: [{ label: '刷新', value: 'refresh' }],
          })
          setTimeout(() => card.update({ body: '2 秒后自动更新' }), 2000)
          setTimeout(() => card.dismiss(), 6000)
        },
      },
      {
        name: 'ext:panel',
        desc: '扩展示例：打开右缘面板槽',
        group: '扩展',
        fn: async () => {
          const p = await tui.ui.panel({ title: ' 扩展面板 ', width: 48, lines: ['内容一'] })
          if (p === null) return // 槽被占用 / headless
          void tui.nvim.request('nvim_buf_set_lines', [p.buf, 0, -1, false, ['内容二']])
          setTimeout(() => void tui.ui.panelRelease(), 8000)
        },
      },
    ]))

    // 会话事件镜像：每个回合结束发一条瞬态通知。
    disposers.push(tui.onSessionEvent(
      { type: 'turn/end' },
      (_sessionId, _ev) => tui.ui.notice('ext-demo: 回合结束'),
    ))

    // 会话切换事件。
    disposers.push(tui.on('tui:active-session', (payload) => {
      const id = (payload as { id?: string } | null)?.id
      tui.ui.notice(`ext-demo: 会话切换 → ${id ?? '?'}`)
    }))
  })

  // 2) dsh-ext 总线：应答 nvim 侧插件的 api.rpc_call（examples/nvim/git-panel.lua）。
  // 处理器内可以安全调用 tui.nvim.*（nvim 阻塞在 rpcrequest 时仍处理事件，
  // 嵌套请求会被应答）——但处理器时长 = nvim UI 冻结时长，且 runner 有 30s
  // 超时兜底（超时后应答错误、结果丢弃）。长任务请用后台 job + 事件回推。
  disposers.push(tui.luaExt.on('git-panel', async (method, args) => {
    switch (method) {
      case 'commits': {
        // 演示原生执行层 + 嵌套调用（安全）。
        const out = await tui.nvim.call('systemlist', [['git', 'log', '--oneline', '-5']])
        return out
      }
      case 'status': return 'ok'
      default: throw new Error(`ext-demo: 未知方法 ${method}`)
    }
  }))

  // 3) 反向驱动 nvim 插件：10 秒后触发一次 git-panel 刷新（luaExt.emit）。
  const timer = setTimeout(() => tui.luaExt.emit('git-panel', 'refresh', { at: Date.now() }), 10000)
  disposers.push(() => clearTimeout(timer))

  // 4) 卸载清理：TUI teardown 也会广播 tui:teardown，这里主动兜底。
  disposers.push(tui.on('tui:teardown', () => {
    for (const off of disposers.splice(0)) {
      try { off() } catch { /* best effort */ }
    }
  }))
}
