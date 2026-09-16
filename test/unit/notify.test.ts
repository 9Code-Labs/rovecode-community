/** tui/notify.ts (aion port #79, 2026-09-07): resolveNotifyConfig (the knobs on injected env + settings maps: the `bell`
 *  switch, env over file, project over user, `auto` per terminal, the unknown-value notes; notify_command's source gate —
 *  env / user file always, project file only when trusted — and its execpolicy classification), the Notifier (the focus
 *  gate for BOTH the sequence and the hook, the one-shot disable rules, the payload as argv[last], the default spawner's
 *  shape) and withNotifications — a Proxy that adds no member (`in` / instanceof pins over a real PiTuiRenderer and a
 *  real SextantRenderer), the setBusy transition table, the DECSET 1004 writes around the sextant's start / stop writes
 *  (fixed clock → byte-exact), the off byte identity, and interactiveRenderer's surface choice. No process stdio is
 *  touched: every write goes to an injected sink. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../../src/core/settings.ts";
import { enterSequence, leaveSequence } from "../../src/sextant/input.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import { Notifier, defaultSpawner, interactiveRenderer, payloadFor, resolveNotifyConfig, withNotifications, type NotifyConfig, type NotifyPayload } from "../../src/tui/notify.ts";
import { FocusTracker, type NotifyDetail, type NotifyKind } from "../../src/tui/notify-seq.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import type { ApprovalAnswer, AssistantView, QuestionPrompt, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";
import { MemoryIO, type RawStdin, type RawStdout } from "../../src/tui/sextant-io.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";

const NOOP_HOOKS: RendererHooks = { onSubmit() {}, onInterrupt() {}, onExit() {} };
const PROJECT = "C:/repo/.rovecode/settings.json";

/** the config for an env + the two settings files (default: nothing set anywhere, the project file untrusted). The gate
 *  itself lives in core/settings.ts loadSettingsScoped (test/unit/project-trust.test.ts); here its OUTPUT is modelled:
 *  an untrusted project file arrives with notify_command removed and named in `dropped`. */
function cfg(env: Record<string, string>, files: { user?: Settings; project?: Settings } = {}, trusted = false): NotifyConfig {
  const raw = files.project ?? {};
  const gated = trusted || raw.notify_command === undefined;
  const { notify_command: _dropped, ...rest } = raw;
  const project: Settings = gated ? raw : rest;
  return resolveNotifyConfig("C:/repo", { env, settings: { user: files.user ?? {}, project, projectPath: PROJECT, dropped: gated ? [] : ["notify_command"] } });
}

interface Rig { n: Notifier; writes: string[]; spawns: string[][]; notes: string[]; focus: { focused: boolean } }
function rig(config: NotifyConfig, o: { write?: (s: string) => void; spawn?: (argv: string[]) => void; cwd?: string } = {}): Rig {
  const writes: string[] = [], spawns: string[][] = [], notes: string[] = [];
  const focus = { focused: true };
  const n = new Notifier({
    config, cwd: o.cwd ?? "C:/repo",
    write: o.write ?? ((s) => { writes.push(s); }),
    spawn: o.spawn ?? ((a) => { spawns.push(a); }),
    note: (t, tone) => { notes.push(`${tone}: ${t}`); },
    focused: () => focus.focused,
  });
  return { n, writes, spawns, notes, focus };
}
const ALL: [NotifyKind, NotifyDetail][] = [["approval", { tool: "bash", argsPreview: "{}" }], ["question", { question: "which?" }], ["run_end", { lastText: "done" }]];
const fireAll = (r: Rig): void => { for (const [k, d] of ALL) r.n.fire(k, d); };

