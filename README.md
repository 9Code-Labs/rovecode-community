# Rovecode

A coding agent for the terminal. The cockpit is a panelled TUI called sextant; the mascot is a
weather cloud whose mood follows the run. Under the hood, rovecode is a research-derived harness in
TypeScript on Bun: instead of inventing architecture it ports evidence-based patterns from open-source
harnesses (pi, opencode, codex, cline, aider, gemini-cli, oh-my-pi, hermes-agent, senpi, prime-agent,
OpenHands) — every port traces to file:line in a snapshotted source and lands only after an independent
fresh-context critic verifies it against a pre-written bar (ledger: `PORTS.md`, kept outside this
repository for now).

![The sextant TUI at 160×44 cells: the files tree with git statuses, the code panel on src/auth/callback.ts with edited lines highlighted, the messages panel with read and edit tool rows and an approval card asking to run bun test, the plan at step 1 of 4, usage at 13% context, and the rovecode cloud pet waiting for a nod.](https://raw.githubusercontent.com/9Code-Labs/rovecode-site/main/public/shots/approval-160x44.png)

## Status (2026-09-04, post wave 4)

- **All 20 BLUEPRINT §3 ports landed** (P1 8/8 · P2 6/6 · P3 4/4 · P4 2/2) **+ all 19 Wave-3 parity ports (#21–#39)** landed
  through the gauntlet-loop (builder → fresh-context critic → fix wave → re-verify; ledger: `PORTS.md`)
- **Tests**: 2360 pass / 0 fail (191 files, unit + integration; measured 2026-09-06). CI runs the
  same suite on `ubuntu-latest` (`.github/workflows/ci.yml`), so POSIX paths are gated, not just exercised.
  `bun test` runs against an **empty `ROVECODE_HOME`**: `bunfig.toml` preloads `test/helpers/isolate-home.ts`,
  which points it at a fresh temp directory before any test file loads and clears every `*_API_KEY`,
  `GITHUB_TOKEN`/`GH_TOKEN` and `ROVECODE_*` variable, so the skills, plugins, MCP servers and keys installed
  or exported on the machine cannot decide a result (installing one skill used to fail a plugin test, two MCP
  servers failed twenty-five, and an exported `ANTHROPIC_API_KEY` let a headless run on a clean checkout bill
  a real call). A test that wants a home or a variable of its own still sets it itself
- **Gauntlet**: 10/10 (basic, coding, failure-recovery, adversarial: loop-guard, huge-output, permission-bypass)
- **Typecheck**: 0 errors · TUI render smoke: PASS
- **Wave 4**: the sextant surface (`src/sextant/*`, the new default TUI ported from the user's prototype) is merged —
  core, model/panels, code/messages, input, pet, crew board and the renderer integration; external agentic-CLI
  lanes (#47) are not implemented in this repository; the pi-tui chat stays available as `--classic`
- **After wave 4**, the ports ledger stops covering what shipped. Also landed:
  - the **interface-design protocol** (`src/design`, `docs/design.md`): no default look, `design_direction`
    records the direction the human chose, `design_audit` checks later screens against it, and a headless run
    records a *provisional* direction instead of passing its own taste off as a decision
  - **three permission tiers** (ask first · accept edits · auto) with `.rovecode/settings.json` to persist one
  - the **plugin format** (`src/plugins`) and the **MCP market with its project trust gate** (`src/mcp`)
  - **model profiles** (`src/providers/profiles.ts`) and one **thinking dial** across every provider dialect
    (`docs/thinking.md`; `rovecode model show` prints what your model receives per level)
  - **run budgets** — `--max-turns` / `--max-seconds`, so a spiral ends in a result instead of an outside kill
  - a decided **wire-failure policy** (`docs/wire-failures.md`): what is retried, what is never retried after
    text has arrived, and the wait announced while it happens
  - the **site** ([its own repo](https://github.com/9Code-Labs/rovecode-site), 15 languages, prerendered, [live](http://64.177.43.110/)) and the CI/CD workflows
    that build and ship it
  - **sextant** gained mouse and scrollbar dragging, the page tab strip, the notices history and prompt suggestions
  - **startup** is lazy: `rovecode --help` no longer boots the TUI, the loop, the runtime or the plugin scanner

## Install

Requires [Bun](https://bun.sh) ≥ 1.3.14 (the CLI entry is TypeScript, executed by bun — node cannot run it).

```bash
# from source
git clone https://github.com/9Code-Labs/rovecode.git && cd rovecode && bun install
bun run src/cli/main.ts --help          # or: bun link → `rovecode` on PATH
bun run build:cli                       # optional: pre-bundle (TUI cold start ~230 ms → ~80 ms); re-run after git pull

# single binary (~110 MB: bun runtime + bundled deps + embedded native addons)
bun run build                           # scripts/build.ts → dist/rovecode(.exe) + smoke
dist/rovecode.exe --version

# from an npm tarball (npm pack) — global install shims to bun via the shebang
npm install -g ./rovecode-0.3.1.tgz
```

Not yet published to the npm registry (name availability unverified). Releases are cut on
[GitHub Releases](https://github.com/9Code-Labs/rovecode/releases) — v0.3.1 is the current one — and there is no
self-update: `git pull` and rebuild, or reinstall the binary. Rovecode does tell you when that is worth doing: the
TUI's startup card carries `update available: 0.3.0 → 0.4.0 · <release url>` when a newer release exists. The check
(`src/core/update-check.ts`) asks GitHub once every six hours (cached in `~/.rovecode/update-check.json`), never
blocks the start and never throws. The repository is private, so it needs `GITHUB_TOKEN`, `GH_TOKEN` or a
`gh auth login`; without one the result is "unknown — the release repository is private and no token is set",
never "up to date", and the card prints nothing rather than a guess. Only a real newer release produces a line
on the card — `rovecode --version` prints the version to stdout alone (so a script can still read it) and, on
stderr, whatever the last check found. It reads the cache and never opens a socket: a courtesy line must not
make the one command scripts call to identify a build wait on the network.

## Quickstart

On a terminal, `rovecode` opens with a ~1.1 s intro centred on a cleared screen (`src/core/intro.ts`): the
ROVECODE mark fills in left to right, a hairline frame draws inward from the four corners until the halves meet,
the cloud mascot leans down out of that top line, and the mark breathes once. The session boots underneath it, in
parallel, so the only wall time this adds is whatever is left of the show once the session is otherwise ready.
Skip it with `--no-intro` or `ROVECODE_INTRO=0`; nothing is drawn into a pipe or under `--plain`, and it never
reads stdin, so keys typed during it reach the session. It hands over to a card that names the version, the connected
model, what loaded (`3 skills · 1 plugin · 2 MCP servers` — zeroes are omitted), the folder and permission tier,
and, only when there is one, the newer release (see Install). A resumed session gets a one-line note instead; a
terminal narrower than the mark gets the same facts as prose.

```bash
rovecode connect                # connect a model, step by step: pick a provider, paste the key (hidden), one
                                # test call
rovecode connect anthropic      # the same in one line — see Providers for the flags (rovecode setup = the
                                # wizard)
rovecode                        # TUI chat — sextant on a colour TTY ≥ 100×30 (truecolor or 256), else the
                                # classic chat
rovecode --classic              # force the classic chat; --plain = readline REPL; --pet <name> names the
                                # sextant pet
rovecode "fix the failing test" # one-shot task
rovecode run "<prompt>" --yolo  # one-shot in auto mode (never asks)
rovecode --effort high          # how hard the model thinks first: auto (default) | off | low | medium | high
                                # (/effort in the TUI, ROVECODE_EFFORT=…). auto sends no thinking field and
                                # leaves the endpoint's own default standing. Anthropic takes
                                # output_config.effort or a thinking budget depending on the model — rovecode
                                # learns which from the endpoint's own 400 and remembers it; OpenAI takes
                                # reasoning_effort. Billed as output tokens. `rovecode model show` prints what
                                # YOUR model receives per level (docs/thinking.md).
rovecode --accept-edits         # middle tier: writes INSIDE this folder stop asking; shell, subagents,
/yolo --save                  # make it stick: the level is written to ~/.rovecode/settings.json and the
/accept-edits --save --project  # next launch starts there. --project pins it to this checkout instead.
                                # Ladder: CLI flag > ROVECODE_PERMISSION > .rovecode/settings.json (project) >
                                # ~/.rovecode/settings.json (user) > ask. Without --save a toggle lasts one
                                # session. network and writes outside it still ask (/accept-edits ·
                                # ROVECODE_ACCEPT_EDITS=1 · or the `all edits` button on a write approval
                                # card)
                                # The same file takes "bell": false — both TUIs notify you (bell, or an
                                # OSC 9 toast where the terminal shows one) when a run ends or a card
                                # needs you, ONLY while the terminal is unfocused; off with that key.
@src/auth.ts why does this fail  # @file attaches the file to the message as a `read` would return it —
                                # contents + edit anchors, no tool round-trip. Capped and said: 400 lines
                                # per file (the footer names the offset to continue), 8 files, ~60k chars
                                # per message; a directory, a binary, a 2 MB+ file or a path outside the
                                # workspace is named and left out. The panel shows one chip per file.
rovecode run "<prompt>" --output json    # ONE result object on stdout (ndjson: one line per RunEvent + a
                                         # result line)
rovecode run "<prompt>" --max-seconds 300 --max-turns 40  # ceilings on one run: a hit ends it cleanly with
                                                          # status "budget" (exit 1) and the work so far, not
                                                          # an outside kill. A headless run already has a
                                                          # 20-minute clock (--max-seconds off removes it);
                                                          # ROVECODE_MAX_TURNS / ROVECODE_MAX_SECONDS set both
                                                          # on every surface, TUI included
rovecode run "/review src/x.ts" # a leading /name expands .rovecode/commands/<name>.md (a custom slash
                                # command) headlessly
rovecode gauntlet               # adversarial eval suite (offline, deterministic, 10 tasks)
rovecode gauntlet --live        # 9 of those tasks against the configured REAL model, through the real prompt
                                # (--model provider/model, --effort …): the before/after instrument for prompt
                                # work
rovecode bench                  # cross-harness micro-benchmarks
rovecode tools                  # registered tool listing
rovecode auth set <provider>    # store an API key (prompted on the terminal, never echoed); auth list / auth
                                # remove
rovecode provider add <id> <url>  # register any OpenAI-compatible or Anthropic endpoint — live, no
                                  # restart; also provider list|test
rovecode model                # pick from a numbered menu of every configured provider's models
rovecode models               # just list them (* = current); alias for `model list`
rovecode model use <provider/model>  # persist the default model directly (--project pins it to this repo)
rovecode model show           # the model, its protocol, and the exact thinking field each --effort level
                              # sends
rovecode sessions [--json]      # this folder's sessions, newest first (+ a footer counting empty session dirs)
rovecode sessions rename|delete|fork|search   # name, remove (with its checkpoints), copy or search sessions —
                                # ids are exact or a unique prefix; ambiguous/unknown → exit 2, nothing touched
rovecode trace <id|prefix>      # replay a session's JSONL tree
rovecode acp                    # Agent Client Protocol v1 over stdio (Zed/JetBrains)
rovecode serve                  # headless HTTP + SSE server (ROVECODE_PORT, loopback-only)
```

Without a provider configured, one-shot runs answer from a scripted mock (also how the packaging
smoke works), and the TUI opens with a card pointing at `/setup`. The quickest way to a real model is
`rovecode connect` (or `/setup` in the TUI). Give it a provider id and it stops asking — the whole
sitting becomes one line that fits in a README, a Dockerfile or a CI step:

```bash
rovecode connect                             # no arguments: the step-by-step wizard (rovecode setup)
rovecode connect anthropic                   # a built-in: key from the env, else one hidden prompt
rovecode connect anthropic --model claude-opus-5   # pin the model too
rovecode connect ollama --no-key             # a local server: nothing to store
rovecode connect gw https://gw.corp/v1 --protocol anthropic --key --project   # your own endpoint
echo "$KEY" | rovecode connect groq --key-stdin    # scripts and CI: no terminal needed
rovecode connect gw https://gw.corp/v1 --key-env GW_TOKEN --no-test   # register only, skip the test call
```

It registers the endpoint, stores the key, picks the model, makes one tiny real call and persists the
default. A key is never a flag *value* — that would sit in the shell history and in every `ps` listing
— so `--key` prompts (hidden), `--key-stdin` reads one piped line and `--key-env NAME` names an env var
to read at call time. Exit codes: `0` connected, `1` the test call failed (**the config is still
written** — `rovecode provider test <id>` retries it), `2` a usage error.

By hand, store a key once — built-in providers need nothing else:

```bash
rovecode auth set anthropic                  # prompts for ANTHROPIC_API_KEY — never echoed, never logged
rovecode auth set kaesra --key MY_PROXY_KEY  # override the key name recorded for a provider
rovecode auth list                           # stored providers + key names, values redacted (first 4 chars)
rovecode auth remove anthropic
rovecode auth set openai < key.txt           # piped stdin: reads one line, no prompt (scripts)
```

Any other OpenAI-compatible or Anthropic endpoint — a proxy, a gateway, a local server — is one line
away, and every change is **live**: a running TUI, `rovecode serve` or `rovecode acp` picks it up on the
next model call, no restart:

```bash
rovecode provider add myproxy https://llm.example.com/v1 --model gpt-5 --key   # --key prompts (never echoed)
rovecode provider add ollama http://127.0.0.1:11434/v1 --no-key                # local server, no key
rovecode provider add gw https://gw.corp/v1 --protocol anthropic --key-env GW_TOKEN --project  # ./.rovecode
rovecode provider list                       # configured providers + the default provider/model (key SOURCES
                                             # only)
rovecode provider test myproxy               # one tiny real call: url + key + model
rovecode model list myproxy                  # ids from providers.json or the endpoint's /models
rovecode model use myproxy/gpt-5             # persist the default (running TUIs switch live)
```

In the TUI the same surface is `/connect` (bare: the guided cards, same as `/setup`; with an id: the
one-liner above, minus the key flags — there is no hidden prompt in there, so a missing key is handed
over to `rovecode auth set <id>` or `/provider key <id> <secret>` and the command finishes itself the
moment the key lands), `/provider list|add|remove|use|test|key <id> <secret>`, `/models
[provider]` and `/model <provider/model> [--save]`; the agent itself has `provider_list` (read-only) and
`provider_edit` (add/remove/use — asks for approval, **never accepts a key**: the human stores it with
`rovecode auth set <id>` or `/provider key`, or names an env var with `keyEnv`).

Keys live in `~/.rovecode/credentials.json` (`ROVECODE_HOME` overrides the directory). On POSIX the file is
written 0600 inside a 0700 directory. On Windows, mode bits are not enforced — the file is protected
by the NTFS ACL of your user profile (`%USERPROFILE%`, which `~/.rovecode` inherits), not by permission
bits. Stored keys beat `<NAME>_API_KEY` env vars; an explicit `ROVECODE_BASE_URL`/`ROVECODE_API_KEY` pair
beats both. Endpoints live in `providers.json` (see Configuration → Providers) — never keys.

Or configure by env:

```bash
ROVECODE_BASE_URL=... ROVECODE_API_KEY=...   # any OpenAI-compatible or Anthropic endpoint (always wins)
OPENAI_API_KEY=... / ANTHROPIC_API_KEY=... / DEEPSEEK_API_KEY=... / GROQ_API_KEY=...  # named providers
ROVECODE_MODEL=zai-org/glm-5.3           # model id
ROVECODE_MODEL_DEFAULT=prov/a,prov/b     # role fallback chains (DEFAULT SMOL PLAN COMMIT TASK); advance on
                                         # 429/5xx
```

TUI slash commands: `/help /setup /status /cost /model /effort /yolo /accept-edits /plan /act /rewind /tree
/sessions /resume /new /checkpoints /restore /skills /memory /export /todos /tasks /attach /paste /mcp /exit`,
plus one `/name` per custom command
file in `.rovecode/commands/` (project) or `~/.rovecode/commands/` (user scope). The sextant surface adds its own
renderer-local `/theme night|ember|contrast`, `/open <file>`, `/diff [file]`, `/focus messages|code|files`,
`/agents` and `/notices` (the notification history, also `⌃b`) — they never reach the agent; the names are
reserved against custom commands.

Images: `/attach <path>` stages an image for your next message (text is still required, at most 8 per
message, `ROVECODE_IMAGE_MAX_BYTES` caps each), `/paste` (or `⌃v`) takes the image on the clipboard, and
dragging an image file onto the terminal attaches it directly.

**The sextant surface** (wave 4, ports #40–#46 — ported from the user's own sextant v0.4.0 prototype):
a panelled cockpit instead of a chat log — `files` (git tree with M/A/D, touched-file spinner) · `code`
(the file the agent reads/edits with the highlight band, `±` HEAD-vs-disk diff after an edit lands and the
approval preview before it, `$` run output with PASS/FAIL chips, `∷` the crew board over background tasks)
· `messages` (compact tool rows `· read x … N lines` `~ edit x +a −b` `$ run cmd`, the ONE modal card for
approvals and `ask_user`, the prompt with `/` suggestions and `@file` mentions) · `plan` (the session's
todos + crew) · `usage` (tokens, context bar, cost) · `rovecode`, the weather-cloud pet whose mood follows
the run. `rovecode` picks it when stdout is a TTY of at least 100×30 that renders truecolor (`COLORTERM`,
`WT_SESSION`, `TERM_PROGRAM` vscode/iTerm/WezTerm/ghostty, kitty/`-direct` `TERM`) or 256 colors (a
`*-256color` `TERM` with no `COLORTERM`, painted through the xterm-256 quantizer); `ROVECODE_TUI=sextant|classic`
overrides the heuristics (a non-TTY never gets sextant, nor does a TTY under the 40×12 floor), `--classic`
beats both. After an edit the `code` panel's diff is the ONE change that landed — captured before an
approved edit, rebuilt from the edit's own anchors after an ungated one — and falls back to a `vs HEAD`
view (every uncommitted change) only when neither is possible. Git runs beside the frame loop: a slow
`git status` never stalls the spinner or the keys. Keys: `⏎` send · `tab`
complete/cycle focus · `esc esc` stop the run · `⌃c` quit (interrupts first) · `⌃k`/`⌃p` palette · `⌃s` code
(and focus it) · `⌃d` diff (press again to go back to code) · `⌃r` run output · `⌃a` agents board · `⌃e` files · `⌃o` cycle the page tabs (code/files/plan, narrow terminals) · `⌃b`
notifications · `⌃v` paste a clipboard image · `⌃t` theme · `⌃n` new session · `⌃u` clear the prompt ·
`⌃←`/`⌃→` word jump · mouse: clicks everywhere (tabs, file rows, cards, a tool row opens its file, the header's unread badge, the footer's theme and effort words), wheel over any panel, scrollbar drag. `rovecode smoke-tui --sextant` renders a
160×44 frame through the real pipeline and prints PASS.

**`@file` in the prompt** (both TUIs) attaches the file to the message exactly as the `read` tool would return it —
hashline header, numbered lines with their anchors, footer — so the model has the contents and valid edit anchors
without a tool round-trip. In the sextant, `@` opens a fuzzy picker over the workspace's files and a mention resolves
the way the picker does (exact path, unique basename, best fuzzy match); in the classic chat, `@` autocompletes
paths and a mention must be the exact cwd-relative path. The transcript shows one chip per file, never the file body.
A file the model did not ask for is still context you pay for, so every limit is enforced AND said (a toast in the
sextant, a note in the classic chat): **400 lines per file** (the block's footer names the offset that continues),
**8 files per message**, **about 60,000 characters of files per message** (a further file is named instead of being
cut to a fragment). Named and left out: a mention nothing matches, a directory, a binary, a file over **2 MB**, a path
outside the workspace. A `/command` or a `!shell` line is never expanded. Settings: none — the caps are fixed.

## Features beyond the 20 ports (wave 3, verified per port in `PORTS.md`)

- **Custom slash commands** (#30) — `.rovecode/commands/<name>.md` (project shadows `~/.rovecode/commands/`):
  optional frontmatter `description:` / `model:` (per-run override, restored after) / `mode: plan|act`
  (durable switch), body = prompt template with `$ARGUMENTS`, `$1..$9`, `$$`; autocomplete + `/help`
  list them; a built-in name always wins (boot warning). `rovecode run "/name args"` expands the same files
  headlessly (model:/mode: are TUI-only there). Arguments reach the template raw — whitespace runs and
  pasted newlines survive.
- **Todo list** (#32) — `todo_write`/`todo_read` keep one `todos.json` per session (whole-list replace,
  one `in_progress` at a time, bounded); `/todos` renders it as checkboxes and the status bar shows
  `todos done/total`. Plan mode keeps `todo_write` (the plan's own artifact) while denying every other write.
- **Background tasks** (#26) — the `task` tool starts child agent sessions as bounded FIFO jobs
  (`ROVECODE_TASKS_MAX`, default 3) through the ONE agent loop; completion notes land on the parent's next
  turn as steering; `/tasks` lists them, `/tasks cancel <id>|all` cancels; quitting the TUI, `rovecode serve`
  `stop()` and `rovecode acp` shutdown cancel every live child; `GET /session/:id/tasks` over HTTP.
- **ask_user** (#33) — the model asks a question through a modal overlay (options or free text) on
  interactive surfaces; headless surfaces fail the tool closed.
- **web_fetch** (#31) — bounded, SSRF-guarded HTTP fetch (`net.fetch <host>` policy action; prompt by
  default; `ROVECODE_WEBFETCH_TIMEOUT_MS`, `ROVECODE_WEBFETCH_ALLOW_PRIVATE=1`).
- **Output modes** (#35) — `rovecode run --output text|json|ndjson`: `json` = exactly ONE result object
  `{status, summary, sessionId, model, origin, usage, costUsd, toolCalls, durationMs, exitCode}` on stdout;
  `ndjson` = every RunEvent as a JSON line then a final `{type:"result"}` line; stdout is JSON-only
  (progress → stderr; the guard is up before the runtime boots, so even a `session_open` hook's prints land
  on stderr); `--output=<mode>` also accepted; exit 0 done · 1 error/budget · 2 usage/startup
  error (one stderr line, nothing on stdout — validated before the runtime boots) · 130 aborted.
- **Reflection** (#28, aider pattern) — a failed `edit`/`write` (or one that introduces LSP diagnostics)
  gets ONE `reflection: …` nudge on the next turn with the error in context, capped at 2 per run
  (`ROVECODE_REFLECTION_MAX`; `ROVECODE_REFLECTION=0` disables); identical repeat failures are not re-nudged and
  the loop guard still fires. Nudges serve the active session's runs only — a background-task child gets
  none (its loop guard still bounds repeats; its failure text reaches the parent through the task note).
  Failed edits now report the anchor line's current text and hash, the lines
  that do match, and the read-then-retry remedy; `write` into a missing directory says so.
- Also landed: first-class `glob`/`grep`/`ls` tools (#22), same-model retry with backoff (#23), diff
  previews in approval overlays (#24), compaction strategies (#25), per-project sandbox rung (#27),
  `rovecode export` (#38), `rovecode auth` credential onboarding (#37), packaging (#36).

## What's ported (the 20 landed ports)

Full ledger with bars, critic verdicts, and evidence: `PORTS.md` (not yet published with this repository). Sources are MIT or
Apache-2.0 only; Apache attributions in `THIRD_PARTY_NOTICES.md`.

**Surfaces**
- #1 differential-render TUI, vendored pi-tui behind a `Renderer` seam (pi, MIT) — now the `--classic` chat
- #40–#46 the sextant surface (user-owned prototype): cell buffer + diff flush, key/mouse/paste parser, the
  RunEvent reducer, files/code/messages/plan/usage panels, the crew board and the pet — a second `Renderer`
  implementation over the same ONE loop (`src/sextant/`, `tui/sextant-io.ts`); `onEvent?`/`attach?` are the
  two optional seam members it needs
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
- #10 executor sandbox ladder: direct/WSL2/Docker rungs behind one `Executor` seam, probed not assumed (codex + OpenHands patterns); #27 makes the rung selectable per project (`.rovecode/sandbox.json` / `ROVECODE_SANDBOX`)

**Memory & context**
- #3 MCP client, stdio + HTTP, lazy disclosure (two registry tools, ~0 idle token cost) (MIT)
- #8 config inheritance: AGENTS.md / CLAUDE.md / .claude / .cursor / .github instructions harvested into capped chunks (oh-my-pi, MIT)
- #16 versioned memory/skill edits with optimistic concurrency + one-call rollback (prime-agent, MIT)
- #17 cross-session recall: FTS over past session JSONL (hermes-agent, MIT)
- #18 persistent eval cell / code-mode, feature-flagged `ROVECODE_EVAL_CELL=1` (OMP/prime/codex patterns)

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
tools/                 the non-coding built-ins: task, todo, ask_user, webfetch,
                       design, eval cell — each a Tool the registry gates
design/                the interface-design protocol: prompt section, the
                       design_direction record, the design_audit checker
skills/                SKILL.md discovery + the versioned skill tools
plugins/               plugin.json folders: tools, hooks, commands, skills, MCP
telemetry/             OpenTelemetry spans and the OTLP exporter
mcp/ acp/ server/ tui/ sextant/  surfaces over the same loop (no second loop
                       generation); sextant is the default TUI, tui the --classic one
eval/                  scripted-provider gauntlet + deterministic benches
```

## Supported extension API

Distributed integrations should import only `rovecode/extensions`, `rovecode/plugins`, or `rovecode/providers`; deep `src/` imports are internal. See [API stability](docs/api-stability.md), [extension interfaces](docs/extensions.md), and the [open-core architecture](docs/open-core-architecture.md). Public code is mechanically prevented from importing private overlays.

## Configuration

Defaults < project config chunks (harvested, capped) < env < CLI flags.

- `~/.rovecode/providers.json` (user) and `.rovecode/providers.json` (project) — model providers and the
  default model; see Providers below
- `.rovecode/mcp.json` (+ harvested `.mcp.json`, + `~/.rovecode/mcp.json` for you) — MCP servers; `rovecode mcp add`
  writes them. PROJECT files are gated: until you approve them (`rovecode mcp show` to review,
  `rovecode mcp trust` to approve) their servers stay off, and any edit asks again (`docs/mcp-market.md`)
- **Project trust** (`src/core/trust.ts`, 2026-09-07) — the same gate, one store (`~/.rovecode/plugins.json`, path →
  sha256), now covers EVERY project file that could make rovecode run or import something: `.rovecode/hooks.ts`
  (imported in-process at boot — the worst of them), `.rovecode/sandbox.json` (the rung and the docker image every
  bash command runs in), `.rovecode/settings.json` when it carries a command-bearing key (`verify`, `lsp`,
  `notify_command`), and the MCP files. A cloned repository's copies contribute NOTHING until `rovecode trust`:
  `rovecode trust show` lists each file with what it WOULD do (the keys and their values, the rung and image, the
  server commands), `rovecode trust [--yes]` approves them as they are now, `rovecode trust untrust` withdraws; an
  edit asks again. Your own `~/.rovecode` files never ask. `verify: false` is a refusal, not a command, and is honoured
  from any file. `.rovecode/commands/*.md` and `agents/*.md` are prompt text, not executables — out of this gate's scope
- `.rovecode/modes.json` — per-mode model config (TUI-scoped; see limitations)
- `.rovecode/sandbox.json` — `{"rung": "direct"|"wsl"|"docker", "dockerImage"?: "…"}` selects where `bash` runs (#27);
  `ROVECODE_SANDBOX=<rung>` / `ROVECODE_SANDBOX_IMAGE=<image>` override it; default `direct`
- `.rovecode/commands/*.md` — custom slash commands (project scope); `~/.rovecode/commands/*.md` (user scope,
  `ROVECODE_HOME`-aware) is scanned first and shadowed by the project's (#30)
- `.rovecode/profiles/<id>.md` (project) / `~/.rovecode/profiles/<id>.md` (user) — replaces a model profile's
  prompt section (see Model profiles below); `ROVECODE_PROFILE=off|<id>` turns profiles off or forces one
- `.rovecode/design.json` — the interface-design direction this project chose; written by `design_direction`,
  checked by `design_audit` (`ROVECODE_DESIGN=off` drops the prompt section). See `docs/design.md`
- `.rovecode/settings.json` (project) / `~/.rovecode/settings.json` (user) — the answers you should only have to
  give once; the project file wins key by key. Three keys: `"permission": "ask" | "accept-edits" | "auto"` (written
  by `/yolo --save` and `/accept-edits --save [--project]`; ladder: CLI flag > `ROVECODE_PERMISSION` > project >
  user > ask), `"effort": "auto" | "off" | "low" | "medium" | "high"` (the thinking dial, `/effort --save`), and
  `"bell": false` — both TUIs notify you when a run ends and when an approval or question card opens, but ONLY while
  the terminal is unfocused: the point is telling someone who looked away, and a bell on every turn is a bell nobody
  hears (a terminal that never reports focus reads as watched and stays silent). `"notify": "auto" | "bell" | "osc9" |
  "osc777"` picks the signal (auto = an OSC 9 desktop toast on Ghostty, iTerm2, kitty, Warp and WezTerm, the BEL
  everywhere else; Windows Terminal turns the bell into a flash, a chime or a taskbar badge per profile);
  `"notify_when": "always"` brings back a signal on every run; `"notify_command": ["notify-send","rovecode"]` (a JSON
  string array, or whitespace-split words) runs a desktop hook under the same gate with a JSON payload as its last
  argument, never through a shell — from the project file it applies only once that file is trusted, from the user file
  always. `ROVECODE_NOTIFY[=off]`, `ROVECODE_NOTIFY_WHEN` and `ROVECODE_NOTIFY_COMMAND` override the files. Fourth key: `"verify": "bun run check"`
  (or a list, run in order; or `false`) — the check the loop runs after the agent's last edit before its reply counts
  as done. Without the key rovecode infers one only where both the name and the shape are recognised: a
  `package.json` `check` script (unless its body names deploy/publish/push/docker/curl and the like), or a
  `typecheck`/`lint`/`test` script whose body is a runner known to run unattended and end (tsc, eslint, biome, bun
  test, vitest run, jest, node --test, mocha — never a watch mode), `cargo check`, `go vet ./...`, `ruff check .`;
  `npm test` with any other body, `cargo test`, `pytest` and Makefile targets are never inferred, and `rovecode doctor`
  prints each refusal with its reason so you can set the key deliberately. The check runs after edits made with the
  `edit` or `write` tools; a run that changed files only through `bash` is not counted, so it is not verified. Anything else in the file, or a
  value of the wrong type (`"bell": "off"`), is ignored rather than guessed at
- `.rovecode/` also holds sessions (each with its `todos.json`), checkpoints, repo-map cache
- Permission rules: deny-by-default, last-match wildcard (`file.read/write`, `shell.exec`, `spawn`, `memory.write`, `net.fetch`, `tool.*`). Three permission levels, as the screen names them: **ask first** (default — I ask before every write, shell command and subagent), **accept edits** (`--accept-edits` / `ROVECODE_ACCEPT_EDITS=1` / `/accept-edits` — writes inside this folder stop asking; shell, subagents, network and writes outside it still ask) and **auto (never asks)** (`--yolo` / `ROVECODE_YOLO=1` / `/yolo` in the TUI). `ROVECODE_PERMISSION=ask|accept-edits|auto` sets the level a run starts at; auto skips the prompts, never the deny rules or plan mode
- `.rovecode/hooks.ts` (+ `~/.rovecode/hooks.ts`, `ROVECODE_HOME`-aware) — typed hook set (#29; see Extending → Hooks);
  `ROVECODE_NO_HOOKS=1` skips the files, `ROVECODE_HOOK_TIMEOUT_MS` bounds every call

### Providers

Providers are data, merged per id in this order (later wins): the built-in table (kaesra, openai,
anthropic, deepseek, groq, openrouter, ollama, lmstudio, together, mistral, cerebras, fireworks,
perplexity, xai, moondream, vllm) < `~/.rovecode/providers.json` < `<project>/.rovecode/providers.json` <
the `ROVECODE_BASE_URL`/`ROVECODE_API_KEY` pair (provider id `custom`, always the default). Both files share
one shape:

```json
{
  "default": "myproxy/gpt-5",
  "providers": {
    "myproxy": { "baseUrl": "https://llm.example.com/v1", "protocol": "openai",
                 "keyEnv": "MYPROXY_API_KEY", "defaultModel": "gpt-5",
                 "models": ["gpt-5", "gpt-5-mini"], "headers": { "x-org": "9code" } },
    "ollama":  { "baseUrl": "http://127.0.0.1:11434/v1", "noKey": true }
  }
}
```

- `protocol` is `openai` (chat/completions) or `anthropic` (messages); omitted, it is inferred from the URL.
- Keys are never in this file. A provider's key is its stored credential (`rovecode auth set <id>`) else
  `process.env[keyEnv]` (default: the models.dev name, e.g. `ANTHROPIC_API_KEY`, else `<ID>_API_KEY`);
  `noKey: true` marks local servers. `headers` are sent on every request (the protocol's own auth header wins).
- `default` is `provider/model` (split on the first slash, so model ids keep their slashes) or a bare provider
  id (→ its `defaultModel`); the project file's `default` beats the user's, `ROVECODE_MODEL` beats both.
  Without a `default`: the first stored credential in table order, else the first env key, else a keyless
  file provider.
- **Hot reload.** The runtime keeps ONE live registry (`src/providers/registry.ts`) whose stream resolves
  `model.provider` on every call and re-reads the two `providers.json` files and `credentials.json` when
  their mtime changes. `rovecode provider add …` / `rovecode auth set …` in another terminal, `/provider …` in
  the TUI, and the agent's `provider_edit` tool all take effect on the next model call — no restart. A call
  to an unknown provider, or one without a key, ends the turn with ONE `config:` error naming the fix; the
  router/retry layers treat that prefix as non-retryable.
- Because routing is per call, `/model other/model` switches providers mid-session and cross-provider
  fallback chains (`ROVECODE_MODEL_<ROLE>=a/x,b/y`) really fail over to the other endpoint.
- Surface: `rovecode provider list [--all] | add <id> <baseUrl> [--protocol openai|anthropic] [--key-env NAME]
  [--model <id>] [--no-key] [--project] [--key] | remove <id> | test <id> [model]`, `rovecode model list [provider]
  | use <provider/model> [--project]`; TUI `/provider …`, `/models [provider]`, `/model <provider/model | model>
  [--save]`; agent tools `provider_list` (kind read: list/models/test) and `provider_edit` (kind custom →
  `tool.provider_edit`, prompted in ask-first mode, denied in plan mode; add/remove/use; refuses API keys).

Environment knobs (`rovecode help env` is the full reference; this list is the commentary):

- `ROVECODE_BASE_URL` / `ROVECODE_API_KEY` — any OpenAI-compatible or Anthropic endpoint; always wins over stored and named keys
- `ROVECODE_MODEL` — model id (beats the providers.json `default`); `ROVECODE_MODEL_<ROLE>` — fallback chain per role
  (DEFAULT SMOL PLAN COMMIT TASK), comma-separated `provider/model`, advancing on 429/5xx (#14); each candidate
  is served by its own provider's endpoint
- `ROVECODE_RETRY_MAX` (default 3, so 4 attempts; 0 = off) / `ROVECODE_RETRY_BASE_MS` (default 1000) — same-model
  retries on 429/5xx/transport failures. The first backoff is capped at `RETRY_BASE_MS`, doubles per attempt up to
  20 s, is fully jittered, and a `Retry-After` header raises the wait but never lowers it. Wired INSIDE the router,
  so retries exhaust before the fallback chain advances (#23). The wait is announced **while it happens** —
  `anthropic: overloaded — retrying in 4 s (2/4)` as a TUI note or on `rovecode run`'s stderr — and giving up says
  which limit was hit: the attempts, the retry budget, or the run's own deadline
- `ROVECODE_FIRST_BYTE_TIMEOUT_MS` (default 60000) — how long a provider may go without sending **anything** before
  the request counts as failed and is retried. Only the first byte is on this clock; once the model is talking the
  body may take as long as it takes. A connection that drops mid-stream **after** text arrived is NOT retried: the
  partial answer is kept and the error row says why (`docs/wire-failures.md`)
- `ROVECODE_WEBFETCH_TIMEOUT_MS` (default 30000) / `ROVECODE_WEBFETCH_ALLOW_PRIVATE=1` — `web_fetch` timeout and the SSRF-guard
  escape for loopback/private hosts (local dev servers) (#31)
- `ROVECODE_COMPACTION` — `head-summarize` (default) | `keep-window` | `provider-native` (#25)
- `ROVECODE_TASKS_MAX` (default 3) — concurrent background tasks; extra `task start`s queue FIFO (#26)
- `ROVECODE_OTEL_ENDPOINT` (e.g. `http://host:4318`) — OTLP/HTTP collector; exports one trace per run (`rovecode.run` ⊃
  `rovecode.turn` ⊃ `rovecode.tool`) with token/latency/cost attributes; unset = off, the exporter is never constructed (#39);
  `ROVECODE_OTEL_HEADERS=k=v,k2=v2` — extra OTLP headers (e.g. `authorization=Bearer …`)
- `ROVECODE_REFLECTION=0` disables the reflection nudges; `ROVECODE_REFLECTION_MAX` (default 2) caps them per run (#28)
- `ROVECODE_SANDBOX` / `ROVECODE_SANDBOX_IMAGE` — executor rung for `bash` and the docker image (#27)
- `--output text|json|ndjson` (flag, `rovecode run` only) — output mode (#35); `ROVECODE_YOLO=1` — allow all tool actions;
  `ROVECODE_STREAM` — streaming is ON by default for both protocols; `off`/`json`/`0`/`false`/`none` fall back
  to the one-shot JSON adapters (a proxy with no SSE route); `sse` selects the raw OpenAI-compatible SSE
  adapter for `rovecode run` — still streaming, but without the text-tool-call middleware wrap;
  `ROVECODE_OPENAI_WIRE=responses|chat` — which OpenAI wire a request takes (`src/providers/wire-select.ts`, per call).
  Unset: a stored ChatGPT login (`rovecode auth login openai`) always takes `/responses` (its token is accepted by the
  Codex backend only, with `originator: rovecode`); provider `openai` takes `/responses` for models the catalog does not
  mark non-reasoning (gpt-5, o3, unknown ids) and `/chat/completions` for the gpt-4o class; every other provider stays
  on `/chat/completions`, byte-identical to before. Selection is static — a `/responses` 404 is an error turn, never a
  re-issue. Not done yet on `/responses`: reasoning items are not replayed to the model on the next turn (each turn
  reasons afresh; reasoning text still streams live) — that needs a reasoning message part across the store, export
  and the other wires;
  `ROVECODE_HOME` — credentials + user-scope commands dir (default `~/.rovecode`)
- `ROVECODE_TUI=sextant|classic` — force the TUI surface (#44; sextant still needs a TTY of at least 40×12,
  `--classic` wins); `ROVECODE_THEME=night|ember|contrast` — the sextant palette at boot (`/theme` switches it
  live); `ROVECODE_PET=0` — hide the sextant pet panel (`--pet <name>` renames it); the surface picks itself
  at ≥ 100×30 cells with truecolor or a 256-color `TERM` — below that, or on a pipe, `rovecode` opens the
  classic pi-tui chat
- `ROVECODE_DESIGN=off` — drop the interface-design section from the system prompt (for runs with no UI in
  them). Otherwise every run carries it: propose three distinct directions before the first UI in a project,
  let the human choose, record it with `design_direction`, then build to it. See `docs/design.md`
- `ROVECODE_IMAGE_MAX_BYTES` (default 5 MB) — per-image cap for pasted (`⌃v`) and attached (`/attach`) images;
  at most 8 images ride on one message, and an oversized one is refused by name rather than dropped
- Kill switches / budgets: `ROVECODE_NO_CHECKPOINTS=1`, `ROVECODE_NO_REPOMAP=1`, `ROVECODE_REPOMAP_TOKENS`
  (default 1024), `ROVECODE_NO_TOOL_MIDDLEWARE=1`, `ROVECODE_TOOL_MIDDLEWARE=1`, `ROVECODE_EVAL_CELL=1`,
  `ROVECODE_NO_PLUGINS=1`, `ROVECODE_PLUGIN_TIMEOUT_MS` (default 5000, per plugin import + `tools()`)

### Model profiles

A **model profile** is per-model-family tuning that the prompt assembler and the provider layer share
(`src/providers/profiles.ts`): a behavioral section appended to the system prompt, the extra request fields
the endpoint wants, and the endpoint's own words for the one `--effort` dial. Profiles resolve by **model
id**, not provider — the same GLM through kaesra (`zai-org/glm-5.3-flash`), zai (`glm-5.3`) or openrouter
(`z-ai/glm-5.3`) gets one profile. Today there is one:

- **`glm-5.3`** (GLM-5.3 and GLM-5.3-Flash): the base prompt gains two sections. First a **Claude Sonnet 5
  persona** — the model plays Sonnet 5 as a role and carries everything Anthropic publishes about it: the
  model facts it may state about itself, the Sonnet 5 traits (calibrated length, literal scope, action by
  default, self-verification, progress updates, design directions instead of a house style, coverage-first
  code review, cyber caution) and Claude's published character (warm and direct, minimal formatting, one
  question at a time, owns mistakes without self-abasement, evenhanded, careful with wellbeing). It is a
  closed role: asked which model it is, even directly or repeatedly, it stays Claude Sonnet 5 and does not
  name the underlying model. The harness stays honest at the system level, since `/status` and `/cost` keep
  reporting the real configured model id. It also carries real captured Sonnet 5 replies as voice examples.
  Then the *working
  agreement* — the operating rules for this harness (act by default, read before you claim, the `read` →
  `edit` hash protocol with its rejection remedy, independent tool calls in parallel with no guessed
  arguments, verify before "done" and report failures as failures, minimal scope, short grounded progress
  notes, ask only when readings differ materially, treat denials as decisions, persist across compaction).
- **`glm-5.3-plain`**: the working agreement without the persona, same request fields. Opt-in only:
  `ROVECODE_PROFILE=glm-5.3-plain`. On an OpenAI-compatible provider the request also carries Z.ai's fields: `thinking: {type:
  "enabled", clear_thinking: false}` (GLM-5.3 cannot switch thinking off), `temperature: 1` / `top_p: 0.95`
  (Z.ai's suggestion), `tool_stream: true` when streaming; `--effort off` leaves the endpoint's default
  (`max`, Z.ai's coding recommendation), `low` → `low`, `medium` → `high`, `high` → `max`. Behind an
  Anthropic-protocol gateway only the prompt section applies. Streamed `reasoning_content` shows up as
  thinking in the TUI like Anthropic's `thinking_delta`.

`ROVECODE_PROFILE=off` runs every model bare; `ROVECODE_PROFILE=glm-5.3` forces the contract's **prompt
section** onto any model (A/B it on something it was not written for) while the request fields keep
following the model id, so gpt-5 never receives `thinking` or `max`. `.rovecode/profiles/glm-5.3.md` (project) or
`~/.rovecode/profiles/glm-5.3.md` (user) **replaces** the built-in section text — edit, restart the run,
no rebuild; an empty file drops the section and keeps the wire tuning. The persona is a role, not a
relabeling: the harness keeps reporting the real model id in `/status` and `/cost`, and you can loosen the
closed role in the override file. Measure a change with `rovecode gauntlet
--live` before and after (pass count, tool calls, tokens per task).

## Safety model (stacked, honest)

1. **Policy** — deny-default wildcard rules, evaluated on revised args
2. **execpolicy** — declarative per-command verdicts; `forbidden` never reaches execution or a human
3. **Gate** — approvals resolved on revised args, cached; child agents cannot prompt
4. **Runtime** — bash denylist + cwd lock + output truncation

This is **not an OS sandbox**. Where `bash` runs is selectable (#10 seam + #27 config):
`.rovecode/sandbox.json` `{"rung": "direct"|"wsl"|"docker", "dockerImage"?: "…"}`, or `ROVECODE_SANDBOX=<rung>`
(+ `ROVECODE_SANDBOX_IMAGE`; env beats file; default `direct`). Every rung is **delegation, not isolation**:
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

**OTel spans** (#39, `telemetry/otel.ts`): set `ROVECODE_OTEL_ENDPOINT` and every run exports one trace as
OTLP/HTTP JSON — `rovecode.run` ⊃ `rovecode.turn` (one per model step) ⊃ `rovecode.tool`, with per-span tokens, latency,
served model and cost (omitted when unpriced), compaction and never-dispatched calls as span events; ids, sizes
and outcomes only (no goal, args, output or headers). Batched once per run, 5 s timeout, a failed export is one
`hooks:` warning and never blocks a run. Cancelled runs export too (Esc, `session/cancel`, HTTP DELETE or a
client disconnect → status `stopped`); `rovecode.tool_calls` counts issued calls, the `--output json` `toolCalls`
count — both per issuing turn, so a call id a provider reuses across turns counts once per turn; the one gap is a
run aborted while a call awaited approval after its `pre_tool` hook (a span, never an event). Unset = zero cost:
the exporter is never constructed; a malformed endpoint is one warning, not a stall.

Typed `RunEvent` stream (run/turn/tool/compaction events) persisted with the session tree;
`rovecode trace <id>` replays any session with corruption findings. `/cost` and `/status` surface
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
  `rovecode serve`/`rovecode acp` sessions booted from different project dirs share the most recently booted
  session's rung. The offline `rovecode gauntlet` always runs `direct` (it never builds a runtime); `gauntlet --live`
  boots the runtime and honors the configured rung like any other run.
- **ACP is the one surface that mixes cwds.** `rovecode acp` boots a runtime per `session/new` cwd on that
  process-wide seam: a `session/new` REFUSED because its cwd asks for a rung this machine cannot provide
  (JSON-RPC error) still leaves the seam holding that unmet rung, so existing sessions' `bash` calls fail
  with the rung error until a later `session/new` boots successfully. Keep one editor window per project,
  or every project on the same rung.
- **Plan/Act modes are TUI-scoped.** `run`/`acp`/`serve` ignore `.rovecode/modes.json` including
  `defaultMode`.
- **Server sessions are in-memory.** `rovecode serve` loses its session routing table on restart
  (JSONL trees persist on disk).
- **Windows-first, Linux-checked.** Developed on Windows 11 + Git Bash, where the suite, the gauntlet and
  the render smoke are run by hand before anything lands. CI (`.github/workflows/ci.yml`) runs `tsc` and the
  full suite on `ubuntu-latest` for every push and pull request, so POSIX paths are gated rather than merely
  exercised. **macOS is not verified anywhere** — nothing runs there, by CI or by hand.
- **Packaging**: not published to npm; compiled binary is ~110 MB (bun runtime).

## Extending

- **Plugins** (`src/plugins`, `docs/plugins.md`): a folder with a `plugin.json` that bundles the things below —
  an in-process entry module (tools + hooks), `commands/*.md`, `skills/**/SKILL.md`, MCP servers — so one
  `rovecode plugin add <folder|git-url>` installs all of it and `rovecode plugin list` shows all of it. User scope
  `~/.rovecode/plugins/<name>`; project scope `.rovecode/plugins/<name>` is **listed but never run** until
  `rovecode plugin trust <name>` records the folder's content digest in your home (a repo cannot trust itself; a
  pull that changes any file asks again). Plugin tools go through the same `ToolRegistry` and permission rules as
  built-ins (a plugin cannot replace `bash`); plugin hooks join the same `HookRunner`. Read once per process;
  `ROVECODE_NO_PLUGINS=1` skips discovery. First-party plugins live in `plugins/` (safety-net · notes ·
  conventional-commits).
- **Tool**: implement `Tool` (schema + kind + execute), `registry.register(t)`; kind maps to a policy action.
- **Provider**: implement `StreamFn` — must not throw; failures become `{stopReason: "error"}`.
- **Hooks** (`core/hooks.ts`, port #29): drop a `.rovecode/hooks.ts` (or `.js`; user scope `~/.rovecode/hooks.*`)
  exporting `{ version: 1, hooks: {…} }` — plain `import`, no build step. Nine typed hooks, all optional,
  sync or async: `pre_run`, `post_run` (also fired, as `stopped`, when the consumer cancels a run mid-way),
  `pre_tool` (return `{deny: reason}` to block), `post_tool` (return
  `{output}` to annotate what the model sees, growth-bounded), `approval` (return `"allow"`/`"deny"` to
  pre-answer a prompt), `compaction`, `session_open`, `session_close`, `on_event` (every RunEvent, not
  awaited). Every call is timeout-bounded (`ROVECODE_HOOK_TIMEOUT_MS`, default 5000) and isolated — a throwing
  or hanging hook is one warning note, never a dead run. Policy wins: rules run before `pre_tool` (a hook
  can only deny, in every mode incl. auto (`--yolo`), and the same hooks govern background-task children); the
  approval hook sits where the human would, INSIDE the execpolicy wrap (rules → execpolicy → hook →
  human): forbidden argv is denied before any hook sees it, allow-listed argv runs without asking one, and
  a hook `"allow"` is exactly a human's one-shot yes (never cached). Hooks receive copies of args and
  results — only a returned value counts. Hooks are trusted code run in-process (same class as
  `.rovecode/mcp.json`); loaded once per process, restart to pick up edits; `ROVECODE_NO_HOOKS=1` skips the files.
  The programmatic `ExtensionHooks.reviseToolArgs` still rewrites args before policy + approval (approval
  sees revised args).
- **MCP** (`src/mcp`, `docs/mcp-market.md`): `rovecode mcp search|info|add|remove|list|show|trust|untrust` and `/mcp`
  in the TUI install servers from a curated shelf and the official registry — the exact command/URL, publisher and
  version are shown before a yes, keys are asked masked by name and written as values only to `~/.rovecode/mcp.json`
  (a `--project` file gets `${NAME}`). Servers live in `~/.rovecode/mcp.json` < `.mcp.json` < `.rovecode/mcp.json`;
  tools arrive lazily through `mcp_list`/`mcp_call` under the same policy pipeline. A server a **repository** brings
  with it is listed but never connected until you trust it: `mcp show` prints every configured file and what it would
  run, `mcp trust` records the project files' content digest in your home (`--yes` to skip the prompt; an edit to
  either file asks again) and `mcp untrust` revokes it. User-scope servers need no gate. `rovecode trust` is the same
  store one level up: it approves the MCP files together with `hooks.ts`, `sandbox.json` and the command-bearing
  settings keys in one step (see Project trust above).
- **Market** (`src/market`, [`docs/mcp-market.md`](docs/mcp-market.md)): one shelf over all three — `rovecode market search|info|docs|
  install|remove|list|update|sources|verify|validate` (each with `--json`) and `/market` in the TUI find MCP
  servers, skills and plugins
  and install any of them with one command. A single argument resolves five shapes (bare id, `kind:id`, a git URL,
  an npm package, a local folder) and prints the candidates rather than guessing when two kinds share a name.
  Installing is always resolve → plan without touching the disk → show exactly what will be written → write, and
  the preview says what each kind actually is: a skill is files that are never executed, a plugin is code rovecode
  will load and run. The skill and plugin shelves are generated from their sources (`scripts/build-*-catalog.mjs`,
  idempotent under `--check`), so "is this real?" is answered by re-running them.
- **Context and cost** (`src/core/context-report.ts`, `docs/context.md`): `rovecode context` breaks the window into
  the rows a reader thinks in and prints the provider's own count of the same prompt beside our estimate, naming
  the gap past 5% — compaction fires on the estimate, so a meter that reads low compacts too late. Cache reads and
  writes are counted as the prompt they are. Cost follows the vendors' prompt-size tiers: over xAI's or Google's
  200k threshold the whole request bills at the upper rate. The history budget is derived from the model's window
  rather than a flat 200k (`ROVECODE_CONTEXT_BUDGET` overrides).
- **Interface design** (`src/design`, `docs/design.md`): no default palette, typeface or layout ships — instead a
  protocol (propose three distinct directions, the human picks, `design_direction` records it in
  `.rovecode/design.json`) and `design_audit`, which counts template patterns in source and reports them as
  *slop* only while nothing is recorded, or as *deviation* from what the project chose. `ROVECODE_DESIGN=off`
  drops the section for runs with no UI in them.
- **#47 external agentic-CLI lanes** — the one wave-4 row that was never implemented here. Measured
  2026-09-06 rather than assumed: `claude -p` and `opencode run` already work through the `bash` tool
  today, in print mode, without a TTY. What makes a lane a real feature rather than a shortcut is the
  finding that came with it — **the child agent obeys its own permission configuration, not rovecode's.**
  A `claude -p "create a file"` spawned from a rovecode run under `auto` created the file, because that
  machine's `~/.claude/settings.json` sets `bypassPermissions`; rovecode's approval gate saw one `bash`
  call and never saw a write. Under `ask` or `accept-edits` the bash call is refused first, so the hole is
  exactly as wide as unattended `bash` — but a nested agent turns one approved command into an
  unsupervised multi-step agent, under someone else's write policy, billing a different account. A lane
  therefore has to run the child in a directory the approver saw, pass no `--dangerously-*` flag ever,
  and name the account it spends from. (`opencode` also writes `.opencode/` and `docs/` into the working
  directory even when it fails, and on Windows a nested shell layer ate the backslashes of an absolute
  path and produced a file literally named `C:UsersberkaycikAppData…banana.txt`.)
- **Publishing**: no npm package; the binary is built locally (see Known limitations)
- **Linux/macOS CI**: POSIX paths are exercised in tests, but only Windows is gated
