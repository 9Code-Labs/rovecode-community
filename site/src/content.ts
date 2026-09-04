/** Every fact on the page comes from README.md, `bun run src/cli/main.ts --help`, src/cli/help.ts and
 *  src/providers/provider-config.ts (2026-09-02). */

export const REPO = "https://github.com/9Code-Labs/rovecode";
export const README = `${REPO}#readme`;
export const readmeAnchor = (slug: string) => `${REPO}/blob/main/README.md#${slug}`;
export const NOTICES = `${REPO}/blob/main/THIRD_PARTY_NOTICES.md`;
export const LICENSE = `${REPO}/blob/main/LICENSE`;

export const INSTALL = "git clone https://github.com/9Code-Labs/rovecode && cd rovecode && bun install && bun link";
export const USAGE = 'rovecode "fix the failing test"';

export const HERO = {
  title: "A terminal coding agent with a cockpit, not a chat log.",
  sub: "Rovecode runs on Bun, speaks to 16 providers or any OpenAI-compatible endpoint, and passes every tool call through a deny-default policy before it touches your repository. Free software under AGPL-3.0.",
  frame: "/shots/approval-160x44.png",
  frameAlt: "The sextant TUI at 160 by 44 cells: files tree with git statuses, the code panel showing src/auth/callback.ts with the edited lines highlighted, the messages panel with read and edit tool rows and an approval card asking to run bun test, the plan at 1 of 4 steps, usage at 13 percent context, and the rovecode cloud pet asking for a nod.",
  chips: [
    { text: "+4 −1 landed", className: "-bottom-4 left-[20%]" },
    { text: "ask first · approval card", className: "-bottom-4 left-[47%] -translate-x-1/2" },
    { text: "context 13 % of 200k", className: "-bottom-4 right-[5%]" },
  ],
  quip: "need a nod from you.",
  mood: "patient",
  caption: "Real frame: the approval card for bun test, the +4 −1 edit row, context at 13 % of 200k. Rendered through the sextant painters at a fixed clock.",
};

/** The messages panel of HERO.frame (shots/approval-160x44.png), transcribed row for row — the same run
 *  the screenshot shows: atlas · feature/auth, plan 1/4, context 13 %, cost $0.034. */
export const TRANSCRIPT = {
  panel: "messages",
  status: "needs you",
  user: "add a state check to the oauth callback and run the auth tests",
  note: "Let me look at the auth flow first.",
  tools: [
    { glyph: "·", verb: "read", file: "callback.ts", right: "… 16 lines" },
    { glyph: "~", verb: "edit", file: "callback.ts", plus: 4, minus: 1 },
  ] as ReadonlyArray<{ glyph: string; verb: string; file: string; right?: string; plus?: number; minus?: number }>,
  approval: {
    title: "needs your permission",
    argv: "bash bun test tests/auth.test.ts",
    choices: ["allow", "always", "deny"],
    hint: "↵ confirm · ↔ choose · esc deny",
  },
  prompt: "ask rovecode — e.g. fix the failing test",
} as const;

export const STATS = [
  { value: "1,600+", label: "tests", note: "unit + integration, bun test" },
  { value: "47", label: "ported patterns", note: "each traced to file:line in a snapshotted source" },
  { value: "6", label: "panels", note: "files · code · messages · plan · usage · rovecode" },
  { value: "16", label: "built-in providers", note: "plus any OpenAI-compatible URL" },
  { value: "AGPL-3.0", label: "license", note: "free software, copyleft over network use" },
] as const;

/** ~/.rovecode/providers.json — ProvidersFile { default?, providers?: Record<id, ProviderSpec> } */
export const PROVIDERS_JSON = [
  "{",
  '  "default": "kaesra/zai-org/glm-5.3-flash",',
  '  "providers": {',
  '    "kaesra": {',
  '      "baseUrl": "https://api.kaesra.tech/v1",',
  '      "protocol": "openai",',
  '      "keyEnv": "KAESRA_API_KEY"',
  "    },",
  '    "homelab": {',
  '      "baseUrl": "http://10.0.0.7:8000/v1",',
  '      "protocol": "openai",',
  '      "noKey": true,',
  '      "models": ["qwen3-coder-30b"]',
  "    }",
  "  }",
  "}",
];
export const PROVIDERS_JSON_HL = [1];

export type Visual =
  | { kind: "crop"; src: string; alt: string; position?: string }
  | { kind: "code" };

