/**
 * Offline rasteriser: the OFFICIAL DeepSeek whale path → character-cell coverage.
 *
 * The mark is a single closed cubic-Bézier silhouette, not pixel art, so the
 * TUI art must be DERIVED from it rather than hand-drawn (the previous 16×24
 * grid was a hand approximation and never matched). This script flattens the
 * curves, scan-converts with the non-zero winding rule at sub-cell resolution,
 * and reports coverage so a caller can encode half-blocks.
 *
 * Run directly for a terminal preview:
 *   node scripts/whale-gen.ts 24 32 48
 *
 * Geometry provenance: packages/client/ui-primitives/src/FishLogo.tsx
 * (FISH_LOGO_VIEWBOX / FISH_LOGO_PATH) in the official deepseek-harness repo.
 * Kept verbatim — the whole point is that the cell art tracks the real mark.
 *
 * @module dsh-nvim-tui/scripts/whale-gen
 */

/** Native viewBox of {@link FISH_PATH} (user units). */
export const FISH_VIEWBOX = { width: 23.16, height: 17.04 }

/** The official silhouette path (verbatim, curves uncompressed). */
export const FISH_PATH =
  'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

interface Pt { x: number; y: number }

/** One subpath: a closed polygon (curve already flattened). */
type Contour = Pt[]

/**
 * Parse an SVG path of absolute `M`/`C`/`Z` commands into flattened contours.
 * The official path uses exactly those three commands (verified), so anything
 * else is rejected loudly rather than silently mis-rendered.
 */
export function flattenPath(d: string, stepsPerCurve = 24): Contour[] {
  // Case-SENSITIVE on purpose: an `i` flag would let [MCZ] also match the `e`
  // of scientific notation ("6.57033e-1"), splitting a number into a bogus
  // command. Numbers therefore need an explicit [eE] exponent branch.
  const tokens = d.match(/[MCZL]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
  if (tokens === null) throw new Error('empty path')
  const contours: Contour[] = []
  let cur: Contour = []
  let x = 0
  let y = 0
  let i = 0
  let last = ''
  const num = (): number => {
    const t = tokens[i++]
    if (t === undefined) throw new Error('path: unexpected end')
    const v = Number(t)
    if (!Number.isFinite(v)) throw new Error(`path: bad number ${t}`)
    return v
  }
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void => {
    // Uniform sampling of the cubic; adaptive subdivision buys nothing at these
    // cell sizes and would make the generated art non-deterministic.
    for (let s = 1; s <= stepsPerCurve; s++) {
      const t = s / stepsPerCurve
      const u = 1 - t
      cur.push({
        x: u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        y: u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      })
    }
    x = x3
    y = y3
  }
  while (i < tokens.length) {
    const tok = tokens[i]!
    // SVG implicit repetition. A bare number repeats the previous command —
    // EXCEPT after `M`, where the extra pairs are implicit `L` (the official
    // path relies on this: "M11.1749 14.4736L11.1749 14.4736" appears with the
    // L elided, and treating the second pair as another M desynced the whole
    // token stream by one).
    let cmd: string
    if (tok === 'M' || tok === 'C' || tok === 'Z' || tok === 'L') { cmd = tok; i++ }
    else if (last === 'C' || last === 'L') cmd = last
    else if (last === 'M') cmd = 'L'
    else throw new Error(`path: number ${tok} with no command in scope`)
    if (cmd === 'M') {
      if (cur.length > 0) contours.push(cur)
      x = num()
      y = num()
      cur = [{ x, y }]
    } else if (cmd === 'L') {
      x = num()
      y = num()
      cur.push({ x, y })
    } else if (cmd === 'C') {
      cubic(num(), num(), num(), num(), num(), num())
    } else {
      if (cur.length > 0) contours.push(cur)
      cur = []
    }
    last = cmd
  }
  if (cur.length > 0) contours.push(cur)
  return contours
}

/** Axis-aligned bounds of every contour. */
export function pathBounds(contours: Contour[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  return { minX, minY, maxX, maxY }
}

/** Coverage field: `sub` boolean samples per cell, aspect-corrected. */
export interface Coverage {
  cols: number
  rows: number
  /** sub×sub samples per cell, row-major [row][col][sy][sx] flattened. */
  sub: number
  /** coverage[row * cols + col] in [0,1]. */
  cov: Float64Array
}

/**
 * Scan-convert the contours into per-cell coverage.
 *
 * Cell aspect: a terminal cell is ~1:2 (w:h), and a half-block pair makes one
 * text row cover TWO pixel rows — so a cell of the PIXEL grid is 1 wide × 1
 * tall in pixel units while occupying half a text row. We therefore rasterise
 * a pixel grid whose height is 2× the text rows, preserving the viewBox ratio.
 *
 * @param cols - pixel columns (= text columns).
 * @param rows - pixel rows (= 2 × text rows).
 * @param sub - samples per axis inside each cell.
 */
export function rasterize(contours: Contour[], cols: number, rows: number, sub = 4): Coverage {
  const b = pathBounds(contours)
  const scale = Math.min(cols / (b.maxX - b.minX), rows / (b.maxY - b.minY))
  // Centre the mark in the grid (the official path is not exactly centred).
  const offX = (cols - (b.maxX - b.minX) * scale) / 2 - b.minX * scale
  const offY = (rows - (b.maxY - b.minY) * scale) / 2 - b.minY * scale
  const cov = new Float64Array(cols * rows)
  const samples = sub * sub
  // Edge list in device space, for the scanline pass.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let hit = 0
      for (let sy = 0; sy < sub; sy++) {
        const py = cy + (sy + 0.5) / sub
        for (let sx = 0; sx < sub; sx++) {
          const px = cx + (sx + 0.5) / sub
          if (insideNonZero(contours, (px - offX) / scale, (py - offY) / scale)) hit++
        }
      }
      cov[cy * cols + cx] = hit / samples
    }
  }
  return { cols, rows, sub, cov }
}

