/** Notifications for the interactive TUI: ONE decorator over the Renderer seam rings the terminal (BEL / OSC 9 / OSC 777)
 *  and/or spawns a desktop hook when a run ends or a card needs the user — and ONLY while the terminal is unfocused, because
 *  the whole value is telling someone who looked away; a bell on every turn is a bell nobody hears. Both surfaces, one
 *  place: the renderers themselves no longer ring (their `ring()` moved here on 2026-09-07).
 *
 *  Pattern source: openai/codex (Apache-2.0, pattern level; no code copied) — codex-rs/tui/src/tui.rs (the unfocused | always
 *  gate; terminal_focused starts true; a write error warns once and disables the backend for the session),
 *  codex-rs/tui/src/chatwidget/notifications.rs (the event set: turn complete / approval requested / elicitation),
 *  codex-rs/hooks/src/legacy_notify.rs (the `notify` argv hook: payload appended as the LAST argument, stdin/stdout/stderr
 *  nulled, never awaited; the agent-turn-complete payload shape — the approval / question payloads are rovecode's own).
 *  Deviations: codex disables focus reporting on Windows — Windows Terminal ≥ 1.14 reports focus through VT input, so the
 *  tracker is installed on every TTY; codex fires the hook regardless of focus — here the hook obeys the SAME gate, because a
 *  desktop toast while the person is looking at the terminal is the same noise wearing a different coat.
 *
 *  Knobs (core/settings.ts; env beats file, project beats user, read directly at boot):
 *    bell            (existing) true (default) | false — the on/off switch for terminal notifications
 *    notify          auto (default) | bell | osc9 | osc777 — the method; auto = OSC 9 toast on Ghostty / iTerm2 / kitty /
 *                    Warp / WezTerm, BEL everywhere else. ROVECODE_NOTIFY=off is the env spelling of `bell: false`.
 *    notify_when     unfocused (default) | always                                             ROVECODE_NOTIFY_WHEN
 *    notify_command  argv — a JSON string array or whitespace-split words, NEVER a shell        ROVECODE_NOTIFY_COMMAND
 *
 *  notify_command's permission path (Berkay's 2026-09-04 trust decision applied): from the env or the USER file it is the
 *  person's own configuration; from the PROJECT file it is a repo-supplied command and applies only when that file is
 *  approved in the digest trust store (mcp/trust.ts — the same store as project mcp.json; any edit re-asks), else it is
 *  dropped with one note naming the key. The argv then goes through the same classification bash commands get (port #9:
 *  execpolicy forbidden / dangerous-command → the hook is off, with a note). It is spawned as argv with no shell, every
 *  stdio nulled, never awaited; the run's text reaches it ONLY as one JSON object in argv[last]. Not through the sandbox
 *  rung: the hook is a desktop-side program (notify-send, a toast exe) — under docker/wsl the toast would appear inside the
 *  container. Headless surfaces (`run`, `serve`, `acp`, `--plain`) never construct any of this. */

import { dangerousCommandMatch, defaultExecPolicy } from "../core/execpolicy.ts";
import { loadSettingsScoped, type ScopedSettings, type Settings } from "../core/settings.ts";
import { FocusTerminal } from "./focus-terminal.ts";
import { FOCUS_OFF, FOCUS_ON, FocusTracker, autoMethod, isArgvError, isTmux, message, parseArgv, sequenceFor, type Env, type NotifyDetail, type NotifyKind, type NotifyMethod } from "./notify-seq.ts";
import type { AssistantView, Renderer } from "./renderer.ts";
import { pickRenderer, type RawStdin, type RawStdout } from "./sextant-io.ts";

export type NotifyWhen = "unfocused" | "always";
export const NOTIFY_METHODS = ["auto", "bell", "osc9", "osc777"] as const;
export type NotifyMethodSetting = (typeof NOTIFY_METHODS)[number];
export const NOTIFY_WHENS: readonly NotifyWhen[] = ["unfocused", "always"];

/** everything fire() needs, decided once at boot */
export interface NotifyConfig {
  /** the terminal method; undefined = terminal notifications off (`bell: false` / ROVECODE_NOTIFY=off) */
  method?: NotifyMethod;
  when: NotifyWhen;
  /** the hook argv, validated and classified; undefined = no hook */
  hook?: string[];
  /** where the hook came from, for the notes (`ROVECODE_NOTIFY_COMMAND` or a settings file path) */
  hookSource?: string;
  /** OSC sequences ride a DCS passthrough inside tmux */
  tmux: boolean;
  /** one-shot warn notes: what was dropped and why (shown once the surface is live) */
  notes: string[];
}

