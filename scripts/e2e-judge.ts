// Pure judgement helpers for the headless e2e dump (`scripts/e2e.ts`).
//
// Kept separate from the runner so the "did the model actually answer?" rule is
// unit-testable: it previously lived inline with no coverage, and every
// heuristic bug in it (a bare `·` read, an over-broad `· ` filter) only surfaced
// when a real run misjudged. Import from both the runner and the smoke suite.
//
// Run directly to execute its built-in cases:
//   node scripts/e2e-judge.ts

/** The harness's marker for the injected runtime-context block. Literals on
 *  purpose: this module stays free of the plugin's i18n runtime. */
const INJECTED_MARKERS = ['· 注入上下文', '· injected context']

/** Transcript frame prefix on every rendered line. */
const FRAME = /^\s*\|\s?/

/** Error markers that fail a turn. The no-credential path is matched
 *  bilingually: the harness renders '未检测到 API key' in zh mode and
 *  `no API key` in en mode, and a zh-only host once slipped past an
 *  English-only pattern — letting an unauthenticated run report PASS. */
export const ERROR_MARKERS =
  /⚠ |no API key|未检测到\s*API\s*key|未配置\s*API\s*key|API\s*key\s*未(检测到|配置|设置)|UNSUPPORTED_CONTENT|render flush failed|fatal:/i

/** Turn delimiter. NOTE: the closing line is '── turn end ──', so a plain
 *  `indexOf('── turn ──')` also matches INSIDE the closing delimiter — the
 *  search must anchor the whole line. Both the bare form and the '| '-framed
 *  form occur (the transcript frames some marker lines and not others). */
const TURN_START = /^(?:\|\s)?── turn ──$/m
const TURN_END = /^(?:\|\s)?── turn end ──$/

/** Strip the transcript frame and drop blank / closing lines. */
export const turnBody = (afterMarker: string): string[] =>
  afterMarker
    .split('\n')
    .map((l) => l.replace(FRAME, '').trim())
    .filter((l) => l !== '' && !TURN_END.test(l))

/**
 * The turn's real assistant output.
 *
 * Model output is pushed as a block with NO gutter (feed.ts:1017), while the
 * host's runtime-context block renders as '· 注入上下文' plus one gutter line
 * per injected line (feed.ts:728-729). So the block is dropped as a unit —
 * filtering every gutter line instead would reject a real answer that is a
 * '· ' bullet list, i.e. reintroduce the false-negative this guard exists to
 * prevent.
 *
 * Known limit: injected lines and model bullets are byte-identical once the
 * transcript strips indentation, so a dedicated '· ' bullet answer placed
 * immediately after the injected block is indistinguishable from it and is
 * dropped. That errs toward failing a degenerate turn — the safe direction.
 */
export const assistantText = (body: string[]): string[] => {
  const injectedAt = body.findIndex((l) => INJECTED_MARKERS.includes(l))
  let injectedEnd = injectedAt // exclusive; == injectedAt when absent
  if (injectedAt >= 0) {
    injectedEnd = injectedAt + 1
    // A bare '·' counts too: the injected block interleaves blank lines, which
    // render as '·' (the trailing space of '· ' is trimmed). Requiring '· '
    // ended the block early and let the remaining context count as output.
    while (injectedEnd < body.length && body[injectedEnd]!.startsWith('·')) injectedEnd++
  }
  return body.filter((l, i) => {
    // The user's own prompt echo ('> …') is never assistant output; without
    // this the echo alone satisfied the non-empty check, so a turn where the
    // model never answered (missing credentials) reported PASS.
    if (l.startsWith('> ')) return false
    return !(injectedAt >= 0 && i >= injectedAt && i < injectedEnd)
  })
}

/** Judge one e2e dump. `null` = accepted, otherwise the failure reason. */
export const judgeDump = (dump: string): string | null => {
  // Anchor on whole lines: '── turn ──' is a substring of the closing
  // '── turn end ──' delimiter, so an unanchored search finds the wrong one.
  const starts = [...dump.matchAll(new RegExp(TURN_START.source, 'gm'))]
  const last = starts[starts.length - 1]
  if (last === undefined || last.index === undefined) return 'no turn rendered in dump'
  const tail = dump.slice(last.index)
  const afterMarker = tail.slice(last[0].length)
  const kept = assistantText(turnBody(afterMarker))
  if (kept.join('').length === 0) return 'no assistant content (only prompt echo / injected context)'
  if (ERROR_MARKERS.test(tail)) return 'error markers found in the final turn'
  return null
}

/** Render one complete turn (opening marker + framed body + closing marker),
 *  mirroring the transcript's dump shape: marker lines are bare, body lines
 *  carry the '| ' frame. For tests/callers. */
export const frameTurn = (lines: string[]): string =>
  ['', '── turn ──', ...lines.map((l) => `| ${l}`), '── turn end ──'].join('\n')

// -- self-test (only when run directly) -------------------------------------
const isMain =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const cases: Array<[string, string[], boolean]> = [
    ['plain short answer', ['收到'], true],
    ['multi-line answer', ['第一行', '第二行'], true],
    ['markdown table', ['┌──┬──┐', '│ a │ b │', '└──┴──┘'], true],
    ['tool cards', ['🔧 bash({})', '✓ bash · 234ms'], true],
    ['subagent rows', ['◇ subagent x · completed · 0ms'], true],
    ['workflow rows', ['◈ workflow 审计'], true],
    ['todo list', ['📋 待办 3 项', '  ✓ 任务一'], true],
    ['injected context + answer', ['> 你好', '· 注入上下文', '· Current x', '·', '· Approval y', '收到'], true],
    ['regression: pure bullet answer', ['· 第一点', '· 第二点'], true],
    ['regression: no-key, blank injected lines', ['> probe', '· 注入上下文', '· Current x', '·', '· Approval y'], false],
    ['no-key, injected only', ['> probe', '· 注入上下文', '· Current x'], false],
    ['prompt echo only', ['> probe'], false],
  ]
  let bad = 0
  for (const [label, lines, want] of cases) {
    const got = judgeDump(frameTurn(lines)) === null
    if (got !== want) bad++
    console.log(`${got === want ? ' ' : '✗'} ${label.padEnd(36)} ${got ? 'PASS' : 'FAIL'} (want ${want ? 'PASS' : 'FAIL'})`)
  }
  // A turn that answers but also carries an error marker must fail.
  const errCase = frameTurn(['⚠ 回合被中断'])
  const errGot = judgeDump(errCase) !== null
  if (!errGot) bad++
  console.log(`${errGot ? ' ' : '✗'} ${'error marker in turn'.padEnd(36)} ${errGot ? 'FAIL' : 'PASS'} (want FAIL)`)
  console.log(bad ? `\n${bad} case(s) mismatched` : '\nall cases ok')
  process.exit(bad ? 1 : 0)
}
