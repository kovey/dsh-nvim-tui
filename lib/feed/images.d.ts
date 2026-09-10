import type { ImageAttachmentRef, SaveImageAttachment } from '../kernel/types.js';
/** Detect the raster format from the encoded bytes; null when unsupported. */
export declare function sniffMediaType(bytes: Uint8Array): string | null;
/**
 * Read a local image file into the SaveImageAttachment shape.
 * `~/…` paths expand; the format is sniffed from the bytes (extension only
 * as a fallback for pathless buffers).
 * @throws {Error} when the file is unreadable or the format is unsupported.
 */
/** Expand a leading `~/` against the user's home. Callers MUST expand BEFORE
 *  deciding relative-vs-absolute: `isAbsolute('~/a.png')` is false, so a
 *  home-relative path used to be joined onto the session cwd and fail ENOENT. */
export declare function expandHome(path: string): string;
/** Read an image file. The media type is sniffed from a bounded PREFIX of the
 *  file (magic numbers live in the first bytes) — the whole file is only read
 *  once the type is known, so sniffing a large non-image no longer blocks the
 *  event loop on a full read. */
export declare function readImageFile(path: string): SaveImageAttachment;
/**
 * Parse a pasted `data:image/…;base64,…` URL into the SaveImageAttachment
 * shape; null when the string is not a valid supported image data URL.
 */
export declare function parseImageDataUrl(dataUrl: string): SaveImageAttachment | null;
export declare function splitImageDataUrls(text: string): {
    text: string;
    images: string[];
};
/** Human label for a chat line / notice: `📎 图片 (image/png · 640×480 · 123.4KB)`. */
export declare function imageLabel(ref: ImageAttachmentRef | undefined): string;
/**
 * Read the macOS clipboard image into the SaveImageAttachment shape; null
 * when the clipboard holds no supported raster image.
 *
 * `pbpaste` is TEXT-only (its -Prefer accepts txt/rtf/ps only) — it cannot
 * read image data at all. AppleScript can: try PNGf → TIFF → JPEG → GIF,
 * write the winner to a temp file, and convert TIFF to PNG via `sips`.
 */
export declare function readClipboardImage(): SaveImageAttachment | null;
