/** Skill packaging + install (port #72): `<name>.tar.gz` through the Bun.Archive built-in (no tar / zip dependency)
 *  and a staged install finished by a rename swap. Pattern sources (no code copied): opencode-2026
 *  skill/discovery.ts:94-124 (MIT — stage into a hidden `.tmp-<token>` dir, validate, rename the old skill aside,
 *  rename staging in, remove the old; on failure put the old back) and the house writeUsageAtomic temp + rename
 *  idiom (index.ts). The agentskills.io specification defines NO archive format: a tar.gz holding ONE top-level
 *  directory named after the skill is rovecode's convention (`.skill` zips are neither produced nor consumed).
 *
 *  Safety: every archive entry is checked BEFORE anything is written — the `files()` keys (checkArchiveEntries: `..`,
 *  absolute, drive letter, backslash, empty segment, archive shape) AND the raw tar headers (findLinkMember: a symlink,
 *  hard-link, device or fifo member is refused — `files()` lists regular files only, so those members are invisible to
 *  the key check). The staged tree is then written file-by-file from that validated Map (materialise); libarchive's
 *  `extract` is never called: on POSIX it would create a symlink member and write the next entry THROUGH it, outside
 *  the staging dir, and Bun 1.3.14's `extract` also silently flattens `../x` INTO the target and drops `C:/x` (both
 *  probed). The observable pin is "exit 2 and nothing under the skills dir changed". Staging is a dot-dir inside the
 *  skills dir (`.install-<token>`: invisible to the scanner, same volume as the target so the rename is atomic); the
 *  staged SKILL.md must load through the SAME lenient loader as a scan with zero invalid files before anything is renamed.
 *  File bytes go into the archive via readFileSync — Bun issue #28459 (open): `Bun.file()` inputs yield EMPTY entries.
 *  Pure fs + archive: cli/skills-cmd.ts owns argv, io and exit codes (SkillCmdError.code: 1 refused · 2 io / unsafe). */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isSidecarName, SKILL_FILE, SkillStore } from "./index.ts";

export const MAX_ARCHIVE_ENTRIES = 2000;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** gunzip output cap for the header walk: a 64 MiB skill plus its headers fits, a header-only gzip bomb does not */
export const INFLATE_CAP = 2 * MAX_ARCHIVE_BYTES;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** a refused (1) or failed (2) skills command; the CLI prints the message and exits with `code` */
export class SkillCmdError extends Error {
  constructor(message: string, readonly code: 1 | 2) {
    super(message);
  }
}

/** Every regular file under `dir` as sorted posix-relative paths; usage / version sidecars, .git and node_modules
 *  skipped; a symlink anywhere → SkillCmdError(1) (an archive must not carry links, a copy must not follow them). */
export function collectSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      const st = lstatSync(join(d, e.name));
      if (st.isSymbolicLink()) throw new SkillCmdError(`symlink refused: ${r}`, 1);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name), r); }
      else if (st.isFile() && !isSidecarName(e.name)) out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** gzip tarball bytes: `<name>/<rel>` for every collected file, keys sorted (posix), contents via readFileSync. */
export async function packSkill(dir: string, name: string): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const rel of collectSkillFiles(dir)) entries[`${name}/${rel}`] = readFileSync(join(dir, rel));
  return new Bun.Archive(entries, { compress: "gzip" }).bytes();
}

