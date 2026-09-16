/** The crash guard (src/tui/crash-guard.ts): a rovecode that dies must hand back a usable terminal and
 *  leave the reason on disk.
 *
 *  The reported symptom is the thing these tests are really about. An uncaught error left the terminal on
 *  the alt screen with mouse reporting on, so the shell prompt came back underneath a frame that never
 *  erased and every pointer movement typed `[<222;39;51M` at it. The person reads that as "my terminal is
 *  broken", and the actual error is gone with the screen it printed on. So the two properties pinned
 *  hardest below are ORDER (restore before anything that can fail) and SURVIVAL (the reason reaches a
 *  file, not just the screen that is about to be erased). */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashLogName, crashReport, describeError, installCrashGuard, type CrashProcess } from "../../src/tui/crash-guard.ts";

/** a stand-in for `process`: records listeners so a test can fire them, and records exit codes */
function fakeProcess(): CrashProcess & { fire(event: string, arg?: unknown): void; exits: number[]; listeners(event: string): number } {
  const on = new Map<string, ((...a: unknown[]) => void)[]>();
  const exits: number[] = [];
  return {
    on(event, listener) { (on.get(event) ?? on.set(event, []).get(event)!).push(listener); return this; },
    off(event, listener) { const l = on.get(event); if (l) { const i = l.indexOf(listener); if (i >= 0) l.splice(i, 1); } return this; },
    exit(code) { exits.push(code); },
    fire(event, arg) { for (const l of [...(on.get(event) ?? [])]) l(arg); },
    listeners(event) { return (on.get(event) ?? []).length; },
    exits,
  };
}

function harness(over: { restore?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rove-crash-"));
  const proc = fakeProcess();
  const stderr: string[] = [];
  const order: string[] = [];
  const uninstall = installCrashGuard({
    restore: over.restore ?? (() => { order.push("restore"); }),
    logDir: join(dir, "logs"),
    version: "9.9.9",
    process: proc,
    now: () => new Date("2026-09-07T21:15:04Z"),
    stderr: (l) => { stderr.push(l); order.push("stderr"); },
    writeFile: undefined,
  });
  const logs = (): string[] => { try { return readdirSync(join(dir, "logs")); } catch { return []; } };
  return { dir, proc, stderr, order, uninstall, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an uncaught exception restores the terminal FIRST, then writes the reason to a file, then exits 1", () => {
  const h = harness();
  try {
    h.proc.fire("uncaughtException", new Error("boom"));
    // Order is the property, not an implementation detail: everything after the restore can fail —
    // mkdir, the write, even stderr — and the person must still get their shell back. A restore that
    // ran after the logging would be undone by the first thing that threw.
    expect(h.order[0]).toBe("restore");
    expect(h.proc.exits).toEqual([1]);
    const files = h.logs();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^crash-20260907-\d{6}\.log$/);   // the date is fixed; the clock time is local to the box
    const body = readFileSync(join(h.dir, "logs", files[0]!), "utf8");
    expect(body).toContain("rovecode crash — uncaught exception");
    expect(body).toContain("Error: boom");
    expect(body).toContain("version:  9.9.9");
    expect(body).toContain("crash-guard.test");           // the stack, which is the whole point of the file
    // and stderr names the file, because the screen the stack would have printed on has just been erased
    expect(h.stderr[0]).toContain(files[0]);
    expect(h.stderr.join("\n")).toContain("Error: boom");
  } finally { h.cleanup(); }
});

test("an unhandled rejection is treated as a crash too — in a TUI it is the LIKELIER of the two", () => {
  // Almost everything in the boot path is async, so the surface dies far more often through a rejected
  // promise than through a synchronous throw. Handling only uncaughtException would have covered the
  // rarer half and left the reported symptom in place.
  const h = harness();
  try {
    h.proc.fire("unhandledRejection", new Error("provider never answered"));
    expect(h.order[0]).toBe("restore");
    expect(h.proc.exits).toEqual([1]);
    expect(readFileSync(join(h.dir, "logs", h.logs()[0]!), "utf8")).toContain("unhandled rejection");
  } finally { h.cleanup(); }
});

test("a restore that THROWS still lets the log be written and the process exit — the guard cannot be the thing that hangs", () => {
  const h = harness({ restore: () => { throw new Error("stdout is gone"); } });
  try {
    h.proc.fire("uncaughtException", new Error("original failure"));
    expect(h.proc.exits).toEqual([1]);
    // the ORIGINAL error is what gets recorded, not the restore's — the restore failing is a detail,
    // the reason rovecode died is the thing being asked for
    expect(readFileSync(join(h.dir, "logs", h.logs()[0]!), "utf8")).toContain("original failure");
  } finally { h.cleanup(); }
});

