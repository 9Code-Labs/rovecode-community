/** coding/lsp-gate.ts driven by the server table (ported from the Nimbus harness, #73): exact argv spawned (no implicit
 *  --stdio), the extension's LSP languageId on didOpen, the sanitised argv[0] label, ONE probe per distinct argv per root (a
 *  miss is off for the process and never re-probed; siblings unaffected), one server per argv, `ext=off` / the bare `off` /
 *  an ungated extension → no probe and no spawn, the built-in entry's #13 test hooks (cmd / serverName), the settings value
 *  reaching lspGateNote lazily, and the boot-time availability notes for a missing configured server and a malformed table.
 *  MUTATION TARGETS: cache one probe result across argvs → the independence test; re-probe on every note → the which() count;
 *  re-add `--stdio` → the argv tail; ignore the bare off → the zero-probe rows; replace the merge → the .py-with-defaults rows.
 *  Hermetic: the only child is [process.execPath, test/fixtures/fake-lsp.ts, <mode>]; scratch dirs swept after child exit. */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";
import { createLspGate, disposeDefaultGates, lspAvailabilityNote, lspAvailabilityNotes, lspGateNote, serverLabel, settingsLspValue, type LspGate } from "../../src/coding/lsp-gate.ts";
import { resolveServerTable } from "../../src/coding/lsp-servers.ts";
import { loadSettings } from "../../src/core/settings.ts";

// ---------- scratch dirs, swept after each test even when an expect throws (Windows: a live server cwd locks the dir) ----------
const pending: string[] = [];
function scratch(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); pending.push(d); return d; }
async function rmrf(dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  rmSync(dir, { recursive: true, force: true });
}
afterEach(async () => { for (const g of disposeDefaultGates()) await disposeAll(g); for (const d of pending.splice(0)) await rmrf(d); });

const FIXTURE = join(import.meta.dir, "..", "fixtures", "fake-lsp.ts");
const fixture = (...tail: string[]): string[] => [process.execPath, FIXTURE, ...tail];
const q = (s: string): string => `"${s}"`;
/** the fixture as a knob-grammar argv (quoted: the bun path or the checkout may hold spaces) */
const fixtureText = (...tail: string[]): string => [q(process.execPath), q(FIXTURE), ...tail].join(" ");
const MISSING = "rovecode-no-such-lsp-server-p73";
const LABEL = /lsp-gate \(([^)\n]*)\)/;

/** Bounded child-exit wait (the unref/ref bug lsp.test.ts once froze on): fail in 5 s rather than hang. */
async function awaitExit(exited: Promise<number> | null): Promise<void> {
  if (!exited) return;
  const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res("wedged"), 5000))]);
  if (r === "wedged") throw new Error("lsp child did not exit within 5s — exited promise wedged");
}
/** kill every server of the gate and wait for each exit BEFORE the scratch sweep. */
async function disposeAll(gate: LspGate): Promise<void> {
  const clients = gate.clients();
  gate.dispose();
  for (const c of clients) await awaitExit(c.exited);
}
function project(): { dir: string; ts: string; tsx: string; py: string; md: string } {
  const dir = scratch("rovecode-lsp73-");
  const f = (name: string, text: string): string => { const p = join(dir, name); writeFileSync(p, text); return p; };
  return {
    dir,
    ts: f("bad.ts", "const unused = 1;\nexport {};\nconst n: number = 'x';\n"),
    tsx: f("b.tsx", "export const x = 1;\n"),
    py: f("x.py", "x: int = 'y'\n"),
    md: f("notes.md", "# hi\n"),
  };
}
function whichSpy(): { which: (n: string) => string | null; calls: string[] } {
  const calls: string[] = [];
  return { calls, which: (n) => { calls.push(n); return Bun.which(n); } };
}

test("a table entry spawns exactly the configured argv (no implicit --stdio); didOpen carries the extension's LSP languageId; the note label is the sanitised argv[0] basename", async () => {
  const p = project();
  const gate = createLspGate({ root: p.dir, servers: new Map([[".py", fixture("echo-lang", "--p73-flag", "second")]]), debounceMs: 40 });
  try {
    const note = await gate.note(p.py);
    expect(note).toContain("lsp-gate (");
    expect(note).toContain(`1 error(s) in ${p.py}`);
    expect(note).toContain("lang=python"); // MUTATION TARGET: languageId hard-wired to plaintext / the TS table
    expect(note).toContain("argv=--p73-flag second (v0)"); // MUTATION TARGET: re-add the implicit --stdio → the tail grows
    expect(note).not.toContain("--stdio");
    const label = LABEL.exec(note)![1]!;
    expect(label).toBe(serverLabel(process.execPath));
    expect(label).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(gate.clients().length).toBe(1);
    expect(gate.client).toBe(gate.clients()[0]!);
  } finally { await disposeAll(gate); }
});

