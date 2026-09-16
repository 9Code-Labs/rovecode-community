/** core/workspace.ts (ported from the Nimbus harness, #81): the containment rule (path.relative, never a prefix test), the
 *  canonical spelling (realpath through the deepest existing ancestor: junctions, case, 8.3 names), toolPath (the ONE
 *  spelling the ladder judges and the tools open — `..` collapses lexically before any lookup), externalResource (the
 *  `<dir>\*` grant shape), rootProblem / resolveRoots (a non-directory, a filesystem root and a `*` in the name are refused;
 *  nested and duplicate values are dropped with one note), WorkspaceRoots (rules, accept-edits rules, banner, prompt line,
 *  the named checkpoint limit) and outsidePrompt (the card text names the path, the cwd, the roots and the remedy).
 *  MUTATION TARGETS are named per test. Hermetic: scratch dirs, swept after each test (Windows retry). */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  EXTERNAL_ACTION, WorkspaceRootError, WorkspaceRoots, canonical, externalResource, isInside, outsidePrompt, outsideWorkspace,
  resolveRoots, rootProblem, toolPath,
} from "../../src/core/workspace.ts";

const pending: string[] = [];
function scratch(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); pending.push(d); return d; }
afterEach(() => {
  for (const d of pending.splice(0)) {
    for (let i = 0; i < 8; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50); } }
  }
});
const real = (prefix: string): string => realpathSync.native(scratch(prefix));
const win = process.platform === "win32";

// ---------- isInside: the relative() rule ----------

test("isInside: the root itself, a nested file and a nested dir are inside; a parent, a sibling and the sibling-PREFIX dir are outside (MUTATION: startsWith(root) says the `proj2` sibling is inside)", () => {
  const base = real("rovecode-ws-");
  const proj = join(base, "proj");
  expect(isInside(proj, proj)).toBe(true);
  expect(isInside(proj, join(proj, "src", "a.ts"))).toBe(true);
  expect(isInside(proj, join(proj, "sub"))).toBe(true);
  expect(isInside(proj, base)).toBe(false);
  expect(isInside(proj, join(base, "other", "x.txt"))).toBe(false);
  expect(isInside(proj, join(base, "proj2", "x.txt"))).toBe(false); // the prefix trap
  expect(isInside(proj, join(base, "proj2"))).toBe(false);
  expect(isInside(proj, join(proj, "..", "proj2", "x"))).toBe(false); // `..` inside the spelling still leaves the root
});

test("isInside: a filesystem root contains every path on it; another drive / an absolute elsewhere is outside", () => {
  const root = parse(process.cwd()).root; // `C:\` or `/`
  expect(isInside(root, join(root, "x", "y.txt"))).toBe(true);
  expect(isInside(join(root, "a"), join(root, "b"))).toBe(false);
  if (win) expect(isInside("C:\\proj", "D:\\proj\\x.txt")).toBe(false);
});

test.skipIf(!win)("win32: a lower-cased drive / directory spelling and forward slashes are the same place — canonical() collapses them and isInside compares case-insensitively for a tail that does not exist yet", () => {
  const dir = real("rovecode-ws-case-");
  writeFileSync(join(dir, "F.txt"), "x");
  expect(canonical(dir.toLowerCase())).toBe(dir);
  expect(canonical(dir.replace(/\\/g, "/") + "/F.txt")).toBe(join(dir, "F.txt"));
  expect(outsideWorkspace(dir.toLowerCase(), join(dir, "new", "missing.txt"))).toBe(false);          // non-existent tail, different case on the root
  expect(outsideWorkspace(dir, join(dir.toUpperCase(), "Missing", "x.txt"))).toBe(false);
  expect(isInside(dir, join(dir.toUpperCase(), "Missing", "x.txt"))).toBe(true);                    // relative() on win32 is case-insensitive
});

