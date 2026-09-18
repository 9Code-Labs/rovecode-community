# When the provider misbehaves

What happens on the wire when an endpoint says 429, 529, 5xx, drops the socket mid-answer, or never answers
at all — and what the person sees. One retry policy for both adapters (`src/providers/retry.ts withRetry`,
wrapped around the OpenAI-compatible and Anthropic adapters in `src/providers/stream.ts` by `cli/runtime.ts`,
inside the router's fallback chain), one first-byte timeout (`stream-errors.ts fetchFirstByte`), one rule for
mid-stream failures (no re-drive after content), and one note channel for the human.

## The policy

A failure is retried when retrying could help and cannot duplicate work: **429 and 5xx are retryable**,
transport failures (no HTTP prefix) are retryable, and `config:` errors and every other 4xx are not — the same
classifier the router uses for its fallback chain (`router.ts classifyStreamError`).

`ROVECODE_RETRY_MAX` sets the retries after the first attempt (default 3, so 4 attempts; `0` disables).
`ROVECODE_RETRY_BASE_MS` caps the FIRST backoff (default 1000); it doubles per attempt up to 20 s and is fully
jittered (`U[0,1) × cap`), so a rate-limited fleet does not come back in lockstep. Whatever the server asks for
— `Retry-After` in seconds or as an HTTP date, `retry-after-ms`, or Anthropic's rate-limit reset headers — is a
**floor**, never a ceiling: a hint raises the wait, it can never shorten it.

Three things end the retrying rather than the attempts running out, and each says so by name: the per-turn
retry budget (60 s total), the run's own deadline from `--max-seconds`, and a hint longer than either.

`ROVECODE_FIRST_BYTE_TIMEOUT_MS` (default 60000) bounds only the wait for the **first** byte. Once the model is
talking the SSE body has a separate idle timeout; active chunks reset that idle timer.

## What changed on 2026-09-04

Kept for anyone who knew the old behaviour; the right-hand column is what ships.

| case | before | now |
|---|---|---|
| **429** | retried (3 retries, full jitter, base 2 s, cap 30 s), Retry-After as a floor; note only after the run (TUI) / never (headless) | retried: 4 attempts, full jitter base 1 s cap 20 s, the longest of Retry-After (seconds or HTTP-date), `retry-after-ms`, `anthropic-ratelimit-requests/tokens-reset` as the floor; live notice `openai: rate limited — retrying in 3 s (2/4)` |
| **529 overloaded / 503** | retried as above | retried; notice `anthropic: overloaded — retrying in 0.5 s (2/4)`; on the last failure `anthropic: overloaded (HTTP 529) — gave up after 4 attempts: Overloaded` |
| **500 / 502 / 504** | retried | retried; `server error (HTTP 500)` wording; the error turn keeps the provider's exact text (`HTTP 500: {…}`) for the router and the run summary |
| **400 / 401 / 403 / 404** | not retried | unchanged: the error stands at once |
| **socket reset mid-stream, after tokens arrived** | retried — and the router could advance the chain too: the answer streamed AGAIN under the first | **not retried, not re-driven**: the turn ends with the partial text kept as its parts (the transcript stores it, the summary shows it above the error) and the error `… — the connection dropped after part of the answer had arrived; not retried, a retry would repeat it` |
| **socket reset before any token** | retried | retried (nothing to duplicate) |
| **no response before the first byte** | hung until Ctrl-C — the run's wall clock is checked only between turns | `fetchFirstByte`: 60 s (`ROVECODE_FIRST_BYTE_TIMEOUT_MS`) on the wait for headers only; a timeout is a transport failure `no response from api.anthropic.com within 60 s`, retried; SSE body reads have a separate 120 s idle timeout |
| **abort (Ctrl-C, Esc Esc) during the backoff** | the sleep woke at once, no retry | unchanged |
| **`--max-seconds` deadline** | unknown to the retry: a 30 s Retry-After could overshoot the clock | the loop passes `StreamOptions.deadlineAt`; a wait that would end past it is not taken: `anthropic: overloaded (HTTP 529) — not retried: the run's time limit is closer than the 8 s wait: Overloaded` |
| retry budget per turn | 60 s total | unchanged (60 s); the note says `not retried: the 30 s wait would pass the retry budget` |

## Stream integrity

The shared SSE reader handles split UTF-8, CRLF, multi-line data frames and an unterminated final line.
`ROVECODE_STREAM_IDLE_TIMEOUT_MS` bounds silence between body chunks (default 120000 ms).
Chat Completions and Anthropic SSE reads also honor abort and the absolute run deadline.
The `sseLines` compatibility export remains available to the Responses adapter.

EOF without a finish reason, HTTP 200 error envelopes, malformed tool arguments, missing/duplicate IDs
and empty tool-use turns are errors, never permission to execute tools. Length-limited calls remain
non-executable. The core loop rejects missing terminal turns and pairs calls in error/budget turns with
failed results so a later resume has no orphan calls. Headless SSE runs use the runtime's full provider
chain, including OAuth refresh, middleware, retries and routing.

Coverage: `test/unit/stream-integrity.test.ts`, `test/integration/loop-integrity.test.ts`,
`test/unit/tool-stream-regressions.test.ts`, `test/integration/cli-tool-stream.test.ts`.

## Idempotency

A retry re-sends the same request. That is safe only while nothing of the answer has reached the person.
`withRetry` counts the text and reasoning deltas it let through in the current attempt; once any went out, a
failure ends the turn instead of retrying. The router applies the same rule to its chain advance (a fallback
candidate would otherwise print a second answer under the first). The partial text is not lost: it becomes
the error turn's parts, the loop stores the message, and the run summary reads `<partial text>\nerror: …`.

## What the person sees

- **TUI**: each retry is a warn system note while the backoff waits (`rt.onRouterNote` → `renderer.addSystemNote`),
  which the sextant surface shows as a notice; the give-up line the same way; the failed turn is an error row
  with the partial text kept above it.
- **`rovecode run`**: one stderr line per retry / give-up (`rt.onRouterNote` → stderr); stdout stays the
  transcript / result object. The run ends `status: "error"` with the provider's text in `summary`.
- **repl**: notes drain after each turn as before (`drainRouterNotes`).

## Files

- `src/providers/retry.ts` — `withRetry`, `serverWaitMs`, `failureWord`, `describeRetry`, `describeGiveUp`, `RetryNote`, `GiveUpNote`
- `src/providers/stream-errors.ts` — `httpErrorTurn` (records status + Retry-After + retry-after-ms + anthropic reset), `providerMessage`, `fetchFirstByte`, `firstByteTimeoutMs`
- `src/providers/stream.ts` — the three provider fetches go through `fetchFirstByte`
- `src/providers/router.ts` — no chain advance after content streamed
- `src/core/types.ts StreamOptions.deadlineAt`, `src/core/loop.ts` (passes the run's deadline)
- `src/cli/runtime.ts` (`onRouterNote`, note wording), `src/cli/main.ts` (stderr), `src/tui/app.ts` (live note)
- `test/unit/wire-failures.test.ts` — every row above through the real adapters with a fake fetch; `test/unit/retry.test.ts`, `retry-wiring.test.ts`
