/**
 * Natural-language command router: non-slash input lines are matched against
 * intent phrases (zh + en) and routed to the corresponding slash command.
 *
 * Guardrails (so real chat messages are not hijacked):
 *  - questions (ending in ？/?) always go to the agent;
 *  - lines starting with > " ' are forced to chat (escape hatch);
 *  - inputs longer than 60 chars are always chat;
 *  - destructive commands (clear/stop/exit/quit/restart/compact/rewind) only
 *    fire on EXACT phrases, never on substring patterns;
 *  - interpretation is echoed into the feed (`→ 命令: /name args`).
 */
const MAP_ONOFF = (v) => (v === '开' || v === '打开' || v === 'on' ? 'on' : 'off');
const MAP_LANG = (v) => (v === '英文' || v === 'english' || v === 'en' ? 'en' : 'zh');
const MAP_EFFORT = (v) => ({ 低: 'off', 关: 'off', 关闭: 'off', off: 'off', 高: 'high', high: 'high', 最高: 'max', max: 'max', 自动: 'auto', auto: 'auto' }[v] ?? v);
const MAP_FB = (v) => (v === '赞' || v === 'up' ? 'up' : 'down');
/** Conversational lead-ins («打开/显示/查看/帮我/切换到…»), bilingual. */
const LEAD_RE = /^(?:请|麻烦|请帮我|帮我|给我|我要|我想|需要|打开|显示|查看|展示|看看|看下|进入|切换到|切到|换成|换到|open|show|display|view|list|switch to|go to|help me|please|i want to|i need to)[:： ]*/i;
const INTENTS = [
    // -- system ---------------------------------------------------------------
    {
        name: 'help',
        exact: [['帮助'], ['命令列表'], ['有哪些命令'], ['指令列表'], ['help'], ['commands'], ['?']],
        contains: ['帮助', '命令', 'help', 'commands'],
    },
    {
        name: 'exit',
        exact: [['退出'], ['退出dsh'], ['退出程序'], ['离开'], ['exit'], ['quit dsh']],
    },
    { name: 'quit', exact: [['quit'], ['q']] },
    { name: 'restart', exact: [['重启'], ['重启dsh'], ['restart']] },
    { name: 'clear', exact: [['清屏'], ['清空屏幕'], ['清空'], ['清屏一下'], ['clear'], ['clear screen'], ['cls']] },
    { name: 'stop', exact: [['停止'], ['停下'], ['停'], ['stop'], ['halt']] },
    { name: 'layout', exact: [['布局'], ['layout']], patterns: [{ re: /^布局[:： ]*(default|panel)$/i, arg: (m) => m[1] }] },
    { name: 'panel', exact: [['活动面板'], ['面板'], ['收起面板'], ['展开面板'], ['panel']], contains: ['面板', 'panel'] },
    { name: 'bell', exact: [['铃声'], ['响铃'], ['bell']], patterns: [{ re: /^(?:铃声|响铃|bell)[:： ]*(on|off|开|关)$/i, arg: (m) => MAP_ONOFF(m[1]) }] },
    { name: 'doctor', exact: [['诊断'], ['终端诊断'], ['体检'], ['doctor']], contains: ['诊断', 'doctor'] },
    // -- sessions --------------------------------------------------------------
    {
        name: 'sessions',
        exact: [['会话列表'], ['切换会话'], ['会话'], ['浏览会话'], ['历史'], ['历史会话'], ['sessions'], ['switch session']],
        contains: ['会话', 'sessions', 'session'],
    },
    {
        name: 'new',
        exact: [['新建会话'], ['新开会话'], ['开个新会话'], ['新会话'], ['new session']],
        patterns: [{ re: /^(?:新建会话|新开会话|开个新会话)[:： ]*(.+)$/i }],
    },
    {
        name: 'rename',
        patterns: [
            { re: /^(?:重命名为|把会话重命名为|会话改名为|改名)[:： ]*(.+)$/i },
            { re: /^重命名[:： ]*(.+)$/i },
            { re: /^rename[:： ]*(.+)$/i },
        ],
    },
    { name: 'fork', exact: [['分叉'], ['分叉会话'], ['分支'], ['fork'], ['branch']], patterns: [{ re: /^(?:分叉|分支)[:： ]*(.+)$/i }] },
    {
        name: 'btw',
        patterns: [{ re: /^(?:侧问|悄悄问|旁路问)[:： ]*(.+)$/i }, { re: /^ask aside[:： ]*(.+)$/i }],
    },
    { name: 'rewind', exact: [['回退'], ['回退会话'], ['回退消息'], ['rewind']] },
    {
        name: 'archive',
        exact: [['归档'], ['archive']],
        patterns: [{ re: /^归档[:： ]*(.+)$/i }],
    },
    {
        name: 'workspace',
        exact: [['工作区'], ['工作区管理'], ['workspace'], ['workspaces']],
        contains: ['工作区', 'workspace'],
        patterns: [
            { re: /^(?:添加|新建)(?:一个)?工作区(?:[:： ]*(.+))?$/i, arg: (m) => (m[1] ? `add ${m[1]}` : undefined) },
            { re: /^删除工作区[:： ]*(.+)$/i, arg: (m) => `delete ${m[1]}` },
        ],
    },
    // -- model ----------------------------------------------------------------
    {
        name: 'model',
        exact: [['换模型'], ['切换模型'], ['选择模型'], ['模型'], ['model']],
        contains: ['模型', 'model'],
        patterns: [
            { re: /^(?:切换|换成|换|用|使用)(?:到)?(?:的)?模型[:： ]*(.+)$/i },
            { re: /^模型[:： ]*(.+)$/i },
            { re: /^(?:切换|换成|用|使用)[:： ]*([a-z0-9._-]+(?:\/[a-z0-9._-]+)*)$/i },
            { re: /^(.+?)[:： ]*模型$/, arg: (m) => {
                    const v = m[1].replace(LEAD_RE, '').trim();
                    return /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i.test(v) ? v : undefined;
                } },
        ],
    },
    {
        name: 'effort',
        patterns: [{ re: /^(?:推理等级|effort)[:： ]*(off|high|max|auto|低|高|最高|自动|关|关闭)$/i, arg: (m) => MAP_EFFORT(m[1]) }],
    },
    { name: 'preset', exact: [['预设'], ['agent预设'], ['preset']], patterns: [{ re: /^预设[:： ]*(.+)$/i }] },
    {
        name: 'models',
        exact: [['模型目录'], ['可用模型'], ['有哪些模型'], ['模型列表'], ['models']],
    },
    // -- approval / display ----------------------------------------------------
    {
        name: 'yolo',
        exact: [['yolo'], ['开启yolo'], ['关闭yolo'], ['yolo on'], ['yolo off']],
        patterns: [{ re: /^yolo[:： ]*(on|off)$/i, arg: (m) => m[1] }],
    },
    { name: 'density', exact: [['紧凑模式'], ['紧凑卡片'], ['density']] },
    { name: 'whale', exact: [['鲸鱼'], ['鲸鱼背景'], ['蓝鲸'], ['背景鲸鱼'], ['whale']] },
    {
        name: 'glance',
        exact: [['状态栏设置'], ['glance']],
        patterns: [{ re: /^状态栏(?:显示|隐藏|开关)[:： ]*(cache|context|tokens|cost|elapsed|total)$/i }],
    },
    {
        name: 'theme',
        exact: [['主题'], ['theme']],
        contains: ['主题', 'theme'],
        patterns: [{ re: /^(?:主题换成|主题改为|切换主题|换主题|主题)[:： ]*(.+)$/i }, { re: /^theme[:： ]*(.+)$/i }],
    },
    // -- info ------------------------------------------------------------------
    { name: 'cost', exact: [['用量'], ['成本'], ['花了多少'], ['用量成本'], ['cost'], ['usage'], ['tokens']], contains: ['用量', '成本', 'cost', 'usage'] },
    { name: 'export', exact: [['导出'], ['导出转录'], ['export']] },
    { name: 'config', exact: [['配置'], ['配置摘要'], ['我的配置'], ['config']], contains: ['配置', 'config'] },
    { name: 'status', exact: [['状态'], ['会话状态'], ['快照'], ['会话快照'], ['status']], contains: ['状态', '快照', 'status'] },
    { name: 'context', exact: [['上下文'], ['上下文占用'], ['上下文组成'], ['context']], contains: ['上下文', 'context'] },
    { name: 'queue', exact: [['消息队列'], ['队列'], ['排队消息'], ['queue']], contains: ['队列', 'queue'] },
    { name: 'plugins', exact: [['插件清单'], ['宿主插件'], ['插件列表'], ['plugins']] },
    { name: 'subagents', exact: [['子代理'], ['子代理列表'], ['subagents']], contains: ['子代理', 'subagent'] },
    { name: 'workflow', exact: [['工作流'], ['工作流状态'], ['工作流视图'], ['workflow']], contains: ['工作流', 'workflow'] },
    { name: 'trajectory', exact: [['步骤轨迹'], ['轨迹'], ['trajectory']], contains: ['轨迹', 'trajectory'] },
    { name: 'deliverables', exact: [['交付物'], ['产物'], ['deliverables']], contains: ['交付物', '产物', 'deliverables'] },
    { name: 'mcp', exact: [['mcp'], ['mcp统计'], ['mcp工具']] },
    {
        name: 'settings',
        exact: [['设置'], ['设置总览'], ['settings']],
        contains: ['设置', 'settings'],
        patterns: [{ re: /^(?:编辑设置|打开设置|设置编辑)$/i, arg: () => 'edit' }],
    },
    {
        name: 'locale',
        exact: [['切换英文', 'en'], ['切换到英文', 'en'], ['english', 'en'], ['切换中文', 'zh'], ['切换到中文', 'zh'], ['中文', 'zh'], ['英文', 'en']],
        contains: ['语言', 'language', 'locale'],
        patterns: [{ re: /^(?:语言|locale)[:： ]*(zh|en|中文|英文)$/i, arg: (m) => MAP_LANG(m[1]) }],
    },
    // -- market ----------------------------------------------------------------
    {
        name: 'market',
        exact: [['插件市场'], ['装插件'], ['market'], ['marketplace'], ['market refresh'], ['插件市场刷新']],
        contains: ['插件', '市场', 'market', 'plugin'],
        patterns: [{ re: /^(?:安装插件|装插件|插件市场)[:： ]*(.+)$/i }],
    },
    // -- memory / goals / plans -------------------------------------------------
    {
        name: 'remember',
        patterns: [{ re: /^(?:记住|记下来)[:： ]*(.+)$/i }],
    },
    {
        name: 'memory',
        exact: [['记忆'], ['我的记忆'], ['记忆库'], ['memory']],
        contains: ['记忆', 'memory'],
        patterns: [{ re: /^记忆删除[:： ]*(.+)$/i, arg: (m) => `delete ${m[1]}` }],
    },
    {
        name: 'goal',
        exact: [['目标'], ['查看目标'], ['goal']],
        contains: ['目标', 'goal'],
        patterns: [{ re: /^(?:新建目标|创建目标|目标)[:： ]*(.+)$/i, arg: (m) => `new ${m[1]}` }],
    },
    {
        name: 'plan',
        exact: [['计划'], ['plan'], ['开启计划'], ['关闭计划']],
        contains: ['计划', 'plan'],
        patterns: [{ re: /^计划[:： ]*(on|off|status)$/i, arg: (m) => m[1] }, { re: /^(?:开启|打开)计划$/i, arg: () => 'on' }, { re: /^关闭计划$/i, arg: () => 'off' }],
    },
    {
        name: 'compact',
        exact: [['压缩'], ['压缩上下文'], ['压缩会话'], ['compact']],
    },
    // -- tools / tasks / search -------------------------------------------------
    {
        name: 'search',
        exact: [['搜索'], ['search']],
        patterns: [{ re: /^(?:搜索|查找|搜)[:： ]*(.+)$/i }],
    },
    {
        name: 'todo',
        exact: [['待办'], ['待办列表'], ['todo'], ['todos']],
        contains: ['待办', 'todo'],
        patterns: [{ re: /^(?:添加|新建|增加|加入)(?:任务|待办)[:： ]*(.+)$/i }],
    },
    { name: 'tasks', exact: [['任务'], ['任务列表'], ['tasks']], contains: ['任务', 'tasks'], patterns: [{ re: /^取消任务[:： ]*(.+)$/i, arg: (m) => `kill ${m[1]}` }] },
    {
        name: 'skills',
        exact: [['技能'], ['技能列表'], ['skills']],
        contains: ['技能', 'skills'],
        patterns: [{ re: /^技能[:： ]*(.+)$/i }],
    },
    {
        name: 'image',
        patterns: [{ re: /^(?:看图|识别图片|分析图片|查看图片|打开图片|看图片)[:： ]*(.+)$/i }],
    },
    {
        name: 'attach',
        patterns: [{ re: /^附加(?:文件|目录)?[:： ]*(.+)$/i }, { re: /^attach[:： ]*(.+)$/i }],
    },
    {
        name: 'permission',
        exact: [['权限'], ['权限预设'], ['permission']],
        contains: ['权限', 'permission'],
        patterns: [{ re: /^权限[:： ]*(.+)$/i }],
    },
    {
        name: 'steer',
        patterns: [{ re: /^(?:引导|注入指令|指令)[:： ]*(.+)$/i }],
    },
    {
        name: 'fb',
        patterns: [{ re: /^(?:反馈|fb)[:： ]*(up|down|赞|踩)(?:[:： ]*(.+))?$/i, arg: (m) => `${MAP_FB(m[1])}${m[2] ? ` ${m[2].trim()}` : ''}` }],
    },
];
/** Exact phrases for destructive commands — used as the `contains` blocklist. */
const DESTRUCTIVE = new Set(['clear', 'stop', 'exit', 'quit', 'restart', 'compact', 'rewind']);
/** One matching pass over the intent table.
 *  `withContains`: allow the loose no-arg substring pass (only after every
 *  arg-capable pattern/exact level failed, so «帮我切换模型 x» keeps its arg). */
