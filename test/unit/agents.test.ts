/** core/agents.ts (ported from the Nimbus harness, #62 + its fix wave): the frontmatter parser (description / model / mode /
 *  tools allow-list / body = prompt; every malformed field is an `{ error }`, never a throw; a YAML block list or an empty
 *  `tools:` never fails open to "*"; unknown keys load with a warning), discovery across the user scope (ROVECODE_HOME →
 *  <home>/agents) + `.rovecode/agents` with project-shadows-user, reserved names (main + the four lane ids, each refused
 *  with a line naming the file), a `model:` the runtime cannot honour refused at discovery (modelProblemFor), and the
 *  child registry FILTER restrictTools (allow-list ∩ the parent's names — never wider). Each test names its mutation target. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  DEFAULT_RESERVED_AGENT_NAMES, agentRows, discoverAgents, modelProblemFor, parseAgentFile, parseToolList, restrictTools, type CustomAgent,
} from "../../src/core/agents.ts";
import type { Tool } from "../../src/core/types.ts";

let cwd: string;
let home: string;
const SAVED_HOME = process.env.ROVECODE_HOME;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-agents-cwd-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-agents-home-"));
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = SAVED_HOME;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}
const project = (file: string, content: string) => write(cwd, join(".rovecode", "agents", file), content);
const user = (file: string, content: string) => write(home, join("agents", file), content);

const BLOCK_LIST = 'frontmatter uses a YAML block list ("- read") — not supported: write `tools: read, grep` on one line';
const EMPTY_TOOLS = "tools: empty value (write `tools: *` for every tool, or list names — `tools:` alone never means all)";

// ---------- file format ----------

test("parseAgentFile: full frontmatter → description/model/mode/tools + trimmed body; tools accept commas, spaces and [brackets]", () => {
  const p = parseAgentFile("---\ndescription: Fast explorer\nmodel: openai/gpt-4o-mini\nmode: plan\ntools: read, grep glob\n---\n\nYou explore.\n\n");
  expect(p).toEqual({ description: "Fast explorer", model: "openai/gpt-4o-mini", mode: "plan", tools: ["read", "grep", "glob"], body: "You explore." });
  expect(parseToolList("[read, edit]")).toEqual(["read", "edit"]);
  expect(parseToolList('"read" "write"')).toEqual(["read", "write"]);
  expect(parseToolList("read, read, grep")).toEqual(["read", "grep"]); // deduped
});

test("parseAgentFile: no frontmatter = body only with defaults (tools *, no description/model/mode); empty file = empty body (inherits the runtime prompt); a BOM is dropped", () => {
  expect(parseAgentFile("Just a prompt.\n")).toEqual({ description: undefined, model: undefined, mode: undefined, tools: ["*"], body: "Just a prompt." });
  expect(parseAgentFile("---\ndescription: d\n---\n")).toMatchObject({ description: "d", tools: ["*"], body: "" });
  expect(parseAgentFile(String.fromCharCode(0xfeff) + "---\ndescription: bom\n---\nx")).toMatchObject({ description: "bom", body: "x" });
});

test("parseAgentFile: `tools: *` (alone or among names) = every child tool; parseToolList('') keeps its own contract", () => {
  expect(parseToolList("*")).toEqual(["*"]);
  expect(parseToolList("read, *")).toEqual(["*"]);
  expect(parseToolList("")).toEqual(["*"]);
  expect(parseToolList(undefined)).toEqual(["*"]);
  expect(parseAgentFile("---\ntools: *\n---\nx")).toMatchObject({ tools: ["*"] });
  expect(parseAgentFile("---\ntools: [*]\n---\nx")).toMatchObject({ tools: ["*"] });
});

test("parseAgentFile: invalid files are `{ error }` (never a throw) — unterminated frontmatter, mode outside plan|act, a spaced model, a malformed tools token; the echo is bounded", () => {
  // MUTATION TARGET: return the parsed file despite the bad field → these become objects without `error`
  expect(parseAgentFile("---\ndescription: never closed\nbody")).toEqual({ error: "unterminated frontmatter (no closing ---)" });
  expect(parseAgentFile("---\nmode: turbo\n---\nx")).toEqual({ error: 'mode must be "plan" or "act" (got "turbo")' });
  expect(parseAgentFile("---\nmodel: gpt 4o\n---\nx")).toEqual({ error: 'model must be one selector ("provider/model" or a model id; got "gpt 4o")' });
  expect(parseAgentFile("---\ntools: read, sh;rm\n---\nx")).toEqual({ error: 'tools: "sh;rm" is not a tool name (letters, digits, _ - or *)' });
  const long = parseAgentFile(`---\nmode: ${"x".repeat(200)}\n---\nx`);
  expect("error" in long && long.error.length).toBeLessThan(100);
});

test("parseAgentFile: a YAML block list under ANY key is `{ error }` naming block lists — never `*`; any other colon-less line names the line (MUTATION TARGET: drop checkFrontmatterLines → tools ['*'])", () => {
  expect(parseAgentFile("---\ndescription: d\ntools:\n  - read\n  - grep\n---\nbody")).toEqual({ error: BLOCK_LIST });
  expect(parseAgentFile("---\ndescription:\n  - one\n---\nx")).toMatchObject({ error: expect.stringContaining("YAML block list") });
  expect(parseAgentFile("---\ntools:\n-\n---\nx")).toMatchObject({ error: expect.stringContaining("YAML block list") });
  expect(parseAgentFile("---\ntools:\n  - name: read\n---\nx")).toMatchObject({ error: expect.stringContaining('YAML block list ("- name: read")') });
  expect(parseAgentFile("---\ndescription: >\n  folded text\n---\nx")).toEqual({ error: 'frontmatter line is not `key: value` ("folded text")' });
  const long = parseAgentFile(`---\ntools:\n  - ${"x".repeat(200)}\n---\nx`);
  expect("error" in long && long.error.length).toBeLessThan(140);
});

test("parseAgentFile: blank lines, `#` comments, a colon inside a value and CRLF line ends stay valid `key: value` frontmatter", () => {
  expect(parseAgentFile("---\n# the explorer\n\ndescription: note: colons ok\ntools: read\n---\nx"))
    .toEqual({ description: "note: colons ok", model: undefined, mode: undefined, tools: ["read"], body: "x" });
  expect(parseAgentFile("---\r\ndescription: crlf\r\nmode: plan\r\ntools: read, grep\r\n---\r\nbody\r\n"))
    .toMatchObject({ description: "crlf", mode: "plan", tools: ["read", "grep"], body: "body" });
  expect(parseAgentFile("---\ndescription: d\n---   \nbody")).toMatchObject({ description: "d", body: "body" });
});

test("parseAgentFile: a PRESENT `tools:` with nothing in it — bare, `[]`, `[ ]`, `''`, `\"\"` — is `{ error }`; an ABSENT key means every tool (MUTATION TARGET: drop the emptiness check → ['*'])", () => {
  for (const v of ["tools:", "tools: ", "tools: []", "tools: [ ]", "tools: ''", 'tools: ""']) {
    expect([v, parseAgentFile(`---\ndescription: d\n${v}\n---\nx`)]).toEqual([v, { error: EMPTY_TOOLS }]);
  }
  expect(parseAgentFile("---\ndescription: d\n---\nx")).toMatchObject({ tools: ["*"] });
});

test("parseAgentFile: keys outside description/model/mode/tools are reported in `unknown` (file order) and the file still parses; a known-only file carries NO `unknown` field", () => {
  expect(parseAgentFile("---\nmaxTurns: 5\ntemperature: 0.3\ntools: read\n---\nx"))
    .toEqual({ description: undefined, model: undefined, mode: undefined, tools: ["read"], body: "x", unknown: ["maxTurns", "temperature"] });
  expect(Object.keys(parseAgentFile("---\ndescription: d\nmodel: m\nmode: act\ntools: read\n---\nx") as object)).not.toContain("unknown");
});

// ---------- discovery ----------

test("discovery: user (<home>/agents) + project (.rovecode/agents) merge sorted by name with their scope + path; a project file SHADOWS a same-named user file", () => {
  const u = user("scout.md", "---\ndescription: user scout\n---\nuser body");
  user("zeta.md", "---\ndescription: Z\ntools: read\n---\nz");
  const p = project("scout.md", "---\ndescription: project scout\nmodel: mock/fast\nmode: plan\ntools: read, grep\n---\nproject body");
  const { agents, warnings } = discoverAgents(cwd, { home });
  expect(warnings).toEqual([]);
  expect(agents.map((a) => [a.name, a.scope])).toEqual([["scout", "project"], ["zeta", "user"]]);
  const scout = agents[0]!;
  // MUTATION TARGET: scan the project dir FIRST (user last wins) → the user scout would survive
  expect(scout).toEqual({ name: "scout", description: "project scout", model: "mock/fast", mode: "plan", tools: ["read", "grep"], body: "project body", path: p, scope: "project" });
  expect(scout.path).not.toBe(u);
  expect(agents[1]).toMatchObject({ name: "zeta", tools: ["read"], scope: "user" });
  expect(agentRows({ agents, warnings })).toEqual([{ name: "scout", description: "project scout" }, { name: "zeta", description: "Z" }]);
});

test("discovery: the user scope defaults to ROVECODE_HOME (providers/auth.ts rovecodeHome)", () => {
  process.env.ROVECODE_HOME = home;
  user("fromhome.md", "body");
  expect(discoverAgents(cwd).agents.map((a) => [a.name, a.scope])).toEqual([["fromhome", "user"]]);
});

test("discovery: missing dirs are silent; non-.md files and subdirectories are ignored; cwd/.rovecode IS the home → scanned once; project:false skips the project dir", () => {
  expect(discoverAgents(cwd, { home })).toEqual({ agents: [], warnings: [] });
  project("notes.txt", "not an agent");
  project(join("nested", "deep.md"), "nested");
  expect(discoverAgents(cwd, { home })).toEqual({ agents: [], warnings: [] });
  project("solo.md", "body");
  const same = discoverAgents(cwd, { home: join(cwd, ".rovecode") });
  expect(same.agents.map((a) => [a.name, a.scope])).toEqual([["solo", "project"]]);
  expect(same.warnings).toEqual([]);
  user("mine.md", "body");
  expect(discoverAgents(cwd, { home, project: false }).agents.map((a) => a.name)).toEqual(["mine"]);
});

test("discovery: invalid files are SKIPPED with one warning each, never a throw — bad frontmatter, bad name, `main`, and the four LANE ids (the lane keeps the name, the file is refused with the reason); the valid siblings still load", () => {
  const bad = project("broken.md", "---\nmode: turbo\n---\nx");
  const spaced = project("bad name.md", "x");
  const main = project("main.md", "---\ndescription: shadow the built-in\n---\nx");
  const codex = project("codex.md", "x");
  project("good.md", "---\ndescription: ok\n---\nx");
  const { agents, warnings } = discoverAgents(cwd, { home });
  // MUTATION TARGET: keep the file despite the error / drop the reserved check → an extra agent lands and a warning is missing
  expect(agents.map((a) => a.name)).toEqual(["good"]);
  expect(warnings).toEqual([
    `${spaced}: skipped — agent name "bad name" must match [a-z0-9_-]+`,
    `${bad}: skipped — mode must be "plan" or "act" (got "turbo")`,
    `${codex}: skipped — "codex" is a reserved agent name (the codex external lane keeps it; \`task start codex\` runs the lane, never this file)`,
    `${main}: skipped — "main" is a reserved agent name`,
  ]);
  expect([...DEFAULT_RESERVED_AGENT_NAMES]).toEqual(["main", "claude", "codex", "opencode", "agy"]);
});

test("discovery: a block-list file and an empty-`tools:` file are SKIPPED (one warning each, never `*`); a `tool:` typo LOADS with tools `*` and a `loaded — ignored unknown frontmatter keys` warning", () => {
  const block = project("blocklist.md", "---\ndescription: block list\ntools:\n  - read\n---\nx");
  const empty = project("empty-tools.md", "---\ntools: []\n---\nx");
  project("good.md", "---\ndescription: ok\ntools: read\n---\nx");
  const typo = project("typo.md", "---\ndescription: typo\ntool: read\nmaxturns: 3\n---\nx");
  const { agents, warnings } = discoverAgents(cwd, { home });
  expect(agents.map((a) => [a.name, a.tools])).toEqual([["good", ["read"]], ["typo", ["*"]]]);
  expect(warnings).toEqual([
    `${block}: skipped — ${BLOCK_LIST}`,
    `${empty}: skipped — ${EMPTY_TOOLS}`,
    `${typo}: loaded — ignored unknown frontmatter keys "tool", "maxturns" (known: description, model, mode, tools)`,
  ]);
  const one = project("one.md", "---\ndescription: one\nmodle: x\n---\nx");
  expect(discoverAgents(cwd, { home }).warnings).toContain(`${one}: loaded — ignored unknown frontmatter key "modle" (known: description, model, mode, tools)`);
});

test("discovery: a `model:` the runtime cannot honour is refused AT DISCOVERY with the file named — modelProblemFor(configured): another provider's prefix is refused, the same provider / a bare id / an unknown model id pass, nothing is refused when no provider is configured", () => {
  const check = modelProblemFor("anthropic");
  expect(check("claude-opus-5")).toBeUndefined();                                   // bare id: the run's provider
  expect(check("anthropic/claude-opus-5")).toBeUndefined();                          // the same provider
  expect(check("anthropic/some-model-nobody-heard-of")).toBeUndefined();             // an unknown id is advisory, not refused
  expect(check("openai/gpt-4o-mini")).toBe('model "openai/gpt-4o-mini" names provider "openai" but this session streams over "anthropic" — a child cannot switch providers; write the bare model id, or "anthropic/<model>"');
  expect(modelProblemFor(null)("openai/gpt-4o-mini")).toBeUndefined();               // no provider configured: nothing to contradict
  const other = project("other.md", "---\ndescription: elsewhere\nmodel: openai/gpt-4o-mini\n---\nx");
  project("same.md", "---\nmodel: anthropic/claude-opus-5\n---\nx");
  project("bare.md", "---\nmodel: claude-haiku\n---\nx");
  const { agents, warnings } = discoverAgents(cwd, { home, validateModel: check });
  // MUTATION TARGET: drop the validateModel call → `other` loads and fails inside a child at run time
  expect(agents.map((a) => a.name)).toEqual(["bare", "same"]);
  expect(warnings).toEqual([`${other}: skipped — ${check("openai/gpt-4o-mini")}`]);
  expect(discoverAgents(cwd, { home }).agents.map((a) => a.name)).toEqual(["bare", "other", "same"]); // without a validator nothing is judged
});

test("discovery: the description is bounded (≤ 200 chars) and defaults to `custom agent (<file>)`; names are lowercased; optional fields are ABSENT, not undefined", () => {
  project("Loud.md", `---\ndescription: ${"d".repeat(400)}\n---\nx`);
  project("quiet.md", "x");
  const { agents } = discoverAgents(cwd, { home });
  expect(agents.map((a) => a.name)).toEqual(["loud", "quiet"]);
  expect(agents[0]!.description.length).toBe(200);
  expect(agents[1]!.description).toBe("custom agent (quiet.md)");
  const a: CustomAgent = agents[1]!;
  expect(Object.keys(a).sort()).toEqual(["body", "description", "name", "path", "scope", "tools"]);
});

// ---------- the child registry filter ----------

const tool = (name: string): Tool => ({ schema: { name, description: name, args: { type: "object", properties: {} } }, kind: "read", async execute() { return { ok: true, output: "" }; } });
const TABLE: Tool[] = ["read", "edit", "write", "bash", "glob", "grep", "ls"].map(tool);
const names = (ts: Tool[]): string[] => ts.map((t) => t.schema.name);
const PARENT = new Set(["read", "edit", "write", "bash", "glob", "grep", "ls", "web_fetch", "memory_edit", "task"]);

test("restrictTools: \"*\" keeps the whole child table (∩ parent); a list keeps exactly the named tools, in table order; an empty list keeps nothing", () => {
  expect(names(restrictTools(TABLE, ["*"], PARENT))).toEqual(names(TABLE));
  // MUTATION TARGET (allow-list not applied): drop the `all || wanted.has` test → every table tool survives
  expect(names(restrictTools(TABLE, ["grep", "read", "glob"], PARENT))).toEqual(["read", "glob", "grep"]);
  expect(names(restrictTools(TABLE, [], PARENT))).toEqual([]);
});

test("restrictTools: a definition can NEVER widen the child — names outside the child table are dropped (even ones the parent has, e.g. web_fetch), and a table tool the PARENT lacks is dropped too", () => {
  expect(names(restrictTools(TABLE, ["read", "web_fetch", "memory_edit", "task", "mcp_call"], PARENT))).toEqual(["read"]);
  // MUTATION TARGET (widening clamp): drop the `parentNames.has` test → bash survives with a parent that never had it
  const sparse = new Set(["read", "grep"]);
  expect(names(restrictTools(TABLE, ["read", "bash", "grep"], sparse))).toEqual(["read", "grep"]);
  expect(names(restrictTools(TABLE, ["*"], sparse))).toEqual(["read", "grep"]);
});

test("restrictTools is pure: the table and the allow-list are untouched", () => {
  const allow = ["read", "bash"];
  const before = names(TABLE);
  restrictTools(TABLE, allow, PARENT);
  expect(names(TABLE)).toEqual(before);
  expect(allow).toEqual(["read", "bash"]);
});
