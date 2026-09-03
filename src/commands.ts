/**
 * dsh_tui commands module: messaging (followup / send / images / steering),
 * the host-service commands (goal / plan / tasks / skills / mcp / settings /
 * feedback …), input routing (natural-language → command, queue edit, rename
 * flows), the generic slash-command registry, /help, and the agent-side
 * `tui_command` routing tool.
 *
 * @module dsh-nvim-tui/commands
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { locale, setLocale, t } from './i18n.js'
import { matchIntent } from './nlcmd.js'
import { imageLabel, readClipboardImage, readImageFile, sniffMediaType, splitImageDataUrls } from './images.js'
import { billedInput, formatElapsed, formatTokens, modeLabel } from './stats.js'
import { queueSubagentPromptKey } from './types.js'
import type { InboxLike, LlmService, MessageContent, SaveImageAttachment } from './types.js'
import type { App, CommandSpec, ModelRef, SessionRec } from './app.js'

/**
 * Send a user message with optional image attachments.
 * `images` entries are SaveImageAttachment-shaped (`{data, mediaType, name}`)
 * — read from a local file (/image) or parsed from pasted data URLs. They
 * are durably committed through the harness `attachments` service so the
 * message content carries only stable image refs; the LLM adapter resolves
 * them into data URLs at request time.
 * agent.followup() ENQUEUES a next-turn message and wakes the driver: a
 * running turn is never interrupted — the input is processed as a later
 * turn of the same drain.
 */
const followup = async (app: App, rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }> | string>) => {
  if (app.disposed || rec === undefined) return
  // Surface the queueing so the message doesn't look lost. (Use /btw to
  // fork a side session instead.)
  if (rec.status === '● running') {
    app.activeFeed()?.appendNotice('已排队：当前回合结束后处理')
  }
  if (images !== undefined && images.length > 0 && (text ?? '').trim() === '') {
    text = '📎 图片消息'
  }
  const content: MessageContent[] = [{ type: 'text', text }]
  if (images !== undefined && images.length > 0) {
    const attachments = app.svc('attachments')
    if (attachments === undefined) {
      app.notice(t('图片发送需要 attachments 服务（attachment-local 未装配）'))
      return
    }
    // 官方识图路径：当前模型声明 image 输入 → 直接发送；否则临时切换到
    // 官方识图模型（目录中的 deepseek-v4-flash-vision-exp 等），回合结束
    // 自动切回原模型（boot.ts 的 turn/end 恢复）。目录里没有任何带 image
    // 模态的模型时 fail fast——不要让回合死在适配器里（UNSUPPORTED_CONTENT）。
    const llm = app.runtimeCtx.get('llm') as LlmService | undefined
    const sel = app.currentSelection()
    const curInfo = await llm?.resolveModelInfo(sel.provider, sel.model).catch(() => undefined)
    if (curInfo?.inputModalities?.includes('image') !== true) {
      const candidates = ['deepseek-v4-flash-vision-exp', 'deepseek-vl2', 'deepseek-vl']
      let visionModel: string | undefined
      for (const id of candidates) {
        const info = await llm?.resolveModelInfo(sel.provider, id).catch(() => undefined)
        if (info?.inputModalities?.includes('image') === true) {
          visionModel = id
          break
        }
      }
      if (visionModel === undefined) {
        app.notice(`没有可用的官方识图模型（settings.yaml 的 llm-deepseek.models 需包含声明 image 模态的模型，如 deepseek-v4-flash-vision-exp）`)
        return
      }
      rec.modelRef.current = { ...sel, model: visionModel }
      rec.visionTmp = { prev: sel, switchAt: Date.now() }
      app.notice(`📎 图片消息: 临时切换官方识图模型 ${sel.provider}/${visionModel}（回合结束自动切回 ${sel.provider}/${sel.model}）`)
      app.updateStatusline()
    }
    const max = attachments.imageLimits?.maxImagesPerMessage ?? 4
    if (images.length > max) {
      app.notice(`最多附带 ${max} 张图片，已截断`)
      images = images.slice(0, max)
    }
    try {
      for (const img of images) {
        content.push({ type: 'image', attachment: await attachments.saveImage(img as SaveImageAttachment) })
      }
    } catch (err) {
      app.notice(`图片附加失败: ${(err as Error).message}`)
      return
    }
  }
  try {
    rec.handle.agent.followup(createUserMessage({
      content: content as never,
      source: { kind: 'user' },
    }))
  } catch (err) {
    app.notice(`发送失败: ${(err as Error).message}`)
  }
}

/**
 * Queue one human prompt to a continuable child through the official
 * symbol-keyed host prompt queue (Symbol.for('dsh.subagent.queuePrompt')).
 * The dsh-subagent service exposes NO public followup method — this face
 * is the host-only queue: (parent, childId, content, source, signal) →
 * inbox MessageId. Running children admit it as their next turn after the
 * current one converges; settled children cold-resume.
 */
const queueSubagentPrompt = async (app: App, parentAgent: unknown, childId: string, text: string) => {
  const subagentsSvc = app.svc('subagents')
  const fn = subagentsSvc?.[queueSubagentPromptKey]
  if (typeof fn !== 'function') {
    throw new Error(t('子代理续聊不可用（subagents 服务未装配）'))
  }
  // The symbol-keyed method reads `this` internally (requireContinuations,
  // etc.) — invoke it BOUND to the service instance, never as a detached
  // function (an unbound call crashes with "Cannot read properties of
  // undefined (reading 'requireContinuations')").
  await (fn as (...args: unknown[]) => Promise<unknown>).call(
    subagentsSvc,
    parentAgent,
    childId,
    [{ type: 'text', text }],
    { kind: 'user' },
    new AbortController().signal,
  )
}

const send = (app: App, text: string) => {
  if (app.disposed) return
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.pendingInput.push(text)
    return
  }
  // /subagents → 继续对话: this input line goes to the continuable child
  // through the official host prompt queue (parent-authority check
  // built in) instead of the main agent.
  if (app.pendingSubagentFollowup !== null) {
    const target = app.pendingSubagentFollowup
    app.pendingSubagentFollowup = null
    void (async () => {
      try {
        await queueSubagentPrompt(app, rec.handle.agent, target.childId, text)
        app.notice(`已发送给子代理 ${target.label}: ${text.slice(0, 60)}`)
      } catch (err) {
        app.notice(`子代理续聊失败: ${(err as Error).message}`)
      }
    })()
    return
  }
  // Pasted data URLs become image attachments; the URL text is stripped.
  const { text: clean, images } = splitImageDataUrls(text)
  // Clipboard images queued via <C-v> ride along with the submitted text.
  const all = [...images, ...app.pendingImages]
  app.pendingImages = []
  void followup(app, rec, clean, all)
}

/** <C-v> handler: queue the macOS clipboard image for the next submit. */
const pasteClipboardImage = (app: App) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  if (process.platform !== 'darwin') {
    app.notice(t('剪贴板读图仅支持 macOS（请用 /image <路径>）'))
    return
  }
  // pbpaste -Prefer public.png/tiff: plain pbpaste only returns the
  // clipboard TEXT, which is empty for an image copied with Cmd+C.
  const image = readClipboardImage()
  if (image === null) {
    app.notice(t('剪贴板里没有图片（截图/复制图片后按 C-v）'))
    return
  }
  app.pendingImages.push(image)
  app.notice(`📎 已附加剪贴板图片（共 ${app.pendingImages.length} 张，回车随消息发送；/image clear 清空）`)
}

/** /image [<path>] [prompt] — attach an image and send. No path on macOS
 *  reads the clipboard image via pbpaste (PNG bytes). `/image clear`
 *  drops the <C-v> pending queue. */
