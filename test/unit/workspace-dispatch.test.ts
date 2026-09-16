/** The workspace boundary at the ONE ladder (core/tools.ts dispatch step 2a + core/workspace.ts), over the REAL rule sets
 *  cli/runtime.ts buildCfg produces for the three permission levels, with the real read / write / glob / ls tools and a
 *  spy approver. The proof the contract asks for, as numbers:
 *    - allow-all (auto) and accept-edits: ZERO new prompts — inside the cwd, inside a `--add-dir` root, and (auto) even
 *      outside; a person who never touches a path outside their project cannot tell this shipped (the same script of
 *      inside operations asks exactly the same cards with and without roots, under every level);
 *    - the ONLY new prompt is a path genuinely outside the cwd and every root under gated (ask) rules — and under
 *      accept-edits a WRITE outside, which already asked before (the ordinary card); it now asks with the boundary card;
 *    - the card names the path, the cwd, the roots that exist and the remedy; "always" is remembered per DIRECTORY;
 *    - a deny rule on file.external is a denial that names the boundary; headless (no approver) fails closed;
 *    - a `--add-dir` root is visible to every decision: read / glob / ls / write under it never reach the card;
 *    - what the tool opens is what the ladder judged: `<cwd>/<link>/../own.txt` reads INSIDE; `<cwd>/<link>/secret.txt` asks.
 *  MUTATION TARGETS: drop step 2a → the outside read passes silently; skip canonical() → the link read passes; key the
 *  "always" on the file → the second file in the dir asks again; drop roots.rules() → a read under a root asks. */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { globTool, lsTool } from "../../src/coding/files.ts";
import { readTool, writeTool } from "../../src/coding/hashline.ts";
import { describeResource, ToolRegistry } from "../../src/core/tools.ts";
import type { ApprovalRequest, PermissionRule, RunEvent, ToolContext, ToolOutput } from "../../src/core/types.ts";
import { EXTERNAL_ACTION, toolPath } from "../../src/core/workspace.ts";
import { createRuntime } from "../../src/cli/runtime.ts";

const pending: string[] = [];
afterEach(() => {
  for (const d of pending.splice(0)) for (let i = 0; i < 8; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50); } }
});
const win = process.platform === "win32";

interface Rig {
  base: string; cwd: string; lib: string; other: string;
  asks: ApprovalRequest[]; events: RunEvent[]; reg: ToolRegistry;
  /** rules exactly as a session at this level would carry them, with or without the lib root */
  rules(level: false | "accept-edits" | true, withRoot?: boolean): PermissionRule[];
  dispatch(tool: string, args: unknown, rules: PermissionRule[], approver?: ((r: ApprovalRequest) => Promise<"once" | "always" | "deny">) | null): Promise<ToolOutput>;
}

function rig(): Rig {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "rovecode-ws-dispatch-"))); pending.push(base);
  const cwd = join(base, "proj"), lib = join(base, "lib"), other = join(base, "other");
  for (const d of [cwd, lib, other, join(base, "proj2")]) mkdirSync(d);
  writeFileSync(join(cwd, "own.txt"), "OWN\n");
  writeFileSync(join(lib, "lib.txt"), "LIB\n");
  writeFileSync(join(other, "out.txt"), "OUTSIDE-SECRET\n");
  writeFileSync(join(other, "second.txt"), "SECOND-SECRET\n");
  writeFileSync(join(base, "proj2", "x.txt"), "SIBLING\n");
  const asks: ApprovalRequest[] = [], events: RunEvent[] = [];
  const reg = new ToolRegistry(); reg.register(readTool, writeTool, globTool, lsTool);
  const cache = new Map<string, PermissionRule[]>();
  const rules = (level: false | "accept-edits" | true, withRoot = true): PermissionRule[] => {
    const key = `${String(level)}|${withRoot}`;
    let r = cache.get(key);
    if (!r) { r = createRuntime({ cwd, stream: null, sessionId: `s-${key}`, ...(withRoot ? { addDirs: [lib] } : {}) }).buildCfg(level).permissionRules; cache.set(key, r); }
    return r;
  };
  const yes = async (r: ApprovalRequest): Promise<"once"> => { asks.push(r); return "once"; };
  return {
    base, cwd, lib, other, asks, events, reg, rules,
    dispatch: (tool, args, rs, approver = yes) => reg.dispatch({ kind: "tool_call", id: `c${events.length}`, tool, args }, { sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } } as ToolContext, undefined, rs, approver ?? undefined, (e) => events.push(e)),
  };
}
const denied = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: "tool_call_failed" }> => e.type === "tool_call_failed" && e.reason === "permission_denied");
/** the inside-only script a person who never leaves their project runs: what it asks must not change with roots */
async function insideScript(r: Rig, rules: PermissionRule[]): Promise<string[]> {
  const before = r.asks.length;
  await r.dispatch("read", { path: "own.txt" }, rules);
  await r.dispatch("read", { path: join(r.cwd, "own.txt") }, rules);
  await r.dispatch("glob", { pattern: "*.txt" }, rules);
  await r.dispatch("ls", {}, rules);
  await r.dispatch("ls", { path: r.cwd }, rules);
  await r.dispatch("write", { path: "new.txt", content: "n\n" }, rules);
  await r.dispatch("write", { path: join(r.cwd, "deep", "later.txt"), content: "d\n" }, rules);
  return r.asks.slice(before).map((a) => a.reason);
}

