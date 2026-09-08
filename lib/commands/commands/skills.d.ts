import type { App } from '../../kernel/app.js';
/** /skills [name] — skill catalog; picker → detail float (show_skill). */
export declare const skillsCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installSkillsCommand(app: App): void;