describe("resolveNotifyConfig", () => {
  test("nothing set: the bell, unfocused, no hook, no notes — the default the README teaches", () => {
    expect(cfg({})).toEqual({ method: "bell", when: "unfocused", tmux: false, notes: [] });
    expect(cfg({ TERM_PROGRAM: "WezTerm" }).method).toBe("osc9");     // auto per terminal
    expect(cfg({ WT_SESSION: "x" }).method).toBe("bell");
    expect(cfg({ TMUX: "/tmp/tmux-1/default,1,0" }).tmux).toBe(true);
  });

  test("`bell: false` / ROVECODE_NOTIFY=off turn the terminal method off; the method and the gate: env beats file, project beats user; unknown values → a note and the next layer", () => {
    expect(cfg({}, { user: { bell: false } }).method).toBeUndefined();
    expect(cfg({}, { project: { bell: false }, user: { notify: "osc9" } }).method).toBeUndefined();
    expect(cfg({ ROVECODE_NOTIFY: "off" }, { user: { notify: "osc9" } }).method).toBeUndefined();
    expect(cfg({ ROVECODE_NOTIFY: "OFF " }).method).toBeUndefined();
    expect(cfg({ ROVECODE_NOTIFY: "bell" }, { user: { bell: false } }).method).toBe("bell"); // the env is this shell's word: it beats the file's off
    expect(cfg({}, { user: { notify: "osc777" }, project: { notify: "osc9" } }).method).toBe("osc9");
    expect(cfg({ ROVECODE_NOTIFY: "osc777" }, { project: { notify: "osc9" } }).method).toBe("osc777");
    expect(cfg({ ROVECODE_NOTIFY: "auto", TERM_PROGRAM: "ghostty" }, { project: { notify: "bell" } }).method).toBe("osc9");
    expect(cfg({}, { user: { notify_when: "always" } }).when).toBe("always");
    expect(cfg({}, { user: { notify_when: "always" }, project: { notify_when: "unfocused" } }).when).toBe("unfocused");
    expect(cfg({ ROVECODE_NOTIFY_WHEN: "Always" }, { project: { notify_when: "unfocused" } }).when).toBe("always");
    const bad = cfg({ ROVECODE_NOTIFY: "toast", ROVECODE_NOTIFY_WHEN: "sometimes" }, { user: { notify: "osc777", notify_when: "always" } });
    expect(bad.method).toBe("osc777");                                 // the file's word stands
    expect(bad.when).toBe("always");
    expect(bad.notes).toEqual([
      'notify: unknown value "toast" in ROVECODE_NOTIFY — off | auto | bell | osc9 | osc777; using the settings files',
      'notify_when: unknown value "sometimes" in ROVECODE_NOTIFY_WHEN — unfocused | always; using always',
    ]);
  });

  test("notify_command: the env and the USER file are the person's own; the PROJECT file is a repo-supplied command and applies only when trusted (else one note naming the key and the path, and the user file still applies)", () => {
    const env = cfg({ ROVECODE_NOTIFY_COMMAND: '["notify-send","rovecode"]' }, { project: { notify_command: "evil" }, user: { notify_command: "mine" } }, true);
    expect(env.hook).toEqual(["notify-send", "rovecode"]);
    expect(env.hookSource).toBe("ROVECODE_NOTIFY_COMMAND");
    const user = cfg({}, { user: { notify_command: "  C:\\tools\\toast.exe  --title rovecode " } });
    expect(user.hook).toEqual(["C:\\tools\\toast.exe", "--title", "rovecode"]);
    expect(user.hookSource).toBe("~/.rovecode/settings.json");
    expect(user.notes).toEqual([]);
    const untrusted = cfg({}, { project: { notify_command: "repo-hook --x" }, user: { notify_command: "mine" } }, false);
    expect(untrusted.hook).toEqual(["mine"]);                          // MUTATION: the project file's command runs unapproved
    expect(untrusted.hookSource).toBe("~/.rovecode/settings.json");
    expect(untrusted.notes).toEqual([`notify_command: set by ${PROJECT}, a repository file this machine has not approved — ignored (rovecode trust show · rovecode trust; in the TUI: /trust); set it in ~/.rovecode/settings.json or ROVECODE_NOTIFY_COMMAND to use your own`]);
    const onlyProject = cfg({}, { project: { notify_command: "repo-hook --x" } }, false);
    expect(onlyProject.hook).toBeUndefined();
    expect(onlyProject.notes.length).toBe(1);
    const trusted = cfg({}, { project: { notify_command: "repo-hook --x" }, user: { notify_command: "mine" } }, true);
    expect(trusted.hook).toEqual(["repo-hook", "--x"]);                // approved: the project file wins as every other key does
    expect(trusted.hookSource).toBe(PROJECT);
    expect(trusted.notes).toEqual([]);
    expect(cfg({ ROVECODE_NOTIFY_COMMAND: "   " }, { user: { notify_command: "mine" } }).hook).toEqual(["mine"]); // a blank env value is "unset"
  });

  test("notify_command: an invalid argv, a dangerous command or one execpolicy forbids → no hook + one note naming the source; the terminal method is unaffected", () => {
    for (const [bad, why] of [["[not json", "not a JSON array"], ["[1,2]", "non-empty strings"], ["[]", "non-empty strings"], ['[""]', "non-empty strings"]] as const) {
      const c = cfg({ ROVECODE_NOTIFY_COMMAND: bad });
      expect([bad, c.hook, c.method]).toEqual([bad, undefined, "bell"]);
      expect(c.notes.length).toBe(1);
      expect(c.notes[0]).toMatch(new RegExp(`^notify_command \\(ROVECODE_NOTIFY_COMMAND\\): .*${why}.* — the hook is off$`));
    }
    const rm = cfg({}, { user: { notify_command: '["rm","-rf","/"]' } });
    expect(rm.hook).toBeUndefined();                                   // MUTATION: the classification skipped
    expect(rm.notes).toEqual(['notify_command (~/.rovecode/settings.json): "rm -rf /" is a dangerous command (forced-rm) — the hook is off']);
    const push = cfg({ ROVECODE_NOTIFY_COMMAND: "git push --force origin main" });
    expect(push.hook).toBeUndefined();
    expect(push.notes).toEqual(['notify_command (ROVECODE_NOTIFY_COMMAND): execpolicy forbids "git push --force origin main" — the hook is off']);
    expect(cfg({ ROVECODE_NOTIFY_COMMAND: "notify-send rovecode" }).hook).toEqual(["notify-send", "rovecode"]); // an unknown program is a `prompt` at most: the person configured it
  });
});

