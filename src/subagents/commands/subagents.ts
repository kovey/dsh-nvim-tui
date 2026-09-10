/** dsh_tui command: /subagents — one command per file. */
import { t, tf } from '../../kernel/i18n.js'
import { ageLabel, isExpired, orderSubagentChildren } from '../../kernel/subagent-clean.js'
import type { App, AppSlices, WritableSlice } from '../../kernel/app.js'
const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>

export const subagentsCommand = async (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec || app.slices.sessions.activeId === null) {
    app.notice(t('无活跃会话'))
    return
  }
  try {
    let children = await app.slices.sessions.listSubagentChildren(app.slices.sessions.activeId)
    // TTL cleanup: settled chains past the retention window are truncated
    // (only the first event survives) and hidden from the list.
    const ttlHours = Number(app.config.subagentTtlHours ?? 72)
    const expired = children.filter((c) => !c.running && isExpired(c.createdAt, ttlHours))
    if (expired.length > 0) {
      let cleaned = 0
      for (const c of expired) {
        if (await app.slices.sessions.cleanSubagentChain(app.slices.sessions.activeId, c.id)) cleaned++
      }
      if (cleaned > 0) {
        app.notice(tf('🧹 已清理 {0} 条过期子代理思考链（>{1}h），列表不再显示', [cleaned, ttlHours]))
        children = await app.slices.sessions.listSubagentChildren(app.slices.sessions.activeId)
      }
    }
    if (children.length === 0) {
      app.notice(t('该会话没有子代理（workflow/subagent 运行后此处可回放其思考链）'))
      return
    }
    // Running children first, then newest-first — the live work leads.
    children = orderSubagentChildren(children)
    const settledCount = children.filter((c) => !c.running).length
    const rows: Array<{ label: string; value: string }> = []
    let cleanRowInserted = false
    for (const c of children) {
      if (!c.running && !cleanRowInserted) {
        cleanRowInserted = true
        if (settledCount > 0) {
          rows.push({ label: tf('🧹 清理全部已结束思考链（{0} 条）', [settledCount]), value: 'act:clean' })
        }
      }
      rows.push({
        label: `${c.label}${c.running ? ' · 运行中' : ` · 已结束${ageLabel(c.createdAt) !== '' ? ` · ${ageLabel(c.createdAt)}` : ''}`}`,
        value: c.id,
      })
    }
    const sel = await app.openPicker(t('子代理（选择查看思考链）'), rows)
    if (sel === null) return
    if (sel === 'act:clean') {
      const ok = await app.openPicker(t('清理思考链'), [
        { label: `确认清理 ${settledCount} 条已结束思考链（列表隐藏；存储截断视 dsh 版本支持）`, value: 'yes' },
        { label: t('取消'), value: 'no' },
      ])
      if (ok !== 'yes') return
      let done = 0
      for (const c of children) {
        if (!c.running && await app.slices.sessions.cleanSubagentChain(app.slices.sessions.activeId, c.id)) done++
      }
      app.notice(tf('🧹 已清理 {0} 条思考链', [done]))
      return
    }
    const child = children.find((c) => c.id === sel)
    const action = child?.mode === 'continuable'
      ? await app.openPicker(t('子代理操作'), [
          { label: '打开对话窗口（像主聊天一样发消息）', value: 'chat' },
          { label: '继续对话（下一条输入发给它）', value: 'continue' },
          { label: '查看思考链回放', value: 'view' },
        ])
      : 'view'
    if (action === 'continue') {
      W(app.slices.agent).pendingSubagentFollowup = { childId: sel, label: child?.label ?? sel.slice(0, 8) }
      app.notice(tf('下一条输入将发给子代理 {0}（/subagents 可取消，直接输入即发送）', [app.slices.agent.pendingSubagentFollowup!.label]))
      return
    }
    if (action === null) return
    if (action === 'chat') {
      await app.slices.agent.openSubagentChat( sel, child?.label ?? sel.slice(0, 8))
      return
    }
    await app.slices.agent.openSubagentView( sel, child?.label ?? sel.slice(0, 8))
  } catch (err) {
    app.notice(tf('subagents 失败: {0}', [(err as Error).message]))
  }
}


export function installSubagentsCommand(app: App): void {
  app.registerCommands([{ name: '/subagents', desc: t('子代理目录（回放/续聊思考链）'), usage: t(''), group: t('会话'), fn: () => subagentsCommand(app) }])
}
