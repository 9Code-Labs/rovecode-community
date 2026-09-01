# Aion — Research-Derived Agent Harness

A production-oriented agent harness built from evidence-based analysis of 12 open-source reference harnesses (omp, pi, opencode, codex-rs, langgraph, aider, SWE-agent, letta, smolagents, swarm, phi, omp-best-of). Every architectural decision traces to a file:line-verified pattern in `research/` (see `research/architecture_decisions.md`).

## Status (2026-08-31)
- **Tests**: 57 pass / 0 fail (8 files: unit + integration)
- **Gauntlet**: 10/10 (basic, coding, failure-recovery, adversarial: loop-guard, huge-output, permission-bypass)
- **Benchmarks** (`aion bench`): anchored-edit workload 16–27ms (8 tool calls) vs 3ms raw-fs; session durability 500 append+replay+hash-chain in ~52ms

## Architecture

```
providers/stream.ts   StreamFn seam — never throws; errors are stopReasons (pi)
        ↓
core/loop.ts          one generator agentLoop: steering+follow-up drains,
                      truncation-fail, live context eviction, compaction,
                      cooperative abort, depth-threaded spawns
        ↓
core/tools.ts         validate → revise(hooks) → policy(deny-default, last-match)
                      → approve(revised args, cached) → execute → typed outcome
        ↓
core/session.ts       append-only JSONL tree: (id,parentId)+leaf, branch=rewind,
                      sha256 hash chain, corruption taxonomy
        ↓
coding/hashline.ts    TAG+LINE#HASH anchored edits, reverse-order apply,
                      nearest-match diagnostics, lint-gate revert, windowed read,
                      bash denylist + cwd lock + retry
        ↓
core/orchestrator.ts  spawn preflight (depth caps, policy), git-worktree/copy
                      isolation (win32-safe), derived child permissions,
                      patch merge-back
        ↓
memory/store.ts       bounded records: budgets, decay, dedup, provenance
        ↓
eval/                 scripted-provider gauntlet + deterministic benches
cli/main.ts           run / gauntlet / bench / tools / trace
```

## Quickstart

```bash
cd aion
bun test                          # 57 tests
bun run src/cli/main.ts gauntlet  # adversarial eval suite (10 tasks)
bun run src/cli/main.ts bench     # deterministic benchmarks
bun run src/cli/main.ts tools     # tool registry

# real model (any OpenAI-compatible endpoint):
AION_BASE_URL=https://api.deepseek.com/v1 AION_API_KEY=sk-... \
  bun run src/cli/main.ts run "fix the failing test in src/foo.ts"
```

## Configuration

Defaults < `aion.config.json` (planned) < env (`AION_BASE_URL`, `AION_API_KEY`) < CLI flags. Permission rules are deny-by-default with last-match wildcard evaluation:

```json
[
  { "action": "file.read",  "resource": "*",        "effect": "allow" },
  { "action": "shell.exec", "resource": "*",        "effect": "prompt" },
  { "action": "shell.exec", "resource": "rm *",     "effect": "deny"  },
  { "action": "file.write", "resource": ".env*",    "effect": "deny"  }
]
```

## Extending

- **Tool**: implement `Tool` (schema + kind + execute), `registry.register(t)`. Kind maps to policy action (`file.read/write`, `shell.exec`, `spawn`, `memory.write`).
- **Provider**: implement `StreamFn` — must not throw; failures become `{stopReason: "error"}`. `openaiCompatStream` covers any /chat/completions endpoint.
- **Agent**: `AgentDefinition` — systemPrompt (static or fn), tools, model, maxTurns (finite always), spawn policy.
- **Hooks**: `ExtensionHooks.reviseToolArgs` may rewrite args before policy+approval (approval always sees revised args — omp revision gate).

## Safety model (three stacked points)
1. **Policy**: deny-default wildcard rules (`core/tools.ts:evaluatePermissions`)
2. **Gate**: approval resolved on revised args; cached decisions; children cannot prompt
3. **Runtime**: bash denylist + cwd lock (NOT a sandbox — no OS seatbelt; use container/microVM for untrusted work, see research/baseline_comparison.md sandbox tiers)

## Observability
Every run emits a typed `RunEvent` stream (run_start → turn_start → message_update → tool_execution_* → compaction → turn_end → run_end) persisted alongside the session tree. `aion trace <session-id>` replays any session and surfaces corruption findings.

## Known limitations
- No OS-level sandbox (denylist only) — documented, deliberate scope cut
- No repo-map (aider PageRank) yet — reserved chunk name in context assembly
- No provider-native compaction; single head-summarize strategy
- Memory store has no self-edit tool yet (flags declared, unwired)
- Windows-first shell paths; POSIX paths exercised via Git-for-Windows bash

## Roadmap
1. OS sandbox rung (Windows AppContainer / Linux bubblewrap delegate)
2. Repo-map chunk (tree-sitter + ranking, token-budgeted)
3. Memory self-edit tool + sleeptime background agents
4. Best-of-N selection with capability preflight (omp-best-of pattern)
5. Provider-native compaction strategies
