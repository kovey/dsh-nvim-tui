/** Stable section name (a duplicate registration would throw). */
export declare const TODO_GUARD_SECTION = "nvim-tui-todo-discipline";
/** Reminder budget per turn — enough to steer, never a nag loop. */
export declare const MAX_NUDGES_PER_TURN = 3;
export interface TodoItem {
    content: string;
    status: string;
}
interface SessionEventLike {
    type?: unknown;
    data?: {
        todos?: unknown;
    };
}
export declare function todoDisciplineSectionText(): string;
/** Newest standing list from one session log (the last todo/write wins). */
export declare function latestTodos(events: readonly SessionEventLike[]): TodoItem[] | null;
export interface TodoGuardStep {
    /** The step being inspected called todo_write. */
    sawTodoWrite: boolean;
    /** Number of tool calls the step made. */
    toolCalls: number;
}
/** Reminder for the NEXT request; null when the step was clean. Pure. */
export declare function todoGuardReminder(step: TodoGuardStep, todos: TodoItem[] | null, nudgesUsed: number, maxNudges?: number): string | null;
/**
 * Reminder for the turn-END gate: null when there is nothing to finish.
 *
 * Separate from {@link todoGuardReminder} because at this point the model made
 * NO tool calls — it simply decided to stop — so the per-step "ran tools but
 * wrote no list" test does not apply. Pure, so the wording is testable.
 */
export declare function todoTurnEndReminder(todos: TodoItem[] | null): string | null;
/** Install the guard on one agent scope. Never throws. */
export declare function installTodoGuard(agentCtx: unknown, opts?: {
    enabled?: boolean;
    onError?: (stage: string, err: unknown) => void;
}): void;
export {};
