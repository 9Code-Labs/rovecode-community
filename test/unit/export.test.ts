/** Port #38: session export — golden markdown, JSONL byte fidelity, prefix
 *  resolution (mirrors /resume), overwrite guard, output cap, CLI wiring.
 *  The golden is committed INLINE and pinned full-string: timestamps come from
 *  the fixture (ISO UTC), the catalog is the offline snapshot, and there is no
 *  wall-clock line — the render must be byte-stable. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/core/session.ts";
import { formatModeSwitchNotice, type ModeChangeEntry } from "../../src/core/modes.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import {
  exportSession, renderSessionMarkdown, resolveSessionId, parseExportArgs, TOOL_OUTPUT_CAP,
} from "../../src/cli/export.ts";

const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);

/** Scripted session: user → assistant(text+tool_call) → tool result → mode switch →
 *  compaction event → user → assistant(failing tool_call) → tool result. Fixed ids
 *  and timestamps; two origins so the per-origin costs table has to group. */
function buildScriptedSession(root: string, id = "goldsess"): SessionStore {
  const s = new SessionStore(root, id);
  s.append({ id: "u1", role: "user", parts: [{ kind: "text", text: "hello there" }], parentId: null, createdAt: T0 });
  s.append({
    id: "a1", role: "assistant",
    parts: [{ kind: "text", text: "Let me look." }, { kind: "tool_call", id: "c1", tool: "read", args: { path: "a.txt" } }],
    parentId: "u1", createdAt: T0 + 60_000, origin: { provider: "mock", model: "default" }, usage: { input: 12, output: 7 },
  });
  s.append({ id: "t1", role: "tool", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "line one\nline two" }], parentId: "a1", createdAt: T0 + 120_000 });
  const sw: ModeChangeEntry = {
    id: "m1", role: "system", parts: [{ kind: "text", text: formatModeSwitchNotice("act", "plan") }],
    parentId: "t1", createdAt: T0 + 180_000, modeSwitch: { from: "act", to: "plan" },
  };
  s.append(sw);
  s.append({ id: "e1", kind: "event", parentId: "m1", createdAt: T0 + 240_000, event: { type: "compaction", strategy: "head-summarize", tokensBefore: 1200, tokensAfter: 300 } });
  s.append({ id: "u2", role: "user", parts: [{ kind: "text", text: "try the risky thing" }], parentId: "e1", createdAt: T0 + 250_000 });
  s.append({
    id: "a2", role: "assistant", parts: [{ kind: "tool_call", id: "c2", tool: "bash", args: { cmd: "boom" } }],
    parentId: "u2", createdAt: T0 + 260_000, origin: { provider: "acme", model: "turbo" }, usage: { input: 5, output: 3, cacheRead: 2 },
  });
  s.append({ id: "t2", role: "tool", parts: [{ kind: "tool_result", callId: "c2", ok: false, output: "exit 1: boom not found" }], parentId: "a2", createdAt: T0 + 300_000 });
  return s;
}

const GOLDEN = [
  "# rovecode session goldsess",
  "",
  "- id: `goldsess`",
  "- range: 2026-09-01T10:00:00.000Z → 2026-09-01T10:05:00.000Z",
  "- models: mock/default, acme/turbo",
  "",
  "## User",
  "",
  "hello there",
  "",
  "## Assistant",
  "",
  "Let me look.",
  "",
  "### tool: read — ok",
  "",
  'args: `{"path":"a.txt"}`',
  "",
  "```",
  "line one",
  "line two",
  "```",
  "",
  "> mode → plan",
  "",
  "> compacted (head-summarize): 1200 → 300 tokens",
  "",
  "## User",
  "",
  "try the risky thing",
  "",
  "## Assistant",
  "",
  "### tool: bash — ERROR",
  "",
  'args: `{"cmd":"boom"}`',
  "",
  "```",
  "exit 1: boom not found",
  "```",
  "",
  "## Costs",
  "",
  "| model | input | output | cache read | cache write | messages |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  "| mock/default | 12 | 7 | 0 | 0 | 1 |",
  "| acme/turbo | 5 | 3 | 2 | 0 | 1 |",
  "",
  "- tokens: 17 in / 10 out · cache: 2 read / 0 written",
  "- context: ~58 tokens (window unknown)",
  "- pricing unknown for acme/turbo",
].join("\n") + "\n";