const imageCommand = (app: App, a: string | undefined) => {
  if ((a ?? '').trim() === 'clear') {
    const n = app.pendingImages.length
    app.pendingImages = []
    app.notice(n > 0 ? `已清空 ${n} 张待发送图片` : '（没有待发送图片）')
    return
  }
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const m = (a ?? '').match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const prompt = (m?.[2] ?? '').trim()
  let image
  if (m !== null && m[1] !== undefined) {
    try {
      image = readImageFile(m[1])
    } catch (err) {
      app.notice(`读取图片失败: ${(err as Error).message}`)
      return
    }
  } else if (process.platform === 'darwin') {
    image = readClipboardImage()
    if (image === null) {
      app.notice(t('剪贴板里没有图片（用法: /image <路径> [提示]；或先复制图片）'))
      return
    }
  } else {
    app.notice(t('用法: /image <路径> [提示]'))
    return
  }
  void followup(app, rec, prompt || '📎 图片消息', [image])
}

/** /stop — abort the active turn (agent.cancel with a user cause). */
const stopCommand = (app: App) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  if (rec.status !== '● running') {
    app.notice(t('没有运行中的回合'))
    return
  }
  try {
    rec.handle.agent.cancel({ kind: 'user' })
    rec.feed.appendNotice('⏹ 已请求停止当前回合')
  } catch (err) {
    app.notice(`停止失败: ${(err as Error).message}`)
  }
}

/** /steer <directive> — inject steering for the nearest step. */
const steerCommand = (app: App, a: string | undefined) => {
  const text = (a ?? '').trim()
  if (!text) {
    app.notice(t('用法: /steer <directive>（注入到最近一步的引导指令）'))
    return
  }
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  try {
    rec.handle.agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    rec.feed.pushBlock('steer', text)
    app.notice(t('已注入引导指令'))
  } catch (err) {
    app.notice(`steer 失败: ${(err as Error).message}`)
  }
}

// -- host-service commands (goal / compaction / jobs / skills / mcp /
//    plan / search / rename / feedback / rewind) ------------------------

/** /compact — manually compact the session context via the compaction
 *  engine; null result means there was nothing worth compacting. */
const compactCommand = async (app: App) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const compaction = app.svc('compaction')
  if (compaction === undefined) {
    app.notice(t('compaction 服务未装配（profile 加入 dsh-compaction 后可用）'))
    return
  }
  app.notice(t('正在压缩上下文…'))
  try {
    const result = await compaction.compactNow(rec.handle.agent, new AbortController().signal)
    if (result === null) {
      app.notice(t('没有可压缩的历史'))
    } else {
      app.notice(`已压缩 ${result.shadowedSeqs.length} 条历史 · 约 ${formatTokens(result.shadowedTokenCount)} tokens`)
    }
  } catch (err) {
    app.notice(`压缩失败: ${(err as Error).message}`)
  }
}

/** /todo — the standing task list is AGENT-owned (the dsh todo_write
 *  tool rejects non-agent callers, the official web UI only renders it),
 *  so adding a task = asking the agent to update its list; with no
 *  argument the current list pops up (read-only, from todo/write folds). */
const todoCommand = (app: App, a: string | undefined): void => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) { app.notice(t('无活跃会话')); return }
  const text = (a ?? '').trim()
  if (text !== '') {
    const items = rec.todosItems ?? []
    const keep = items.length > 0 ? `，保持其余 ${items.length} 项不变` : ''
    void followup(app, rec, `请更新任务清单：添加一项「${text}」${keep}`)
    return
  }
  // Whole-log todos projection (dsh-tool-todo registers `todos` on
  // ctx.sessionProjections): authoritative on resumed sessions; fall back
  // to the live todo/write fold.
  let items: Array<{ content: string; status: string }> = rec.todosItems ?? []
  const projections = app.svc('sessionProjections')
  if (typeof projections?.stateOf === 'function') {
    const proj = projections.stateOf(rec.handle.agent.session, 'todos') as
      Array<{ content: string; status: string }> | null | undefined
    if (Array.isArray(proj) && proj.length > 0) items = proj
  }
  if (items.length === 0) {
    app.notice(t('（当前没有待办任务——直接告诉我要做什么，我会自己维护清单）'))
    return
  }
  const marks: Record<string, string> = { pending: '○', in_progress: '◐', completed: '✓' }
  const lines = items.map((it) => `  ${marks[it.status] ?? '·'} ${it.content}`)
  void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('📋 待办清单'), lines]).catch(() => {})
}

/** /goal [show|new <objective>|pause|resume|complete|clear] — the active
 *  goal (compare-and-set on the GoalRef). */
const goalCommand = (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const goals = app.svc('goals')
  if (goals === undefined) {
    app.notice(t('goal 服务未装配（profile 加入 dsh-goal 后可用）'))
    return
  }
  const agent = rec.handle.agent
  const goal = goals.get(agent)
  const [op, ...rest] = (a ?? '').trim().split(/\s+/)
  if (op === '' || op === 'show' || op === 'status') {
    if (goal === undefined) {
      app.notice(t('（无进行中的目标）用法: /goal new <objective>'))
      return
    }
    app.notice(`🎯 ${goal.objective}`)
    app.notice(`${goal.phase}${goal.blockedReason ? ` · 阻塞: ${goal.blockedReason.message}` : ''} · ${goal.roundsStarted} 轮 / 上限 ${goal.maxGoalRounds > 0 ? goal.maxGoalRounds : '∞'} · ${goal.activation === 'armed' ? 'armed' : 'disarmed'}`)
    return
  }
  const ref = goal === undefined ? undefined : { id: goal.id, revision: goal.revision }
  try {
    if (op === 'new' || op === 'create') {
      const objective = rest.join(' ').trim()
      if (objective === '') {
        app.notice(t('用法: /goal new <objective>'))
        return
      }
      goals.create(agent, { objective })
      app.notice(t('目标已创建'))
    } else if (op === 'pause') {
      goals.pause(agent, ref)
      app.notice(t('目标已暂停'))
    } else if (op === 'resume') {
      goals.resume(agent, ref)
      app.notice(t('目标已恢复'))
    } else if (op === 'complete') {
      goals.complete(agent, ref)
      app.notice(t('目标已标记完成'))
    } else if (op === 'clear') {
      goals.clear(agent, ref)
      app.notice(t('目标已清空'))
    } else {
      app.notice(t('用法: /goal [show|new <objective>|pause|resume|complete|clear]'))
    }
  } catch (err) {
    app.notice(`goal 操作失败: ${(err as Error).message}`)
  }
}

/** /plan [on|off|status] — plan mode state. */
const planCommand = (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const planMode = app.svc('planMode')
  if (planMode === undefined) {
    app.notice(t('plan-mode 服务未装配'))
    return
  }
  const arg = (a ?? '').trim()
  const state = planMode.get(rec.handle.agent)
  if (arg === '' || arg === 'status') {
    app.notice(`计划模式: ${state.active ? '开启' : '关闭'}${state.pending ? '（变更待生效）' : ''}`)
    return
  }
  if (arg !== 'on' && arg !== 'off') {
    app.notice(t('用法: /plan [on|off|status]'))
    return
  }
  const r = planMode.set(rec.handle.agent, arg === 'on')
  app.notice(`计划模式: ${arg === 'on' ? '开启' : '关闭'}（${r}）`)
}

/** /tasks [kill <id>] — job registry view / cancel one job. */
const tasksCommand = (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const jobs = app.svc('jobs')
  if (jobs === undefined) {
    app.notice(t('jobs 服务未装配'))
    return
  }
  const arg = (a ?? '').trim()
  if (arg.startsWith('kill ')) {
    const id = arg.slice(5).trim()
    if (id === '') {
      app.notice(t('用法: /tasks kill <job-id>'))
      return
    }
    const r = jobs.kill(id, rec.handle.agent, 'user asked')
    app.notice(r === 'requested' ? `已请求取消 ${id}` : `${id} 已结束`)
    return
  }
  const list = jobs.list(rec.handle.agent)
  if (list.length === 0) {
    app.notice(t('（没有运行中的任务）'))
    return
  }
  const icon = (s: string): string => s === 'running' ? '⏳' : s === 'completed' ? '✓' : s === 'killed' ? '✗' : s === 'failed' ? '⚠' : '·'
  for (const j of list) {
    const elapsed = j.startedAt !== undefined ? ` · ${((Date.now() - j.startedAt) / 1000).toFixed(0)}s` : ''
    app.notice(`${icon(j.status)} ${j.id} ${j.label ?? ''}${elapsed}`)
  }
}