/** The pre-write rules over `files()` keys: the reason the archive is refused, or null when it may be unpacked. */
export function checkArchiveEntries(keys: readonly string[]): string | null {
  if (keys.length === 0) return "archive is empty";
  if (keys.length > MAX_ARCHIVE_ENTRIES) return `archive has ${keys.length} entries (max ${MAX_ARCHIVE_ENTRIES})`;
  const tops = new Set<string>();
  for (const key of keys) {
    const shown = JSON.stringify(key);
    if (key.includes("\\")) return `unsafe entry ${shown}: backslash`;
    if (key.startsWith("/")) return `unsafe entry ${shown}: absolute path`;
    if (/^[A-Za-z]:/.test(key)) return `unsafe entry ${shown}: drive letter`;
    const segs = key.split("/");
    if (segs.some((s) => s === "")) return `unsafe entry ${shown}: empty path segment`;
    if (segs.some((s) => s === ".." || s === ".")) return `unsafe entry ${shown}: relative segment`;
    if (segs.length < 2) return `entry ${shown} is not inside a top-level directory`;
    tops.add(segs[0]!);
  }
  if (tops.size !== 1) return `archive must hold exactly one top-level directory (found ${[...tops].sort().join(", ")})`;
  const top = [...tops][0]!;
  if (!keys.includes(`${top}/${SKILL_FILE}`)) return `top-level directory ${JSON.stringify(top)} has no ${SKILL_FILE}`;
  return null;
}

/** Member types a skill archive may not carry — `files()` never lists them, so an install would silently drop a hard
 *  link and (on POSIX, under `extract`) follow a symlink out of the staging dir. */
const LINK_TYPES: Record<string, string> = { "1": "hard link", "2": "symlink", "3": "character device", "4": "block device", "6": "fifo" };

/** Walk the raw ustar headers and name the first link / device / fifo member, or null. gzip (1f 8b) is inflated under
 *  INFLATE_CAP (past it → a refusal); a body that is not ustar at its first header, or a size field the walk cannot
 *  read, returns null — `files()` already accepted the archive and materialise() writes only its regular-file keys, so
 *  the walk is what NAMES a malformed archive, not what keeps a missed member harmless. */
export function findLinkMember(bytes: Uint8Array): string | null {
  let tar: Uint8Array = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { tar = gunzipSync(bytes, { maxOutputLength: INFLATE_CAP }); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? `archive inflates past ${INFLATE_CAP} bytes` : null; }
  }
  const text = (off: number, len: number): string => new TextDecoder().decode(tar.subarray(off, off + len)).replace(/\0[\s\S]*$/, "");
  if (text(257, 5) !== "ustar") return null;
  for (let off = 0; off + 512 <= tar.length && tar[off] !== 0; ) { // an all-zero block (empty name) ends the archive
    const size = parseInt(text(off + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size)) return null; // base-256 size or garbage: leave it to files()
    const kind = LINK_TYPES[String.fromCharCode(tar[off + 156]!)];
    if (kind !== undefined) {
      const prefix = text(off + 345, 155);
      return `unsafe entry ${JSON.stringify(prefix === "" ? text(off, 100) : `${prefix}/${text(off, 100)}`)}: ${kind} member`;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Write the validated regular-file entries under `dir` — these keys are the ONLY thing that ever reaches the disk
 *  (no `extract`: no link members, no directory members, no mode bits from the archive). */
async function materialise(files: Map<string, File>, dir: string): Promise<void> {
  for (const [key, file] of files) {
    const path = join(dir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Uint8Array(await file.arrayBuffer()));
  }
}

export interface InstallOptions {
  /** replace an existing `<skills dir>/<name>` (rename-swap; the old copy is restored when the swap fails) */
  force?: boolean;
  /** test seam: the per-file copy used while staging a directory (default copyFileSync) */
  copyFile?: (src: string, dst: string) => void;
  /** test seam: runs after the old skill was moved aside and before staging moves in — a throw exercises the rollback */
  onSwap?: () => void;
}
export interface InstallResult { name: string; version: string; path: string; warnings: string[] }

const token = (): string => Math.random().toString(36).slice(2, 10);

function stagingDir(skillsDir: string): string {
  mkdirSync(skillsDir, { recursive: true });
  const dir = join(skillsDir, `.install-${token()}`);
  mkdirSync(dir);
  return dir;
}

function removeDir(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (attempt >= 5) throw e; Bun.sleepSync(40 * attempt); } // Windows: a closing handle inside the tree
  }
}

