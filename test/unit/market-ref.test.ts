/** `--ref`: pinning a cloned source to a branch, a tag or a commit.
 *
 *  The decision under test is not "does it clone" but "who decides what the ref IS". A pattern like
 *  /^[0-9a-f]{7,40}$/ is a guess; git's answer is a fact. Most of these tests exist because the guess and
 *  the fact disagree in cases that are easy to construct and impossible to notice afterwards.
 *
 *  The first group drives cloneAtRef with a scripted spawn — every command it would run is asserted, no
 *  network. The last one uses REAL git in a temp repository, because the branch-versus-commit collision is
 *  the one thing a scripted fake cannot honestly prove: only git can tell us what git would do. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneAtRef, type Spawn } from "../../src/market/clone.ts";
import { planInstall, runInstall } from "../../src/market/install.ts";
import { recordFor } from "../../src/market/manifest.ts";
import { findItem, searchMarket, type RegistryDeps } from "../../src/market/registry.ts";
import type { MarketItem } from "../../src/market/types.ts";

/** a spawn that records what was asked and answers from a table of exit codes */
function scripted(answers: (cmd: string[]) => { code: number; stderr?: string }) {
  const ran: string[][] = [];
  const spawn: Spawn = async (cmd) => { ran.push(cmd); const a = answers(cmd); return { code: a.code, stderr: a.stderr ?? "" }; };
  return { spawn, ran };
}
const isClone = (c: string[]): boolean => c[1] === "clone";
const isFetch = (c: string[]): boolean => c[1] === "fetch";

test("no ref: one plain shallow clone, and the result says it was the default", async () => {
  const { spawn, ran } = scripted(() => ({ code: 0 }));
  expect(await cloneAtRef(spawn, "https://example.com/r.git", "/tmp/x")).toEqual({ ok: true, resolvedBy: "default" });
  expect(ran).toEqual([["git", "clone", "--depth", "1", "--quiet", "--", "https://example.com/r.git", "."]]);
});

test("a ref is tried as a branch or tag FIRST, and that is the whole command when it works", async () => {
  const { spawn, ran } = scripted(() => ({ code: 0 }));
  expect(await cloneAtRef(spawn, "https://example.com/r.git", "/tmp/x", "v2.1")).toEqual({ ok: true, resolvedBy: "branch" });
  expect(ran).toEqual([["git", "clone", "--depth", "1", "--quiet", "--branch", "v2.1", "--", "https://example.com/r.git", "."]]);
});

test("a ref that is not a branch falls through to the commit path, and says so", async () => {
  const sha = "41bbe19d1a1aa9f0d3c2b1a0998877665544332211";
  const { spawn, ran } = scripted((c) => (isClone(c) ? { code: 128, stderr: "warning: Could not find remote branch" } : { code: 0 }));
  expect(await cloneAtRef(spawn, "https://example.com/r.git", "/tmp/x", sha)).toEqual({ ok: true, resolvedBy: "commit" });
  expect(ran.map((c) => c[1])).toEqual(["clone", "init", "fetch", "checkout"]);
  expect(ran[2]).toEqual(["git", "fetch", "--depth", "1", "--quiet", "--", "https://example.com/r.git", sha]);
  expect(ran[3]).toEqual(["git", "checkout", "--quiet", "FETCH_HEAD"]);
});

test("a server that refuses a bare commit is reported, NOT answered by cloning the whole history", async () => {
  const { spawn, ran } = scripted((c) => isClone(c)
    ? { code: 128, stderr: "Remote branch not found" }
    : isFetch(c) ? { code: 128, stderr: "error: Server does not allow request for unadvertised object 41bbe19" } : { code: 0 });
  const r = await cloneAtRef(spawn, "https://example.com/r.git", "/tmp/x", "41bbe19");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("will not serve the single commit");
  expect(r.error).toContain("give a branch or tag instead");
  // the fix for "the server will not send one commit" is never "then send me all of them"
  expect(ran.some((c) => c.includes("--depth") && c.includes("50"))).toBe(false);
  expect(ran.filter(isClone).length).toBe(1);
  expect(ran.some((c) => c[1] === "checkout")).toBe(false);
});