test("golden markdown for a scripted session — full-string pin, default <short>.md path", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const out = mkdtempSync(join(tmpdir(), "rovecode-export-out-"));
  buildScriptedSession(root);
  const res = exportSession(root, "goldsess", { cwd: out });
  expect(res.format).toBe("markdown");
  expect(res.path).toBe(join(out, "goldsess.md"));
  expect(readFileSync(res.path, "utf8")).toBe(GOLDEN);
  rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test("mode switches render as the replay-convention line, never raw <mode_notice> XML", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const s = buildScriptedSession(root);
  const md = renderSessionMarkdown(s.path(), "goldsess", new ModelCatalog());
  expect(md).toContain("> mode → plan");
  expect(md).not.toContain("<mode_notice>");
  rmSync(root, { recursive: true, force: true });
});

test("--json copies the session JSONL byte-verbatim (whole tree, not a re-serialization)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const out = mkdtempSync(join(tmpdir(), "rovecode-export-out-"));
  const s = buildScriptedSession(root);
  s.branch("t1"); // moved leaf: markdown would shrink, but the raw copy keeps EVERY line
  const src = readFileSync(join(root, "goldsess", "entries.jsonl"));
  const res = exportSession(root, "goldsess", { json: true, cwd: out });
  expect(res.format).toBe("jsonl");
  expect(res.path).toBe(join(out, "goldsess.jsonl"));
  const copied = readFileSync(res.path);
  expect(copied.length).toBe(src.length);
  expect(Buffer.compare(copied, src)).toBe(0);
  rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test("prefix resolution: exact id wins over longer siblings; unique prefix resolves", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  for (const id of ["abc", "abc-one", "abd-two"]) {
    new SessionStore(root, id).append({ id: `${id}-m`, role: "user", parts: [{ kind: "text", text: id }], parentId: null, createdAt: T0 });
  }
  expect(resolveSessionId(root, "abc")).toBe("abc");        // exact beats the "abc-one" prefix hit
  expect(resolveSessionId(root, "abc-")).toBe("abc-one");   // unique prefix
  expect(resolveSessionId(root, "abd")).toBe("abd-two");
  rmSync(root, { recursive: true, force: true });
});

test("ambiguous prefix errors listing candidates (mirrors /resume: never picks silently)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  for (const id of ["abc", "abc-one", "abd-two"]) {
    new SessionStore(root, id).append({ id: `${id}-m`, role: "user", parts: [{ kind: "text", text: id }], parentId: null, createdAt: T0 });
  }
  expect(() => resolveSessionId(root, "ab")).toThrow(/"ab" matches 3 sessions: .*abc.* — be more specific/);
  expect(() => resolveSessionId(root, "zzz")).toThrow('no session matching "zzz"');
  expect(() => exportSession(root, "ab", {})).toThrow(/matches 3 sessions/); // surfaces through export too
  rmSync(root, { recursive: true, force: true });
});

test("never overwrites an existing file without --force; --force replaces it", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const out = mkdtempSync(join(tmpdir(), "rovecode-export-out-"));
  buildScriptedSession(root);
  const first = exportSession(root, "goldsess", { cwd: out });
  expect(existsSync(first.path)).toBe(true);
  expect(() => exportSession(root, "goldsess", { cwd: out })).toThrow(/refusing to overwrite .*goldsess\.md.*--force/);
  writeFileSync(first.path, "OLD CONTENT");
  const forced = exportSession(root, "goldsess", { cwd: out, force: true });
  expect(forced.path).toBe(first.path);
  expect(readFileSync(forced.path, "utf8")).toBe(GOLDEN);
  // the guard applies to --json targets too
  exportSession(root, "goldsess", { json: true, cwd: out });
  expect(() => exportSession(root, "goldsess", { json: true, cwd: out })).toThrow(/refusing to overwrite/);
  rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test("--out overrides the target path (relative resolves against cwd)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const out = mkdtempSync(join(tmpdir(), "rovecode-export-out-"));
  buildScriptedSession(root);
  const rel = exportSession(root, "goldsess", { cwd: out, out: "transcript.md" });
  expect(rel.path).toBe(join(out, "transcript.md"));
  expect(readFileSync(rel.path, "utf8")).toBe(GOLDEN);
  const absTarget = join(out, "abs.jsonl");
  const abs = exportSession(root, "goldsess", { json: true, out: absTarget });
  expect(abs.path).toBe(absTarget);
  rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test(`tool output is clipped at ${TOOL_OUTPUT_CAP} chars with an explicit marker`, () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const s = new SessionStore(root, "bigout");
  const big = "A".repeat(TOOL_OUTPUT_CAP) + "TAIL_SENTINEL";
  s.append({ id: "u1", role: "user", parts: [{ kind: "text", text: "go" }], parentId: null, createdAt: T0 });
  s.append({ id: "a1", role: "assistant", parts: [{ kind: "tool_call", id: "c1", tool: "bash", args: { cmd: "spam" } }], parentId: "u1", createdAt: T0 + 1 });
  s.append({ id: "t1", role: "tool", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: big }], parentId: "a1", createdAt: T0 + 2 });
  const md = renderSessionMarkdown(s.path(), "bigout", new ModelCatalog());
  expect(md).toContain(`*+13 chars clipped (cap ${TOOL_OUTPUT_CAP})*`);
  expect(md).not.toContain("TAIL_SENTINEL");
  expect(md).toContain("A".repeat(TOOL_OUTPUT_CAP)); // the kept head is intact
  rmSync(root, { recursive: true, force: true });
});

