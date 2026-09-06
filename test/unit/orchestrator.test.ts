import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightSpawn, createIsolation, deriveChildRules, DEFAULT_MAX_DEPTH,
} from "../../src/core/orchestrator.ts";
import type { AgentDefinition, PermissionRule } from "../../src/core/types.ts";

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "worker", systemPrompt: "do work", tools: ["*"], ...over,
});

// ---------- preflightSpawn: depth + spawn policy ----------

test("depth 0 spawns freely", () => {
  expect(preflightSpawn(agent(), { depth: 0, maxDepth: DEFAULT_MAX_DEPTH, parentSessionId: "s" }).ok).toBe(true);
});

test("depth at cap is blocked (depth 3, cap 3)", () => {
  const r = preflightSpawn(agent(), { depth: 3, maxDepth: DEFAULT_MAX_DEPTH, parentSessionId: "s" });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("depth cap 3");
});

test("depth below cap passes; above cap blocked", () => {
  expect(preflightSpawn(agent(), { depth: 2, maxDepth: 3, parentSessionId: "s" }).ok).toBe(true);
  expect(preflightSpawn(agent(), { depth: 4, maxDepth: 3, parentSessionId: "s" }).ok).toBe(false);
});

test("spawn policy 'none' refuses regardless of depth", () => {
  const r = preflightSpawn(agent({ spawns: "none" }), { depth: 0, maxDepth: 3, parentSessionId: "s" });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("'none'");
});

// ---------- deriveChildRules: narrowing ----------

const parentRules: PermissionRule[] = [
  { action: "file.read", resource: "*", effect: "allow" },
  { action: "shell.exec", resource: "*", effect: "prompt" },
  { action: "file.write", resource: "src/**", effect: "allow" },
  { action: "shell.exec", resource: "rm *", effect: "deny" },
  { action: "file.write", resource: ".env*", effect: "prompt" },
];

test("no prompt rules survive derivation", () => {
  const child = deriveChildRules(parentRules);
  expect(child.filter((r) => r.effect === "prompt")).toHaveLength(0);
  // both parent prompt rules became deny
  const exec = child.find((r) => r.action === "shell.exec" && r.resource === "*");
  expect(exec?.effect).toBe("deny");
  const dotenv = child.find((r) => r.resource === ".env*");
  expect(dotenv?.effect).toBe("deny");
});

test("deny-rest default present, placed FIRST (last-match-wins: parent-derived rules must override it)", () => {
  const child = deriveChildRules(parentRules);
  expect(child.at(0)).toEqual({ action: "*", resource: "*", effect: "deny" });
});

test("allow rules keep parent breadth when not isolated", () => {
  const child = deriveChildRules(parentRules);
  const read = child.find((r) => r.action === "file.read");
  expect(read?.effect).toBe("allow");
  expect(read?.resource).toBe("*"); // breadth unchanged
});

test("isolated children get path-glob allows re-rooted under the isolation dir", () => {
  const isoDir = join("tmp", "rovecode-iso-x", "work");
  const child = deriveChildRules(parentRules, isoDir, true);
  const write = child.find((r) => r.action === "file.write" && r.resource !== ".env*" && r.resource !== "*");
  expect(write?.resource).toBe(join(isoDir, "src/**"));
  // wildcard and command-shaped resources are left alone
  expect(child.find((r) => r.action === "file.read")?.resource).toBe("*");
  expect(child.find((r) => r.resource === "rm *")?.effect).toBe("deny");
});

// ---------- createIsolation: Windows-safe smoke ----------

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-orch-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("worktree isolation: diff after a change, cleanup removes dir", async () => {
  const repo = tempGitRepo();
  try {
    const iso = await createIsolation(repo, { prefer: "worktree" });
    expect(iso.kind === "worktree" || iso.kind === "copy").toBe(true);
    expect((await iso.diff()).trim()).toBe(""); // clean tree → empty patch
    writeFileSync(join(iso.dir, "src", "app.ts"), "export const x = 2;\n");
    const patch = await iso.diff();
    expect(patch.trim()).not.toBe("");
    expect(patch).toContain("src/app.ts");
    expect(patch).toContain("-export const x = 1;");
    expect(patch).toContain("+export const x = 2;");
    const dir = iso.dir;
    await iso.cleanup();
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("copy isolation: same contract without git", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rovecode-orch-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  try {
    const iso = await createIsolation(repo, { prefer: "copy" });
    expect(iso.kind).toBe("copy");
    expect((await iso.diff()).trim()).toBe("");
    writeFileSync(join(iso.dir, "src", "app.ts"), "export const x = 2;\n");
    const patch = await iso.diff();
    expect(patch).toContain("-export const x = 1;");
    expect(patch).toContain("+export const x = 2;");
    // patch paths are repo-relative (applyable in the parent)
    expect(patch).not.toContain("baseline/");
    expect(patch).not.toContain("work/src");
    const dir = iso.dir;
    await iso.cleanup();
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("copy patch applies back onto the parent tree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rovecode-orch-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  try {
    const iso = await createIsolation(repo, { prefer: "copy" });
    writeFileSync(join(iso.dir, "src", "app.ts"), "export const x = 2;\n");
    const patch = await iso.diff();
    const p = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "apply", "-"], { cwd: repo, stdin: new Blob([patch]), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const x = 2;\n");
    await iso.cleanup();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prefer none returns the root with no-op diff/cleanup", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rovecode-orch-"));
  try {
    const iso = await createIsolation(repo, { prefer: "none" });
    expect(iso.kind).toBe("none");
    expect(iso.dir).toBe(repo);
    expect(await iso.diff()).toBe("");
    await iso.cleanup();
    expect(existsSync(repo)).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
