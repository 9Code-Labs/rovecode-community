/** ONE effort dial (core/types.ts ThinkingEffort: auto | off | low | medium | high), every wire it can reach.
 *  This module answers, for a model on a protocol, two questions the adapters and the humans both ask:
 *  which request fields carry the level, and — in one sentence — what the model will actually receive.
 *  stream.ts spreads `thinkingPlan(...).fields` into the body; /effort and `rovecode model show` print `says`.
 *
 *  Rules (Berkay, 2026-09-04): `auto` sends NOTHING and leaves the endpoint's own default standing (the
 *  Claude 5 family reasons adaptively on its own; the old default "off" switched that off). `off` is an
 *  explicit disable where the API has one, otherwise nothing. A level maps onto the endpoint's own
 *  vocabulary; where the vocabulary has fewer steps, medium rounds UP (a rovecode "medium" asks for more
 *  than "low"). A model that always reasons, or has no reasoning mode, gets nothing — sending a dial such a
 *  model rejects is a 400, not a downgrade (grok-4, gpt-4-class on OpenAI proper).
 *
 *  Dialects are matched by MODEL ID, provider-agnostic (the same GLM under kaesra, zai or openrouter is one
 *  family) — except OpenRouter, whose unified `reasoning` object wins for every model it fronts, and Groq's
 *  Qwen vocabulary. The catalog's word is stronger than any regex: a model models.dev lists WITHOUT a
 *  reasoning mode (ModelRef.reasoning === false, stamped by cli/runtime.ts buildDef) gets nothing.
 *
 *  Only Anthropic and GLM-5.3 are measured live (stream.ts header, profiles.ts header). The other
 *  vocabularies are the vendors' published API docs as of 2026-09 — docs/thinking.md carries the matrix
 *  and marks each row measured or documented. */

import type { ModelRef, ThinkingEffort } from "../core/types.ts";
import { GLM_53_MODEL_RE, wireProfileFor } from "./profiles.ts";

export type WireProtocol = "openai" | "anthropic";
type Level = "low" | "medium" | "high";
type Setting = "auto" | "off" | Level;

export interface ThinkingPlan {
  /** the dialect that answered (docs/thinking.md row) */
  dialect: string;
  /** spread into the request body */
  fields: Record<string, unknown>;
  /** one sentence for the human: the exact field, or why nothing goes */
  says: string;
}

/** undefined (a bare ModelRef) is auto — the runtime stamps every ref, but adapters must not care */
const setting = (e: ThinkingEffort | undefined): Setting => e ?? "auto";
const NOTHING_AUTO = "nothing — auto: the endpoint's own default stands";

// ------------------------------------------------------------------ Anthropic (Messages API), two shapes

/** Anthropic has TWO request shapes and no model exposes both — see the measured table in stream.ts.
 *  The shape is learned per provider+model from a wrong-shape 400 (stream.ts anthropicPost). */
export type AnthropicThinkingShape = "effort" | "budget";

/** The budget in tokens per level for the older `thinking.enabled` shape. Steps ~x4 apart so the
 *  levels are felt. The endpoint requires ≥1024 and max_tokens strictly greater (anthropicMaxTokens). */
export function thinkingBudget(effort: ThinkingEffort | undefined): number | null {
  switch (effort) {
    case "low": return 2_048;
    case "medium": return 8_192;
    case "high": return 24_576;
    default: return null; // "off", "auto" and unset: no budget
  }
}

/** the request fields that carry the effort, for one shape */
export function anthropicThinking(effort: ThinkingEffort | undefined, shape: AnthropicThinkingShape): Record<string, unknown> {
  if (effort === undefined || effort === "auto") return {};              // unset / auto: leave the model's default alone (Claude 5: adaptive, high)
  if (effort === "off") return { thinking: { type: "disabled" } };       // explicit, deliberate: opus-5 thinks unless told not to
  if (shape === "effort") return { output_config: { effort } };          // low | medium | high (the API also has xhigh/max)
  const budget = thinkingBudget(effort);
  return budget === null ? {} : { thinking: { type: "enabled", budget_tokens: budget } };
}