/** Copy a skill directory (sidecars excluded) into the skills dir under its LOADED name. */
export function installFromDir(src: string, skillsDir: string, opts: InstallOptions = {}): InstallResult {
  const from = resolve(src);
  if (!existsSync(join(from, SKILL_FILE))) throw new SkillCmdError(`${from} has no ${SKILL_FILE}`, 2);
  const files = collectSkillFiles(from);
  const staging = stagingDir(skillsDir);
  try {
    const dest = join(staging, basename(from)); // the source basename, so a missing `name:` falls back to the right dir
    const copy = opts.copyFile ?? copyFileSync;
    for (const rel of files) {
      const to = join(dest, rel);
      mkdirSync(dirname(to), { recursive: true });
      copy(join(from, rel), to);
    }
    return finish(staging, skillsDir, opts);
  } catch (e) {
    removeDir(staging);
    throw e;
  }
}

/** Unpack a tar.gz body: keys AND tar headers checked BEFORE anything is written, the tree written from the validated
 *  Map (never `extract`), then the same loader as a scan, then the rename swap. */
export async function installFromBytes(bytes: Uint8Array, skillsDir: string, opts: InstallOptions = {}): Promise<InstallResult> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new SkillCmdError(`archive is ${bytes.length} bytes (max ${MAX_ARCHIVE_BYTES})`, 2);
  let files: Map<string, File>;
  try { files = await new Bun.Archive(bytes).files(); }
  catch (e) { throw new SkillCmdError(`not a tar.gz archive: ${e instanceof Error ? e.message : String(e)}`, 2); }
  const reason = checkArchiveEntries([...files.keys()]) ?? findLinkMember(bytes);
  if (reason !== null) throw new SkillCmdError(reason, 2);
  let total = 0;
  for (const f of files.values()) total += f.size;
  if (total > MAX_ARCHIVE_BYTES) throw new SkillCmdError(`archive unpacks to ${total} bytes (max ${MAX_ARCHIVE_BYTES})`, 2);
  const staging = stagingDir(skillsDir);
  try {
    await materialise(files, staging);
    return finish(staging, skillsDir, opts);
  } catch (e) {
    removeDir(staging);
    throw e;
  }
}

/** Validate the staged tree with the runtime's loader, then swap it into place. Throws with staging still present
 *  (the callers remove it); after a failed swap the old skill is back and no `.old-*` dir remains. */
function finish(staging: string, skillsDir: string, opts: InstallOptions): InstallResult {
  const r = new SkillStore(skillsDir, { projectDir: staging, globalDir: null }).scan();
  if (r.invalid.length > 0) throw new SkillCmdError(`staged skill is invalid: ${r.invalid.map((i) => i.reason).join("; ")}`, 2);
  if (r.skills.length !== 1) throw new SkillCmdError(`expected exactly one skill, found ${r.skills.length}`, 2);
  const skill = r.skills[0]!;
  if (!/^[^/\\]+$/.test(skill.name) || skill.name === "." || skill.name === ".." || skill.name.startsWith(".")) {
    throw new SkillCmdError(`refusing skill name ${JSON.stringify(skill.name)}`, 2);
  }
  const target = join(skillsDir, skill.name);
  const warnings = r.warnings.map((w) => w.reason);
  if (existsSync(target)) {
    if (!opts.force) throw new SkillCmdError(`${target} already exists (use --force to replace it)`, 1);
    const old = join(skillsDir, `.old-${token()}`);
    renameSync(target, old);
    try {
      opts.onSwap?.();
      renameSync(skill.dir, target);
    } catch (e) {
      rmSync(target, { recursive: true, force: true });
      renameSync(old, target);
      throw e;
    }
    removeDir(old);
  } else renameSync(skill.dir, target);
  removeDir(staging);
  return { name: skill.name, version: skill.version, path: target, warnings };
}
