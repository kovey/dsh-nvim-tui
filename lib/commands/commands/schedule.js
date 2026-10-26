/** dsh_tui command: /schedule — host-durable reminders (dsh-schedule).
 *
 * The host owns the task store, delivery, and the next-run clock; this file is
 * only the TUI surface (list / create / edit / delete / history). A reminder is
 * bound to the ORIGINAL session, so every call passes `rec.id` — never the
 * process cwd or an ambient "current" session. */
import { t, tf } from '../../kernel/i18n.js';
import { promptLine } from '../../kernel/prompt.js';
const TIME_ZONE = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }
    catch {
        return 'UTC';
    }
};
const shortId = (id) => (id.length > 10 ? '…' + id.slice(-8) : id);
const whenText = (record) => {
    const at = new Date(record.scheduledAt);
    return Number.isNaN(at.getTime()) ? record.scheduledAt : at.toLocaleString();
};
const kindLabel = (kind) => {
    switch (kind) {
        case 'after': return t('延时一次');
        case 'at': return t('定时一次');
        case 'every': return t('固定间隔');
        case 'daily': return t('每天');
        case 'weekly': return t('每周');
        case 'cron': return t('Cron');
    }
};
const ruleText = (record) => {
    switch (record.kind) {
        case 'after': return tf('{0} 秒后', [String(record.afterSeconds ?? '?')]);
        case 'every': return tf('每 {0} 秒', [String(record.everySeconds ?? '?')]);
        case 'daily': return tf('每天 {0}（{1}）', [record.time ?? '?', record.timeZone ?? '?']);
        case 'weekly': return tf('每周 {0} {1}（{2}）', [(record.weekdays ?? []).join(','), record.time ?? '?', record.timeZone ?? '?']);
        case 'cron': return tf('{0}（{1}）', [record.expression ?? '?', record.timeZone ?? '?']);
        case 'at': return tf('{0}', [whenText(record)]);
    }
};
const parsePositive = (text) => {
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
};
const parseAt = (text) => {
    const d = new Date(text.trim());
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const normalizeClock = (text) => {
    const v = text.trim();
    return /^\\d{2}:\\d{2}$/.test(v) ? `${v}:00` : v;
};
const createWizard = async (app, sessionId) => {
    const svc = app.svc('schedule');
    if (svc?.create === undefined)
        return;
    const title = await promptLine(app, t('提醒名称（必填）'));
    if (title === null)
        return;
    if (title.trim() === '') {
        app.notice(t('名称不能为空'));
        return;
    }
    const prompt = await promptLine(app, t('提醒内容（到期后发给 agent）'));
    if (prompt === null)
        return;
    if (prompt.trim() === '') {
        app.notice(t('提醒内容不能为空'));
        return;
    }
    const kind = await app.openPicker(t('提醒规则'), [
        { label: t('N 秒后一次'), value: 'after' },
        { label: t('指定时间一次'), value: 'at' },
        { label: t('固定间隔重复'), value: 'every' },
        { label: t('每天'), value: 'daily' },
        { label: t('每周'), value: 'weekly' },
        { label: t('Cron'), value: 'cron' },
    ]);
    if (kind === null)
        return;
    const request = { title: title.trim(), prompt: prompt.trim() };
    const zone = TIME_ZONE();
    if (kind === 'after') {
        const raw = await promptLine(app, t('多少秒后（>0）'), '600');
        if (raw === null)
            return;
        const n = parsePositive(raw);
        if (n === null) {
            app.notice(t('需要正数秒'));
            return;
        }
        request.after_seconds = n;
    }
    else if (kind === 'at') {
        const raw = await promptLine(app, t('时间（ISO/RFC3339，如 2026-10-20T09:00:00+08:00）'));
        if (raw === null)
            return;
        const at = parseAt(raw);
        if (at === undefined) {
            app.notice(t('时间格式无法解析'));
            return;
        }
        request.at = at;
    }
    else if (kind === 'every') {
        const raw = await promptLine(app, t('间隔秒数（>=60）'), '3600');
        if (raw === null)
            return;
        const n = parsePositive(raw);
        if (n === null || n < 60) {
            app.notice(t('间隔至少 60 秒'));
            return;
        }
        request.every_seconds = n;
    }
    else if (kind === 'daily') {
        const time = await promptLine(app, t('本地时间 HH:mm'), '09:00');
        if (time === null)
            return;
        request.daily = { time: normalizeClock(time), time_zone: zone };
    }
    else if (kind === 'weekly') {
        const time = await promptLine(app, t('本地时间 HH:mm'), '09:00');
        if (time === null)
            return;
        const days = await promptLine(app, t('星期几（1=周一 … 7=周日，逗号分隔）'), '1');
        if (days === null)
            return;
        const weekdays = days.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
        if (weekdays.length === 0) {
            app.notice(t('需要至少一个 1–7 的星期'));
            return;
        }
        request.weekly = { time: normalizeClock(time), time_zone: zone, weekdays };
    }
    else if (kind === 'cron') {
        const expr = await promptLine(app, t('五段 cron（分 时 日 月 周）'), '0 9 * * *');
        if (expr === null)
            return;
        request.cron = { expression: expr.trim(), time_zone: zone };
    }
    try {
        const record = await svc.create(sessionId, request);
        app.notice(tf('已创建提醒「{0}」· {1}', [record.title, whenText(record)]));
    }
    catch (err) {
        app.notice(tf('创建提醒失败: {0}', [err.message]));
    }
};
const listRecords = async (app, sessionId) => {
    const svc = app.svc('schedule');
    if (svc?.list === undefined)
        return [];
    try {
        return await svc.list({ sessionId });
    }
    catch {
        return [];
    }
};
const showHistory = async (app, sessionId, record) => {
    const svc = app.svc('schedule');
    if (svc?.history === undefined) {
        app.notice(t('该宿主不支持提醒历史'));
        return;
    }
    try {
        const hist = await svc.history({ sessionId, id: record.id, limit: 20 });
        const items = hist.items ?? [];
        const lines = [tf('「{0}」投递历史', [record.title]), ''];
        if (items.length === 0)
            lines.push(t('（还没有投递记录）'));
        for (const item of items) {
            lines.push(`${item.scheduledAt ?? '?'} → ${item.deliveredAt ?? '?'}`);
            if (typeof item.prompt === 'string' && item.prompt !== '')
                lines.push(`  ${item.prompt}`);
        }
        await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('提醒历史'), lines]).catch(() => { });
    }
    catch (err) {
        app.notice(tf('读取提醒历史失败: {0}', [err.message]));
    }
};
const editRecord = async (app, sessionId, record) => {
    const svc = app.svc('schedule');
    if (svc?.update === undefined) {
        app.notice(t('该宿主不支持编辑提醒'));
        return;
    }
    const title = await promptLine(app, t('提醒名称'), record.title);
    if (title === null)
        return;
    const prompt = await promptLine(app, t('提醒内容'), record.prompt);
    if (prompt === null)
        return;
    try {
        const result = await svc.update({
            sessionId,
            id: record.id,
            expected: record,
            ...(title.trim() !== '' ? { title: title.trim() } : {}),
            ...(prompt.trim() !== '' ? { prompt: prompt.trim() } : {}),
        });
        if (result.updated === true)
            app.notice(tf('已更新「{0}」', [title.trim() || record.title]));
        else
            app.notice(tf('更新未生效: {0}', [result.code ?? 'unknown']));
    }
    catch (err) {
        app.notice(tf('更新提醒失败: {0}', [err.message]));
    }
};
const recordActions = async (app, sessionId, record) => {
    const svc = app.svc('schedule');
    const action = await app.openPicker(tf('提醒「{0}」', [record.title]), [
        { label: t('编辑名称/内容'), value: 'edit' },
        { label: t('查看投递历史'), value: 'history' },
        { label: t('删除'), value: 'delete' },
        { label: t('返回'), value: 'back' },
    ]);
    if (action === null || action === 'back')
        return;
    if (action === 'edit') {
        await editRecord(app, sessionId, record);
        return;
    }
    if (action === 'history') {
        await showHistory(app, sessionId, record);
        return;
    }
    const yes = await app.openPicker(tf('删除「{0}」？', [record.title]), [
        { label: t('确认删除'), value: 'yes' },
        { label: t('取消'), value: 'no' },
    ]);
    if (yes !== 'yes')
        return;
    try {
        await svc?.delete?.({ sessionId, id: record.id });
        app.notice(tf('已删除「{0}」', [record.title]));
    }
    catch (err) {
        app.notice(tf('删除提醒失败: {0}', [err.message]));
    }
};
const showCatalog = async (app) => {
    const svc = app.svc('schedule');
    if (svc?.catalog === undefined) {
        app.notice(t('该宿主不支持任务目录'));
        return;
    }
    try {
        const entries = await svc.catalog();
        const lines = [t('全部提醒（跨会话）'), ''];
        if (entries.length === 0)
            lines.push(t('（没有提醒）'));
        for (const entry of entries) {
            const r = entry.record;
            if (r === undefined)
                continue;
            lines.push(`${r.title} · ${kindLabel(r.kind)} · ${whenText(r)} · ${r.prompt}`);
            if (entry.sessionId !== undefined)
                lines.push(`  session ${shortId(entry.sessionId)}`);
        }
        await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('提醒目录'), lines]).catch(() => { });
    }
    catch (err) {
        app.notice(tf('读取提醒目录失败: {0}', [err.message]));
    }
};
export const scheduleCommand = async (app, a) => {
    const svc = app.svc('schedule');
    if (svc === undefined) {
        app.notice(t('schedule 服务未装配（profile 加入 dsh-schedule 后可用；/deps install 可一键装配）'));
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const arg = (a ?? '').trim();
    const [sub, ...rest] = arg === '' ? [] : arg.split(/\\s+/);
    if (sub === 'new') {
        await createWizard(app, rec.id);
        return;
    }
    if (sub === 'catalog') {
        await showCatalog(app);
        return;
    }
    if (sub === 'delete' && rest[0] !== undefined) {
        const records = await listRecords(app, rec.id);
        const hit = records.find((r) => r.id === rest[0] || shortId(r.id) === rest[0]);
        if (hit === undefined) {
            app.notice(t('找不到该提醒'));
            return;
        }
        try {
            await svc.delete?.({ sessionId: rec.id, id: hit.id });
            app.notice(tf('已删除「{0}」', [hit.title]));
        }
        catch (err) {
            app.notice(tf('删除提醒失败: {0}', [err.message]));
        }
        return;
    }
    if ((sub === 'history' || sub === 'edit') && rest[0] !== undefined) {
        const records = await listRecords(app, rec.id);
        const hit = records.find((r) => r.id === rest[0] || shortId(r.id) === rest[0]);
        if (hit === undefined) {
            app.notice(t('找不到该提醒'));
            return;
        }
        if (sub === 'history')
            await showHistory(app, rec.id, hit);
        else
            await editRecord(app, rec.id, hit);
        return;
    }
    const records = await listRecords(app, rec.id);
    const rows = [
        { label: t('＋ 新建提醒'), value: 'act:new' },
        { label: t('📋 全部提醒目录'), value: 'act:catalog' },
        ...records.map((r) => ({
            label: `${kindLabel(r.kind)} · ${r.title} · ${ruleText(r)} · ${t('下次')} ${whenText(r)}`,
            value: `rec:${r.id}`,
        })),
    ];
    if (records.length === 0)
        rows.push({ label: t('（本会话还没有提醒）'), value: 'act:none' });
    const sel = await app.openPicker(t('本会话提醒（Enter 操作）'), rows);
    if (sel === null || sel === 'act:none')
        return;
    if (sel === 'act:new') {
        await createWizard(app, rec.id);
        return;
    }
    if (sel === 'act:catalog') {
        await showCatalog(app);
        return;
    }
    if (sel.startsWith('rec:')) {
        const record = records.find((r) => r.id === sel.slice(4));
        if (record !== undefined)
            await recordActions(app, rec.id, record);
    }
};
export function installScheduleCommand(app) {
    app.registerCommands([{
            name: '/schedule',
            desc: t('定时提醒（宿主持久化，到期回到本会话）'),
            usage: t('[new | list | delete <id> | edit <id> | history <id> | catalog]'),
            group: t('会话'),
            args: [
                { kind: 'oneof', values: ['new', 'list', 'delete', 'edit', 'history', 'catalog'], hint: t('new=新建；delete/edit/history 需要 id') },
                { kind: 'free', label: '[id]', hint: t('delete/edit/history 的提醒 id') },
            ],
            fn: (x) => scheduleCommand(app, x),
        }]);
}