test("PROOF (auto): allow-all rules see ZERO prompts anywhere — inside, under the root, outside the workspace; the boundary rule exists (yolo's `* *` allows it) and nothing asks", async () => {
  const r = rig();
  const rules = r.rules(true);
  expect(rules).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  expect(await insideScript(r, rules)).toEqual([]);
  expect((await r.dispatch("read", { path: join(r.other, "out.txt") }, rules)).output).toContain("OUTSIDE-SECRET");
  expect((await r.dispatch("read", { path: join(r.lib, "lib.txt") }, rules)).output).toContain("LIB");
  await r.dispatch("write", { path: join(r.other, "w.txt"), content: "x" }, rules);
  expect(r.asks.length).toBe(0);
  expect(denied(r.events)).toEqual([]);
});

test("PROOF (accept-edits): ZERO new prompts — reads and writes inside the cwd and under the `--add-dir` root ask nothing; the inside script asks exactly the same (nothing) with and without the root; a WRITE outside asked before (ordinary card) and asks now (boundary card) — one card either way", async () => {
  const r = rig();
  const withRoot = r.rules("accept-edits"), without = r.rules("accept-edits", false);
  expect(await insideScript(r, without)).toEqual([]);
  expect(await insideScript(r, withRoot)).toEqual([]);
  expect((await r.dispatch("read", { path: join(r.lib, "lib.txt") }, withRoot)).output).toContain("LIB");
  expect((await r.dispatch("write", { path: join(r.lib, "made.txt"), content: "m\n" }, withRoot)).ok).toBe(true);
  expect((await r.dispatch("glob", { pattern: "*.txt", path: r.lib }, withRoot)).ok).toBe(true);
  expect((await r.dispatch("ls", { path: r.lib }, withRoot)).ok).toBe(true);
  expect(r.asks.length).toBe(0); // ← the number the contract asks for: zero, with roots, under accept-edits
  // a write OUTSIDE every root asked before this shipped (file.write * prompt) and asks now: one card, now the one that says why
  await r.dispatch("write", { path: join(r.other, "w.txt"), content: "x" }, withRoot);
  expect(r.asks.length).toBe(1);
  expect(r.asks[0]!.reason).toContain(`${join(r.other, "w.txt")} is outside the workspace ${r.cwd} and its roots ${join(r.lib, "*")}`);
  expect(r.asks[0]!.external).toBe(join(r.other, "*"));
  // …and a read outside, which used to pass in silence under accept-edits, is the ONE genuinely new card
  await r.dispatch("read", { path: join(r.other, "out.txt") }, withRoot);
  expect(r.asks.length).toBe(2);
  expect(r.asks[1]!.reason).toContain("is outside the workspace");
});

