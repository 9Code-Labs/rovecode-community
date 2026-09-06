/** PORT #33 — ask_user: one clarifying question per call, answered by the interactive surface.
 *
 *  The model asks a question (optional option labels + free text); the surface renders it and
 *  the user's answer returns as the tool result. Surfaces without a human (run/serve/acp) never
 *  bind an asker, so the tool fails CLOSED with an actionable error instead of hanging.
 *
 *  Sources (research/source_snapshots):
 *   - opencode-2026 (MIT, ebece6e) packages/opencode/src/tool/question.ts:22-40 — the tool
 *     contract: prompts with option labels, answers folded back into the tool output as the
 *     selected label text (:30-36); packages/schema/src/v1/question.ts:15-28 — Option/Prompt
 *     shape incl. `custom` (typed answer allowed, default true); question.txt usage notes
 *     (recommended option first, no catch-all "Other" — the surface adds the free-text entry);
 *     packages/opencode/src/question/index.ts:29-33 — a dismissed question is an ERROR the
 *     model sees ("The user dismissed this question"), never a silent empty answer.
 *   - gemini-cli (Apache-2.0, 0bd1d43) packages/cli/src/config/config.ts:794-803 — headless
 *     behavior: with no human present ask_user is excluded and ASK_USER decisions translate to
 *     DENY. rovecode keeps the tool registered on every surface (one registry for all of them) and
 *     fails closed at execute time with a message that tells the model what to do instead.
 *  Deviations: ONE question per call (sequential: true) instead of a batch of up to 4; options
 *  are plain strings — the harness renders into 80 columns, not a web panel. No code copied.
 */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";

/** What the surface must render: the question, optional option labels, and whether a typed
 *  answer is accepted (default true — opencode `custom`, schema/v1/question.ts:26-28). */
export interface QuestionPrompt {
  question: string;
  options?: string[];
  allowFreeText?: boolean;
}

/** What the surface hands back: a picked option (index, label) or typed text. */
export interface QuestionAnswer {
  choice?: number;
  label?: string;
  text?: string;
}

/** The surface seam. Resolves null when the user declines; MUST honor `signal` (dismiss on
 *  abort) — the tool races it regardless, so a deaf surface cannot pin the run. */
export type AskFn = (q: QuestionPrompt, signal: AbortSignal) => Promise<QuestionAnswer | null>;

export const MAX_OPTIONS = 8;
export const MAX_OPTION_CHARS = 80;
export const MAX_QUESTION_CHARS = 2000;

export const ASK_USER_UNAVAILABLE =
  "ask_user unavailable: no interactive user in this session (headless run/serve/acp) — proceed with your best judgment or stop";
export const ASK_USER_ABORTED = "ask_user aborted";
export const ASK_USER_DECLINED = "user declined to answer";

/** Validate + normalize args. A string return is the error message (never throws). */
export function parseQuestion(args: unknown): QuestionPrompt | string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const question = typeof a.question === "string" ? a.question.trim() : "";
  if (question === "") return "question must be a non-empty string";
  if (question.length > MAX_QUESTION_CHARS) return `question too long (${question.length} chars, max ${MAX_QUESTION_CHARS})`;
  let options: string[] | undefined;
  if (a.options !== undefined && a.options !== null) {
    if (!Array.isArray(a.options)) return "options must be an array of strings";
    if (a.options.length > MAX_OPTIONS) return `too many options (${a.options.length}, max ${MAX_OPTIONS})`;
    options = [];
    for (const o of a.options) {
      if (typeof o !== "string" || o.trim() === "") return "every option must be a non-empty string";
      const label = o.trim();
      if (label.length > MAX_OPTION_CHARS) return `option too long (${label.length} chars, max ${MAX_OPTION_CHARS}): ${label.slice(0, 40)}…`;
      options.push(label);
    }
    if (options.length === 0) options = undefined;
  }
  if (a.allowFreeText !== undefined && typeof a.allowFreeText !== "boolean") return "allowFreeText must be a boolean";
  const allowFreeText = a.allowFreeText !== false;
  if (!options && !allowFreeText) return "nothing to answer with: provide options or allow free text";
  return { question, ...(options ? { options } : {}), allowFreeText };
}