export const PROBLEMS: { n: string; problem: string; solution: string; snippet: string; visual: Visual }[] = [
  {
    n: "01",
    problem: "Every agent ships welded to one vendor's API and one pricing page.",
    solution: "One StreamFn seam and a live provider registry. 16 named providers, or any OpenAI-compatible or Anthropic endpoint from providers.json; a provider added in another terminal serves the very next call. Role fallback chains advance on a 429 or 5xx.",
    snippet: "rovecode provider add homelab http://10.0.0.7:8000/v1 --no-key",
    visual: { kind: "code" },
  },
  {
    n: "02",
    problem: "A chat log scrolls the file you care about off the screen while the agent edits it.",
    solution: "A panelled cockpit: files, code, messages, plan, usage and the weather-cloud pet. The messages panel keeps tool calls to one compact row each; the code panel shows the one hunk that landed.",
    snippet: "files · code · messages · plan · usage · rovecode",
    visual: { kind: "crop", src: "/shots/crops/messages.png", alt: "The messages panel: a user line, the assistant's note, then compact tool rows for read and edit with +5 −2", position: "left top" },
  },
  {
    n: "03",
    problem: "The model asks for rm -rf and the harness runs it because nobody said no in time.",
    solution: "Deny-default wildcard rules, then execpolicy verdicts where forbidden never reaches execution or a human, then an approval card on revised args. 4 stacked layers, none of them pretending to be a sandbox.",
    snippet: "rules → execpolicy → approval → runtime denylist + cwd lock",
    visual: { kind: "crop", src: "/shots/crops/rmrf.png", alt: "The approval card: needs your permission, bash rm -rf node_modules && git checkout -- ., with deny selected", position: "left bottom" },
  },
  {
    n: "04",
    problem: "Turn 40 goes wrong and the only way back is a new conversation.",
    solution: "An append-only JSONL session tree with a sha256 hash chain. /rewind opens the turn picker, branches from any turn and prefills the editor with that turn's full text; shadow-git checkpoints restore in 3 modes without touching your .git.",
    snippet: "/rewind   /checkpoints   /restore   rovecode trace <session-id>",
    visual: { kind: "crop", src: "/shots/crops/rewind.png", alt: "The /rewind picker: rewind to a turn, rows #38 to #41 with #40 selected", position: "left center" },
  },
];

export interface Tile { glyph: string; title: string; body: string; tag: string }
export const BENTO_MEDIUM: Tile[] = [
  { glyph: "∷", title: "MCP client", body: "stdio and HTTP servers from .rovecode/mcp.json. Lazy disclosure through 2 registry tools, so an idle server costs close to zero tokens.", tag: "mcp_list · mcp_call" },
  { glyph: "$", title: "Safety ladder", body: "Every tool call climbs four rungs before it runs. A forbidden argv is denied before any hook sees it; --yolo skips prompts, never deny rules.", tag: "policy → execpolicy → approval → runtime" },
  { glyph: "±", title: "Session tree + checkpoints", body: "Append-only JSONL with a sha256 hash chain. /rewind branches, /resume picks up, shadow-git checkpoints restore in 3 modes and never touch your .git.", tag: "/rewind · /checkpoints · /restore" },
];
export const LADDER = ["rules", "execpolicy", "approval", "runtime"];
export const BENTO_SMALL: Tile[] = [
  { glyph: "~", title: "ACP for Zed + JetBrains", body: "Agent Client Protocol v1 over stdio, official SDK.", tag: "rovecode acp" },
  { glyph: "$", title: "Headless HTTP + SSE", body: "Sessions, one RunEvent stream, OpenAPI at /doc. Port 4100, loopback-only.", tag: "rovecode serve" },
  { glyph: "∷", title: "Background subagents", body: "Bounded FIFO child sessions, 3 concurrent by default; notes land on the parent's next turn.", tag: "/tasks" },
  { glyph: "~", title: "Hooks", body: "9 typed hooks in .rovecode/hooks.ts, each bounded by a 5 s timeout. pre_tool can only deny.", tag: "pre_tool · approval · on_event" },
  { glyph: "·", title: "OpenTelemetry", body: "One trace per run: run ⊃ turn ⊃ tool with tokens, latency, cost. Unset endpoint, no exporter.", tag: "ROVECODE_OTEL_ENDPOINT" },
];

export interface Callout { n: number; x: number; y: number; short: string; text: string }
export interface Shot { file: string; alt: string; title: string; lead: string; callouts: Callout[] }

