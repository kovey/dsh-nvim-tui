/**
 * Blue whale pixel art for the chat window — the DeepSeek brand whale
 * (rounded body, white belly, eye + blush, upturned tail) with nvim-tui
 * flavor on top of the base silhouette: the left eye winks, two bubbles
 * rise above the head, and a white sparkle sits in the sky.
 *
 * 16×24 pixel grid rendered with half-block glyphs (▀/▄/█), one highlight
 * group per cell color pair so the nvim extmark pass can color each glyph
 * with foreground/background (truecolor + 256-color).
 * Ported from the tianshu-tui welcome whale (huiliyi37/dsh-tianshu-tui,
 * src/format/whale.ts — the user's previous TUI).
 */

export interface WhaleRenderRow {
  text: string
  spans: Array<{ s: number; e: number; group: string }>
}

const WHALE_COLS = 24
export const WHALE_ROWS = 8

const GRID: readonly string[] = [
  '.........B.......BB..BB.',
  '.......B.........BBBBBB.',
  '..W...BBBBBBB....BBBB...',
  '.WWWBBBBBBBBBBB..BBB....',
  '..BBBBBBBBBBBBBBBBBB....',
  '.BBBBBBBBBBBBBBBBBBB....',
  '.BBBBBBBBE.BBBBBBBBB....',
  'BBWWWWBBBEEBBBBBBBBB....',
  'BWWWWWWPPBBBBBBBBBB.....',
  'BWWWWWWPPBBBBBBBBBB.....',
  'BWWWWWWWWWWWBBBBBB......',
  'BWWWWWWWWWWWWWBBBB......',
  '.BWWWWWWWWWWWWWBBB......',
  '..BWWWWWWWWWWWBBB.......',
  '....BBWWWWWWWBBB........',
  '.......BBBBBBBB.........',
]

function renderRows(grid: readonly string[]): WhaleRenderRow[] {
  const rows: WhaleRenderRow[] = []
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? ''
    const bottom = grid[y + 1] ?? ''
    let text = ''
    const spans: WhaleRenderRow['spans'] = []
    const cols = grid[0]?.length ?? 0
    for (let x = 0; x < cols; x++) {
      const t = top[x] ?? '.'
      const b = bottom[x] ?? '.'
      let ch: string
      let group: string
      if (t === '.' && b === '.') { text += ' '; continue }
      if (t === '.') { ch = '▄'; group = `DshTuiWhale-${b}` }
      else if (b === '.') { ch = '▀'; group = `DshTuiWhale${t}-` }
      else if (t === b) { ch = '█'; group = `DshTuiWhale${t}${b}` }
      else { ch = '▀'; group = `DshTuiWhale${t}${b}` }
      const start = Buffer.byteLength(text)
      text += ch
      spans.push({ s: start, e: Buffer.byteLength(text), group })
    }
    const trimmed = text.replace(/\s+$/, '')
    const cut = Buffer.byteLength(trimmed)
    rows.push({ text: trimmed, spans: spans.filter((sp) => sp.s < cut) })
  }
  return rows
}

/** Pre-rendered pixel rows (text + per-glyph color spans). */
export const WHALE_RENDER_ROWS: WhaleRenderRow[] = renderRows(GRID)

/**
 * One-line statusline animation (replaces the running spinner): a 6-cell
 * mini whale — white bubble pops above the head, eye fixed, tail fluke
 * flips ▖↔▘. Inline `%#Group#` markers let the statusline color each glyph
 * with the same pixel-pair highlight groups as the wallpaper.
 */

// ---------------------------------------------------------------------------
// Animation: a 4-frame cycle — eyes wink alternately, bubbles rise, and the
// whale bobs one pixel on the closing frames. All frames share the same
// silhouette and palette.
// ---------------------------------------------------------------------------

function cloneGrid(): string[][] {
  return GRID.map((r) => r.split(''))
}

function setCell(g: string[][], row: number, col: number, ch: string): void {
  if (row >= 0 && row < g.length && col >= 0 && col < g[row].length) g[row][col] = ch
}

/** Both eyes open (undo the base grid's left wink). */
function eyesBothOpen(g: string[][]): void {
  setCell(g, 6, 10, 'E')
  setCell(g, 7, 10, 'E')
}

/** Right eye closed (wink the other side). */
function rightWink(g: string[][]): void {
  eyesBothOpen(g)
  setCell(g, 6, 11, '.')
  setCell(g, 7, 11, 'E')
}

/** Shift every non-empty row down by one pixel (gentle bob). */
function bobDown(g: string[][]): void {
  for (let y = g.length - 1; y >= 1; y--) g[y] = g[y - 1]
  g[0] = new Array(g[1]?.length ?? 24).fill('.')
}

/** The 4 animation grids (base, both-open+bubbles-up, right-wink+bob, left-wink+bob). */
function frameGrids(): string[][][] {
  const f0 = cloneGrid()
  const f1 = cloneGrid()
  eyesBothOpen(f1)
  setCell(f1, 1, 7, '.')
  setCell(f1, 0, 7, 'B')
  const f2 = cloneGrid()
  rightWink(f2)
  bobDown(f2)
  const f3 = cloneGrid()
  bobDown(f3)
  return [f0, f1, f2, f3]
}

/** Full-size animation frames (8 text rows × 24 cols). */
export function whaleFrames(): WhaleRenderRow[][] {
  return frameGrids().map((g) => renderRows(g.map((r) => r.join(''))))
}

/**
 * Watermark animation: the terminal's own emoji font renders the whale
 * (2 cells wide), so frames cycle the spouting whale ↔ plain whale — the
 * spout appears to pulse. No highlight groups: emoji carry their colors.
 */
export const WHALE_EMOJI_FRAMES: readonly string[] = ['🐳', '🫧🐳']

/**
 * Horizontally indented whale rows (no vertical padding — the caller composes
 * the whole empty-state block and centers it as one unit).
 */
export function whaleRowsIndented(width: number, rows: WhaleRenderRow[] = WHALE_RENDER_ROWS): WhaleRenderRow[] | null {
  if (width < 40) return null
  const indent = Math.max(0, Math.floor((width - WHALE_COLS) / 2))
  const pad = ' '.repeat(indent)
  return rows.map((r) => ({
    text: pad + r.text,
    spans: r.spans.map((sp) => ({ s: sp.s + indent, e: sp.e + indent, group: sp.group })),
  }))
}

/**
 * Center the whale for a window: leading empty rows for vertical centering
 * and a horizontal indent baked into the text. Returns null when the window
 * is too small (min 40×22, like tianshu).
 */
export function layoutWhaleRows(height: number, width: number, rows: WhaleRenderRow[] = WHALE_RENDER_ROWS): WhaleRenderRow[] | null {
  if (width < 40 || height < WHALE_ROWS + 2) return null
  const indented = whaleRowsIndented(width, rows)
  if (indented === null) return null
  const topPad = Math.max(0, Math.floor((height - WHALE_ROWS) / 2))
  const out: WhaleRenderRow[] = []
  for (let i = 0; i < topPad; i++) out.push({ text: '', spans: [] })
  return [...out, ...indented]
}
