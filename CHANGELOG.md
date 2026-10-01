# Changelog

What changed for the person using rovecode, newest first. Every line ends with the commit that carries
the change (hashes on `main`). Numbers are measurements from the commit that reports them, on the
machine it names.

## 5.2.0 — 2026-09-30

- Sextant: assistant turns render as markdown — headings, **bold**, *italic*, ~~strike~~, `code` chips,
  lists with hanging indents, fenced blocks with a lang label (wrapped, never clipped), blockquotes, rules,
  aligned tables (sextant/markdown.ts on marked's lexer; the panel showed the source — literal ## and ** —
  before). Streaming renders as it grows; a lexer failure falls back to the plain text the panel always had
- Sextant: long runs of completed exploration rows (read / search / fetch) fold into one summary line —
  `⚙ 3 calls · read ×3` — once at least three would fold; writes, edits, runs, failures and the live row
  never fold, and the last two rows keep their click-to-open path
- Catalog/boot: the model index ships as a 138 KB hot file (the 17 mapped providers, ~1.7 ms parse)
  plus a lazily-loaded 1.4 MB extra file, instead of one 1.4 MB file every session parsed. A new 12 KB
  manifest serves `keyNameFor`, which parsed the full index for one env var name
  (docs/decisions/0001-model-index-split.md)
- New: every models.dev provider is reachable — `rovecode provider add kilo <url>` (or any of the ~200
  catalogued vendors) prices and reports context windows with no table edit. The other 196 providers in
  the index were shipped but unreachable before
- New: `rovecode model list <provider>` falls back to the shipped catalog when the endpoint has no
  /models route or no key is stored (Anthropic has no such route at all), and prints each model's
  context window, price and capabilities in aligned columns — unknowns render as `—`, never a guess.
  The interactive `rovecode model` picker annotates the same facts inline
- New: `rovecode provider add --context-window <tokens>` — the provider-wide context fallback the
  usage panel stands on, which the spec type supported but the CLI never exposed