test("tool output containing ``` gets a longer fence (block cannot be broken out of)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const s = new SessionStore(root, "fency");
  s.append({ id: "u1", role: "user", parts: [{ kind: "text", text: "go" }], parentId: null, createdAt: T0 });
  s.append({ id: "a1", role: "assistant", parts: [{ kind: "tool_call", id: "c1", tool: "read", args: { path: "x.md" } }], parentId: "u1", createdAt: T0 + 1 });
  s.append({ id: "t1", role: "tool", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "before\n```\ninner\n```\nafter" }], parentId: "a1", createdAt: T0 + 2 });
  const md = renderSessionMarkdown(s.path(), "fency", new ModelCatalog());
  expect(md).toContain("````\nbefore\n```\ninner\n```\nafter\n````");
  rmSync(root, { recursive: true, force: true });
});

test("args containing a `` run get a longer inline-code delimiter (span cannot be closed early)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const s = new SessionStore(root, "ticky");
  s.append({ id: "u1", role: "user", parts: [{ kind: "text", text: "go" }], parentId: null, createdAt: T0 });
  s.append({ id: "a1", role: "assistant", parts: [{ kind: "tool_call", id: "c1", tool: "bash", args: { cmd: "echo ``x``" } }], parentId: "u1", createdAt: T0 + 1 });
  s.append({ id: "t1", role: "tool", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "x" }], parentId: "a1", createdAt: T0 + 2 });
  const md = renderSessionMarkdown(s.path(), "ticky", new ModelCatalog());
  // CommonMark closes a span at the first backtick string of EQUAL length, so a fixed ``
  // delimiter ends at the inner `` — the delimiter must be (longest run + 1) = ```
  expect(md).toContain('args: ``` {"cmd":"echo ``x``"} ```');
  expect(md).not.toContain('args: `` {"cmd"');
  rmSync(root, { recursive: true, force: true });
});

test("markdown walks the ACTIVE path only (branched-away turns excluded); empty session renders", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-export-"));
  const s = buildScriptedSession(root);
  s.branch("t1"); // rewind before the mode switch — later entries leave the active path
  const md = renderSessionMarkdown(new SessionStore(root, "goldsess").path(), "goldsess", new ModelCatalog());
  expect(md).toContain("hello there");
  expect(md).not.toContain("try the risky thing");
  // a directory holding meta.json and no entries: what every start left behind before the store went lazy
  // (core/session.ts materialize()) — still resumable, still exportable as markdown, still refused as JSONL
  mkdirSync(join(root, "hollow"), { recursive: true });
  writeFileSync(join(root, "hollow", "meta.json"), JSON.stringify({ id: "hollow", createdAt: Date.now() }));
  const empty = new SessionStore(root, "hollow");
  const emd = renderSessionMarkdown(empty.path(), "hollow", new ModelCatalog());
  expect(emd).toContain("*(no entries)*");
  expect(emd).toContain("- range: (empty)");
  expect(() => exportSession(root, "hollow", { json: true, cwd: root })).toThrow(/has no entries\.jsonl/);
  rmSync(root, { recursive: true, force: true });
});

test("parseExportArgs: --out value never becomes the session id; flags parsed", () => {
  const a = parseExportArgs(["bun", "main.ts", "export", "--out", "foo.md", "abc1", "--json", "--force"]);
  expect(a).toEqual({ idOrPrefix: "abc1", out: "foo.md", json: true, force: true });
  const b = parseExportArgs(["bun", "main.ts", "export", "abc1"]);
  expect(b).toEqual({ idOrPrefix: "abc1", json: false, force: false });
  expect(parseExportArgs(["bun", "main.ts"]).idOrPrefix).toBeUndefined();
});

