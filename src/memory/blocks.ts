/** Bounded markdown memory blocks (hermes pattern): MEMORY.md + USER.md with hard char caps.
 *  The snapshot is frozen at session start (constructor) so the system prompt stays
 *  cache-stable; tools mutate live state + disk only. A threat-scan neutralizes injection
 *  lines in the rendered view — raw text on disk is never rewritten by the scan. */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BlockName = "memory" | "user";

export interface BlockCaps { memory: number; user: number }

export const defaultCaps: BlockCaps = { memory: 2_200, user: 1_375 };

export interface BlockEditResult {
  ok: boolean;
  reason?: string;
  /** present on cap failures: current chars / cap */
  current?: number;
  limit?: number;
}

const THREAT = /(?:ignore previous|disregard above|system prompt)/i;

function scan(text: string): string {
  return text.split("\n").map((l) => (THREAT.test(l) ? "[BLOCKED]" : l)).join("\n");
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

export class BlockStore {
  private live: Record<BlockName, string> = { memory: "", user: "" };
  private readonly frozen: Record<BlockName, string>;

  constructor(
    private readonly dir: string,
    private readonly caps: BlockCaps = defaultCaps,
  ) {
    mkdirSync(dir, { recursive: true });
    this.live.memory = this.read("MEMORY.md");
    this.live.user = this.read("USER.md");
    // snapshot is the threat-scanned view of what session start loaded
    this.frozen = { memory: scan(this.live.memory), user: scan(this.live.user) };
  }

  private read(name: string): string {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  private file(block: BlockName): string {
    return join(this.dir, block === "memory" ? "MEMORY.md" : "USER.md");
  }

  add(block: BlockName, text: string): BlockEditResult {
    const t = text.trim();
    if (!t) return { ok: false, reason: "empty text" };
    const next = this.live[block] ? this.live[block] + "\n" + t : t;
    return this.commit(block, next);
  }

  replace(block: BlockName, oldText: string, newText: string): BlockEditResult {
    const found = this.locate(block, oldText);
    if (!found.ok) return found;
    const t = newText.trim();
    const next = t ? this.live[block].replace(oldText, t) : this.live[block].replace(oldText, "");
    return this.commit(block, next.trim());
  }

  remove(block: BlockName, oldText: string): BlockEditResult {
    const found = this.locate(block, oldText);
    if (!found.ok) return found;
    const next = this.live[block].replace(oldText, "").replace(/\n{3,}/g, "\n\n").trim();
    return this.commit(block, next);
  }

  /** oldText must match exactly once: 0 → not found, >1 → ambiguous. */
  private locate(block: BlockName, oldText: string): BlockEditResult {
    if (!oldText) return { ok: false, reason: "oldText required" };
    const n = occurrences(this.live[block], oldText);
    if (n === 0) return { ok: false, reason: "oldText not found" };
    if (n > 1) return { ok: false, reason: `oldText matches ${n} times; must match exactly once` };
    return { ok: true };
  }

  private commit(block: BlockName, next: string): BlockEditResult {
    const limit = this.caps[block];
    if (next.length > limit) {
      return {
        ok: false, reason: `block would exceed cap (${next.length} > ${limit} chars)`,
        current: this.live[block].length, limit,
      };
    }
    this.live[block] = next;
    writeFileSync(this.file(block), next);
    return { ok: true, current: next.length, limit };
  }

  /** Session-start snapshot (threat-scanned). Tool writes never change it. */
  renderForPrompt(): string {
    const parts: string[] = [];
    if (this.frozen.memory) parts.push(`# Memory\n${this.frozen.memory}`);
    if (this.frozen.user) parts.push(`# User\n${this.frozen.user}`);
    return parts.join("\n\n");
  }

  /** Live (post-snapshot) raw text — for reads/debug, not for the prompt. */
  liveText(block: BlockName): string { return this.live[block]; }

  cap(block: BlockName): number { return this.caps[block]; }
}
