/** Check a catalog before anyone is asked to trust it.
 *
 *  `--check` in CI answers "did OUR generator produce this?", which is the wrong question for someone
 *  else's file. A person writing a private catalog for their team, or preparing one to send us, needs the
 *  question answered the other way round: *given this file, what would rovecode do with it, and which of my
 *  fields would not survive?* That is what this reports, field by field.
 *
 *  THE INVARIANT THAT MATTERS: this must never call a row valid that `registry.ts` would drop. A validator
 *  that disagrees with the loader is worse than none — it hands out a clean bill for a catalog that shows
 *  up empty. So every row is also run through `itemFromCatalog`, the real reader, and a row it refuses
 *  while we found nothing to say produces an error anyway. The checks below exist to explain the refusal in
 *  the author's terms, not to be the authority on it.
 *
 *  Errors and warnings are genuinely different and are not collapsed:
 *    error   — the row (or the file) is dropped. The market will not show it.
 *    warning — the row loads, but not as written: a field was truncated, a list item past the cap was
 *              dropped, a key was not recognised. Silent in production, and exactly what an author wants
 *              to hear before they publish.
 */

import { itemFromCatalog } from "./registry.ts";
import { LIMITS } from "./types.ts";

export type Severity = "error" | "warning";

export interface Finding {
  /** where it is, in the author's terms: `items[3].description` */
  path: string;
  message: string;
  severity: Severity;
}

