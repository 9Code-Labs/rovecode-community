import { test, expect } from "bun:test";
import { SessionStore, chainHash } from "../../src/core/session.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function msg(text: string, parentId: string | null = null) {
  return { id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }], parentId, createdAt: Date.now() };
}

test("session store appends and replays path", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "s1");
  const m1 = msg("hello", null);
  const m2 = msg("world", m1.id);
  s.append(m1); s.append(m2);
  const msgs = s.messages();
  expect(msgs.length).toBe(2);
  expect(msgs[0]!.parts[0]).toEqual({ kind: "text", text: "hello" });
  rmSync(dir, { recursive: true, force: true });
});

test("branch rewinds leaf without deleting", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "s2");
  const m1 = msg("a"); s.append(m1);
  const m2 = msg("b", m1.id); s.append(m2);
  const ok = s.branch(m1.id);
  expect(ok).toBe(true);
  expect(s.messages().length).toBe(1);
  // re-branch forward still possible (nothing deleted)
  expect(s.branch(m2.id)).toBe(true);
  expect(s.messages().length).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});

test("reload detects malformed json corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "s3");
  s.append(msg("x"));
  const f = join(dir, "s3", "entries.jsonl");
  const lines = require("node:fs").readFileSync(f, "utf8").split("\n").filter(Boolean);
  require("node:fs").writeFileSync(f, lines.join("\n") + "\nnot json\n");
  const s2 = new SessionStore(dir, "s3");
  const corrupt = s2.reload();
  expect(corrupt.some((c) => c.kind === "malformed-json")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("chain hash is tamper-evident", () => {
  const m = msg("seed");
  const h1 = chainHash("", m as never);
  const h2 = chainHash("", { ...m, parts: [{ kind: "text", text: "tampered" }] } as never);
  expect(h1).not.toBe(h2);
});
