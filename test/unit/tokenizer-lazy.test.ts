/** The o200k table (gpt-tokenizer) costs 385–520 ms and ~136 MB resident to load (scripts/probe-import.ts,
 *  2026-09-06). Nothing on a session's boot path may load it: not counting an empty transcript, not the
 *  sextant usage panel of a fresh session, not the panel of a resumed one with a transcript. Each check
 *  runs in a child bun, because the test runner's own module cache would already hold the table from
 *  another test file (usage.test.ts counts real tokens). The boot checks reuse scripts/probe-boot.ts. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/core/session.ts";
import type { Message } from "../../src/core/types.ts";

const ROOT = join(import.meta.dir, "..", "..");
/** the child's env: no MCP servers, no skills, no credentials from the developer's home */
const childEnv = (home: string): Record<string, string> => ({ ...process.env, ROVECODE_HOME: home, NO_COLOR: "1" } as Record<string, string>);

function run(cmd: string[], cwd: string, home: string): { out: string; err: string; code: number } {
  const r = Bun.spawnSync({ cmd, cwd, env: childEnv(home), stdout: "pipe", stderr: "pipe" });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
}

/** the probe's "first frame" sample */
function firstFrame(out: string): { tokenizer: boolean; modules: number; rssMB: number } {
  const line = out.split("\n").find((l) => l.includes('"at":"first frame"'));
  if (!line) throw new Error(`no first-frame sample in probe output:\n${out}`);
  return JSON.parse(line) as { tokenizer: boolean; modules: number; rssMB: number };
}

test("countTokens('') answers 0 without loading the o200k table; a non-empty count loads it", () => {
  const home = mkdtempSync(join(tmpdir(), "rovecode-tok-home-"));
  const src = `const u = await import("./src/core/usage.ts"); const loaded = () => Object.keys(require.cache).some((k) => k.includes("gpt-tokenizer"));
    const a = u.countTokens(""); const l1 = loaded(); const ifl = u.countTokensIfLoaded("hello world"); const l2 = loaded();
    const b = u.countTokens("hello world"); const l3 = loaded();
    console.log(JSON.stringify({ a, l1, ifl, l2, b, l3, resident: u.tokenizerLoaded() }));`;
  const r = run([process.execPath, "-e", src], ROOT, home);
  rmSync(home, { recursive: true, force: true });
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out.trim()) as { a: number; l1: boolean; ifl: number | null; l2: boolean; b: number; l3: boolean; resident: boolean };
  expect(j.a).toBe(0); expect(j.l1).toBe(false);                 // empty: answered, table untouched
  expect(j.ifl).toBeNull(); expect(j.l2).toBe(false);            // "if loaded": declines, never loads
  expect(j.b).toBeGreaterThan(0); expect(j.l3).toBe(true);       // a real count is what loads it
  expect(j.resident).toBe(true);
});

test("a fresh sextant session boots to its first frame without the o200k table", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tok-fresh-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-tok-home-"));
  const r = run([process.execPath, join(ROOT, "scripts", "probe-boot.ts"), "--quick"], cwd, home);
  rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  expect(r.code).toBe(0);
  expect(firstFrame(r.out).tokenizer).toBe(false);
}, 30_000);

test("a resumed session with a transcript boots to its first frame without the o200k table (the panel estimates from chars)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tok-resume-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-tok-home-"));
  const sessionsDir = join(cwd, ".rovecode", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const id = "11111111-2222-4333-8444-555555555555";
  const store = new SessionStore(sessionsDir, id);
  const user: Message = { id: "u1", role: "user", parts: [{ kind: "text", text: "Summarise the plan for the sextant frame loop, in detail." }], parentId: null, createdAt: 1 };
  const assistant: Message = { id: "a1", role: "assistant", parts: [{ kind: "text", text: "The loop sleeps until the next ambient change. ".repeat(40) }], parentId: "u1", createdAt: 2, origin: { provider: "anthropic", model: "claude-sonnet-5" }, usage: { input: 1200, output: 300 } };
  store.append(user); store.append(assistant);
  const r = run([process.execPath, join(ROOT, "scripts", "probe-boot.ts"), "--quick", "--session", id], cwd, home);
  rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  expect(r.code).toBe(0);
  expect(firstFrame(r.out).tokenizer).toBe(false);
}, 30_000);
