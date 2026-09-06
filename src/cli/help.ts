/** `rovecode help [topic]` — short and grouped by default; `env`, `advanced` and `all` hold the full
 *  reference. Pure text so it is unit-testable (main.ts dispatches on import). Wording follows
 *  core/voice.ts: plain sentences, the two permission modes by their screen names. */

import { MODE_ASK, MODE_AUTO } from "../core/voice.ts";

export const HELP_TOPICS = ["", "env", "advanced", "all"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

const SHORT = `rovecode — a coding agent in your terminal

start here
  rovecode                        open the cockpit (--classic: the plain chat · --plain: a bare REPL)
  rovecode "fix the failing test" one task, then exit
  rovecode connect                connect a model: pick a provider, paste the key (hidden), one test call
  rovecode connect <id> [<url>]   the same in one line — rovecode connect anthropic · rovecode connect me https://host/v1

everyday
  rovecode run "<prompt>" --yolo  one task in ${MODE_AUTO} mode
  rovecode run "<prompt>" --output json   machine-readable result (ndjson: one line per event)
  rovecode model               pick the default from a menu · model use <provider/model> sets it (--project pins it here)
  rovecode market search <q>   MCP servers, skills and plugins on one shelf; install any with market install <id>
  --effort auto|off|low|medium|high  how hard I think before answering (/effort in the TUI, ROVECODE_EFFORT=…)
  rovecode provider list|add|remove|test  endpoints in ~/.rovecode/providers.json — live, no restart
  rovecode auth set <id>          store an API key (hidden prompt) · auth list · auth remove <id>
  rovecode --resume <id>          reopen a session · rovecode export <session> writes it as markdown

safety
  ${MODE_ASK} (default)           I read freely; I ask before every write, shell command and subagent
  accept edits (--accept-edits) I write inside this folder without asking; shell, subagents,
                            network and writes OUTSIDE it still ask (/accept-edits, ROVECODE_ACCEPT_EDITS=1)
  auto (--yolo, ROVECODE_YOLO=1)  I never ask — deny rules and plan mode still hold
  /yolo --save · /accept-edits --save   make the level stick (add --project to pin it to this repo);
                            without --save a toggle lasts one session. ROVECODE_PERMISSION=ask|accept-edits|auto
  plan mode (/plan in the TUI)  read-only: I can look and plan, not change anything

more
  rovecode help env               every ROVECODE_* setting (incl. the bash sandbox rungs)
  rovecode help advanced          market · context · mcp · plugins · acp · serve · gauntlet · bench · trace · tools
  rovecode help all               everything on one page`;

const ADVANCED = `advanced — the full command reference
  rovecode                      interactive TUI chat — the sextant surface (files · code · messages · plan · usage · pet)
                            on a colour TTY of at least 100x30 (truecolor, or 256 colours through the
                            quantizer), else the classic pi-tui chat;
                            --classic forces the classic chat · --pet <name> names the pet · --plain = readline REPL
                            --no-intro (or ROVECODE_INTRO=0) skips the ~0.9s opening animation
  rovecode chat · rovecode repl  the same as bare rovecode (repl still needs --plain for the readline REPL)
  rovecode --help | -h          this help (only with no command in front of it) · rovecode --version prints the
                            version to stdout and the update check’s answer to stderr
  rovecode --resume <id>        open the TUI resuming a session (full id or unique prefix)
  rovecode --continue           reopen the newest session that holds something (also: --resume with no id);
                                nothing to continue from → a fresh session
  rovecode "prompt"             one-shot task (same as run; a lone path-shaped word — ./x, x.ts, an existing
                                name — is confirmed on a TTY and refused with exit 2 off one: use "rovecode run" to send it)
  rovecode setup                connect a model step by step (TTY only; piped stdin prints the recipe and exits 2)
  rovecode connect              the same wizard when given no arguments
  rovecode connect <id> [<baseUrl>] [--model <id>] [--key | --key-stdin | --key-env NAME | --no-key]
                              [--protocol openai|anthropic] [--project] [--no-test]
                              one line: register the endpoint, store the key, pick the model, one tiny real
                              call, persist the default. A key is never a flag value (shell history, ps):
                              --key prompts hidden, --key-stdin reads one piped line (CI), --key-env names
                              an env var, --no-key marks a local server.
                              exit 0 connected · 1 the test call failed (config still written) · 2 usage
  rovecode smoke-tui            render check: full pipeline into an 80x24 terminal emulator (dev-only)
  rovecode smoke-tui --sextant  render check: the sextant surface at 160x44 through the full pipeline (no emulator needed)
  rovecode run "<prompt>"       run an agent task (--yolo = ${MODE_AUTO}; a scripted mock answers when no provider is configured)
                            "/name args" expands a custom command (.rovecode/commands/<name>.md, else ~/.rovecode/commands)
                            the way the TUI does; an unknown /name is sent verbatim; model:/mode: frontmatter is
                            TUI-only and not applied headlessly
                            piped stdin is appended to the prompt as a fenced block — git diff | rovecode run "review this"
                            (never read from a terminal; --no-stdin ignores it; an open pipe that sends nothing
                            for 3 s is skipped with a note; capped at 1 MB)
    --max-turns N · --max-seconds S|off   ceilings on one run; a hit ends it cleanly with status
                            "budget" (exit 1) and the work so far, instead of an external kill. Headless runs
                            default to a 20-minute wall clock; --max-seconds off removes it
    --max-cost D|off        a spend ceiling in dollars for one run, priced from each turn's usage as it lands
                            (the catalog's rates for the model that served it); the same clean "budget" end.
                            A turn the catalog cannot price adds nothing and is counted in the summary
    --output <text|json|ndjson>  text (default): progress + the final answer on stdout
                            json: exactly ONE result object on stdout {status, summary, sessionId,
                            model:{provider,model}, origin (served model|null), usage:{input,output,cacheRead,
                            cacheWrite}, costUsd (null when unpriced), toolCalls:[{tool,ok,ms?}], durationMs, exitCode}
                            ndjson: one JSON line per RunEvent, then a final {type:"result"} line
                            json/ndjson: stdout carries only JSON, progress goes to stderr
                            exit codes: 0 done · 1 error/budget · 2 usage/startup error · 130 aborted (Ctrl-C)
                            exit 2 = usage/startup error (bad --output value, sandbox misconfig or unavailable rung):
                            one stderr line, nothing on stdout; --output=<mode> is accepted as well
  rovecode bench                run cross-harness micro-benchmarks (edits, sessions)
  rovecode gauntlet             run the adversarial evaluation suite (offline, scripted model)
  rovecode gauntlet --live      the gauntlet's tasks minus loop-guard (9) against the configured REAL model through
                                the real prompt — --model <provider/model> and --effort pick; compare pass/calls/tokens
  rovecode tools                list registered tools
  rovecode plugin list          plugins in ~/.rovecode/plugins and .rovecode/plugins with status (active · disabled · untrusted · broken)
  rovecode plugin add <folder|git-url> [--project] [--force]  install a plugin folder (tools, hooks, commands, skills, MCP in one manifest)
  rovecode plugin trust <name>  approve a PROJECT plugin's current files on this machine (show <name> lists them first)
  rovecode plugin remove|enable|disable|untrust|show <name>   (docs/plugins.md; restart to load — read once per process, like hooks)
  rovecode mcp search [query]   MCP servers to install: the curated shelf, then the official registry (cached a day)
  rovecode mcp info <name>      publisher, version, the exact command or URL, the keys it asks for
  rovecode mcp add <name> [--project] [--pick N] [--as <name>] [--yes] [--force]  show the plan, ask for keys
                            masked, write ~/.rovecode/mcp.json (or .rovecode/mcp.json); --as renames it, --force replaces an entry
  rovecode mcp remove <name> [--project] · rovecode mcp list   (docs/mcp-market.md; /mcp does the same inside the TUI)
  rovecode mcp show             this repo's .rovecode/mcp.json + .mcp.json: exact commands/URLs, env names, trusted or not
  rovecode mcp trust [--yes] · rovecode mcp untrust   approve those files as they are now, or withdraw that
                            approval — until trusted nothing in them loads; your own add --project is trusted as you approve it
  rovecode market search [query] [--kind mcp|skill|plugin]  one shelf over MCP servers, skills and plugins
  rovecode market info <id>     publisher, licence, version, exactly what an install would write
  rovecode market docs <id>     the item's own documentation, as the catalog carries it — no network
  rovecode market install <id|kind:id|git-url|npm-pkg> [--project] [--ref <branch|tag|commit>] [--yes]
                            plan first, write only after you agree
  rovecode market list|remove|update|sources   what is installed, what is behind, where each shelf came from
  rovecode market verify [id]   re-hash what is installed and say what has changed since
  rovecode market validate <path|url> [--kind skill|plugin]   check a catalog before anyone trusts it
                            (docs/market.md; /market does the same inside the TUI; every subcommand takes --json)
  rovecode context [session] [--json]  what fills the window, item by item, and how far our estimate is from
                            the provider's own count of the same prompt (cache reads included — they are the prompt too)
                            (--exact asks Anthropic to count it for real; --no-runtime skips the system prompt and tool schemas)
  rovecode auth set <provider> [--key <name>]  store an API key (prompts on stdin; ~/.rovecode/credentials.json)
  rovecode auth list            stored providers + key names (values redacted)
  rovecode auth remove <provider>  delete a stored credential
  rovecode provider list [--all]  providers with a key + every providers.json entry, and the default provider/model
  rovecode provider add <id> <baseUrl> [--protocol openai|anthropic] [--key-env NAME] [--model <id>] [--no-key]
                              [--project | --user | --scope user|project] [--key]
                              register any OpenAI-compatible or Anthropic endpoint in ~/.rovecode/providers.json
                              (--project: ./.rovecode/providers.json); --key prompts for the secret (never echoed);
                              running TUIs/servers pick the change up live — no restart
  rovecode provider remove <id>  delete a providers.json entry (built-ins: rovecode auth remove <id> drops the key)
  rovecode provider test <id> [model]  one tiny real call — proves url + key + model together
  rovecode model list [provider]  model ids (providers.json "models" or the endpoint's /models); * = current default
  rovecode models [provider]  alias for model list
  rovecode model              no arguments on a terminal: every configured provider's models in one
                            numbered menu, the current one first; a pipe gets the usage line instead
  rovecode model use <provider/model> [--project]  persist the default (in the TUI: /model <provider/model> --save)
  rovecode model show [provider/model]  the model, its protocol, and the exact thinking field each /effort
                            level puts on the wire (docs/thinking.md)
  rovecode trace <session-id>   the session's messages, one line each (role · first 120 chars · tool-call count)
  rovecode export <session>     write a session as markdown (--json: raw JSONL copy; --out <path>; --force)
  rovecode eval                 alias for gauntlet
  rovecode acp                  Agent Client Protocol v1 endpoint over stdio (Zed/JetBrains)
  rovecode serve                headless HTTP server (ROVECODE_PORT, default 4100; loopback-only)`;

const ENV = `env — every ROVECODE_* setting
  ROVECODE_BASE_URL   any OpenAI-compatible or Anthropic endpoint
  ROVECODE_API_KEY    API key (falls back to OPENAI_API_KEY)
  ROVECODE_MODEL      model id (e.g. zai-org/glm-5.3)
  ROVECODE_MODEL_<ROLE>  role fallback chain, comma-separated provider/model list; on 429/5xx
                  the next candidate serves. Roles: DEFAULT SMOL PLAN COMMIT TASK
                  (e.g. ROVECODE_MODEL_DEFAULT=kaesra/zai-org/glm-5.3-flash,openai/gpt-4o-mini)
  ROVECODE_STREAM     streaming is on by default (both protocols); off|json|0|false|none use the one-shot JSON
                    adapters; sse forces the raw SSE adapter, without the tool-call middleware, for one-shot runs
  ROVECODE_EFFORT     auto|off|low|medium|high thinking before the answer (default auto: the provider's
                    own default stands). Anthropic gets output_config.effort or a thinking budget,
                    whichever the model takes (learned from its own 400, then remembered); OpenAI gets
                    reasoning_effort. Thinking is billed as output and delays the first word.
  ROVECODE_PROFILE    model profile: off, or an id (glm-5.3 | glm-5.3-plain) whose PROMPT section is forced onto
                    every model (request fields always follow the model id). Unset = by model id: GLM-5.3 / -Flash
                    get the Claude Sonnet 5 persona + the working agreement appended to the system prompt
                    (glm-5.3-plain = agreement only) plus, on OpenAI-compatible providers, Z.ai's
                    request fields (thinking always on, reasoning_effort low|high|max — off leaves the endpoint's
                    max, medium rounds up to high, high means max — and tool_stream when streaming). The text
                    comes from .rovecode/profiles/<id>.md (project) or ~/.rovecode/profiles/<id>.md when present.
  ROVECODE_DESIGN     off drops the interface-design section from the system prompt (for runs with no UI in
                    them). Otherwise every run carries it: propose three distinct directions before the first
                    UI in a project, let the human choose, record it with design_direction, then build to it.
                    The section prescribes NO palette, typeface or layout -- there is no default look, on
                    purpose -- and names the patterns to climb out of (amber accents, the reflex full-viewport
                    hero, Inter/Roboto/Poppins, hairlines round everything, all-square corners, everything
                    centred, violet gradients). The choice lives in .rovecode/design.json; design_audit counts
                    those patterns in the files you touched and checks them against it.
  ROVECODE_PERMISSION  ask|accept-edits|auto — the level this run starts at. Ladder, widest first:
                    a CLI flag, then this, then <cwd>/.rovecode/settings.json, then ~/.rovecode/settings.json,
                    then "ask". Write the files with /yolo --save or /accept-edits --save [--project].
  ROVECODE_ACCEPT_EDITS=1  start in accept-edits (writes inside the workspace do not ask)
  ROVECODE_YOLO=1     ${MODE_AUTO}: allow all tool actions
  ROVECODE_TUI        sextant | classic — force the TUI surface (sextant still needs a TTY; --classic wins)
  ROVECODE_THEME      sextant palette: night (default) | ember | contrast (/theme switches it live)
  ROVECODE_PET=0      hide the sextant pet panel (rovecode); --pet <name> renames it
  ROVECODE_SANDBOX    executor rung for bash: direct (default) | wsl | docker; beats .rovecode/sandbox.json {"rung","dockerImage"}
  ROVECODE_SANDBOX_IMAGE  image for the docker rung (default debian:stable-slim; must contain bash)
  ROVECODE_RETRY_MAX  same-model retries after a 429/5xx/transport failure (default 3 = 4 attempts; 0 = off)
                    The wait is announced live, while it is happening, not in a summary after the run
  ROVECODE_RETRY_BASE_MS  cap of the FIRST backoff, ms (default 1000; full jitter; a Retry-After hint is a floor)
                    It doubles per attempt up to 20 s, and a server hint can raise the wait, never shorten it
  ROVECODE_FIRST_BYTE_TIMEOUT_MS  how long a provider may go without ANY response before the request
                    counts as failed and is retried (default 60000). Only the FIRST byte is on this clock:
                    once the model is talking, the body may take as long as it takes
  ROVECODE_WEBFETCH_TIMEOUT_MS  web_fetch request timeout in ms (default 30000)
  ROVECODE_WEBFETCH_ALLOW_PRIVATE=1  let web_fetch reach loopback/private hosts (SSRF guard escape for local dev)
  ROVECODE_COMPACTION  history compaction strategy: head-summarize (default) | keep-window | provider-native
  ROVECODE_TASKS_MAX  concurrent background tasks (default 3; further task starts queue FIFO)
  ROVECODE_OTEL_ENDPOINT  OTLP/HTTP collector, e.g. http://host:4318 — one trace per run (run ⊃ turn ⊃ tool); unset = off
  ROVECODE_OTEL_HEADERS  extra OTLP headers as k=v,k2=v2 (e.g. authorization=Bearer …)
  ROVECODE_REFLECTION=0  disable reflection nudges after failed edits; ROVECODE_REFLECTION_MAX caps them per run (default 2)
  ROVECODE_PORT       port for rovecode serve (default 4100; loopback-only)
  ROVECODE_IMAGE_MAX_BYTES  per-image cap in bytes for pasted and attached images (default 5 MB;
                    at most 8 images per message). Over it, the image is refused by name, not silently dropped.
  ROVECODE_REPOMAP_TOKENS  repo-map budget in tokens (default 1024); ROVECODE_NO_REPOMAP=1 drops the map entirely
  ROVECODE_HOOK_TIMEOUT_MS  per-hook-call budget in ms (default 5000); ROVECODE_NO_HOOKS=1 skips hook files
  ROVECODE_PLUGIN_TIMEOUT_MS  per-plugin import + tools() budget in ms (default 5000);
                    ROVECODE_NO_PLUGINS=1 skips plugin discovery
  ROVECODE_NO_CHECKPOINTS=1  turn off the shadow-git checkpoints taken after mutating tools
  ROVECODE_TOOL_MIDDLEWARE=1  force the text tool-call protocol (a prompt block + a parser) even for a model
                    the catalog says has native tool calling; ROVECODE_NO_TOOL_MIDDLEWARE=1 forces native only
  ROVECODE_EVAL_CELL=1  register the persistent eval cell tool (a REPL that keeps state between calls)
  ROVECODE_MAX_TURNS  turn ceiling for one run, every surface (TUI included); a hit ends it with status
                    "budget" and exit 1
  ROVECODE_MAX_SECONDS  the same as a wall clock, or "off". Every surface honours it, but only
                    one-shot runs have a DEFAULT (1200 s) — the TUI has no clock unless this sets one
  ROVECODE_MAX_COST   the same in dollars for one run (--max-cost on a one-shot run), or "off"; no default
  ROVECODE_HOME       credentials + user-scope providers/commands dir (default ~/.rovecode)
providers: built in — kaesra openai anthropic deepseek groq openrouter ollama lmstudio
            together mistral cerebras fireworks perplexity xai moondream vllm
            plus anything in ~/.rovecode/providers.json or ./.rovecode/providers.json (rovecode provider add)
            key: rovecode auth set <id>, or set <ID>_API_KEY — stored creds beat env;
            default: providers.json "default" ("provider/model"), ROVECODE_MODEL overrides the model,
            ROVECODE_BASE_URL/ROVECODE_API_KEY always wins`;

/** the text for a topic; an unknown topic gets the short page plus a one-line note */
export function helpText(topic = ""): string {
  switch (topic) {
    case "": return SHORT;
    case "env": return ENV;
    case "advanced": return ADVANCED;
    case "all": return `${SHORT}\n\n${ADVANCED}\n\n${ENV}`;
    default: return `${SHORT}\n\nno help topic "${topic}" — topics: env · advanced · all`;
  }
}
