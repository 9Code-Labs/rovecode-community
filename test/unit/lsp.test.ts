import { test, expect } from "bun:test";
import {
  encodeFrame, FrameParser, LspClient, createLspGate, formatGateNote, withLspGate,
  lspGateNote, disposeDefaultGates,
} from "../../src/coding/lsp.ts";
import type { Diagnostic } from "../../src/coding/lsp.ts";
import type { LspGate } from "../../src/coding/lsp.ts";
import type { Tool, ToolContext, ToolOutput } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "fake-lsp.ts");
const fixtureCmd = (mode: string): string[] => [process.execPath, FIXTURE, mode];

/** Windows: the spawned server's cwd locks the temp dir until it fully exits. */
async function rmrf(dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Bounded child-exit wait: if `exited` ever wedges again (the unref/ref bug this suite
 *  once froze on), the test must FAIL in 5s — bun cannot preempt a never-settling await. */
async function awaitExit(exited: Promise<number> | null): Promise<void> {
  if (!exited) return;
  const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res("wedged"), 5000))]);
  if (r === "wedged") throw new Error("lsp child did not exit within 5s — exited promise wedged");
}

async function disposeAndRm(gate: LspGate, dir: string): Promise<void> {
  gate.dispose();
  await awaitExit(gate.client?.exited ?? null);
  await rmrf(dir);
}

function tempProject(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-lsp-"));
  const file = join(dir, "bad.ts");
  writeFileSync(file, "const unused = 1;\nexport {};\nconst n: number = 'x';\n");
  return { dir, file };
}

// ---------- wire framing ----------

test("encodeFrame uses UTF-8 byte length, not string length", () => {
  const frame = Buffer.from(encodeFrame({ msg: "héllo→" })); // multibyte payload
  const text = frame.toString("utf8");
  const body = text.slice(text.indexOf("\r\n\r\n") + 4);
  const declared = Number(/Content-Length: (\d+)/.exec(text)?.[1]);
  expect(declared).toBe(Buffer.byteLength(body, "utf8"));
  expect(declared).toBeGreaterThan(body.length); // multibyte: bytes > chars proves it's not .length
  expect(JSON.parse(body)).toEqual({ msg: "héllo→" });
});

test("FrameParser reassembles a frame split across arbitrary chunk boundaries", () => {
  const parser = new FrameParser();
  const frame = Buffer.from(encodeFrame({ jsonrpc: "2.0", method: "x", params: { s: "héllo" } }));
  const cut1 = 7;                    // mid-header
  const cut2 = frame.byteLength - 3; // mid-body
  expect(parser.push(frame.subarray(0, cut1))).toEqual([]);
  expect(parser.push(frame.subarray(cut1, cut2))).toEqual([]);
  const msgs = parser.push(frame.subarray(cut2));
  expect(msgs).toEqual([{ jsonrpc: "2.0", method: "x", params: { s: "héllo" } }]);
});

test("FrameParser decodes multiple messages arriving in one chunk", () => {
  const parser = new FrameParser();
  const chunk = Buffer.concat([
    Buffer.from(encodeFrame({ id: 1 })),
    Buffer.from(encodeFrame({ id: 2, note: "ünïcode" })),
  ]);
  expect(parser.push(chunk)).toEqual([{ id: 1 }, { id: 2, note: "ünïcode" }]);
});

// ---------- diagnostics round-trip (scripted fake server over real stdio) ----------

test("round-trip: didOpen → publishDiagnostics → errors-only gate note", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("diagnostics"), root: dir, debounceMs: 40 });
  try {
    const note = await gate.note(file);
    expect(note).toContain("lsp-gate");
    expect(note).toContain(`1 error(s) in ${file}`);
    // fixture publishes at 0-based {line:2, character:4}; note must be 1-based
    expect(note).toContain("ERROR [3:5] Type 'string' is not assignable to type 'number'.");
    expect(note).toContain("(v0)"); // fixture echoes the didOpen version (opencode opens at 0)
    // severity-2 warning was published but must NOT reach the note
    expect(note).not.toContain("never read");
    expect(note).not.toContain("WARN");
  } finally {
    await disposeAndRm(gate, dir);
  }
});

test("second touch sends didChange with bumped version", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("diagnostics"), root: dir, debounceMs: 40 });
  try {
    expect(await gate.note(file)).toContain("(v0)");
    const second = await gate.note(file); // fixture echoes didChange's version in the message
    expect(second).toContain("(v1)");
    expect(second).not.toContain("(v0)");
  } finally {
    await disposeAndRm(gate, dir);
  }
});

test("clean server: empty diagnostics produce no gate note", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("clean"), root: dir, debounceMs: 40 });
  try {
    expect(await gate.note(file)).toBe("");
  } finally {
    await disposeAndRm(gate, dir);
  }
});

