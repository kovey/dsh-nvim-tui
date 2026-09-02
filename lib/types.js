// ---------------------------------------------------------------------------
// Service surfaces (structural — what this bundle actually calls)
// ---------------------------------------------------------------------------
/** Symbol-keyed host prompt queue on the dsh-subagent service instance
 *  (Symbol.for('dsh.subagent.queuePrompt')): queue one human prompt as a
 *  distinct child turn. Signature: (parentAgent, childId, content, source,
 *  signal) → inbox MessageId. The service exposes NO public method name for
 *  this face — only the symbol. */
export const queueSubagentPromptKey = Symbol.for('dsh.subagent.queuePrompt');
