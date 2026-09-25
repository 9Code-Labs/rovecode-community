/** learning/draft.ts — skills drafted FROM experience (Hermes-inspired, pattern-level).
 *
 *  Hermes' pitch: "it creates skills from experience, nudges itself to persist knowledge."
 *  This module is the deterministic core of that idea for rovecode:
 *
 *   - draftSkillFromSession reads a finished session's transcript and condenses it into a
 *     SKILL.md PROPOSAL: the goal, the tool sequence that worked, the files it touched,
 *     the commands it ran. No LLM call — evidence extraction only; a model (or the user)
 *     can refine the prose afterwards.
 *   - learningNudges scans recent sessions for REPEATED work that no existing skill covers
 *     — the "you've done this three times, write it down" nudge.
 *   - saveSkillDraft writes a draft into the PROJECT skills dir. Nothing is ever installed
 *     implicitly: like plugins, learned knowledge is proposed and reviewed, not smuggled in.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, listSessions } from "../core/session.ts";
import type { Message } from "../core/types.ts";
import { skillsDir, type SkillStore } from "../skills/index.ts";
import { tokens } from "./graph.ts";

export interface SkillDraft {
  name: string;
  description: string;
  /** full SKILL.md content, frontmatter included */
  content: string;
  /** the transcript facts the draft stands on — surfaced so the reviewer sees WHY */
  evidence: { goal: string; toolCalls: number; files: string[]; commands: string[]; sessions: string[] };
}

export interface LearningNudge {
  kind: "repeat" | "novel";
  /** one line for a human or a follow-up prompt */
  suggestion: string;
  sessions: string[];
  toolSignature: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function slugify(text: string): string {
  const slug = text.toLowerCase()
    .replace(/[^a-z0-9ğüşöçıi]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return SLUG_RE.test(slug) ? slug : `learned-${Date.now().toString(36)}`;
}

interface SessionFacts {
  goal: string;
  toolSeq: string[];
  files: string[];
  commands: string[];
  toolCalls: number;
  done: boolean;
}

/** the transcript reduced to what a skill draft can stand on */
export function sessionFacts(messages: Message[]): SessionFacts {
  let goal = "";
  const toolSeq: string[] = [];
  const files: string[] = [];
  const commands: string[] = [];
  let toolCalls = 0;
  let done = false;
  for (const m of messages) {
    if (m.role === "user" && goal === "") {
      const t = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join(" ").trim();
      if (t) goal = t.slice(0, 300);
    }
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.kind !== "tool_call") continue;
      toolCalls++;
      toolSeq.push(p.tool);
      const args = (p.args ?? {}) as Record<string, unknown>;
      const path = typeof args.path === "string" ? args.path : typeof args.file === "string" ? args.file : null;
      if (path && (p.tool === "write" || p.tool === "edit") && !files.includes(path)) files.push(path);
      const cmd = typeof args.command === "string" ? args.command.trim().split("\n")[0] ?? "" : "";
      if (p.tool === "bash" && cmd && !commands.includes(cmd)) commands.push(cmd.slice(0, 200));
    }
  }
  done = toolCalls > 0;
  return { goal, toolSeq, files, commands, toolCalls, done };
}

/** the ordered distinct tools of a session — the "signature" a repetition shares */
export function toolSignature(f: SessionFacts): string[] {
  return [...new Set(f.toolSeq)].slice(0, 5);
}

/** Condense one session into a SKILL.md proposal; null when there is too little to learn from. */
export function draftSkillFromSession(store: SessionStore): SkillDraft | null {
  const f = sessionFacts(store.messages());
  if (f.toolCalls < 3 || f.goal === "") return null;
  const name = slugify(f.goal);
  const sig = toolSignature(f);
  const description = f.goal.replace(/\s+/g, " ").slice(0, 120);
  const lines: string[] = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "metadata:",
    "  learned_from: session",
    "  learned_at: " + new Date().toISOString().slice(0, 10),
    "---",
    "",
    `# ${name}`,
    "",
    "## When to use",
    "",
    f.goal,
    "",
    "## What worked",
    "",
    ...sig.map((t) => `- \`${t}\``),
  ];
  if (f.files.length > 0) lines.push("", "## Files touched", "", ...f.files.slice(0, 10).map((p) => `- \`${p}\``));
  if (f.commands.length > 0) lines.push("", "## Commands", "", ...f.commands.slice(0, 10).map((c) => `- \`${c}\``));
  lines.push("", "> Drafted from session experience — review before relying on it.", "");
  return {
    name,
    description,
    content: lines.join("\n"),
    evidence: { goal: f.goal, toolCalls: f.toolCalls, files: f.files, commands: f.commands, sessions: [store.id] },
  };
}

