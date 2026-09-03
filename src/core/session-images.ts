/** Port #34 image sidecars for the session store (session.ts): the persisted form ↔ the in-memory
 *  form of a message's image parts.
 *  Sidecars live at `<session>/attachments/<sha256>.<ext>`, content-addressed (the same image
 *  attached twice is one file). The store references them from entries.jsonl by ONE canonical
 *  session-relative form, `attachments/<file>` (forward slash, one segment, not `.`/`..`), and
 *  resolves that form to an absolute path in memory only, so core/images.ts imageData() can read
 *  it without knowing the session.
 *  Path confinement: every other persisted path is foreign and never resolves to a readable file —
 *  a non-canonical relative path stays relative (F2: `../outside.png` used to hydrate to
 *  <sessions>/outside.png) and an absolute path is DROPPED (F3: the store never writes one, so a
 *  persisted absolute path is a tampered or foreign line that would otherwise ship arbitrary
 *  on-disk bytes to the provider as an image block). imageData()/imageByteSize() decline both, so
 *  the part lowers to a "file unavailable" placeholder. Consequently the only file a hydrated part
 *  can name is `<session>/attachments/<one segment>`, whatever entries.jsonl says.
 *  `rovecode export --json` copies entries.jsonl ALONE — the attachments directory travels with the
 *  session directory, not with the export (the JSONL stays a small, verbatim-copyable record). */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { imageExt } from "./images.ts";
import type { ImagePart, MessagePart } from "./types.ts";

export const ATTACHMENTS_DIR = "attachments";

/** F2 (port #34 hardening): the only persisted sidecar form is `attachments/<file>` — one segment,
 *  no separators, not `.`/`..`. Anything else is undefined here and left unresolved (hydrateImageParts). */
export function sidecarFile(persisted: string): string | undefined {
  const prefix = `${ATTACHMENTS_DIR}/`;
  if (!persisted.startsWith(prefix)) return undefined;
  const file = persisted.slice(prefix.length);
  return file !== "" && file !== "." && file !== ".." && !/[\\/]/.test(file) ? file : undefined;
}

/** The on-disk form: every inline image (`bytes`) becomes a sidecar file under `dir` and the part
 *  keeps the session-relative `path` instead — the hash chain covers the path, the content-addressed
 *  filename covers the bytes. A sidecar that cannot be written (read-only dir, disk full) keeps its
 *  bytes inline, so nothing is ever dropped. undefined when there is nothing to do. */
export function sidecarImageParts(dir: string, parts: readonly MessagePart[]): MessagePart[] | undefined {
  if (!parts.some((p) => p.kind === "image" && p.bytes !== undefined)) return undefined;
  return parts.map((p) => {
    if (p.kind !== "image" || p.bytes === undefined) return p;
    const buf = Buffer.from(p.bytes, "base64");
    const file = `${createHash("sha256").update(buf).digest("hex")}.${imageExt(p.mime)}`;
    try {
      mkdirSync(join(dir, ATTACHMENTS_DIR), { recursive: true });
      const abs = join(dir, ATTACHMENTS_DIR, file);
      if (!existsSync(abs)) writeFileSync(abs, buf);
    } catch {
      return p; // inline fallback
    }
    const out: ImagePart = { kind: "image", mime: p.mime, path: `${ATTACHMENTS_DIR}/${file}` };
    if (p.width !== undefined) out.width = p.width;
    if (p.height !== undefined) out.height = p.height;
    if (p.name !== undefined) out.name = p.name;
    return out;
  });
}

/** The in-memory form: the canonical `attachments/<file>` path → absolute under `dir`; a persisted
 *  ABSOLUTE path is dropped (F3, header) so the part is unreadable rather than a read of whatever
 *  file the line names; any other relative path stays as it is (F2). undefined when there is
 *  nothing to do. */
export function hydrateImageParts(dir: string, parts: readonly MessagePart[]): MessagePart[] | undefined {
  const touched = (p: MessagePart): boolean => p.kind === "image" && p.path !== undefined && (isAbsolute(p.path) || sidecarFile(p.path) !== undefined);
  if (!parts.some(touched)) return undefined;
  return parts.map((p) => {
    if (p.kind !== "image" || p.path === undefined) return p;
    if (isAbsolute(p.path)) { const rest = { ...p }; delete rest.path; return rest; }
    const file = sidecarFile(p.path);
    return file === undefined ? p : { ...p, path: join(dir, ATTACHMENTS_DIR, file) };
  });
}