test("a value that looks like an option stays a value: `--` sits before every positional", async () => {
  // git parses options by shape, not by position, so `--upload-pack=...` in the ref or url slot is an
  // instruction unless something says otherwise. Catalog data never arrives in that shape, but `--ref` and
  // `market install <git-url>` are command-line input, and this is one argument's worth of certainty.
  const evil = "--upload-pack=touch /tmp/pwned";
  const { spawn, ran } = scripted((c) => (isClone(c) ? { code: 128, stderr: "Remote branch not found" } : { code: 0 }));
  await cloneAtRef(spawn, "https://example.com/r.git", "/tmp/x", evil);

  for (const cmd of ran) {
    const end = cmd.indexOf("--");
    if (!cmd.includes(evil) && !cmd.includes("https://example.com/r.git")) continue;
    expect(end).toBeGreaterThan(-1);
    // every argument git could read as an option comes BEFORE the marker, and the untrusted ones after it
    for (const arg of cmd.slice(end + 1)) expect(cmd.indexOf(arg)).toBeGreaterThan(end);
  }
  // and the ref never appears in a slot where it could act: --branch takes it as a VALUE, or it follows `--`
  const branchClone = ran.find(isClone)!;
  expect(branchClone[branchClone.indexOf(evil) - 1]).toBe("--branch");
  const fetch = ran.find(isFetch)!;
  expect(fetch.indexOf("--")).toBeLessThan(fetch.indexOf(evil));
});

test("a ref that exists nowhere reports both attempts rather than only the second", async () => {
  const { spawn } = scripted((c) => (isClone(c) || isFetch(c) ? { code: 128, stderr: "fatal: couldn't find remote ref nope" } : { code: 0 }));
  const r = await cloneAtRef(spawn, "https://example.com/r.git", "/tmp/x", "nope");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("is not a branch or tag there, and fetching it as a commit failed");
});

// ---------- the flag's edges ----------

const SKILLS = { version: 1, items: [
  { id: "remote-skill", title: "Remote skill", publisher: "rovecode", description: "Cloned.", install: { source: { git: "https://example.com/skill.git" } } },
] };
const PLUGINS = { version: 1, items: [
  { id: "linter", title: "Linter", publisher: "acme", version: "2.0.0", description: "Lints.", install: { source: "https://example.com/linter.git", git: true } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-ref-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-ref-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify(PLUGINS));
  const registry: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
const find = (items: MarketItem[], id: string, kind: string): MarketItem => items.find((i) => i.id === id && i.kind === kind)!;

test("`--ref` on a plugin is refused rather than accepted and ignored", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    // accepting it silently is exactly the failure this feature prevents: the human believes they pinned
    const plan = planInstall(find(items, "linter", "plugin"), { scope: "user", cwd: s.cwd, home: s.home, ref: "v1" });
    expect("error" in plan).toBe(true);
    if ("error" in plan) expect(plan.error).toContain("not wired for plugins yet");
  } finally { s.cleanup(); }
});

test("a pinned skill records the ref, how it resolved, and the commit it landed on", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home, ref: "v3" };
    const plan = planInstall(find(items, "remote-skill", "skill"), opts);
    if ("error" in plan) throw new Error(plan.error);

    const spawn: Spawn = async (cmd, cwd) => {
      if (cmd[1] === "clone") {
        mkdirSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git", "HEAD"), "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00\n");
        writeFileSync(join(cwd, "SKILL.md"), "---\nname: remote-skill\n---\npinned\n");
      }
      return { code: 0, stderr: "" };
    };
    expect((await runInstall(plan, {}, opts, { spawn })).ok).toBe(true);
    const record = recordFor({ kind: "skill", id: "remote-skill" }, "user", s.cwd, s.home)!;
    expect(record.git).toMatchObject({ source: "https://example.com/skill.git", ref: "v3", resolvedBy: "branch", sha: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00" });
  } finally { s.cleanup(); }
});