- New: `provider add` reports on the spot what the catalog knows about the id ("the catalog knows 367
  models for kilo…") or how to set a context window when it does not
- Libraries: the catalog is now `@rovecode-labs/models` (packages/models, MIT) — the first library split
  out of the monorepo. Public mirror: github.com/9Code-Labs/rovecode-models (full history via
  `scripts/publish-libs.sh`, git subtree split); npm: @rovecode-labs/models@0.1.0
  (docs/decisions/0002-library-split.md)

## 5.1.2 — 2026-09-29

- New: `/compact` — durable manual compaction: the session's transcript is summarized by the current
  model into a FRESH seeded session (the old one stays intact under /sessions)
- Fixed: AUTO-compaction was effectively OFF in production — the loop's speculative path needs a head
  summarizer and no surface wired one. `createHeadSummarizer` (core/summarize.ts) now rides the
  run's own model on the TUI, headless run, serve and ACP
- Packaging (claude-code model): the npm tarball ships the MINIFIED dist only — no src/, no
  sourcemaps, no native binaries (the @ast-grep/napi dependency resolves per-platform). The bin
  wrapper is self-contained; a dev checkout keeps the src fast path + the staleness guard

## 5.1.0 — 2026-09-29

- Boot/RAM: the ast-grep native addon left the base import graph (it rode in with coding/files.ts —
  every process paid it, even `rovecode --version`); the repo-map loads it on first real build now.
  Big-repo boot: 3.6 s → 0.8-0.9 s, idle RSS 218 → ~148 MB (this repo, warm tags cache)
- Crew board: lanes show the child's LIVE line — its streamed text tail, `thinking · N tokens`,
  `▶ tool {args}` — and running/queued lanes carry a × kill affordance (click, or `x` on the
  selected lane); both ride TaskManager.cancel
- `/tasks <id>` prints a task's FULL result (delegations keep their whole answer, not the 200-char brief)

- New: rovecode orchestrates EXTERNAL CLI agents — built-in adapters for claude-code, codex,
  opencode, antigravity, gemini, qwen, cursor-agent, copilot and aider (auto-detected on PATH), and
  any other CLI joins through `~/.rovecode/agents.json` or `.rovecode/agents.json`
  (`{ "agents": { id: { command, format } } }`, `{prompt}` placeholder or argv-append,
  `promptVia: "stdin"` for long prompts). Per-CLI answer parsing: claude-json (cost/turns included),
  codex JSONL agent_message, opencode JSON events, plain text fallback
- New: `/delegate <agent> <task>` — the USER's own door: fire-and-forget onto the agents board
  (`/agents`), the result lands as a note when the CLI finishes. Bare `/delegate` lists what is
  installed and what is missing from PATH
- New: the model's `delegate` tool runs the same path — every delegation is a crew-board task
  (queued, bounded, cancelled with the run), its answer returned inline; kind "spawn" prompts under
  the gated rules (the delegated CLI edits with its own tools), yolo allows, plan mode denies.
  Answers cap at 50k chars, and the run's abort tree-kills the child process

## 0.5.0 — 2026-09-28

- Fixed: OpenAI-compatible endpoints that re-send the tool name on EVERY SSE delta produced phantom
  tools — `unknown tool lsls` loops. The parser absorbs exact repeats and cumulative re-sends, and the
  same proxy pathology in arguments (`{…}{…}`) is rescued instead of failing the turn. Malformed calls
  now fail closed instead of executing garbage
- Fixed: a length-limited turn (`max_tokens`) no longer executes its truncated tool calls — `length`
  beats `tool_use` in all four adapters, and the text-protocol middleware never promotes an unfinished
  turn's `<tool_call>` markup to an executable call
- Changed (breaking): the run-budget system is gone — no `--max-turns` / `--max-seconds` / `--max-cost`,
  no `ROVECODE_MAX_*`, no `run_end "budget"`. A run ends when the model stops calling tools, when it
  errors, or when you interrupt it (Esc / Ctrl-C). The loop guard and compaction thrash protection stay
  as the runaway safeties
- New: the usage bar never shows `?` — a model's context window resolves from providers.json
  (`contextWindows` per model / `contextWindow` per provider), then the catalog, then a MARKED
  assumption (`≈`, 128k) with a one-time note saying how to set the real number
- New: the model's reasoning streams live into the transcript as dimmed `◌` thinking rows — what it
  thought is as visible as what it did (never persisted to the session)
- New: resuming a session (`--resume`, `--continue`, `/resume`, `/sessions`) brings back the model that
  session actually ran on; an explicit `--model` still wins, a provider that no longer exists warns and
  keeps the current model
- New: quitting the TUI prints the pasteable command back into the session (`rovecode --resume <id>`)
- Fixed: `rovecode run` with `ROVECODE_STREAM=sse` honors Anthropic-protocol endpoints (the legacy
  opt-in was hardcoded to the OpenAI adapter and read their stream as an empty turn)
- Fixed: the bin wrapper skips a stale dist bundle after an update instead of silently serving the old
  code (source fallback + a hint; `.githooks/post-merge` rebuilds it — `git config core.hooksPath .githooks`)

## 0.3.1 — 2026-09-06

Berkay: "kod yazarken pek üstünde durmuyor, çoğu durumda az değişiklikler yapıp bırakıyor" — when it writes
code rovecode does not stay on the task. Three sessions measured it and the cause was ours, in two halves.

### Finishing what was asked

- A run ended as `done` whenever a turn contained no tool call — the model's silence, taken for finished
  work by every layer. Proven end to end: a rejected `write`, the plan item marked completed anyway,
  "Done — I created src/a.ts", exit 0, three of four items still open, the file never written. `run_end`
  now carries what the transcript says was left (a failure with no later success at the same path, an
  unanswered question, open plan items) and both TUIs and the headless summary say it in one clause —
  `done · 1 failed tool call not recovered (write)`. A run with nothing outstanding is byte-identical to
  before (b0dae27)
- And once per run, on a failure or an unanswered question, the model gets one turn naming exactly what is
  open, which it may answer by finishing OR by saying why it is not needed. Never on a permission denial,
  the loop guard or an abort — those are the harness's verdict or the user's. The next silence is
  accepted whatever it says: a loop that will not stop is worse than one that stops early.
  `ROVECODE_FINISH_CHECK=0` turns the nudge off (b0dae27)
- Nothing we send the model said to finish the task before answering, and ten sentences said do less. The
  worst told it that turns are scarce without ever saying there are sixty; it is gone. The worked recap
  example ended with "README untouched; say so if you want the flag documented" — we were teaching that
  the right ending is a small change plus a menu. A `# Finishing` section now says what the harnesses that
  get this right say: done means everything named and plainly implied is built and verified, a reply
  without a tool call ends the run, and a blocked part is named while every other part is finished
  (6714953)
- The design gate asked for directions before every visual change, and on this machine 6 of 24 task runs
  ended at that question. Berkay's decision: propose directions for something NEW; make the change to
  something that already exists. The rule is now a test anyone can apply — if the person could point at
  the thing on the screen, it exists and you change it (6714953)

## 0.3.0 — 2026-09-06

`rovecode doctor` is new: one command that runs every check in here and says what it did NOT check.
Startup, the first edit of a session and an idle session all got much cheaper, several surfaces stopped
promising things they did not do, and MCP servers can be installed once instead of resolved at every
start. Numbers are measurements from the commit that reports them, on the machine it names.

### Startup

- The TUI opens on a card that names the version, the connected model, what loaded (skills · plugins · MCP servers, zeroes omitted), the folder and permission tier — and `update available: x → y · <url>` when GitHub Releases on 9Code-Labs/rovecode has a newer one. The check needs `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth login` (the repository is private), asks at most every six hours, never blocks, and prints nothing unless a release is genuinely newer (8c6f6f9)
- An opening intro, centred on a cleared screen: the ROVECODE mark fills in left to right, a hairline frame draws inward from the four corners, the cloud mascot leans down out of that top line, and the mark breathes once. ~1.1 s; the session boots underneath it, so the only wall time it adds is whatever is left of the show once the session is ready. `--no-intro` or `ROVECODE_INTRO=0` skips it; nothing is drawn into a pipe or under `--plain`, and it never reads stdin, so keys typed during it reach the session (09e4a1c, 420353d, 9d6fe71)
- The intro no longer draws outside a terminal it does not fit in: at 34×24 the frame wrapped six columns past the edge and the mark broke up, at 40×10 it painted thirteen lines into ten and scrolled its own top away. A terminal too small for the whole block gets no intro and the card's prose form instead (25ca9af)
- Every session loaded a 136 MB token table before its first frame — to count an empty string and return 0. Fresh session to first frame: RSS 238–246 MB → 111–112 MB, boot 450–550 ms → 154–183 ms; a resumed session with a 435k-character transcript no longer pays it either. `/cost`, `/context` and `export` are unchanged and still exact (574dae0)
- The pre-bundled CLI was undoing its own lazy imports: `bun build` inlines dynamic imports, so `dist/cli/main.js --version` paid for pi-tui, the gauntlet, acp and the tokenizer. Built with `--splitting`: 388–491 ms → 84–103 ms wall, 98 MB → 74 MB. `build:cli` also clears `dist/cli` first (574dae0)
- An idle session repainted ~9.5 times a second to show nothing changing: 89–98 ms of CPU per wall-clock second → 14–20 ms at ~2.5 frames/s. A busy session is unchanged by design, and nothing looks different — things now paint only when they change (df155ca)
- `rovecode --version` prints the version to stdout alone (still one word for a script) and the update check’s answer to stderr: the newer release, `up to date (0.2.0) · cached`, or `not asked yet`. It reads the cache and never opens a socket — awaiting the network there made the one command scripts call to identify a build take 3.2 s on a fresh machine, against 117–159 ms now (2aef715, b2e1101)
- Two configured MCP servers cost 758 ms before the first frame because the MCP SDK was evaluated inside createRuntime; it now loads on the connect path, after the first frame, and servers start one per event-loop turn (createRuntime 758 ms → 22 ms with the same home) (f36e73b)

### Speed

- The first edit of a session took 26–35 s in this repository and built a 232 MB checkpoint: the shadow-git snapshot taken before the first change hashed 165 MB of video and 82 MB of screenshots, because only cline's structural excludes had been ported. With its media, archive, binary and database/log patterns added (SVG stays — it is text and it is edited), the first snapshot is 2.8–3.2 s and 3.6 MB over 566 files, and every later change costs ~200 ms (14e9118)

### Correctness

- A one-shot run with no provider configured reported success: `rovecode run "hi" --output json` printed `{"status":"done"}` with the “no model is connected” hint as its summary, and exited 0. It is a startup failure — exit 2, one document in a machine mode — and the canned provider is now asked for by name (`ROVECODE_MOCK=1`) rather than fallen into (d80c2f6)
- A configured MCP server that never connected was counted on the startup card and never mentioned; boot-time connect failures now say so by name, the same way the loader’s skipped entries do (f213b58)
- `rovecode mcp add` and `rovecode market install` share one plan and had drifted into three different behaviours — different wording for the same question, a secret asked in project scope and then discarded, and `--yes` off a terminal refused by one face and written by the other. Unified on: write it, name it out loud, let the loader refuse to launch until the variable is set (18f607a)
- Pointing `ROVECODE_HOME` at a directory that did not exist yet filled it with a copy of `~/.cumulus`, stored keys included: the rename migration honoured an explicit home too, so a "scratch" home was not scratch. It billed two real API calls during this release's own verification before anyone noticed. An explicit home is now that directory and nothing else; the default home still inherits, and says so on stderr (03817b8)
- A first word shaped like a path (`rovecode ./src/cli/main.ts`) is no longer sent to the provider as a prompt — it cost a real API call when a probe passed a filename where a prompt was expected. On a terminal it asks first; off one it exits 2 before the runtime boots. `rovecode run <word>` stays the explicit way to send it, and sentences are never guarded (60456d6, 14e9118)
- `rovecode run "hi" --output json --max-turns 1` sent the model the prompt "hi 1": only `--output`'s value was kept out of the prompt words, every other value flag after the command leaked its value in. All of them are dropped now, by position, so a prompt may still contain the word "json" (60456d6)
- `rovecode trace` with no id exited 0 and printed nothing — a silent success a reader takes for an empty session; it now asks for the id and exits 2. `rovecode export` with no argument exited 1, the code a failed export uses; a usage error there is 2 now, like every other command, and a real failure stays 1 (9936376)
- A TypeScript project on a machine without `typescript-language-server` on PATH is told once at boot that edits and writes are NOT being type-checked and the model gets no diagnostics after them. The gate had been silently off, and everyone had been crediting a loop that was not running (60456d6)
- `--help` still promised that "a scripted mock answers when no provider is configured", which d80c2f6 made false; the line now says exit 2 and names `ROVECODE_MOCK=1` as the way to ask for the mock (03817b8)

### Sessions & scripting

- A session that never received a message no longer leaves `.rovecode/sessions/<id>/` behind — 35 hollow directories in this repository alone; the directory appears with the first entry, and nothing is ever deleted, so every session that has content resumes as before (1169be0)
- Every `--json` surface is one parseable document on stdout on every exit: `market update --all --json` (was a sentence, or one document per item), every market usage error (`{ok:false, error, usage}`, exit 2) and the early exits of `context --json` (`{error}`) (1169be0)
- `market list --kind mcp|skill|plugin` filters; a flag a market subcommand does not read is refused with exit 2 instead of ignored (1169be0)
- `rovecode --continue` (or `--resume` with no id) reopens the newest session in this directory that holds something: a leftover directory with only a meta.json cannot win, and `--resume <id>` still opens exactly what was named. With nothing to continue from, a fresh session (60456d6)
- Piped stdin becomes the prompt's context: `git diff | rovecode run "review this"` appends the diff under the words as a fenced block. It is never read from a terminal; an open pipe that sends nothing for 3 s is skipped with a note; input past 1 MB is trimmed with a note; `--no-stdin` opts out (60456d6)
- `--max-cost 0.50` (`ROVECODE_MAX_COST` on every surface) ends a run at the next turn boundary once the money is spent — status "budget", the dollars in the message — priced the way `/cost` prices, for the model that served each turn. A turn the catalog cannot price adds nothing and is counted in the message, so the figure is never mistaken for the whole bill (60456d6)
- `provider list --json` and `auth list --json` accepted the flag and printed prose, so a script asking for a document got a paragraph and exit 0; both are one document now, the credentials one carrying only the redacted form (03817b8)

### MCP market & trust

- An install that could not fill a required argument (the filesystem server's directory) wrote a server that could never start. Now the argument is asked for on both CLI faces (`rovecode mcp add`, `rovecode market install`), written as `<directory the server may touch>` when nobody answered, and the loader skips a server still carrying the placeholder and names the file and the line to edit (a180ad2)
- A server installed from `/mcp` or `/market` is connected in that session, without a restart, and a session that had no servers gets `mcp_list`/`mcp_call` at that moment; the overlay also stopped refusing the six curated servers that only needed a placeholder argument (d30755f)

- MCP servers can be installed once instead of resolved through `npx` at every start: connect 1767/2052 ms → 347/473 ms for memory/filesystem, no network needed to open a session, and the package, version and npm integrity hash recorded in `installed.json`. It always asks, declining leaves the `npx` line exactly as it is, and existing entries are never rewritten (158e2e9)
- A server that was downloading looked like a server that was broken: a first-ever `uvx` or `npx` launch can exceed the 10 s connect budget, so the very first start of a newly installed server failed with “Request timed out”. Package runners now get 90 s for a first connect, and a timeout says what happened and both ways out (736f6fd)

### Sextant TUI

- `@path` in the prompt attaches the file: the model receives exactly what the `read` tool returns, edit anchors included, with no tool round-trip. The footer had promised this while nothing read the mentions. Every refusal is named — no match, a directory, a binary, over 2 MB, outside the workspace — and the caps are said out loud: 400 lines a file, 8 files, ~60k characters a message. The transcript shows `▤ path · N lines` chips instead of the file (8a5e9d7)
- The terminal bell rings when a run ends, when an approval card opens and when a question card opens — the three moments someone who tabbed away needs. `"bell": false` in settings.json silences it, user or project scope (8a5e9d7)
- `/market` can install an MCP server's package once, as the two CLI faces already could: it asks before the plan with the trade under each option, the approval card stays the gate, and Esc at either step installs nothing (8a5e9d7)

### Tests

- The migration test asserted the very behaviour 03817b8 removed — "the override is a home like any other" — and so kept the defect honest until someone measured what it cost. Flipped, with the two real charges recorded in it; tests that need the migration inject `legacyDir` (3f8c0ed, 03817b8)
- `bun test` runs against an empty `ROVECODE_HOME` and a scrubbed environment (`bunfig.toml` preloads `test/helpers/isolate-home.ts`): every `*_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN` and `ROVECODE_*` variable is cleared, so what is installed or exported on the machine running the suite cannot decide a result. Installing one skill used to fail a plugin test, two MCP servers failed twenty-five, and an exported `ANTHROPIC_API_KEY` let a headless run on a clean checkout bill a real call (8c6f6f9, f213b58)

## Unreleased — 2026-09-04

### Thinking & providers

- Thinking is on by default: the new `auto` effort level sends no thinking field, so the model's own reasoning default stands; `off` is now the explicit, deliberate choice (f655be0)
- Answers are no longer cut at 4096 tokens: max output follows the catalog's limit per model, capped at 32768, with an 8192 floor for uncatalogued models (f655be0)
- Every model receives the working agreement (read before edit, verify before "done", parallel calls, scope, reporting), not only GLM; "be concise" became "match the length to the task" (f655be0)
- One effort dial for every wire: the dial is translated per model family (Anthropic, GLM, DeepSeek, Qwen, Kimi, Gemini, grok, gpt-5, o-series, OpenRouter); `/effort` and `rovecode model show` say exactly what the model receives; the matrix is docs/thinking.md (02edf99)
- `--help`, the ROVECODE_EFFORT note and the `/effort` row list `auto` as the default (1b275ae)
- Models that models.dev lacks are priced from rovecode's own table (the DeepSeek API aliases, the grok-4 family); `model show` names where a price comes from (b5e51bf)
- The grok-4 rows carry xAI's retirement terms (served by grok-4.3: $1.25 in / $2.50 out per MTok, 1M context); the DeepSeek alias rows are marked unverified because the vendor page now lists only V4; grok-3-mini stays unpriced (2309b7f)
- models.dev 0.0.64: openrouter glm-5.3 cache-read 0.26 → 0.14 per MTok; google, zai, moonshot, alibaba and minimax ids resolve to prices; Anthropic prompt caching verified healthy on a live run (f246355)
- Images the way people try to send them: ctrl-v pastes a clipboard screenshot, dropping an image on the terminal attaches it, staged images show as chips on the prompt row before sending (f655be0)

### Run limits & wire failures

- `rovecode run --max-turns N --max-seconds S` (ROVECODE_MAX_TURNS / ROVECODE_MAX_SECONDS also reach the TUI, serve and acp); a headless run defaults to a 1200 s wall clock and ends with status "budget", exit 1, every tool result kept (605b288)
- Wire failures decided and visible: 1 s base, 20 s cap, 4 attempts, full jitter, floors from Retry-After, retry-after-ms and Anthropic's ratelimit headers; no retry after content has streamed, so an answer never appears twice; a 60 s first-byte timeout (ROVECODE_FIRST_BYTE_TIMEOUT_MS); live notes such as "anthropic: overloaded — retrying in 4 s (2/4)" in the TUI and on stderr (c3be792)
- The wire-failure policy is documented and the retry knobs are in `--help` (7c29705)
- `rovecode serve` stops in order on SIGTERM/SIGINT: session-close hooks, MCP servers and background tasks close instead of being killed (1e8ae54)

### MCP market & trust

- `rovecode mcp search | info | add | remove | list` and `/mcp [query]`: a curated shelf of 16 servers plus the official registry, an approval card carrying the exact launch line; installs write `${NAME}` placeholders and a secret never lands on a command line or in a project file (576d295)
- A project's `.rovecode/mcp.json` or `.mcp.json` loads nothing until approved once on this machine (`rovecode mcp trust`, `/mcp trust`); any edit to the file asks again; the user-level file is never gated (114a9d5)
- Four promises the docs made are kept: the plugin boot summary prints, an sse-only registry remote says why nothing was written, unknown `mcp` flags exit 2, and the note after `mcp add` names only the variables the entry uses (da3f41f)
- `/mcp ` offers its subcommands, and Enter completes the word instead of sending it (b8c311e)

### Sextant TUI

- Scrollbar thumbs can be dragged (ddc9226); the wheel scrolls the files tree, and a view scrolled up follows the tail again once it reaches the bottom (4618610)
- The frame's border rows answer clicks, and the thinking dial shows in the footer (c8c42e4)
- Click a tool row that names a file and the file opens (6076b09)
- A long plan windows around the step in progress instead of showing steps 1–8 of 30 (b24164c)
- `/effort ` offers its levels and `/model ` suggests the configured providers' models (b614a22, 7f134a9)
- The help card names every key it has, and the README says what the mouse does (515d05e, e31fc58)
- `design_direction get` no longer raises an approval card; only the write does (71e5d1a)
- Design tools: a provisional direction is recorded when no human can answer, plus four rules live runs asked for (cbdc608); design_audit rebuilt on 20 measured repositories, slop rules demoted, deviation measured in OKLCH (b0111a6); multi-page projects are scored with their layout chain and HSL colours are read (42e5732); the ask-once flow is tested through the real TUI (b8ab321)

### Startup performance

- `rovecode --help` answers in 75 ms instead of ~900: each command imports what it needs when it runs (077155b)
- Telemetry and MCP load only when configured; the models.dev snapshot parses on first use (d080e16)
- The tokenizer parses on the first count, ~430 ms off every launch; the repo map's ast-grep loads after the first frame (3be18f7, c80cc1f)
- Process start to first frame ~948 → ~240 ms, measured with the new ROVECODE_TRACE_BOOT=1, which prints boot timestamps to stderr (8c24361, 3be18f7)
- The files tree and the transcript rows are built once per frame, not twice; the scrollbar painters drop a placeholder (4b23ee2, a7ad4fe, 79d27f5)
- `/help`, `/status`, `/cost` and the session commands load on first use instead of before the first frame (b3daccb)
- `bun run build:cli` pre-bundles the TUI path (opt-in, re-run after git pull); the `rovecode` bin routes a TUI launch to the bundle and everything else to the source, so `--help` stays ~80 ms and the first frame drops ~230 → ~75 ms (d252e1b)

### Tooling & CI

- GitHub Actions: tsc and the suite on every push and pull request; the site deploys itself on merge through an SSH key bound to a forced receive command (1ea1504)
- `bun run gauntlet` runs the gauntlet (it executed the library module and printed nothing); `check`, `smoke` and `deploy:site` scripts (6bbba33, a996b52)
- Dependencies: models.dev 0.0.64, marked 18.0.11, @xterm/headless 6 (f246355, b5e51bf)
- `.gitattributes` makes every text file LF; fresh checkouts no longer depend on core.autocrlf (e848057)

### Site & deploy

- The rovecode site, round 8: Vite + React, static output, self-hosted Hanken Grotesk and IBM Plex Mono, recorded in site/.rovecode/design.json (2b4364d)
- Landing transfer 1007 → 294 kB: AVIF/WebP frames, prerendered HTML that works without JavaScript, no motion library; Lighthouse 94/100/100/100 mobile and 100s desktop (63edd98, 4e2cb18)
- Locales load lazily, fonts are pruned, social tags are absolute, and a real 404 page replaces the SPA fallback (4641a04)
- One page per language: 15 prerendered pages with hreflang, a sitemap, RTL for Arabic; every quickstart command checked against the CLI (e197e59)
- Live checks: a sitemap walk with axe (0 findings on 15 pages) and a Chromium + Firefox + WebKit pass; the copy button reports failure instead of claiming success (4c4278a, 1ca96f9)
- `/docs/` is live: 7 pages × 15 locales, the deploy default (`--no-docs` builds the landing alone); one h1 per page and keyboard-scrollable code blocks (6624432, 6964982, 18241ac, 2d9a9e9)
- `deploy-site.sh --check` runs the live walk after the flip and rolls the release back when a page fails; live-check exits non-zero on failure and checks a preview URL where it lives (e0fc4ae, 529217f)
- One command deploys site/ to the VPS; docs/deploy.md covers the server, the release layout, the CI key and what is still open; the webtop container is gone and port 3001 is closed (b04262f, 47ce15c, f1b51d0, 53773a8)
- The site's frames, design.json and facts.json describe what actually ships (de35af2, ffddf2c, aee0f63)
- Round 12, Y3 · Sabah sisi: a softer visual system on the same content — periwinkle ground, white 24 px cards with one shadow, pills, Manrope + JetBrains Mono, a two-tone blue accent that meets 4.6:1 on every small text; og.png and favicons follow; live-check 120 pages clean, design_audit 0 findings, Lighthouse mobile 91 (live was 87) (c1c8c09)

### Docs

- Every command, flag, key and env var checked against the code both ways; drift fixed: three permission modes, `auto` effort, ROVECODE_STREAM's five values, the MCP verbs and trust gate, the unlisted keys (706d37a)
- README: the site and how it ships (e912782); status measured on today's HEAD, what landed after wave 4, Windows-first and Linux-checked (c2acdc5)

### Tests / Linux

- The suite runs on Linux: eleven Windows-only assumptions fixed, three of them product gaps (HOME honoured for the config directory, backslash session ids refused everywhere, drive-letter paths relativized on POSIX); the backslash-cwd git check is Windows-only (1dfd3fa, d24c590)
- The two headless surfaces are tested through the real process: a `serve` SSE run, an `acp` stdio session, and the MCP child reaped on exit (6aa25aa)
