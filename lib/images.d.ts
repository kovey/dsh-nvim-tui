import type { ImageAttachmentRef, SaveImageAttachment } from './types.js';
/** Detect the raster format from the encoded bytes; null when unsupported. */
export declare function sniffMediaType(bytes: Uint8Array): string | null;
/**
 * Read a local image file into the SaveImageAttachment shape.
 * `~/…` paths expand; the format is sniffed from the bytes (extension only
 * as a fallback for pathless buffers).
 * @throws {Error} when the file is unreadable or the format is unsupported.
 */
export declare function readImageFile(path: string, _knownMediaType?: string | null): SaveImageAttachment;
/**
 * Parse a pasted `data:image/…;base64,…` URL into the SaveImageAttachment
 * shape; null when the string is not a valid supported image data URL.
 */
export declare function parseImageDataUrl(dataUrl: string): SaveImageAttachment | null;
/** Strip image data URLs from a submitted line; returns {text, images}. */
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