/**
 * Scan recent sessions for work worth persisting:
 *  - "repeat": the same tool signature in ≥ `minRepeat` sessions whose goal vocabulary no
 *    existing skill covers → you keep doing this by hand.
 *  - "novel": one substantial session (≥ 8 tool calls) with no covering skill → worth a draft.
 */
export function learningNudges(opts: {
  sessionsRoot: string;
  skillStore?: SkillStore;
  last?: number;
  minRepeat?: number;
}): LearningNudge[] {
  const { sessionsRoot } = opts;
  const last = opts.last ?? 10;
  const minRepeat = opts.minRepeat ?? 2;
  let dirs: string[] = [];
  try { dirs = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const ids = listSessions(sessionsRoot).map((s) => s.id).filter((id) => dirs.includes(id)).slice(0, last);
  const skills = opts.skillStore ? opts.skillStore.scan().skills : [];
  const coveredBySkill = (goal: string): boolean => {
    const g = tokens(goal);
    if (g.size === 0) return true;
    return skills.some((s) => {
      const st = tokens(`${s.name} ${s.fullDescription}`);
      let hit = 0;
      for (const t of g) if (st.has(t)) hit++;
      return hit / g.size >= 0.5;
    });
  };

  const nudges: LearningNudge[] = [];
  const bySig = new Map<string, { sessions: string[]; goal: string }>();
  for (const id of ids) {
    const store = new SessionStore(sessionsRoot, id);
    const f = sessionFacts(store.messages());
    const sig = toolSignature(f);
    if (sig.length < 2 || f.goal === "" || coveredBySkill(f.goal)) continue;
    const key = sig.join(",");
    const hit = bySig.get(key);
    if (hit) hit.sessions.push(id);
    else bySig.set(key, { sessions: [id], goal: f.goal });
    if (f.toolCalls >= 8 && f.done) {
      nudges.push({
        kind: "novel",
        suggestion: `Session ${id} did substantial uncovered work (${f.toolCalls} tool calls: ${sig.join(", ")}) — draft a skill from it?`,
        sessions: [id],
        toolSignature: sig,
      });
    }
  }
  for (const [key, v] of bySig) {
    if (v.sessions.length >= minRepeat) {
      nudges.push({
        kind: "repeat",
        suggestion: `You repeated the same workflow in ${v.sessions.length} sessions (${key.split(",").join(" → ")}) — persist it as a skill.`,
        sessions: v.sessions,
        toolSignature: key.split(","),
      });
    }
  }
  return nudges;
}

/**
 * Write a draft into `<cwd>/.rovecode/skills/<name>/SKILL.md` — PROJECT scope only:
 * a draft earned in one repo must not leak into every project (global scope stays manual).
 * Refuses to overwrite unless `overwrite: true`.
 */
export function saveSkillDraft(cwd: string, draft: SkillDraft, opts: { overwrite?: boolean } = {}): { ok: true; path: string } | { ok: false; reason: string } {
  if (!SLUG_RE.test(draft.name)) return { ok: false, reason: `invalid skill name '${draft.name}'` };
  const dir = join(skillsDir(cwd, "project"), draft.name);
  const path = join(dir, "SKILL.md");
  if (existsSync(path) && opts.overwrite !== true) return { ok: false, reason: `skill '${draft.name}' already exists at ${path} (pass overwrite: true)` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, draft.content);
  return { ok: true, path };
}
