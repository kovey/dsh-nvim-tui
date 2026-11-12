import type { App } from '../kernel/app.js';
export interface SubagentChild {
    id: string;
    label: string;
    name?: string | undefined;
    path?: string | undefined;
    depth?: number | undefined;
    running: boolean;
    mode: string | undefined;
    createdAt?: number | undefined;
}
export declare const listSubagentChildren: (app: App, parentId: string) => Promise<SubagentChild[]>;