test("PROOF (gated / ask): the inside script asks the same two ordinary write cards with and without roots — never a boundary card; a read under the root asks nothing; the ONLY new prompt is a path outside the cwd and every root, and its card names the path, the cwd, the root and the remedy", async () => {
  const r = rig();
  const withRoot = r.rules(false), without = r.rules(false, false);
  const a = await insideScript(r, without);
  const b = await insideScript(r, withRoot);
  expect(a).toEqual(b);
  expect(a.length).toBe(2);                                                   // the two writes: the ordinary card, as before
  for (const reason of a) { expect(reason).toStartWith("permission required for file.write"); expect(reason).not.toContain("outside the workspace"); }
  expect(r.asks.every((x) => x.external === undefined)).toBe(true);
  const before = r.asks.length;
  expect((await r.dispatch("read", { path: join(r.lib, "lib.txt") }, withRoot)).output).toContain("LIB");
  expect((await r.dispatch("read", { path: join(r.lib, "sub", "..", "lib.txt") }, withRoot)).output).toContain("LIB");
  expect((await r.dispatch("glob", { pattern: "*.txt", path: r.lib }, withRoot)).ok).toBe(true);
  expect((await r.dispatch("ls", { path: r.lib }, withRoot)).ok).toBe(true);
  expect(r.asks.length).toBe(before);                                          // a root is visible to the decision: nothing under it asks
  // the one new card
  const out = await r.dispatch("read", { path: join(r.other, "out.txt") }, withRoot);
  expect(out.output).toContain("OUTSIDE-SECRET");                              // "once" → it ran
  expect(r.asks.length).toBe(before + 1);
  const card = r.asks.at(-1)!;
  expect(card.tool).toBe("read");
  expect(card.external).toBe(join(r.other, "*"));
  expect(card.reason).toBe(`${join(r.other, "out.txt")} is outside the workspace ${r.cwd} and its roots ${join(r.lib, "*")} — allow once/always for this directory, or start rovecode with --add-dir <dir> to make it a workspace root`);
  // without the root the same card has no "and its roots" clause
  await r.dispatch("read", { path: join(r.other, "out.txt") }, without);
  expect(r.asks.at(-1)!.reason).toBe(`${join(r.other, "out.txt")} is outside the workspace ${r.cwd} — allow once/always for this directory, or start rovecode with --add-dir <dir> to make it a workspace root`);
  // the sibling-PREFIX dir asks too (never a startsWith test)
  await r.dispatch("read", { path: join(r.base, "proj2", "x.txt") }, withRoot);
  expect(r.asks.at(-1)!.external).toBe(join(r.base, "proj2", "*"));
  // the rule set itself: the boundary prompt sits in the gated set, the root right after it; the same rules minus the root otherwise
  expect(withRoot.filter((x) => x.action === EXTERNAL_ACTION)).toEqual([{ action: EXTERNAL_ACTION, resource: "*", effect: "prompt" }, { action: EXTERNAL_ACTION, resource: join(r.lib, "*"), effect: "allow" }]);
  expect(without.filter((x) => x.action === EXTERNAL_ACTION)).toEqual([{ action: EXTERNAL_ACTION, resource: "*", effect: "prompt" }]);
  expect(withRoot.filter((x) => x.action !== EXTERNAL_ACTION)).toEqual(without.filter((x) => x.action !== EXTERNAL_ACTION));
});

test("'always' on the boundary card is remembered for the DIRECTORY: a second file in that dir, and a glob over it, ask nothing more; 'deny' is the user's decision; the ordinary write card's own key is untouched", async () => {
  const r = rig();
  const rules = r.rules(false);
  const always = async (a: ApprovalRequest): Promise<"always"> => { r.asks.push(a); return "always"; };
  expect((await r.dispatch("read", { path: join(r.other, "out.txt") }, rules, always)).output).toContain("OUTSIDE-SECRET");
  expect((await r.dispatch("read", { path: join(r.other, "second.txt") }, rules, always)).output).toContain("SECOND-SECRET");
  expect((await r.dispatch("glob", { pattern: "*.txt", path: r.other }, rules, always)).ok).toBe(true);
  expect(r.asks.length).toBe(1); // MUTATION: key the grant on the file → 3
  const deny = async (a: ApprovalRequest): Promise<"deny"> => { r.asks.push(a); return "deny"; };
  const d = await r.dispatch("read", { path: join(r.base, "proj2", "x.txt") }, rules, deny);
  expect(d).toEqual({ ok: false, output: "Permission denied by user" });
  expect(d.output).not.toContain("SIBLING");
});

test("a `deny file.external <dir>\\*` rule denies with a reason that names the boundary; a primary deny (plan mode's `file.write *`) wins before the boundary is consulted; headless with no approver fails closed with the existing shape", async () => {
  const r = rig();
  const rules = [...r.rules(false), { action: EXTERNAL_ACTION, resource: join(r.other, "*"), effect: "deny" as const }];
  const out = await r.dispatch("read", { path: join(r.other, "out.txt") }, rules);
  expect(out.ok).toBe(false);
  expect(out.output).toBe(`Permission denied: ${join(r.other, "out.txt")} is outside the workspace ${r.cwd} (denied by rule file.external ${join(r.other, "*")})`);
  expect(out.output).not.toContain("OUTSIDE-SECRET");
  expect(r.asks).toEqual([]);
  expect(denied(r.events).length).toBe(1);
  const plan = [...r.rules(false), { action: "file.write", resource: "*", effect: "deny" as const }];
  const w = await r.dispatch("write", { path: join(r.other, "p.txt"), content: "x" }, plan);
  expect(w.output).toBe("Permission denied: denied by rule file.write *");
  expect(existsSync(join(r.other, "p.txt"))).toBe(false);
  expect(r.asks).toEqual([]);
  const headless = await r.dispatch("read", { path: join(r.other, "out.txt") }, r.rules(false), null);
  expect(headless).toEqual({ ok: false, output: "Permission denied: approval required, no approver available" });
});

