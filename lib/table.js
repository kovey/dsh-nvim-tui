/**
 * Markdown table → box-drawing table rendering (Claude-TUI style).
 *
 * Detects GFM table blocks (header | separator | body) in a line array and
 * replaces them with aligned, bordered rows — EVERY data row gets its own
 * ├…┼…┤ divider (header included):
 *
 *   ┌─────────┬────┬─────┐
 *   │ 日期    │ AQI│ 等级│   <- the WHOLE table bold (DshTuiBold):
 *   ├─────────┼────┼─────┤      cells, │ separators, ─ borders and corners
 *   │ 今天    │ 29 │ 🟢  │      alike (uniform stroke weight)
 *   ├─────────┼────┼─────┤
 *   │ 明天    │ 50 │ 🟢  │
 *   └─────────┴────┴─────┘
 *
 * Column widths use DISPLAY width (CJK/emoji count 2), so the borders line up
 * in nvim's grid. While the tail is still streaming (`streamOpen`), an open
 * block at the end of the view omits its bottom border and gains it once the
 * stream closes.
 *
 * OVERFLOW (maxWidth): when the natural table is wider than the viewport,
 * columns shrink (widest first) and cell content WRAPS into continuation
 * lines — EVERY physical line carries the `│` borders, so the frame never
 * breaks mid-table (nvim's own soft-wrap used to bend the box out of shape).
 *
 * @module dsh-nvim-tui/table
 */
import stringWidth from 'string-width';
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line);
export { isTableRow, isSeparator };
/** Strip inline emphasis from one cell: models frequently wrap table cells
 *  in `**…**` or `` `…` `` — inside a bordered table the markers would show
 *  literally, so drop them (the whole table is bold anyway). */
function stripCellMarkup(text) {
    return (text ?? '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/^\s+|\s+$/g, '');
}
function splitCells(line) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|'))
        return null;
    return t.slice(1, -1).split('|').map(stripCellMarkup);
}
/**
 * Render one validated table block (header + separator + body lines).
 * Exported so the chat feed can render blocks inline against its own
 * fence/diff state machine (a whole-view pre-pass desyncs its fence state
 * on fence markers inside verbatim diff rows).
 * @param {string[]} block raw table lines (block[1] is the separator)
 * @param {boolean} closed whether to draw the bottom border
 * @param {number} maxWidth total display-width cap (Infinity = natural).
 *   Overflow shrinks columns (widest first, floor 3) and wraps cell text
 *   into bordered continuation lines.
 */