test("per-argv probe: a missing custom binary is off in <300 ms after ONE which(); the sibling extension's server still reports; the miss is never re-probed", async () => {
  const p = project();
  const spy = whichSpy();
  const gate = createLspGate({ root: p.dir, which: spy.which, servers: new Map([[".py", [MISSING, "--stdio"]], [".ts", fixture("diagnostics")]]), debounceMs: 40 });
  try {
    const t0 = Date.now();
    expect(await gate.note(p.py)).toBe("");
    expect(Date.now() - t0).toBeLessThan(300); // no spawn, no settle wait
    expect(spy.calls).toEqual([MISSING]);
    expect(gate.clients().length).toBe(0);
    expect(gate.client).toBeNull();
    const note = await gate.note(p.ts); // MUTATION TARGET: one probe result cached across argvs → "" here
    expect(note).toContain(`1 error(s) in ${p.ts}`);
    expect(note).toContain("ERROR [3:5] Type 'string' is not assignable to type 'number'. (v0)");
    expect(gate.clients().length).toBe(1);
    expect(await gate.note(p.py)).toBe("");
    expect(spy.calls).toEqual([MISSING]); // MUTATION TARGET: re-probe on every note → a second call
    expect(await gate.note(p.ts)).toContain("(v1)"); // the live sibling keeps going
    expect(gate.clients().length).toBe(1);
  } finally { await disposeAll(gate); }
});

test("extensions sharing an argv share ONE server per root: a.ts then b.tsx → one client, both files noted", async () => {
  const p = project();
  const gate = createLspGate({ root: p.dir, servers: new Map([[".ts", fixture("diagnostics")], [".tsx", fixture("diagnostics")]]), debounceMs: 40 });
  try {
    expect(await gate.note(p.ts)).toContain(`in ${p.ts}`);
    expect(await gate.note(p.tsx)).toContain(`in ${p.tsx}`); // its own didOpen (v0) on the same server
    expect(await gate.note(p.tsx)).toContain("(v1)");
    expect(gate.clients().length).toBe(1);
  } finally { await disposeAll(gate); }
});

test("'.ts=off' with a .py entry (through the real grammar, ROVECODE_LSP): no TS probe or spawn (<200 ms), the .py server reports; the bare value 'off' yields zero probes for every extension; the merge keeps the built-in entry", async () => {
  const p = project();
  const spy = whichSpy();
  const gate = createLspGate({ root: p.dir, which: spy.which, env: { ROVECODE_LSP: `.ts=off;.py=${fixtureText("echo-lang")}` }, debounceMs: 40 });
  try {
    const t0 = Date.now();
    expect(await gate.note(p.ts)).toBe("");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(spy.calls).toEqual([]);
    expect(gate.clients().length).toBe(0);
    expect(await gate.note(p.py)).toContain("lang=python");
    expect(gate.clients().length).toBe(1);
  } finally { await disposeAll(gate); }
  const off = createLspGate({ root: p.dir, which: spy.which, env: { ROVECODE_LSP: "off" } });
  try {
    for (const f of [p.ts, p.tsx, p.py, p.md]) expect(await off.note(f)).toBe(""); // MUTATION TARGET: ignore the bare off → the TS default probes
    expect(spy.calls).toEqual([]);
    expect(off.clients().length).toBe(0);
  } finally { await disposeAll(off); }
  // the merge is what the gate sees: .py added, .tsx still the built-in entry (probed by name → which() called once)
  const merged = createLspGate({ root: p.dir, which: spy.which, env: { ROVECODE_LSP: `.py=${fixtureText("echo-lang")}` }, serverName: MISSING });
  try {
    expect(await merged.note(p.tsx)).toBe("");
    expect(spy.calls).toEqual([MISSING]); // MUTATION TARGET: replace instead of merge → .tsx ungated, no probe
    expect(await merged.note(p.py)).toContain("lang=python");
  } finally { await disposeAll(merged); }
});