/** /skills [name] — skill catalog; picker → detail float (show_skill). */
const skillsCommand = async (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const skills = app.svc('skills')
  if (skills === undefined) {
    app.notice(t('skills 服务未装配'))
    return
  }
  const arg = (a ?? '').trim()
  try {
    const showSkill = async (name: string) => {
      const def = await skills.get(name, { scope: rec.handle.agent })
      if (def === undefined) {
        app.notice(`未知技能 ${name}`)
        return
      }
      await app.luaCall('require("dsh_tui").show_skill(...)', [{
        name: def.name,
        description: def.description ?? '',
        whenToUse: def.whenToUse ?? '',
        content: def.content ?? '',
      }]).catch(() => {})
    }
    if (arg !== '') {
      await showSkill(arg)
      return
    }
    const list = await skills.list({ scope: rec.handle.agent })
    if (list.length === 0) {
      app.notice(t('（没有可用技能）'))
      return
    }
    const sel = await app.openPicker(t('技能（选择查看详情）'),
      list.map((s) => ({ label: `${s.name} — ${String(s.description ?? '').slice(0, 44)}`, value: s.name })))
    if (sel === null) return
    await showSkill(sel)
  } catch (err) {
    app.notice(`skills 失败: ${(err as Error).message}`)
  }
}

/** /plugins — read-only host loader inventory (official Plugins
 *  settings tab counterpart), rendered in a scrollable float like
 *  /sessions and the other listing commands. */
const pluginsCommand = async (app: App): Promise<void> => {
  const inv = app.svc('pluginInventory')
  if (typeof inv?.list !== 'function') {
    app.notice(t('plugin-inventory 服务未装配（dsh-host-plugin-inventory）'))
    return
  }
  // dsh 0.1.2-alpha.2: list() 改为 async，返回 Promise<PluginInventorySnapshot>。
  const snapshot = await inv.list()
  const entries = snapshot.entries ?? []
  const lines: string[] = ['']
  if (entries.length === 0) {
    lines.push(t('（loader 没有插件条目）'))
  } else {
    for (const e of entries) {
      lines.push(`${e.enabled ? '●' : '○'} ${e.entryId} · ${e.moduleName} · ${e.fiberPhase}`)
    }
  }
  void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('插件清单（只读）'), lines]).catch(() => {})
}

/** /permission [name] — switch the session's permission preset (the
 *  official dsh-permission-presets service: sandbox mode + approval
 *  policy pair; the profile's patch must mount the `permission` row). */
const permissionCommand = async (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const permission = app.svc('permissionPresets')
  if (permission === undefined || typeof permission.set !== 'function') {
    app.notice(t('permission-presets 服务未装配（profile patch 加入 dsh-permission-presets 行）'))
    return
  }
  try {
    const names = [...permission.names]
    if (!a) {
      const current = permission.current(rec.handle.agent.session)
      for (const name of names) {
        const opt = permission.optionOf(name)
        app.notice(`${name}${name === current ? ' ✓（当前）' : ''} · ${opt?.name ?? name}${opt?.description ? `) — ${opt.description}` : ''}`)
      }
      return
    }
    const name = String(a).trim()
    if (!names.includes(name)) {
      app.notice(`未知权限预设 ${name}（可用: ${names.join(' ')})`)
      return
    }
    const opt = permission.optionOf(name)
    const current = permission.current(rec.handle.agent.session)
    // Danger-full-access switch asks for an explicit confirmation first
    // (official client's modal acknowledgement counterpart).
    const danger = /full|danger/i.test(name) || /全|危险/.test(opt?.name ?? '')
    if (danger && name !== current) {
      const ok = await app.openPicker(t('危险权限确认'), [
        { label: '确认切换到全访问（危险操作需谨慎）', value: 'yes' },
        { label: '取消', value: 'no' },
      ])
      if (ok !== 'yes') {
        app.notice(t('已取消权限切换'))
        return
      }
    }
    permission.set(rec.handle.agent.session, name)
    app.notice(`权限预设: ${name}`)
    app.updateStatusline()
  } catch (err) {
    app.notice(`permission 失败: ${(err as Error).message}`)
  }
}

/** Directory picker promise (Lua navigable float → 'dsh-dir-selected'). */
const openDirPicker = (app: App, startPath: string): Promise<string | null> => new Promise((resolve) => {
  app.dirSettle = resolve
  void app.luaCall('require("dsh_tui").show_dir_picker(...)', [startPath ?? process.cwd()])
    .catch(() => { app.dirSettle = null; resolve(null) })
})

/** Format an @-mention: quote paths containing whitespace. */
const formatMention = (path: string): string => (/\s/.test(path) ? `@"${path}"` : `@${path}`)

/** Local fs candidates (fallback when the fileReferences service is
 *  absent): immediate children of the query's dir matching its prefix. */
const localFileCandidates = async (cwd: string, query: string): Promise<Array<{ path: string; mention: string }>> => {
  const q = (query ?? '').replace(/^["']/, '')
  const slash = q.lastIndexOf('/')
  const dirPart = slash >= 0 ? q.slice(0, slash + 1) : ''
  const namePart = slash >= 0 ? q.slice(slash + 1) : q
  const base = isAbsolute(q) ? '' : cwd
  const dirPath = join(base, dirPart || '.')
  const out = []
  try {
    for (const name of readdirSync(dirPath, { withFileTypes: true })) {
      if (namePart !== '' && !name.name.startsWith(namePart)) continue
      const rel = (dirPart + name.name + (name.isDirectory() ? '/' : ''))
      out.push({ path: rel, mention: formatMention(rel) })
    }
  } catch {}
  out.sort((x, y) => x.path < y.path ? -1 : 1)
  return out.slice(0, 50)
}

/** @-completion query from the input line (dsh-at-query notify).
 *  Files first, then @session references (the official client's unified
 *  `@file`/`@session` source, in the same deterministic order). */
const atQuery = async (app: App, query: string): Promise<void> => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  const agent = rec?.handle.agent
  let items: Array<{ path: string; mention: string }> = []
  try {
    const fr = app.svc('fileReferences')
    if (typeof fr?.list === 'function' && agent) {
      const cands = await fr.list(agent, query, new AbortController().signal)
      items = (cands ?? []).map((c) => ({ path: c.path, mention: formatMention(c.path) }))
    } else {
      items = await localFileCandidates(process.cwd(), query)
    }
  } catch {}
  const sessionRef = app.svc('sessionReferenceResolver')
  if (agent !== undefined && typeof sessionRef?.listCandidates === 'function') {
    try {
      const cands = await sessionRef.listCandidates(agent, query, 8, new AbortController().signal)
      for (const c of cands) {
        // Canonical mention: @[label](dsh-session:<base64url(JSON id)>).
        const uri = 'dsh-session:' + Buffer.from(JSON.stringify(c.sessionId), 'utf8').toString('base64url')
        const label = (c.label ?? c.sessionId).replace(/[\[\]]/g, '\\$&')
        items.push({
          path: `💬 ${label}${c.cwd !== undefined && c.cwd !== '' ? ` · ${c.cwd}` : ''}`,
          mention: `@[${label}](${uri})`,
        })
      }
    } catch {}
  }
  await app.luaCall('require("dsh_tui").set_at_menu(...)', [items]).catch(() => {})
}

/** /attach [path] — image → durable attachment; file/dir → @-mention.
 *  Without an argument a directory picker selects the target. */
const attachCommand = async (app: App, a: string | undefined) => {
  let path: string | null = (a ?? '').trim()
  if (path === '') {
    path = await openDirPicker(app, process.cwd())
    if (path === null) return
  }
  const abs = isAbsolute(path) ? path : join(process.cwd(), path)
  const media = sniffMediaType(abs as unknown as Uint8Array)
  if (media !== null) {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
    const attachments = app.svc('attachments')
    if (!rec || typeof attachments?.saveImage !== 'function') {
      app.notice(t('附件服务未装配'))
      return
    }
    try {
      const img = await readImageFile(abs, media)
      const ref = await attachments.saveImage(img)
      app.pendingImages.push({ type: 'image', attachment: ref })
      app.notice(`📎 图片已附加: ${imageLabel(ref)}（随下一条消息发送）`)
    } catch (err) {
      app.notice(`附件失败: ${(err as Error).message}`)
    }
    return
  }
  // Non-image: a path-only @-mention (the official file-reference way —
  // the model reads the file through its tools when needed).
  const rel = isAbsolute(path) ? path : path
  await app.luaCall('require("dsh_tui").append_input(...)', [formatMention(rel) + ' ']).catch(() => {})
  app.notice(`已引用: ${rel}（@ 路径会随消息发送，模型按需读取）`)
}

/** /deliverables — files this session's current turn produced (mutation
 *  tools' follow-along paths, derived from tool/call arguments). */
const deliverablesCommand = async (app: App) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const paths = rec.deliverables?.paths ?? []
  if (paths.length === 0) {
    app.notice(t('本回合还没有产出文件（写/改文件的工具运行后会出现在这里）'))
    return
  }
  const sel = await app.openPicker(t('交付物（Enter 在 nvim 新标签页打开）'),
    paths.map((p) => ({ label: p, value: p })))
  if (sel === null) return
  await app.luaCall('require("dsh_tui").open_file_tab(...)', [sel]).catch(() => {})
}

