/** `rovecode skills list|validate|pack|install` (port #72): the agentskills.io-shaped skill catalogue on the command
 *  line. Mirrors cli/mcp-market-cmd.ts — hand-parsed argv, an io seam, ONE dispatch line in main.ts — plus an
 *  injectable fetch and DNS resolver for the URL install. Exit codes: 0 ok · 1 usage / strict finding / refused
 *  overwrite / non-http(s) URL / symlink / a refused address · 2 io (unreadable, not an archive, unsafe entries, an
 *  invalid staged skill, HTTP or network failure). `list` is the LENIENT loader the runtime uses (every loaded skill,
 *  every loader warning, the files it refused); `validate` and `pack` are STRICT (spec violations are errors, unknown
 *  keys notes, nothing is written after a finding). Scopes are skills/index.ts skillsDir(cwd, scope):
 *  `<cwd>/.rovecode/skills`, or `<home>/skills` with --user (ROVECODE_HOME honoured). allowed-tools is never enforced.
 *
 *  `install <url>` goes through the SAME SSRF guard as web_fetch and web_search (tools/webfetch.ts ssrfDenyReason:
 *  loopback, private, link-local and reserved ranges refused, names resolved through the injectable resolver) — on the
 *  URL and on every redirect hop, http(s) only, ≤ 5 hops. The reason is that a human typing a URL is not the only
 *  caller: a model with bash can run `rovecode skills install http://169.254.169.254/…`, and cloud metadata is exactly
 *  what that guard is for. A CLI that skips the check its own tools make is the soft spot in the boundary, so do not
 *  remove this. There is deliberately NO allow-private knob: an intranet-hosted archive is refused, and `curl` +
 *  `skills install <file.tar.gz>` is the local path — one env knob is a decision for Berkay, not a default.
 *  Body bounded at 64 MiB (webfetch readBounded) under a ref'd timeout. */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SKILL_FILE, SkillStore, skillsDir } from "../skills/index.ts";
import { parseSkillFrontmatter, validateSkillMeta, type Validation } from "../skills/spec.ts";
import { installFromBytes, installFromDir, MAX_ARCHIVE_BYTES, packSkill, SkillCmdError, type InstallResult } from "../skills/pack.ts";
import { abortable, dnsResolver, readBounded, ssrfDenyReason, type FetchLike, type Resolver } from "../tools/webfetch.ts";

export interface SkillsCmdIo { out(line: string): void; err(line: string): void }
export interface SkillsCmdDeps {
  io?: SkillsCmdIo;
  /** the URL install's fetch (tests inject a loopback / scripted one) */
  fetch?: FetchLike;
  /** the SSRF guard's name resolver (tests inject one that answers for their loopback fixture) */
  resolve?: Resolver;
  /** the user-scope skills dir (default `<user state dir>/skills`) */
  globalDir?: string;
}
const stdio: SkillsCmdIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

export const SKILLS_USAGE =
  "usage: rovecode skills list [--json] | rovecode skills validate <dir> | rovecode skills pack <dir> [--out <file>] [--force] | " +
  "rovecode skills install <dir|file.tar.gz|http(s)-url> [--user] [--force]";
export const INSTALL_TIMEOUT_MS = 60_000;
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Entry point: `args` are the argv words AFTER `skills`. Returns the exit code. */
export async function cmdSkills(args: string[], cwd: string, deps: SkillsCmdDeps = {}): Promise<number> {
  const io = deps.io ?? stdio;
  const action = args[0] ?? "";
  const rest = args.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const outIx = rest.indexOf("--out");
  const outFile = outIx !== -1 ? rest[outIx + 1] : undefined;
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--out");
  const globalDir = deps.globalDir ?? skillsDir(cwd, "global");
  try {
    if (action === "list") return list(cwd, globalDir, flags.has("--json"), io);
    if (action === "validate" && positional[0] !== undefined) return validate(resolve(cwd, positional[0]), io);
    if (action === "pack" && positional[0] !== undefined) {
      return await pack(resolve(cwd, positional[0]), outFile !== undefined ? resolve(cwd, outFile) : undefined, flags.has("--force"), cwd, io);
    }
    if (action === "install" && positional[0] !== undefined) {
      const target = flags.has("--user") ? globalDir : skillsDir(cwd, "project");
      return await install(positional[0], cwd, target, flags.has("--force"), deps.fetch ?? ((u, i) => fetch(u, i)), deps.resolve ?? dnsResolver, io);
    }
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof SkillCmdError ? err.code : 2;
  }
  io.err(SKILLS_USAGE);
  return 1;
}

function list(cwd: string, globalDir: string, json: boolean, io: SkillsCmdIo): number {
  const r = new SkillStore(cwd, { globalDir }).scan();
  const byPath = new Map<string, string[]>();
  for (const w of r.warnings) byPath.set(w.path, [...(byPath.get(w.path) ?? []), w.reason]);
  const rows = r.skills.map((s) => ({
    name: s.name, version: s.version, scope: s.scope, path: s.path, dir: s.dir, description: s.fullDescription,
    license: s.license, compatibility: s.compatibility, metadata: s.metadata, allowedTools: s.allowedTools,
    warnings: byPath.get(s.path) ?? [],
  }));
  if (json) {
    io.out(JSON.stringify({ skills: rows, invalid: r.invalid }, null, 2));
    return 0;
  }
  if (rows.length === 0 && r.invalid.length === 0) {
    io.out(`no skills installed (${skillsDir(cwd, "project")} or ${globalDir}) — rovecode skills install <dir|file.tar.gz|url>`);
    return 0;
  }
  for (const row of rows) io.out(`${row.name.padEnd(24)} ${(row.version || "-").padEnd(10)} ${row.scope.padEnd(8)} ${row.path}`);
  for (const row of rows) for (const w of row.warnings) io.err(`warning: ${row.path}: ${w}`);
  for (const i of r.invalid) io.err(`warning: ${i.path}: not loaded — ${i.reason}`);
  return 0;
}

