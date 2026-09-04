# Thinking: one dial, every wire

rovecode has one effort dial — `--effort`, `ROVECODE_EFFORT`, `/effort` — with five positions:
`auto | off | low | medium | high` (`src/core/types.ts ThinkingEffort`). Every provider names the same idea
differently, and several cannot be switched off or have no reasoning mode at all. `src/providers/thinking.ts`
translates the dial per model family and says, in one sentence, what the model will actually receive.
`/effort` prints that sentence as its second line; `rovecode model show [provider/model]` prints all five.

Rules (Berkay, 2026-09-04):

- **auto** sends **nothing** — the endpoint's own default stands. The Claude 5 family reasons adaptively on its
  own; the old default `off` switched that off and was most of "we are not getting the model's real performance".
  `auto` is the runtime default.
- **off** is an explicit disable **where the API has one**; otherwise nothing is sent and the sentence says why.
- **low / medium / high** map onto the endpoint's own vocabulary. Where it has fewer steps, **medium rounds up**
  (a rovecode "medium" asks for more than "low").
- A model that **always reasons** or has **no reasoning mode** receives nothing — sending a dial such a model
  rejects is a hard 400, not a downgrade (a grok `-non-reasoning` variant; gpt-4-class on OpenAI proper).
- The **catalog's word is stronger than any regex**: a model that models.dev lists without a reasoning mode
  (`ModelRef.reasoning === false`, stamped by `cli/runtime.ts buildDef`) receives nothing on every dialect.
- Dialects are matched by **model id, provider-agnostic** (the same GLM under kaesra, zai or openrouter is one
  family) — except **OpenRouter**, whose unified `reasoning` object wins for every model it fronts, and **Groq's**
  Qwen vocabulary.

Measured vs documented: only the **Anthropic** rows and **GLM-5.3** are measured against the live endpoints
(`stream.ts` header, `profiles.ts` header, 2026-09-03). Every other row is the vendor's published API reference as
of 2026-09 and is marked *doc*. If an endpoint answers 400 to one of these fields, that row is wrong — fix the
dialect in `thinking.ts`, not the caller.

## The matrix

`—` = nothing is sent (the sentence names the reason). Levels on one line mean `low / medium / high`.