/** Non-zero winding test for one point (in path user units). */
function insideNonZero(contours: Contour[], px: number, py: number): boolean {
  let winding = 0
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i]!
      const b = c[(i + 1) % c.length]!
      if (a.y <= py) {
        if (b.y > py && isLeft(a, b, px, py) > 0) winding++
      } else if (b.y <= py && isLeft(a, b, px, py) < 0) winding--
    }
  }
  return winding !== 0
}

/** >0 when (px,py) is left of the directed edge a→b. */
function isLeft(a: Pt, b: Pt, px: number, py: number): number {
  return (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)
}

/**
 * Half-block cell: ' ' | 'top' | 'bottom' | 'full'.
 * A cell lights its top half from pixel row 2k and its bottom half from 2k+1.
 */
export type HalfCell = ' ' | 'top' | 'bottom' | 'full'

/** Coverage grid → half-block cells (pixel rows pair up into text rows). */
export function coverageToCells(cov: Float64Array, cols: number, rows: number, threshold = 0.5): HalfCell[][] {
  const cells: HalfCell[][] = []
  for (let ty = 0; ty < rows; ty += 2) {
    const line: HalfCell[] = []
    for (let x = 0; x < cols; x++) {
      const top = (cov[ty * cols + x] ?? 0) >= threshold
      const bottom = (cov[(ty + 1) * cols + x] ?? 0) >= threshold
      line.push(top && bottom ? 'full' : top ? 'top' : bottom ? 'bottom' : ' ')
    }
    cells.push(line)
  }
  return cells
}

/**
 * Remove isolated halves: a lit half with no lit neighbour in its own half row
 * (left/right) and no lit partner half in the cell.
 *
 * Sampling a curve at cell resolution leaves one-pixel islands — a control
 * point that grazes a single cell — and they read as dirt beside an otherwise
 * clean silhouette. This MUST run on the half-block plane rather than the
 * coverage grid: a cell with top≈0.9 / bottom≈0.7 renders a lone `▀` whose
 * halves both look healthy in coverage terms, so a coverage-space erosion
 * keeps it. Without this pass the 48-column tier showed single blocks floating
 * above the head and off the tail.
 */
