export interface ClipboardResult {
    ok: boolean;
    command?: string;
    error?: string;
}
/** Candidate argv lists, in preference order, for one platform. */
export declare const clipboardCommands: (platform?: string) => string[][];
/** Copy `text` verbatim through the first working platform command. */
export declare const writeClipboardText: (text: string, platform?: string) => ClipboardResult;