test("a rule list that never mentions file.external is byte-identical behaviour: no canonicalisation, no card — a read outside under `file.read * allow` alone passes as it always did", async () => {
  const r = rig();
  const bare: PermissionRule[] = [{ action: "file.read", resource: "*", effect: "allow" }];
  expect((await r.dispatch("read", { path: join(r.other, "out.txt") }, bare)).output).toContain("OUTSIDE-SECRET");
  expect(r.asks).toEqual([]);
});

test("what the tool opens is what the ladder judged: `<cwd>/<link>/../own.txt` is judged AND read as `<cwd>/own.txt` (no card); `<cwd>/<link>/secret.txt` is outside through the link's real target (card, names the real dir); a write through `..` lands where it was judged; describeResource == toolPath for every spelling", async () => {
  const r = rig();
  const target = join(r.base, "target"); mkdirSync(target);
  writeFileSync(join(target, "secret.txt"), "LINK-SECRET\n");
  symlinkSync(target, join(r.cwd, "link"), win ? "junction" : "dir");
  const rules = r.rules(false);
  const viaDotDot = [r.cwd, "link", "..", "own.txt"].join(sep);
  expect((await r.dispatch("read", { path: viaDotDot }, rules)).output).toContain("OWN");
  expect(r.asks).toEqual([]);                                                         // inside, lexically — and opened inside
  const direct = await r.dispatch("read", { path: join(r.cwd, "link", "secret.txt") }, rules);
  expect(direct.output).toContain("LINK-SECRET");                                     // "once" → ran, but it ASKED, naming the real dir
  expect(r.asks.length).toBe(1);
  expect(r.asks[0]!.external).toBe(join(target, "*"));
  await r.dispatch("write", { path: [r.cwd, "link", "..", "via.txt"].join(sep), content: "v\n" }, rules);
  expect(readFileSync(join(r.cwd, "via.txt"), "utf8")).toBe("v\n");                  // landed in the cwd, where it was judged
  expect(existsSync(join(target, "via.txt"))).toBe(false);
  for (const p of [viaDotDot, "own.txt", join(r.cwd, "link", "secret.txt"), join(r.base, "..", "elsewhere", "x"), `${r.cwd}${sep}.${sep}own.txt`]) {
    expect(describeResource(readTool, { path: p }, r.cwd)).toBe(toolPath(r.cwd, p));
  }
});

test("runtime carries the roots: rt.roots, the prompt line only with roots, the two boot notes (dropped values, the checkpoint limit) on the plugin-warning channel, and `.rovecode/sessions` untouched by a refused value", () => {
  const r = rig();
  const plain = createRuntime({ cwd: r.cwd, stream: null, sessionId: "s-plain" });
  expect(plain.roots.dirs).toEqual([]);
  expect(plain.buildDef({ provider: "mock", model: "default" }).systemPrompt).not.toContain("Additional workspace roots");
  mkdirSync(join(r.cwd, "deep-inside")); // a real directory INSIDE the cwd: dropped with a note, never a root (a missing one would be the error below)
  const rt = createRuntime({ cwd: r.cwd, stream: null, sessionId: "s-roots", addDirs: [r.lib, join(r.cwd, "deep-inside")] });
  expect(rt.roots.dirs).toEqual([r.lib]);
  const prompt = rt.buildDef({ provider: "mock", model: "default" }).systemPrompt;
  expect(typeof prompt === "string" ? prompt : prompt({} as never)).toContain(`Additional workspace roots (name them by absolute path): ${r.lib}`);
  expect(rt.plugins.warnings.some((w) => w.includes("checkpoints cover") && w.includes(r.cwd))).toBe(true);
  expect(rt.plugins.warnings.some((w) => w.startsWith("rovecode: --add-dir:") && w.includes("dropped"))).toBe(true);
  // a nested value is dropped with a note, not an error; an absent dir is the startup-error class, before any side effect
  const fresh = join(r.base, "fresh"); mkdirSync(fresh);
  expect(() => createRuntime({ cwd: fresh, stream: null, addDirs: [join(r.base, "nope")] })).toThrow('--add-dir "' + join(r.base, "nope") + '" is not a directory');
  expect(existsSync(join(fresh, ".rovecode"))).toBe(false);
});