describe("Notifier", () => {
  test("off (`bell: false`, no hook) → zero writes, zero spawns, zero notes for every trigger, focused or not; focusOn() writes nothing", () => {
    for (const c of [cfg({}, { user: { bell: false } }), cfg({ ROVECODE_NOTIFY: "off" }), cfg({ ROVECODE_NOTIFY: "off", ROVECODE_NOTIFY_WHEN: "always" })]) {
      const r = rig(c);
      for (const focused of [true, false]) { r.focus.focused = focused; fireAll(r); }
      expect(r.n.focusOn()).toBe(false);
      r.n.focusOff();
      expect([r.writes, r.spawns, r.notes]).toEqual([[], [], []]);
    }
  });

  test("the unfocused gate (the default): focused → nothing; unfocused → exactly ONE sequence per trigger; DECSET on/off written once something can fire", () => {
    const r = rig(cfg({}));
    fireAll(r);
    expect(r.writes).toEqual([]); // MUTATION: gate inverted / focused initialised false
    r.focus.focused = false;
    fireAll(r);
    expect(r.writes).toEqual(["\x07", "\x07", "\x07"]);
    expect(r.spawns).toEqual([]);
    expect(r.n.focusOn()).toBe(true);
    r.n.focusOff();
    expect(r.writes.slice(3)).toEqual(["\x1b[?1004h", "\x1b[?1004l"]);
    r.n.focusOff();
    expect(r.writes.length).toBe(5); // never an unpaired ?1004l
  });

  test("always: one sequence while focused too; osc9 / osc777 on the wire; tmux wraps; the message is scrubbed", () => {
    const r = rig(cfg({ ROVECODE_NOTIFY: "osc9", ROVECODE_NOTIFY_WHEN: "always" }));
    r.n.fire("run_end", { lastText: "all done" });
    expect(r.writes).toEqual(["\x1b]9;run finished: all done\x07"]);
    const o777 = rig(cfg({}, { user: { notify: "osc777", notify_when: "always" } }));
    o777.n.fire("question", { question: "which file?" });
    expect(o777.writes).toEqual(["\x1b]777;notify;rovecode;question: which file?\x07"]);
    const tmux = rig(cfg({ ROVECODE_NOTIFY: "osc9", ROVECODE_NOTIFY_WHEN: "always", TMUX: "/tmp/tmux-1/default,1,0" }));
    tmux.n.fire("run_end", {});
    expect(tmux.writes).toEqual(["\x1bPtmux;\x1b\x1b]9;run finished\x07\x1b\\"]);
    const inj = rig(cfg({ ROVECODE_NOTIFY: "osc9", ROVECODE_NOTIFY_WHEN: "always" }));
    inj.n.fire("run_end", { lastText: "ok\x07\x1b]9;x\x07 fine" });
    expect(inj.writes).toEqual(["\x1b]9;run finished: ok]9;x fine\x07"]);
    expect(inj.writes[0]!.slice(4, -1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/); // MUTATION: scrub removed — the payload would carry BEL/ESC
    const wez = rig(cfg({ ROVECODE_NOTIFY_WHEN: "always", TERM_PROGRAM: "WezTerm" }));
    wez.n.fire("approval", { tool: "bash", argsPreview: '{"command":"ls"}' });
    expect(wez.writes).toEqual(['\x1b]9;approval needed: bash {"command":"ls"}\x07']);
  });

  test("the config's notes are shown ONCE, at the first focusOn()/fire(); a write throw → ONE warn note, sequences off for the session, the hook still fires", () => {
    const bad = rig(cfg({ ROVECODE_NOTIFY: "toast", ROVECODE_NOTIFY_WHEN: "always" }));
    bad.n.fire("run_end", {}); bad.n.fire("run_end", {});
    expect(bad.writes).toEqual(["\x07", "\x07"]);            // the files' default stood
    expect(bad.notes).toEqual([expect.stringMatching(/^warn: notify: unknown value "toast"/)]);
    let calls = 0;
    const boom = rig(cfg({ ROVECODE_NOTIFY_WHEN: "always", ROVECODE_NOTIFY_COMMAND: "hook" }), { write: () => { calls++; throw new Error("EPIPE"); } });
    boom.n.fire("run_end", {}); boom.n.fire("approval", { tool: "x", argsPreview: "" }); boom.n.fire("question", { question: "q" });
    expect(calls).toBe(1);
    expect(boom.notes).toEqual(["warn: notify: the terminal write failed (EPIPE) — terminal notifications are off for this session"]);
    expect(boom.spawns.length).toBe(3);
    expect(boom.n.focusOn()).toBe(true);
    boom.n.focusOff();
    expect(calls).toBe(1); // the disabled writer stays silent, no second note
    expect(boom.notes.length).toBe(1);
  });

  test("notify_command obeys the SAME gate as the sequence: focused → no spawn; unfocused or always → one spawn per trigger; payload = argv[last] in the three shapes; a hook with the terminal method off still fires", () => {
    const r = rig(cfg({ ROVECODE_NOTIFY_COMMAND: '["notify-send","rovecode"]' }), { cwd: "D:/work/repo" });
    fireAll(r);
    expect(r.spawns).toEqual([]);                            // MUTATION: the hook fires regardless of focus (codex's rule, not ours)
    r.focus.focused = false;
    r.n.fire("run_end", { lastText: "all done" });
    r.n.fire("approval", { tool: "bash", argsPreview: '{"command":"ls"}' });
    r.n.fire("question", { question: "which?" });
    r.n.fire("run_end", {});
    expect(r.writes).toEqual(["\x07", "\x07", "\x07", "\x07"]);
    expect(r.spawns.map((a) => a.slice(0, 2))).toEqual([["notify-send", "rovecode"], ["notify-send", "rovecode"], ["notify-send", "rovecode"], ["notify-send", "rovecode"]]);
    expect(r.spawns.every((a) => a.length === 3)).toBe(true);
    expect(JSON.parse(r.spawns.map((a) => a.at(-1)!).join(",").replace(/^/, "[").replace(/$/, "]")) as NotifyPayload[]).toEqual([
      { type: "agent-turn-complete", cwd: "D:/work/repo", "last-assistant-message": "all done" },
      { type: "approval-requested", cwd: "D:/work/repo", tool: "bash", "args-preview": '{"command":"ls"}' },
      { type: "question-requested", cwd: "D:/work/repo", question: "which?" },
      { type: "agent-turn-complete", cwd: "D:/work/repo", "last-assistant-message": null },
    ]);
    const quietHook = rig(cfg({ ROVECODE_NOTIFY: "off", ROVECODE_NOTIFY_WHEN: "always", ROVECODE_NOTIFY_COMMAND: "hook" }));
    quietHook.n.fire("run_end", {});
    expect([quietHook.writes, quietHook.spawns.length]).toEqual([[], 1]);
    expect(quietHook.n.focusOn()).toBe(true);                // the hook alone is reason to ask the terminal about focus
    expect(payloadFor("run_end", {}, "x")).toEqual({ type: "agent-turn-complete", cwd: "x", "last-assistant-message": null });
  });

  test("a spawn throw → ONE warn note and the hook is off for the session; sequences unaffected", () => {
    let tries = 0;
    const r = rig(cfg({ ROVECODE_NOTIFY_WHEN: "always", ROVECODE_NOTIFY_COMMAND: "nope-not-a-program" }), { spawn: () => { tries++; throw new Error("ENOENT"); } });
    r.n.fire("run_end", {}); r.n.fire("approval", { tool: "x", argsPreview: "" });
    expect(tries).toBe(1);
    expect(r.notes).toEqual(["warn: notify_command: could not start nope-not-a-program (ENOENT) — the hook is off for this session"]);
    expect(r.writes).toEqual(["\x07", "\x07"]);
  });

  test("defaultSpawner: argv, no shell, stdio all ignored, unref() called, nothing awaited or returned", () => {
    const calls: { argv: string[]; opts: unknown }[] = [];
    let unrefs = 0;
    const spawn = defaultSpawner((argv, opts) => { calls.push({ argv, opts }); return { unref() { unrefs++; } }; });
    const r = spawn(["x", "payload"]);
    expect(r).toBeUndefined();
    expect(calls).toEqual([{ argv: ["x", "payload"], opts: { stdio: ["ignore", "ignore", "ignore"] } }]); // MUTATION: stdio inherited → a hook's output lands in the TUI
    expect(unrefs).toBe(1);
  });
});

// ---------- withNotifications ----------

class FakeRenderer implements Renderer {
  calls: string[] = [];
  start(_h: RendererHooks): void { this.calls.push("start"); }
  stop(): void { this.calls.push("stop"); }
  setCommands(): void {}
  addUser(): void {}
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.calls.push(`note(${tone}): ${text}`); }
  beginAssistant(): AssistantView { let b = ""; const c = this.calls; return { append(d: string) { b += d; }, done() { c.push(`assistant: ${b}`); } }; }
  toolStart(): void {}
  toolUpdate(): void {}
  toolEnd(): void {}
  async askApproval(tool: string, preview: string, detail?: string): Promise<ApprovalAnswer> { this.calls.push(`approval: ${tool} ${preview} ${detail ?? "-"}`); return "once"; }
  async askQuestion(q: QuestionPrompt, signal?: AbortSignal): Promise<null> { this.calls.push(`question: ${q.question} ${signal ? "sig" : "-"}`); return null; }
  async pickOne(): Promise<null> { return null; }
  clearTranscript(): void {}
  prefillEditor(): void {}
  setBusy(b: boolean, label?: string): void { this.calls.push(`busy: ${b} ${label ?? "-"}`); }
  setStatus(_i: StatusInfo): void {}
  /** a member only THIS class has — the Proxy must expose it bound to the target */
  extra(): string { return `extra:${this.calls.length}`; }
}
const ALWAYS = cfg({ ROVECODE_NOTIFY_WHEN: "always" });