// ---------- garbage frames: the reader loop must survive malformed messages ----------

test("garbage frames (null body, scalar body, null params) are skipped; diagnostics after them still arrive", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("garbage"), root: dir, debounceMs: 40 });
  try {
    // fixture front-loads garbage at startup AND before the initialize answer AND before
    // every publish — one poisoned frame must not abort the pump and eat later output
    const note = await gate.note(file);
    expect(note).toContain("lsp-gate");
    expect(note).toContain("ERROR [3:5] Type 'string' is not assignable to type 'number'. (v0)");
    expect(gate.client!.state).toBe("ready"); // reader survived; state is not lying
    expect(await gate.note(file)).toContain("(v1)"); // and it keeps decoding on later touches
  } finally {
    await disposeAndRm(gate, dir);
  }
});

// ---------- stale publishes: a lagging server's old-version publish is another edit's ----------

test("laggy server: publish carrying the previous version is rejected, the matching one is awaited", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("laggy"), root: dir, settleMs: 1200, debounceMs: 40 });
  try {
    expect(await gate.note(file)).toContain("(v0)"); // didOpen: publish lags 150ms but matches v0
    const second = await gate.note(file); // didChange v1: v0's stale publish lands first
    expect(second).toContain("(v1)"); // waited past the stale publish for the version just sent
    expect(second).not.toContain("(v0)"); // the previous edit's diagnostics were NOT attributed
  } finally {
    await disposeAndRm(gate, dir);
  }
});

// ---------- absence path (PATH probe fails → feature silently off) ----------

test("absent server: probe miss turns the feature off silently and never spawns", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ serverName: "rovecode-no-such-lsp-server-p13", root: dir });
  try {
    const t0 = Date.now();
    expect(await gate.note(file)).toBe("");
    expect(Date.now() - t0).toBeLessThan(300); // no spawn, no settle wait
    expect(gate.client).toBeNull();
    expect(await gate.note(file)).toBe(""); // stays off
  } finally {
    await disposeAndRm(gate, dir);
  }
});

test("non-TS file is ignored before any probe or spawn", async () => {
  const { dir } = tempProject();
  const md = join(dir, "notes.md");
  writeFileSync(md, "# hi\n");
  const gate = createLspGate({ cmd: fixtureCmd("wedged"), root: dir }); // would wedge if touched
  try {
    const t0 = Date.now();
    expect(await gate.note(md)).toBe("");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(gate.client).toBeNull(); // never even constructed a client
  } finally {
    await disposeAndRm(gate, dir);
  }
});

// ---------- timeout paths (wedged server can never block the loop) ----------

test("wedged server: bounded return, then killed and marked dead, never retried", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("wedged"), root: dir, initTimeoutMs: 300, hardDeadlineMs: 600 });
  try {
    const t0 = Date.now();
    expect(await gate.note(file)).toBe(""); // initialize never answered
    expect(Date.now() - t0).toBeLessThan(1000); // bounded well under the 2s ceiling
    const client = gate.client;
    expect(client).not.toBeNull();
    expect(client!.state).toBe("dead"); // init timeout → becomeDead
    const exit = client!.exited;
    expect(exit).not.toBeNull();
    await awaitExit(exit); // the wedged process was actually killed
    const t1 = Date.now();
    expect(await gate.note(file)).toBe(""); // dead server: silently off
    expect(Date.now() - t1).toBeLessThan(100); // no second settle wait
  } finally {
    await disposeAndRm(gate, dir);
  }
});

test("mute server: init ok but no publish → settle window expires, no note, still bounded", async () => {
  const { dir, file } = tempProject();
  const gate = createLspGate({ cmd: fixtureCmd("mute"), root: dir, settleMs: 250, hardDeadlineMs: 800 });
  try {
    const t0 = Date.now();
    expect(await gate.note(file)).toBe("");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000); // ≤2s bar
  } finally {
    await disposeAndRm(gate, dir);
  }
});

test("settle window and hard deadline are clamped to the 2s bar", async () => {
  const { dir, file } = tempProject();
  // hostile config asks for 60s waits; the gate must still return within ~2s
  const gate = createLspGate({ cmd: fixtureCmd("mute"), root: dir, settleMs: 60_000, hardDeadlineMs: 60_000 });
  try {
    const t0 = Date.now();
    expect(await gate.note(file)).toBe("");
    expect(Date.now() - t0).toBeLessThan(2500);
  } finally {
    await disposeAndRm(gate, dir);
  }
});

// ---------- formatter ----------

function diag(line: number, character: number, message: string, severity: number): Diagnostic {
  return { range: { start: { line, character }, end: { line, character: character + 1 } }, severity, message };
}

