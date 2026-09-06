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
rovecode context --exact    ask Anthropic to count the prompt instead of estimating it
```

The estimate is exact for OpenAI models (o200k is their tokenizer) and an approximation everywhere else.
Anthropic's tokenizer is not public and its 4.7-generation models produce materially more tokens for the
same text, so expect the estimate to read low there — the drift line measures exactly how much, per model,
from your own transcripts rather than from a claim on this page.

## Asking instead of estimating

Anthropic publishes the arithmetic: `POST /v1/messages/count_tokens` takes the same body a request would
— model, system, messages, tools — and returns `input_tokens`, the number the window and the bill are
computed from. `--exact` sends the prompt the report just measured and prints the provider's own count
beside ours. On this repository, on a session with no turns yet:

```
context  ~7,790 of 1,000,000 (0.8%)
exact    the provider counted 12,283 for this prompt
         our estimate reads low by 4,493 (36.6%) — beyond the 5.0% tolerance
```

**That gap is the whole reason the flag exists.** o200k under-counts Anthropic's tokenizer by better than
a third on rovecode's own system prompt and tool schemas, and compaction fires on the estimate: at a third
low, a session believed to be at 70% of the window is really at 95%. The drift line measures the same thing
from a transcript, but only after a turn has been billed; `--exact` answers before the first request.

Four deliberate limits:

- **Anthropic protocol only.** No other vendor publishes a counting endpoint. An OpenAI-protocol provider
  gets a stated reason, not a fallback number whose provenance nobody could explain.
- **Opt-in.** It is a network call with your key. Nothing in `rovecode context` reaches the network without
  `--exact`.
- **It never fails the command.** A refusal, a gateway without the route, a timeout — each prints as a
  reason on the `exact` row. A token count is not worth failing a report over.
- **A fresh session carries a placeholder.** The API rejects an empty message list, so a session with no
  turns is counted with a one-character user message standing in for the transcript. The output says so;
  a couple of tokens of scaffolding inside a number labelled *exact* has to be disclosed.

Pair it with `--no-runtime` and the count describes the transcript alone, which is rarely what you want —
the two rows below are most of a fresh window.

## The correction, and why it is measured

`--exact` produced a number, and the number had a consequence: our estimate was not a little low, it was
low by three quarters in the worst case. `bun scripts/measure-tokenizer.ts` turns that observation into a
table by sending real samples — the system prompt, the tool schemas, a TypeScript file, English prose,
Turkish prose, a JSON tool result and fourteen market documentation bodies — to the counting endpoint and
dividing. Measured 2026-09-05 against claude-opus-5, the extremes of twenty samples:

| sample | chars/4 | o200k | actual | o200k needs |
|---|---|---|---|---|
| system prompt | 3,703 | 3,461 | 4,941 | 1.428× |
| tool schemas (json) | 4,610 | 4,329 | 6,574 | 1.519× |
| typescript source | 5,964 | 5,999 | 9,489 | 1.582× |
| english prose | 2,330 | 2,362 | 3,417 | 1.447× |
| market doc: github | 5,481 | 5,067 | 8,590 | 1.695× |
| market doc: cloudflare-docs | 2,390 | 1,785 | 3,174 | 1.778× |
| market doc: mcp-builder | 2,354 | 2,016 | 3,611 | 1.791× |

The market documents belong in that list for a reason. The first run used six samples of prose, code and
JSON and produced a 1.58× ceiling; nimbus-24, measuring 19 skill bodies independently, found ratios above
it. Markdown documentation — headings, bullets, fenced code and tables in one file — tokenizes worse than
either prose or code alone, and it is exactly what lands in a window when a model opens a skill. Their
worst case reproduces here at 1.791. A sample set that omits the commonest content is not conservative;
it is wrong in the expensive direction.

Three further things the table settles. Sonnet 5 returns **identical** counts to Opus 5 on every sample,
so the factor belongs to a generation rather than to a model name. Haiku 4.5 is a different, older
tokenizer at 1.08–1.29×, so the 5-generation figure must not be applied to it. And OpenAI models need no
correction at all, because o200k *is* their tokenizer — a blanket multiplier would have broken the one
case that was already exact.

`src/core/token-scale.ts` holds the factors: 1.80× for Claude 5, 1.29× for Claude 4.5/4.6. Each is the
**maximum** ratio across the samples, not the mean, because the two errors are not symmetric — a budget
that reads high leaves some window unused, while one that reads low sends a request the provider refuses.
A model nobody has measured gets 1 and says so; a borrowed multiplier would move the budget by an amount
whose provenance no one could explain.

The correction is applied in exactly one place: `contextBudgetFor` divides the budget by the scale, which
is arithmetically the same as inflating every estimate at every call site, and there is one of it. That
is what makes compaction fire on time. `rovecode context` shows the raw estimate beside the corrected one
and names the factor — a number that has been silently adjusted is not a measurement:

```
context  ~14,022 of 1,000,000 (1.4%)
         o200k counted 7,790, scaled by 1.8× — measured 2026-09-05 against /v1/messages/count_tokens
exact    the provider counted 12,283 for this prompt
```

Note what that shows about the trade. On *this* prompt the corrected estimate reads 14,022 against an
actual 12,283 — 14% high, because 1.80× is the worst case across the samples and a system prompt is not
the worst case. The uncorrected estimate was 37% low. Both are wrong; only one of them loses the turn.
`--exact` is there for when you want the actual number rather than the safe one.

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

## The fixed cost of a turn

Two rows are in every prompt and in no transcript: the system prompt and the tool schemas. `rovecode
context` builds the same runtime a run would and asks it for the definition it would actually send, so
those rows are measured rather than guessed. On this repository they are the whole of a fresh session:

```
  system prompt      3,461   44.4%
  tool schemas       4,329   55.6%
```

~7.8k tokens before you have typed anything — worth knowing when a model's window is 128k, and worth
knowing per project, because both rows grow with what the project brings (skills index, memory blocks,
the design section, a model profile). `--no-runtime` skips this for a project whose config does not load.

MCP tools are deliberately not counted: a server's schemas exist only after connecting to it, and
starting someone else's processes to print a number is not a trade this command makes. It says so
instead of implying the total is complete.

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
