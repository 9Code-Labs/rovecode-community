/** TUI options/table extraction port, following aion's tui-commands.ts. app.ts re-exports both
 *  names so existing callers, help, palette and custom-command reservations keep the same source.
 *  The declarations below are moved verbatim from this checkout's app.ts, not from aion's table. */
import type { SpawnRunner } from "../core/executor.ts";
import { THINKING_EFFORTS, type PermissionLevel, type StreamFn, type ThinkingEffort } from "../core/types.ts";
import { ATTACH_COMMAND, PASTE_COMMAND } from "./attach.ts";
import { CONNECT_COMMAND, MODEL_COMMAND, PROVIDER_COMMANDS } from "./providers-cmd.ts";
import { MCP_COMMAND } from "./mcp-cmd.ts";
import { TRUST_COMMAND } from "./trust-card.ts";
import { CONTEXT_COMMANDS } from "./context-cmds.ts";
import type { Renderer, SlashCommand } from "./renderer.ts";

export interface TuiAppOptions {
  yolo?: boolean;
  model?: string;
  cwd?: string;
  /** resume an existing session id instead of starting a fresh one. ALREADY RESOLVED by the caller (cli/resume.ts
   *  resolveBoot → the one resolver in core/session-ops.ts): a prefix has become the full id, and an invalid, unknown
   *  or ambiguous one exited 2 before this module loaded — the TUI no longer re-resolves or starts fresh on a miss */
  sessionId?: string;
  /** one line for the startup card when the boot request could not be honoured as a resume
   *  (cli/resume.ts: "nothing to continue from — this is a new session") */
  bootNote?: string;
  /** Owns the loading screen until runtime, sandbox and scene setup are ready. finish() hands it over. */
  startup?: { status(line: string): void; finish(): void; animationDone?: Promise<void>; signal?: AbortSignal };
  /** injected by tests/smoke (VirtualTerminal-backed renderer, mock stream) */
  renderer?: Renderer;
  stream?: StreamFn | null;
  /** default true: process.exit(0) when the user quits */
  exitOnClose?: boolean;
  /** port #27 test seams, threaded into createRuntime: the process runner behind the rung
   *  probe (never a real wsl.exe/docker in tests) and the platform the probe assumes */
  spawnRunner?: SpawnRunner;
  platform?: NodeJS.Platform;
  /** `--add-dir <dir>` values (absolute; cli/run-flags.ts) — extra workspace roots beside the cwd (core/workspace.ts) */
  addDirs?: readonly string[];
  /** port #44: the sextant pet's name (`--pet <name>`); the classic renderer ignores it */
  pet?: string;
  /** start in the middle permission tier (`--accept-edits`, ROVECODE_ACCEPT_EDITS=1) */
  acceptEdits?: boolean;
  /** the permission level as an explicit ASK from an in-process caller — the same rung as a CLI flag, so it
   *  beats ROVECODE_PERMISSION and both settings files. `yolo`/`acceptEdits` can only demand a WIDER
   *  level; `yolo: false` is "no flag", and a user settings file saying "auto" then wins. A smoke whose
   *  assertion is "an approval card appears" needs this to say "ask" and mean it. Leaving it undefined
   *  changes nothing: the env var and the files keep their say. */
  permission?: PermissionLevel;
  /** `--effort <level>`; overrides ROVECODE_EFFORT for this session */
  effort?: ThinkingEffort;
}

/** The built-in slash commands, worded in rovecode's voice (core/voice.ts) and tagged with the /help topic
 *  they are listed under (info-cmd.ts cmdHelp groups by `group`; the palette shows name + description). */