/** Fold the surface's answer into the model-facing result; garbage from a surface is an error. */
function renderAnswer(a: QuestionAnswer, q: QuestionPrompt): ToolOutput {
  const text = typeof a.text === "string" ? a.text.trim() : "";
  if (text !== "") return { ok: true, output: `answer: ${text}`, data: { text } };
  const options = q.options ?? [];
  if (typeof a.choice === "number" && Number.isInteger(a.choice) && a.choice >= 0 && a.choice < options.length) {
    const label = options[a.choice]!;
    return { ok: true, output: `answer: ${label}`, data: { choice: a.choice, label } };
  }
  return { ok: false, output: "ask_user failed: the surface returned an unusable answer" };
}

/** Build the tool over a GETTER for the asker, so a surface can bind/unbind after registration
 *  (runtime.setAskUser — the setBlockStore late-binding idiom). */
export function askUserTool(getAsk: () => AskFn | undefined): Tool {
  return {
    schema: {
      name: "ask_user",
      description:
        "Ask the user ONE clarifying question and wait for the answer. Use it when instructions are " +
        "ambiguous, a decision has real consequences, or you must pick between approaches — do not guess. " +
        `Give up to ${MAX_OPTIONS} short options (≤${MAX_OPTION_CHARS} chars each); the user may also type a ` +
        "free-text answer unless allowFreeText is false. If you recommend an option, list it first and append " +
        "\"(recommended)\"; never add an \"Other\" option — the free-text entry covers it. The result is " +
        "`answer: <chosen option or typed text>`. A declined or aborted question, or a session with no " +
        "interactive user (headless run/serve/acp), returns an error: then proceed with your best judgment or stop.",
      args: {
        type: "object",
        properties: {
          question: { type: "string", description: "the complete question — clear, specific, one decision" },
          options: {
            type: "array", items: { type: "string" }, maxItems: MAX_OPTIONS,
            description: `up to ${MAX_OPTIONS} answer choices, ≤${MAX_OPTION_CHARS} chars each (recommended one first)`,
          },
          allowFreeText: { type: "boolean", description: "also accept a typed free-form answer (default true)" },
        },
        required: ["question"],
      },
    },
    // kind "read" → action file.read. Asking the human must never itself need approval: the gated
    // default rules (runtime.ts buildCfg) allow file.read, prompt file.write/shell.exec/spawn/
    // tool.mcp_call, and deny-default everything else — a "custom" kind would map to
    // `tool.ask_user`, which no rule allows (denied), and plan mode's blanket `tool.* deny`
    // (modes.ts planModeRules) would lock the question tool out of exactly the mode where
    // clarifying questions matter most, while file.read is re-allowed there. Non-mutating, so no
    // checkpoint (MUTATING_KINDS = write/execute). With no `path`/`command` arg the policy
    // resource is the tool name, so `file.read ask_user` can still be targeted precisely
    // (same reasoning as memory/recall.ts:282-288).
    kind: "read",
    sequential: true, // one question at a time — never interleaved with sibling tool output
    async execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const prompt = parseQuestion(args);
      if (typeof prompt === "string") return { ok: false, output: `ask_user failed: ${prompt}` };
      const ask = getAsk();
      if (!ask) return { ok: false, output: ASK_USER_UNAVAILABLE }; // headless: fail closed, say why
      if (ctx.signal.aborted) return { ok: false, output: ASK_USER_ABORTED };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<"aborted">((res) => {
        onAbort = () => res("aborted");
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        // RACED, not merely awaited: a surface that ignores the signal must not pin the run.
        // The executor form invokes ask() synchronously and turns a sync throw into a rejection.
        const asked = new Promise<QuestionAnswer | null>((res) => res(ask(prompt, ctx.signal)));
        const winner = await Promise.race([asked.then((answer) => ({ answer })), aborted]);
        // an answer landing in the same tick as the abort is moot — the run is going away
        if (winner === "aborted" || ctx.signal.aborted) return { ok: false, output: ASK_USER_ABORTED };
        if (winner.answer === null) return { ok: false, output: ASK_USER_DECLINED };
        return renderAnswer(winner.answer, prompt);
      } catch (e) {
        // never throw across the tool seam (ADR-005): surface failures become typed output
        return { ok: false, output: `ask_user failed: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
