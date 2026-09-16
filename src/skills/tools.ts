/** Skill tools (hermes pattern): `skill_view` returns a body and bumps the
 *  usage sidecar; `skills_list` returns the index. Above 50 skills the index
 *  is too big for the system prompt, so `skills_list` is the only access path
 *  and `buildSkillsIndex` returns "" (prompt_builder.py:2083 reject rule). */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { SkillStore, skillLifecycle, type Skill, type SkillUsage } from "./index.ts";

export const INDEX_PROMPT_LIMIT = 50; // hermes: >50 skills → skills_list tool only

function renderIndexLine(s: Skill, usage: SkillUsage | undefined, now: number): string {
  const state = skillLifecycle(s, usage, now);
  return `- ${s.name}${s.version ? ` (v${s.version})` : ""}: ${s.description}${state === "stale" ? " [stale]" : ""}`;
}

/** System-prompt index. Empty string when the catalogue outgrows the prompt. */
export function buildSkillsIndex(store: SkillStore, now: number = Date.now()): string {
  const skills = store.list();
  if (skills.length === 0 || skills.length > INDEX_PROMPT_LIMIT) return "";
  return skills.map((s) => renderIndexLine(s, store.usage(s.name), now)).join("\n");
}

export function createSkillTools(store: SkillStore): Tool[] {
  const skillView: Tool = {
    schema: {
      name: "skill_view",
      description:
        "Read one skill's full instructions. Use when a skill in the index matches the task.",
      args: {
        type: "object",
        properties: { name: { type: "string", description: "skill name from the index" } },
        required: ["name"],
      },
    },
    kind: "read",
    sequential: true, // sidecar write
    execute(args): Promise<ToolOutput> {
      const raw = args as { name?: unknown };
      const name = typeof raw.name === "string" ? raw.name : "";
      const skill = store.get(name);
      if (!skill) return Promise.resolve({ ok: false, output: `no skill named '${name}'` });
      const usage = store.bumpUsage(skill);
      // the FULL description, not the index's clipped line: the model opened this skill to read it, so
      // the sentence saying when to use it belongs here in one piece
      const header = `# ${skill.name} (v${skill.version})\n\n${skill.fullDescription}\n\n`;
      return Promise.resolve({ ok: true, output: header + skill.body, data: usage });
    },
  };

  const skillsList: Tool = {
    schema: {
      name: "skills_list",
      description:
        "List available skills (name, version, description, staleness). Use to discover skills when the system prompt has no skill index.",
      args: { type: "object", properties: {} },
    },
    kind: "read",
    execute(_args: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      store.scan(); // fresh catalogue even when the caller forgot to rescan
      const skills = store.list();
      if (skills.length === 0) return Promise.resolve({ ok: true, output: "no skills installed" });
      const now = Date.now();
      const lines = skills.map((s) => renderIndexLine(s, store.usage(s.name), now));
      return Promise.resolve({ ok: true, output: lines.join("\n"), data: { count: skills.length } });
    },
  };

  return [skillView, skillsList];
}
