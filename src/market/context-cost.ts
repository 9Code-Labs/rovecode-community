/** What installing this item costs you in context, said before the yes.
 *
 *  THE NUMBER IS TWO NUMBERS, and collapsing them would be the whole feature's undoing. rovecode's skills
 *  are progressive disclosure: `buildSkillsIndex` puts one line per skill in the system prompt — the name,
 *  the version and the clipped description — and the SKILL.md body enters context only when the model calls
 *  `skill_view`. Measured across the 19 skills that ship: the index line averages 79 tokens, the body
 *  averages 2,288. A single "costs ~2.3k tokens per turn" would be 29× the truth for a skill nobody opens,
 *  and a reader who checked once would never trust the line again.
 *
 *  So: `perTurn` is what every request carries, `whenUsed` is what arrives if the model opens it.
 *
 *  WHAT CANNOT BE KNOWN is said instead of guessed:
 *    - an MCP server publishes its tool schemas after it connects. Before that there is no number, and
 *      inventing one would spend this line's credibility on the day it shipped.
 *    - a plugin's entry module contributes tools whose schemas we would have to LOAD ITS CODE to read,
 *      which is exactly what a plan must not do. Its skills and commands directories are files, so those
 *      are measured.
 *
 *  THE ESTIMATE IS SCALED, NOT CAVEATED. `countTokens` is gpt-tokenizer's o200k_base and Anthropic's
 *  tokenizer is not public, so for a Claude model the raw count is simply wrong — measured against
 *  Anthropic's own count_tokens endpoint over all 19 skill bodies that ship, it reads 1.41×–1.79× low
 *  (mean 1.59×). Rather than describe that in prose, the numbers are multiplied by `tokenScaleFor`, which
 *  holds a measured factor per model generation. An earlier draft of this file said "reads roughly a third
 *  low on Anthropic models"; that was already wrong for Claude 4.5, where the factor is 1.21×, and a
 *  sentence like it is wrong again every time a model ships.
 *
 *  When no model is named the numbers are left unscaled and the line says so. When the provider's own
 *  tokenizer IS o200k — OpenAI — there is nothing to scale and the line says that instead. A model nobody
 *  has measured is never given a neighbour's factor.
 */

import { tokenScaleFor, type TokenScale } from "../core/token-scale.ts";
import { countTokens } from "../core/usage.ts";
import { INDEX_PROMPT_LIMIT } from "../skills/tools.ts";
import type { MarketItem } from "./types.ts";

export interface ContextCost {
  /** tokens added to EVERY request while this is installed */
  perTurn: number;
  /** tokens added only when the model opens it; absent when there is no such body */
  whenUsed?: number;
  /** the tokenizer the numbers came from — named because it is not the model's */
  tokenizer: "o200k_base";
  /** a part of the cost that cannot be known before installing, and why */
  unknown?: string;
  /** installing this would push the skill count past the index limit; see `INDEX_PROMPT_LIMIT` */
  overIndexLimit?: boolean;
  /** how wrong the estimate is for the model that will carry it, when a measurement exists for it */
  scale?: TokenScale;
}

export interface ContextCostOptions {
  /** how many skills are already installed, so the index-limit warning can be right */
  installedSkills?: number;
  /** the model that will actually carry this, so the estimate can be scaled by a MEASURED factor rather
   *  than described with a hand-written one. Omit it and the line says the number is unscaled. */
  model?: { provider: string; model: string };
}

/** The system-prompt line `buildSkillsIndex` renders, rebuilt from catalog fields so the count describes
 *  what would actually be in the prompt rather than an approximation of it (skills/tools.ts
 *  renderIndexLine). The description is already clipped to 60 characters by the skill reader. */
const indexLine = (item: MarketItem): string =>
  `- ${item.id}${item.version ? ` (v${item.version})` : ""}: ${item.description}`;

export function contextCostOf(item: MarketItem, opts: ContextCostOptions = {}): ContextCost | undefined {
  const install = item.install;

  if (install.kind === "mcp") {
    // Deliberately no numbers. A server's tools are whatever it reports on connect.
    return { perTurn: 0, tokenizer: "o200k_base",
             unknown: "an MCP server's tools are only known once it connects, so its context cost cannot be measured before you install it" };
  }

  if (install.kind === "skill") {
    const body = item.docs?.body;
    const cost: ContextCost = { perTurn: countTokens(indexLine(item)), tokenizer: "o200k_base" };
    if (opts.model !== undefined) cost.scale = tokenScaleFor(opts.model);
    if (body !== undefined) cost.whenUsed = countTokens(body);
    else cost.unknown = "the SKILL.md is not carried in the catalog, so only the index line can be measured here";
    const installed = opts.installedSkills;
    if (installed !== undefined && installed + 1 > INDEX_PROMPT_LIMIT) cost.overIndexLimit = true;
    return cost;
  }

  // A plugin, and the answer is nothing measurable — for two separate reasons, both worth stating plainly
  // rather than papering over with a number:
  //   its entry module registers tools whose schemas need the code LOADED to read, which a plan must not do;
  //   its commands and skills are files inside the repository, and the catalog carries the plugin's README,
  //   not those files — measuring them would mean cloning during a preview.
  return { perTurn: 0, tokenizer: "o200k_base",
           unknown: "a plugin's context cost cannot be measured from the catalog: its tools need the code loaded to read, and its commands and skills are files that are only fetched when you install it" };
}

const n = (t: number): string => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));

/** The plan's line(s). Returns [] when there is nothing worth saying. */
export function contextCostLines(c: ContextCost | undefined): string[] {
  if (c === undefined) return [];
  const lines: string[] = [];

  if (c.perTurn > 0 || c.whenUsed !== undefined) {
    // When a measurement exists for the model in play, the numbers are SCALED BY IT rather than described
    // with a hand-written caveat. "Reads roughly a third low on Anthropic models" was wrong the moment
    // token-scale.ts had two Anthropic generations in it: 1.59x on Claude 5 and 1.21x on 4.5. A sentence
    // that has to be rewritten every time a model ships is a sentence that will be wrong between ships.
    const k = c.scale?.measured === true ? c.scale.scale : 1;
    const turn = `~${n(Math.round(c.perTurn * k))} tokens every turn`;
    const used = c.whenUsed !== undefined ? `, ~${n(Math.round(c.whenUsed * k))} more when the model opens it` : "";
    lines.push(`${turn}${used}`);
    if (c.scale === undefined) lines.push(`counted with o200k_base, which is not every model's tokenizer — unscaled here because no model was named`);
    else if (!c.scale.measured) lines.push(`counted with o200k_base — ${c.scale.note}`);
    else if (k === 1) lines.push(`counted with o200k_base — ${c.scale.note}`);
    else lines.push(`o200k_base scaled ${k}× for this model — ${c.scale.note}`);
  }
  if (c.overIndexLimit) {
    lines.push(`past ${INDEX_PROMPT_LIMIT} skills the index leaves the prompt entirely and the model lists skills with a tool instead — this changes the cost of every skill you have, not just this one`);
  }
  if (c.unknown !== undefined) lines.push(c.unknown);
  return lines;
}