/** /workflow — live registry view of workflow runs (phases, agents). */
const workflowCommand = (app: App) => {
  if (app.workflowRuns.size === 0) {
    app.notice(t('没有工作流记录（workflow 工具运行后此处显示阶段树）'))
    return
  }
  const lines = []
  for (const run of app.workflowRuns.values()) {
    const elapsed = run.startedAt ? formatElapsed(Date.now() - run.startedAt) : '?'
    lines.push(`◈ ${run.name ?? run.id} · ${run.running ? `运行中 ${elapsed}` : `完成 ${run.stopReason ?? ''}`}`)
    for (const ph of run.phases) {
      lines.push(`  ─ ${ph.title}${ph.startedAt ? ` · ${formatElapsed(Date.now() - ph.startedAt)}` : ''}`)
    }
    for (const ag of run.agents) {
      lines.push(`    ◇ #${ag.seq} ${ag.label}${ag.outcome ? ` · ${ag.outcome}` : ''}`)
    }
    for (const msg of run.logs.slice(-6)) {
      lines.push(`    · ${String(msg).slice(0, 100)}`)
    }
  }
  void app.luaCall('require("dsh_tui").show_lines_float(...)', ['工作流运行', lines]).catch(() => {})
}

/** /settings [edit] — settings overview; `edit` opens settings.yaml in
 *  a new nvim tab (the official document is hot-reloaded). */
const settingsCommand = async (app: App, a: string | undefined) => {
  const settings = app.svc('settings')
  if (settings === undefined) {
    app.notice(t('settings 服务未装配'))
    return
  }
  try {
    const setArg = (a ?? '').trim()
    if (setArg.startsWith('set ')) {
      // /settings set <ns> <key.path> <value> — the namespace is a
      // registered settings section (see the overview); typed value
      // (true/false, number, JSON, else string), nested path into the patch.
      const rest = setArg.slice(4).trim()
      const m = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/)
      if (m === null) {
        app.notice(t('用法: /settings set <ns> <key.path> <value>（ns 见概览，如 agent-default-model）'))
        return
      }
      const ns = m[1]
      const path = m[2].split('.')
      const raw = m[3].trim()
      let value: unknown = raw
      if (raw === 'true') value = true
      else if (raw === 'false') value = false
      else if (raw === 'null') value = null
      else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw)
      else { try { value = JSON.parse(raw) } catch {} }
      const patch: Record<string, unknown> = {}
      let node = patch
      for (let i = 0; i < path.length - 1; i++) {
        node = node[path[i]] = (node[path[i]] as Record<string, unknown> | undefined) ?? {}
      }
      node[path[path.length - 1]] = value
      try {
        if (typeof settings.update !== 'function') throw new Error('update 不可用')
        await settings.update(ns, patch)
        app.notice(`已更新设置 ${ns}.${m[2]} = ${JSON.stringify(value)}`)
      } catch (err) {
        app.notice(`设置更新失败: ${(err as Error).message}`)
      }
      return
    }
    if (setArg === 'edit') {
      const path = await settings.prepareDocument?.()
      if (typeof path !== 'string' || path === '') {
        app.notice(t('settings 文档不可编辑（非文件存储）'))
        return
      }
      await app.luaCall('require("dsh_tui").open_file_tab(...)', [path]).catch(() => {})
      app.notice(`已在 nvim 新标签页打开 settings 文档: ${path}（保存后热重载）`)
      return
    }
    // Official SettingsDescriptor shape: { ns, schema, value, revision,
    // base?, user?, applies, secrets? } — one descriptor per namespace.
    // The overview renders each namespace's resolved value (redacted,
    // pretty-printed) with user-overridden top-level keys starred.
    const desc = (settings.describe?.({ redactSecrets: true }) ?? []) as Array<{
      ns?: unknown; value?: unknown; user?: unknown; revision?: number; applies?: unknown
    }>
    const docPath = await settings.prepareDocument?.().catch(() => undefined)
    const lines = ['settings 文档: ' + (settings.documentPath ?? docPath ?? '（非文件）') + ' · 可写: ' + (settings.writable ? '是' : '否'), '']
    let total = 0
    for (const d of desc) {
      lines.push(`▸ ${String(d.ns ?? '(unnamed)')}${d.applies !== undefined ? ` · ${String(d.applies)}` : ''}${d.revision !== undefined ? ` · rev ${d.revision}` : ''}`)
      const userKeys = d.user !== null && typeof d.user === 'object' ? Object.keys(d.user as Record<string, unknown>) : []
      const valueText = JSON.stringify(d.value, null, 2) ?? String(d.value ?? '')
      for (const line of valueText.split('\n')) {
        if (total++ > 60) break
        const key = line.match(/^\s*"([^"]+)"/)?.[1]
        const starred = key !== undefined && userKeys.includes(key) ? '* ' : '  '
        lines.push(`${starred}${line}`)
      }
      if (total > 60) break
    }
    lines.push('', '常用修改: i/o 在此打开配置文件编辑（保存后热重载）；/settings set <key.path> <value> 即时写入；/model /effort /theme /permission 即时生效')
    void app.luaCall('require("dsh_tui").show_lines_float(...)', ['设置', lines, typeof docPath === 'string' ? docPath : null]).catch(() => {})
  } catch (err) {
    app.notice(`settings 失败: ${(err as Error).message}`)
  }
}

/** /bell [on|off] — terminal bell on turn end (approvals always ring). */
const bellCommand = (app: App, a: string | undefined) => {
  if ((a ?? '').trim() !== '') app.bellOn = String(a).trim() === 'on'
  else app.bellOn = !app.bellOn
  app.notice(`回合结束响铃: ${app.bellOn ? '开' : '关'}`)
}

/** /mcp — MCP tools grouped by server (prefix mcp__<server>__<tool>). */
const mcpCommand = (app: App) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const tools = app.svc('tools')
  if (tools === undefined) {
    app.notice(t('tools 服务未装配'))
    return
  }
  const byServer = new Map()
  for (const s of tools.schemas(rec.handle.agent)) {
    if (!s.name.startsWith('mcp__')) continue
    const server = s.name.slice(5).split('__')[0]
    byServer.set(server, (byServer.get(server) ?? 0) + 1)
  }
  if (byServer.size === 0) {
    app.notice(t('（没有已连接的 MCP server）'))
    return
  }
  for (const [server, count] of byServer) app.notice(`🔌 ${server}: ${count} 个工具`)
}

