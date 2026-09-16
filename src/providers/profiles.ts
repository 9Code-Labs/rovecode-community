/** Model profiles: per-model-family tuning that the provider layer and the prompt assembler share.
 *
 *  One profile answers three questions for one model family, in one place:
 *    1. prompt — a behavioral section appended to the interactive system prompt (cli/runtime.ts
 *       buildDef). A model that was not tuned for this harness gets the operating contract spelled
 *       out: the read → edit hash protocol, act by default, parallel calls, verify before "done", …
 *       The GLM-5.3 profile's section has THREE parts: a Claude Sonnet 5 PERSONA (profile-sonnet5-
 *       persona.ts — the role Berkay asked for, carrying everything Anthropic publishes about how
 *       Sonnet 5 behaves and how Claude talks; a closed role that stays Claude Sonnet 5 even when asked
 *       directly which model it is — /status and /cost still report the real model, so the harness stays
 *       honest at the system level), then real captured Sonnet 5 VOICE examples (profile-sonnet5-voice.ts),
 *       then the harness WORKING AGREEMENT (profile-glm53.ts — tool protocol, permissions, reporting;
 *       names no model or vendor).
 *    2. wire   — extra request fields the model's endpoint wants. OpenAI-compatible adapters only
 *       (stream.ts spreads profileWire() into the /chat/completions body); the Anthropic adapter
 *       has its own dial (anthropicThinking) and no profile today — a GLM behind an Anthropic-protocol
 *       gateway gets the prompt section and nothing on the wire.
 *    3. effort — the endpoint's vocabulary for rovecode's ONE effort dial (off|low|medium|high).
 *
 *  Two resolvers, on purpose:
 *    - profileFor (the PROMPT): ROVECODE_PROFILE=off → none for any model; ROVECODE_PROFILE=<id> → that
 *      profile's section for EVERY model (A/B a contract on a model it was not written for; or pick the
 *      persona-free `glm-5.3-plain` variant for a GLM); unset → the first profile whose matches() accepts
 *      the model id.
 *    - wireProfileFor (the WIRE + effort words): the off-words still switch it off, but a forced id is
 *      ignored — request fields follow the model id only. An endpoint rejects fields it does not know
 *      (OpenAI has no `thinking`/`tool_stream`, and "max" is not an OpenAI effort word), so forcing the
 *      GLM contract onto gpt-5 must not turn every request into a 400.
 *  Both are provider-agnostic: the same GLM served by kaesra ("zai-org/glm-5.3-flash"), zai ("glm-5.3")
 *  or openrouter ("z-ai/glm-5.3", "z-ai/glm-5.3:free") gets one profile.
 *
 *  Prompt override: <cwd>/.rovecode/profiles/<id>.md, else <ROVECODE_HOME>/profiles/<id>.md, REPLACES
 *  the whole built-in section (persona + agreement for glm-5.3) — iterate on the text without a rebuild;
 *  an EMPTY file drops the section and keeps the wire tuning (buildDef appends nothing, not even the
 *  separator). Read at every buildDef: once per run start, never per turn, so the system prefix stays
 *  byte-stable within a run (prompt cache).
 *
 *  Not a port — rovecode-native. GLM-5.3 facts are Z.ai's model docs (docs.z.ai, glm-5.3 /
 *  glm-5.3-flash pages, 2026-08): thinking cannot be disabled (`thinking.type` accepts "enabled" only,
 *  `clear_thinking: false` recommended for agents), `reasoning_effort` low|high|max with max the default
 *  and the recommendation for coding, temperature 1 / top_p 0.95 suggested, `tool_stream: true` for
 *  streamed tool-call arguments. The word "medium" is not in GLM's vocabulary (an out-of-enum value
 *  silently means max), so rovecode's four levels map onto the three it has. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRef, ThinkingEffort } from "../core/types.ts";
import { rovecodeHome } from "./auth.ts";
import { GLM_53_AGENT_CONTRACT } from "./profile-glm53.ts";
import { SONNET_5_PERSONA } from "./profile-sonnet5-persona.ts";
import { SONNET_5_VOICE } from "./profile-sonnet5-voice.ts";

export { GLM_53_AGENT_CONTRACT, SONNET_5_PERSONA, SONNET_5_VOICE };

export interface ModelProfile {
  /** stable id: ROVECODE_PROFILE value, override file name (<id>.md), the live gauntlet's banner */
  id: string;
  /** does this model id belong to the family? provider is deliberately not consulted */
  matches(model: ModelRef): boolean;
  /** built-in prompt section (markdown, `# ` headers like the base prompt's own sections) */
  promptSection: string;
  /** extra OpenAI-compatible request fields; `streaming` = the SSE adapter is asking */
  wire(ctx: { streaming: boolean }): Record<string, unknown>;
  /** the endpoint's word for rovecode's level; null = send no reasoning field (endpoint default) */
  reasoningEffort(effort: ThinkingEffort | undefined): string | null;
}