describe("withNotifications", () => {
  test("setBusy transition table: a label-less false after a true fires ONCE; a labelled false never; a second false never; two runs → two; nothing before start()", () => {
    const r = rig(ALWAYS);
    const inner = new FakeRenderer();
    const w = withNotifications(inner, r.n);
    w.setBusy(true); w.setBusy(false);                  // before start(): no terminal to hear it
    expect(r.writes).toEqual([]);
    w.start(NOOP_HOOKS);
    r.writes.length = 0;                                // drop the DECSET
    w.setBusy(false);                                   // false without a prior true: nothing
    expect(r.writes).toEqual([]);
    w.setBusy(true, "thinking…"); w.setBusy(false);    // the run: one ring
    expect(r.writes).toEqual(["\x07"]);
    w.setBusy(false);                                   // MUTATION: a second false rings again
    expect(r.writes).toEqual(["\x07"]);
    w.setBusy(true, "running ls…"); w.setBusy(false, "done");   // a labelled outcome is a status, not a run's end
    w.setBusy(true, "committing…"); w.setBusy(false, "error");
    expect(r.writes).toEqual(["\x07"]);                 // MUTATION: ring on every false
    w.setBusy(true); w.setBusy(false);                  // an interrupted run ends the same way: rings
    expect(r.writes).toEqual(["\x07", "\x07"]);
    expect(inner.calls.filter((c) => c.startsWith("busy:"))).toEqual(["busy: true -", "busy: false -", "busy: false -", "busy: true thinking…", "busy: false -", "busy: false -", "busy: true running ls…", "busy: false done", "busy: true committing…", "busy: false error", "busy: true -", "busy: false -"]); // every call forwarded verbatim
  });

  test("run end carries the last COMPLETED assistant text of this run (≤ 400 kept, ≤ 120 shown); a run with no text → `run finished`; approval / question forward every argument and fire once each; the config's notes land on the inner as warn notes at start", async () => {
    const r = rig(cfg({ ROVECODE_NOTIFY: "osc9", ROVECODE_NOTIFY_WHEN: "always", ROVECODE_NOTIFY_COMMAND: "hook", TERM_PROGRAM: "x" }), { cwd: "C:/w" });
    const inner = new FakeRenderer();
    const noted = withNotifications(inner, new Notifier({ config: cfg({ ROVECODE_NOTIFY: "toast" }), note: (t, tone) => inner.addSystemNote(t, tone) }));
    noted.start(NOOP_HOOKS);
    expect(inner.calls).toEqual(["start", expect.stringMatching(/^note\(warn\): notify: unknown value "toast"/)]);
    inner.calls.length = 0;
    const w = withNotifications(inner, r.n);
    w.start(NOOP_HOOKS);
    w.setBusy(true, "thinking…");
    const v = w.beginAssistant(); v.append("Hello "); v.append("world"); v.done();
    const v2 = w.beginAssistant(); v2.append("second\nanswer\x07"); v2.done();
    w.setBusy(false);
    expect(r.writes.slice(1)).toEqual(["\x1b]9;run finished: second answer\x07"]);
    expect(JSON.parse(r.spawns[0]!.at(-1)!)).toEqual({ type: "agent-turn-complete", cwd: "C:/w", "last-assistant-message": "second\nanswer\x07" });
    expect(inner.calls).toContain("assistant: Hello world");
    expect(inner.calls).toContain("assistant: second\nanswer\x07");
    w.setBusy(true, "thinking…");
    const v3 = w.beginAssistant(); v3.append("x".repeat(1000)); v3.done();
    w.setBusy(false);
    expect(r.writes[2]).toBe(`\x1b]9;run finished: ${"x".repeat(119)}…\x07`);
    expect((JSON.parse(r.spawns[1]!.at(-1)!) as { "last-assistant-message": string })["last-assistant-message"].length).toBe(400);
    w.setBusy(true, "thinking…"); w.setBusy(false);     // a run with no assistant text: the previous run's text is NOT reused
    expect(r.writes[3]).toBe("\x1b]9;run finished\x07");
    expect(await w.askApproval("edit", '{"path":"a.ts"}', "diff…")).toBe("once");
    expect(await w.askQuestion({ question: "Which db?", options: ["a"] }, new AbortController().signal)).toBeNull();
    expect(r.writes.slice(4)).toEqual(['\x1b]9;approval needed: edit {"path":"a.ts"}\x07', "\x1b]9;question: Which db?\x07"]);
    expect(inner.calls.slice(-2)).toEqual(['approval: edit {"path":"a.ts"} diff…', "question: Which db? sig"]);
    expect(r.spawns.map((a) => (JSON.parse(a.at(-1)!) as { type: string }).type)).toEqual(["agent-turn-complete", "agent-turn-complete", "agent-turn-complete", "approval-requested", "question-requested"]);
  });

  test("the Proxy adds no member: `onEvent`/`attach`/`drain` absent on a wrapped PiTuiRenderer, present + bound on a wrapped SextantRenderer (instanceof, getter, methods with `this`); extra members forward", async () => {
    const n = rig(cfg({})).n;
    const pi = withNotifications(new PiTuiRenderer({ terminal: new VirtualTerminal(80, 24), cwd: process.cwd() }), n);
    expect("onEvent" in pi).toBe(false); // MUTATION: onEvent added unconditionally → the classic surface would be treated as event-driven
    expect("attach" in pi).toBe(false);
    expect("drain" in pi).toBe(false);
    expect((pi as Renderer).onEvent).toBeUndefined();
    expect(pi).toBeInstanceOf(PiTuiRenderer);
    const io = new MemoryIO(100, 30, {});
    const sx = withNotifications(new SextantRenderer({ io, clock: () => 1000, truecolor: true, scan: false, cwd: "C:/repo", theme: "ember" }), n);
    expect(sx).toBeInstanceOf(SextantRenderer);
    expect("onEvent" in sx).toBe(true);
    expect(typeof sx.onEvent).toBe("function");
    expect(sx.themeName).toBe("ember");           // a getter reads the inner's state
    expect(sx.active).toBe(false);
    sx.tick();                                    // a method needing `this` (bound to the inner)
    expect(sx.frames).toBeGreaterThanOrEqual(0);
    await sx.drain?.();
    sx.onEvent?.({ type: "run_start", runId: "r1", sessionId: "s1" } as never);
    const fake = new FakeRenderer();
    const w = withNotifications(fake, n);
    expect(w.extra()).toBe("extra:0");
    w.start(NOOP_HOOKS);
    expect(w.extra()).toBe("extra:1");
    expect(Object.getPrototypeOf(w)).toBe(FakeRenderer.prototype);
  });

  test("sextant surface: off → the stdout byte stream equals a control run; on → `?1004h` follows the surface's start writes and `?1004l` precedes its stop writes, once each; a non-TTY writer writes nothing; always → one ring for the run, none for a labelled outcome", () => {
    const script = (r: Renderer): void => { r.start(NOOP_HOOKS); r.setBusy(true, "thinking…"); r.setBusy(false); r.setBusy(true, "x…"); r.setBusy(false, "done"); r.stop(); r.stop(); };
    const make = (): { io: MemoryIO; r: SextantRenderer } => { const io = new MemoryIO(100, 30, {}); return { io, r: new SextantRenderer({ io, clock: () => 1000, truecolor: true, scan: false, cwd: "C:/repo" }) }; };
    const control = make(); script(control.r);
    const off = make(); script(withNotifications(off.r, new Notifier({ config: cfg({}, { user: { bell: false } }), write: (s) => off.io.write(s) })));
    expect(off.io.output()).toBe(control.io.output()); // MUTATION: ?1004h written with notifications off
    expect(control.io.output()).not.toContain("?1004");
    const on = make(); const seq: string[] = [];
    script(withNotifications(on.r, new Notifier({ config: cfg({}), write: (s) => { seq.push(s); on.io.write(s); } })));
    expect(seq).toEqual(["\x1b[?1004h", "\x1b[?1004l"]); // unfocused gate + a focused (default) tracker: no ring; the two DECSET writes exactly once (two stop() calls)
    const out = on.io.output();
    expect(out.startsWith(enterSequence(true))).toBe(true);
    expect(out.indexOf("\x1b[?1004h")).toBeGreaterThan(out.indexOf(enterSequence(true)));
    expect(out.split("\x1b[?1004h").length - 1).toBe(1);
    expect(out.endsWith("\x1b[?1004l" + leaveSequence())).toBe(true); // MUTATION: ?1004l omitted at stop
    expect(out.replace("\x1b[?1004h", "").replace("\x1b[?1004l", "")).toBe(control.io.output()); // nothing else changed on the wire
    const always = make(); script(withNotifications(always.r, new Notifier({ config: ALWAYS, write: (s) => always.io.write(s) })));
    expect(always.io.output().split("\x07").length - 1).toBe(1); // one ring for the run, none for the `done` outcome
    const pipe = make(); script(withNotifications(pipe.r, new Notifier({ config: ALWAYS }))); // the default writer: nowhere (a non-TTY stdout)
    expect(pipe.io.output()).toBe(control.io.output());
  });

  test("interactiveRenderer: sextant on a capable TTY (a Proxy over a SextantRenderer, `onEvent` present), classic otherwise and on a pipe (`onEvent` absent); nothing is written or started; a scratch cwd's settings are read", () => {
    class FakeStdin implements RawStdin { isRaw = false; setRawMode(m: boolean): this { this.isRaw = m; return this; } setEncoding(): this { return this; } resume(): this { return this; } pause(): this { return this; } on(): this { return this; } off(): this { return this; } }
    class FakeStdout implements RawStdout { out = ""; constructor(public isTTY: boolean, public columns = 160, public rows = 44) {} write(s: string): boolean { this.out += s; return true; } on(): this { return this; } off(): this { return this; } }
    const cwd = mkdtempSync(join(tmpdir(), "rovecode-notify-root-"));
    try {
      const tty = new FakeStdout(true);
      const sx = interactiveRenderer({ classic: false, pet: "stormy" }, { COLORTERM: "truecolor" }, tty, new FakeStdin(), cwd);
      expect(sx).toBeInstanceOf(SextantRenderer);
      expect("onEvent" in sx).toBe(true);
      expect((sx as SextantRenderer).active).toBe(false);
      expect(tty.out).toBe("");
      const classic = interactiveRenderer({ classic: true }, { COLORTERM: "truecolor" }, new FakeStdout(true), new FakeStdin(), cwd);
      expect(classic).toBeInstanceOf(PiTuiRenderer);
      expect("onEvent" in classic).toBe(false);
      const pipe = new FakeStdout(false);
      const piped = interactiveRenderer({ classic: false }, { COLORTERM: "truecolor", ROVECODE_NOTIFY_WHEN: "always" }, pipe, new FakeStdin(), cwd);
      expect(piped).toBeInstanceOf(PiTuiRenderer);
      expect("onEvent" in piped).toBe(false);
      expect(pipe.out).toBe("");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("FocusTracker flag feeds the gate: the same Notifier rings only while its tracker says unfocused", () => {
    const tracker = new FocusTracker();
    const writes: string[] = [];
    const n = new Notifier({ config: cfg({}), write: (s) => { writes.push(s); }, focused: () => tracker.focused });
    const w = withNotifications(new FakeRenderer(), n);
    w.start(NOOP_HOOKS);
    writes.length = 0;
    w.setBusy(true); w.setBusy(false);
    expect(writes).toEqual([]);
    tracker.feed("\x1b[O");
    w.setBusy(true); w.setBusy(false);
    expect(writes).toEqual(["\x07"]);
    tracker.feed("\x1b[I");
    w.setBusy(true); w.setBusy(false);
    expect(writes).toEqual(["\x07"]);
  });
});