/** /search <query> — cross-session full-text search → picker → resume. */
const searchCommand = async (app: App, a: string | undefined) => {
  const query = (a ?? '').trim()
  if (query === '') {
    app.notice(t('用法: /search <关键词>（跨会话全文搜索）'))
    return
  }
  const sessionQuery = app.svc('sessionQuery')
  if (sessionQuery === undefined) {
    app.notice(t('session-query 服务未装配（profile 加入 dsh-session-query-sqlite 后可用）'))
    return
  }
  app.notice(`搜索中: ${query}…`)
  try {
    const page = await sessionQuery.searchSessions({
      query,
      eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }],
      limit: 20,
    })
    const hits = page.items ?? []
    if (hits.length === 0) {
      app.notice(t('没有匹配的会话'))
      return
    }
    const sel = await app.openPicker(`搜索结果（${hits.length}）`,
      hits.map((h) => ({
        label: `${String(h.header?.id ?? '?')} · ${String(h.bestMatch?.snippet ?? '').slice(0, 48)}`,
        value: String(h.header?.id),
      })))
    if (sel !== null) await app.selectSession(sel)
  } catch (err) {
    app.notice(`搜索失败: ${(err as Error).message}`)
  }
}

/** /fb up|down [note] — feedback on the last assistant message. */
const feedbackCommand = async (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const feedback = app.svc('messageFeedback')
  if (feedback === undefined) {
    app.notice(t('message-feedback 服务未装配'))
    return
  }
  const [op, ...rest] = (a ?? '').trim().split(/\s+/)
  if (op !== 'up' && op !== 'down' && op !== 'clear') {
    app.notice(t('用法: /fb up|down [备注] | /fb clear'))
    return
  }
  if (rec.lastAssistantMessageId === null || rec.lastAssistantMessageId === undefined) {
    app.notice(t('本会话还没有助手消息可反馈'))
    return
  }
  try {
    if (op === 'clear') {
      const list = await feedback.list({ sessionId: rec.id })
      const item = list.ok ? list.value.items.find((i) => i.messageId === rec.lastAssistantMessageId) : undefined
      if (item !== undefined) await feedback.delete({ sessionId: rec.id, messageId: rec.lastAssistantMessageId, ifVersion: item.version })
      app.notice(t('已清除反馈'))
      return
    }
    const list = await feedback.list({ sessionId: rec.id })
    const item = list.ok ? list.value.items.find((i) => i.messageId === rec.lastAssistantMessageId) : undefined
    const note = rest.join(' ').trim() || undefined
    const r = await feedback.put({
      sessionId: rec.id,
      messageId: rec.lastAssistantMessageId,
      rating: op === 'up' ? 'positive' : 'negative',
      ...(note !== undefined ? { note } : {}),
      ifVersion: item?.version ?? null,
    })
    if (r.ok) app.notice(op === 'up' ? '👍 已反馈' : '👎 已反馈')
    else app.notice(`反馈失败: ${r.error?.code ?? 'unknown'}`)
  } catch (err) {
    app.notice(`反馈失败: ${(err as Error).message}`)
  }
}

const onInput = (app: App, text: string): void => {
  // Queue edit flow: the next submitted line REPLACES the queued message
  // (official client's per-row edit action).
  if (app.pendingQueueEdit !== null) {
    const target = app.pendingQueueEdit
    app.pendingQueueEdit = null
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
    const inbox = rec?.handle.agent.inbox as InboxLike | undefined
    const text0 = text.trim()
    if (text0 === '' || typeof inbox?.replace !== 'function') {
      app.notice(t('已取消编辑（空输入或 inbox 不可用）'))
      return
    }
    try {
      const replaced = inbox.replace(target.messageId, createUserMessage({
        content: [{ type: 'text', text: text0 }],
        source: { kind: 'user' },
      }))
      app.notice(replaced === true ? '排队消息已更新' : '该消息已被处理，无法再编辑')
    } catch (err) {
      app.notice(`编辑排队消息失败: ${(err as Error).message}`)
    }
    return
  }
  // Row-action rename flow: the next submitted line IS the new name
  // (the terminal counterpart of the web's rename dialog).
  if (app.pendingRename !== null) {
    const target = app.pendingRename
    app.pendingRename = null
    const name = text.trim()
    if (name === '') { app.notice(t('已取消重命名（空输入）')); return }
    void (async () => {
      try {
        if (target.kind === 'workspace') {
          const ws = app.svc('workspaceRegistry')
          const ent = ws?.list?.().find((w) => w.id === target.id)
          if (ent?.setTitle === undefined) { app.notice(t('工作区重命名不可用（workspaceRegistry 服务未装配）')); return }
          await ent.setTitle(name)
          app.notice(`工作区已重命名: ${name}`)
        } else {
          const sessionTitle = app.svc('sessionTitle')
          if (sessionTitle === undefined) { app.notice(t('session-title 服务未装配')); return }
          sessionTitle.rename(app.runtimeCtx.sessions.get(target.id), name)
          app.notice(t('会话标题已更新'))
        }
      } catch (err) {
        app.notice(`重命名失败: ${(err as Error).message}`)
      }
    })()
    return
  }
  const trimmed = text.trim()
  if (!trimmed) return
  // Natural-language command routing: plain lines that clearly match a
  // slash-command intent run that command (echoed into the feed); '>'
  // prefixes force chat, questions always go to the agent.
  const nl = matchIntent(trimmed)
  if (nl !== null) {
    if (nl.loose === true) {
      // AMBIGUOUS noun match: the agent decides — the message carries a
      // routing hint and the tui_command tool executes the command when
      // the user really wanted one. Instant routing stays for slash
      // commands, patterns and exact phrases.
      const nlRec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
      if (nlRec === undefined) { send(app, trimmed); return }
      const candidate = `/${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`
      const hint = `（TUI 操作判定：这句话可能是想执行命令 ${candidate}。若确实如此，请调用 tui_command 工具；若只是聊天提问，请正常回答，不要调用工具。）\n${trimmed}`
      nlRec.feed.pushUser(hint, [])
      const q = app.pendingEchoes.get(app.activeId as string) ?? []
      q.push(hint)
      if (q.length > 4) q.shift()
      app.pendingEchoes.set(app.activeId as string, q)
      void followup(app, nlRec, hint)
      return
    }
    const nlRec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
    nlRec?.feed.appendNotice(`→ 命令: /${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`)
    onCommand(app, `/${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`)
    return
  }
  const echoRec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (echoRec !== undefined && app.pendingImages.length === 0 &&
    splitImageDataUrls(trimmed).images.length === 0) {
    echoRec.feed.pushUser(trimmed, [])
    const q = app.pendingEchoes.get(app.activeId as string) ?? []
    q.push(trimmed)
    if (q.length > 4) q.shift()
    app.pendingEchoes.set(app.activeId as string, q)
  }
  send(app, trimmed)
}

const applyModelSelection = async (app: App, next: ModelRef['current']): Promise<void> => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (rec?.modelRef) rec.modelRef.current = next // hot for the active session
  if (rec) rec.model = next.model
  await app.runtimeCtx.agentDefaultModel.saveSelection(next) // persist default
  app.notice(`模型已切换: ${next.provider}/${next.model}${next.reasoningEffort ? ` (${next.reasoningEffort})` : ''}`)
  app.updateStatusline()
}

