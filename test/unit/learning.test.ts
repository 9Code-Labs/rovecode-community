/** learning (Hermes-inspired) — graph derivation, session→skill drafts, nudges, SDK wiring. */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/core/session.ts";
import type { Message } from "../../src/core/types.ts";
import { SkillStore } from "../../src/skills/index.ts";
import { BlockStore } from "../../src/memory/blocks.ts";
import { buildLearningGraph, memoryChunks, tokens, jaccard } from "../../src/learning/graph.ts";
import { draftSkillFromSession, learningNudges, saveSkillDraft, sessionFacts, toolSignature } from "../../src/learning/draft.ts";
import { createClient } from "../../src/sdk/index.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";

const dirs: string[] = [];
function ws(): string { const d = mkdtempSync(join(tmpdir(), "rovec-learn-")); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

let seq = 0;
let lastId: string | null = null; // SessionStore.path() follows parent links — chain or messages vanish
function msg(role: Message["role"], parts: Message["parts"]): Message {
  const id = `m${++seq}`;
  const parentId = lastId;
  lastId = id;
  return { id, role, parts, parentId, createdAt: seq };
}
const user = (text: string) => msg("user", [{ kind: "text", text }]);
const call = (tool: string, args: unknown = {}) => msg("assistant", [{ kind: "tool_call", id: `t${++seq}`, tool, args }]);

function seedSkill(cwd: string, name: string, description: string, related = ""): void {
  const dir = join(cwd, ".rovecode", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  related_skills: ${related}\n---\n\nBody of ${name}.\n`);
}

describe("learning/graph", () => {
  it("tokens/jaccard: shared vocabulary scores, disjoint does not", () => {
    const a = tokens("fix the flaky login test");
    const b = tokens("flaky login timeout");
    expect(jaccard(a, b)).toBeGreaterThan(0);
    expect(jaccard(a, tokens("zzz qqq"))).toBe(0);
  });

  it("memoryChunks keeps bullets and sentences, drops headers and crumbs", () => {
    const chunks = memoryChunks("# Notes\n- the deploy token lives in 1Password\nx\nplain sentence here is long enough\n");
    expect(chunks).toEqual(["the deploy token lives in 1Password", "plain sentence here is long enough"]);
  });

  it("declared related_skills become edges; lexical overlap links memory to skills", () => {
    const cwd = ws();
    seedSkill(cwd, "release-flow", "cut a release with changelog and tag", "hotfix-flow");
    seedSkill(cwd, "hotfix-flow", "ship an urgent patch release");
    const skillStore = new SkillStore(cwd, { globalDir: null });
    const memDir = join(cwd, ".rovecode", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), "- the release-flow changelog step needs signed tags\n");
    const blocks = new BlockStore({ memory: memDir, user: memDir }); // BlockDirs = directories, BLOCK_FILES supplies the name

    const g = buildLearningGraph({ skillStore, blocks });
    expect(g.nodes.filter((n) => n.kind === "skill").length).toBe(2);
    expect(g.nodes.filter((n) => n.kind === "memory").length).toBe(1);
    expect(g.edges.some((e) => e.kind === "declared" && e.from === "skill:release-flow" && e.to === "skill:hotfix-flow")).toBe(true);
    expect(g.edges.some((e) => e.kind === "lexical" && e.to === "skill:release-flow")).toBe(true);
  });
});

describe("learning/draft", () => {
  it("sessionFacts extracts goal, tool sequence, files and commands", () => {
    const cwd = ws();
    const store = new SessionStore(join(cwd, ".rovecode", "sessions"), "s1");
    store.append(user("set up the release pipeline"));
    store.append(call("bash", { command: "bun test" }));
    store.append(call("write", { path: "src/release.ts", content: "x" }));
    store.append(call("edit", { path: "package.json", find: "a", replace: "b" }));
    store.append(call("bash", { command: "git tag v1" }));
    const f = sessionFacts(store.messages());
    expect(f.goal).toBe("set up the release pipeline");
    expect(f.toolCalls).toBe(4);
    expect(f.files).toEqual(["src/release.ts", "package.json"]);
    expect(f.commands).toEqual(["bun test", "git tag v1"]);
    expect(toolSignature(f)).toEqual(["bash", "write", "edit"]);
  });

  it("draftSkillFromSession returns a SKILL.md proposal; too-thin sessions return null", () => {
    const cwd = ws();
    const root = join(cwd, ".rovecode", "sessions");
    const thin = new SessionStore(root, "thin");
    thin.append(user("hi"));
    thin.append(call("bash", { command: "ls" }));
    expect(draftSkillFromSession(thin)).toBeNull();

    const rich = new SessionStore(root, "rich");
    rich.append(user("add retry with backoff to the provider client"));
    rich.append(call("read", { path: "src/providers/retry.ts" }));
    rich.append(call("edit", { path: "src/providers/retry.ts" }));
    rich.append(call("bash", { command: "bun test retry" }));
    const draft = draftSkillFromSession(rich)!;
    expect(draft).not.toBeNull();
    expect(draft.content).toContain("name: add-retry-with-backoff");
    expect(draft.content).toContain("## What worked");
    expect(draft.content).toContain("learned_from: session");
    expect(draft.evidence.toolCalls).toBe(3);
    expect(draft.evidence.sessions).toEqual(["rich"]);
  });

  it("saveSkillDraft writes project-scope, refuses overwrite, honours overwrite:true", () => {
    const cwd = ws();
    const draft = { name: "my-skill", description: "d", content: "---\nname: my-skill\ndescription: d\n---\n", evidence: { goal: "g", toolCalls: 3, files: [], commands: [], sessions: ["s"] } };
    const first = saveSkillDraft(cwd, draft);
    expect(first.ok).toBe(true);
    const second = saveSkillDraft(cwd, draft);
    expect(second.ok).toBe(false);
    const forced = saveSkillDraft(cwd, draft, { overwrite: true });
    expect(forced.ok).toBe(true);
    expect(saveSkillDraft(cwd, { ...draft, name: "BAD NAME!" }).ok).toBe(false);
    // and the store actually picks it up
    expect(new SkillStore(cwd, { globalDir: null }).scan().skills.map((s) => s.name)).toContain("my-skill");
  });

  it("learningNudges flags repeated uncovered workflows and novel heavy sessions", () => {
    const cwd = ws();
    const root = join(cwd, ".rovecode", "sessions");
    for (const id of ["a", "b"]) {
      const s = new SessionStore(root, id);
      s.append(user(`deploy the worker to staging ${id}`));
      s.append(call("bash", { command: "wrangler deploy" }));
      s.append(call("read", { path: "wrangler.jsonc" }));
      s.append(call("edit", { path: "wrangler.jsonc" }));
    }
    const heavy = new SessionStore(root, "heavy");
    heavy.append(user("migrate the database schema carefully"));
    for (let i = 0; i < 4; i++) { heavy.append(call("bash", { command: `echo ${i}` })); heavy.append(call("edit", { path: `m${i}.sql` })); }
    const nudges = learningNudges({ sessionsRoot: root, skillStore: new SkillStore(cwd, { globalDir: null }) });
    expect(nudges.some((n) => n.kind === "repeat" && n.sessions.sort().join() === "a,b")).toBe(true);
    expect(nudges.some((n) => n.kind === "novel" && n.sessions[0] === "heavy")).toBe(true);
  });
});

describe("sdk learning surface", () => {
  it("rc.memory round-trips and rc.learn drafts+saves from a live session", async () => {
    const cwd = ws();
    const rc = await createClient({ cwd, stream: mockStream({ turns: [textTurn("ok")] }) });
    expect(rc.memory.add("memory", "the release token lives in the vault").ok).toBe(true);
    expect(rc.memory.read("memory")).toContain("release token");

    const s = await rc.session.create();
    for await (const _ of s.prompt("noop")) { /* drain */ }
    // transcript too thin for a draft (mock run = no tool calls)
    expect(rc.learn.draftSkill(s.id)).toBeNull();

    // graph sees the memory we just persisted
    const g = rc.learn.graph();
    expect(g.nodes.some((n) => n.kind === "memory" && (n.preview ?? "").includes("release token"))).toBe(true);
    await rc.close();
  });
});
