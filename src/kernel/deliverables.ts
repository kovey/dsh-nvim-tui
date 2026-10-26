/**
 * Deliverables folding: explicit `deliverables/presented` declarations plus
 * the mutation-tool path heuristic. Kept in kernel (not boot) because both the
 * live event pipeline and the resume/replay path fold it, and commands read it.
 *
 * The explicit event is authoritative: a `present` call can declare files the
 * model produced with bash (or any tool whose arguments carry no path), which
 * the heuristic can never see. Heuristic paths remain so older tools and
 * pre-present sessions still work, but a declared path wins on duplicates.
 *
 * @module dsh-nvim-tui/deliverables
 */
import { isAbsolute, resolve } from 'node:path'
import type { DeliverablesState, PresentedFile } from './types.js'

/** Fresh per-turn state. */
export const emptyDeliverables = (turn?: number): DeliverablesState => ({
  turn,
  paths: [],
  presented: [],
})

/** Merge declared files into the turn's state, de-duplicated by path. */
export const mergePresentedFiles = (
  state: DeliverablesState,
  turn: number | undefined,
  files: readonly PresentedFile[],
): DeliverablesState => {
  const presented = [...state.presented]
  const seen = new Set(presented.map((f) => f.path))
  for (const file of files) {
    if (typeof file?.path !== 'string' || file.path === '' || seen.has(file.path)) continue
    seen.add(file.path)
    presented.push({
      path: file.path,
      ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {}),
    })
  }
  return {
    turn: state.turn ?? turn,
    paths: state.paths,
    presented,
  }
}

/** All deliverable paths in display order: explicit declarations first. */
export const deliverablePaths = (state: DeliverablesState | undefined): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const file of state?.presented ?? []) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    out.push(file.path)
  }
  for (const path of state?.paths ?? []) {
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** Resolve a deliverable path against the session cwd (present allows both). */
export const resolveDeliverablePath = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)