/** /model [provider/model]: picker without an argument, direct switch with. */
const pickModel = async (app: App, arg: string | undefined): Promise<void> => {
  const sel = app.currentSelection()
  if (arg) {
    const [provider, model] = arg.includes('/') ? arg.split('/') : [sel.provider, arg]
    if (!model) {
      app.notice(`用法: /model [provider/model]`)
      return
    }
    try {
      await applyModelSelection(app, { provider, model, reasoningEffort: sel.reasoningEffort })
    } catch (err) {
      app.notice(`模型切换失败: ${(err as Error).message}`)
    }
    return
  }
  const items = [{ label: `${sel.provider}/${sel.model} · 当前`, value: JSON.stringify(sel), active: true }]
  const picked = await app.openPicker(t('选择模型'), items)
  if (picked === null) return
  try {
    await applyModelSelection(app, JSON.parse(picked))
  } catch (err) {
    app.notice(`模型切换失败: ${(err as Error).message}`)
  }
}

/** /effort [off|high|max|auto] */
const effortCommand = async (app: App, a: string | undefined) => {
  if (!a) {
    app.notice(`当前推理等级: ${app.currentSelection().reasoningEffort ?? 'auto（模型默认）'}`)
    return
  }
  if (!['off', 'high', 'max', 'auto'].includes(a)) {
    app.notice(t('用法: /effort [off|high|max|auto]'))
    return
  }
  const next = { ...app.currentSelection(), reasoningEffort: a === 'auto' ? undefined : a }
  try {
    await applyModelSelection(app, next)
  } catch (err) {
    app.notice(`切换失败: ${(err as Error).message}`)
  }
}

/** /preset [id] — agent presets (标准/PTC/极简/创造 + user roots).
 *  Mirrors the official `agentPresets.select` flow (dsh-host-apiproxy):
 *  a session's composition is fixed once any turn has run, so switching
 *  afterwards is a caller error (agent-preset-locked). On a blank
 *  session the switch must re-link the live agent (recompose) AND record
 *  `agent-preset/selected` in the session log — the log event alone does
 *  not move the running agent. */
const presetCommand = async (app: App, a: string | undefined) => {
  const presets = app.svc('agentPresets')
  if (!presets?.list || typeof presets.recompose !== 'function') {
    app.notice(t('agent-presets 服务未装配（在 profile patch 中加入该行）'))
    return
  }
  try {
    if (!a) {
      for (const p of await presets.list()) app.notice(`${p.id} · ${p.name ?? ''}`)
      return
    }
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
    const agent = rec?.handle.agent
    if (!agent) {
      app.notice(t('没有活动会话，无法切换预设'))
      return
    }
    // Official blank rule (sessionBlank in dsh-host-apiproxy): blank =
    // no `turn/start` event yet. Standalone events like /plan and /goal
    // keep a session blank; any started turn locks the preset, because
    // the history was produced under the old composition's tools.
    if (app.sessionEvents(agent.session).some((e) => e.type === 'turn/start')) {
      app.notice(t('预设已锁定: 会话已开始，官方规则下预设只能在空白会话切换（请新开会话后再试）'))
      return
    }
    const applied = await presets.recompose(agent.ctx, a)
    agent.session.append('agent-preset/selected', { agentPreset: applied.id })
    app.notice(`已切换预设: ${applied.id}`)
  } catch (err) {
    app.notice(`preset 失败: ${(err as Error).message}`)
  }
}

/** /yolo [on|off] — approval policy ask/never. */
const yoloCommand = (app: App, a: string | undefined) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) return
  const policy = a === 'on' ? 'never' : a === 'off' ? 'ask' : rec.policy === 'never' ? 'ask' : 'never'
  try {
    rec.handle.agent.session.append('approval/policy', { policy })
    rec.policy = policy
    app.updateStatusline()
    app.notice(`审批策略: ${policy === 'never' ? 'never（不再询问 · 需要审批的操作自动拒绝）' : 'ask（逐项询问）'}`)
  } catch (err) {
    app.notice(`yolo 失败: ${(err as Error).message}`)
  }
}

/** /config — current runtime summary. */
const configCommand = (app: App) => {
  const sel = app.currentSelection()
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  app.notice(`模型 ${sel.provider}/${sel.model} · effort ${sel.reasoningEffort ?? 'auto'}`)
  app.notice(`权限 ${modeLabel(rec?.mode)} · 审批 ${rec?.policy ?? 'ask'} · 用户配置 ${app.config.loadUserConfig !== false ? '已加载' : '关闭'}`)
  app.notice(`主题覆盖 ${app.config.theme ? Object.keys(app.config.theme).length + ' 组' : '无（跟随 colorscheme）'}`)
}

/** /restart — respawn the dsh command and exit this process. */
const restartCommand = (app: App) => {
  try {
    const next = spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', detached: true })
    next.unref()
    app.notice(t('正在重启…'))
    setTimeout(() => void app.quit(0), 300)
  } catch (err) {
    app.notice(`重启失败: ${(err as Error).message}`)
  }
}

/** /remember <text> — append to .dsh/memory/global.md. */
const rememberCommand = (app: App, a: string | undefined) => {
  if (!a) {
    app.notice(t('用法: /remember <text>'))
    return
  }
  try {
    const dir = join(process.cwd(), '.dsh', 'memory')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'global.md'), `- ${a}\n`)
    app.notice(t('已写入 .dsh/memory/global.md'))
  } catch (err) {
    app.notice(`写入失败: ${(err as Error).message}`)
  }
}

/** /memory [delete <id>] — list / delete project memory files. */
const memoryCommand = (app: App, a: string | undefined) => {
  const dir = join(process.cwd(), '.dsh', 'memory')
  const a0 = a ?? ''
  try {
    if (a0.startsWith('delete ')) {
      const target = a0.slice(7).trim()
      const file = join(dir, target.endsWith('.md') ? target : `${target}.md`)
      if (!existsSync(file)) {
        app.notice(`不存在: ${target}`)
        return
      }
      unlinkSync(file)
      app.notice(`已删除 ${target}`)
      return
    }
    if (!existsSync(dir)) {
      app.notice(t('（无项目记忆）用法: /remember <text> 写入'))
      return
    }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      app.notice(`- ${f}`)
    }
  } catch (err) {
    app.notice(`memory 失败: ${(err as Error).message}`)
  }
}

/** /doctor — terminal capability report. */
const doctorCommand = async (app: App) => {
  let size = null
  try {
    size = await app.luaCall('return { vim.o.columns, vim.o.lines }', [])
  } catch {}
  app.notice(`TERM=${process.env.TERM ?? '?'} · TTY=${process.stdout.isTTY} · Node ${process.version}`)
  app.notice(`终端尺寸 ${size ? `)${size[0]}×${size[1]}` : '?'} · Unicode ✓ · truecolor ${process.env.COLORTERM === 'truecolor' ? '✓' : '按 TERM'}`)
  app.notice(t('诊断建议: 真彩异常时检查 COLORTERM；宽度异常检查 locale/字体'))
}

/** /theme [name] — built-in presets over the colorscheme. */
const themeCommand = (app: App, a: string | undefined) => {
  const presets: Record<string, Record<string, unknown>> = {
    default: {},
    dim: { DshTuiReasoning: { italic: true }, DshTuiNotice: { italic: true } },
    vivid: { DshTuiUser: { bold: true }, DshTuiTool: { italic: true } },
    contrast: { DshTuiUser: { bold: true }, DshTuiTool: { bold: true }, DshTuiError: { bold: true } },
    mono: { DshTuiUser: { underline: true }, DshTuiTool: { underline: true }, DshTuiReasoning: { underline: true } },
  }
  const name = a || 'default'
  const theme = presets[name]
  if (!theme) {
    app.notice(`未知主题 ${name}（可用: ${Object.keys(presets).join(' ')})`)
    return
  }
  void app.luaCall('require("dsh_tui").apply_theme(...)', [theme]).catch(() => {})
  app.notice(`主题: ${name}`)
}

/** /models — provider/model catalog + current selection (official
 *  model-selection settings counterpart). */