test("a log that cannot be written is not fatal: the terminal is still restored and the error still reaches stderr", () => {
  // A crash we cannot record is still a crash we have to get the terminal back from. This is the case
  // where the disk is full or the home directory is read-only, and it must not become a second crash.
  const dir = mkdtempSync(join(tmpdir(), "rove-crash-"));
  const proc = fakeProcess();
  const stderr: string[] = [];
  let restored = 0;
  installCrashGuard({
    restore: () => { restored++; },
    logDir: join(dir, "logs"),
    process: proc,
    stderr: (l) => stderr.push(l),
    writeFile: () => { throw new Error("ENOSPC"); },
  });
  try {
    proc.fire("uncaughtException", new Error("boom"));
    expect(restored).toBe(1);
    expect(proc.exits).toEqual([1]);
    expect(stderr[0]).toContain("crash log could not be written");
    expect(stderr.join("\n")).toContain("boom");   // the reason is not lost just because the file was
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("`exit` restores but writes NO log — a clean quit is not a crash, and a logs directory full of them would be noise", () => {
  const h = harness();
  try {
    h.proc.fire("exit", 0);
    expect(h.order).toEqual(["restore"]);
    expect(h.logs()).toEqual([]);
    expect(h.proc.exits).toEqual([]);   // it does not exit again from inside an exit
  } finally { h.cleanup(); }
});

test("the restore runs ONCE however many times the process fires at it", () => {
  // A dying process can fire uncaughtException and then exit; writing the leave sequence twice is
  // harmless on a real terminal but the second one would run against a stream that may already be gone.
  const h = harness();
  try {
    h.proc.fire("uncaughtException", new Error("boom"));
    h.proc.fire("exit", 1);
    expect(h.order.filter((s) => s === "restore")).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("uninstall removes every listener, so a clean quit's own exit is not reported as a crash", () => {
  const h = harness();
  try {
    expect(h.proc.listeners("uncaughtException")).toBe(1);
    expect(h.proc.listeners("exit")).toBe(1);
    h.uninstall();
    expect(h.proc.listeners("uncaughtException")).toBe(0);
    expect(h.proc.listeners("unhandledRejection")).toBe(0);
    expect(h.proc.listeners("exit")).toBe(0);
    h.proc.fire("exit", 0);
    expect(h.order).toEqual([]);   // the quit path did its own restore; this one is gone
  } finally { h.cleanup(); }
});

test("a non-Error value keeps its content: a rejected string or object must not log as [object Object]", () => {
  // `throw "boom"` and a rejected plain object are common in async code, and they are exactly the cases
  // where a naive `err.stack` yields nothing at all — the log would say a crash happened and not what.
  expect(describeError("just a string")).toBe("non-Error value thrown: just a string");
  expect(describeError({ code: "ETIMEDOUT", server: "memory" })).toContain(`"code":"ETIMEDOUT"`);
  expect(describeError(undefined)).toBe("non-Error value thrown: undefined");
  const circular: Record<string, unknown> = {}; circular["self"] = circular;
  expect(describeError(circular)).toContain("non-Error value thrown:");   // does not throw on a cycle
  // a cause chain is followed: the wrapper alone usually says nothing useful
  const wrapped = new Error("could not start", { cause: new Error("EADDRINUSE 4096") });
  expect(describeError(wrapped)).toContain("caused by: Error: EADDRINUSE 4096");
});

test("log names sort chronologically and never collide inside one second", () => {
  const at = new Date(2026, 8, 7, 21, 15, 4);
  expect(crashLogName(at)).toBe("crash-20260907-211504.log");
  expect(crashLogName(at, 1)).toBe("crash-20260907-211504-1.log");
  const earlier = new Date(2026, 8, 7, 9, 5, 4);
  expect(crashLogName(earlier) < crashLogName(at)).toBe(true);  // zero-padded, so string order is time order
});

test("the report stands alone: pasted into a message with no context it still says what died, when and on what", () => {
  const body = crashReport("uncaught exception", new Error("nope"), new Date("2026-09-07T21:15:04Z"), "0.3.2");
  expect(body).toContain("rovecode crash — uncaught exception");
  expect(body).toContain("when:     2026-09-07T21:15:04.000Z");
  expect(body).toContain("version:  0.3.2");
  expect(body).toContain(process.platform);
  expect(crashReport("x", new Error("y"), new Date(), undefined)).toContain("version:  unknown");
});

test("a transient network error (Bun's stream-side ResolveMessage) is logged but NOT fatal: no restore, no exit, the session lives", () => {
  const h = harness();
  try {
    // the crash of 2026-09-10: "Unhandled error. (ResolveMessage {})" from node:streams/destroy —
    // Bun's fetch emits DNS failures as a promise rejection (caught) AND an internal stream error
    // event (uncaught). The session was healthy; the network had blipped.
    h.proc.fire("uncaughtException", new Error("Unhandled error. (ResolveMessage {})"));
    expect(h.proc.exits).toEqual([]);                 // NOT fatal: no exit at all
    const logs = h.logs();
    expect(logs.some((f) => f.startsWith("crash-"))).toBe(true);   // still on disk, same place
    const body = readFileSync(join(h.dir, "logs", logs[0]!), "utf8");
    expect(body).toContain("transient network error (recovered");
    expect(h.stderr.some((l) => l.includes("network call failed"))).toBe(true);
    expect(h.order).not.toContain("restore");         // the terminal was never torn down
    // the family: bare codes and the Resolve payload itself, on BOTH handlers
    h.proc.fire("unhandledRejection", new Error("getAddrInfo ENOTFOUND api.github.com"));
    h.proc.fire("uncaughtException", { name: "ResolveMessage" });
    h.proc.fire("unhandledRejection", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    expect(h.proc.exits).toEqual([]);
    // and a REAL error in the same shape is still fatal — the narrowness is the whole point
    h.proc.fire("uncaughtException", new Error("cannot read properties of undefined"));
    expect(h.proc.exits).toEqual([1]);
  } finally { h.uninstall(); rmSync(h.dir, { recursive: true, force: true }); }
});