test.skipIf(!win)("win32: an 8.3 short-name spelling of a long directory is the same root (realpath) — the CI runner's short TEMP shape (MUTATION: no realpath on either side → the short spelling is outside)", () => {
  const base = real("rovecode-ws-83-");
  const long = join(base, "LongDirectoryNameForShortNames");
  mkdirSync(long);
  writeFileSync(join(long, "f.txt"), "x");
  expect(long.includes(" ")).toBe(false);                    // the unquoted `for` probe below needs a space-free path
  const r = spawnSync("cmd.exe", ["/d", "/c", `for %I in (${long}) do @echo %~sI`], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const short = (r.stdout ?? "").trim();
  expect(short.length > 0).toBe(true);                       // cmd answered (8.3 names may be disabled on the volume: then short === long, still one root)
  expect(canonical(short)).toBe(long);
  expect(outsideWorkspace(short, join(long, "f.txt"))).toBe(false);
  expect(outsideWorkspace(long, join(short, "f.txt"))).toBe(false);
  expect(externalResource(join(short, "f.txt"))).toBe(join(long, "*"));
});

test("a junction (win32) / symlink (POSIX) INSIDE the cwd that points OUTSIDE is outside — containment is judged on the real target (MUTATION: skip canonical → the link path looks inside)", () => {
  const base = real("rovecode-ws-link-");
  const cwd = join(base, "cwd"), target = join(base, "target");
  mkdirSync(cwd); mkdirSync(target);
  writeFileSync(join(target, "secret.txt"), "s");
  const link = join(cwd, "link");
  symlinkSync(target, link, win ? "junction" : "dir");
  expect(canonical(join(link, "secret.txt"))).toBe(join(target, "secret.txt"));
  expect(outsideWorkspace(cwd, join(link, "secret.txt"))).toBe(true);
  expect(outsideWorkspace(cwd, link)).toBe(true);
  expect(externalResource(join(link, "secret.txt"))).toBe(join(target, "*")); // the grant names the REAL dir
  expect(outsideWorkspace(cwd, join(cwd, "own.txt"))).toBe(false);          // a plain file in the cwd stays inside
  // the same through a link on the ROOT side: a cwd reached through a junction is the real cwd
  const cwdLink = join(base, "cwd-link");
  symlinkSync(cwd, cwdLink, win ? "junction" : "dir");
  expect(outsideWorkspace(cwdLink, join(cwd, "own.txt"))).toBe(false);
});

// ---------- toolPath: what a tool opens is what the ladder judged ----------

test("toolPath: ONE spelling for the ladder and the tools — absolute, `.`/`..`/doubled separators collapsed LEXICALLY before any lookup, a trailing separator dropped, relative against the cwd; through a link then `..` the link segment is gone (MUTATION: `isAbsolute(p) ? p : join(cwd, p)` keeps the raw `link/../` spelling a POSIX kernel resolves through the link's TARGET)", () => {
  const base = real("rovecode-ws-toolpath-");
  const cwd = join(base, "cwd"), target = join(base, "target"), side = join(cwd, "side");
  mkdirSync(cwd); mkdirSync(target); mkdirSync(side);
  symlinkSync(target, join(cwd, "link"), win ? "junction" : "dir");
  const spelled = [cwd, "link", "..", "side", "own.txt"].join(sep);     // through the link, then `..`: a POSIX kernel would land in <base>/side
  expect(spelled).toContain(`${sep}link${sep}..${sep}`);                // string-built on purpose: path.join would collapse the `..` itself
  expect(toolPath(cwd, spelled)).toBe(join(side, "own.txt"));          // lexical: the link segment is gone before any open
  expect(toolPath(cwd, `${cwd}${sep}.${sep}side${sep}${sep}own.txt`)).toBe(join(side, "own.txt"));
  expect(toolPath(cwd, join(side, "own.txt") + sep)).toBe(join(side, "own.txt"));
  expect(toolPath(cwd, "side/../side/own.txt")).toBe(join(side, "own.txt"));
  expect(toolPath(cwd, ["link", "..", "side", "own.txt"].join(sep))).toBe(join(side, "own.txt"));
  expect(toolPath(cwd, join(cwd, "link", "own.txt"))).toBe(join(cwd, "link", "own.txt")); // the direct link spelling is untouched here — canonical() judges it
  expect(canonical(toolPath(cwd, join(cwd, "link", "own.txt")))).toBe(join(target, "own.txt"));
  expect(outsideWorkspace(cwd, toolPath(cwd, spelled))).toBe(false);  // …so an INSIDE verdict means the tool opens INSIDE too
  expect(outsideWorkspace(cwd, toolPath(cwd, join(cwd, "link", "own.txt")))).toBe(true);
  if (win) {
    expect(toolPath("C:\\cwd", "/workspace/link/../x")).toBe(resolve("/workspace/x")); // a rooted spelling without a drive lands on the PROCESS drive, where node:fs opens it; `..` still collapses
    expect(toolPath("C:\\cwd", "/workspace/x")).toBe(resolve("/workspace/x"));        // never kept forward-slashed: that carve-out would let `/proj/.env` dodge an absolute deny
  } else {
    expect(toolPath("/cwd", "/other/./x/../y")).toBe("/other/y");
  }
});

test("rootProblem / resolveRoots: a directory NAME holding `*` cannot be a root (its `allow file.external <dir>\\*` rule would widen past that dir) — refused on the spelling before the stat, and on the real path of a link to such a dir (POSIX, the only platform that allows the name)", () => {
  const base = real("rovecode-ws-star-");
  const cwd = join(base, "cwd"); mkdirSync(cwd);
  const msg = rootProblem(join(base, "we*ird"), "we*ird");
  expect(msg).toContain('--add-dir "we*ird"');
  expect(msg).toContain('contains "*"');
  expect(() => resolveRoots(cwd, ["we*ird"], base)).toThrow(WorkspaceRootError);
  expect(() => resolveRoots(cwd, ["we*ird"], base)).toThrow(/contains "\*"/);
  if (!win) {
    mkdirSync(join(base, "we*ird"));
    expect(rootProblem(join(base, "we*ird"), "we*ird")).toContain('contains "*"');
    symlinkSync(join(base, "we*ird"), join(base, "plain"), "dir");
    expect(rootProblem(join(base, "plain"), "plain")).toContain('contains "*"');       // the real path is checked too
  }
});

// ---------- externalResource ----------

test("externalResource: a file → its real parent dir + `\\*`; an existing directory (glob/grep/ls target) → the dir itself + `\\*`; a not-yet-existing nested file → its (missing) parent + `\\*`; a drive-root file → `<root>*` (MUTATION: the bare dir would never match `allow file.external <dir>\\*`)", () => {
  const dir = real("rovecode-ws-ext-");
  writeFileSync(join(dir, "a.txt"), "a");
  mkdirSync(join(dir, "sub"));
  expect(externalResource(join(dir, "a.txt"))).toBe(join(dir, "*"));
  expect(externalResource(join(dir, "sub"))).toBe(join(dir, "sub", "*"));
  expect(externalResource(join(dir, "sub") + sep)).toBe(join(dir, "sub", "*"));
  expect(externalResource(join(dir, "new", "deep.txt"))).toBe(join(dir, "new", "*"));
  expect(externalResource(dir.toLowerCase() === dir ? join(dir, "a.txt") : join(dir.toLowerCase(), "a.txt"))).toBe(join(dir, "*")); // case collapses (win32) or is literal (POSIX, same spelling)
  const root = parse(dir).root;
  expect(externalResource(join(root, "rovecode-p81-no-such-file.txt"))).toBe(root + "*");
  expect(externalResource(root)).toBe(root + "*");
});

// ---------- resolveRoots ----------

test("resolveRoots: values resolve against `base` (the launch dir), come back canonical, keep argv order; exact and canonical duplicates collapse; a root inside the cwd and a root inside another root are dropped with ONE note; a wider root replaces the narrower one", () => {
  const base = real("rovecode-ws-roots-");
  const cwd = join(base, "cwd"), lib = join(base, "lib"), other = join(base, "other");
  for (const d of [cwd, lib, join(lib, "sub"), other, join(cwd, "inside")]) mkdirSync(d, { recursive: true });
  const r = resolveRoots(cwd, ["lib", other, "./lib", join(lib, "sub"), join(cwd, "inside"), lib.toLowerCase() === lib ? lib + sep : lib.toLowerCase()], base);
  expect(r.dirs).toEqual([lib, other]);
  expect(r.notes.length).toBe(1);
  expect(r.notes[0]).toStartWith("rovecode: --add-dir:");
  expect(r.notes[0]).toContain("dropped");
  expect(r.notes[0]).toContain(join(lib, "sub"));
  expect(r.notes[0]).toContain(join(cwd, "inside"));
  // no values → no roots, no note; a wider root after a narrower one replaces it (one root, one note)
  expect(resolveRoots(cwd, [], base)).toEqual({ dirs: [], notes: [] });
  const wide = resolveRoots(cwd, [join(lib, "sub"), lib], base);
  expect(wide.dirs).toEqual([lib]);
  expect(wide.notes.length).toBe(1);
  expect(wide.notes[0]).toContain(join(lib, "sub"));
});

test("resolveRoots / rootProblem: a missing path or a file is `--add-dir \"<v>\" is not a directory`; a filesystem root is refused with the `would disable the workspace boundary — pass --yolo` line (MUTATION: skip the root check → `C:\\` becomes a root)", () => {
  const base = real("rovecode-ws-bad-");
  const cwd = join(base, "cwd"); mkdirSync(cwd);
  writeFileSync(join(base, "file.txt"), "f");
  expect(() => resolveRoots(cwd, ["nope"], base)).toThrow(WorkspaceRootError);
  expect(() => resolveRoots(cwd, ["nope"], base)).toThrow('--add-dir "nope" is not a directory');
  expect(() => resolveRoots(cwd, ["file.txt"], base)).toThrow('--add-dir "file.txt" is not a directory');
  const root = parse(cwd).root;
  expect(() => resolveRoots(cwd, [root], base)).toThrow(/would disable the workspace boundary — pass --yolo/);
  expect(rootProblem(root, root)).toContain("would disable the workspace boundary — pass --yolo");
  expect(rootProblem(join(base, "file.txt"), "file.txt")).toBe('--add-dir "file.txt" is not a directory');
  expect(rootProblem(cwd, "cwd")).toBeUndefined();
  if (win) expect(() => resolveRoots(cwd, ["c:/"], base)).toThrow(/filesystem root/); // a lower-cased, forward-slashed root spelling is still the root
});

// ---------- WorkspaceRoots ----------

test("WorkspaceRoots: canonical cwd, `allow file.external <dir>\\*` and `allow file.write <dir>\\*` per root, rootOf by canonical containment (cwd is not a root there), `+<dir>` banner text, the prompt sentence and the checkpoint limit only when roots exist", () => {
  const base = real("rovecode-ws-class-");
  const cwd = join(base, "cwd"), lib = join(base, "lib");
  mkdirSync(cwd); mkdirSync(lib); mkdirSync(join(lib, "deep"));
  const none = new WorkspaceRoots(cwd);
  expect(none.cwd).toBe(cwd);
  expect(none.dirs).toEqual([]);
  expect(none.rules()).toEqual([]);
  expect(none.acceptEditsRules()).toEqual([]);
  expect(none.describe()).toBe("");
  expect(none.promptLine()).toBe("");
  expect(none.checkpointNote()).toBe("");
  const roots = new WorkspaceRoots(cwd.toLowerCase() === cwd ? cwd : cwd.toLowerCase(), resolveRoots(cwd, [lib]));
  expect(roots.cwd).toBe(cwd);
  expect(roots.dirs).toEqual([lib]);
  expect(roots.rules()).toEqual([{ action: EXTERNAL_ACTION, resource: join(lib, "*"), effect: "allow" }]);
  expect(roots.acceptEditsRules()).toEqual([{ action: "file.write", resource: join(lib, "*"), effect: "allow" }]);
  expect(roots.rootOf(join(lib, "deep", "x.ts"))).toBe(lib);
  expect(roots.rootOf(lib)).toBe(lib);
  expect(roots.rootOf(join(cwd, "x.ts"))).toBeUndefined();
  expect(roots.rootOf(join(base, "lib2", "x.ts"))).toBeUndefined(); // the sibling-prefix trap again
  expect(roots.describe()).toBe(`+${lib}`);
  expect(roots.promptLine()).toBe(`\n\nAdditional workspace roots (name them by absolute path): ${lib}`);
  expect(roots.checkpointNote()).toBe(`roots: +${lib} — checkpoints cover ${cwd} only; a change under an added root is not snapshotted and /restore does not undo it`);
  expect(EXTERNAL_ACTION).toBe("file.external");
});

test("outsidePrompt names the path, the cwd, the roots the ladder allows (its `allow file.external <dir>\\*` rules, never `*`) and the --add-dir remedy — never a bare denial", () => {
  const p = outsidePrompt("D:\\other\\x.txt", "D:\\proj", [
    { action: "file.external", resource: "*", effect: "prompt" },
    { action: "file.external", resource: "D:\\lib\\*", effect: "allow" },
    { action: "file.read", resource: "*", effect: "allow" },
  ]);
  expect(p).toContain("D:\\other\\x.txt is outside the workspace D:\\proj");
  expect(p).toContain("and its roots D:\\lib\\*");
  expect(p).not.toContain("roots *");
  expect(p).toContain("--add-dir");
  expect(outsidePrompt("/o/x", "/p", [])).toBe("/o/x is outside the workspace /p — allow once/always for this directory, or start rovecode with --add-dir <dir> to make it a workspace root");
});
