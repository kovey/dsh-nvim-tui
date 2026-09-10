/**
 * Built-in /theme presets over the dsh_tui highlight groups.
 *
 * Shared by the /theme command and boot (which restores the persisted
 * preference), so it lives in the kernel — the only module both import.
 * A preset only ever ADDS highlight attributes, therefore the applied map
 * always carries EVERY touched group: groups the preset does not style get an
 * empty spec, which the Lua side resets to the default.
 *
 * @module dsh-nvim-tui/kernel/theme-presets
 */

/** Highlight groups any preset may touch (all of them get an explicit spec). */
export const THEME_GROUPS = ['DshTuiReasoning', 'DshTuiNotice', 'DshTuiUser', 'DshTuiTool', 'DshTuiError'] as const

export const THEME_PRESETS: Record<string, Record<string, Record<string, unknown>>> = {
  default: {},
  dim: { DshTuiReasoning: { italic: true }, DshTuiNotice: { italic: true } },
  vivid: { DshTuiUser: { bold: true }, DshTuiTool: { italic: true } },
  contrast: { DshTuiUser: { bold: true }, DshTuiTool: { bold: true }, DshTuiError: { bold: true } },
  mono: { DshTuiUser: { underline: true }, DshTuiTool: { underline: true }, DshTuiReasoning: { underline: true } },
}

export const THEME_NAMES = Object.keys(THEME_PRESETS)

/** Full application map for one preset ({} = reset for unstyled groups). */
export const themeMapFor = (name: string): Record<string, unknown> | null => {
  const preset = THEME_PRESETS[name]
  if (preset === undefined) return null
  const map: Record<string, unknown> = {}
  for (const g of THEME_GROUPS) map[g] = preset[g] ?? {}
  return map
}
