# Aion — Research-Derived Agent Harness

A best-of-OSS agent harness in TypeScript on Bun. Instead of inventing architecture, aion ports
evidence-based patterns from open-source harnesses (pi, opencode, codex, cline, aider, gemini-cli,
oh-my-pi, hermes-agent, senpi, prime-agent, OpenHands) — every port traces to file:line in a
snapshotted source and lands only after an independent fresh-context critic verifies it against a
pre-written bar (ledger: `PORTS.md` at the workspace root).

## Status (2026-09-01, post wave 2)

- **All 20 BLUEPRINT §3 ports landed** (P1 8/8 · P2 6/6 · P3 4/4 · P4 2/2)
- **Tests**: 650 pass / 0 fail (53 files, unit + integration)
- **Gauntlet**: 10/10 (basic, coding, failure-recovery, adversarial: loop-guard, huge-output, permission-bypass)
- **Typecheck**: 0 errors · TUI render smoke: PASS

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
/checkpoints /restore /skills /memory /exit`.

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
- `.aion/` also holds sessions, checkpoints, repo-map cache
- Permission rules: deny-by-default, last-match wildcard (`file.read/write`, `shell.exec`, `spawn`, `memory.write`, `tool.*`); `--yolo`/`AION_YOLO=1` bypasses prompts but not deny rules in plan mode

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
  (`server > log 2>&1 &`), as before. The runner always settles within ~0.5 s of the abort even if an
  orphan holds a pipe end: output so far + `[output truncated: process tree terminated on abort]`, exit 143.
- **Sandbox rungs delegate, they do not isolate.** `wsl`/`docker` (#27) isolate only as well as the
  wrapped runtime does; `direct` (the default) is denylist + cwd lock. The executor seam is process-wide:
  `aion serve`/`aion acp` sessions booted from different project dirs share the most recently booted
  session's rung. `aion gauntlet` always runs `direct` (it never builds a runtime).
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
  sync or async: `pre_run`, `post_run`, `pre_tool` (return `{deny: reason}` to block), `post_tool` (return
  `{output}` to annotate what the model sees, growth-bounded), `approval` (return `"allow"`/`"deny"` to
  pre-answer a prompt), `compaction`, `session_open`, `session_close`, `on_event` (every RunEvent, not
  awaited). Every call is timeout-bounded (`AION_HOOK_TIMEOUT_MS`, default 5000) and isolated — a throwing
  or hanging hook is one warning note, never a dead run. Policy wins: rules run before `pre_tool` (a hook
  can only deny, in every mode incl. yolo) and the approval hook only answers prompts policy allowed to be
  asked. Hooks are trusted code run in-process (same class as `.aion/mcp.json`); loaded once per process,
  restart to pick up edits; `AION_NO_HOOKS=1` skips the files. The programmatic
  `ExtensionHooks.reviseToolArgs` still rewrites args before policy + approval (approval sees revised args).
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
