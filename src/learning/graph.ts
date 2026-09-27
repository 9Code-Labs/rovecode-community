/** learning/graph.ts — the "learning made visible" graph (Hermes-inspired, pattern-level).
 *
 *  Nodes are what the agent has LEARNED over time: skills (declared knowledge) and memory
 *  chunks (persisted experience from the MEMORY/USER blocks). Edges connect them:
 *   - "declared": a skill's `related_skills` metadata names another skill — explicit.
 *   - "lexical": a memory chunk and a skill share enough vocabulary — derived, the way
 *     Hermes derives memory→skill links from lexical overlap (agent/learning_graph.py).
 *
 *  The graph is PURELY DERIVED: nothing here writes to disk, mutates a store, or feeds a
 *  prompt. Consumers: the SDK (`rc.learn.graph()`), and later the Mission Control dashboard.
 */

import { createHash } from "node:crypto";
import type { BlockStore } from "../memory/blocks.ts";
import type { Skill, SkillStore } from "../skills/index.ts";

export interface LearningNode {
  id: string;
  kind: "skill" | "memory";
  /** skill name, or the memory block the chunk came from */
  label: string;
  scope: "project" | "global" | "user";
  /** memory chunks only: first line, clipped */
  preview?: string;
}

export interface LearningEdge {
  from: string;
  to: string;
  kind: "declared" | "lexical";
  /** 0..1 — 1.0 for declared edges, the Jaccard overlap for lexical ones */
  weight: number;
}

export interface LearningGraph {
  nodes: LearningNode[];
  edges: LearningEdge[];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "are", "was", "were",
  "bir", "ile", "için", "ve", "bu", "şu", "olan", "gibi", "son", "kadar",
]);

/** lowercase word tokens, length ≥ 3, stopwords out — the shared vocabulary unit */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9ğüşöçıi]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
}

/** memory block text → chunks: bullets and non-trivial lines, clipped for preview */
export function memoryChunks(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l.length >= 12 && !l.startsWith("#"));
}

export const LEXICAL_EDGE_MIN = 0.25;

export function buildLearningGraph(opts: { skillStore?: SkillStore; blocks?: BlockStore }): LearningGraph {
  const nodes: LearningNode[] = [];
  const edges: LearningEdge[] = [];
  const skills: Skill[] = opts.skillStore ? opts.skillStore.scan().skills : [];
  const byName = new Map(skills.map((s) => [s.name, s]));

  for (const s of skills) {
    nodes.push({ id: `skill:${s.name}`, kind: "skill", label: s.name, scope: s.scope === "global" ? "global" : "project" });
  }
  // declared edges — a skill names its relatives (Hermes: "skill links come from declared related_skills")
  for (const s of skills) {
    const rel = s.metadata["related_skills"] ?? s.metadata["related-skills"] ?? "";
    for (const name of rel.split(/[\s,]+/).filter(Boolean)) {
      if (byName.has(name) && name !== s.name) {
        edges.push({ from: `skill:${s.name}`, to: `skill:${name}`, kind: "declared", weight: 1 });
      }
    }
  }

  if (opts.blocks) {
    for (const block of ["memory", "user"] as const) {
      if (opts.blocks.isWithheld(block)) continue;
      const text = opts.blocks.liveText(block);
      const scope = block === "user" ? "user" : "project";
      for (const chunk of memoryChunks(text)) {
        const id = `memory:${block}:${createHash("sha256").update(chunk).digest("hex").slice(0, 8)}`;
        nodes.push({ id, kind: "memory", label: block, scope, preview: chunk.slice(0, 80) });
        // lexical edges — memory ↔ skill vocabulary overlap (Hermes derives these the same way)
        const ct = tokens(chunk);
        for (const s of skills) {
          const w = jaccard(ct, tokens(`${s.name} ${s.fullDescription}`));
          if (w >= LEXICAL_EDGE_MIN) edges.push({ from: id, to: `skill:${s.name}`, kind: "lexical", weight: Math.round(w * 100) / 100 });
        }
      }
    }
  }
  return { nodes, edges };
}
