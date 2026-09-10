/**
 * dsh_tui kernel module: DIFFICULTY-BASED MODEL ROUTING.
 *
 * Picks the model for a user turn by task difficulty:
 *   M1 explicit — `/difficulty easy|medium|hard` pins a tier; `/difficulty
 *     auto` re-arms estimation; `off` disables routing.
 *   M2 rules — deterministic local heuristics (plan mode, goal, tool errors,
 *     keywords, message length). Zero latency/cost.
 *   M3 classifier — optional LLM rating with a cheap model before the main
 *     turn (config `classifier.enabled`); any failure falls back to rules.
 *   M4 subagent policy — optionally syncs the official
 *     `subagent-model-selection` settings gate to the tier routes.
 *
 * Switching mirrors the vision-model temp-switch: the tier selection is
 * applied to `rec.modelRef.current` at send time and restored at turn/end
 * (boot/session-events.ts). The GLOBAL default (agentDefaultModel) is never
 * touched. Manual `/model` disables routing for the session.
 *
 * Config lives in the runner row's config block (HMR):
 *   config.difficultyRouting = { mode, tiers: {easy|medium|hard}, classifier,
 *   subagentPolicy }
 *
 * @module dsh-nvim-tui/kernel/difficulty
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
/** Statusline / notice icons and labels per tier. */
export const TIER_ICONS = { easy: '🟢', medium: '🟡', hard: '🔴' };
const TIER_LABELS = { easy: '简', medium: '中', hard: '难' };
const TIERS = ['easy', 'medium', 'hard'];
/** Hard-task keywords (rule estimator, M2). */
const HARD_PATTERN = /(重构|架构|设计|排查|调试|性能|优化|安全|审查|评审|迁移|并发|死锁|泄漏|漏洞|攻击|注入|兼容|回滚|根因|崩溃|卡死|refactor|architecture|design|debug|optimiz|review|migrat|concurren|deadlock|race|security|vulnerab|rollback|root cause|performance)/i;
/** The WHOLE message is a short acknowledgement → easy. */
const CHATTY_PATTERN = /^(好|好的|行|可以|收到|谢谢|继续|ok|okay|yes|no|嗯|哦|哈|对|是|明白|了解)[！!。.？?～~，, ]*$/i;
function routingConfig(app) {
    const raw = app.config.difficultyRouting;
    if (raw !== null && typeof raw === 'object')
        return raw;
    return {};
}
/** Full selection for a tier (provider/effort omitted = inherit current;
 *  effort 'auto' = clear to the model default). */
function tierRoute(cfg, tier, current) {
    const t = cfg.tiers?.[tier];
    if (t === undefined || typeof t.model !== 'string' || t.model === '')
        return null;
    const provider = typeof t.provider === 'string' && t.provider !== '' ? t.provider : current.provider;
    const route = { provider, model: t.model };
    if (t.effort !== undefined && t.effort !== 'auto')
        route.reasoningEffort = t.effort;
    else if (t.effort === undefined)
        route.reasoningEffort = current.reasoningEffort;
    return route;
}
export function estimateByRules(text, ctx) {
    if (ctx.planActive || ctx.goal || ctx.toolErrors > 0)
        return 'hard';
    const clean = text.trim();
    if (HARD_PATTERN.test(clean))
        return 'hard';
    if (ctx.hasImages)
        return 'medium'; // vision path handles the model; never downgrade images
    if (clean.length >= 600)
        return 'hard';
    if (clean.length <= 30 && (CHATTY_PATTERN.test(clean) || (clean.length <= 12 && !/[?？]/.test(clean))))
        return 'easy';
    return 'medium';
}
const CLASSIFY_PROMPT = (text) => '你是任务难度分类器。评估下面用户任务的难度，只输出一个单词：easy、medium 或 hard。\n\n任务：\n' +
    text.replace(/\s+/g, ' ').slice(0, 400);