export interface ResolveDeps {
  /** default process.env */
  env?: Env;
  /** the two settings files, the project layer already gated (default: core/settings.ts loadSettingsScoped(cwd)) */
  settings?: ScopedSettings;
}

const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase();

/** the knobs → one config. Never throws; every refusal is a note. */
export function resolveNotifyConfig(cwd: string, d: ResolveDeps = {}): NotifyConfig {
  const env = d.env ?? process.env;
  const scoped = d.settings ?? loadSettingsScoped(cwd);
  const merged: Settings = { ...scoped.user, ...scoped.project };
  const notes: string[] = [];

  // the terminal method: ROVECODE_NOTIFY (off | auto | bell | osc9 | osc777) beats the files; `bell: false` is off
  let method: NotifyMethodSetting | undefined;
  const envMethod = norm(env.ROVECODE_NOTIFY);
  if (envMethod === "off") method = undefined;
  else if ((NOTIFY_METHODS as readonly string[]).includes(envMethod)) method = envMethod as NotifyMethodSetting;
  else {
    if (envMethod !== "") notes.push(`notify: unknown value "${envMethod}" in ROVECODE_NOTIFY — off | auto | bell | osc9 | osc777; using the settings files`);
    method = merged.bell === false ? undefined : (merged.notify ?? "auto");
  }
  const resolved: NotifyMethod | undefined = method === "auto" ? autoMethod(env) : method;

  // the gate: ROVECODE_NOTIFY_WHEN beats the files; unfocused unless told otherwise
  let when: NotifyWhen = merged.notify_when ?? "unfocused";
  const envWhen = norm(env.ROVECODE_NOTIFY_WHEN);
  if ((NOTIFY_WHENS as readonly string[]).includes(envWhen)) when = envWhen as NotifyWhen;
  else if (envWhen !== "") notes.push(`notify_when: unknown value "${envWhen}" in ROVECODE_NOTIFY_WHEN — unfocused | always; using ${when}`);

  // the hook: env → the project file (trust-gated) → the user file
  let raw: string | undefined, source: string | undefined;
  const envCmd = env.ROVECODE_NOTIFY_COMMAND;
  if (envCmd !== undefined && envCmd.trim() !== "") { raw = envCmd; source = "ROVECODE_NOTIFY_COMMAND"; }
  else {
    // the project layer arrives GATED (core/settings.ts COMMAND_KEYS): an untrusted file's notify_command is already gone
    // and named in `dropped` — the same store and the same yes as hooks.ts, sandbox.json and mcp.json (`rovecode trust`)
    if (scoped.project.notify_command !== undefined) { raw = scoped.project.notify_command; source = scoped.projectPath; }
    else if (scoped.dropped.includes("notify_command")) notes.push(`notify_command: set by ${scoped.projectPath}, a repository file this machine has not approved — ignored (rovecode trust show · rovecode trust; in the TUI: /trust); set it in ~/.rovecode/settings.json or ROVECODE_NOTIFY_COMMAND to use your own`);
    if (raw === undefined && scoped.user.notify_command !== undefined) { raw = scoped.user.notify_command; source = "~/.rovecode/settings.json"; }
  }
  let hook: string[] | undefined;
  if (raw !== undefined) {
    const argv = parseArgv(raw);
    if (isArgvError(argv)) notes.push(`notify_command (${source}): ${argv.error} — the hook is off`);
    else {
      const danger = dangerousCommandMatch(argv);
      const decision = defaultExecPolicy().check(argv).decision;
      if (danger !== null) notes.push(`notify_command (${source}): "${argv.join(" ")}" is a dangerous command (${danger}) — the hook is off`);
      else if (decision === "forbidden") notes.push(`notify_command (${source}): execpolicy forbids "${argv.join(" ")}" — the hook is off`);
      else hook = argv;
    }
  }
  return { ...(resolved !== undefined ? { method: resolved } : {}), when, ...(hook !== undefined ? { hook, hookSource: source } : {}), tmux: isTmux(env), notes };
}

/** the last completed assistant text kept for the preview / payload */
const PREVIEW_MAX = 400;

/** the JSON handed to `notify_command` as its LAST argument (codex legacy-notify shape for the turn; rovecode's own for the cards) */
export type NotifyPayload =
  | { type: "agent-turn-complete"; cwd: string; "last-assistant-message": string | null }
  | { type: "approval-requested"; cwd: string; tool: string; "args-preview": string }
  | { type: "question-requested"; cwd: string; question: string };