function anthropicPlan(level: Setting, shape: AnthropicThinkingShape): ThinkingPlan {
  const fields = anthropicThinking(level, shape);
  const says = level === "auto" ? NOTHING_AUTO
    : level === "off" ? 'thinking: { type: "disabled" } — an explicit off; Claude 5 reasons by default'
    : `${JSON.stringify(fields).slice(1, -1).replace(/"(\w+)":/g, "$1: ").replace(/,/g, ", ")} (the ${shape} shape — learned from the endpoint, kept per model)`;
  return { dialect: `anthropic/${shape}`, fields, says };
}

// ------------------------------------------------------------------ OpenAI-compatible dialects

interface Dialect {
  id: string;
  matches(m: ModelRef): boolean;
  /** never called with "auto" — that is answered centrally with nothing */
  plan(level: "off" | Level, m: ModelRef): { fields: Record<string, unknown>; says: string };
}

const q = (s: string): string => JSON.stringify(s);
const nothing = (why: string): { fields: Record<string, unknown>; says: string } => ({ fields: {}, says: `nothing — ${why}` });
const word = (w: string, note = ""): { fields: Record<string, unknown>; says: string } => ({ fields: { reasoning_effort: w }, says: `reasoning_effort: ${q(w)}${note ? ` (${note})` : ""}` });
const onOff = (on: boolean, vendor: string): { fields: Record<string, unknown>; says: string } => ({
  fields: { thinking: { type: on ? "enabled" : "disabled" } },
  says: `thinking: { type: ${q(on ? "enabled" : "disabled")} } (${vendor} has an on/off switch, no levels)`,
});
const id = (re: RegExp) => (m: ModelRef): boolean => re.test(m.model);