test("a .md touch with a full table never probes or spawns; argv[0] with a path separator is checked with existsSync relative to the root (never which()) — a missing path is off", async () => {
  const p = project();
  const spy = whichSpy();
  const gate = createLspGate({ root: p.dir, which: spy.which, servers: new Map([[".py", fixture("echo-lang")], [".rs", ["./tools/no-such-server", "--stdio"]], [".ts", fixture("diagnostics")]]) });
  try {
    const t0 = Date.now();
    expect(await gate.note(p.md)).toBe("");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(spy.calls).toEqual([]);
    expect(gate.clients().length).toBe(0);
    const rs = join(p.dir, "a.rs");
    writeFileSync(rs, "fn main() {}\n");
    expect(await gate.note(rs)).toBe("");
    expect(spy.calls).toEqual([]); // separator → existsSync branch, never which()
    expect(gate.clients().length).toBe(0);
    expect(await gate.note(p.py)).toContain("lang=python"); // the absolute bun path also took the existsSync branch
    expect(spy.calls).toEqual([]);
  } finally { await disposeAll(gate); }
});

test("the built-in entry keeps #13's test hooks: `cmd` bypasses its probe and the label stays typescript-language-server; a custom entry ignores `cmd`; `serverName` swaps only the built-in probe target", async () => {
  const p = project();
  const spy = whichSpy();
  const gate = createLspGate({ root: p.dir, which: spy.which, cmd: fixture("diagnostics"), servers: new Map([...resolveServerTable({ env: {} }), [".py", [MISSING]]]), debounceMs: 40 });
  try {
    const note = await gate.note(p.ts);
    expect(note).toContain("lsp-gate (typescript-language-server): 1 error(s)"); // core/reflection.ts parses this label unchanged
    expect(spy.calls).toEqual([]);
    expect(await gate.note(p.tsx)).toContain("lsp-gate (typescript-language-server)"); // same built-in argv → same server
    expect(gate.clients().length).toBe(1);
    expect(await gate.note(p.py)).toBe(""); // cmd is not a table-wide override
    expect(spy.calls).toEqual([MISSING]);
  } finally { await disposeAll(gate); }
  const named = createLspGate({ root: p.dir, which: spy.which, env: {}, serverName: MISSING });
  try {
    expect(await named.note(p.ts)).toBe("");
    expect(spy.calls).toEqual([MISSING, MISSING]);
    expect(named.client).toBeNull();
  } finally { await disposeAll(named); }
});

test("wiring: the project's .rovecode/settings.json `lsp` reaches lspGateNote with no runtime change (read lazily on the first note of a fresh root); ROVECODE_LSP beats it", async () => {
  const p = project();
  mkdirSync(join(p.dir, ".rovecode"));
  writeFileSync(join(p.dir, ".rovecode", "settings.json"), JSON.stringify({ lsp: `.py=${fixtureText("echo-lang")}` }));
  trustProjectFiles(p.dir); // `lsp` is a command-bearing key: an untrusted project file's table is dropped (project-trust.test.ts)
  expect(loadSettings(p.dir).lsp).toBe(`.py=${fixtureText("echo-lang")}`);
  expect(settingsLspValue(p.dir)).toBe(`.py=${fixtureText("echo-lang")}`);
  expect(settingsLspValue(join(p.dir, "no-such-dir"))).toBeUndefined();
  for (const g of disposeDefaultGates()) await disposeAll(g);
  const note = await lspGateNote(p.py, p.dir, { env: {}, debounceMs: 40 });
  expect(note).toContain("lang=python");
  expect(await lspGateNote(p.md, p.dir)).toBe("");
  for (const g of disposeDefaultGates()) await disposeAll(g);
  // the env wins over the file for a fresh gate
  expect(await lspGateNote(p.py, p.dir, { env: { ROVECODE_LSP: "off" } })).toBe("");
  // the settings layer keeps a malformed table as written (it is named at boot, not dropped in silence), and drops blank / non-string / oversize
  writeFileSync(join(p.dir, ".rovecode", "settings.json"), JSON.stringify({ lsp: "garbage" }));
  trustProjectFiles(p.dir);
  expect(loadSettings(p.dir).lsp).toBe("garbage");
  writeFileSync(join(p.dir, ".rovecode", "settings.json"), JSON.stringify({ lsp: "   " }));
  expect(loadSettings(p.dir).lsp).toBeUndefined();
  writeFileSync(join(p.dir, ".rovecode", "settings.json"), JSON.stringify({ lsp: 42 }));
  expect(loadSettings(p.dir).lsp).toBeUndefined();
});