// ---------- the collision, against real git ----------

const haveGit = (() => { try { return Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; } })();

test.if(haveGit)("when a name is BOTH a branch and a commit's short id, the branch wins — and that is a decision, not an accident", async () => {
  const origin = mkdtempSync(join(tmpdir(), "rovecode-refrepo-"));
  const work = mkdtempSync(join(tmpdir(), "rovecode-refwork-"));
  const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git(["init", "--quiet", "--initial-branch=main"], origin);
    writeFileSync(join(origin, "SKILL.md"), "first\n");
    git(["add", "-A"], origin); git(["commit", "-qm", "one"], origin);
    const first = git(["rev-parse", "HEAD"], origin).stdout.toString().trim();

    // a SECOND commit, and a branch named after the FIRST commit's short id
    writeFileSync(join(origin, "SKILL.md"), "second\n");
    git(["add", "-A"], origin); git(["commit", "-qm", "two"], origin);
    const collide = first.slice(0, 7);
    git(["branch", collide], origin);          // the branch points at the SECOND commit
    git(["update-ref", `refs/heads/${collide}`, "HEAD"], origin);

    const spawn: Spawn = async (cmd, cwd) => {
      const p = Bun.spawnSync(["git", ...cmd.slice(1)], { cwd, stdout: "ignore", stderr: "pipe" });
      return { code: p.exitCode, stderr: p.stderr.toString() };
    };
    const dest = join(work, "clone");
    mkdirSync(dest, { recursive: true });
    const r = await cloneAtRef(spawn, origin.replace(/\\/g, "/"), dest, collide);
    expect(r).toEqual({ ok: true, resolvedBy: "branch" });
    // the branch's content, not the commit whose id it borrowed: a regex would have picked the other one
    expect(readFileSync(join(dest, "SKILL.md"), "utf8").trim()).toBe("second");
  } finally {
    rmSync(origin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

test.if(haveGit)("a real bare commit still resolves through the fetch path", async () => {
  const origin = mkdtempSync(join(tmpdir(), "rovecode-refrepo2-"));
  const work = mkdtempSync(join(tmpdir(), "rovecode-refwork2-"));
  const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git(["init", "--quiet", "--initial-branch=main"], origin);
    git(["config", "uploadpack.allowReachableSHA1InWant", "true"], origin);
    writeFileSync(join(origin, "SKILL.md"), "pinned\n");
    git(["add", "-A"], origin); git(["commit", "-qm", "one"], origin);
    const sha = git(["rev-parse", "HEAD"], origin).stdout.toString().trim();
    writeFileSync(join(origin, "SKILL.md"), "later\n");
    git(["add", "-A"], origin); git(["commit", "-qm", "two"], origin);

    const spawn: Spawn = async (cmd, cwd) => {
      const p = Bun.spawnSync(["git", ...cmd.slice(1)], { cwd, stdout: "ignore", stderr: "pipe" });
      return { code: p.exitCode, stderr: p.stderr.toString() };
    };
    const dest = join(work, "clone");
    mkdirSync(dest, { recursive: true });
    const r = await cloneAtRef(spawn, origin.replace(/\\/g, "/"), dest, sha);
    expect(r).toEqual({ ok: true, resolvedBy: "commit" });
    expect(readFileSync(join(dest, "SKILL.md"), "utf8").trim()).toBe("pinned");   // the pinned commit, not HEAD
    expect(existsSync(join(dest, ".git"))).toBe(true);
  } finally {
    rmSync(origin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

// ---------- the context cost, placed in the plan ----------

test("the plan shows what a skill costs per turn and what it costs only when opened, as two numbers", async () => {
  const s = scratch();
  try {
    const files = [{ path: "SKILL.md", text: `---\nname: costly\ndescription: ${"a description ".repeat(6)}\n---\n${"body text ".repeat(400)}` }];
    writeFileSync(join(s.home, "skills.json"), JSON.stringify({ version: 1, items: [
      { id: "costly", title: "Costly", publisher: "p", description: "d", install: { files },
        docs: { source: "https://example.com/SKILL.md", format: "markdown", bytes: 4000, truncated: false, text: files[0]!.text,
          body: files[0]!.text } },
    ] }));
    // resolved the way the CLI resolves it: findItem carries the body, the search path deliberately does not
    const item = (await findItem("skill", "costly", s.registry)).item!;
    const plan = planInstall(item, { scope: "user", cwd: s.cwd, home: s.home });
    if ("error" in plan) throw new Error(plan.error);
    const text = plan.preview.join("\n");

    // two numbers, never one: an index line and a body differ by roughly thirty times
    expect(text).toMatch(/context {4}~\d+ tokens every turn, ~[\d.]+k? more when the model opens it/);
    // the estimate names its tokenizer rather than pretending to be exact. The SENTENCE is context-cost.ts's
    // to word — this test owns the placement, so it pins the shape and the label, not the prose.
    expect(text).toContain("o200k_base");
    const lines = plan.preview.filter((l) => l.startsWith("  context    ") || l.startsWith("             o") || l.includes("o200k_base"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(plan.preview.filter((l) => l.startsWith("  context    ")).length).toBe(1);   // one label, continuations indented
  } finally { s.cleanup(); }
});

test("an MCP server's context cost is not guessed at — it says why it cannot be known yet", async () => {
  const s = scratch();
  try {
    const registry: RegistryDeps = { ...s.registry, mcp: { offline: true, home: s.home, catalog: [
      { key: "notes", title: "Notes", source: "curated", publisher: "acme", description: "Notes.",
        installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "notes-server"], env: [], pending: [] }] },
    ] } };
    const items = (await searchMarket("", registry)).items;
    const plan = planInstall(find(items, "notes", "mcp"), { scope: "user", cwd: s.cwd, home: s.home });
    if ("error" in plan) throw new Error(plan.error);
    const text = plan.preview.join("\n");
    expect(text).toContain("context");
    // no invented figure: a server's tools are only known once it connects
    const contextPart = text.split("context")[1]?.split("writes")[0] ?? "";
    expect(contextPart).not.toMatch(/~\d/);
  } finally { s.cleanup(); }
});

test("the estimate is scaled for the model the plan is drawn for, and says so when there is none", async () => {
  const s = scratch();
  try {
    const body = `---\nname: costly\ndescription: a description of some length here\n---\n${"body text ".repeat(400)}`;
    writeFileSync(join(s.home, "skills.json"), JSON.stringify({ version: 1, items: [
      { id: "costly", title: "Costly", publisher: "p", description: "d", install: { files: [{ path: "SKILL.md", text: body }] },
        docs: { source: "https://example.com/SKILL.md", format: "markdown", bytes: 4000, truncated: false, body } },
    ] }));
    const item = (await findItem("skill", "costly", s.registry)).item!;
    const base = { scope: "user" as const, cwd: s.cwd, home: s.home };

    const unscaled = planInstall(item, base);
    const scaled = planInstall(item, { ...base, model: { provider: "anthropic", model: "claude-sonnet-5" } });
    if ("error" in unscaled || "error" in scaled) throw new Error("plan failed");

    const perTurn = (p: { preview: string[] }): number => Number(/~(\d+) tokens every turn/.exec(p.preview.join("\n"))?.[1] ?? "0");
    // a Claude model's real prompt is bigger than o200k counts, so the scaled figure must be larger
    expect(perTurn(scaled)).toBeGreaterThan(perTurn(unscaled));
    // and with no model named, the plan says the numbers are unscaled instead of quietly picking one
    expect(unscaled.preview.join("\n")).toContain("no model was named");
  } finally { s.cleanup(); }
});