/** x/y are cell coordinates on the 160×44 frame, converted to percentages by the component */
export const SHOTS: Shot[] = [
  {
    file: "/shots/diff-160x44.png",
    alt: "sextant frame after an edit: the code panel in diff mode shows one hunk, the messages panel lists read and edit tool rows",
    title: "The edit landed. The code panel shows exactly that hunk.",
    lead: "Captured before an approved edit, rebuilt from the edit's own anchors after an ungated one.",
    callouts: [
      { n: 1, x: 36, y: 1, short: "± diff", text: "Switch to ± diff mode as the edit lands" },
      { n: 2, x: 75, y: 6, short: "+4 −1", text: "Read +4 −1 against the file on disk" },
      { n: 3, x: 88, y: 37, short: "tool rows", text: "Follow the compact tool rows: read, then edit" },
      { n: 4, x: 132, y: 40, short: "13 %", text: "Watch context fill at 13 % of 200k" },
    ],
  },
  {
    file: "/shots/approval-160x44.png",
    alt: "sextant frame with the approval card open: bash bun test tests/auth.test.ts, allow always deny",
    title: "A shell command waits for a nod. One card, three answers.",
    lead: "Approvals resolve on revised args and are cached per session; child agents cannot prompt.",
    callouts: [
      { n: 1, x: 100, y: 38, short: "exact argv", text: "See the exact argv before it runs" },
      { n: 2, x: 48, y: 39, short: "allow · always · deny", text: "Choose allow, always or deny; Esc denies" },
      { n: 3, x: 140, y: 0, short: "waiting", text: "Header switches to waiting for you" },
      { n: 4, x: 14, y: 40, short: "pet asks", text: "Pet asks for the nod, then remembers it" },
    ],
  },
  {
    file: "/shots/tests-160x44.png",
    alt: "sextant frame after the run finished: the code panel in run mode shows bun test output with 18 pass, plan 4/4 complete",
    title: "Tests ran. The $ panel keeps the output; the header freezes the clock.",
    lead: "PASS and FAIL chips read the exit code from the tool's own header line.",
    callouts: [
      { n: 1, x: 36, y: 1, short: "$ run", text: "Read the run output in $ mode, 18 pass" },
      { n: 2, x: 130, y: 1, short: "4/4", text: "Plan closes at 4/4 steps" },
      { n: 3, x: 90, y: 37, short: "last line", text: "Tool row carries the last line of output" },
      { n: 4, x: 132, y: 42, short: "$0.071", text: "Cost lands at $0.071 from the offline catalog" },
    ],
  },
  {
    file: "/shots/agents-160x44.png",
    alt: "sextant frame with the crew board open: two lanes, write tests running and review done",
    title: "Two background tasks, one lane each, on the crew board.",
    lead: "Child sessions share the one agent loop; quitting the TUI cancels every live child.",
    callouts: [
      { n: 1, x: 36, y: 1, short: "∷ agents", text: "Open the ∷ agents board with ⌃a" },
      { n: 2, x: 52, y: 3, short: "lane", text: "Each lane shows label, elapsed and status" },
      { n: 3, x: 130, y: 30, short: "crew", text: "Crew summary stays in the plan panel" },
      { n: 4, x: 88, y: 37, short: "still editing", text: "Parent run keeps editing meanwhile" },
    ],
  },
];

export const STEPS = [
  {
    n: "01",
    title: "Clone and link (Bun ≥ 1.3.14)",
    body: "The CLI entry is TypeScript executed by bun; node cannot run it. bun link puts rovecode on PATH.",
    cmd: INSTALL,
  },
  {
    n: "02",
    title: "Connect a model",
    body: "rovecode setup walks it: pick a provider, paste the key hidden, one tiny test call, done. Or store a key directly with rovecode auth set, or point ROVECODE_BASE_URL at any OpenAI-compatible endpoint.",
    cmd: "rovecode setup",
    alt: "rovecode auth set anthropic",
  },
  {
    n: "03",
    title: "Run a task or open the cockpit",
    body: "Plain rovecode opens the sextant surface. A quoted prompt is a one-shot run; --output json returns exactly one result object.",
    cmd: USAGE,
    output: { src: "/shots/crops/tests.png", alt: "Run output: 18 pass, 0 fail, 41 expect() calls, Ran 18 tests across 1 files." },
  },
] as const;

export const PROVIDERS_HOSTED = ["kaesra", "openai", "anthropic", "deepseek", "groq", "openrouter", "together", "mistral", "cerebras", "fireworks", "perplexity", "xai", "moondream"] as const;
export const PROVIDERS_LOCAL = ["ollama", "lmstudio", "vllm"] as const;

export const FAQ = [
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
] as const;

export const FOOTER = [
  {
    head: "Project",
    links: [
      { label: "GitHub", href: REPO },
      { label: "README", href: README },
      { label: "THIRD_PARTY_NOTICES", href: NOTICES },
      { label: "LICENSE (AGPL-3.0)", href: LICENSE },
    ],
  },
  {
    head: "Surfaces",
    links: [
      { label: "rovecode (sextant TUI)", href: readmeAnchor("quickstart") },
      { label: "rovecode --classic", href: readmeAnchor("quickstart") },
      { label: "rovecode acp", href: readmeAnchor("quickstart") },
      { label: "rovecode serve", href: readmeAnchor("quickstart") },
      { label: "rovecode run --output json", href: readmeAnchor("features-beyond-the-20-ports-wave-3-verified-per-port-in-portsmd") },
    ],
  },
  {
    head: "Configuration",
    links: [
      { label: "rovecode setup", href: readmeAnchor("quickstart") },
      { label: "rovecode provider add", href: readmeAnchor("quickstart") },
      { label: "~/.rovecode/providers.json", href: readmeAnchor("configuration") },
      { label: ".rovecode/mcp.json", href: readmeAnchor("configuration") },
      { label: ".rovecode/hooks.ts", href: readmeAnchor("extending") },
      { label: ".rovecode/commands/*.md", href: readmeAnchor("configuration") },
    ],
  },
  {
    head: "Safety",
    links: [
      { label: "Safety model", href: readmeAnchor("safety-model-stacked-honest") },
      { label: "Known limitations", href: readmeAnchor("known-limitations") },
      { label: "Observability", href: readmeAnchor("observability") },
      { label: "Architecture", href: readmeAnchor("architecture") },
    ],
  },
] as const;