test("parseExportArgs: flags before the command are honored; a dangling or flag-shaped --out is a usage error", () => {
  // parseCli dispatches `rovecode --json export <id>` to export — the parser must see that flag too
  expect(parseExportArgs(["bun", "main.ts", "--json", "export", "abc1"])).toEqual({ idOrPrefix: "abc1", json: true, force: false });
  expect(parseExportArgs(["bun", "main.ts", "--force", "--json", "export", "abc1", "--out", "o.jsonl"]))
    .toEqual({ idOrPrefix: "abc1", out: "o.jsonl", json: true, force: true });
  // dispatch-level flags are ignored; only the FIRST `export` is the command (a session
  // whose id starts with "export" is still addressable)
  expect(parseExportArgs(["bun", "main.ts", "--yolo", "export", "export"])).toEqual({ idOrPrefix: "export", json: false, force: false });
  expect(() => parseExportArgs(["bun", "main.ts", "export", "abc1", "--out"])).toThrow(/--out needs a path/);
  expect(() => parseExportArgs(["bun", "main.ts", "export", "abc1", "--out", "--force"])).toThrow(/--out needs a path/);
});

// CLI wiring e2e: the `rovecode export` subcommand end-to-end through main.ts (known set +
// dispatch case). spawnSync — no async stdout readers (the --resume flake class).
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

test("rovecode export e2e: prefix resolves, file lands in cwd, exit 0; unknown id exits 1", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-export-e2e-"));
  const sessionsRoot = join(cwd, ".rovecode", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  buildScriptedSession(sessionsRoot, "e2e-fixed-id");
  const ok = Bun.spawnSync([process.execPath, MAIN, "export", "e2e-f"], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("exported markdown →");
  expect(existsSync(join(cwd, "e2e-fixe.md"))).toBe(true);
  expect(readFileSync(join(cwd, "e2e-fixe.md"), "utf8")).toContain("# rovecode session e2e-fixe");
  const bad = Bun.spawnSync([process.execPath, MAIN, "export", "nope"], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain('no session matching "nope"');
  rmSync(cwd, { recursive: true, force: true });
}, 30_000); // two synchronous main.ts boots (~1.4s each idle) overran Bun's 5s default under suite load

test("rovecode export e2e: --json before the command is honored; dangling --out exits 1 and writes nothing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-export-e2e-"));
  const sessionsRoot = join(cwd, ".rovecode", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  buildScriptedSession(sessionsRoot, "e2e-fixed-id");
  const src = readFileSync(join(sessionsRoot, "e2e-fixed-id", "entries.jsonl"));
  // parseCli routes `rovecode --json export …` to export; the flag must not be lost on the
  // way (it used to write MARKDOWN into o.jsonl with exit 0)
  const pre = Bun.spawnSync([process.execPath, MAIN, "--json", "export", "e2e-f", "--out", "o.jsonl"], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(pre.exitCode).toBe(0);
  expect(pre.stdout.toString()).toContain("exported jsonl →");
  expect(Buffer.compare(readFileSync(join(cwd, "o.jsonl")), src)).toBe(0);
  // --out with no value, or with a flag as its value: usage error, exit 1, no file written
  // (previously: silent default → wrote e2e-fixe.md; or a file literally named "--force")
  for (const tail of [["--out"], ["--out", "--force"]]) {
    const before = readdirSync(cwd);
    const bad = Bun.spawnSync([process.execPath, MAIN, "export", "e2e-f", ...tail], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("--out needs a path");
    expect(readdirSync(cwd)).toEqual(before);
  }
  rmSync(cwd, { recursive: true, force: true });
}, 30_000); // three synchronous main.ts boots — the known 5s-timeout flake under load (seen by 3 critics)

test("a usage error and a failure are different answers: `export` with no id exits 2, a real failure exits 1", async () => {
  // README documents the classes as 0 done · 1 error/budget · 2 usage/startup, and every other command
  // answers that way; export exited 1 for both, so a script could not tell "you typed it wrong" from
  // "it did not work". Spawned rather than called, because the distinction IS the exit code.
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-export-exit-"));
  const main = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, main, "export", ...args], { cwd, env: { ...process.env, ROVECODE_HOME: cwd }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  const noId = await run();
  expect(noId.code).toBe(2);
  expect(noId.err).toContain("usage: rovecode export");

  const missing = await run("nosuchsession");
  expect(missing.code).toBe(1);                       // a real failure, not a usage error
  expect(missing.err).not.toContain("usage:");
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);