const modelsCommand = (app: App): void => {
  const sel = app.currentSelection()
  app.notice(`当前模型: ${sel.provider}/${sel.model}${sel.reasoningEffort ? ` ◎${sel.reasoningEffort}` : ''}`)
  const llm = app.runtimeCtx.get('llm') as LlmService | undefined
  if (llm === undefined) {
    app.notice(t('（llm 服务未装配）'))
    return
  }
  try {
    const live = llm.listProviders?.() ?? []
    const configurable = llm.listConfigurableProviders?.() ?? []
    if (live.length === 0 && configurable.length === 0) {
      app.notice(t('（没有已注册的 provider；用 /settings 查看模型配置）'))
      return
    }
    for (const p of live) app.notice(`● ${String(p.id ?? p.provider ?? '?')} · ${String(p.name ?? '')}`)
    for (const p of configurable) {
      if (live.some((l) => String(l.id ?? l.provider) === String(p.provider))) continue
      app.notice(`○ ${String(p.provider ?? '?')} · ${String(p.displayName ?? '')} · 配置段 ${String(p.settingsNs ?? '?')}`)
    }
  } catch (err) {
    app.notice(`models 失败: ${(err as Error).message}`)
  }
}

/** /context — context composition breakdown (official client's
 *  occupancy ring panel counterpart): ~used/capacity, heuristic
 *  composition rows, claim window. */
const contextCommand = async (app: App): Promise<void> => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const projections = app.svc('sessionProjections')
  if (typeof projections?.stateOf === 'function') {
    try {
      const b = projections.stateOf(rec.handle.agent.session, 'contextBreakdown') as {
        systemTokens?: number; toolsTokens?: number; messageTokens?: number
        claim?: { start?: number; end?: number; tokens?: number }
      } | undefined
      if (b !== undefined) {
        const used = (b.systemTokens ?? 0) + (b.toolsTokens ?? 0) + (b.messageTokens ?? 0)
        const cap = rec.contextWindow
        app.notice(`上下文占用 ≈${formatTokens(used)}${cap !== undefined ? `) / ${formatTokens(cap)} · ${Math.round((used / cap) * 100)}%` : ''}`)
        app.notice(`  system ${formatTokens(b.systemTokens ?? 0)} · tools ${formatTokens(b.toolsTokens ?? 0)} · messages ${formatTokens(b.messageTokens ?? 0)}`)
        if (b.claim !== undefined) {
          app.notice(`  claim ${formatTokens(b.claim.tokens ?? 0)} tokens（seq ${b.claim.start ?? '?'}–${b.claim.end ?? '?'}）`)
        }
        return
      }
    } catch {}
  }
  const usage = rec.lastUsage ?? rec.usage
  app.notice(`上下文占用（按事件折叠）: ${usage !== undefined ? `)◧ ${formatTokens(billedInput(usage))}${rec.contextWindow !== undefined ? `/${formatTokens(rec.contextWindow)}` : ''}` : '暂无数据'}`)
}

/** /locale [zh|en] — switch runner UI language (official client's
 *  locale preference; Lua-side hints stay Chinese for now). */
const localeCommand = (app: App, a: string | undefined): void => {
  const want = (a ?? '').trim()
  if (want === '') {
    app.notice(`语言: ${locale() === 'en' ? 'en' : 'zh'}（/locale zh|en 切换）`)
    return
  }
  if (want !== 'zh' && want !== 'en') {
    app.notice('用法: /locale zh|en')
    return
  }
  setLocale(want)
  app.refreshList()
  void app.refreshCommandCatalog()
  app.updateStatusline()
  app.notice(`语言已切换: ${want}`)
}

/** /status — active session snapshot. */
const statusCommand = (app: App) => {
  const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  app.notice(`${rec.id} · ${rec.title ?? '（无标题）'} · ${rec.status ?? '○ idle'}`)
  app.notice(`模型 ${rec.model ?? '?'} · 权限 ${modeLabel(rec.mode)} · 审批 ${rec.policy ?? 'ask'}`)
}

/** /help — every command in a sessions-style popup, grouped like the
 *  old chat listing and sorted alphabetically within each group; Enter
 *  fills the picked command into the input box (the command completion
 *  menu's Enter logic: type args, a second Enter executes). */
const helpCommand = async (app: App) => {
  const groups = new Map<string, CommandSpec[]>()
  for (const s of app.commandSpecs) {
    const group = s.group ?? t('其他')
    const list = groups.get(group) ?? []
    list.push(s)
    groups.set(group, list)
  }
  const rows: Array<{ label: string; value: string }> = []
  for (const [group, list] of groups) {
    rows.push({ label: `── ${group} ──`, value: `grp:${group}` })
    for (const s of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ label: `  ${s.name}${s.usage ? ` ${s.usage}` : ''} · ${s.desc}`, value: s.name })
    }
  }
  const sel = await app.openPicker(t('全部命令（Enter 填入输入框）'), rows)
  if (sel === null || sel.startsWith('grp:')) return
  await app.luaCall('require("dsh_tui").fill_input(...)', [`${sel} `]).catch(() => {})
}

const onCommand = (app: App, line: string): void => {
  if (line.startsWith('/skills:')) {
    void skillsCommand(app, line.slice('/skills:'.length).trim())
    return
  }
  const m = line.match(/^(\S+)(?:\s+(.*))?$/)
  const name = m?.[1] ?? ''
  const rest = m?.[2] ?? ''
  const spec = app.commandSpecs.find((s) => s.name === name)
  if (spec) {
    // Command fns are async (pickers, session resume, model switch…):
    // a rejection here must surface as a notice + log line — in alpha.4
    // the host's fail-loud turns ANY unhandledRejection into a hard
    // process.exit, which is exactly how "选择会话 → dsh 整个退掉" 表现.
    void Promise.resolve()
      .then(() => spec.fn(rest))
      .catch((err: unknown) => {
        const e = err as Error | undefined
        try {
          appendFileSync(app.errorLogPath,
            `${new Date().toISOString()} 命令 ${name}: ${e?.stack ?? String(err)}\n`)
        } catch {}
        app.notice(`⚠ ${name} 失败: ${e?.message ?? String(err)}`)
      })
  } else app.notice(`未知命令 ${name || line}（/help 查看可用命令）`)
}

// tui_command — the agent-side routing tool: natural-language messages
// that were AMBIGUOUS at the keyword layer reach the agent with a hint;
// when the agent judges them to be UI operations it calls this tool and
// the TUI runs the command. UI-display + safe commands only — quit,
// fork/rewind/archive and destructive actions stay out of reach.
const TUI_COMMAND_WHITELIST = new Set([
  '/help', '/sessions', '/subagents', '/panel', '/plugins', '/todo',
  '/goal', '/memory', '/status', '/context', '/cost', '/queue',
  '/deliverables', '/workflow', '/locale', '/whale', '/bell', '/skills',
  '/dir', '/lines', '/history', '/btw', '/model', '/effort', '/plan',
  '/jobs', '/tasks', '/settings',
])

