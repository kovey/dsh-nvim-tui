// ---------------------------------------------------------------------------
// Service surfaces (structural — what this bundle actually calls)
// ---------------------------------------------------------------------------
/** Symbol-keyed host prompt queue on the dsh-subagent service instance
 *  (Symbol.for('dsh.subagent.queuePrompt')): pre-0.1.5 face — queue one
 *  human prompt as a distinct child turn. Signature:
 *  (parentAgent, childId, content, source, signal) → inbox MessageId.
 *  0.1.5 replaced it with the public `subagents.prompt` method. */
export const queueSubagentPromptKey = Symbol.for('dsh.subagent.queuePrompt');