/** GLM-5.3 and GLM-5.3-Flash under any vendor prefix, date suffix or `:variant`/`:tag` suffix:
 *  glm-5.3, glm-5.3-flash, zai-org/glm-5.3-flash, z-ai/glm-5.3-20260816, z-ai/glm-5.3:free,
 *  glm-5.3:latest — not glm-5.2, not glm-5.32, not glm-5.3x. */
export const GLM_53_MODEL_RE = /(^|[/:])glm-5\.3(?=[-:]|$)/i;

const glm53Wire = ({ streaming }: { streaming: boolean }): Record<string, unknown> => ({
  thinking: { type: "enabled", clear_thinking: false },
  temperature: 1,
  top_p: 0.95,
  ...(streaming ? { tool_stream: true } : {}),
});

// off = leave the endpoint's default alone (max: Z.ai's coding recommendation); low is the fast
// path; medium has no GLM word and rounds UP (a rovecode "medium" asks for more than "low" —
// rounding down would hand the two lower levels the same behavior)
const glm53Effort = (e: ThinkingEffort | undefined): string | null =>
  e === undefined || e === "auto" || e === "off" ? null : e === "low" ? "low" : e === "medium" ? "high" : "max";

/** The default for the GLM-5.3 family: the Sonnet 5 persona, real Sonnet 5 voice examples, then the
 *  working agreement. */
export const GLM_53_PROFILE: ModelProfile = {
  id: "glm-5.3",
  matches: (m) => GLM_53_MODEL_RE.test(m.model),
  promptSection: `${SONNET_5_PERSONA}\n\n${SONNET_5_VOICE}\n\n${GLM_53_AGENT_CONTRACT}`,
  wire: glm53Wire,
  reasoningEffort: glm53Effort,
};

/** The persona-free variant — the working agreement alone, same wire tuning. Opt-in only
 *  (ROVECODE_PROFILE=glm-5.3-plain): matches no model id by itself. */
export const GLM_53_PLAIN_PROFILE: ModelProfile = {
  id: "glm-5.3-plain",
  matches: () => false,
  promptSection: GLM_53_AGENT_CONTRACT,
  wire: glm53Wire,
  reasoningEffort: glm53Effort,
};

export const PROFILES: readonly ModelProfile[] = [GLM_53_PROFILE, GLM_53_PLAIN_PROFILE];

const OFF_WORDS = new Set(["off", "0", "false", "none", "no"]);

function forcedId(env: Record<string, string | undefined>): string {
  return (env["ROVECODE_PROFILE"] ?? "").trim().toLowerCase();
}

/** The profile whose PROMPT section a model runs under, honoring ROVECODE_PROFILE (off | <id>). An
 *  unknown id → null, so a typo means "no profile", never a silently different one (profileHint names it). */
export function profileFor(model: ModelRef, env: Record<string, string | undefined> = process.env): ModelProfile | null {
  const forced = forcedId(env);
  if (OFF_WORDS.has(forced)) return null;
  if (forced.length > 0) return PROFILES.find((p) => p.id === forced) ?? null;
  return PROFILES.find((p) => p.matches(model)) ?? null;
}

/** The profile whose WIRE fields and effort words a request carries: by model id only. The off-words
 *  still disable it; a forced id does not reach the wire (see the header). */
export function wireProfileFor(model: ModelRef, env: Record<string, string | undefined> = process.env): ModelProfile | null {
  if (OFF_WORDS.has(forcedId(env))) return null;
  return PROFILES.find((p) => p.matches(model)) ?? null;
}

/** ROVECODE_PROFILE names something that is not a profile — the one-line note the live gauntlet prints
 *  (`rovecode gauntlet --live`); the other surfaces run silently without a profile. */
export function profileHint(env: Record<string, string | undefined> = process.env): string | null {
  const forced = forcedId(env);
  if (forced.length === 0 || OFF_WORDS.has(forced) || PROFILES.some((p) => p.id === forced)) return null;
  return `ROVECODE_PROFILE=${forced} names no profile (known: ${PROFILES.map((p) => p.id).join(", ")}, off) — running without one`;
}

/** Override file paths, most specific first (project, then user scope). */
export function profileOverridePaths(profile: ModelProfile, cwd: string, home: string = rovecodeHome()): string[] {
  return [join(cwd, ".rovecode", "profiles", `${profile.id}.md`), join(home, "profiles", `${profile.id}.md`)];
}

/** The section buildDef appends: the first override file that exists (trimmed; "" disables the
 *  section), else the built-in text. An unreadable file falls back to the built-in text. */
export function profilePromptSection(profile: ModelProfile, cwd: string, home: string = rovecodeHome()): string {
  for (const p of profileOverridePaths(profile, cwd, home)) {
    if (!existsSync(p)) continue;
    try { return readFileSync(p, "utf8").trim(); } catch { return profile.promptSection; }
  }
  return profile.promptSection;
}

/** The request fields a model's endpoint wants beside the standard body; {} without a wire profile. */
export function profileWire(model: ModelRef, streaming: boolean, env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  return wireProfileFor(model, env)?.wire({ streaming }) ?? {};
}
