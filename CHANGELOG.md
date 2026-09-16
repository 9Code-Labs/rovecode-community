# Changelog

What changed for the person using rovecode, newest first. Every line ends with the commit that carries
the change (hashes on `main`). Numbers are measurements from the commit that reports them, on the
machine it names.

Hashes on entries before 0.3.2 name commits in the checkout rovecode shared with its website until
2026-09-06. That repository is gone; the entries are kept because what they describe still ships.

## Unreleased

### Open-core boundary and supported APIs

- Added explicit package exports for the core, extension, plugin, and provider APIs, with contract tests and a documented 0.x compatibility policy.
- Added a CI-enforced one-way dependency boundary: public source cannot import private, hosted, commercial, or control-plane overlays.
- Added a separate product-auth boundary that excludes account, billing, entitlement, website/dashboard, and control-plane contracts while retaining generic local provider and MCP authentication.
- Added local documentation-link validation and a manual signed release checklist.
- Replaced the licensed Gitleaks Action with a checksum-pinned open-source CLI invocation and pinned all CI actions to immutable commits.

### Connect wizard: endpoint doors and the active model list

- A "your own URL" row in the wizard's provider list no longer fails with `unknown provider` when
  the key step arrives: it walks its own ENDPOINT step first (a short name and the base URL, both
  validated before the registry is touched), registers the row, and only then asks for the key.
