import type { App } from '../../kernel/app.js';
/** Model ids configured for one provider — read from the settings section
 *  (`llm-<provider>.models`, the same catalog the vision-model switch and
 *  /settings overview use). Best-effort: returns [] when the section is
 *  absent or the schema is unrecognized. */
export declare const configuredModels: (app: App, providerId: string, settingsNs?: string) => string[];
/** Shared catalog rows for the /models directory AND the /model picker:
 *  current header (`act:current`), provider group rows (`prov:<id>`),
 *  switchable model rows (`switch:{provider,model}`). null = llm service
 *  absent; [] = no providers registered. */
export declare const modelCatalogRows: (app: App) => Array<{
    label: string;
    value: string;
    active?: boolean;
}> | null;
/** /models — provider/model catalog popup (sessions-style browse + act):
 *  current selection, live providers with their configured models
 *  (Enter switches), and not-yet-assembled providers pointing at their
 *  settings section. */
export declare const modelsCommand: (app: App) => Promise<void>;
export declare function installModelsCommand(app: App): void;
