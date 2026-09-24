/**
 * Argument grammar for every slash command that takes arguments.
 *
 * WHY ONE TABLE INSTEAD OF 35 EDITS: the grammar is pure data, and keeping it in
 * one place makes it reviewable in a single read — you can see the whole input
 * language of the TUI at once, and a new command that forgets its entry is
 * caught by one assertion rather than by hoping every author remembers. Commands
 * ABSENT from this table take no arguments, which is the common case (28 of 63)
 * and the right default: an entry here would be a lie.
 *
 * Only commands whose text the agent consumes are listed. A command that takes
 * free text (`/remember <text>`) says so and is never completed — completing it
 * would be nonsense; the hint is the whole point there.
 *
 * @module dsh-nvim-tui/kernel/command-args
 */
import type { CommandArg } from './app.js';
/**
 * The grammar of each argument-taking command, keyed by command name.
 *
 * Values come from the command's own parser, not from its `usage` string — the
 * usage line is a summary and is sometimes incomplete (`/fb` also accepts
 * `clear`, which its usage never mentioned).
 */
export declare const COMMAND_ARGS: Record<string, CommandArg[]>;
