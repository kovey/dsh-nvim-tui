/**
 * Blue whale background art (DeepSeek mascot) for the chat window.
 *
 * Two layouts, per the chosen UX:
 *  - WHALE_BIG: centered empty-state wallpaper (shown while the transcript
 *    has no content);
 *  - WHALE_SMALL: persistent bottom watermark once content exists.
 *
 * Rows carry their highlight group (DshTuiWhale1..4 = a blue gradient from
 * light spout to deep body); layout helpers indent/center them for any
 * window size.
 */
const W1 = 'DshTuiWhale1'; // spout / lightest
const W2 = 'DshTuiWhale2'; // top outline
const W3 = 'DshTuiWhale3'; // body
const W4 = 'DshTuiWhale4'; // belly / deepest
export const WHALE_BIG = [
    { text: '                      〰〰〰', group: W1 },
    { text: '                  〰〰〰〰〰〰', group: W1 },
    { text: '              〰〰〰〰〰〰〰〰', group: W1 },
    { text: '           ▄▄█████████████████████████████████████▄▄', group: W2 },
    { text: '        ▄██████████████████████████████████████████████▄▖', group: W2 },
    { text: '      ▄████▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓████▄▖', group: W2 },
    { text: '     ███▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓████▘', group: W3 },
    { text: '    ███▓▓▓▓▓●▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓████', group: W3 },
    { text: '    ██▓▓▓▓▓▄░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓███', group: W4 },
    { text: '    ██▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓███', group: W4 },
    { text: '    ██▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓███', group: W4 },
    { text: '    ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓███', group: W3 },
    { text: '     ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██▖', group: W3 },
    { text: '      ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██▖', group: W3 },
    { text: '       ▀▀██████████████████████████████████████████████████▀▀▘', group: W2 },
    { text: '         〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰', group: W1 },
];
export const WHALE_SMALL = [
    { text: '   〰〰〰', group: W1 },
    { text: ' ▄██████████████████████████████████▄▖', group: W2 },
    { text: ' █▓▓▓▓▓●▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓████▘', group: W3 },
    { text: ' █▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓███', group: W4 },
    { text: ' ▀▀████████████████████████████████████▀▘', group: W2 },
    { text: '  〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰', group: W1 },
];
export function whaleMaxWidth(rows) {
    let w = 0;
    for (const r of rows) {
        const wide = (r.text.match(/[〰●]/gu) ?? []).length; // width-2 glyphs
        w = Math.max(w, r.text.length + wide);
    }
    return w;
}
/**
 * Lay the art out for a window: horizontally centered, vertically centered
 * via leading empty rows. Returns null when the window is too small.
 */
export function layoutWhaleRows(rows, height, width) {
    const artWidth = whaleMaxWidth(rows);
    if (width < artWidth + 2 || height < rows.length + 2)
        return null;
    const indent = Math.max(0, Math.floor((width - artWidth) / 2));
    const topPad = Math.max(0, Math.floor((height - rows.length) / 2));
    const pad = ' '.repeat(indent);
    const out = [];
    for (let i = 0; i < topPad; i++)
        out.push({ text: '', group: '' });
    for (const r of rows)
        out.push({ text: pad + r.text, group: r.group });
    return out;
}