const DIALECTS: readonly Dialect[] = [
  // the catalog's word first: models.dev says this model has no reasoning mode — a dial would be rejected or ignored
  { id: "catalog: no reasoning mode", matches: (m) => m.reasoning === false,
    plan: (_l, m) => nothing(`the catalog lists ${m.model} without a reasoning mode, so no dial is sent`) },
  // OpenRouter normalizes every upstream behind one object; its own words (low|medium|high, enabled)
  { id: "openrouter", matches: (m) => m.provider === "openrouter",
    plan: (l) => l === "off"
      ? { fields: { reasoning: { enabled: false } }, says: "reasoning: { enabled: false } (OpenRouter's unified field; a model that always reasons ignores it)" }
      : { fields: { reasoning: { effort: l } }, says: `reasoning: { effort: ${q(l)} } (OpenRouter's unified field, translated per upstream)` } },
  // GLM-5.3: measured (profiles.ts) — low|high|max, medium rounds up to high, cannot be switched off. The
  // words come from the wire profile; ROVECODE_PROFILE=off means "no GLM tuning at all", so the plain
  // OpenAI word goes instead (the A/B the off-switch exists for), and off sends nothing either way.
  { id: "glm-5.3", matches: id(GLM_53_MODEL_RE),
    plan: (l, m) => {
      if (l === "off") return nothing("GLM-5.3 cannot switch thinking off (Z.ai: thinking.type accepts enabled only); the endpoint default is max");
      const profile = wireProfileFor(m);
      if (profile === null) return word(l, "ROVECODE_PROFILE=off: the plain word, not GLM's low | high | max");
      return word(profile.reasoningEffort(l)!, "GLM's words are low | high | max; medium rounds up");
    } },
  // GLM generation 5 below 5.3 (5.3 itself is the profile row above): gen-5 speaks reasoning_effort
  // low | high | max, NOT the 4.x on/off switch. Measured 2026-09-19 against kaesra's
  // dash/glm-5.2-fast-preview: the field is accepted (HTTP 200) and it MOVES the model — one sample
  // of a small math task reasoned 1233 completion tokens at "low" vs 1438 at "max", while the
  // on/off-only mapping sent the SAME body for low, medium and high (the dial did nothing, which is
  // exactly the "effort uygulanamıyor" report). `thinking: {type: "disabled"}` was IGNORED by that
  // endpoint (1216 reasoning tokens with it), so "off" sends the explicit disable as a best effort
  // and says honestly that a gen-5 endpoint may ignore it.
  { id: "glm-5.x", matches: id(/(^|[/:])glm-5(\.\d+)?(?=[-:]|$)/i),
    plan: (l) => l === "off"
      ? { fields: { thinking: { type: "disabled" } }, says: 'thinking: { type: "disabled" } (best effort — GLM gen-5 endpoints may ignore it; measured ignored on kaesra dash)' }
      : word(l === "low" ? "low" : l === "medium" ? "high" : "max", "GLM gen-5 words are low | high | max; medium rounds up") },
  { id: "glm", matches: id(/(^|[/:])glm-(4\.[5-9]|4\.\d{2,})(?=[-:]|$)/i), plan: (l) => onOff(l !== "off", "GLM") },
  { id: "deepseek", matches: id(/deepseek/i),
    plan: (l, m) => /reasoner|r1/i.test(m.model) ? nothing(`${m.model} always thinks — no dial`) : onOff(l !== "off", "DeepSeek") },
  { id: "qwen", matches: id(/(^|[/:])(qwen|qwq)/i),
    plan: (l, m) => {
      if (m.provider === "groq") return l === "off" ? word("none", "Groq's Qwen words are none | default") : word("default", "Groq's Qwen words are none | default");
      if (l === "off") return { fields: { enable_thinking: false }, says: "enable_thinking: false (DashScope / most Qwen hosts; a vLLM host wants chat_template_kwargs instead and ignores this)" };
      const budget = thinkingBudget(l)!;
      return { fields: { enable_thinking: true, thinking_budget: budget }, says: `enable_thinking: true, thinking_budget: ${budget} (DashScope's fields; a host without them ignores both)` };
    } },
  { id: "kimi", matches: id(/kimi|moonshot/i),
    plan: (l, m) => /thinking/i.test(m.model) ? nothing(`${m.model} always thinks — no dial`)
      : /k2[.-]5|k2\.5/i.test(m.model) ? onOff(l !== "off", "Moonshot K2.5") : nothing(`${m.model} has no thinking mode (the -thinking variant does)`) },
  { id: "gemini", matches: id(/gemini/i),
    plan: (l, m) => l !== "off" ? word(l, "Google's OpenAI-compatible layer maps low | medium | high to a thinking budget")
      : /flash/i.test(m.model) ? { fields: { extra_body: { google: { thinking_config: { thinking_budget: 0 } } } }, says: "extra_body.google.thinking_config.thinking_budget: 0 (Flash can switch thinking off; Pro cannot)" }
      : nothing(`${m.model} cannot switch thinking off (Gemini Pro keeps a minimum budget)`) },
  // xAI (docs.x.ai, fetched 2026-09-04): grok-4.3 / 4.5 / 4.6 / 4.20 take reasoning_effort none | low | medium | high;
  // the retired grok-4-0709 / grok-4-fast slugs are served by grok-4.3 since 2026-05-15, so they take the same words
  { id: "grok", matches: id(/grok/i),
    plan: (l, m) => /non-reasoning/i.test(m.model) ? nothing(`${m.model} has no reasoning mode`)
      : /grok-3-mini/i.test(m.model) ? (l === "off" ? nothing("grok-3-mini cannot switch reasoning off") : word(l === "low" ? "low" : "high", "xAI's words for grok-3-mini are low | high; medium rounds up"))
      : l === "off" ? word("none", "xAI's explicit off (grok-4.3 and later; retired grok-4 slugs are served by grok-4.3)") : word(l, "xAI's words are none | low | medium | high") },
  { id: "gpt-oss", matches: id(/gpt-oss/i), plan: (l) => l === "off" ? nothing("gpt-oss cannot switch reasoning off (low is the floor)") : word(l) },
  { id: "openai o-series", matches: id(/(^|[/:])o[134](-|$)/i), plan: (l, m) => l === "off" ? nothing(`${m.model} cannot switch reasoning off`) : word(l) },
  { id: "openai gpt-5", matches: id(/(^|[/:])gpt-5/i),
    plan: (l, m) => l !== "off" ? word(l)
      : /gpt-5\.[1-9]/i.test(m.model) ? word("none", "gpt-5.1 and later: the explicit off") : word("minimal", "gpt-5 has no off; minimal is its floor") },
  { id: "openai gpt-4 class", matches: id(/(^|[/:])(gpt-4|gpt-3\.5|chatgpt)/i), plan: (_l, m) => nothing(`${m.model} has no reasoning mode and OpenAI rejects reasoning_effort for it`) },
  { id: "mistral", matches: id(/magistral|mistral|codestral|ministral|pixtral/i),
    plan: (_l, m) => /magistral/i.test(m.model) ? nothing("Magistral always reasons — no dial") : nothing(`${m.model} has no reasoning mode`) },
  { id: "minimax", matches: id(/minimax/i), plan: (_l, m) => nothing(`${m.model} always reasons — no dial`) },
  // the floor for anything else: the OpenAI word; off sends nothing (no common explicit disable)
  { id: "openai-compatible default", matches: () => true,
    plan: (l) => l === "off" ? nothing("off sends nothing here: no common explicit disable on OpenAI-compatible endpoints; a model without a reasoning mode ignores the word anyway")
      : word(l, "the OpenAI word; a model without a reasoning mode ignores it") },
];

