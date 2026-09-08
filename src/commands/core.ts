/**
 * dsh_tui commands module CORE: the messaging/input chains and the module
 * wiring that every command file shares — send / followup / input routing /
 * model switching / @-completion / the nvim-notification + host-event
 * registrations / the tui_command agent tool. Command DEFINITIONS live in
 * commands/*.ts (one file per command, self-registering); the module index
 * (index.ts) only assembles.
 *
 * @module dsh-nvim-tui/commands
 */
import { appendFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { t } from '../kernel/i18n.js'
import { matchIntent } from './nlcmd.js'
import { activeSessionCwd } from '../kernel/app.js'
import { readClipboardImage, splitImageDataUrls, parseImageDataUrl } from '../feed/images.js'
import { queueSubagentPromptKey } from '../kernel/types.js'
import type { ApprovalRequest, InboxLike, LlmService, MessageContent, SaveImageAttachment } from '../kernel/types.js'
import type { AppSlices, WritableSlice } from '../kernel/app.js'
import { registerHostHandler } from '../kernel/host-events.js'
import { registerNvimNotification } from '../kernel/rpc.js'
const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>
import type { App, ModelRef, SessionRec } from '../kernel/app.js'
import { skillsCommand } from './commands/skills.js'

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
export const followup = async (app: App, rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }> | string>) => {
  if (app.slices.runtime.disposed || rec === undefined) return
  if ((text ?? '').trim() === '' && (images === undefined || images.length === 0)) return
  // Surface the queueing so the message doesn't look lost. (Use /btw to
  // fork a side session instead.)
  if (rec.status !== undefined && rec.status.startsWith('● running')) {
    app.slices.ui.activeFeed()?.appendNotice('已排队：当前回合结束后处理')
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
    const sel = app.slices.agent.currentSelection()
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
      app.slices.ui.updateStatusline()
    } else if (rec.visionTmp !== null) {
      // Another image message queued while an image turn is still pending:
      // extend the switch window so the restore happens after THIS turn too
      // (otherwise the second image turn runs on the restored text model).
      rec.visionTmp.switchAt = Date.now()
    }
    const max = attachments.imageLimits?.maxImagesPerMessage ?? 4
    if (images.length > max) {
      app.notice(`最多附带 ${max} 张图片，已截断`)
      images = images.slice(0, max)
    }
    try {
      for (const img of images) {
        // Already-durable attachment refs (queued via /attach) pass through;
        // raw images (clipboard / parsed data URLs) are saved here.
        const existing = (img as { attachment?: unknown } | undefined)?.attachment
        if (existing !== undefined) {
          content.push({ type: 'image', attachment: existing })
          continue
        }
        const saved = await attachments.saveImage(img as SaveImageAttachment)
        content.push({ type: 'image', attachment: saved })
      }
    } catch (err) {
      // Roll the temporary vision switch back so a failed attach never
      // leaves the session parked on the vision model.
      if (rec.visionTmp !== null) {
        const prev = rec.visionTmp.prev
        rec.modelRef.current = prev
        rec.model = prev.model
        rec.visionTmp = null
        app.slices.ui.updateStatusline()
      }
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
export const queueSubagentPrompt = async (app: App, parentAgent: unknown, childId: string, text: string) => {
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

export const send = (app: App, text: string) => {
  if (app.slices.runtime.disposed) return
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.slices.agent.pendingInput.push(text)
    return
  }
  // /subagents → 继续对话: this input line goes to the continuable child
  // through the official host prompt queue (parent-authority check
  // built in) instead of the main agent.
  if (app.slices.agent.pendingSubagentFollowup !== null) {
    const target = app.slices.agent.pendingSubagentFollowup
    W(app.slices.agent).pendingSubagentFollowup = null
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
  // URLs are parsed into the SaveImageAttachment contract ({data,mediaType})
  // BEFORE followup — the attachments service receives bytes, never strings.
  const { text: clean, images } = splitImageDataUrls(text)
  const parsed: Array<SaveImageAttachment> = []
  for (const url of images) {
    const p = parseImageDataUrl(url)
    if (p !== null) parsed.push(p)
  }
  // Clipboard images queued via <C-v> ride along with the submitted text.
  const all = [...parsed, ...app.slices.agent.pendingImages]
  W(app.slices.agent).pendingImages = []
  void followup(app, rec, clean, all)
}

/** <C-v> handler: queue the macOS clipboard image for the next submit. */
export const pasteClipboardImage = (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
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
  app.slices.agent.pendingImages.push(image)
  app.notice(`📎 已附加剪贴板图片（共 ${app.slices.agent.pendingImages.length} 张，回车随消息发送；/image clear 清空）`)
}

/** /stop — abort the active turn (agent.cancel with a user cause). */
export const stopCommand = (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
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

/** Directory picker promise (Lua navigable float → 'dsh-dir-selected'). */
export const openDirPicker = (app: App, startPath: string): Promise<string | null> => new Promise((resolve) => {
  if (app.slices.agent.dirSettle !== null) app.slices.agent.resolveDirPicker(null)
  W(app.slices.agent).dirSettle = resolve
  void app.luaCall('require("dsh_tui").show_dir_picker(...)', [startPath ?? process.cwd()])
    .catch(() => { W(app.slices.agent).dirSettle = null; resolve(null) })
})

/** Format an @-mention: quote paths containing whitespace. */
export const formatMention = (path: string): string => (/\s/.test(path) ? `@"${path}"` : `@${path}`)

/** Local fs candidates (fallback when the fileReferences service is
 *  absent): immediate children of the query's dir matching its prefix. */
export const localFileCandidates = async (cwd: string, query: string): Promise<Array<{ path: string; mention: string }>> => {
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
export const atQuery = async (app: App, query: string, start = 0): Promise<void> => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  const agent = rec?.handle.agent
  let items: Array<{ path: string; mention: string }> = []
  try {
    const fr = app.svc('fileReferences')
    if (typeof fr?.list === 'function' && agent) {
      const cands = await fr.list(agent, query, new AbortController().signal)
      items = (cands ?? []).map((c) => ({ path: c.path, mention: formatMention(c.path) }))
    } else {
      items = await localFileCandidates(activeSessionCwd(app), query)
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
  await app.luaCall('require("dsh_tui").set_at_menu(...)', [items, start]).catch(() => {})
}

export const onInput = (app: App, text: string): void => {
  // Queue edit flow: the next submitted line REPLACES the queued message
  // (official client's per-row edit action).
  if (app.slices.agent.pendingQueueEdit !== null) {
    const target = app.slices.agent.pendingQueueEdit
    W(app.slices.agent).pendingQueueEdit = null
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
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
  if (app.slices.agent.pendingRename !== null) {
    const target = app.slices.agent.pendingRename
    W(app.slices.agent).pendingRename = null
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
          const live = app.runtimeCtx.sessions.get(target.id)
          if (live === undefined) { app.notice(t('会话已不在线（可能已退出或未成功恢复），无法重命名')); return }
          sessionTitle.rename(live, name)
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
      const nlRec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
      if (nlRec === undefined) { send(app, trimmed); return }
      const candidate = `/${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`
      const hint = `（TUI 操作判定：这句话可能是想执行命令 ${candidate}。若确实如此，请调用 tui_command 工具；若只是聊天提问，请正常回答，不要调用工具。）\n${trimmed}`
      nlRec.feed.pushUser(hint, [])
      const q = app.slices.ui.pendingEchoes.get(app.slices.sessions.activeId as string) ?? []
      q.push(hint)
      if (q.length > 16) q.shift()
      app.slices.ui.pendingEchoes.set(app.slices.sessions.activeId as string, q)
      void followup(app, nlRec, hint)
      return
    }
    const nlRec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
    nlRec?.feed.appendNotice(`→ 命令: /${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`)
    onCommand(app, `/${nl.name}${nl.arg !== undefined ? ` ${nl.arg}` : ''}`)
    return
  }
  const echoRec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (echoRec !== undefined && app.slices.agent.pendingImages.length === 0 &&
    splitImageDataUrls(trimmed).images.length === 0) {
    echoRec.feed.pushUser(trimmed, [])
    const q = app.slices.ui.pendingEchoes.get(app.slices.sessions.activeId as string) ?? []
    q.push(trimmed)
    if (q.length > 16) q.shift()
    app.slices.ui.pendingEchoes.set(app.slices.sessions.activeId as string, q)
  }
  send(app, trimmed)
}

export const applyModelSelection = async (app: App, next: ModelRef['current']): Promise<void> => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (rec?.modelRef) rec.modelRef.current = next // hot for the active session
  if (rec) rec.model = next.model
  await app.runtimeCtx.agentDefaultModel.saveSelection(next) // persist default
  app.notice(`模型已切换: ${next.provider}/${next.model}${next.reasoningEffort ? ` (${next.reasoningEffort})` : ''}`)
  app.slices.ui.updateStatusline()
}

export const onCommand = (app: App, line: string): void => {
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

export const TUI_COMMAND_WHITELIST = new Set([
  '/help', '/sessions', '/subagents', '/panel', '/plugins', '/todo',
  '/goal', '/memory', '/status', '/context', '/cost', '/queue',
  '/deliverables', '/workflow', '/locale', '/whale', '/bell', '/skills',
  '/dir', '/lines', '/history', '/btw', '/model', '/effort', '/plan',
  '/tasks', '/settings',
])

/** Register the agent-side tui_command routing tool (whitelisted UI/safe
 *  commands only — quit/fork/rewind/archive and destructive actions stay
 *  out of reach). */
export function registerTool(app: App): void {
  const toolsSvc = app.ctx.get('tools') as { register?: (tool: unknown) => unknown } | undefined
  if (typeof toolsSvc?.register === 'function') {
    try {
      const safeSpecs = app.commandSpecs.filter((sp) => TUI_COMMAND_WHITELIST.has(sp.name))
      void Promise.resolve(toolsSvc.register(defineTool({
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
      }))).catch(() => {
        // registration rejected asynchronously: keyword routing still works
      })
    } catch {
      // tools service absent / registration rejected: keyword routing still works
    }
  }
}

/** nvim notifications this module owns (dispatched by boot via rpc.ts). */
export function registerNotifications(): void {
  // -- nvim notifications this module owns (dispatched by boot via rpc.ts) --
  registerNvimNotification('dsh-input', '输入处理', (app, args) => {
    const raw = String(args?.[0] ?? '')
    // Card INPUT actions claim the next input: it belongs to the card,
    // not the agent (interception sits BEFORE the tui:input broadcast,
    // so ext subscribers never see card inputs as chat input).
    if (app.slices.ext.pendingCardInput !== null) {
      const pending = app.slices.ext.pendingCardInput
      app.slices.ext.setPendingCardInput(null)
      const text = raw.trim()
      if (text === '') {
        app.notice('已取消卡片输入')
        return
      }
      const feed = app.slices.ui.activeFeed()
      const r = feed === undefined ? null : feed.resolveCardAction(pending.mark, pending.actionIdx)
      if (r === null || r.action === undefined) {
        app.notice('⚠ 卡片已失效，输入已取消')
        return
      }
      try {
        feed!.fireCardAction(r.cardId, text)
      } catch (err) {
        app.notice(`⚠ 卡片操作失败: ${(err as Error).message}`)
      }
      return
    }
    app.slices.ext.extFire('tui:input', { text: raw })
    try { app.slices.agent.onInput(raw) } catch (err) { app.notice(`⚠ 输入处理失败: ${(err as Error).message}`) }
  })
  registerNvimNotification('dsh-command', '命令', (app, args) => {
    // A pending card INPUT claims the next submission even when it starts
    // with '/' (the Lua side routes slash-lines to dsh-command) — route it
    // through the same interception as dsh-input instead of executing it.
    if (app.slices.ext.pendingCardInput !== null) {
      try { app.slices.agent.onInput(String(args?.[0] ?? '')) } catch { /* handled inside */ }
      return
    }
    try { app.slices.agent.onCommand(String(args?.[0] ?? '')) } catch (err) { app.notice(`⚠ 命令失败: ${(err as Error).message}`) }
  })
  registerNvimNotification('dsh-abort', '中止', (app) => {
    // <C-c> in the input box: same path as /stop.
    app.slices.agent.stopCommand()
  })
  registerNvimNotification('dsh-approval-decided', '审批', (app, args) => {
    const raw = String(args?.[0] ?? 'n')
    if (raw === 'always') {
      // dsh has no allow-always grant (one-shot vocabulary only), so
      // "always" switches the session to AUTOMATIC mode: approval
      // policy 'never' — stop prompting, auto-decide from now on
      // (the harness fails closed: such requests are auto-rejected).
      // This request is the last one decided interactively.
      const sid = app.slices.agent.approvalReq?.agent?.session?.id
      if (sid !== undefined) {
        const rec = app.slices.sessions.live.get(sid)
        if (rec) {
          try {
            rec.handle.agent.session.append('approval/policy', { policy: 'never' })
            rec.policy = 'never'
            app.slices.ui.updateStatusline()
            rec.feed.appendNotice('已切换自动审批模式（never）：不再弹窗询问，需要审批的操作将自动拒绝（/yolo off 恢复逐项询问）')
          } catch { /* policy switch is best-effort */ }
        }
      }
      app.slices.agent.settleApproval('allowed-once')
    } else {
      app.slices.agent.settleApproval(raw === 'y' ? 'allowed-once' : 'rejected')
    }
    app.slices.agent.setApproval(null, null)
  })
  registerNvimNotification('dsh-questions-answered', '提问', (app, args) => {
    const answers = (args?.[0] ?? []) as unknown[]
    app.slices.agent.questionsResolve?.resolve({ answers })
    app.slices.agent.setQuestions(null)
  })
  registerNvimNotification('dsh-questions-cancelled', '提问', (app) => {
    const reject = app.slices.agent.questionsResolve
    app.slices.agent.setQuestions(null)
    reject?.reject(new Error('cancelled by user'))
  })
  registerNvimNotification('dsh-picker-selected', '选择', (app, args) => {
    app.slices.agent.settlePicker((args?.[0] ?? null) as string | null)
  })
  registerNvimNotification('dsh-picker-cancelled', '选择', (app) => {
    app.slices.agent.settlePicker(null)
  })
  registerNvimNotification('dsh-dir-selected', '目录选择', (app, args) => {
    const picked = args?.[0] as string | null | undefined
    // resolveDirPicker self-clears the slot — no follow-up setDirSettle needed.
    app.slices.agent.resolveDirPicker(picked ?? null)
  })
  registerNvimNotification('dsh-at-query', '文件引用补全', (app, args) => {
    const payload = (args?.[0] ?? {}) as { query?: unknown; start?: unknown }
    const query = String(payload.query ?? '')
    const start = Number(payload.start ?? 0)
    return app.slices.agent.atQuery(query, start)
  })
  registerNvimNotification('dsh-paste-image', '图片粘贴', (app) => {
    app.slices.agent.pasteClipboardImage()
  })
  registerNvimNotification('dsh-open-failed', '打开文件', (app, args) => {
    // nvim-side open_file_tab (tabedit) failed: /dir、/deliverables、/settings
    // all open files in a fresh tab — surface the failure instead of
    // silently ignoring the notification (previously unhandled).
    const path = String(args?.[0] ?? '')
    app.notice(`⚠ 打开文件失败: ${path}`)
  })
}

/** host events this module owns (wired by boot via host-events.ts). */
export function registerHostEventHandlers(): void {
  // -- host events this module owns (wired by boot via host-events.ts) ----
  // Approval requests: show the floating window and decide.
  registerHostHandler('approval/request', (app, req, next) => {
    const request = req as ApprovalRequest
    const proceed = next as () => unknown
    if (app.slices.runtime.disposed) return proceed()
    return new Promise((resolve) => {
      let settled = false
      const cleanup = () => {
        request.signal?.removeEventListener?.('abort', onAbort)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        app.slices.agent.setApproval(null, null)
        resolve('cancelled')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      app.slices.agent.setApproval(request, (outcome) => {
        if (settled) return
        settled = true
        cleanup()
        app.slices.agent.setApproval(null, null)
        resolve(outcome)
      })
      const sid = request.agent?.session?.id
      const rec = sid === undefined ? undefined : app.slices.sessions.live.get(sid)
      rec?.feed.appendNotice(`⚠ 审批请求: ${request.toolName ?? '?'}${request.reason ? ` — ${request.reason}` : ''}`)
      // Approvals always ring — attention is required, bell toggle or not.
      void app.luaCall('require("dsh_tui").bell()', []).catch(() => {})
      void app.luaCall('require("dsh_tui").show_approval(...)', [{
        toolName: request.toolName ?? '',
        reason: request.reason ?? '',
      }]).catch(() => {
        if (!settled) {
          settled = true
          cleanup()
          app.slices.agent.setApproval(null, null)
          resolve('rejected')
        }
      })
    })
  })
  // User questions: claim the host's `user-questions/request` waterfall
  // as the interactive answerer (dsh 0.1.2-alpha.2: registerProvider was
  // removed in favor of the scoped cordis waterfall).
  registerHostHandler('user-questions/request', (app, request, next) => {
    const req = request as { questions?: unknown[]; signal?: { addEventListener: (ev: string, cb: () => void, opts?: unknown) => void } }
    const proceed = next as () => unknown
    if (app.slices.runtime.disposed) return proceed()
    return new Promise((resolve, reject) => {
      app.slices.agent.setQuestions({ resolve, reject })
      req.signal?.addEventListener('abort', () => {
        if (app.slices.agent.questionsResolve) {
          const r = app.slices.agent.questionsResolve
          app.slices.agent.setQuestions(null)
          r.reject(new Error('cancelled by caller'))
        }
      }, { once: true })
      void app.luaCall('require("dsh_tui").show_questions(...)', [req.questions ?? []])
        .catch(() => {
          if (app.slices.agent.questionsResolve) {
            const r = app.slices.agent.questionsResolve
            app.slices.agent.setQuestions(null)
            r.reject(new Error('no UI'))
          }
        })
    })
  })
}

/** Boot-phase drain (moved out of boot): input that arrived before the
 *  first agent was ready. */
export function drainPendingInput(app: App): void {
  if (app.slices.agent.pendingInput.length > 0) {
    const queued = app.slices.agent.pendingInput.splice(0)
    for (const text of queued) app.slices.agent.send(text)
  }
}
