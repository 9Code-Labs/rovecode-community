# Context and cost: what the vendors say, and what rovecode does with it

Two numbers describe every turn and they are not the same thing. The **estimate** is ours: o200k over
everything we are about to send, available before a request and for a session that never ran. The
**reported** prompt is the provider's own count — `input + cacheRead + cacheWrite` from its usage block —
and it is the one you are billed for. `rovecode context` prints both and names the gap, because
compaction fires on the estimate: a meter that reads low compacts too late and the request is rejected;
one that reads high throws away history you paid to build.

```
rovecode context            the newest session in this directory
rovecode context <id>       a particular one · --json for the whole report
```

The estimate is exact for OpenAI models (o200k is their tokenizer) and an approximation everywhere else.
Anthropic's tokenizer is not public and its 4.7-generation models produce materially more tokens for the
same text, so expect the estimate to read low there — the drift line measures exactly how much, per model,
from your own transcripts rather than from a claim on this page.

## What counts against the window

- **Cache reads and writes are part of the prompt.** A long agentic session is almost entirely cache
  reads; a meter that counts only `input` reads near zero forever. `contextReport` counts all three.
- **Thinking tokens count.** Anthropic bills them as output and counts them in the window; on Opus 4.5+,
  Sonnet 4.6+ and Fable 5.x the thinking blocks are retained and come back as **input** on the next turn.
  OpenAI bills reasoning tokens as output (`output_tokens_details.reasoning_tokens`) and they occupy the
  window. Google adds thinking tokens to the output price (`total_thought_tokens`).
- **Images are not estimated.** Image token cost is provider-specific; the report says how many images are
  in the transcript instead of folding them in at zero.
- **The history budget follows the window.** It used to be a flat 200k for every model, which spends a
  fifth of a 1M window and overflows a 128k one. It is now the window minus the answer's room minus a
  fixed allowance for the system prompt and tool schemas; `ROVECODE_CONTEXT_BUDGET` overrides it.

## Prompt-size tiers

Two vendors charge more for a large prompt, and they do it in the shape that costs the most: the rate is
selected by the prompt size and then applied to **the whole request, output included**.

| Vendor | Threshold | Below | At or above | Shape |
|---|---|---|---|---|
| xAI grok-4.6 | 200k prompt tokens | $2 in / $6 out | $4 in / $12 out | whole request |
| xAI grok-4.3 | 200k | $1.25 / $2.50 | $2.50 / $5.00 | whole request |
| Google gemini-3.1-pro-preview | 200k | $2 / $12 | $4 / $18 | whole request |
| Google gemini-2.5-pro | 200k | $1.25 / $10 | $2.50 / $15 | whole request |

`ratesFor(info, promptTokens)` in `src/providers/catalog.ts` returns the split; `costUsdTiered` in
`src/core/usage.ts` multiplies it. A model with no tier gets a trivial breakdown, so no caller branches.
The `marginal` shape (only the overflow at the upper rate) exists in the type and is used by nothing —
classifying a vendor that way without its own wording would be a guess.

**Anthropic has no long-context tier.** "Claude 4.6 and later models include the full 1M token context
window at standard pricing", and no beta header is needed for 1M
(<https://platform.claude.com/docs/en/build-with-claude/context-windows>). Any code that reserves a
multiplier or a header for long Anthropic prompts is describing a version of the API that no longer exists.

## Where the numbers come from

Every row in `catalog-local.ts` carries the page it was read from and the day it was read; `rovecode model
show` prints which layer answered. Verified 2026-09-05 against the vendors' own pages:

| Vendor | Page | What it settled |
|---|---|---|
| Anthropic | platform.claude.com/docs/en/docs/about-claude/pricing | Opus 5 $5/$25, Sonnet 5 $2/$10 (the September increase was cancelled), Haiku 4.5 $1/$5, Fable 5.1 $10/$50 with a **0.025×** cache read — the only model not on 0.1× |
| Anthropic | …/build-with-claude/thinking, /context-windows | thinking billed as output, inside `max_tokens`, retained thinking returns as input |
| xAI | docs.x.ai/developers/pricing | 200k threshold, upper rate applies to every token in the request; the original `grok-4` is no longer listed |
| Google | ai.google.dev/gemini-api/docs/pricing | the 200k columns are written "prompts > 200k", i.e. selected by prompt size; 3.8 Flash is promotional and **doubles on 2027-01-01** |
| OpenAI | developers.openai.com/api/docs/pricing, /guides/prompt-caching | cached input at 0.1×, and from GPT-5.6 a real **cache write** charge at 1.25× (`cache_write_tokens`) — added, not subtracted |
| DeepSeek | api-docs.deepseek.com/quick_start/pricing | v4-flash / v4-pro / v4-flash-vision-exp, 1M window; there is no separate `deepseek-reasoner` model, thinking is a mode |
| OpenRouter | openrouter.ai/docs/use-cases/usage-accounting | `prompt_tokens_details.cached_tokens` is **inside** `prompt_tokens`; `cost_details.upstream_inference_cost` only for BYOK |
| Mistral | mistral.ai/pricing/api | cached input −90%, batch −50%, regional +10%; no page states a max output — those stay unverified |
| Groq | console.groq.com/docs/models | only the GPT-OSS pages carry prices; the Llama and Whisper rows are unverified rather than guessed |

Two readings were deliberately left conservative. DeepSeek's page describes its off-peak window in a way
that contradicts the scheme it documents elsewhere, so the **peak** rate is used and the discount is not
implemented — an estimate that surprises nobody with a large bill. Mistral's snapshot rows report a max
output equal to the context window, which looks like a filler value; it is flagged, not corrected.

## Reconciling a real session

```
$ rovecode context --json | jq .drift
{ "estimated": 41230, "reported": 44118, "delta": 2888, "fraction": 0.065, "beyondTolerance": true }
```

`beyondTolerance` is 5%. Past it the estimate is wrong enough to matter for compaction, and the fix is a
model-specific correction, not a smaller tolerance. Under it, the meter can be trusted for budgeting.
