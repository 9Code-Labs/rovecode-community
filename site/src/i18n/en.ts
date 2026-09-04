/** The English source of every translatable string on the page. Facts, commands, file names, provider names,
 *  env vars and the transcript of the real TUI frame stay in `content.ts` and are never translated — they are
 *  what you actually type. Other locales are `Partial<Dict>`, so an untranslated key falls back to this file. */
export const en = {
  meta: {
    title: "Rovecode — a coding agent for the terminal",
    description:
      "Rovecode is an open-source coding agent for the terminal: a panelled TUI cockpit, 16 built-in providers or any OpenAI-compatible endpoint, deny-default tool policy, session tree with rewind. TypeScript on Bun, AGPL-3.0.",
  },

  nav: {
    cockpit: "Cockpit",
    capabilities: "Capabilities",
    terminal: "Terminal",
    quickstart: "Quickstart",
    providers: "Providers",
    security: "Security",
    faq: "FAQ",
  },

  ui: {
    skip: "Skip to content",
    backToTop: "Rovecode, back to top",
    sections: "Sections",
    readme: "README",
    github: "GitHub",
    copy: "copy",
    copied: "copied",
    copyAria: "Copy command",
    copiedAria: "Copied",
    or: "or",
    play: "play",
    pause: "pause",
    playAria: "Play the background video",
    pauseAria: "Pause the background video",
    language: "Language",
    sitemap: "Site map",
    footerLabel: "Footer",
    facts: ["open source", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },

  hero: {
    /** the word between *asterisks* is set in the ink accent blue at medium weight; every locale marks exactly one
     *  word this way, which is why it is a marker and not a separate key to match against */
    title: "A terminal coding agent with a *cockpit*, not a chat log.",
    sub: "Rovecode runs on Bun, speaks to 16 providers or any OpenAI-compatible endpoint, and passes every tool call through a deny-default policy before it touches your repository. Free software under AGPL-3.0.",
    ctaGithub: "View on GitHub",
    ctaReadme: "Read the README",
    caption:
      "Real frame: the approval card for bun test, the +4 −1 edit row, context at 13 % of 200k. Rendered through the sextant painters at a fixed clock.",
    quip: "need a nod from you.",
    mood: "patient",
    frameAlt:
      "The sextant TUI at 160 by 44 cells: files tree with git statuses, the code panel showing src/auth/callback.ts with the edited lines highlighted, the messages panel with read and edit tool rows and an approval card asking to run bun test, the plan at 1 of 4 steps, usage at 13 percent context, and the rovecode cloud pet asking for a nod.",
    chips: ["+4 −1 landed", "ask first · approval card", "context 13 % of 200k"],
  },

  proof: {
    eyebrow: "from the repository, 2026-09-02",
    ariaLabel: "Numbers from the repository",
    stats: [
      { label: "tests", note: "unit + integration, bun test" },
      { label: "ported patterns", note: "each traced to file:line in a snapshotted source" },
      { label: "panels", note: "files · code · messages · plan · usage · rovecode" },
      { label: "built-in providers", note: "plus any OpenAI-compatible URL" },
      { label: "license", note: "free software, copyleft over network use" },
    ],
  },

  cockpit: {
    eyebrow: "the cockpit",
    title: "Six panels on one screen. The file you care about never scrolls away.",
    lead: "Files with git status, code with the highlight band and ± diff, compact tool rows, plan, usage and the pet. Rendered headlessly through the sextant painters at a fixed clock: the same code path the TUI paints with, not a mockup.",
    transcriptEyebrow: "messages panel · row for row",
    transcriptTitle: "One run, transcribed from the frame above.",
    transcriptBody1:
      "Every tool call is one row: the verb, the file, and what changed. The edit landed as +4 −1. The shell command waits behind one card with three answers; Esc denies, and the answer is cached for the rest of the session.",
    transcriptBody2: "Child agents cannot prompt. A forbidden argv never reaches the card at all.",
  },

  problems: {
    eyebrow: "problems → solutions",
    title: "Four things that go wrong with terminal agents, and what rovecode does about each.",
    lead: "Stated in the words you would use at the keyboard, answered with the mechanism and its limit. Every strip is a real frame crop or the real config file.",
    problemLabel: "problem",
    solutionLabel: "what rovecode does",
    items: [
      {
        problem: "Every agent ships welded to one vendor's API and one pricing page.",
        solution:
          "One StreamFn seam and a live provider registry. 16 named providers, or any OpenAI-compatible or Anthropic endpoint from providers.json; a provider added in another terminal serves the very next call. Role fallback chains advance on a 429 or 5xx.",
      },
      {
        problem: "A chat log scrolls the file you care about off the screen while the agent edits it.",
        solution:
          "A panelled cockpit: files, code, messages, plan, usage and the weather-cloud pet. The messages panel keeps tool calls to one compact row each; the code panel shows the one hunk that landed.",
      },
      {
        problem: "The model asks for rm -rf and the harness runs it because nobody said no in time.",
        solution:
          "Deny-default wildcard rules, then execpolicy verdicts where forbidden never reaches execution or a human, then an approval card on revised args. 4 stacked layers, none of them pretending to be a sandbox.",
      },
      {
        problem: "Turn 40 goes wrong and the only way back is a new conversation.",
        solution:
          "An append-only JSONL session tree with a sha256 hash chain. /rewind opens the turn picker, branches from any turn and prefills the editor with that turn's full text; shadow-git checkpoints restore in 3 modes without touching your .git.",
      },
    ],
  },

  capabilities: {
    eyebrow: "capabilities",
    title: "Ten capabilities, each one a port with a file:line trail.",
    lead: "Rovecode ports evidence-based patterns from pi, opencode, codex, cline, aider, gemini-cli and others. A port lands only after a fresh-context critic verifies it against a bar written before the work began.",
    surfaceLabel: "surface",
    surfaceTitle: "sextant cockpit",
    surfaceBody:
      "6 panels on a truecolor TTY of at least 100×30: files with git status, code with the highlight band and ± diff, compact tool rows, plan, usage, the pet. 3 palettes, /theme switches live; --classic keeps the pi-tui chat.",
    surfaceAlt: "Crop of the sextant frame: files tree and the code panel with the editing highlight band",
    providersLabel: "providers",
    providersTitle: "providers, hot-reloaded",
    providersBody:
      "16 built-ins plus anything you register in providers.json. Every call resolves the provider against the live snapshot: add one in another terminal and the running cockpit uses it on the next call. No restart.",
    mediumLabels: ["context", "safety", "memory"],
    medium: [
      {
        title: "MCP client",
        body: "stdio and HTTP servers from .rovecode/mcp.json. Lazy disclosure through 2 registry tools, so an idle server costs close to zero tokens.",
      },
      {
        title: "Safety ladder",
        body: "Every tool call climbs four rungs before it runs. A forbidden argv is denied before any hook sees it; --yolo skips prompts, never deny rules.",
      },
      {
        title: "Session tree + checkpoints",
        body: "Append-only JSONL with a sha256 hash chain. /rewind branches, /resume picks up, shadow-git checkpoints restore in 3 modes and never touch your .git.",
      },
    ],
    small: [
      { title: "ACP for Zed + JetBrains", body: "Agent Client Protocol v1 over stdio, official SDK." },
      { title: "Headless HTTP + SSE", body: "Sessions, one RunEvent stream, OpenAPI at /doc. Port 4100, loopback-only." },
      { title: "Background subagents", body: "Bounded FIFO child sessions, 3 concurrent by default; notes land on the parent's next turn." },
      { title: "Hooks", body: "9 typed hooks in .rovecode/hooks.ts, each bounded by a 5 s timeout. pre_tool can only deny." },
      { title: "OpenTelemetry", body: "One trace per run: run ⊃ turn ⊃ tool with tokens, latency, cost. Unset endpoint, no exporter." },
    ],
  },

  terminal: {
    eyebrow: "from the terminal",
    title: "Four real frames at 160×44, with the parts worth reading numbered.",
    lead: "Rendered headlessly through the sextant painters at a fixed clock: the same code path the TUI paints with, not a mockup. Hover a row, or tap it, and the frame zooms 2× on that spot.",
    shots: [
      {
        title: "The edit landed. The code panel shows exactly that hunk.",
        lead: "Captured before an approved edit, rebuilt from the edit's own anchors after an ungated one.",
        alt: "sextant frame after an edit: the code panel in diff mode shows one hunk, the messages panel lists read and edit tool rows",
        callouts: [
          "Switch to ± diff mode as the edit lands",
          "Read +4 −1 against the file on disk",
          "Follow the compact tool rows: read, then edit",
          "Watch context fill at 13 % of 200k",
        ],
      },
      {
        title: "A shell command waits for a nod. One card, three answers.",
        lead: "Approvals resolve on revised args and are cached per session; child agents cannot prompt.",
        alt: "sextant frame with the approval card open: bash bun test tests/auth.test.ts, allow always deny",
        callouts: [
          "See the exact argv before it runs",
          "Choose allow, always or deny; Esc denies",
          "Header switches to waiting for you",
          "Pet asks for the nod, then remembers it",
        ],
      },
      {
        title: "Tests ran. The $ panel keeps the output; the header freezes the clock.",
        lead: "PASS and FAIL chips read the exit code from the tool's own header line.",
        alt: "sextant frame after the run finished: the code panel in run mode shows bun test output with 18 pass, plan 4/4 complete",
        callouts: [
          "Read the run output in $ mode, 18 pass",
          "Plan closes at 4/4 steps",
          "Tool row carries the last line of output",
          "Cost lands at $0.071 from the offline catalog",
        ],
      },
      {
        title: "Two background tasks, one lane each, on the crew board.",
        lead: "Child sessions share the one agent loop; quitting the TUI cancels every live child.",
        alt: "sextant frame with the crew board open: two lanes, write tests running and review done",
        callouts: [
          "Open the ∷ agents board with ⌃a",
          "Each lane shows label, elapsed and status",
          "Crew summary stays in the plan panel",
          "Parent run keeps editing meanwhile",
        ],
      },
    ],
  },

  quickstart: {
    eyebrow: "quickstart",
    title: "Three commands from clone to a running agent.",
    lead: "Without a provider configured, one-shot runs use a scripted mock provider, which is also how the packaging smoke works.",
    runLabel: "$ run · exit 0",
    steps: [
      {
        title: "Clone and link (Bun ≥ 1.3.14)",
        body: "The CLI entry is TypeScript executed by bun; node cannot run it. bun link puts rovecode on PATH.",
      },
      {
        title: "Connect a model",
        body: "rovecode setup walks it: pick a provider, paste the key hidden, one tiny test call, done. Or store a key directly with rovecode auth set, or point ROVECODE_BASE_URL at any OpenAI-compatible endpoint.",
      },
      {
        title: "Run a task or open the cockpit",
        body: "Plain rovecode opens the sextant surface. A quoted prompt is a one-shot run; --output json returns exactly one result object.",
      },
    ],
    outputAlt: "Run output: 18 pass, 0 fail, 41 expect() calls, Ran 18 tests across 1 files.",
  },

  providers: {
    eyebrow: "providers",
    title: "16 built-in providers, or any OpenAI-compatible URL.",
    leadA: "Stored credentials beat ",
    leadB: " env vars; an explicit ",
    leadC: " pair beats both.",
    hosted: "hosted apis",
    local: "local runtimes",
    keyNote:
      "● local runtimes need no key · rovecode auth set <name> stores a key in ~/.rovecode/credentials.json, prompted on the terminal and never echoed.",
    liveLabel: "any endpoint · live",
    liveTitle: "Add a provider in another terminal; the running cockpit picks it up on the next call. No restart.",
  },

  faq: {
    eyebrow: "faq",
    title: "Objections, answered with specifics.",
    lead: "Seven questions people ask before they trust an agent with a shell. Each answer names the mechanism and where it stops.",
    aside:
      "Everything here is lifted from README.md sections Safety model, Known limitations, Observability and License & notices. Where the README says a limit exists, so does this page.",
    items: [
      {
        q: "Is it a sandbox?",
        a: "No. Four stacked layers run before and around every tool call: deny-default policy rules, execpolicy verdicts (a forbidden command never reaches execution or a human), the approval gate on revised args, and a runtime bash denylist with a cwd lock. Where bash runs is selectable, direct, WSL2 or Docker, but every rung is delegation, not isolation. Use a container or microVM for untrusted work.",
      },
      {
        q: "Which models can I use?",
        a: "Anything the 16 named providers serve, or any OpenAI-compatible or Anthropic endpoint registered in ~/.rovecode/providers.json (rovecode provider add) or passed as ROVECODE_BASE_URL. Models without native tool calling get XML, Hermes or JSON-in-text parsed into native calls by middleware. Five roles (DEFAULT, SMOL, PLAN, COMMIT, TASK) each take a comma-separated fallback chain.",
      },
      {
        q: "Does it phone home?",
        a: "No. Outbound traffic goes to the provider you configured, the MCP servers you listed, and web_fetch when the model asks for it (prompt by default, SSRF-guarded). OpenTelemetry export exists but is off until ROVECODE_OTEL_ENDPOINT is set, and even then it carries ids, sizes and outcomes, never prompts, args or output. The pricing catalog is an offline snapshot. There is no self-update.",
      },
      {
        q: "Windows only?",
        a: "Windows-first, not Windows-only. Development and the release gate run on Windows 11 with Git Bash. POSIX paths are exercised in tests, but Linux and macOS are not CI-verified yet. Bun ≥ 1.3.14 is the one hard requirement.",
      },
      {
        q: "What happens when I press Esc mid-run?",
        a: "The run's controller aborts: the in-flight provider fetch dies (≤2 ms measured) and the running bash call is killed. On Windows the launcher sits in a kernel Job Object so the whole process tree goes with it; on POSIX the shell gets SIGTERM but a forked grandchild may finish on its own. Cancelled runs still export their trace.",
      },
      {
        q: "Is it on npm?",
        a: "Not yet. Install from source with bun install and bun link, build a single ~110 MB binary with bun run build, or npm pack a tarball and install that globally.",
      },
      {
        q: "What does the license require?",
        a: "AGPL-3.0. Use, study, modify and redistribute; keep the license and copyright notices on every copy and derivative. If you run a modified rovecode as a network service you must offer its complete source to the users of that service. Third-party attributions live in THIRD_PARTY_NOTICES.md; no code comes from crush (FSL), claw-code, nanocoder, iflow or the Claude Agent SDK.",
      },
    ],
  },

  security: {
    eyebrow: "security and deployment",
    title: "Four layers in front of every tool call. Nothing leaves the machine you did not configure.",
    lead: "The safety model as the README states it, limits included. Each layer names what it decides and where it stops; none of them is a sandbox.",
    cols: ["layer", "decides", "limit"],
    layers: [
      { name: "rules", decides: "Deny-default wildcard policy rules over tool and argv. A forbidden pattern is denied before anything runs.", limit: "Pattern matching, not intent: a novel spelling of a dangerous command passes to the next layer." },
      { name: "execpolicy", decides: "Verdicts on the parsed argv: allow, prompt, forbidden. Forbidden never reaches execution or a human.", limit: "Reads the command, not the shell it will run in; an alias or a script body is opaque to it." },
      { name: "approval", decides: "One card on the revised args with allow, always and deny. Answers are cached per session; child agents cannot prompt.", limit: "A human decision: --yolo skips this rung, never the deny rules above it." },
      { name: "runtime", decides: "A bash denylist and a cwd lock at execution; Esc kills the running call and, on Windows, its whole process tree.", limit: "Delegation, not isolation. Untrusted work belongs in a container or microVM." },
    ],
    deployLabel: "deployment and data",
    deploy: [
      { title: "Self-hosted by definition", body: "Runs from source on your machine or your CI; there is no hosted service and no account. Bun ≥ 1.3.14 is the one requirement." },
      { title: "No phone-home", body: "Outbound traffic goes only to the provider you configured, the MCP servers you listed and web_fetch when the model asks. Pricing catalog is an offline snapshot; there is no self-update." },
      { title: "Telemetry is opt-in", body: "OpenTelemetry export is off until ROVECODE_OTEL_ENDPOINT is set; even then it carries ids, sizes and outcomes — never prompts, arguments or output." },
      { title: "Audit trail by construction", body: "Sessions are append-only JSONL with a sha256 hash chain; every run exports one trace (run ⊃ turn ⊃ tool), including cancelled ones." },
      { title: "Platform status", body: "Windows-first: development and the release gate run on Windows 11. POSIX paths are tested, Linux and macOS are not yet CI-verified." },
      { title: "License", body: "AGPL-3.0-only. Modify and redistribute freely; running a modified build as a network service obliges you to offer its source to those users." },
    ],
  },

  cta: {
    eyebrow: "get rovecode",
    title: "Six panels. Sixteen providers. Zero pricing page.",
    button: "Star on GitHub",
    quip: "sun's out.",
    mood: "sunny",
  },

  footer: {
    blurb: "A coding agent for the terminal. TypeScript on Bun, 47 ported patterns, one deny-default policy in front of every tool.",
    legal: "© 2026 9Code Labs · AGPL-3.0-only · v0.2.0 · Bun ≥ 1.3.14",
    notice: "Sources ported are MIT or Apache-2.0 only; attributions in THIRD_PARTY_NOTICES.md.",
    heads: ["Project", "Surfaces", "Configuration", "Safety"],
  },

  pet: {
    /** alt text for the illustrated cloud spots; {mood} is filled in by the component */
    alt: "Rovecode, the cloud mascot",
    edit: "holding a pencil",
    read: "looking through a magnifying glass",
    guard: "holding a shield",
    rewind: "holding a clock with a backwards arrow",
    done: "giving a thumbs up",
  },
};

/** widened on purpose: without `as const` every leaf is `string`, so a locale file can hold any translation
 *  rather than being pinned to the English literal */
export type Dict = typeof en;
/** every locale but English may translate any subset; the rest falls back to `en` */
export type PartialDict = DeepPartial<Dict>;
type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;