export interface ValidationReport {
  ok: boolean;
  kind: "skill" | "plugin";
  /** rows that would load */
  accepted: number;
  /** rows the market would drop */
  dropped: number;
  findings: Finding[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The keys each kind's rows may carry. An unrecognised key is a warning, not an error, because a catalog
 *  may legitimately carry more than we read — but `descriptoin` is a typo that would otherwise cost the
 *  author a silent empty description, and that is worth a line. */
const KNOWN_KEYS: Record<"skill" | "plugin", ReadonlySet<string>> = {
  skill: new Set(["id", "name", "title", "publisher", "description", "version", "license", "tags", "repository",
                  "homepage", "source", "files", "bytes", "docs", "env", "status", "planNote"]),
  plugin: new Set(["id", "name", "title", "publisher", "description", "version", "apiVersion", "license", "tags",
                   "repository", "homepage", "install", "contributes", "docs", "env", "status", "planNote"]),
};

/** a subfolder that climbs out of its clone, by the same rules the installers apply */
function escapes(sub: unknown): boolean {
  if (typeof sub !== "string" || sub === "") return false;
  const s = sub.split("\\").join("/");
  return s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").includes("..");
}

export interface ValidateOptions {
  /** `skill` or `plugin`; when absent it is read from the document's own `kind`, else inferred from a name */
  kind?: "skill" | "plugin";
  /** the file name, used only to infer the kind when nothing else says */
  filename?: string;
}

export function inferKind(doc: unknown, opts: ValidateOptions = {}): "skill" | "plugin" | undefined {
  if (opts.kind !== undefined) return opts.kind;
  if (isRecord(doc) && (doc.kind === "skill" || doc.kind === "plugin")) return doc.kind;
  const n = (opts.filename ?? "").toLowerCase();
  if (n.includes("skill")) return "skill";
  if (n.includes("plugin")) return "plugin";
  return undefined;
}

/** Validate one catalog document. `text` is the raw file — parsing is part of what is being checked. */
export function validateCatalog(text: string, opts: ValidateOptions = {}): ValidationReport {
  const findings: Finding[] = [];
  const add = (path: string, message: string, severity: Severity = "error") => findings.push({ path, message, severity });

  if (text.length > LIMITS.body) {
    return { ok: false, kind: opts.kind ?? "skill", accepted: 0, dropped: 0,
             findings: [{ path: "", message: `the file is ${Math.round(text.length / 1024)} KB; rovecode reads at most ${LIMITS.body / 1024} KB`, severity: "error" }] };
  }

  let doc: unknown;
  try { doc = JSON.parse(text); }
  catch (e) { return { ok: false, kind: opts.kind ?? "skill", accepted: 0, dropped: 0,
                       findings: [{ path: "", message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`, severity: "error" }] }; }

  const kind = inferKind(doc, opts);
  if (kind === undefined) {
    return { ok: false, kind: "skill", accepted: 0, dropped: 0,
             findings: [{ path: "", message: `cannot tell whether this is a skill or a plugin catalog — pass --kind skill|plugin, or give the document a "kind" field`, severity: "error" }] };
  }

  if (!isRecord(doc)) {
    return { ok: false, kind, accepted: 0, dropped: 0, findings: [{ path: "", message: "the top level must be an object", severity: "error" }] };
  }
  if (doc.version === undefined) add("version", "missing; rovecode assumes 1", "warning");
  else if (doc.version !== 1) add("version", `is ${JSON.stringify(doc.version)}; this rovecode reads version 1`);
  if (!Array.isArray(doc.items)) {
    add("items", "missing or not an array — a catalog is { version, items: [...] }");
    return { ok: false, kind, accepted: 0, dropped: 0, findings };
  }

  const rows = doc.items;
  if (rows.length === 0) add("items", "no rows: this catalog would show nothing", "warning");
  if (rows.length > LIMITS.items) add("items", `${rows.length} rows; rovecode reads the first ${LIMITS.items} and ignores the rest`, "warning");

  const seen = new Map<string, number>();
  let accepted = 0, dropped = 0;

  rows.forEach((raw: unknown, i: number) => {
    const at = `items[${i}]`;
    const before = findings.length;

    if (!isRecord(raw)) { add(at, "not an object"); dropped++; return; }

    const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : undefined;
    if (id === undefined) add(`${at}.id`, "missing (a row needs an id, or a name to use as one)");
    else if (!ID.test(id)) add(`${at}.id`, `"${id}" is not a bare slug — lowercase letters, digits, dot, dash, underscore, at most 64`);
    else {
      const first = seen.get(id);
      if (first !== undefined) add(`${at}.id`, `"${id}" is already used by items[${first}]; ids are unique within a kind`);
      else seen.set(id, i);
    }

    if (typeof raw.description !== "string" || raw.description.trim() === "") add(`${at}.description`, "missing (a row needs one line describing it)");
    else if (raw.description.length > LIMITS.desc) add(`${at}.description`, `${raw.description.length} characters; will be cut to ${LIMITS.desc}`, "warning");

    for (const k of ["title", "publisher", "version", "license", "repository", "homepage"] as const) {
      const v = raw[k];
      if (v !== undefined && typeof v !== "string") add(`${at}.${k}`, `must be a string, not ${Array.isArray(v) ? "an array" : typeof v}`, "warning");
      else if (typeof v === "string" && v.length > LIMITS.str) add(`${at}.${k}`, `${v.length} characters; will be cut to ${LIMITS.str}`, "warning");
    }
    if (raw.publisher === undefined) add(`${at}.publisher`, 'missing; the row will say "unknown"', "warning");

    if (raw.tags !== undefined) {
      if (!Array.isArray(raw.tags)) add(`${at}.tags`, "must be an array of strings", "warning");
      else if (raw.tags.length > LIMITS.list) add(`${at}.tags`, `${raw.tags.length} tags; only the first ${LIMITS.list} are read`, "warning");
    }

    validateInstall(kind, raw, at, add);
    validateDocs(raw.docs, `${at}.docs`, add);

    for (const key of Object.keys(raw)) {
      if (!KNOWN_KEYS[kind].has(key)) add(`${at}.${key}`, "not a field rovecode reads — a typo, or something it will ignore", "warning");
    }

    // The authority, not us: whatever we found or missed, the real reader decides whether this row loads.
    const notes: string[] = [];
    const item = itemFromCatalog(kind, raw, notes);
    const errorsHere = findings.slice(before).some((f) => f.severity === "error");
    if (item === null) {
      dropped++;
      if (!errorsHere) add(at, `rovecode drops this row${notes.length ? `: ${notes[notes.length - 1]}` : ""} — the checks above did not explain why, which is a gap in this validator`);
    } else {
      if (errorsHere) add(at, "the row loads despite the errors above; treat them as the more careful reading", "warning");
      accepted++;
    }
  });

  return { ok: findings.every((f) => f.severity !== "error"), kind, accepted, dropped, findings };
}

function validateInstall(kind: "skill" | "plugin", raw: Record<string, unknown>, at: string,
                         add: (p: string, m: string, s?: Severity) => void): void {
  if (kind === "skill") {
    const source = isRecord(raw.source) ? raw.source : undefined;
    const files = Array.isArray(raw.files) ? raw.files : undefined;
    if (source === undefined && files === undefined) {
      add(`${at}.source`, "missing: a skill needs either source.git (a repository) or files (the text itself)");
      return;
    }
    if (source !== undefined) {
      if (typeof source.git !== "string" || !/^https?:\/\//.test(source.git)) add(`${at}.source.git`, "must be an http(s) repository URL");
      if (escapes(source.subfolder)) add(`${at}.source.subfolder`, `"${String(source.subfolder)}" climbs out of the clone`);
    }
    files?.forEach((f: unknown, j: number) => {
      const p = isRecord(f) ? f.path : undefined;
      if (typeof p !== "string" || p === "") add(`${at}.files[${j}].path`, "missing");
      else if (escapes(p)) add(`${at}.files[${j}].path`, `"${p}" writes outside the skill's folder`);
      if (isRecord(f) && typeof f.text !== "string") add(`${at}.files[${j}].text`, "missing (the file's contents)");
    });
    if (files !== undefined && files.length > LIMITS.list) add(`${at}.files`, `${files.length} files; only the first ${LIMITS.list} are read`, "warning");
    return;
  }

  const install = isRecord(raw.install) ? raw.install : undefined;
  if (install === undefined) { add(`${at}.install`, "missing: a plugin needs install.source (a repository URL or a folder)"); return; }
  if (typeof install.source !== "string" || install.source === "") { add(`${at}.install.source`, "missing"); return; }
  if (install.git === true && !/^https?:\/\//.test(install.source)) add(`${at}.install.source`, `"${install.source}" is marked git: true but is not an http(s) URL`);
  if (escapes(install.subfolder)) add(`${at}.install.subfolder`, `"${String(install.subfolder)}" climbs out of the clone`);
  // Not an error, and said plainly: rovecode's own three plugins all live in a subfolder, so a row without
  // one is claiming the manifest sits at the repository root — right sometimes, a mistake more often.
  if (install.subfolder === undefined) add(`${at}.install.subfolder`, "absent: the plugin.json must then be at the repository root", "warning");
}

function validateDocs(docs: unknown, at: string, add: (p: string, m: string, s?: Severity) => void): void {
  if (docs === undefined) return;                       // a row without documentation is a normal row
  if (!isRecord(docs)) { add(at, "must be an object", "warning"); return; }
  if (typeof docs.source !== "string" || !/^https?:\/\//.test(docs.source)) add(`${at}.source`, "must be the http(s) URL the document was read from — the docs are dropped without it", "warning");
  if (docs.format !== "markdown") add(`${at}.format`, `must be "markdown"; the docs are dropped otherwise`, "warning");
  if (typeof docs.body !== "string" || docs.body.trim() === "") add(`${at}.body`, "empty: the docs are dropped and the row keeps no documentation", "warning");
  else if (Buffer.byteLength(docs.body, "utf8") > LIMITS.docs) add(`${at}.body`, `${Math.round(Buffer.byteLength(docs.body, "utf8") / 1024)} KB; will be cut to ${LIMITS.docs / 1024} KB`, "warning");
  if (docs.truncated === true && typeof docs.bytes === "number" && typeof docs.body === "string"
      && docs.bytes <= Buffer.byteLength(docs.body, "utf8")) {
    add(`${at}.bytes`, "marked truncated, but bytes is not larger than the body — bytes should be the size BEFORE truncation", "warning");
  }
}

/** The report as lines, for a terminal. Errors first: an author fixes those, warnings are a second pass. */
export function reportLines(r: ValidationReport, where: string): string[] {
  const errors = r.findings.filter((f) => f.severity === "error");
  const warnings = r.findings.filter((f) => f.severity === "warning");
  const lines = [`${where}: ${r.kind} catalog — ${r.ok ? "valid" : "INVALID"}`];
  lines.push(`  ${r.accepted} row${r.accepted === 1 ? "" : "s"} would load, ${r.dropped} dropped, ${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
  for (const f of [...errors, ...warnings]) {
    lines.push(`  ${f.severity === "error" ? "error  " : "warning"}  ${f.path === "" ? "(file)" : f.path}: ${f.message}`);
  }
  if (r.ok && warnings.length > 0) lines.push("  warnings do not stop a catalog loading; they are fields that will not survive as written");
  return lines;
}