export const TUI_COMMANDS: SlashCommand[] = [
  { name: "help", description: "This list, by topic", group: "start here" },
  CONNECT_COMMAND, // providers-cmd.ts: /connect — bare it is /setup; with an id it takes the answers on the line
  { name: "exit", description: "Quit (alias /quit; Ctrl+C does the same)", group: "start here" },
  { name: "new", description: "Start over in this session (branch back to the beginning)", group: "session" },
  { name: "sessions", description: "Pick an earlier session to continue — or manage them: /sessions rename <title…> | delete <id> | fork [<id>] | search <terms…>", group: "session", choices: ["rename", "delete", "fork", "search"] /* session-manage.ts; inline so the palette table does not load that module at boot */, choicesThen: "complete" },
  { name: "resume", description: "Continue a session by id: /resume <id>", group: "session" },
  { name: "rewind", description: "Go back to an earlier turn and edit it (alias: /tree)", group: "session" },
  { name: "tree", description: "Alias of /rewind", group: "session" },
  { name: "export", description: "Save this session as markdown: /export [--json] [path] [--force]", group: "session" },
  MODEL_COMMAND, // providers-cmd.ts: /model <provider/model | model> [--save]
  ...PROVIDER_COMMANDS, // /models · /provider — providers-cmd.ts (live registry: no restart after add/key/use)
  { name: "yolo", description: "Toggle ask first / auto (never asks)", group: "modes & safety" },
  { name: "accept-edits", description: "Stop asking for writes inside this folder; shell, subagents and writes outside it still ask", group: "modes & safety" },
  { name: "effort", description: "How hard I think before answering: /effort auto | off | low | medium | high — the note says what the current model actually receives", group: "model & provider", choices: THINKING_EFFORTS },
  { name: "plan", description: "Plan mode: I only read and plan, nothing changes", group: "modes & safety" },
  { name: "act", description: "Act mode: I can edit and run again", group: "modes & safety" },
  { name: "checkpoints", description: "Snapshots I took before each change (shadow git)", group: "files & history" },
  { name: "restore", description: "Go back to a snapshot: /restore <ref> [files|conversation|both]", group: "files & history" },
  { name: "commit", description: "Commit the staged changes with a model-drafted conventional message (COMMIT role): /commit [message] — `git commit -m` runs through the bash tool's approval card", group: "files & history" }, // port #65 — git-cmds.ts
  { name: "undo", description: "Undo the agent's last change: restore the previous checkpoint's files (a drifted workspace goes back to the last checkpoint; confirmation card; the conversation is untouched)", group: "files & history" }, // port #65 — git-cmds.ts
  { ...ATTACH_COMMAND, group: "files & history" }, // port #34: /attach <path> · /attach (list) · /attach clear — attach.ts
  { ...PASTE_COMMAND, group: "files & history" },  // /paste: the clipboard image as an attachment (⌃v in sextant) — attach.ts
  TRUST_COMMAND, // trust-card.ts: /trust — the gated project files with what they carry, then a per-file approval card (no default yes)
  { name: "agents", description: "My subagent definitions: /agents list (the bare /agents is the crew board)", group: "start here", choices: ["list"] },
  { name: "config", description: "The settings this session actually loaded: /config [all] — files, set keys, ROVECODE_* env", group: "start here", choices: ["all"] },
  MCP_COMMAND, // mcp-cmd.ts: /mcp [query] — pick a server in the palette, approve the exact plan on the card, it lands in mcp.json
  { name: "status", description: "Provider, model, turns, tokens, sandbox", group: "info" },
  { name: "cost", description: "Tokens, cache hits and the USD estimate (/cost refresh updates prices)", group: "info" },
  { name: "todos", description: "My step list for the current task", group: "info" },
  { name: "tasks", description: "Background subagents: /tasks [cancel <id>|cancel all]", group: "info" },
  { name: "skills", description: "Installed skills", group: "info" },
  { name: "memory", description: "What I remember across turns: /memory · /memory --user · /memory [--user] <text> to add a line", group: "info" },
  ...CONTEXT_COMMANDS, // port #53: /compact [focus] · /clear · /init · /copy [n] — context-cmds.ts
];
