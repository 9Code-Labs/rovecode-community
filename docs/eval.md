# Eval & reliability gate (offline)

The eval P0 layer: **persist** what a run did, **grade** the workspace it left behind,
**replay** it without a network, **detect** stuck loops, and **redact** secrets before any
of it touches disk. All deterministic — no provider keys needed.

```
bun scripts/eval-offline.ts          # the whole gate in one command (~150 ms local)
bun scripts/eval-offline.ts --out artifacts/eval   # custom artifact dir (default .eval-results/, gitignored)
bun test test/unit/eval-trajectory.test.ts test/unit/eval-grader.test.ts \
         test/unit/eval-replay.test.ts test/unit/eval-redact.test.ts test/unit/stuck-detector.test.ts
```

CI runs the script as the `eval` job in `.github/workflows/ci.yml` (10-minute ceiling for
the artifact upload, not the eval) and uploads the trajectories as `eval-trajectories`.

## 1. Trajectory persistence — `src/eval/trajectory.ts`

One JSONL file per run, `schemaVersion: 1`:

| line | carries |
|---|---|
| `header` | runId, task (id/category/prompt), model, seed, commit, **fixture snapshot**, permission rules, env |
| `step` | ordered user / assistant (tool calls) / tool (results) records |
| `result` | outcome, durationMs, toolCallCount, usage, costUsd, **failure taxonomy**, grader specs+results, redacted evidence |

Failure taxonomy: `verify-failed · timeout · provider-error · budget · loop-guard ·
invalid-args · permission-denied · workspace-leak · tool-error · unknown`.

Rules the file keeps: every string payload is **redacted** and **workspace-relative-ized**
(`<workspace>` tokens) before the write; tool results carry `outputSha` — the sha256 of the
path-normalized RAW output — so replay compares substance while the stored text stays
redacted evidence. The reader classifies damage (`unsupported-version`, `missing-header`,
`malformed-line` + line number, unknown line kinds tolerated) instead of crashing mid-file.

## 2. Graders — `src/eval/grader.ts`

JSON-serializable specs, judged against the workspace (never against the model's own words):

- `file-changed` — differs from the fixture baseline, `mustMatch` / `mustNotMatch` on the
  new content; evidence carries a unified diff (the patch grader)
- `file-equals`, `file-matches` — exact content / regex on the end state
- `command` — a real process in the workspace, exit-code asserted, timeout-bounded
- `final-text` — **advisory only**: recorded as corroboration, never sufficient

The composite gate (`runGraders` → `GraderConfigError`): a set of only `final-text` specs
is a configuration error. String-contains alone does not pass. The existing deterministic
gauntlet (`src/eval/gauntlet.ts`) is untouched and stays the cheap floor; this layer is the
optional, composable step up.

## 3. Replay — `src/eval/replay.ts`

`replayTrajectory(path)` rebuilds the workspace from the header's fixture snapshot,
re-executes the recorded tool calls through the real `ToolRegistry` with the recorded
permission rules, and compares per call: the `ok` flag and the `outputSha`. Then it re-runs
the recorded grader specs and compares the verdict with the recorded outcome. No network,
no model. A tampered call or drifted tool output is reported per step with both previews.

## 4. Stuck detector — `src/core/stuck-detector.ts`

Five OpenHands-derived patterns (G12), pure module, 64-step bounded window:

| pattern | fires at |
|---|---|
| `repeated-action-observation` | 4th identical (action, observation) pair |
| `repeated-action-error` | 3rd failing repeat of the same action |
| `monologue` | 3rd consecutive assistant turn with no tool call |
| `ping-pong` | 6th action of a strict two-signature alternation |
| `context-window-thrash` | 2nd consecutive context-window error |

False-positive protections: poller exemption (`process`, `*_get_result`, `*_poll`), a
changed observation resets the repetition streak (progress forgives), user turns and
actions reset the monologue count, a third signature or immediate repeat breaks ping-pong,
and any non-error step resets the thrash count.

**Integration is deliberately absent** — the loop wiring has a single owner (coordinator
decision, 2026-09-14). Use it as middleware:

```ts
import { StuckDetector } from "./src/core/stuck-detector.ts";
const detector = new StuckDetector();
for await (const ev of agentLoop(/* … */)) {
  if (ev.type === "tool_execution_start") detector.observe({ kind: "action", tool: ev.tool, signature: sig(ev.args) });
  if (ev.type === "tool_execution_end") detector.observe({ kind: "observation", tool, signature: sig(ev.output), ok: ev.ok });
  if (detector.isStuck()) { /* represent / steer / stop — the owner's call */ }
}
```

`detectStuck(steps)` is the stateless batch form (tests, replay, offline analysis).

## 5. Redaction — `src/eval/redact.ts`

`redactSecrets` / `redactionReport` / `redactDeep` run before every persistence write.
Covers: Anthropic/OpenAI/AWS/GitHub/Google/Slack key shapes, Bearer + Basic auth values,
JWT triplets, PEM private-key blocks, and generic `key = "value"` assignments; sensitive
KEY names in structured args are redacted regardless of value shape. Deterministic and
idempotent — replays compare hashes of redacted text, so the replacement is a stable
literal (`[REDACTED:<kind>]`).

Scope note: `src/telemetry/otel.ts` records ids, sizes and outcomes only — it never carries
args or output, so it is deliberately NOT touched; `test/unit/eval-redact.test.ts` pins
that contract red if it ever erodes.

## 6. Offline eval script — `scripts/eval-offline.ts`

The CI gate: three gauntlet tasks recorded + graded behaviorally, each trajectory replayed,
the five stuck patterns + protections asserted, redaction spot-checked. Non-zero exit on
any failure; artifacts land in `.eval-results/` (gitignored, uploaded by CI).