async function classifyViaLlm(app, cfg, rec, text, current) {
    const c = cfg.classifier;
    if (c === undefined || c.enabled !== true || typeof c.model !== 'string' || c.model === '')
        return null;
    const llm = app.runtimeCtx.get('llm');
    if (typeof llm?.prepareCall !== 'function')
        return null;
    const provider = typeof c.provider === 'string' && c.provider !== '' ? c.provider : current.provider;
    const timeoutMs = typeof c.timeoutMs === 'number' ? c.timeoutMs : 8000;
    try {
        const signal = AbortSignal.timeout(timeoutMs);
        const prepared = await llm.prepareCall({ provider, model: c.model, signal }, signal);
        const assembler = new BlockAssembler();
        const request = {
            ...prepared.config,
            messages: [createUserMessage({ content: [{ type: 'text', text: CLASSIFY_PROMPT(text) }], source: { kind: 'user' } })],
            sessionId: rec.handle.agent.session.id,
            signal,
        };
        for await (const chunk of prepared.stream(request))
            assembler.push(chunk);
        const out = assembler.blocks()
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .toLowerCase();
        if (/hard|困难|复杂|难/.test(out))
            return 'hard';
        if (/easy|简单|轻松/.test(out))
            return 'easy';
        return 'medium';
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// estimation entry (pin → classifier → rules)
// ---------------------------------------------------------------------------
async function estimateDifficulty(app, rec, text, hasImages) {
    const d = rec.difficulty;
    if (d.enabled !== true)
        return null;
    const cfg = routingConfig(app);
    if (cfg.mode === 'off')
        return null;
    if (d.pinned !== null)
        return { tier: d.pinned, source: 'pin' };
    const current = app.slices.agent.currentSelection();
    const classified = await classifyViaLlm(app, cfg, rec, text, current);
    if (classified !== null)
        return { tier: classified, source: 'classifier' };
    return {
        tier: estimateByRules(text, {
            planActive: rec.planActive,
            goal: rec.goal !== null,
            toolErrors: rec.toolErrors,
            hasImages,
        }),
        source: 'rules',
    };
}
// ---------------------------------------------------------------------------
// M4 — subagent model gate sync (official `subagent-model-selection`)
// ---------------------------------------------------------------------------
function allRoutes(cfg, current) {
    const out = [];
    const seen = new Set();
    for (const tier of TIERS) {
        const r = tierRoute(cfg, tier, current);
        if (r === null)
            continue;
        const key = `${r.provider}\0${r.model}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ provider: r.provider, model: r.model });
    }
    return out;
}
function routesKey(cfg, current) {
    return JSON.stringify(allRoutes(cfg, current).map((r) => `${r.provider}/${r.model}`).sort());
}
async function syncSubagentPolicy(app, cfg, rec, current, enabled) {
    if (cfg.subagentPolicy !== true)
        return;
    const key = enabled ? routesKey(cfg, current) : 'off';
    if (rec.difficulty.syncedRoutesKey === key)
        return;
    const settings = app.runtimeCtx.get('settings');
    if (typeof settings?.update !== 'function')
        return;
    try {
        await settings.update('subagent-model-selection', enabled
            ? { enabled: true, allowedModels: allRoutes(cfg, current) }
            : { enabled: false, allowedModels: [] });
        rec.difficulty.syncedRoutesKey = key;
        app.notice(enabled
            ? '子代理模型闸门已同步为难度档位模型（subagent-model-selection）'
            : '子代理模型闸门已关闭（subagent-model-selection）');
    }
    catch (err) {
        app.notice(`子代理模型策略同步失败: ${err.message}`);
    }
}
// ---------------------------------------------------------------------------
// send-time routing + turn-end restore
// ---------------------------------------------------------------------------
/** Apply one tier switch to the session model (validation + notice +
 *  statusline + subagent-policy sync). `notify` = active session. */
async function applyTierSwitch(app, rec, est, notify) {
    const d = rec.difficulty;
    const cfg = routingConfig(app);
    const current = { ...rec.modelRef.current };
    const route = tierRoute(cfg, est.tier, current);
    if (route === null)
        return;
    // Same route AND same effort = no-op (an effort-only difference still
    // switches — e.g. tiers.hard = { model: <默认>, effort: 'max' }).
    if (route.provider === current.provider && route.model === current.model &&
        (route.reasoningEffort ?? null) === (current.reasoningEffort ?? null))
        return;
    // 0.1.5: verify the tier model exists in the catalog — a missing model
    // would kill the whole turn with NO_ADAPTER instead of degrading.
    const llm = app.runtimeCtx.get('llm');
    if (typeof llm?.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(route.provider, route.model).catch(() => undefined);
        if (info === undefined || info === null) {
            if (notify)
                app.notice(`难度路由跳过: 档位模型 ${route.provider}/${route.model} 不在模型目录中（检查 difficultyRouting.tiers 配置）`);
            return;
        }
    }
    rec.modelRef.current = route;
    rec.model = route.model;
    rec.provider = route.provider;
    d.tier = est.tier;
    d.source = est.source;
    d.tmp = { prev: current, switchAt: Date.now(), tier: est.tier };
    if (notify) {
        const why = est.source === 'pin' ? '手动钉住' : est.source === 'classifier' ? 'LLM 分类' : '规则评估';
        app.notice(`${TIER_ICONS[est.tier]} 难度${TIER_LABELS[est.tier]}（${why}）→ 使用 ${route.provider}/${route.model}${route.reasoningEffort ? ` ◎${route.reasoningEffort}` : ''} · 回合结束切回 ${current.provider}/${current.model}`);
        app.slices.ui.updateStatusline();
    }
    if (cfg.subagentPolicy === true)
        void syncSubagentPolicy(app, cfg, rec, current, true);
}
/** Called by followup() before every main-session send. Never throws. */
export async function routeDifficultyForTurn(app, rec, text, hasImages) {
    try {
        const d = rec.difficulty;
        if (d.enabled !== true)
            return;
        // An image turn is pending (the vision temp switch owns the session
        // model): do NOT layer a difficulty switch — the vision restore at
        // turn/end would clobber it, and the difficulty restore would then
        // land on the vision model. The next message re-estimates normally.
        if (rec.visionTmp !== null)
            return;
        const running = rec.status !== undefined && rec.status.startsWith('● running');
        if (running) {
            // A turn is running: NEVER touch modelRef — the running turn's
            // per-step selection snapshots would silently re-route it mid-turn.
            // Park the estimate (cheap rules; no LLM call for queued messages)
            // and let turn/end apply it for the queued turn after the restores.
            const cfg = routingConfig(app);
            if (cfg.mode === 'off')
                return;
            if (d.pinned !== null) {
                d.pending = { tier: d.pinned, source: 'pin' };
                return;
            }
            d.pending = {
                tier: estimateByRules(text, {
                    planActive: rec.planActive,
                    goal: rec.goal !== null,
                    toolErrors: rec.toolErrors,
                    hasImages,
                }),
                source: 'rules',
            };
            return;
        }
        const est = await estimateDifficulty(app, rec, text, hasImages);
        if (est === null)
            return;
        // A stale switch can linger when the queued turn never ran (its message
        // was cleared via /queue after the turn/end application) — restore it
        // first so the new switch's prev stays the TRUE default selection.
        if (d.tmp !== null) {
            const prev = d.tmp.prev;
            d.tmp = null;
            d.tier = null;
            d.source = null;
            rec.modelRef.current = prev;
            rec.model = prev.model;
            rec.provider = prev.provider;
        }
        await applyTierSwitch(app, rec, est, true);
    }
    catch (err) {
        app.notice(`难度路由失败（本次用默认模型）: ${err.message}`);
    }
}
/** Called at turn/end (after the vision restore). `notify` = active session. */
export function restoreDifficulty(app, rec, notify) {
    const d = rec.difficulty;
    const pending = d.pending;
    d.pending = null;
    if (d.tmp !== null && (rec.lastTurnStartAt ?? 0) >= d.tmp.switchAt) {
        const prev = d.tmp.prev;
        d.tmp = null;
        d.tier = null;
        d.source = null;
        rec.modelRef.current = prev;
        rec.model = prev.model;
        rec.provider = prev.provider;
        if (notify) {
            app.notice(`已切回模型 ${prev.provider}/${prev.model}（难度路由回合结束）`);
            app.slices.ui.updateStatusline();
        }
    }
    // A message was queued while the finished turn ran: apply its parked
    // estimate for the upcoming turn — unless the vision switch owns the
    // model for a queued image turn (the next message re-estimates).
    if (pending !== null && rec.visionTmp === null) {
        void applyTierSwitch(app, rec, pending, notify).catch(() => { });
    }
}
// ---------------------------------------------------------------------------
// /difficulty command ops
// ---------------------------------------------------------------------------
/** Apply /difficulty <arg>. Returns 0..n notice lines. */
export async function applyDifficultyCommand(app, rec, arg) {
    const d = rec.difficulty;
    const cfg = routingConfig(app);
    const current = { ...rec.modelRef.current };
    if (arg === 'off') {
        d.enabled = false;
        d.pinned = null;
        d.pending = null;
        if (d.tmp !== null) {
            const prev = d.tmp.prev;
            d.tmp = null;
            d.tier = null;
            d.source = null;
            rec.modelRef.current = prev;
            rec.model = prev.model;
            rec.provider = prev.provider;
        }
        await syncSubagentPolicy(app, cfg, rec, current, false);
        return ['难度路由已关闭（/difficulty auto 恢复）'];
    }
    d.enabled = true;
    if (arg === 'auto') {
        d.pinned = null;
        return ['难度路由: 自动（规则评估' + (cfg.classifier?.enabled === true ? ' + LLM 分类' : '') + '）'];
    }
    d.pinned = arg;
    const route = tierRoute(cfg, arg, current);
    const routeText = route === null ? '（未配置该档位模型 → 用默认模型）' : `（${route.provider}/${route.model}）`;
    await syncSubagentPolicy(app, cfg, rec, current, true);
    return [`难度钉住: ${TIER_ICONS[arg]} ${TIER_LABELS[arg]}${routeText} · 下一条消息生效，回合结束切回默认`];
}
/** Status lines for bare /difficulty. */
export function difficultyStatusLines(app, rec) {
    const d = rec.difficulty;
    const cfg = routingConfig(app);
    const current = app.slices.agent.currentSelection();
    const lines = [
        `难度路由: ${d.enabled !== true || cfg.mode === 'off' ? '关闭' : '自动'}${d.pinned !== null ? ` · 钉住 ${TIER_ICONS[d.pinned]} ${TIER_LABELS[d.pinned]}` : ''}`,
        `当前回合档位: ${d.tier === null ? '—（默认模型）' : `${TIER_ICONS[d.tier]} ${TIER_LABELS[d.tier]}${d.source !== null ? ` · ${d.source}` : ''}`}`,
        '档位配置:',
    ];
    for (const tier of TIERS) {
        const r = tierRoute(cfg, tier, current);
        lines.push(`  ${TIER_ICONS[tier]} ${TIER_LABELS[tier]} → ${r === null ? '默认模型' : `${r.provider}/${r.model}${r.reasoningEffort ? ` ◎${r.reasoningEffort}` : ''}`}`);
    }
    if (cfg.classifier?.enabled === true) {
        lines.push(`LLM 分类: 开启（${cfg.classifier.provider ?? current.provider}/${cfg.classifier.model ?? '?'}）`);
    }
    if (cfg.subagentPolicy === true)
        lines.push('子代理模型闸门: 同步档位模型');
    lines.push('', '用法: /difficulty [easy|medium|hard|auto|off]');
    return lines;
}
