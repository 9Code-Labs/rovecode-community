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
  rovecode model               pick the default from a numbered menu (rovecode models lists them)
  rovecode model use <provider/model>     set it directly · --project pins it to this repo
  --effort off|low|medium|high  how hard I think before answering (/effort in the TUI, ROVECODE_EFFORT=…)
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
  rovecode help env               every ROVECODE_* setting
  rovecode help advanced          acp · serve · gauntlet · bench · trace · tools · smoke-tui · output modes · sandbox
  rovecode help all               everything on one page`;

const ADVANCED = `advanced — the full command reference
  rovecode                      interactive TUI chat — the sextant surface (files · code · messages · plan · usage · pet)
                            on a truecolor TTY of at least 100x30, else the classic pi-tui chat;
                            --classic forces the classic chat · --pet <name> names the pet · --plain = readline REPL
  rovecode --resume <id>        open the TUI resuming a session (full id or unique prefix)
  rovecode "prompt"             one-shot task (same as run)
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
  rovecode auth set <provider> [--key <name>]  store an API key (prompts on stdin; ~/.rovecode/credentials.json)
  rovecode auth list            stored providers + key names (values redacted)
  rovecode auth remove <provider>  delete a stored credential
  rovecode provider list [--all]  providers with a key + every providers.json entry, and the default provider/model
  rovecode provider add <id> <baseUrl> [--protocol openai|anthropic] [--key-env NAME] [--model <id>] [--no-key] [--project] [--key]
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
  rovecode trace <session-id>   print session tree events (JSONL)
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
  ROVECODE_STREAM     streaming is on by default (both protocols); =off|json uses the one-shot JSON adapters
  ROVECODE_EFFORT     off|low|medium|high thinking before the answer (default off). Anthropic gets
                    output_config.effort or a thinking budget, whichever the model takes (learned from
                    its own 400, then remembered); OpenAI gets reasoning_effort. Thinking is billed as
                    output and delays the first word.
  ROVECODE_PROFILE    model profile: off, or an id (glm-5.3 | glm-5.3-plain) whose PROMPT section is forced onto
                    every model (request fields always follow the model id). Unset = by model id: GLM-5.3 / -Flash
                    get the Claude Sonnet 5 persona + the working agreement appended to the system prompt
                    (glm-5.3-plain = agreement only) plus, on OpenAI-compatible providers, Z.ai's
                    request fields (thinking always on, reasoning_effort low|high|max — off leaves the endpoint's
                    max, medium rounds up to high, high means max — and tool_stream when streaming). The text
                    comes from .rovecode/profiles/<id>.md (project) or ~/.rovecode/profiles/<id>.md when present.
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
  ROVECODE_RETRY_MAX  same-model retries after a 429/5xx/transport failure (default 3; 0 = off)
  ROVECODE_RETRY_BASE_MS  first backoff cap in ms (default 2000; exponential, full jitter, Retry-After honored)
  ROVECODE_WEBFETCH_TIMEOUT_MS  web_fetch request timeout in ms (default 30000)
  ROVECODE_WEBFETCH_ALLOW_PRIVATE=1  let web_fetch reach loopback/private hosts (SSRF guard escape for local dev)
  ROVECODE_COMPACTION  history compaction strategy: head-summarize (default) | keep-window | provider-native
  ROVECODE_TASKS_MAX  concurrent background tasks (default 3; further task starts queue FIFO)
  ROVECODE_OTEL_ENDPOINT  OTLP/HTTP collector, e.g. http://host:4318 — one trace per run (run ⊃ turn ⊃ tool); unset = off
  ROVECODE_OTEL_HEADERS  extra OTLP headers as k=v,k2=v2 (e.g. authorization=Bearer …)
  ROVECODE_REFLECTION=0  disable reflection nudges after failed edits; ROVECODE_REFLECTION_MAX caps them per run (default 2)
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
