/**
 * Image attachment helpers for the TUI input path.
 *
 * The DSH multimodal pipeline is durable-attachment based: a TUI reads the
 * image bytes, the harness `attachments.saveImage()` service validates them
 * and returns a stable `ImageAttachmentRef`, and the user message carries
 * `{ type: 'image', attachment: ref }` content blocks. The LLM adapter then
 * resolves refs into data URLs at request time.
 *
 * This module turns the two input forms a terminal can realistically
 * produce — a local file path and a pasted `data:image/...;base64,...` URL —
 * into the `SaveImageAttachment` shape (`{ data: Uint8Array, mediaType, name }`).
 *
 * @module dsh-nvim-tui/images
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { ImageAttachmentRef, SaveImageAttachment } from './types.js'

/** Media types the version-one attachment path accepts (dsh-attachment). */
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Magic-number sniffing — the attachment service re-validates the real bytes. */
const MAGIC: Array<{ type: string; bytes: number[] }> = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
]

const isWebp = (b: Uint8Array): boolean =>
  b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50

/** Detect the raster format from the encoded bytes; null when unsupported. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null
  if (isWebp(bytes)) return 'image/webp'
  for (const m of MAGIC) {
    if (m.bytes.every((v, i) => bytes[i] === v)) return m.type
  }
  return null
}

const EXTENSION_TYPES = new Map<string, string>([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['gif', 'image/gif'],
])

/**
 * Read a local image file into the SaveImageAttachment shape.
 * `~/…` paths expand; the format is sniffed from the bytes (extension only
 * as a fallback for pathless buffers).
 * @throws {Error} when the file is unreadable or the format is unsupported.
 */
export function readImageFile(path: string, _knownMediaType?: string | null): SaveImageAttachment {
  const resolved = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  const raw = readFileSync(resolved)
  let mediaType = sniffMediaType(raw)
  if (mediaType === null) {
    const ext = basename(resolved).toLowerCase().split('.').pop() ?? ''
    mediaType = EXTENSION_TYPES.get(ext) ?? null
  }
  if (mediaType === null) {
    throw new Error(`不支持的图片格式（支持 ${ACCEPTED.join(' / ')}）: ${path}`)
  }
  return { data: new Uint8Array(raw), mediaType, name: basename(resolved) }
}

const DATA_URL_RE = /data:(image\/png|image\/jpeg|image\/webp|image\/gif);base64,([A-Za-z0-9+/=\s]+)/

/**
 * Parse a pasted `data:image/…;base64,…` URL into the SaveImageAttachment
 * shape; null when the string is not a valid supported image data URL.
 */
export function parseImageDataUrl(dataUrl: string): SaveImageAttachment | null {
  const m = DATA_URL_RE.exec(dataUrl)
  if (m === null) return null
  let decoded: Buffer
  try {
    decoded = Buffer.from(m[2].replace(/\s/g, ''), 'base64')
  } catch {
    return null
  }
  if (decoded.length === 0) return null
  const mediaType = sniffMediaType(decoded)
  if (mediaType === null || mediaType !== m[1]) return null
  return { data: new Uint8Array(decoded), mediaType }
}

/** Strip image data URLs from a submitted line; returns {text, images}. */
export function splitImageDataUrls(text: string): { text: string; images: string[] } {
  const images: string[] = []
  const clean = text.replace(DATA_URL_RE, (whole) => {
    images.push(whole)
    return ''
  }).replace(/[ \t]+/g, ' ').trim()
  return { text: clean, images }
}

/** Human label for a chat line / notice: `📎 图片 (image/png · 640×480 · 123.4KB)`. */
export function imageLabel(ref: ImageAttachmentRef | undefined): string {
  const kb = (ref?.bytes ?? 0) / 1024
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb.toFixed(1)}KB`
  const dims = ref?.width && ref?.height ? ` · ${ref.width}×${ref.height}` : ''
  return `📎 图片 (${ref?.mediaType ?? 'image'}${dims} · ${size})`
}

/**
 * Read the macOS clipboard image into the SaveImageAttachment shape; null
 * when the clipboard holds no supported raster image.
 *
 * `pbpaste` is TEXT-only (its -Prefer accepts txt/rtf/ps only) — it cannot
 * read image data at all. AppleScript can: try PNGf → TIFF → JPEG → GIF,
 * write the winner to a temp file, and convert TIFF to PNG via `sips`.
 */
export function readClipboardImage(): SaveImageAttachment | null {
  if (process.platform !== 'darwin') return null
  const base = join(tmpdir(), `dsh-clip-${Date.now()}`)
  const outPath = `${base}.bin`
  let label = ''
  try {
    label = execFileSync('osascript', ['-e', `
      on run argv
        set outPath to item 1 of argv
        set types to {«class PNGf», «class TIFF», JPEG picture, GIF picture}
        set labels to {"png", "tiff", "jpeg", "gif"}
        repeat with i from 1 to 4
          try
            set d to (the clipboard as (item i of types))
            set f to open for access (POSIX file outPath) with write permission
            set eof f to 0
            write d to f
            close access f
            return item i of labels
          end try
        end repeat
        return "none"
      end run
    `, outPath], { maxBuffer: 1024 * 1024 }).toString().trim()
  } catch {
    return null
  }
  if (label === 'none') {
    try { unlinkSync(outPath) } catch {}
    return null
  }
  try {
    let raw = readFileSync(outPath)
    if (label === 'tiff') {
      const pngPath = `${base}.png`
      execFileSync('sips', ['-s', 'format', 'png', outPath, '--out', pngPath], { stdio: 'ignore' })
      raw = readFileSync(pngPath)
      try { unlinkSync(pngPath) } catch {}
    }
    const type = sniffMediaType(raw)
    if (type !== null) {
      return { data: new Uint8Array(raw), mediaType: type }
    }
  } catch {
    // fall through to null
  } finally {
    try { unlinkSync(outPath) } catch {}
  }
  return null
}