- The model step pins the ACTIVE model list: rows are checked with space, `a` toggles all, Enter
  confirms — the checked rows become the provider's `models` entry in providers.json (served from
  the file afterwards, never re-fetched), an empty selection leaves the endpoint live ("use them
  all"), and one of the checked rows becomes the default and the session's model. When the endpoint
  cannot be listed, typing the id by hand still works exactly as before.

### Readiness-driven intro

- The animated intro remains on screen while the textbox and complete TUI are drawn offscreen.
  Reveal waits for both the intro choreography and real readiness (including the initial file list),
  then replaces the intro with the complete frame in a synchronized-output transaction. No visible
  empty frame/files-only stage or second panel stagger. Slow starts retain the loading screen;
  resize, startup cancellation and errors restore the terminal cleanly.
- Only the selected renderer is loaded. Sextant no longer loads the classic editor/markdown graph,
  classic no longer loads Sextant, and `--plain` loads neither renderer nor the TUI app.
- Automatic interactive repo-map indexing skips the home directory and filesystem root, avoiding
  unrelated SDK/cache trees. Actual project directories and explicit headless builds are unchanged.
- Fast preparation no longer makes the intro flash and disappear: the existing approximately 1.1s
  choreography runs alongside loading, not after it. See [startup behavior and validation](docs/startup.md)
  for the first-frame contract and opt-outs.

### Branch integration and startup responsiveness

- Integrated the remaining TUI ports: plain `!cmd` / `@path` input, image staging, the bare `/model`
  picker with context/pricing/reasoning metadata, and shared boot-note / command declarations
  (`99becc4`). The command table retains `/commit`, `/undo`, `/compact`, `/clear`, `/init`, `/copy`,
  `/agents` and `/config` from `aion-port`; plain `/init` expands before attachment processing.
- Repository-map warmup no longer monopolizes the event loop after the first frame (`510437f`,
  extended during integration). Enumeration is async, extraction is sliced, and graph ranking and
  budget search yield. Quitting cancels and drains the scan before resolving the TUI, preventing
  late cache writes and Windows cwd locks. A background failure omits the map rather than retrying
  synchronously on the next interactive prompt; headless runs retain their synchronous path.
- Plain git commands, compaction, shell commands and model turns share busy/interrupt/quit handling.
  EOF during a pending commit draft cancels it without committing or consuming another model turn.
- The Nimbus submission history is reconciled without replacing Rovecode's product tree. See
  The integration retained Rovecode’s product tree rather than importing an unrelated snapshot wholesale.

### Added

- The sextant's crew section is a card per workflow, not a row per task: a title, `3 agents · 01s`, and one chip
  per agent showing which CLI opened it (`codex claude codex`). A workflow is the RUN the tasks were started
  under — nothing invented, no time buckets or label matching: the manager stamps the run it bound, and tasks
  with no run are their own cards. Two rules the chips keep: a queued lane is hollow and dim while a running one
  is filled, so "codex is about to start" cannot look like "codex is working"; and only an external CLI lane
  shows a CLI's name — our own subagents show their agent name. Working workflows lead the section, since the
  header above it already said how many are working. At the panel's 32 cells the spacing goes first, then names
  collapse to counts (`codex ×2`) and a `+N`, then the title truncates, then whole cards go behind `+N more`;
  the agent count and the clock are never dropped, and a card that cannot show them is not drawn at all
- The card's fourth line is what the workflow has actually done — `wrote 4 files · 12 calls · 4.2k` — and it says
  `wrote` only about a patch that reached your tree. A cancelled or failed agent's files are reported as
  `discarded` (its worktree was thrown away), a live one's as `so far`, and a CLI that has confirmed nothing yet
  gets no file count at all rather than a `0` that would be false while it writes. Tokens are omitted when the CLI
  reported none, because a lane whose usage we could not read is not a lane that used nothing

- `/commit`, `/undo`, `/compact`, `/clear`, `/init`, `/copy`, `/agents list` and `/config` — the
  command surface the TUI was missing, ported in three parallel slices. `/commit` shows the
  model-drafted message ON THE APPROVAL CARD before git runs (the card is the only place it is
  visible before it is recorded); the first adaptation skipped the card and the commit went through
  unseen — found by the port's own tests, fixed before landing. `/undo` restores the previous
  checkpoint through two new read-only methods on the checkpoints table (a scratch index under the
  shadow git-dir; your real index is never touched), and `/undo` stopped being an alias note in the
  sextant — it is a real command now. `/copy` reaches the clipboard through PowerShell with explicit
  UTF-8 on Windows (clip.exe deliberately absent: code-page-dependent stdin). `/agents list` shows the
  loaded definitions while the BARE `/agents` stays the crew board
- An `@image` mention in the sextant rides the `/attach` seam instead of dying as "a binary file",
  and a reasoning block shows as one collapsed `reasoning · N tokens` row per assistant message.
  The harness's input-expand was deliberately NOT ported — rovecode's mentions.ts already is the
  feature, in a stricter format; porting over it would have put two wire formats in one binary.
  Reasoning text is never rendered because the loop drops it on purpose; the row counts what
  survives, the token estimate

### Changed

- `rovecode run "/init"` expands the BUILT-IN prompt instead of sending the literal string to the
  model: expandSlashPrompt consults the builtin table before custom command files, so a repo file
  named init.md cannot swallow it
- `/compact` is durable but cannot summarize on this build: the mechanism is complete (fresh-id
  branch, marker persisted, attachments parked and restored, Esc/Ctrl-C bound) but no surface wires
  a summarizer yet, so a real /compact keeps the window and SAYS so rather than pretending. The
  compaction marker omits `trigger` rather than writing a word the vocabulary has no honest value
  for. The seam exists; the day the core wiring lands, the already-written "with a summarizer" test
  turns green by itself
- The intro ends when the session is READY, not when its clock runs out. It was given a fixed ~1.1 s so it
  would not collapse into a single frame on a fast machine; measured on this one the session is ready at
  ~224 ms, so the other ~875 ms was an animation with nothing left to cover — and it was most of what
  "the UI opens late" meant. It still plays, and it still ends on the finished mark rather than cutting
  mid-sweep; it just stops waiting. `ROVECODE_TRACE_BOOT=1` now covers the stretch before the TUI starts,
  where that time was hiding: the previous trace began after it
- External CLI lanes are on by default. `ROVECODE_LANES_ALLOW` used to be an opt-in allow-list, so
  `task start codex` was refused on every machine until you found an env knob nobody reads — a CLI you had
  installed was unreachable. Unset now allows all four (`claude`, `codex`, `opencode`, `agy`); a value you
  set is still an exact list, so a narrower one is never widened behind your back, and `ROVECODE_LANES_ALLOW=`
  (empty) turns every lane off. Two things come with the new default. A lane whose CLI is not on PATH is
  refused BY NAME at the gate — before a worktree is built and a turn is spent, where it used to surface as
  `spawn failed: codex: ENOENT` afterwards; the check reads PATH only (plus PATHEXT on Windows) and is
  memoised, so `task start` in a loop does not re-stat the disk. And because the gate was also the only
  reason a lane paused for approval, every lane start now states its own flags — `spawn codex lane · sandbox
  workspace-write · approval never · worktree — started` — at every permission level, including `auto`, where
  no approval card is ever shown. That sentence is built from the same function as the card, so it cannot
  describe flags the lane did not get

### Fixed

- A rovecode launched from a pipe, a script or a wrapper that then closed its stdin hung FOREVER.
  Both surfaces listened for input and never for the pipe ending: the sextant's ProcessIO watched
  `data` only, and the classic surface's vendored terminal does the same, so the process sat in its
  event loop with nothing to wait for — measured 60 s+, killed only by an outer timeout. stdin END is
  now an exit on both surfaces: the sextant delivers ETX through the input subscriber (exactly what a
  real Ctrl+C delivers, so a running turn aborts and an idle surface quits through its normal close
  path), and the composition root exits the process when the classic side's input is gone. A TTY
  never ends, so a real terminal is unaffected

- A crash left your TERMINAL broken and told you nothing. The TUI puts the terminal on the alt screen with
  raw input, mouse reporting and focus reporting; quitting undid all of it and dying undid none of it. So an
  uncaught error handed the shell back inside the alt screen, still covered by the last painted frame, and
  every mouse movement afterwards typed escape sequences at the prompt — `[<222;39;51M[<222;38;51M` walking
  across the screen as the pointer moved. The reason it died went with the screen it printed on. rovecode now
  restores the terminal on any death, BEFORE anything that could itself fail, then writes what happened to
  `~/.rovecode/logs/crash-<date>-<time>.log` — name, message, stack, version, platform, cwd — and prints one
  stderr line naming the file. The log exists because restoring the alt screen erases the trace that would
  otherwise have been the only copy. A clean quit writes nothing: it is not a crash
- An isolated subagent could write to your live repository through an external CLI. A lane always built
  its worktree from the top-level root and merged its patch back there, whoever started it — so a subagent
  confined to its own worktree could start `codex`, and the CLI's diff landed straight in the real tree.
  The subagent could not write there; the lane it started could, and the subagent's own patch — the only
  record you read — said nothing about it. A lane now works in, and merges back into, the tree of whatever
  started it, so a nested lane's result travels up the same chain of patches as everything else. A lane
  started at the top level is unchanged: there the root IS the working tree
- Killing a command left its grandchildren running on POSIX. The signal reached the direct child only,
  so anything it had forked — `npm` inside a compound command, anything behind `&` — was orphaned, ran
  to completion and held stdout open while it did, which hung the runner rather than merely leaking a
  process. Abort now signals the whole process GROUP, then escalates to SIGKILL on the group if the
  grace expires. Windows was already covered by its Job Object; a run with no signal is spawned exactly
  as before on both platforms (3a6d3b1)
- A mistyped `--resume <id>` started a NEW empty session under the typed name and said nothing. It now
  exits 2 before the TUI boots, naming the reason and where to look; `--continue` with nothing to
  continue still starts fresh but SAYS so on the startup card. `--resume ../x` used to write its first
  entry outside the sessions root — one validator now gates both it and `trace` (5ceb21e)
- Listing sessions read the whole transcript of every session directory — on this machine 36 of them,
  35 with nothing in them — and `--continue` paid that scan to find one id. It is now a readdir plus one
  stat per directory, and a directory nothing was ever written to is never opened (5ceb21e)
- The memory a session wrote died with the session id, and the USER block — preferences meant to follow
  the person across projects — was written INSIDE the repository. MEMORY is now project-scoped and USER
  lives under the user home; a legacy per-session store is copied forward once, originals untouched
  (240c296)
- An agent file's problem reached you as `plugins: agents: explore.md: skipped`. Four subsystems were
  reporting under a fifth's name; each note now carries its own word (bc31587)
- Every untrusted-file note told you to run a terminal command — read inside the TUI, an instruction to
  quit in order to approve something. Both spellings are now on the line (30638b3)

- A subagent's request to the model carried no tool schemas. Every surface that starts a run passes the
  tool list; the one path that starts a child never did, so a task child on a model that calls tools
  natively was handed a request with no tools and could call nothing, whatever its registry held. The
  scripted models in the tests ignore the tool list, which is how it stayed invisible. A child now sends
  exactly its own registry's schemas, and a loopback provider test counts them per request

- `ROVECODE_MOCK=1` now always means the canned provider. It used to be ignored whenever a provider was
  configured — with a key exported, `ROVECODE_MOCK=1 rovecode run "say hi"` reached the real model and cost
  $0.09 for one turn, while the flag's own comment promised a mock. The suite never saw it because the test
  harness scrubs keys before the CLI starts; the new test counts the requests that must not happen

### Added

- **External agentic-CLI lanes.** `task start {agent: "codex"}` runs codex — or claude, opencode,
  antigravity — as a job of the manager that already runs our own subagents: its own git worktree, its
  diff merged back as a patch, the same completion note. A nested CLI was always possible through
  `bash`; what it could not do was tell anyone. The approval card now names the CLI, the flags it will
  run with and the directory, BEFORE the process exists, and a lane's permissions are quoted from the
  CLI's own flags rather than paraphrased in ours. OFF unless `ROVECODE_LANES_ALLOW` lists the id, and
  the refusal names the variable (8c0fb24)
- **`rovecode trust`.** A cloned repository could make this machine run code through five files and was
  asked about one. The worst was `.rovecode/hooks.ts` — imported IN-PROCESS at boot, with your
  privileges, before the first prompt is read. Also gated now: `sandbox.json` (which rung and which
  docker image every bash command runs in), and the `verify`, `lsp` and `notify_command` settings keys.
  One store, keyed by sha256, so an edited byte asks again; `rovecode trust show` says what each file
  WOULD do; `/trust` answers it in the TUI. Enforced inside loadSettings, so no consumer can forget.
  `.rovecode/commands/*.md` and `agents/*.md` stay out on purpose: prompt text, a different gate
  (08f355a, 240c296)
- **Background shell jobs.** `bash … run_in_background: true` returns a job id at once —
  `bash_output` reads only what is NEW since your last read, `bash_list` shows them, `bash_kill` stops
  one and everything it started. `timeout_ms` gives up on a deadline and RETURNS what the command
  printed, because a build that timed out has usually already printed the reason. Jobs die with their
  session (6048215)
- **Sign in instead of pasting a key**: `rovecode auth login github-copilot` (device code) and
  `openrouter` (PKCE, loopback). Tokens sit beside the API keys, 0600, refreshed in the streaming path.
  `anthropic` is refused — a subscription login is an owner's decision, not a port (9b7a0ac)
- **The OpenAI Responses wire**, which is what a stored ChatGPT token can actually be sent over; the
  `openai` login refusal was lifted in the same change that made it work. Reasoning items are not
  replayed to the model yet, and `rovecode help env` says so under `ROVECODE_OPENAI_WIRE` (0aa46a0)
- **MCP prompts and resources**, not just tools: `mcp_prompts`, `mcp_prompt`, `mcp_resources`,
  `mcp_read`. A server behind OAuth can be signed into with `rovecode mcp login` — through the trust
  gate, which the upstream version went around (4a02798)
- **`--add-dir <dir>`**, and the workspace boundary it needed. Reading a file outside the project used
  to be silently allowed; a path outside every root is now a card that names the path, the roots that
  exist and the way out, remembered per directory. Measured before shipping: zero new prompts under
  `permission=auto`, zero inside the project under accept-edits. Checkpoints do NOT span added roots
  and `/restore` will not undo a change under one — stated at boot, in `rovecode doctor`, in the module
  and here, rather than shipped as a version that looks whole (3416586)
- **Custom subagents**: `.rovecode/agents/<name>.md` — description, model, plan-or-act mode and a tool
  allow-list that is a FILTER, not a label. A definition can never widen a child, and a reserved lane
  id is refused with a reason rather than either side silently winning (ad97ffa)
- **`rovecode sessions`** list · rename · delete · fork · search, and the same four verbs as `/sessions`
  in the TUI. Delete removes the session AND its checkpoints shadow repo; fork is bounded at 256 MB,
  measured before anything is copied (5ceb21e, 240c296)
- **`rovecode skills`** list · validate · pack · install. A `SKILL.md` the loader disagreed with used to
  load under the wrong name or vanish without a word; it now loads with a warning, and `skills list` is
  where those warnings live. A URL install goes through the same SSRF guard as `web_fetch`, re-checked
  on every redirect hop (33ce2c1)
- **`web_search`** beside `web_fetch`, same network class, same SSRF guard, and a keyless default that
  does not pretend to be a credentialed one (824cddf)
- **A language-server TABLE** behind the per-edit diagnostics gate (`ROVECODE_LSP` or the `lsp` setting),
  so it is no longer TypeScript-only. A configured server that is not on PATH is named ONCE, at boot and
  in `rovecode doctor`, with the extensions it would have covered (47e5cca)
- **Metrics and logs on the OTel exporter**, not just traces: token counters, cost, tool durations,
  retry notes, the approval ledger and a span per external lane. A lane that reported no usage emits
  nothing rather than zeros (3a5f82e)
- **Notifications that fire only when you are not looking.** The bell used to ring on every run
  regardless of focus, which is the same as not ringing. `notify_when: always` restores the old
  behaviour; on Ghostty, iTerm2, kitty, Warp and WezTerm `auto` sends a desktop toast instead. A
  `notify_command` is argv with no shell, the run's text lands as one JSON argument, and it goes through
  the same policy a bash command does (34c43e5)
- **`!cmd` in the composer** — promised by the input classifier since before this repository existed and
  consumed by nothing. It goes through the app's own approver, so a `!cmd` and a model turn share ONE
  approval path (240c296)
- `@`-mentions reach `~/` and absolute paths (240c296)

- `/trust` in the TUI: the project trust gate can be answered where you are. A checkout's `.rovecode/hooks.ts`,
  `sandbox.json`, MCP files and the `verify` / `lsp` / `notify_command` settings keys do nothing until this
  machine approves that exact content, and until now the only yes was to quit the session and run `rovecode
  trust` — the shape of friction that gets a gate switched off. `/trust` prints the same lines `rovecode trust
  show` prints (what each file would run, with its values), then asks per file. The highlighted item is "keep
  them untrusted", so Enter on an untouched card refuses; "approve all N" appears only after that listing and
  only when there is more than one file. Approving records the file's current bytes, so a later edit asks again
- `/sessions rename <title…> | delete <id> | fork [<id>] | search <terms…>` in the TUI — the four verbs
  `rovecode sessions` already had, over the one resolver, without leaving the session. Delete resolves the id
  first, asks on one card naming the session, and removes the session directory AND its checkpoints shadow
  repo (a half-delete leaves the space used with nothing pointing at it); deleting the session you are IN moves
  you to a fresh one before the old directory goes. A renamed session now shows its title where you resume it,
  as `rovecode sessions list` already did

- Custom subagents: a markdown file in `.rovecode/agents/<name>.md` (or `~/.rovecode/agents/`) is an agent the
  `task` tool can start by name, with its own prompt (the body), model, plan or act mode and a tool
  allow-list that is a filter over the child's tools — `tools: [read, grep]` yields exactly read and grep,
  and a definition can never hand a child more than the agent that started it has. Files that cannot be
  honoured are refused when the session starts, each with a line naming the file: a reserved name (`main`
  and the four external-lane ids keep their meaning), a mode other than plan or act, a model on a provider
  other than the one this session streams over, a YAML list or an empty `tools:` (which never means "all")
- `--add-dir <dir>` (repeatable, every surface) makes a second directory part of the workspace, and with it
  the workspace gained an edge it never had: a file tool aimed at a path outside the project and outside every
  added root now asks first, on one card that names the path, the project, the roots that exist and the remedy
  — before this an absolute path anywhere on the disk was read without a word. Inside the project and inside a
  root nothing changed; a session in auto mode or accept-edits sees no new question
- The limit that comes with roots, named rather than discovered later: checkpoints snapshot the project
  directory only, so a change under an added root is not undone by /restore. rovecode says so at start, in
  `rovecode doctor --add-dir <dir>`, and here

## 0.3.2 — 2026-09-06

### Fixed

- `--max-cost 0.15` sent its own number to the model as part of the prompt: the flag was not in the
  parser's value list, so the budget was consumed as a flag and `0.15` was consumed as the request. A
  run asked to build a page came back with `0.15` used as a CSS opacity. The test now walks the whole
  flag table instead of the three entries someone remembered

### Added

- A run that changed files can check its own work before it says done: rovecode works out what checking
  this project costs (a `verify` list in settings, or inferred from package.json / Makefile / pyproject),
  runs it once at the end, and on failure gives the model one turn with the failing part quoted. Off by
  default — `ROVECODE_VERIFY=1` turns it on, and `rovecode doctor` says which commands it would run
- `rovecode doctor` gained a verify row: what would run, where it came from, and — when nothing is
  configured — that this is the blind spot, named rather than silently skipped

### Changed

- The website moved out. rovecode is its own repository with its own history; site/ was 250 MB of the
  old pack and none of it was ever read by a build here. Content still lives here and is published to
  the site with `bun run publish:site`

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
- Historical website deployment details were removed from the public core repository; the website is maintained separately.
- The site's frames, design.json and facts.json describe what actually ships (de35af2, ffddf2c, aee0f63)
- Round 12, Y3 · Sabah sisi: a softer visual system on the same content — periwinkle ground, white 24 px cards with one shadow, pills, Manrope + JetBrains Mono, a two-tone blue accent that meets 4.6:1 on every small text; og.png and favicons follow; live-check 120 pages clean, design_audit 0 findings, Lighthouse mobile 91 (live was 87) (c1c8c09)

### Docs

- Every command, flag, key and env var checked against the code both ways; drift fixed: three permission modes, `auto` effort, ROVECODE_STREAM's five values, the MCP verbs and trust gate, the unlisted keys (706d37a)
- README: the site and how it ships (e912782); status measured on today's HEAD, what landed after wave 4, Windows-first and Linux-checked (c2acdc5)

### Tests / Linux

- The suite runs on Linux: eleven Windows-only assumptions fixed, three of them product gaps (HOME honoured for the config directory, backslash session ids refused everywhere, drive-letter paths relativized on POSIX); the backslash-cwd git check is Windows-only (1dfd3fa, d24c590)
- The two headless surfaces are tested through the real process: a `serve` SSE run, an `acp` stdio session, and the MCP child reaped on exit (6aa25aa)