test("formatGateNote: errors only, caps at 20 with overflow suffix", () => {
  const many = Array.from({ length: 25 }, (_, i) => diag(i, 0, `err-${i}`, 1));
  const note = formatGateNote("/p/a.ts", [...many, diag(0, 0, "warn", 2), diag(0, 0, "hint", 4)]);
  expect(note).toContain("25 error(s)");
  expect(note).toContain("err-19");
  expect(note).not.toContain("err-20"); // capped at 20
  expect(note).toContain("... and 5 more");
  expect(note).not.toContain("warn");
  expect(formatGateNote("/p/a.ts", [diag(0, 0, "w", 2), diag(0, 0, "i", 3)])).toBe(""); // no errors → no note
});

// ---------- withLspGate tool wrapper ----------

function ctx(cwd: string): ToolContext {
  return { sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
}

function stubTool(kind: Tool["kind"], result: ToolOutput): Tool {
  return {
    schema: { name: "stub", description: "", args: { type: "object", properties: {} } },
    kind,
    execute: () => Promise.resolve(result),
  };
}

test("withLspGate appends the note to successful write-tool output only", async () => {
  const { dir, file } = tempProject();
  const calls: string[] = [];
  const gate = (p: string): Promise<string> => { calls.push(p); return Promise.resolve("\n\nlsp-gate (stub): 1 error(s)"); };
  try {
    const wrapped = withLspGate(stubTool("write", { ok: true, output: "wrote it" }), gate);
    const out = await wrapped.execute({ path: file }, ctx(dir));
    expect(out.output).toBe("wrote it\n\nlsp-gate (stub): 1 error(s)");
    expect(calls).toEqual([file]); // relative path resolution goes through ctx.cwd
    const rel = await wrapped.execute({ path: "bad.ts" }, ctx(dir));
    expect(rel.output).toContain("lsp-gate");
    expect(calls[1]).toBe(file);

    const failing = withLspGate(stubTool("write", { ok: false, output: "rejected" }), gate);
    expect((await failing.execute({ path: file }, ctx(dir))).output).toBe("rejected"); // no gate on failure
    expect(calls.length).toBe(2);

    const missing = await wrapped.execute({ path: "ghost.ts" }, ctx(dir));
    expect(missing.output).toBe("wrote it"); // nonexistent file: nothing to diagnose
    expect(calls.length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLspGate leaves non-write tools untouched", async () => {
  const reader = stubTool("read", { ok: true, output: "data" });
  expect(withLspGate(reader, () => Promise.resolve("\n\nnote"))).toBe(reader); // same reference
});

// ---------- default gates are per resolved root, not first-caller-wins ----------

test("lspGateNote: two roots get two servers, each diagnosing against its own rootUri", async () => {
  disposeDefaultGates();
  const a = tempProject();
  const b = tempProject();
  try {
    const noteA = await lspGateNote(a.file, a.dir, { cmd: fixtureCmd("echo-root"), debounceMs: 40 });
    const noteB = await lspGateNote(b.file, b.dir, { cmd: fixtureCmd("echo-root"), debounceMs: 40 });
    expect(noteA).toContain(`root=${pathToFileURL(a.dir).href}`);
    expect(noteB).toContain(`root=${pathToFileURL(b.dir).href}`); // NOT the first caller's root
    expect(noteB).not.toContain(pathToFileURL(a.dir).href);
    // same resolved root reuses the live gate: no opts, no re-probe, no second server
    expect(await lspGateNote(a.file, a.dir)).toContain(`root=${pathToFileURL(a.dir).href}`);
  } finally {
    for (const g of disposeDefaultGates()) await awaitExit(g.client?.exited ?? null);
    await rmrf(a.dir);
    await rmrf(b.dir);
  }
});

test("default-gate map is bounded: oldest root evicted and disposed past the cap", async () => {
  disposeDefaultGates();
  try {
    for (let i = 0; i < 6; i++) {
      const root = join(tmpdir(), `rovecode-fake-root-${i}`); // never spawns: probe misses
      expect(await lspGateNote(join(root, "x.ts"), root, { serverName: "rovecode-no-such-lsp-server-p13" })).toBe("");
    }
    expect(disposeDefaultGates().length).toBe(4); // 6 roots in, only the 4 newest kept
  } finally {
    disposeDefaultGates();
  }
});

// ---------- LspClient direct: raw diagnostics include the warning (gate filters, client doesn't) ----------

test("LspClient.touch returns raw diagnostics including warnings", async () => {
  const { dir, file } = tempProject();
  const client = new LspClient({ cmd: fixtureCmd("diagnostics"), root: dir, debounceMs: 40 });
  try {
    const diags = await client.touch(file);
    expect(diags.length).toBe(2);
    expect(diags.map((d) => d.severity).sort()).toEqual([1, 2]);
  } finally {
    client.kill();
    await awaitExit(client.exited);
    await rmrf(dir);
  }
});
