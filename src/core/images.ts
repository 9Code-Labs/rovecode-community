/** Image attachments (port #34): file → sniff → caps → ImagePart; the wire blocks both provider
 *  adapters emit; the text stand-in for models without vision.
 *
 *  Ported from opencode @ ebece6e (MIT), packages/opencode/src unless noted:
 *  - util/media.ts:15-26 sniffAttachmentMime — the MIME comes from magic bytes, never the file
 *    extension (png 89 50 4E 47.., jpeg FF D8 FF, gif "GIF8", webp "RIFF"…"WEBP"); bmp/pdf are
 *    recognised there but not accepted here (neither wire protocol takes them as images);
 *  - image/image.ts:10 MAX_BASE64_BYTES = 5 MiB (their cap is on the base64 form and they resize
 *    past it with photon; here the cap is on the decoded file, ROVECODE_IMAGE_MAX_BYTES, and an
 *    oversize image is an error the user fixes — never a silent re-encode);
 *  - session/prompt.ts:66-71 SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES — the same four types;
 *  - session/message-v2.ts:213-217 `[Attached <mime>: <filename>]` text stand-in for stripped
 *    media and provider/transform.ts:409-441 unsupportedParts (image → text when the model's
 *    input modalities lack "image") — the placeholder below is rovecode's own wording.
 *  Pattern reference only, no code copied: cline @ 8eb5f3d sdk/packages/shared/src/llms/media.ts
 *  SUPPORTED_IMAGE_MEDIA_TYPES (:73-78), DEFAULT_MAX_IMAGE_BASE64_BYTES 5 MiB (:80),
 *  IMAGE_UNSUPPORTED_PLACEHOLDER (:6-12: the stored history keeps the real image, only the
 *  request is substituted); apps/vscode/src/shared/messages/content.ts:140-153 base64 source ↔
 *  `data:<mime>;base64,<data>` URL.
 *  Wire shapes: Anthropic `{type:"image", source:{type:"base64", media_type, data}}`; OpenAI
 *  `{type:"image_url", image_url:{url:"data:<mime>;base64,<data>", detail}}`.
 *  Dimensions are read from container headers only (PNG IHDR, GIF logical screen, JPEG SOFn,
 *  WebP VP8/VP8L/VP8X) — no decoding; a header we cannot parse just leaves width/height unset. */

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ImageMime, ImagePart } from "./types.ts";

/** decoded-file cap per image (bytes); ROVECODE_IMAGE_MAX_BYTES overrides */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_BYTES_ENV = "ROVECODE_IMAGE_MAX_BYTES";
/** cap per user message — the TUI's /attach queue and the ACP prompt path both check it */
export const MAX_IMAGES_PER_MESSAGE = 8;
export const IMAGE_MIMES: readonly ImageMime[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface ImageLoadOptions {
  /** per-image byte cap; default ROVECODE_IMAGE_MAX_BYTES, else IMAGE_MAX_BYTES */
  maxBytes?: number;
  /** env the cap is read from (tests); default process.env */
  env?: Record<string, string | undefined>;
  /** display name; loadImageAttachment uses the file's basename */
  name?: string;
}

export type ImageLoadResult = ImagePart | { error: string };

/** The effective per-image cap: a positive integer ROVECODE_IMAGE_MAX_BYTES wins, else the default. */
export function imageMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[IMAGE_MAX_BYTES_ENV]?.trim();
  if (!raw) return IMAGE_MAX_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : IMAGE_MAX_BYTES;
}

// ---------- sniffing + dimensions ----------

const startsWith = (b: Uint8Array, at: number, prefix: number[]): boolean =>
  b.length >= at + prefix.length && prefix.every((v, i) => b[at + i] === v);

/** MIME by magic bytes (opencode media.ts:15-26 minus bmp/pdf); undefined = not an image we accept. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return undefined;
}

const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** Header-only width/height; undefined when the header is truncated or unrecognised. */
export function imageDimensions(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | undefined {
  const dims = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  switch (mime) {
    case "image/png": // IHDR is always the first chunk: length(4) "IHDR"(4) width(4) height(4)
      return bytes.length >= 24 && startsWith(bytes, 12, [0x49, 0x48, 0x44, 0x52]) ? dims(be32(bytes, 16), be32(bytes, 20)) : undefined;
    case "image/gif": // logical screen descriptor right after "GIF89a"/"GIF87a"
      return bytes.length >= 10 ? dims(le16(bytes, 6), le16(bytes, 8)) : undefined;
    case "image/jpeg": return jpegDimensions(bytes);
    case "image/webp": return webpDimensions(bytes);
  }
}

/** Walk the marker segments to the first SOFn (C0-CF except C4 DHT, C8 JPG, CC DAC): height, width. */
function jpegDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }                       // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // standalone
    if (marker === 0xd9 || marker === 0xda) return undefined;        // EOI / SOS before any SOF
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return i + 8 < b.length ? { height: be16(b, i + 5), width: be16(b, i + 7) } : undefined;
    }
    i += 2 + be16(b, i + 2);
  }
  return undefined;
}

/** First chunk after "WEBP": VP8 (lossy frame header), VP8L (lossless 14-bit fields), VP8X (extended canvas). */
function webpDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined;
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === "VP8 ") return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (fourcc === "VP8L" && b[20] === 0x2f) {
    return { width: 1 + (b[21]! | ((b[22]! & 0x3f) << 8)), height: 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)) };
  }
  if (fourcc === "VP8X") return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  return undefined;
}

// ---------- loading ----------

/** `70 B`, `5121 KB` — the unit both the caps' errors and the placeholder use */
const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : `${Math.ceil(n / 1024)} KB`);