/** the dialect a model on the OpenAI-compatible wire speaks (for docs and the matrix) */
export function dialectFor(model: ModelRef): Dialect["id"] {
  return DIALECTS.find((d) => d.matches(model))!.id;
}

/** what goes on the wire for this model, on this protocol, at its effort — and the sentence that says so */
export function thinkingPlan(model: ModelRef, protocol: WireProtocol, opts: { shape?: AnthropicThinkingShape } = {}): ThinkingPlan {
  const level = setting(model.effort);
  if (protocol === "anthropic") return anthropicPlan(level, opts.shape ?? "effort");
  const d = DIALECTS.find((x) => x.matches(model))!;
  if (level === "auto") return { dialect: d.id, fields: {}, says: NOTHING_AUTO };
  return { dialect: d.id, ...d.plan(level, model) };
}

/** the five rows `rovecode model show` prints: level → what this model receives */
export function thinkingTable(model: ModelRef, protocol: WireProtocol, opts: { shape?: AnthropicThinkingShape } = {}): { level: ThinkingEffort; says: string }[] {
  return (["auto", "off", "low", "medium", "high"] as const).map((level) => ({ level, says: thinkingPlan({ ...model, effort: level }, protocol, opts).says }));
}

/** the one line the /effort note appends: `<provider/model> receives: <says>` */
export function thinkingLine(model: ModelRef, protocol: WireProtocol, opts: { shape?: AnthropicThinkingShape } = {}): string {
  return `${model.provider}/${model.model} receives: ${thinkingPlan(model, protocol, opts).says}`;
}

/** `rovecode model show`: the model, its protocol and dialect, then every level with what it puts on the
 *  wire — the current level marked. `model.effort` is the current level. */
export function thinkingReport(model: ModelRef, protocol: WireProtocol, opts: { shape?: AnthropicThinkingShape; source?: string; catalog?: string } = {}): string[] {
  const current = setting(model.effort);
  const dialect = protocol === "anthropic" ? `anthropic (${opts.shape ?? "effort"} shape)` : dialectFor(model);
  const lines = [
    `${model.provider}/${model.model}${opts.source ? `  (${opts.source})` : ""}`,
    `  protocol  ${protocol}`,
    `  dialect   ${dialect}${model.reasoning === false ? "  — the catalog lists no reasoning mode" : model.reasoning === true ? "  — the catalog lists a reasoning mode" : ""}`,
    ...(opts.catalog ? [`  prices    ${opts.catalog}`] : []), // where the numbers /cost uses come from — models.dev, or rovecode's own table
    `  effort    ${current}  (ROVECODE_EFFORT / --effort / /effort)`,
  ];
  for (const row of thinkingTable(model, protocol, opts)) lines.push(`  ${row.level === current ? "*" : " "} ${row.level.padEnd(7)} ${row.says}`);
  return lines;
}
