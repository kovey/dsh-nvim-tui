import type { SessionPersistenceService } from '../kernel/types.js';
export declare const truncateStoredRaw: (persistence: SessionPersistenceService | undefined, childId: string) => Promise<void>;