/** Bytes already in memory → ImagePart (base64 inline). Rejects by magic bytes and by the cap. */
export function imageFromBytes(bytes: Uint8Array, opts: ImageLoadOptions = {}): ImageLoadResult {
  const label = opts.name ?? "image";
  const mime = sniffImageMime(bytes);
  if (!mime) {
    const head = [...bytes.subarray(0, 4)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
    return { error: `${label}: not a png/jpeg/gif/webp image (magic bytes: ${head || "empty file"})` };
  }
  const max = opts.maxBytes ?? imageMaxBytes(opts.env);
  if (bytes.byteLength > max) return { error: `${label}: ${fmtBytes(bytes.byteLength)} is over the ${fmtBytes(max)} per-image cap (${IMAGE_MAX_BYTES_ENV})` };
  const part: ImagePart = { kind: "image", mime, bytes: Buffer.from(bytes).toString("base64") };
  const d = imageDimensions(bytes, mime);
  if (d) { part.width = d.width; part.height = d.height; }
  if (opts.name !== undefined) part.name = opts.name;
  return part;
}

/** A file on disk → ImagePart. Size is checked from stat BEFORE reading (a 2 GB "image" is
 *  rejected without touching its bytes); the type comes from the bytes, never the extension.
 *  Never throws: every failure is `{ error }`. */
export function loadImageAttachment(filePath: string, opts: ImageLoadOptions = {}): ImageLoadResult {
  const name = opts.name ?? basename(filePath);
  let size: number;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return { error: `${name}: not a file` };
    size = st.size;
  } catch (e) {
    return { error: `${name}: cannot read (${e instanceof Error ? e.message : String(e)})` };
  }
  const max = opts.maxBytes ?? imageMaxBytes(opts.env);
  if (size > max) return { error: `${name}: ${fmtBytes(size)} is over the ${fmtBytes(max)} per-image cap (${IMAGE_MAX_BYTES_ENV})` };
  try {
    return imageFromBytes(readFileSync(filePath), { ...opts, maxBytes: max, name });
  } catch (e) {
    return { error: `${name}: cannot read (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** Transport form (ACP image blocks, HTTP bodies): base64 + declared mime → ImagePart. The bytes
 *  decide the type; a declared mime that disagrees is an error (cline media.ts media_type_mismatch). */
export function imageFromBase64(data: string, declaredMime: string | undefined, opts: ImageLoadOptions = {}): ImageLoadResult {
  const bytes = Buffer.from(data, "base64");
  const res = imageFromBytes(bytes, opts);
  if ("error" in res) return res;
  if (declaredMime !== undefined && declaredMime !== res.mime) return { error: `${opts.name ?? "image"}: declared ${declaredMime} but the bytes are ${res.mime}` };
  return res;
}

/** Per-message image cap: the error to show when `count` images would ride on one message. */
export function checkImageCount(count: number, max = MAX_IMAGES_PER_MESSAGE): string | undefined {
  return count > max ? `at most ${max} images per message (${count} attached)` : undefined;
}

// ---------- reading back (wire + display) ----------

/** The base64 payload: inline bytes, else the sidecar file (absolute path — the session store
 *  resolves relative ones on load). undefined when unreadable — callers fall back to text. */
export function imageData(part: ImagePart): string | undefined {
  if (part.bytes !== undefined) return part.bytes;
  if (part.path === undefined || !isAbsolute(part.path)) return undefined;
  try { return readFileSync(part.path).toString("base64"); } catch { return undefined; }
}

/** Decoded byte size when knowable without reading a sidecar (inline: from the base64 length).
 *  Same path rule as imageData(): only an absolute (store-hydrated) path is stat'ed — a persisted
 *  relative path must never touch the process cwd (session.ts F2 confinement). */
export function imageByteSize(part: ImagePart): number | undefined {
  if (part.bytes !== undefined) {
    const pad = part.bytes.endsWith("==") ? 2 : part.bytes.endsWith("=") ? 1 : 0;
    return Math.floor((part.bytes.length * 3) / 4) - pad;
  }
  if (part.path === undefined || !isAbsolute(part.path)) return undefined;
  try { return statSync(part.path).size; } catch { return undefined; }
}

export function imageExt(mime: ImageMime): "png" | "jpg" | "gif" | "webp" {
  return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : "webp";
}

/** `name, WxH, N KB` — whatever is known, in that order. */
export function describeImage(part: ImagePart): string {
  const bits = [part.name ?? part.mime];
  if (part.width !== undefined && part.height !== undefined) bits.push(`${part.width}x${part.height}`);
  const size = imageByteSize(part);
  if (size !== undefined) bits.push(fmtBytes(size));
  return bits.join(", ");
}

/** Text the adapters send in place of an image the model cannot see (or a sidecar that is gone). */
export function imagePlaceholder(part: ImagePart, reason = "model has no vision"): string {
  return `[image: ${describeImage(part)} — ${reason}]`;
}

/** Transcript chip for a user message's attachment. */
export function imageChip(part: ImagePart): string {
  return `[image: ${part.name ?? part.mime}]`;
}

/** Anthropic Messages content block; undefined when the bytes are unavailable. */
export function anthropicImageBlock(part: ImagePart): Record<string, unknown> | undefined {
  const data = imageData(part);
  return data === undefined ? undefined : { type: "image", source: { type: "base64", media_type: part.mime, data } };
}

/** OpenAI chat-completions content part (data URL); undefined when the bytes are unavailable. */
export function openaiImageBlock(part: ImagePart, detail: "auto" | "low" | "high" = "auto"): Record<string, unknown> | undefined {
  const data = imageData(part);
  return data === undefined ? undefined : { type: "image_url", image_url: { url: `data:${part.mime};base64,${data}`, detail } };
}