function matchOnce(input, withContains) {
    const lower = input.toLowerCase();
    for (const spec of INTENTS) {
        for (const p of spec.patterns ?? []) {
            const m = p.re.exec(input);
            if (m === null)
                continue;
            const arg = p.arg !== undefined ? p.arg(m) : (m[1] ?? '').trim();
            return { name: spec.name, arg: arg === '' ? undefined : arg };
        }
        for (const [phrase, arg] of spec.exact ?? []) {
            if (lower === phrase.toLowerCase())
                return { name: spec.name, arg };
        }
    }
    if (!withContains)
        return null;
    // Loose no-arg phrases: short inputs only, destructive commands excluded.
    if (input.length <= 24) {
        for (const spec of INTENTS) {
            if (DESTRUCTIVE.has(spec.name))
                continue;
            for (const c of spec.contains ?? []) {
                if (lower.includes(c))
                    return { name: spec.name };
            }
        }
    }
    return null;
}
/** Trailing filler nouns («…面板/页面/窗口/列表/菜单/模式…») and 一下. */
const TRAIL_RE = /[:： ]*(?:一下|一下下|面板|页面|窗口|弹窗|列表|菜单|界面|功能|模式|命令|模型|目录|视图|记录|历史)*$/u;
export function matchIntent(raw) {
    const input = raw.trim().replace(/\s+/g, ' ');
    if (input === '' || input.length > 60)
        return null;
    // Questions and forced-chat escapes always reach the agent.
    if (/[？?]$/.test(input))
        return null;
    if (/^[>“”"'“‘]/.test(input))
        return null;
    // Arg-capable passes first (patterns/exact), from most to least specific.
    let hit = matchOnce(input, false);
    if (hit !== null)
        return hit;
    const strippedLead = input.replace(LEAD_RE, '').trim();
    if (strippedLead !== '' && strippedLead !== input) {
        hit = matchOnce(strippedLead, false);
        if (hit !== null)
            return hit;
    }
    const strippedBoth = strippedLead.replace(TRAIL_RE, '').trim();
    if (strippedBoth !== '' && strippedBoth !== strippedLead) {
        hit = matchOnce(strippedBoth, false);
        if (hit !== null)
            return hit;
    }
    // Loose noun hints last («打开帮助面板» → help via 帮助/面板).
    for (const candidate of [input, strippedLead, strippedBoth]) {
        if (candidate === '')
            continue;
        hit = matchOnce(candidate, true);
        if (hit !== null)
            return hit;
    }
    return null;
}