export function renderTable(block, closed, maxWidth = Infinity) {
    const header = splitCells(block[0] ?? '') ?? [];
    const seps = splitCells(block[1] ?? '') ?? [];
    const body = block.slice(2).map((l) => splitCells(l) ?? []);
    const cols = Math.max(header.length, seps.length, ...body.map((r) => r.length));
    const aligns = Array.from({ length: cols }, (_, c) => {
        const s = (seps[c] ?? '').trim();
        if (s.startsWith(':') && s.endsWith(':'))
            return 'center';
        if (s.endsWith(':'))
            return 'right';
        if (s.startsWith(':'))
            return 'left';
        return 'auto';
    });
    // Numeric columns default to right alignment.
    for (let c = 0; c < cols; c++) {
        if (aligns[c] === 'auto' && body.length > 0 &&
            body.every((r) => r[c] !== undefined && /^-?[\d.,]+$/.test(r[c].trim()))) {
            aligns[c] = 'right';
        }
    }
    const rows = [header, ...body];
    const naturalWidths = Array.from({ length: cols }, (_, c) => Math.max(1, ...rows.map((r) => stringWidth(r[c] ?? ''))));
    // Width budget: borders/padding cost cols*3 + 1 columns (one leading │,
    // per column one space of padding on each side + one │ separator).
    const MIN_COL = 3;
    const contentBudget = Number.isFinite(maxWidth)
        ? Math.max(MIN_COL, maxWidth - (cols * 3 + 1))
        : Infinity;
    const widths = naturalWidths.map((w) => Math.min(w, contentBudget));
    if (Number.isFinite(maxWidth)) {
        const total = () => widths.reduce((a, b) => a + b, 0) + cols * 3 + 1;
        while (total() > maxWidth) {
            let idx = -1;
            for (let c = 0; c < cols; c++) {
                if (widths[c] > MIN_COL && (idx < 0 || widths[c] > widths[idx]))
                    idx = c;
            }
            if (idx < 0)
                break; // every column at the floor: minimal overflow wins
            widths[idx]--;
        }
    }
    /** Display-width-aware word wrap: one segment per line ≤ w columns.
     *  Splits by code point (CJK = 2 cols); a chunk wider than the column
     *  on its own is hard-split anyway. */
    const wrapText = (text, w) => {
        const out = [];
        let cur = '';
        let curW = 0;
        for (const ch of Array.from(text ?? '')) {
            const chW = stringWidth(ch);
            if (cur !== '' && curW + chW > w) {
                out.push(cur);
                cur = '';
                curW = 0;
            }
            cur += ch;
            curW += chW;
        }
        if (cur !== '' || out.length === 0)
            out.push(cur);
        return out;
    };
    const cellSeg = (text, c) => {
        const w = widths[c] ?? 0;
        const padTotal = w - stringWidth(text ?? '');
        const align = aligns[c] === 'auto' ? 'left' : aligns[c];
        if (align === 'right')
            return ' ' + ' '.repeat(padTotal) + (text ?? '') + ' ';
        if (align === 'center') {
            return ' ' + ' '.repeat(Math.floor(padTotal / 2)) + (text ?? '') +
                ' '.repeat(Math.ceil(padTotal / 2)) + ' ';
        }
        return ' ' + (text ?? '') + ' '.repeat(padTotal) + ' ';
    };
    const border = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
    /**
     * One bordered data row — possibly SEVERAL physical lines: cells wider
     * than their column wrap, and EVERY continuation line carries the full
     * │…│ frame (nvim's soft-wrap must never break the box). The WHOLE table
     * renders bold (uniform stroke weight): every row — cells, separators,
     * padding — carries a full-row DshTuiBold group, and the border rows
     * (─ corners junctions) carry the same group. The old style (per-cell
     * bold spans + dim borders) left `─`/corners visually thinner than `│`,
     * so the frame looked half-bold; uniform bold everywhere fixes that.
     */
    const row = (cells) => {
        const segs = cells.map((t, c) => wrapText(t ?? '', widths[c] ?? 0));
        const n = Math.max(1, ...segs.map((s) => s.length));
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push({
                text: '│' + segs.map((s, c) => cellSeg(s[i] ?? '', c)).join('│') + '│',
                group: 'DshTuiBold',
                spans: [],
            });
        }
        return out;
    };
    const out = [
        { text: border('┌', '┬', '┐'), group: 'DshTuiBold', spans: [] },
        ...row(header),
        { text: border('├', '┼', '┤'), group: 'DshTuiBold', spans: [] },
    ];
    // Every data row carries its OWN divider; the trailing divider becomes
    // the bottom border when the block is closed (while streaming, the open
    // ├…┤ at the tail doubles as the "more rows coming" cue).
    for (const r of body) {
        out.push(...row(r));
        out.push({ text: border('├', '┼', '┤'), group: 'DshTuiBold', spans: [] });
    }
    if (closed) {
        if (body.length > 0) {
            out[out.length - 1] = { text: border('└', '┴', '┘'), group: 'DshTuiBold', spans: [] };
        }
        else {
            out.push({ text: border('└', '┴', '┘'), group: 'DshTuiBold', spans: [] });
        }
    }
    return out;
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
export function transformTables(lines, streamOpen = false, trailingStatic = 0, maxWidth = Infinity) {
    const out = [];
    let fenceOpen = false;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^\s*```/.test(line)) {
            fenceOpen = !fenceOpen;
            out.push({ table: false, raw: line });
            i++;
            continue;
        }
        if (fenceOpen) {
            out.push({ table: false, raw: line });
            i++;
            continue;
        }
        if (isTableRow(line)) {
            let j = i;
            while (j < lines.length && isTableRow(lines[j] ?? ''))
                j++;
            const block = lines.slice(i, j);
            if (block.length >= 2 && isSeparator(block[1] ?? '')) {
                const closed = j < lines.length - trailingStatic || !streamOpen;
                for (const rendered of renderTable(block, closed, maxWidth)) {
                    out.push({ table: true, ...rendered });
                }
                i = j;
                continue;
            }
        }
        out.push({ table: false, raw: line });
        i++;
    }
    return out;
}
