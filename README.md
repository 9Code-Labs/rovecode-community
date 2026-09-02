# Aion — Research-Derived Agent Harness

A best-of-OSS agent harness in TypeScript on Bun. Instead of inventing architecture, aion ports
evidence-based patterns from open-source harnesses (pi, opencode, codex, cline, aider, gemini-cli,
oh-my-pi, hermes-agent, senpi, prime-agent, OpenHands) — every port traces to file:line in a
snapshotted source and lands only after an independent fresh-context critic verifies it against a
pre-written bar (ledger: `PORTS.md` at the workspace root).

## Status (2026-09-02, post wave 3)

- **All 20 BLUEPRINT §3 ports landed** (P1 8/8 · P2 6/6 · P3 4/4 · P4 2/2) **+ all 19 Wave-3 parity ports (#21–#39)** landed
  through the gauntlet-loop (builder → fresh-context critic → fix wave → re-verify; ledger: `PORTS.md`)
- **Tests**: 1499 pass / 0 fail / 1 skip (104 files, unit + integration; run in ≤4-file chunks)
- **Gauntlet**: 10/10 (basic, coding, failure-recovery, adversarial: loop-guard, huge-output, permission-bypass)
- **Typecheck**: 0 errors · TUI render smoke: PASS
- **Wave 4 in progress**: the sextant surface (`src/sextant/*`, a new default TUI ported from the user's prototype) — core,
  model/panels and pet landed; renderer integration building; the current pi-tui surface stays available as `--classic`

## Install

Requires [Bun](https://bun.sh) ≥ 1.3.14 (the CLI entry is TypeScript, executed by bun — node cannot run it).

```bash
# from source
cd aion && bun install
bun run src/cli/main.ts --help          # or: bun link  → `aion` on PATH

# single binary (~110 MB: bun runtime + bundled deps + embedded native addons)
bun run build                           # scripts/build.ts → dist/aion(.exe) + smoke
dist/aion.exe --version

# from an npm tarball (npm pack) — global install shims to bun via the shebang
npm install -g ./aion-0.2.0.tgz
```

Not yet published to the npm registry (name availability unverified; no self-update — rebuild or
reinstall to update).

## Quickstart

```bash
aion                        # TUI chat (default surface; --plain = readline REPL)
aion "fix the failing test" # one-shot task
aion run "<prompt>" --yolo  # one-shot, all tool approvals granted
aion run "<prompt>" --output json    # ONE result object on stdout (ndjson: one line per RunEvent + a result line)
aion run "/review src/x.ts" # a leading /name expands .aion/commands/<name>.md (custom slash command) headlessly
aion gauntlet               # adversarial eval suite (offline, deterministic, 10 tasks)
aion bench                  # cross-harness micro-benchmarks
aion tools                  # registered tool listing
aion auth set <provider>    # store an API key (prompted on the terminal, never echoed); auth list / auth remove
aion trace <session-id>     # replay a session's JSONL tree
aion acp                    # Agent Client Protocol v1 over stdio (Zed/JetBrains)
aion serve                  # headless HTTP + SSE server (AION_PORT, loopback-only)
```

Without a provider configured, one-shot runs use a scripted mock provider (also how the packaging
smoke works). For a real model, store a key once:

```bash
aion auth set anthropic                  # prompts for ANTHROPIC_API_KEY — never echoed, never logged
aion auth set kaesra --key MY_PROXY_KEY  # override the key name recorded for a provider
aion auth list                           # stored providers + key names, values redacted (first 4 chars)
aion auth remove anthropic
aion auth set openai < key.txt           # piped stdin: reads one line, no prompt (scripts)
```

Keys live in `~/.aion/credentials.json` (`AION_HOME` overrides the directory). On POSIX the file is
written 0600 inside a 0700 directory. On Windows, mode bits are not enforced — the file is protected
by the NTFS ACL of your user profile (`%USERPROFILE%`, which `~/.aion` inherits), not by permission
bits. Stored keys beat `<NAME>_API_KEY` env vars; an explicit `AION_BASE_URL`/`AION_API_KEY` pair
beats both.

Or configure by env:

```bash
AION_BASE_URL=... AION_API_KEY=...   # any OpenAI-compatible or Anthropic endpoint (always wins)
OPENAI_API_KEY=... / ANTHROPIC_API_KEY=... / DEEPSEEK_API_KEY=... / GROQ_API_KEY=...  # named providers
AION_MODEL=zai-org/glm-5.3           # model id
AION_MODEL_DEFAULT=prov/a,prov/b     # role fallback chains (DEFAULT SMOL PLAN COMMIT TASK); advance on 429/5xx
```

TUI slash commands: `/help /status /cost /model /yolo /plan /act /rewind /sessions /resume /new
/checkpoints /restore /skills /memory /export /todos /tasks /exit`, plus one `/name` per custom command
file in `.aion/commands/` (project) or `~/.aion/commands/` (user scope).

## Features beyond the 20 ports (wave 3, verified per port in `PORTS.md`)

- **Custom slash commands** (#30) — `.aion/commands/<name>.md` (project shadows `~/.aion/commands/`):
  optional frontmatter `description:` / `model:` (per-run override, restored after) / `mode: plan|act`
  (durable switch), body = prompt template with `$ARGUMENTS`, `$1..$9`, `$$`; autocomplete + `/help`
  list them; a built-in name always wins (boot warning). `aion run "/name args"` expands the same files
  headlessly (model:/mode: are TUI-only there). Arguments reach the template raw — whitespace runs and
  pasted newlines survive.
- **Todo list** (#32) — `todo_write`/`todo_read` keep one `todos.json` per session (whole-list replace,
  one `in_progress` at a time, bounded); `/todos` renders it as checkboxes and the status bar shows
  `todos done/total`. Plan mode keeps `todo_write` (the plan's own artifact) while denying every other write.
- **Background tasks** (#26) — the `task` tool starts child agent sessions as bounded FIFO jobs
  (`AION_TASKS_MAX`, default 3) through the ONE agent loop; completion notes land on the parent's next
  turn as steering; `/tasks` lists them, `/tasks cancel <id>|all` cancels; quitting the TUI, `aion serve`
  `stop()` and `aion acp` shutdown cancel every live child; `GET /session/:id/tasks` over HTTP.
- **ask_user** (#33) — the model asks a question through a modal overlay (options or free text) on
  interactive surfaces; headless surfaces fail the tool closed.
- **web_fetch** (#31) — bounded, SSRF-guarded HTTP fetch (`net.fetch <host>` policy action; prompt by
  default; `AION_WEBFETCH_TIMEOUT_MS`, `AION_WEBFETCH_ALLOW_PRIVATE=1`).
- **Output modes** (#35) — `aion run --output text|json|ndjson`: `json` = exactly ONE result object
  `{status, summary, sessionId, model, origin, usage, costUsd, toolCalls, durationMs, exitCode}` on stdout;
  `ndjson` = every RunEvent as a JSON line then a final `{type:"result"}` line; stdout is JSON-only
  (progress → stderr; the guard is up before the runtime boots, so even a `session_open` hook's prints land
  on stderr); `--output=<mode>` also accepted; exit 0 done · 1 error/budget · 2 usage/startup
  error (one stderr line, nothing on stdout — validated before the runtime boots) · 130 aborted.
- **Reflection** (#28, aider pattern) — a failed `edit`/`write` (or one that introduces LSP diagnostics)
  gets ONE `reflection: …` nudge on the next turn with the error in context, capped at 2 per run
  (`AION_REFLECTION_MAX`; `AION_REFLECTION=0` disables); identical repeat failures are not re-nudged and
  the loop guard still fires. Nudges serve the active session's runs only — a background-task child gets
  none (its loop guard still bounds repeats; its failure text reaches the parent through the task note).
  Failed edits now report the anchor line's current text and hash, the lines
  that do match, and the read-then-retry remedy; `write` into a missing directory says so.
- Also landed: first-class `glob`/`grep`/`ls` tools (#22), same-model retry with backoff (#23), diff
  previews in approval overlays (#24), compaction strategies (#25), per-project sandbox rung (#27),
  `aion export` (#38), `aion auth` credential onboarding (#37), packaging (#36).

## What's ported (the 20 landed ports)

Full ledger with bars, critic verdicts, and evidence: workspace `PORTS.md`. Sources are MIT or
Apache-2.0 only; Apache attributions in `THIRD_PARTY_NOTICES.md`.

**Surfaces**
- #1 differential-render TUI, vendored pi-tui behind a `Renderer` seam (pi, MIT)
- #2 branch navigator + rewind/edit-resubmit over the session DAG (pi pattern, MIT)
- #15 ACP v1 endpoint for Zed/JetBrains via the official SDK (Apache-2.0)
- #19 headless HTTP server: sessions, SSE RunEvents, OpenAPI at `/doc` (opencode design, MIT)
- #20 Plan/Act modes with per-mode model config, plan = read-only tool rules (cline, Apache-2.0)

**Providers**
- #5 prompt-cache boundaries (`cache_control`) + normalized usage accounting (hermes pattern + tokenlens, MIT)
- #6 models.dev pricing/context catalog, offline snapshot, `/cost` (OSS)
- #7 tool-call middleware: XML/Hermes/JSON-in-text parsed to native tool calls for non-native models (senpi, MIT)
- #14 role routers + fallback chains + rate-limit chain advance (OMP, MIT + gemini-cli, Apache-2.0)

**Coding**
- #11 shadow-git checkpoints, 3 restore modes, user `.git` never touched (cline, Apache-2.0)
- #12 repo-map: tree-sitter (@ast-grep) symbols + PageRank, budgeted context chunk, persistent cache (aider, Apache-2.0)
- #13 LSP diagnostics gate after edits (opencode/OMP, MIT)

**Safety & execution**
- #4 tool-loop guardrails: repeat-signature loop break, duplicate-result stubs (hermes-agent, MIT)
- #9 execpolicy: declarative command policy, strictest-wins, forbidden never executes (openai/codex, Apache-2.0)
- #10 executor sandbox ladder: direct/WSL2/Docker rungs behind one `Executor` seam, probed not assumed (codex + OpenHands patterns); #27 makes the rung selectable per project (`.aion/sandbox.json` / `AION_SANDBOX`)

**Memory & context**
- #3 MCP client, stdio + HTTP, lazy disclosure (two registry tools, ~0 idle token cost) (MIT)
- #8 config inheritance: AGENTS.md / CLAUDE.md / .claude / .cursor / .github instructions harvested into capped chunks (oh-my-pi, MIT)
- #16 versioned memory/skill edits with optimistic concurrency + one-call rollback (prime-agent, MIT)
- #17 cross-session recall: FTS over past session JSONL (hermes-agent, MIT)
- #18 persistent eval cell / code-mode, feature-flagged `AION_EVAL_CELL=1` (OMP/prime/codex patterns)

## Architecture

```
providers/stream.ts    StreamFn seam — never throws; errors are stopReasons
  + middleware.ts        text tool-calls → native parts (non-native models)
  + router.ts            role tables + fallback chains
  + cache.ts, catalog.ts prompt-cache boundaries, usage, pricing
        ↓
core/loop.ts           ONE generator agentLoop: steering/follow-up drains,
                       eviction, compaction, guardrails, depth-threaded spawns
        ↓
core/tools.ts          validate → revise(hooks) → policy(deny-default, last-match)
                       → approve(revised args, cached) → execute → typed outcome
  + execpolicy.ts        declarative command rules (allow/prompt/deny/forbidden)
  + guardrails.ts        loop signatures + duplicate stubs
        ↓
core/session.ts        append-only JSONL tree: branch=rewind, sha256 hash chain
coding/                hashline anchored edits · repomap · lsp gate · checkpoints
memory/                bounded blocks + versioned edits + cross-session recall
mcp/ acp/ server/ tui/ surfaces over the same loop (no second loop generation)
eval/                  scripted-provider gauntlet + deterministic benches
```

## Configuration

Defaults < project config chunks (harvested, capped) < env < CLI flags.

- `.aion/mcp.json` (+ harvested `.mcp.json`) — MCP servers
- `.aion/modes.json` — per-mode model config (TUI-scoped; see limitations)
- `.aion/sandbox.json` — `{"rung": "direct"|"wsl"|"docker", "dockerImage"?: "…"}` selects where `bash` runs (#27);
  `AION_SANDBOX=<rung>` / `AION_SANDBOX_IMAGE=<image>` override it; default `direct`
- `.aion/commands/*.md` — custom slash commands (project scope); `~/.aion/commands/*.md` (user scope,
  `AION_HOME`-aware) is scanned first and shadowed by the project's (#30)
- `.aion/` also holds sessions (each with its `todos.json`), checkpoints, repo-map cache
- Permission rules: deny-by-default, last-match wildcard (`file.read/write`, `shell.exec`, `spawn`, `memory.write`, `net.fetch`, `tool.*`); `--yolo`/`AION_YOLO=1` bypasses prompts but not deny rules in plan mode
- `.aion/hooks.ts` (+ `~/.aion/hooks.ts`, `AION_HOME`-aware) — typed hook set (#29; see Extending → Hooks);
  `AION_NO_HOOKS=1` skips the files, `AION_HOOK_TIMEOUT_MS` bounds every call

Environment knobs (`aion help` prints the same list):

- `AION_BASE_URL` / `AION_API_KEY` — any OpenAI-compatible or Anthropic endpoint; always wins over stored and named keys
- `AION_MODEL` — model id; `AION_MODEL_<ROLE>` — fallback chain per role (DEFAULT SMOL PLAN COMMIT TASK), comma-separated
  `provider/model`, advancing on 429/5xx (#14)
- `AION_RETRY_MAX` (default 3; 0 = off) / `AION_RETRY_BASE_MS` (default 2000) — same-model retries on 429/5xx/transport
  failures with exponential backoff, full jitter and `Retry-After` honored; wired INSIDE the router so retries exhaust
  before the chain advances (#23); each retry is reported like a router note
- `AION_WEBFETCH_TIMEOUT_MS` (default 30000) / `AION_WEBFETCH_ALLOW_PRIVATE=1` — `web_fetch` timeout and the SSRF-guard
  escape for loopback/private hosts (local dev servers) (#31)
- `AION_COMPACTION` — `head-summarize` (default) | `keep-window` | `provider-native` (#25)
- `AION_TASKS_MAX` (default 3) — concurrent background tasks; extra `task start`s queue FIFO (#26)
- `AION_OTEL_ENDPOINT` (e.g. `http://host:4318`) — OTLP/HTTP collector; exports one trace per run (`aion.run` ⊃
  `aion.turn` ⊃ `aion.tool`) with token/latency/cost attributes; unset = off, the exporter is never constructed (#39);
  `AION_OTEL_HEADERS=k=v,k2=v2` — extra OTLP headers (e.g. `authorization=Bearer …`)
- `AION_REFLECTION=0` disables the reflection nudges; `AION_REFLECTION_MAX` (default 2) caps them per run (#28)
- `AION_SANDBOX` / `AION_SANDBOX_IMAGE` — executor rung for `bash` and the docker image (#27)
- `--output text|json|ndjson` (flag, `aion run` only) — output mode (#35); `AION_YOLO=1` — allow all tool actions;
  `AION_STREAM=sse` — raw SSE adapter; `AION_HOME` — credentials + user-scope commands dir (default `~/.aion`)
- Kill switches / budgets: `AION_NO_CHECKPOINTS=1`, `AION_NO_REPOMAP=1`, `AION_REPOMAP_TOKENS`,
  `AION_NO_TOOL_MIDDLEWARE=1`, `AION_TOOL_MIDDLEWARE=1`, `AION_EVAL_CELL=1`

## Safety model (stacked, honest)

1. **Policy** — deny-default wildcard rules, evaluated on revised args
2. **execpolicy** — declarative per-command verdicts; `forbidden` never reaches execution or a human
3. **Gate** — approvals resolved on revised args, cached; child agents cannot prompt
4. **Runtime** — bash denylist + cwd lock + output truncation

This is **not an OS sandbox**. Where `bash` runs is selectable (#10 seam + #27 config):
`.aion/sandbox.json` `{"rung": "direct"|"wsl"|"docker", "dockerImage"?: "…"}`, or `AION_SANDBOX=<rung>`
(+ `AION_SANDBOX_IMAGE`; env beats file; default `direct`). Every rung is **delegation, not isolation**:
`direct` is in-process bash with the denylist + cwd lock; `wsl` runs each command through `wsl.exe` in the
default distro, which must contain bash (Docker Desktop's `docker-desktop` distro has none — set a real
distro as default); `docker` runs each command in `docker run --rm -v <cwd>:/workspace <image>` and needs a
running daemon plus an image with bash (default `debian:stable-slim`). A configured rung is probed at boot
by a 500 ms trial through its own wrapper (`wsl.exe --exec bash -c true` / `docker run --rm <image> bash -c
true`); an unavailable rung is a one-line startup error on every entrypoint (`run`/TUI/`--plain` exit 2,
`serve` 503, `acp` JSON-RPC error) — never a silent fallback to `direct`. A cold WSL utility VM can exceed
the cap and report unavailable: warm it (`wsl.exe --exec bash -c true`) and retry. `/status` shows the
active rung. Use a container/microVM for untrusted work.

## Observability

**OTel spans** (#39, `telemetry/otel.ts`): set `AION_OTEL_ENDPOINT` and every run exports one trace as
OTLP/HTTP JSON — `aion.run` ⊃ `aion.turn` (one per model step) ⊃ `aion.tool`, with per-span tokens, latency,
served model and cost (omitted when unpriced), compaction and never-dispatched calls as span events; ids, sizes
and outcomes only (no goal, args, output or headers). Batched once per run, 5 s timeout, a failed export is one
`hooks:` warning and never blocks a run. Cancelled runs export too (Esc, `session/cancel`, HTTP DELETE or a
client disconnect → status `stopped`); `aion.tool_calls` counts issued calls, the `--output json` `toolCalls`
count. Unset = zero cost: the exporter is never constructed; a malformed endpoint is one warning, not a stall.

Typed `RunEvent` stream (run/turn/tool/compaction events) persisted with the session tree;
`aion trace <id>` replays any session with corruption findings. `/cost` and `/status` surface
tokens, cache hits, and catalog-priced spend.

## Known limitations

- **Cancellation is mid-turn; how far the kill reaches is platform-specific.** Esc/`session/cancel`/HTTP
  DELETE abort the run's controller: the in-flight provider fetch dies (≤2 ms measured) and the running
  `bash` call is killed. Windows: the launcher is placed in a kernel Job Object right after spawn, so the
  abort terminates the whole tree — compound, nested `bash -c`, and backgrounded children included —
  with `taskkill /T /F` as a sweep; a box without `bun:ffi`/kernel32 job objects falls back to taskkill
  alone, which reaches the shell but not msys children whose forked stub already exited. POSIX: the shell
  gets SIGTERM and never runs its next statement, but a forked grandchild (`sleep`, `npm`, `python` inside
  a compound command) is orphaned and finishes on its own — no process-group kill yet. Never reached: work
  already handed to another process tree (a container started by the `docker` rung outlives its
  `docker run` client; a WSL-side process may outlive `wsl.exe`; services, COM- or `schtasks`-launched
  programs). A command that completes on its own keeps its deliberately backgrounded daemon
  (`server > log 2>&1 &`), as before. The runner always settles within ~0.5 s of the abort, even one that
  lands after the launcher already exited while an unredirected child it left behind (`sleep 600 & echo
  started`) still holds a pipe end — the job kill reaches that child (measured 3 ms; exit 143); an orphan
  outside the tree that keeps a pipe end open past the kill yields output so far + `[output truncated:
  process tree terminated on abort]`, exit 143.
- **Sandbox rungs delegate, they do not isolate.** `wsl`/`docker` (#27) isolate only as well as the
  wrapped runtime does; `direct` (the default) is denylist + cwd lock. The executor seam is process-wide:
  `aion serve`/`aion acp` sessions booted from different project dirs share the most recently booted
  session's rung. `aion gauntlet` always runs `direct` (it never builds a runtime).
- **ACP is the one surface that mixes cwds.** `aion acp` boots a runtime per `session/new` cwd on that
  process-wide seam: a `session/new` REFUSED because its cwd asks for a rung this machine cannot provide
  (JSON-RPC error) still leaves the seam holding that unmet rung, so existing sessions' `bash` calls fail
  with the rung error until a later `session/new` boots successfully. Keep one editor window per project,
  or every project on the same rung.
- **Plan/Act modes are TUI-scoped.** `run`/`acp`/`serve` ignore `.aion/modes.json` including
  `defaultMode`.
- **Server sessions are in-memory.** `aion serve` loses its session routing table on restart
  (JSONL trees persist on disk).
- **Windows-first.** Developed and gated on Windows 11 + Git Bash; POSIX paths exercised in tests
  but Linux/macOS are not CI-verified.
- **Packaging**: no LICENSE file yet — the package.json `license` field is intentionally unset
  pending an owner decision; not published to npm; compiled binary is ~110 MB (bun runtime).

## Extending

- **Tool**: implement `Tool` (schema + kind + execute), `registry.register(t)`; kind maps to a policy action.
- **Provider**: implement `StreamFn` — must not throw; failures become `{stopReason: "error"}`.
- **Hooks** (`core/hooks.ts`, port #29): drop a `.aion/hooks.ts` (or `.js`; user scope `~/.aion/hooks.*`)
  exporting `{ version: 1, hooks: {…} }` — plain `import`, no build step. Nine typed hooks, all optional,
  sync or async: `pre_run`, `post_run` (also fired, as `stopped`, when the consumer cancels a run mid-way),
  `pre_tool` (return `{deny: reason}` to block), `post_tool` (return
  `{output}` to annotate what the model sees, growth-bounded), `approval` (return `"allow"`/`"deny"` to
  pre-answer a prompt), `compaction`, `session_open`, `session_close`, `on_event` (every RunEvent, not
  awaited). Every call is timeout-bounded (`AION_HOOK_TIMEOUT_MS`, default 5000) and isolated — a throwing
  or hanging hook is one warning note, never a dead run. Policy wins: rules run before `pre_tool` (a hook
  can only deny, in every mode incl. yolo, and the same hooks govern background-task children); the
  approval hook sits where the human would, INSIDE the execpolicy wrap (rules → execpolicy → hook →
  human): forbidden argv is denied before any hook sees it, allow-listed argv runs without asking one, and
  a hook `"allow"` is exactly a human's one-shot yes (never cached). Hooks receive copies of args and
  results — only a returned value counts. Hooks are trusted code run in-process (same class as
  `.aion/mcp.json`); loaded once per process, restart to pick up edits; `AION_NO_HOOKS=1` skips the files.
  The programmatic `ExtensionHooks.reviseToolArgs` still rewrites args before policy + approval (approval
  sees revised args).
- **MCP**: add servers to `.aion/mcp.json`; tools arrive lazily through `mcp_list`/`mcp_call` under the same policy pipeline.

## License & notices

Third-party attributions (Apache-2.0 NOTICE entries + MIT credits): `THIRD_PARTY_NOTICES.md`
(shipped in the npm tarball; source of truth lives at the workspace root). No code from crush
(FSL), claw-code, nanocoder, iflow, or the Claude Agent SDK. Aion's own license: not yet declared.

## Roadmap (wave 3, `PORTS.md` §Wave-3)

Ports #21–#39: mid-turn cancellation, first-class grep/glob/ls tools, retry-with-backoff,
approval diff previews, compaction v2, background subagents, sandbox rung config, reflection
retries, hooks v2, custom slash commands, web fetch, todo/ask_user tools, image input,
JSON/NDJSON output modes, session export, OTel spans.
