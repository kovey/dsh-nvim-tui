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
export interface NlMatch {
    /** slash-command name WITHOUT the leading '/'. */
    name: string;
    /** optional argument string to append. */
    arg?: string;
}
export declare function matchIntent(raw: string): NlMatch | null;