/** The strict spec check of `<dir>/SKILL.md`; unreadable → 2, no frontmatter → a finding (1). */
function strictCheck(dir: string): Validation {
  const file = join(dir, SKILL_FILE);
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (e) { throw new SkillCmdError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, 2); }
  const fm = parseSkillFrontmatter(text);
  if (fm === null) throw new SkillCmdError(`${file}: missing or unterminated frontmatter block`, 1);
  return validateSkillMeta(fm, basename(dir), "strict");
}

/** one stderr line per finding, notes on stdout; true when there are no errors */
function report(v: Validation, dir: string, io: SkillsCmdIo): boolean {
  for (const e of v.errors) io.err(`${join(dir, SKILL_FILE)}: ${e}`);
  for (const n of v.notes) io.out(`note: ${n}`);
  return v.errors.length === 0;
}

function validate(dir: string, io: SkillsCmdIo): number {
  const v = strictCheck(dir);
  if (!report(v, dir, io)) return 1;
  io.out(`ok: ${v.meta.name}${v.meta.version ? ` (v${v.meta.version})` : ""} — ${join(dir, SKILL_FILE)}`);
  return 0;
}

async function pack(dir: string, outFile: string | undefined, force: boolean, cwd: string, io: SkillsCmdIo): Promise<number> {
  const v = strictCheck(dir);
  if (!report(v, dir, io)) return 1; // any finding → nothing written
  const out = outFile ?? join(cwd, `${v.meta.name}.tar.gz`);
  if (existsSync(out) && !force) {
    io.err(`error: ${out} already exists (use --force to overwrite)`);
    return 1;
  }
  const bytes = await packSkill(dir, v.meta.name); // a symlink inside → SkillCmdError(1) before any write
  writeFileSync(out, bytes);
  io.out(`packed ${v.meta.name} → ${out} (${bytes.length} bytes)`);
  return 0;
}

async function install(src: string, cwd: string, dir: string, force: boolean, fetchImpl: FetchLike, resolve_: Resolver, io: SkillsCmdIo): Promise<number> {
  const scheme = URL_SCHEME.exec(src)?.[1]?.toLowerCase();
  let result: InstallResult;
  if (scheme !== undefined) {
    if (scheme !== "http" && scheme !== "https") throw new SkillCmdError(`only http(s) URLs can be installed (got ${scheme}:)`, 1);
    result = await installFromBytes(await download(src, fetchImpl, resolve_), dir, { force });
  } else {
    const path = resolve(cwd, src);
    let isDir: boolean;
    try { isDir = statSync(path).isDirectory(); }
    catch { throw new SkillCmdError(`${path}: no such file or directory`, 2); }
    result = isDir ? installFromDir(path, dir, { force }) : await installFromBytes(readFileSync(path), dir, { force });
  }
  io.out(`installed ${result.name}${result.version ? ` (v${result.version})` : ""} → ${result.path}`);
  for (const w of result.warnings) io.err(`warning: ${w}`);
  return 0;
}

/** The archive body under the SSRF guard (see the header): the address is checked BEFORE the request and again on
 *  every redirect hop — `redirect: "manual"`, so a public URL cannot redirect us into the metadata service — http(s)
 *  only, ≤ MAX_REDIRECTS. A REF'D timeout drives the abort (Bun's AbortSignal.timeout timer is unref'd — webfetch.ts
 *  pattern). A refused address is 1 (nothing was fetched); non-2xx / network failure / over the cap are 2. */
async function download(url: string, fetchImpl: FetchLike, resolve_: Resolver): Promise<Uint8Array> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INSTALL_TIMEOUT_MS);
  (timer as unknown as { ref?: () => void }).ref?.();
  const failure = (e: unknown): SkillCmdError => new SkillCmdError(
    `download failed: ${ac.signal.aborted ? `timed out after ${INSTALL_TIMEOUT_MS}ms` : e instanceof Error ? e.message : String(e)}`, 2);
  try {
    let current = new URL(url);
    let hops = 0;
    for (;;) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new SkillCmdError(`only http(s) URLs can be installed (got ${current.protocol})`, 1);
      }
      let reason: string | null;
      try { reason = await abortable(ssrfDenyReason(current.hostname, resolve_), ac.signal); }
      catch (e) { throw failure(e); }
      if (reason !== null) throw new SkillCmdError(`refused ${current.href}: ${reason}`, 1);
      let res: Response;
      try { res = await abortable(fetchImpl(current.href, { signal: ac.signal, redirect: "manual" }), ac.signal); }
      catch (e) { throw failure(e); }
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new SkillCmdError(`download failed: HTTP ${res.status} from ${current.href} without a Location header`, 2);
        if (++hops > MAX_REDIRECTS) throw new SkillCmdError(`download failed: too many redirects (more than ${MAX_REDIRECTS}) starting from ${url}`, 2);
        try { current = new URL(location, current); } catch { throw new SkillCmdError(`download failed: invalid redirect target ${location}`, 2); }
        continue; // the guard runs again on the new host — that is the point of the manual loop
      }
      if (!res.ok) throw new SkillCmdError(`download failed: HTTP ${res.status} for ${current.href}`, 2);
      const { bytes, truncated } = await readBounded(res, MAX_ARCHIVE_BYTES);
      if (truncated) throw new SkillCmdError(`download exceeds ${MAX_ARCHIVE_BYTES} bytes`, 2);
      return bytes;
    }
  } finally {
    clearTimeout(timer);
  }
}