export function despeckleCells(cells: HalfCell[][]): HalfCell[][] {
  const rowsN = cells.length
  const colsN = cells[0]?.length ?? 0
  const hasTop = (y: number, x: number): boolean => {
    const c = y >= 0 && y < rowsN && x >= 0 && x < colsN ? cells[y]?.[x] : undefined
    return c === 'top' || c === 'full'
  }
  const hasBottom = (y: number, x: number): boolean => {
    const c = y >= 0 && y < rowsN && x >= 0 && x < colsN ? cells[y]?.[x] : undefined
    return c === 'bottom' || c === 'full'
  }
  return cells.map((line, y) =>
    line.map((cell, x): HalfCell => {
      if (cell === 'full') return cell
      if (cell === 'top') return hasTop(y, x - 1) || hasTop(y, x + 1) ? cell : ' '
      if (cell === 'bottom') return hasBottom(y, x - 1) || hasBottom(y, x + 1) ? cell : ' '
      return cell
    }),
  )
}

/** Half-block cells → text lines. */
export function cellsToText(cells: HalfCell[][]): string[] {
  const glyph: Record<HalfCell, string> = { ' ': ' ', top: '▀', bottom: '▄', full: '█' }
  return cells.map((line) => line.map((c) => glyph[c]).join('').replace(/\s+$/, ''))
}

/** Render a coverage field as half-block text (for previewing / encoding). */
export function coverageToHalfBlocks(c: Coverage, threshold = 0.5): string[] {
  return cellsToText(despeckleCells(coverageToCells(c.cov, c.cols, c.rows, threshold)))
}

// -- preview (only when run directly) ---------------------------------------
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isMain && !process.argv.includes('--emit')) {
  const widths = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const target = widths.length > 0 ? widths : [24, 32, 48]
  const contours = flattenPath(FISH_PATH)
  const b = pathBounds(contours)
  console.log(`contours: ${contours.length} | bounds: ${b.minX.toFixed(2)},${b.minY.toFixed(2)} → ${b.maxX.toFixed(2)},${b.maxY.toFixed(2)}`)
  console.log(`viewBox : ${FISH_VIEWBOX.width} × ${FISH_VIEWBOX.height} (ratio ${(FISH_VIEWBOX.width / FISH_VIEWBOX.height).toFixed(3)})`)
  console.log(`path box: ${(b.maxX - b.minX).toFixed(3)} × ${(b.maxY - b.minY).toFixed(3)} (ratio ${((b.maxX - b.minX) / (b.maxY - b.minY)).toFixed(3)})`)
  for (const cols of target) {
    // Pixel rows = 2 × text rows; keep the viewBox ratio with square pixels.
    const pxRows = Math.round((cols / (b.maxX - b.minX)) * (b.maxY - b.minY))
    const textRows = Math.ceil(pxRows / 2)
    const cov = rasterize(contours, cols, textRows * 2, 4)
    const art = coverageToHalfBlocks(cov)
    const filled = [...cov.cov].filter((v) => v >= 0.5).length
    console.log(`\n--- ${cols} cols × ${textRows} text rows (${cols}×${textRows * 2} px, fill ${(filled / cov.cov.length * 100).toFixed(1)}%) ---`)
    for (const l of art) console.log(l)
  }
}

// ---------------------------------------------------------------------------
// Span encoding: half-block cells → the text + per-glyph highlight spans the
// feed's renderer already understands (same shape the hand-drawn art used).
// ---------------------------------------------------------------------------

/** One rendered row: text plus byte-offset spans naming a highlight group. */
export interface EncodedRow {
  text: string
  spans: Array<{ s: number; e: number; group: string }>
}

/** The official mark is a SOLID silhouette (single `currentColor` fill), so it
 *  encodes with body/absent only. Palette letters match the existing
 *  DshTuiWhale* highlight groups: B = brand blue, '-' = absent. */
