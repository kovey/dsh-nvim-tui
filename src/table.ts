/**
 * Markdown table → box-drawing table rendering (Claude-TUI style).
 *
 * Detects GFM table blocks (header | separator | body) in a line array and
 * replaces them with aligned, bordered rows:
 *
 *   ┌─────────┬────┬─────┐
 *   │ 日期    │ AQI│ 等级│   <- the WHOLE table bold (DshTuiBold):
 *   ├─────────┼────┼─────┤      cells, │ separators, ─ borders and corners
 *   │ 今天    │ 29 │ 🟢  │      alike (uniform stroke weight)
 *   └─────────┴────┴─────┘
 *
 * Column widths use DISPLAY width (CJK/emoji count 2), so the borders line up
 * in nvim's grid. While the tail is still streaming (`streamOpen`), an open
 * block at the end of the view omits its bottom border and gains it once the
 * stream closes.
 *
 * @module dsh-nvim-tui/table
 */
import stringWidth from 'string-width'

/** One rendered table row (or a table-false passthrough entry). */
export type TableEntry =
  | { table: true; text: string; group: string | null; spans: Array<{ s: number; e: number; group: string }> }
  | { table: false; raw: string }

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line)
const isSeparator = (line: string): boolean => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line)

/** Strip inline emphasis from one cell: models frequently wrap table cells
 *  in `**…**` or `` `…` `` — inside a bordered table the markers would show
 *  literally, so drop them (the whole table is bold anyway). */
function stripCellMarkup(text: string): string {
  return (text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s+|\s+$/g, '')
}

function splitCells(line: string): string[] | null {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return null
  return t.slice(1, -1).split('|').map(stripCellMarkup)
}

/** One bordered row with per-cell bold spans. */
interface RenderedRow {
  text: string
  group: string | null
  spans: Array<{ s: number; e: number; group: string }>
}

/**
 * Render one validated table block (header + separator + body lines).
 * @param {string[]} block raw table lines (block[1] is the separator)
 * @param {boolean} closed whether to draw the bottom border
 */
function renderTable(block: string[], closed: boolean): RenderedRow[] {
  const header = splitCells(block[0] ?? '') ?? []
  const seps = splitCells(block[1] ?? '') ?? []
  const body = block.slice(2).map((l) => splitCells(l) ?? [])
  const cols = Math.max(header.length, seps.length, ...body.map((r) => r.length))
  const aligns = Array.from({ length: cols }, (_, c) => {
    const s = (seps[c] ?? '').trim()
    if (s.startsWith(':') && s.endsWith(':')) return 'center'
    if (s.endsWith(':')) return 'right'
    if (s.startsWith(':')) return 'left'
    return 'auto'
  })
  // Numeric columns default to right alignment.
  for (let c = 0; c < cols; c++) {
    if (aligns[c] === 'auto' && body.length > 0 &&
      body.every((r) => r[c] !== undefined && /^-?[\d.,]+$/.test(r[c].trim()))) {
      aligns[c] = 'right'
    }
  }
  const rows = [header, ...body]
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...rows.map((r) => stringWidth(r[c] ?? ''))))

  const cell = (text: string, c: number): string => {
    const w = widths[c] ?? 0
    const padTotal = w - stringWidth(text ?? '')
    const align = aligns[c] === 'auto' ? 'left' : aligns[c]
    if (align === 'right') return ' ' + ' '.repeat(padTotal) + (text ?? '') + ' '
    if (align === 'center') {
      return ' ' + ' '.repeat(Math.floor(padTotal / 2)) + (text ?? '') +
        ' '.repeat(Math.ceil(padTotal / 2)) + ' '
    }
    return ' ' + (text ?? '') + ' '.repeat(padTotal) + ' '
  }
  const border = (l: string, m: string, r: string): string =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r
  /**
   * One bordered data row. The WHOLE table renders bold (uniform stroke
   * weight): every row — cells, `│` separators, padding — carries a
   * full-row DshTuiBold group, and the border rows (─ corners junctions)
   * carry the same group. The old style (per-cell bold spans + dim borders)
   * left `─`/corners visually thinner than `│`, so the frame looked
   * half-bold; uniform bold everywhere fixes the mismatch.
   */
  const row = (cells: string[]): RenderedRow => ({
    text: '│' + cells.map((t, c) => cell(t, c)).join('│') + '│',
    group: 'DshTuiBold',
    spans: [],
  })

  const out: RenderedRow[] = [
    { text: border('┌', '┬', '┐'), group: 'DshTuiBold', spans: [] },
    row(header),
    { text: border('├', '┼', '┤'), group: 'DshTuiBold', spans: [] },
  ]
  for (const r of body) out.push(row(r))
  if (closed) out.push({ text: border('└', '┴', '┘'), group: 'DshTuiBold', spans: [] })
  return out
}

/**
 * Detect table blocks across raw view lines (fence-aware) and return the
 * FINAL output entry stream: one entry per OUTPUT line (a table block expands
 * to bordered lines — more entries than raw lines), or `{table:false, raw}`
 * for lines that parse normally.
 * @param {string[]} lines raw view lines
 * @param {boolean} streamOpen whether the last line may still grow
 * @param {number} trailingStatic number of trailing non-content rows (the
 *   feed's transient activity lines) that must not count as content after a
 *   table block — the open-table check ignores them.
 */
export function transformTables(lines: string[], streamOpen = false, trailingStatic = 0): TableEntry[] {
  const out: TableEntry[] = []
  let fenceOpen = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (/^\s*```/.test(line)) {
      fenceOpen = !fenceOpen
      out.push({ table: false, raw: line })
      i++
      continue
    }
    if (fenceOpen) {
      out.push({ table: false, raw: line })
      i++
      continue
    }
    if (isTableRow(line)) {
      let j = i
      while (j < lines.length && isTableRow(lines[j] ?? '')) j++
      const block = lines.slice(i, j)
      if (block.length >= 2 && isSeparator(block[1] ?? '')) {
        const closed = j < lines.length - trailingStatic || !streamOpen
        for (const rendered of renderTable(block, closed)) {
          out.push({ table: true, ...rendered })
        }
        i = j
        continue
      }
    }
    out.push({ table: false, raw: line })
    i++
  }
  return out
}