/** Fill the commands module's App slots and register its commands. */
export function installCommands(app: App): void {
  app.followup = (rec, text, images) => followup(app, rec, text, images)
  app.queueSubagentPrompt = (parentAgent, childId, text) => queueSubagentPrompt(app, parentAgent, childId, text)
  app.send = (text) => send(app, text)
  app.pasteClipboardImage = () => pasteClipboardImage(app)
  app.stopCommand = () => stopCommand(app)
  app.openDirPicker = (startPath) => openDirPicker(app, startPath)
  app.atQuery = (query) => atQuery(app, query)
  app.applyModelSelection = (next) => applyModelSelection(app, next)
  app.pickModel = (arg) => pickModel(app, arg)
  app.onInput = (text) => onInput(app, text)
  app.onCommand = (line) => onCommand(app, line)
  app.helpCommand = () => helpCommand(app)
  app.restartCommand = () => restartCommand(app)

  const specs: CommandSpec[] = [
    { name: '/exit', desc: t('退出 dsh'), usage: t('退出'), group: t('系统'), fn: () => app.quit(0) },
    { name: '/quit', desc: t('退出（/exit 别名）'), usage: t(''), group: t('系统'), fn: () => app.quit(0) },
    { name: '/restart', desc: t('重启 dsh 进程'), usage: t('重启'), group: t('系统'), fn: () => restartCommand(app) },
    { name: '/help', desc: t('弹出全部命令（Enter 填入输入框）'), usage: t(''), group: t('系统'), fn: () => helpCommand(app) },
    { name: '/panel', desc: t('展开/收起活动面板'), usage: t('活动面板'), group: t('系统'), fn: () => app.luaCall('require("dsh_tui").toggle_reasoning()', []).catch(() => {}) },
    { name: '/stop', desc: t('停止当前回合'), usage: t(''), group: t('会话'), fn: () => stopCommand(app) },
    { name: '/steer', desc: t('注入引导指令'), usage: t('<directive>'), group: t('会话'), fn: (a) => steerCommand(app, a) },
    { name: '/model', desc: t('选择/切换模型'), usage: t('[provider/model]'), group: t('模型'), fn: (a) => pickModel(app, a) },
    { name: '/effort', desc: t('推理等级'), usage: t('off|high|max|auto'), group: t('模型'), fn: (a) => effortCommand(app, a) },
    { name: '/preset', desc: t('agent 预设（仅空白会话可切换）'), usage: t('[id]'), group: t('模型'), fn: (a) => presetCommand(app, a) },
    { name: '/yolo', desc: t('审批策略开关'), usage: t('on|off'), group: t('审批'), fn: (a) => yoloCommand(app, a) },
    { name: '/theme', desc: t('内置主题预设'), usage: t('default|dim|vivid|contrast|mono'), group: t('显示'), fn: (a) => themeCommand(app, a) },
    { name: '/config', desc: t('配置摘要'), usage: t('配置'), group: t('信息'), fn: () => configCommand(app) },
    { name: '/status', desc: t('会话快照'), usage: t('会话快照'), group: t('信息'), fn: () => statusCommand(app) },
    { name: '/context', desc: t('上下文组成分解'), usage: t('上下文组成'), group: t('信息'), fn: () => contextCommand(app) },
    { name: '/models', desc: t('模型/供应商目录'), usage: t('模型目录'), group: t('模型'), fn: () => modelsCommand(app) },
    { name: '/doctor', desc: t('终端诊断'), usage: t('终端诊断'), group: t('信息'), fn: () => doctorCommand(app) },
    { name: '/remember', desc: t('写入项目记忆'), usage: t('<text>'), group: t('记忆'), fn: (a) => rememberCommand(app, a) },
    { name: '/memory', desc: t('浏览/删除项目记忆'), usage: t('[delete <id>]'), group: t('记忆'), fn: (a) => memoryCommand(app, a) },
    { name: '/image', desc: t('发送图片附件（识图）'), usage: t('<路径> [提示]'), group: t('会话'), fn: (a) => imageCommand(app, a) },
    { name: '/compact', desc: t('压缩上下文'), usage: t(''), group: t('会话'), fn: () => compactCommand(app) },
    { name: '/goal', desc: t('查看/管理目标'), usage: t('[new <目标>|pause|resume|complete|clear]'), group: t('会话'), fn: (a) => goalCommand(app, a) },
    { name: '/todo', desc: t('添加/查看待办任务'), usage: t('[任务内容]'), group: t('会话'), fn: (a) => todoCommand(app, a) },
    { name: '/plan', desc: t('计划模式开关'), usage: t('[on|off|status]'), group: t('会话'), fn: (a) => planCommand(app, a) },
    { name: '/search', desc: t('跨会话全文搜索'), usage: t('<关键词>'), group: t('会话'), fn: (a) => searchCommand(app, a) },
    { name: '/tasks', desc: t('任务列表/取消'), usage: t('[kill <job-id>]'), group: t('会话'), fn: (a) => tasksCommand(app, a) },
    { name: '/skills', desc: t('技能浏览'), usage: t('[技能名]'), group: t('会话'), fn: (a) => skillsCommand(app, a) },
    { name: '/mcp', desc: t('MCP server 工具统计'), usage: t(''), group: t('信息'), fn: () => mcpCommand(app) },
    { name: '/plugins', desc: t('宿主插件清单（只读）'), usage: t('插件清单'), group: t('信息'), fn: () => pluginsCommand(app) },
    { name: '/locale', desc: t('语言 (zh/en)'), usage: t('[zh|en]'), group: t('系统'), fn: (a) => localeCommand(app, a) },
    { name: '/fb', desc: t('反馈最后一条回答'), usage: t('up|down [备注]'), group: t('会话'), fn: (a) => feedbackCommand(app, a) },
    { name: '/workflow', desc: t('工作流运行视图（阶段树）'), usage: t(''), group: t('会话'), fn: () => workflowCommand(app) },
    { name: '/permission', desc: t('权限预设（沙箱+审批组合）'), usage: t('[name]'), group: t('审批'), fn: (a) => permissionCommand(app, a) },
    { name: '/attach', desc: t('附加文件/目录（图片为附件，其余为 @ 引用）'), usage: t('[路径]'), group: t('会话'), fn: (a) => attachCommand(app, a) },
    { name: '/deliverables', desc: t('本回合交付物（打开产物文件）'), usage: t(''), group: t('信息'), fn: () => deliverablesCommand(app) },
    { name: '/settings', desc: t('设置总览/编辑'), usage: t('[edit]'), group: t('系统'), fn: (a) => settingsCommand(app, a) },
    { name: '/bell', desc: t('回合结束响铃开关'), usage: t('[on|off]'), group: t('系统'), fn: (a) => bellCommand(app, a) },
  ]
  app.registerCommands(specs)

  const toolsSvc = app.ctx.get('tools') as { register?: (tool: unknown) => unknown } | undefined
  if (typeof toolsSvc?.register === 'function') {
    try {
      const safeSpecs = app.commandSpecs.filter((sp) => TUI_COMMAND_WHITELIST.has(sp.name))
      toolsSvc.register(defineTool({
        name: 'tui_command',
        description: [
          'Execute a TUI (terminal UI) command for the user.',
          'Call this ONLY when the user\'s message is a request to operate the TUI itself',
          '(open a panel, list sessions/subagents/plugins, view goal/memory/status/context/cost,',
          'manage the todo list, switch model/effort/plan/locale, browse directories…) —',
          'never for coding questions, file edits, or general conversation.',
          'Commands: ' + safeSpecs.map((sp) => sp.name + (sp.desc ? ' — ' + sp.desc : '')).join('; '),
        ].join(' '),
        parameters: {
          command: {
            type: 'string',
            required: true,
            description: 'command name (WITHOUT the leading slash), one of: ' + safeSpecs.map((sp) => sp.name.slice(1)).join(', '),
          },
          args: {
            type: 'string',
            description: 'optional command argument (e.g. a model id for /model, task text for /todo)',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              executed: { type: 'boolean', required: true },
              command: { type: 'string', required: true },
            },
          },
          render: (_args, value: { executed?: boolean; command?: string }) => [{
            type: 'text',
            text: value.executed === true
              ? `TUI command /${value.command ?? ''} executed.`
              : `TUI command /${value.command ?? ''} NOT executed (not whitelisted).`,
          }],
        },
        async execute(args: { command?: unknown; args?: unknown }) {
          const name = String(args.command ?? '').trim()
          const arg = typeof args.args === 'string' ? args.args.trim() : ''
          if (name === '' || !TUI_COMMAND_WHITELIST.has('/' + name)) {
            return { executed: false, command: name }
          }
          try {
            onCommand(app, '/' + name + (arg !== '' ? ' ' + arg : ''))
            return { executed: true, command: name }
          } catch {
            return { executed: false, command: name }
          }
        },
      }))
    } catch {
      // tools service absent / registration rejected: keyword routing still works
    }
  }
}
