import { t } from './i18n.js';
/** `on`/`off` — a two-valued switch, terminal either way. */
const ON_OFF = [{ kind: 'oneof', values: ['on', 'off'], byValue: { on: [], off: [] } }];
/** Free text with a label; hinted, never completed. */
// `exactOptionalPropertyTypes` is on: an optional key must be ABSENT rather than
// explicitly undefined, hence the conditional spread.
const free = (label, hint) => [
    { kind: 'free', label, ...(hint === undefined ? {} : { hint }) },
];
/** A filesystem path; hinted, never completed (path completion is separate). */
const path = (label = '<路径>') => [{ kind: 'file', label }];
/** A closed set where nothing sensible follows the choice (terminal). */
const closed = (values, hint) => [
    {
        kind: 'oneof',
        values,
        ...(hint === undefined ? {} : { hint }),
        byValue: Object.fromEntries(values.map((v) => [v, []])),
    },
];
/**
 * The grammar of each argument-taking command, keyed by command name.
 *
 * Values come from the command's own parser, not from its `usage` string — the
 * usage line is a summary and is sometimes incomplete (`/fb` also accepts
 * `clear`, which its usage never mentioned).
 */
export const COMMAND_ARGS = {
    // -- closed sets (nothing follows the choice) ---------------------------
    '/difficulty': closed(['easy', 'medium', 'hard', 'auto', 'off']),
    '/effort': closed(['off', 'high', 'max', 'auto']),
    '/layout': closed(['default', 'panel']),
    '/locale': closed(['zh', 'en']),
    '/theme': closed(['default', 'dim', 'vivid', 'contrast', 'mono']),
    '/whale': ON_OFF,
    '/yolo': ON_OFF,
    '/plan': closed(['on', 'off', 'status']),
    '/glance': closed(['cache', 'context', 'tokens', 'cost', 'elapsed', 'total']),
    // -- a choice that opens its own arguments ------------------------------
    '/fb': [
        {
            kind: 'oneof',
            values: ['up', 'down', 'clear'],
            byValue: { up: free('[备注]'), down: free('[备注]'), clear: [] },
        },
    ],
    '/settings': [
        { kind: 'oneof', values: ['edit'], byValue: { edit: [] } },
    ],
    '/goal': [
        {
            kind: 'oneof',
            values: ['new', 'pause', 'resume', 'complete', 'clear'],
            byValue: {
                new: free('<目标>', t('目标描述')),
                pause: [],
                resume: [],
                complete: [],
                clear: [],
            },
        },
    ],
    '/memory': [
        { kind: 'oneof', values: ['delete'], byValue: { delete: free('<id>', t('记忆条目 id')) } },
    ],
    '/tasks': [
        { kind: 'oneof', values: ['kill'], byValue: { kill: free('<job-id>', t('后台任务 id')) } },
    ],
    '/workspace': [
        {
            kind: 'oneof',
            values: ['add', 'delete'],
            byValue: { add: [{ kind: 'file', label: '<目录>' }, ...free('[标题]')], delete: free('<id>') },
        },
    ],
    // `/market` is EITHER the `refresh` keyword OR a free-text query — a union of
    // two positions, so the keyword is offered while anything else is treated as a
    // search term. (Previously written as two flat elements, which would have made
    // `refresh` and the query BOTH required.)
    '/market': [
        {
            kind: 'oneof',
            values: ['refresh'],
            byValue: { refresh: [] },
            hint: t('刷新目录'),
        },
        ...free('[关键词]', t('按关键词搜索；不带参数则列出目录')),
    ],
    // -- free text / paths (hinted, never completed) -------------------------
    '/archive': free('[会话id]'),
    '/attach': path(),
    '/btw': free('<问题>'),
    '/dir': path(),
    '/fork': free('[directive]', t('分支指令（可选）')),
    '/image': [{ kind: 'file', label: '<路径>' }, ...free('[提示]')],
    '/lines': path(),
    '/new': path('[目录]'),
    '/remember': free('<text>'),
    '/rename': free('<新标题>'),
    '/rewind': free('[第N条]', t('回退到第 N 条消息')),
    '/search': free('<关键词>'),
    '/skills': free('[技能名]'),
    '/steer': free('<directive>', t('追加指令')),
    '/todo': free('[任务内容]'),
    // -- names resolved from a service (not completed yet) -------------------
    // These COULD be completed from the live service (model list, permission
    // presets, …). Left as hints on purpose: a wrong candidate list is worse than
    // none, and wiring each service is a separate change.
    '/model': free('[provider/model]', t('模型 id')),
    '/permission': free('[name]', t('权限预设名')),
    '/preset': free('[id]', t('预设 id')),
};