export function encodeCells(cells: HalfCell[][]): EncodedRow[] {
  return cells.map((line) => {
    let text = ''
    const spans: EncodedRow['spans'] = []
    for (const cell of line) {
      if (cell === ' ') { text += ' '; continue }
      const glyph = cell === 'full' ? '█' : cell === 'top' ? '▀' : '▄'
      // Group naming mirrors the hand-drawn convention: fg=top pixel,
      // bg=bottom pixel, so every colour pair has one stable group.
      const group = cell === 'full'
        ? 'DshTuiWhaleBB'
        : cell === 'top' ? 'DshTuiWhaleB-' : 'DshTuiWhale-B'
      const s = Buffer.byteLength(text)
      text += glyph
      spans.push({ s, e: Buffer.byteLength(text), group })
    }
    const trimmed = text.replace(/\s+$/, '')
    const cut = Buffer.byteLength(trimmed)
    return { text: trimmed, spans: spans.filter((sp) => sp.s < cut) }
  })
}

/** Width tiers the empty-state hero picks from, widest fitting the window. */
export const WHALE_TIERS = [24, 32, 48] as const

/** Rasterise + encode one tier (pixel rows = 2 × text rows, square pixels). */
export function buildTier(cols: number, contours: Contour[] = flattenPath(FISH_PATH)): EncodedRow[] {
  const b = pathBounds(contours)
  const pxRows = Math.round((cols / (b.maxX - b.minX)) * (b.maxY - b.minY))
  const textRows = Math.ceil(pxRows / 2)
  return encodeCells(despeckleCells(coverageToCells(rasterize(contours, cols, textRows * 2, 4).cov, cols, textRows * 2)))
}

if (isMain && process.argv.includes('--emit')) {
  const outPath = process.argv[process.argv.indexOf('--emit') + 1]
  if (outPath === undefined || outPath === '') {
    console.error('usage: node scripts/whale-gen.ts --emit <out.ts>')
    process.exit(2)
  }
  const contours = flattenPath(FISH_PATH)
  const lines: string[] = [
    '/**',
    ' * GENERATED — do not edit by hand. Regenerate with:',
    ' *   node scripts/whale-gen.ts --emit src/feed/whale-art.ts',
    ' *',
    ' * The official DeepSeek mark rasterised to half-block cells. The mark is a',
    ' * single closed cubic-Bézier silhouette (viewBox ' +
      `${FISH_VIEWBOX.width}×${FISH_VIEWBOX.height}, ratio ` +
      `${(FISH_VIEWBOX.width / FISH_VIEWBOX.height).toFixed(3)}), not pixel art — the previous hand-drawn`,
    ' * 16×24 grid was an approximation and never matched. Deriving the cells from',
    ' * the real path is what makes the TUI whale track the official mark, and it',
    ' * re-derives at any size instead of needing a redraw per resolution.',
    ' *',
    ' * Geometry: packages/client/ui-primitives/src/FishLogo.tsx',
    ' * (FISH_LOGO_VIEWBOX / FISH_LOGO_PATH), deepseek-harness.',
    ' *',
    ' * @module dsh-nvim-tui/feed/whale-art',
    ' */',
    '',
    '/** One rendered row: text plus byte-offset spans naming a highlight group.',
    ' *  Groups use the feed palette convention fg=top pixel / bg=bottom pixel, so',
    ' *  the whole silhouette needs only three (BB full, B- top, -B bottom). */',
    'export interface WhaleArtRow {',
    '  t: string',
    '  s: Array<{ s: number; e: number; g: string }>',
    '}',
    '',
  ]
  for (const cols of WHALE_TIERS) {
    const rows = buildTier(cols, contours)
    lines.push(`/** ${cols}-column tier — ${rows.length} text rows. */`)
    lines.push(`export const WHALE_${cols}: WhaleArtRow[] = [`)
    for (const r of rows) {
      const spans = r.spans.map((sp) => `{s:${sp.s},e:${sp.e},g:'${sp.group.replace('DshTuiWhale', '')}'}`).join(', ')
      lines.push(`  { t: ${JSON.stringify(r.text)}, s: [${spans}] },`)
    }
    lines.push(']', '')
  }
  lines.push('/** Tiers in ascending width; the hero picks the widest that fits. */')
  lines.push('export const WHALE_TIER_WIDTHS: readonly number[] = [' + WHALE_TIERS.join(', ') + ']')
  const text = lines.join('\n')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, text + '\n')
  console.error(`wrote ${outPath} (${text.split('\n').length} lines)`)
}
