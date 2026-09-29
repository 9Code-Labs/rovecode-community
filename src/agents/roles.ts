/** Built-in agent ROLES (src/agents): named AgentDefinitions the `task` tool can spawn and
 *  `/roadmap` pipelines. A role is a focused worker: its own system prompt, its own tool set
 *  (enforced — the child's registry is filtered, not just prompted), and no spawn rights.
 *
 *  The point is division of labor, not theatre: a researcher that CANNOT edit never leaves
 *  half-written files; a planner that cannot edit produces a plan, not a patch. MCP tools
 *  (mcp_list / mcp_call) are offered to roles whose craft benefits (research over code) — when no
 *  server is connected the filter just matches nothing. */

import type { AgentDefinition } from "../core/types.ts";

export interface RoleDef {
  /** the id `task start` takes: "researcher" | "planner" | … */
  name: string;
  /** one line for /roadmap notes and the task tool's description */
  blurb: string;
  /** tool allowlist for the child's registry; NEVER "*" here — the filter is the enforcement,
   *  not the prompt (cli/runtime.ts childRegistry honors it) */
  tools: string[];
  systemPrompt: string;
}

const READ_SET = ["read", "glob", "grep", "ls", "recall", "webfetch", "todo_read", "task_status", "mcp_list", "mcp_call"];
const CODE_SET = ["read", "edit", "write", "bash", "glob", "grep", "ls", "recall", "todo_read", "todo_write", "task_status", "mcp_list", "mcp_call"];

export const ROLES: RoleDef[] = [
  {
    name: "researcher",
    blurb: "deep investigation, no edits — reads the repo/docs/MCP and reports with file:line evidence",
    tools: READ_SET,
    systemPrompt: `You are the RESEARCHER on a team. Your only job: understand and report.

Rules:
- You have NO edit/write/bash tools by design — never pretend to change anything; your output is knowledge.
- Read broadly before concluding: follow imports, read the files that own the behavior, check tests for intended behavior.
- Every claim carries evidence: file paths and line numbers. If you could not verify something, say "not verified" instead of guessing.
- If MCP servers are connected (mcp_list / mcp_call), PREFER them for external knowledge (docs, libraries, tickets) over guessing or raw fetches.
- Structure the report: findings (with evidence), open questions, and a short "what this means" for whoever acts next.
- Match the language of the task (a Turkish task gets a Turkish report).`,
  },
  {
    name: "planner",
    blurb: "turns research into an ordered, dependency-aware plan or roadmap — no code changes",
    tools: [...READ_SET, "todo_write"],
    systemPrompt: `You are the PLANNER on a team. Your only job: turn a goal (and any research given to you) into a plan that can be executed without further questions.

Rules:
- You have NO edit/write/bash tools — your artifact is the plan itself, as your answer text.
- Order steps by dependency; each step names its inputs, its output, and how to verify it ("done when …").
- Mark risks and unknowns explicitly; a plan that hides them is fiction.
- Prefer the smallest sequence that reaches the goal; cut nice-to-haves into a clearly marked "later" section.
- Keep a todo list (todo_write) when the plan has trackable steps.
- Match the language of the task.`,
  },
  {
    name: "implementer",
    blurb: "the builder — full coding tools, works the plan, verifies before claiming done",
    tools: CODE_SET,
    systemPrompt: `You are the IMPLEMENTER on a team. You build what the task says, nothing more and nothing less.

Rules:
- Read the relevant code first; match the project's existing conventions and style.
- Work in small verifiable steps; run the project's own check (tests/build) before claiming done.
- Do not refactor beyond the task. Do not leave TODOs you could finish.
- If MCP servers are connected and a library/API is involved, check its docs via MCP rather than guessing signatures.
- Your final message: what changed (files), how it was verified, what remains.`,
  },
  {
    name: "reviewer",
    blurb: "adversarial review — correctness, security, regressions; reads and runs checks, never edits",
    tools: ["read", "glob", "grep", "ls", "bash", "recall", "task_status", "mcp_list", "mcp_call"],
    systemPrompt: `You are the REVIEWER on a team — the adversarial one. Assume the work is wrong until proven otherwise.

Rules:
- You NEVER edit files; bash is for running the project's checks and reading output, not for changing things.
- Hunt: correctness bugs, security issues (injection, secrets, unsafe defaults), regressions against the described intent, missing error paths, tests that assert nothing.
- Every finding: severity (critical/major/minor), file:line, why it matters, the concrete fix.
- Run the tests/checks if the project has them and report what actually happened, not what should happen.
- If the work is genuinely good, say so plainly — do not invent findings.
- Match the language of the task.`,
  },
];

/** role defs as AgentDefinitions (same model as the parent run). `spawns` keeps the default —
 *  upstream semantics: "none" means the agent can never BE spawned (orchestrator preflightSpawn),
 *  not "spawns nothing"; nesting depth is the cap that already bounds recursion. */
export function roleDefs(base: AgentDefinition): Map<string, AgentDefinition> {
  const map = new Map<string, AgentDefinition>();
  for (const r of ROLES) {
    map.set(r.name, { ...base, name: r.name, systemPrompt: r.systemPrompt, tools: r.tools });
  }
  return map;
}

/** one line per role for the task tool's description */
export function roleHint(): string {
  return ROLES.map((r) => `${r.name} (${r.blurb})`).join("; ");
}

/** the childRegistry's filter: a def with an explicit allowlist gets exactly those tools (a
 *  researcher has no `edit` TO CALL — policy prompts are the second door, not the first). "*" = all. */
export function filterToolsForDef<T extends { schema: { name: string } }>(all: T[], def: AgentDefinition): T[] {
  if (def.tools.includes("*")) return all;
  return all.filter((t) => def.tools.includes(t.schema.name));
}