test("the absence is said once, per server: a configured entry not on PATH is named with its extensions; a path-style argv0 names the path; the built-in TS entry only for a tsconfig project; off / ext=off say nothing; a malformed table is named with its source", () => {
  const p = project();
  const none = () => null;
  const found = (n: string) => `/usr/bin/${n}`;
  // no tsconfig: the built-in entry is not promised; the configured .py one was
  expect(lspAvailabilityNotes(p.dir, none, "typescript-language-server", { env: { ROVECODE_LSP: ".py,.pyi=pyright-langserver --stdio" } })).toEqual([
    "lsp: pyright-langserver (.py, .pyi) is not on PATH — edits to those files are NOT checked (the `lsp` setting names it; fix the path or install it)",
  ]);
  const rs = lspAvailabilityNotes(p.dir, none, "typescript-language-server", { env: { ROVECODE_LSP: ".rs=./tools/rust-analyzer" } });
  expect(rs.length).toBe(1);
  expect(rs[0]).toContain("lsp: ./tools/rust-analyzer (.rs) is not at ");
  expect(rs[0]).toContain(join(p.dir, "tools", "rust-analyzer"));
  // found → nothing; off → nothing; ext=off → nothing
  expect(lspAvailabilityNotes(p.dir, found, "typescript-language-server", { env: { ROVECODE_LSP: ".py=pyright-langserver --stdio" } })).toEqual([]);
  expect(lspAvailabilityNotes(p.dir, none, "typescript-language-server", { env: { ROVECODE_LSP: "off" } })).toEqual([]);
  expect(lspAvailabilityNotes(p.dir, none, "typescript-language-server", { env: { ROVECODE_LSP: ".py=off" } })).toEqual([]);
  // a TS project: the built-in line (unchanged wording, cli/doctor.ts and the runtime rely on it) plus the configured one
  writeFileSync(join(p.dir, "tsconfig.json"), "{}");
  const both = lspAvailabilityNotes(p.dir, none, "typescript-language-server", { env: { ROVECODE_LSP: ".py=pyright-langserver --stdio" } });
  expect(both.length).toBe(2);
  expect(both[0]).toBe("lsp: typescript-language-server is not on PATH — edits and writes are NOT type-checked, and the model gets no diagnostics after them (npm i -g typescript-language-server typescript)");
  expect(both[1]).toContain("pyright-langserver (.py)");
  expect(lspAvailabilityNotes(p.dir, none, "vtsls", { env: { ROVECODE_LSP: "" } })).toEqual([expect.stringContaining("vtsls is not on PATH")]);
  // the one-string face: the first line keeps "lsp: ", the rest sit indented under it (doctor strips one prefix, runtime prints the block)
  expect(lspAvailabilityNote(p.dir, found)).toBeNull();
  process.env.ROVECODE_LSP = ".py=pyright-langserver --stdio";
  try {
    const joined = lspAvailabilityNote(p.dir, none)!;
    const lines = joined.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toStartWith("lsp: typescript-language-server is not on PATH");
    expect(lines[1]).toBe("     pyright-langserver (.py) is not on PATH — edits to those files are NOT checked (the `lsp` setting names it; fix the path or install it)");
  } finally { delete process.env.ROVECODE_LSP; }
  // a malformed table: named with its source, the valid entry still counts (and is itself reported as missing)
  const bad = lspAvailabilityNotes(p.dir, none, "typescript-language-server", { env: { ROVECODE_LSP: ".py=;.go=gopls" } });
  expect(bad[0]).toBe('lsp: the `lsp` table (ROVECODE_LSP) has a problem — entry ".py=": empty argv (ext=argv, or ext=off to disable); that entry is ignored, the rest of the table applies');
  expect(bad.some((n) => n.includes("gopls (.go) is not on PATH"))).toBe(true);
  const badFile = lspAvailabilityNotes(p.dir, found, "typescript-language-server", { env: {}, settingsValue: "garbage" });
  expect(badFile).toEqual([expect.stringContaining("(.rovecode/settings.json lsp) has a problem")]);
});

test("serverLabel: basename minus extension, sanitised to [A-Za-z0-9._-] (both separators, any platform)", () => {
  expect(serverLabel("typescript-language-server")).toBe("typescript-language-server");
  expect(serverLabel("C:\\Program Files\\x\\srv.exe")).toBe("srv");
  expect(serverLabel("/usr/local/bin/pyright-langserver")).toBe("pyright-langserver");
  expect(serverLabel("./tools/rust-analyzer.cmd")).toBe("rust-analyzer");
  expect(serverLabel("we!rd (name)")).toBe("werdname");
  expect(serverLabel("srv.v2.exe")).toBe("srv.v2");
  expect(serverLabel(".hidden")).toBe(".hidden");
  expect(serverLabel("")).toBe("lsp");
  expect(serverLabel(")\n(")).toBe("lsp");
});