| wire · family (dialect id) | auto | off | low / medium / high | status |
|---|---|---|---|---|
| **Anthropic Messages**, effort shape — measured on claude-opus-5, claude-sonnet-5, claude-opus-4-5; the shape is *learned*, never hard-coded, and `effort` is the first guess for any Anthropic model | — | `thinking: {type: "disabled"}` | `output_config: {effort: "low"/"medium"/"high"}` | measured |
| **Anthropic Messages**, budget shape — measured on claude-sonnet-4-5, claude-haiku-4-5; reached by flipping after the effort shape's 400 | — | `thinking: {type: "disabled"}` | `thinking: {type: "enabled", budget_tokens: 2048 / 8192 / 24576}`; `max_tokens` raised to at least budget + 4096 | measured |
| OpenAI-compat · **OpenRouter** (any model, `provider === "openrouter"`) | — | `reasoning: {enabled: false}` | `reasoning: {effort: "low"/"medium"/"high"}` | doc |
| OpenAI-compat · **GLM-5.3 / 5.3-flash** (`glm-5.3`) | — | — (cannot be disabled; the endpoint default is max) | `reasoning_effort: "low" / "high" / "max"` (+ the profile's `thinking: {type: "enabled", clear_thinking: false}`); under `ROVECODE_PROFILE=off` the plain OpenAI word goes instead — that A/B is what the switch is for | measured |
| OpenAI-compat · **GLM 4.5 – 5.x** other than 5.3 (`glm`) | — | `thinking: {type: "disabled"}` | `thinking: {type: "enabled"}` (no levels) | doc |
| OpenAI-compat · **DeepSeek** chat / V3.x (`deepseek`) | — | `thinking: {type: "disabled"}` | `thinking: {type: "enabled"}` (no levels) | doc |
| OpenAI-compat · **DeepSeek** reasoner / R1 | — | — (always thinks) | — | doc |
| OpenAI-compat · **Qwen / QwQ** on DashScope and most hosts (`qwen`) | — | `enable_thinking: false` | `enable_thinking: true, thinking_budget: 2048 / 8192 / 24576` | doc |
| OpenAI-compat · **Qwen on Groq** | — | `reasoning_effort: "none"` | `reasoning_effort: "default"` | doc |
| OpenAI-compat · **Kimi K2.5** (`kimi`) | — | `thinking: {type: "disabled"}` | `thinking: {type: "enabled"}` | doc |
| OpenAI-compat · **Kimi K2 Thinking** | — | — (always thinks) | — | doc |
| OpenAI-compat · **Kimi K2 instruct** | — | — (no thinking mode) | — | doc |
| OpenAI-compat · **Gemini** via Google's OpenAI layer (`gemini`) | — | Flash: `extra_body.google.thinking_config.thinking_budget: 0` · Pro: — (minimum budget) | `reasoning_effort: "low"/"medium"/"high"` (Google maps to a budget) | doc |
| OpenAI-compat · **grok-3-mini** (`grok`) | — | — | `reasoning_effort: "low" / "high" / "high"` | doc (no longer on docs.x.ai 2026-09-04) |
| OpenAI-compat · **grok-4.3 / 4.5 / 4.6 / 4.20**, and the retired grok-4-0709 / grok-4-fast slugs (served by grok-4.3 since 2026-05-15) | — | `reasoning_effort: "none"` | `reasoning_effort: "low"/"medium"/"high"` | fetched 2026-09-04 (docs.x.ai/docs/models/grok-4.3) |
| OpenAI-compat · any grok `-non-reasoning` variant | — | — (no reasoning mode) | — | fetched 2026-09-04 |
| OpenAI-compat · **gpt-oss** (`gpt-oss`) | — | — (low is the floor) | `reasoning_effort: "low"/"medium"/"high"` | doc |
| OpenAI-compat · **o1 / o3 / o4** (`openai o-series`) | — | — (cannot be disabled) | `reasoning_effort: "low"/"medium"/"high"` | doc |
| OpenAI-compat · **gpt-5.1** and later (`openai gpt-5`) | — | `reasoning_effort: "none"` | `reasoning_effort: "low"/"medium"/"high"` | doc |
| OpenAI-compat · **gpt-5 / gpt-5-mini / gpt-5-nano** | — | `reasoning_effort: "minimal"` (its floor) | `reasoning_effort: "low"/"medium"/"high"` | doc |
| OpenAI-compat · **gpt-4 class, gpt-3.5, chatgpt-** (`openai gpt-4 class`) | — | — (no reasoning mode; OpenAI rejects the field) | — | doc |
| OpenAI-compat · **Magistral** (`mistral`) | — | — (always reasons) | — | doc |
| OpenAI-compat · other **Mistral** models | — | — (no reasoning mode) | — | doc |
| OpenAI-compat · **MiniMax** (`minimax`) | — | — (always reasons) | — | doc |
| OpenAI-compat · **anything else** (`openai-compatible default`) | — | — (no common explicit disable) | `reasoning_effort: "low"/"medium"/"high"` — a model without a reasoning mode ignores it | — |
| any dialect · **catalog says no reasoning mode** | — | — | — | catalog |

Not spoken natively: Gemini's own API (`thinkingConfig`), Ollama's native `/api/chat` (`think`), Vertex, Bedrock.
rovecode talks two wire protocols only (OpenAI-compatible and Anthropic Messages, `providers.json protocol`), so
Gemini is reached through Google's OpenAI-compatible layer or OpenRouter, and Ollama through its `/v1` — where
`reasoning_effort` is honoured by gpt-oss and ignored by everything else, and there is no off (Ollama's
`think: false` lives on the native API). A Qwen behind vLLM wants `chat_template_kwargs.enable_thinking`, which
rovecode does not send; the DashScope pair is ignored there.

## Anthropic: the learned shape

Anthropic has two request shapes and no model takes both (measured table in `stream.ts`). There is no
capability field to read, so `anthropicPost` tries the newer effort shape, and on a 400 that (a) says the shape
is unsupported **and** (b) mentions thinking/effort/budget, flips to the other shape and retries **once**. What
holds (pinned in `test/unit/thinking.test.ts`):

- **Per provider + model.** The memory key is `provider/model`, so a gateway fronting the same model id cannot
  poison the direct endpoint's memory or the other way round.
- **Bounded.** At most two sends per request; a 400 that is not about the dial ("image input is not supported for
  this model") is returned as is and learns nothing; `auto` and `off` carry no shape and never retry.
- **No oscillation.** The flipped shape is remembered only when the retry was not the same refusal. A model that
  refuses both shapes leaves no memory: every request costs the same two sends and one error turn, never a
  flip-flop that alternates guaranteed failures.
- **Process lifetime.** A model's shape does not change under us; nothing is persisted.

## Seeing it

```
/effort high
thinking: high — I reason before answering. It costs output tokens and delays the first word.
  deepseek/deepseek-chat receives: thinking: { type: "enabled" } (DeepSeek has an on/off switch, no levels)

rovecode model show                    # the default model
rovecode model show openai/gpt-4o      # any model
openai/gpt-4o  (as named)
  protocol  openai
  dialect   catalog: no reasoning mode  — the catalog lists no reasoning mode
  effort    auto  (ROVECODE_EFFORT / --effort / /effort)
  * auto    nothing — auto: the endpoint's own default stands
    off     nothing — the catalog lists gpt-4o without a reasoning mode, so no dial is sent
    …
```

## Files

- `src/providers/thinking.ts` — the dialect table, `thinkingPlan`, `thinkingTable`, `thinkingLine`, `thinkingReport`, the Anthropic budgets and both shapes
- `src/providers/stream.ts` — spreads the plan into the body; `anthropicPost` learns the shape (`shapeByModel`, `anthropicShapeFor`)
- `src/providers/profiles.ts` — GLM-5.3's words and wire fields (measured)
- `src/core/types.ts` — `ThinkingEffort`, `ModelRef.reasoning`; `src/cli/runtime.ts buildDef` stamps `reasoning` from the catalog
- `src/core/voice.ts effortNote(level, receives)`; `src/tui/app.ts` `/effort`; `src/cli/main.ts` `model show`
- `test/unit/thinking.test.ts` (the matrix, the adapters, the shape memory), `test/unit/stream.test.ts`, `test/unit/effort-auto.test.ts`