export function payloadFor(kind: NotifyKind, d: NotifyDetail, cwd: string): NotifyPayload {
  if (kind === "approval") return { type: "approval-requested", cwd, tool: d.tool ?? "", "args-preview": d.argsPreview ?? "" };
  if (kind === "question") return { type: "question-requested", cwd, question: d.question ?? "" };
  return { type: "agent-turn-complete", cwd, "last-assistant-message": d.lastText ?? null };
}

/** the Bun.spawn slice the default spawner needs (tests inject a recorder) */
export interface SpawnLike { (argv: string[], opts: { stdio: ["ignore", "ignore", "ignore"] }): { unref(): void } }
const bunSpawn: SpawnLike = (argv, opts) => Bun.spawn(argv, opts);

/** the default hook spawner: argv, no shell, every stdio nulled, `unref()` so a hung hook never pins the event loop at
 *  quit, never awaited */
export function defaultSpawner(spawnFn: SpawnLike = bunSpawn): (argv: string[]) => void {
  return (argv) => { spawnFn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref(); };
}

export interface NotifierDeps {
  config: NotifyConfig;
  /** payload cwd (default process.cwd()) */
  cwd?: string;
  /** terminal sequences go here (default: nowhere — the composition root wires stdout when it is a TTY) */
  write?: (s: string) => void;
  /** the FocusTracker's flag (default: always focused = watched = silent under `unfocused`) */
  focused?: () => boolean;
  /** the hook spawner (default defaultSpawner()) */
  spawn?: (argv: string[]) => void;
  /** the one-shot warn notes (default: dropped) */
  note?: (text: string, tone: "warn") => void;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Notifier {
  readonly config: NotifyConfig;
  private readonly cwd: string;
  private readonly write: (s: string) => void;
  private readonly focused: () => boolean;
  private readonly spawn: (argv: string[]) => void;
  private readonly note: (text: string, tone: "warn") => void;
  private seqOff = false;
  private hookOff = false;
  private notesShown = false;
  private decset = false;

  constructor(d: NotifierDeps) {
    this.config = d.config;
    this.cwd = d.cwd ?? process.cwd();
    this.write = d.write ?? (() => {});
    this.focused = d.focused ?? (() => true);
    this.spawn = d.spawn ?? defaultSpawner();
    this.note = d.note ?? (() => {});
  }

  /** can anything fire — a terminal method or a hook */
  active(): boolean { return this.config.method !== undefined || this.config.hook !== undefined; }

  /** the config's notes, once, the first time the surface can show them */
  private showNotes(): void {
    if (this.notesShown) return;
    this.notesShown = true;
    for (const n of this.config.notes) this.note(n, "warn");
  }

  /** DECSET 1004 — written by withNotifications right after the surface's start writes; true when it was written */
  focusOn(): boolean {
    this.showNotes();
    if (!this.active()) return false;
    this.decset = true;
    this.emit(FOCUS_ON);
    return true;
  }
  /** DECRST 1004 — right before the surface's stop writes; a no-op unless a focusOn() wrote (never an unpaired `?1004l`) */
  focusOff(): void {
    if (!this.decset) return;
    this.decset = false;
    this.emit(FOCUS_OFF);
  }

  /** one trigger → the sequence and/or the hook, ONLY when `when` is always or the terminal is unfocused. Never throws. */
  fire(kind: NotifyKind, d: NotifyDetail): void {
    this.showNotes();
    if (!(this.config.when === "always" || !this.focused())) return; // the person is watching: nothing to tell them
    const { method, hook } = this.config;
    if (method !== undefined) this.emit(sequenceFor(method, message(kind, d), this.config.tmux));
    if (hook !== undefined && !this.hookOff) this.runHook(hook, payloadFor(kind, d, this.cwd));
  }

  private emit(seq: string): void {
    if (this.seqOff) return;
    try { this.write(seq); } catch (e) {
      this.seqOff = true;
      this.note(`notify: the terminal write failed (${reason(e)}) — terminal notifications are off for this session`, "warn");
    }
  }

  private runHook(argv: string[], payload: NotifyPayload): void {
    try { this.spawn([...argv, JSON.stringify(payload)]); } catch (e) {
      this.hookOff = true;
      this.note(`notify_command: could not start ${argv[0]} (${reason(e)}) — the hook is off for this session`, "warn");
    }
  }
}

type Overridden = Pick<Renderer, "start" | "stop" | "askApproval" | "askQuestion" | "setBusy" | "beginAssistant">;

/** The decorator: a Proxy over the inner renderer that adds NO member the inner lacks (`"onEvent" in wrapped` follows the
 *  inner; `instanceof` follows the inner's prototype) and forwards every other member bound to the inner. Overridden: start
 *  (DECSET 1004 after the surface's own start writes, when anything can fire) · stop (DECRST 1004 before its stop writes) ·
 *  askApproval / askQuestion (a trigger each, from ANY caller) · setBusy (run end = a label-less `false` after a `true` —
 *  never a labelled outcome, never a second `false`) · beginAssistant (keeps the last completed text for the preview / payload). */
export function withNotifications<R extends Renderer>(inner: R, n: Notifier): R {
  let busy = false, started = false, decset = false;
  let generation = 0;
  let lastText: string | undefined;
  const over: Overridden = {
    start(hooks, options) {
      const epoch = generation;
      const starting = inner.start(hooks, options);
      const activated = () => { if (epoch === generation && !started) { started = true; decset = n.focusOn(); } };
      if (starting) return starting.then(activated);
      activated();
    },
    stop() {
      generation++; // a prepared renderer resolving after cancellation must not re-enable focus reporting
      if (decset) { decset = false; n.focusOff(); }
      started = false; // after leave nothing rings: a run's finally racing the user's exit has no terminal to reach
      inner.stop();
    },
    askApproval(tool, argsPreview, detail) {
      if (started) n.fire("approval", { tool, argsPreview });
      return inner.askApproval(tool, argsPreview, detail);
    },
    askQuestion(q, signal) {
      if (started) n.fire("question", { question: q.question });
      return inner.askQuestion(q, signal);
    },
    setBusy(b, label) {
      inner.setBusy(b, label);
      if (b) { busy = true; lastText = undefined; return; }
      const ended = busy && label === undefined;
      busy = false;
      if (ended && started) n.fire("run_end", { ...(lastText !== undefined ? { lastText } : {}) }); // a surface that never started has no terminal to hear it
    },
    beginAssistant(): AssistantView {
      const v = inner.beginAssistant();
      let buf = "";
      return {
        append(delta) { v.append(delta); if (buf.length < PREVIEW_MAX) buf = (buf + delta).slice(0, PREVIEW_MAX); },
        done() { v.done(); lastText = buf; },
      };
    },
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === "string" && Object.hasOwn(over, prop)) return over[prop as keyof Overridden];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** main.ts's ONE composition root for the interactive TUI: the surface pickRenderer would have chosen (sextant on a capable
 *  TTY, else the classic PiTuiRenderer with `cwd` — app.ts parity), its raw-input path carrying a FocusTracker on every TTY
 *  (classic: FocusTerminal around ProcessTerminal; sextant: the ProcessIO option), wrapped in withNotifications over a
 *  Notifier that writes to `stdout` only when it is a TTY. */
export function interactiveRenderer(cli: { classic: boolean; pet?: string }, env: Env = process.env, stdout: RawStdout = process.stdout, stdin: RawStdin = process.stdin, cwd: string = process.cwd()): Renderer {
  const tty = stdout.isTTY === true;
  const tracker = tty ? new FocusTracker() : undefined;
  let inner: Renderer | undefined = pickRenderer(cli, env, stdout, { stdin, ...(tracker ? { focus: tracker } : {}) });
  if (!inner) {
    // The classic surface is optional: do not load its editor/markdown graph into a sextant session.
    const { PiTuiRenderer } = require("./pi-renderer.ts") as typeof import("./pi-renderer.ts");
    const { ProcessTerminal } = require("../../vendor/pi-tui/src/terminal.ts") as typeof import("../../vendor/pi-tui/src/terminal.ts");
    inner = new PiTuiRenderer({ cwd, terminal: tracker ? new FocusTerminal(new ProcessTerminal(), tracker) : new ProcessTerminal() });
  }
  // EOF on stdin (the pipe or wrapper that launched us went away). The classic surface listens for
  // "data" only and the vendored terminal never sees an end, so a piped launch that loses its writer
  // hangs forever — measured 60 s+ under a test timeout. The sextant side handles this in ProcessIO
  // (sextant-io.ts, same ETX shape); the classic side cannot be reached through its own seams, so
  // the fallback here is direct: exit the PROCESS, after restoring the terminal through the crash
  // guard's own path. A TUI whose input is gone has nothing left to wait for, and its terminal
  // state is the only thing that must not be lost on the way out. Skipped for a TTY — a TTY does not end.
  if ((stdin as { isTTY?: boolean }).isTTY !== true) {
    stdin.on?.("end", () => { try { process.exit(0); } catch { /* already going */ } });
  }
  const notifier = new Notifier({
    config: resolveNotifyConfig(cwd, { env }), cwd,
    write: tty ? (s) => { stdout.write(s); } : () => {},
    focused: () => tracker?.focused ?? true,
    note: (text, tone) => inner!.addSystemNote(text, tone),
  });
  return withNotifications(inner, notifier);
}
