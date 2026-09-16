/** Custom slash commands (port #30): discovery across user (temp ROVECODE_HOME) + project dirs,
 *  name derivation/validation, frontmatter, $ARGUMENTS/$N templating, collisions, and the TUI
 *  dispatch semantics (busy gate, mode switch, per-run model override + restore) against a
 *  stub renderer. The terminal e2e lives in test/integration/tui-app.test.ts. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  discoverCommands, parseCommandFile, renderCommand, hints, commandsForPalette, helpForCommands,
  dispatchCustomCommand, runCustomCommand, expandSlashPrompt, type CustomCommand, type CustomCommandCtx,
} from "../../src/tui/commands.ts";
import { ModeManager } from "../../src/core/modes.ts";
import type { Renderer } from "../../src/tui/renderer.ts";

let cwd: string;
let home: string;
const savedHome = process.env.ROVECODE_HOME;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-cmds-cwd-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-cmds-home-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}
const project = (file: string, content: string) => write(cwd, join(".rovecode", "commands", file), content);
const user = (file: string, content: string) => write(home, join("commands", file), content);
const projectPath = (file: string) => join(cwd, ".rovecode", "commands", file);

// ---------- discovery ----------

test("discovery: user (~/.rovecode/commands) + project (.rovecode/commands) merge, sorted by name, scoped", () => {
  user("greet.md", "---\ndescription: Greet\n---\nHello $ARGUMENTS\n");
  project("hello.md", "---\ndescription: Say hello to someone\n---\nSay hi to $ARGUMENTS\n");
  const { commands, warnings } = discoverCommands(cwd, { home });
  expect(warnings).toEqual([]);
  expect(commands.map((c) => [c.name, c.scope])).toEqual([["greet", "user"], ["hello", "project"]]);
  expect(commands[1]!.body).toBe("Say hi to $ARGUMENTS");
  expect(commands[1]!.description).toBe("Say hello to someone");
  expect(commands[1]!.hints).toEqual(["$ARGUMENTS"]);
  expect(commands[1]!.path).toBe(projectPath("hello.md"));
});

test("discovery: the user scope defaults to ROVECODE_HOME (auth.ts rovecodeHome idiom)", () => {
  process.env.ROVECODE_HOME = home;
  user("fromhome.md", "body\n");
  expect(discoverCommands(cwd).commands.map((c) => [c.name, c.scope])).toEqual([["fromhome", "user"]]);
});

test("discovery: missing dirs are silent; non-.md files and subdirectories are ignored", () => {
  expect(discoverCommands(cwd, { home })).toEqual({ commands: [], warnings: [] });
  project("notes.txt", "not a command");
  project(join("nested", "deep.md"), "nested body");
  expect(discoverCommands(cwd, { home })).toEqual({ commands: [], warnings: [] });
});

test("discovery: cwd/.rovecode IS the rovecode home → one directory, scanned once, no self-collision warning", () => {
  project("solo.md", "body");
  const { commands, warnings } = discoverCommands(cwd, { home: join(cwd, ".rovecode") });
  expect(commands.map((c) => [c.name, c.scope])).toEqual([["solo", "project"]]);
  expect(warnings).toEqual([]);
});

test("name derivation: filename sans .md (any case), lowercased; names outside [a-z0-9_-]+ skipped with a warning", () => {
  project("Deploy-Prod.md", "deploy $1");
  project("SHOUT.MD", "loud");
  project("bad name.md", "x");
  project("dots.in.name.md", "x");
  const { commands, warnings } = discoverCommands(cwd, { home });
  expect(commands.map((c) => c.name)).toEqual(["deploy-prod", "shout"]);
  expect(warnings).toEqual([
    `${projectPath("bad name.md")}: skipped — command name "bad name" must match [a-z0-9_-]+`,
    `${projectPath("dots.in.name.md")}: skipped — command name "dots.in.name" must match [a-z0-9_-]+`,
  ]);
});

// ---------- frontmatter ----------

test("frontmatter: description/model/mode parsed, quotes stripped, unknown keys ignored, CRLF ok", () => {
  const r = parseCommandFile('---\r\ndescription: "Quoted desc"\r\nmodel: fast-1\r\nmode: plan\r\nfoo: bar\r\n---\r\nBody $ARGUMENTS\r\n');
  expect(r).toEqual({ description: "Quoted desc", model: "fast-1", mode: "plan", body: "Body $ARGUMENTS" });
});

test("frontmatter is optional: a bare body parses with no metadata and gets a default description", () => {
  expect(parseCommandFile("Just a prompt\n")).toEqual({ body: "Just a prompt" });
  project("bare.md", "Just a prompt\n");
  const [cmd] = discoverCommands(cwd, { home }).commands;
  expect(cmd!.description).toBe("custom command (bare.md)");
  expect(cmd!.model).toBeUndefined();
  expect(cmd!.mode).toBeUndefined();
});

test("malformed files: unterminated fence, bad mode, empty body → parse error; discovery skips them with a warning, never throws", () => {
  expect(parseCommandFile("---\ndescription: x\nno closing fence\n")).toEqual({ error: "unterminated frontmatter (no closing ---)" });
  expect(parseCommandFile("---\nmode: yolo\n---\nbody\n")).toEqual({ error: 'mode must be "plan" or "act" (got "yolo")' });
  expect(parseCommandFile("---\ndescription: x\n---\n\n")).toEqual({ error: "empty command body (nothing to send)" });
  // closing fence as the very last line, no trailing newline (parseFrontmatter needs the line end)
  expect(parseCommandFile("---\ndescription: x\n---")).toEqual({ error: "empty command body (nothing to send)" });
  project("broken.md", "---\nmode: yolo\n---\nbody\n");
  project("ok.md", "fine\n");
  const { commands, warnings } = discoverCommands(cwd, { home });
  expect(commands.map((c) => c.name)).toEqual(["ok"]);
  expect(warnings).toEqual([`${projectPath("broken.md")}: skipped — mode must be "plan" or "act" (got "yolo")`]);
});

test("frontmatter: a UTF-8 BOM before the opening fence is tolerated", () => {
  expect(parseCommandFile(String.fromCharCode(0xfeff) + "---\ndescription: bom\n---\nbody\n")).toEqual({ description: "bom", body: "body" });
});

// ---------- templating ----------

test("templating: $ARGUMENTS is the whole string, $1/$2 are quote-aware tokens, missing → empty", () => {
  expect(renderCommand({ body: "Say hi to $ARGUMENTS" }, "world")).toBe("Say hi to world");
  expect(renderCommand({ body: "Say hi to $ARGUMENTS" }, "  a  b  ")).toBe("Say hi to a  b"); // trimmed ends, inner spacing kept
  expect(renderCommand({ body: "first=$1 second=$2 all=$ARGUMENTS" }, '"a b" c')).toBe('first=a b second=c all="a b" c');
  expect(renderCommand({ body: "one=$1 two=$2 nine=$9" }, "x")).toBe("one=x two= nine=");
  expect(renderCommand({ body: "Say hi to $ARGUMENTS" }, "")).toBe("Say hi to ");
});

test("templating: $$ is a literal $, and substitution is ONE pass (argument text is never re-expanded)", () => {
  expect(renderCommand({ body: "cost: $$5 and $$ARGUMENTS stay; $1 expands" }, "v")).toBe("cost: $5 and $ARGUMENTS stay; v expands");
  // a two-pass port ($N then $ARGUMENTS, opencode prompt.ts:1383-1391) would expand the "$ARGUMENTS" that arrived via $1
  expect(renderCommand({ body: "$1|$ARGUMENTS" }, "$2 $ARGUMENTS")).toBe("$2|$2 $ARGUMENTS");
});

test("templating: a template without placeholders gets the arguments appended (opencode prompt.ts:1393-1395)", () => {
  expect(renderCommand({ body: "Review the diff." }, "focus on tests")).toBe("Review the diff.\n\nfocus on tests");
  expect(renderCommand({ body: "Review the diff." }, "")).toBe("Review the diff.");
  expect(renderCommand({ body: "price $$" }, "x")).toBe("price $\n\nx"); // an escape is not a placeholder
});

test("hints: $N sorted then $ARGUMENTS; $$ escapes do not count", () => {
  expect(hints("b $2 a $1 $1 $ARGUMENTS")).toEqual(["$1", "$2", "$ARGUMENTS"]);
  expect(hints("$$1 $$ARGUMENTS plain")).toEqual([]);
});

// ---------- collisions ----------

test("collision: project shadows user on the same name — project body and scope win, silently", () => {
  user("shared.md", "user body");
  project("shared.md", "project body");
  const { commands, warnings } = discoverCommands(cwd, { home });
  expect(warnings).toEqual([]);
  expect(commands).toHaveLength(1);
  expect(commands[0]!.scope).toBe("project");
  expect(commands[0]!.body).toBe("project body");
});

test("collision: a built-in name is dropped with a boot warning — the built-in wins", () => {
  project("help.md", "not the real help");
  user("exit.md", "not the real exit");
  project("mine.md", "ok");
  const { commands, warnings } = discoverCommands(cwd, { home, reserved: ["help", "exit"] });
  expect(commands.map((c) => c.name)).toEqual(["mine"]);
  expect(warnings).toEqual([
    `/exit is a built-in command — built-in kept (${join(home, "commands", "exit.md")})`,
    `/help is a built-in command — built-in kept (${projectPath("help.md")})`,
  ]);
});

// ---------- palette / help / rovecode run ----------

test("palette + /help: autocomplete entries carry name/description; help lists a custom: section with hints and scope", () => {
  project("hello.md", "---\ndescription: Say hello to someone\n---\nSay hi to $ARGUMENTS\n");
  user("two.md", "$1 then $2");
  const { commands } = discoverCommands(cwd, { home });
  expect(commandsForPalette(commands)).toEqual([
    { name: "hello", description: "Say hello to someone" },
    { name: "two", description: "custom command (two.md)" },
  ]);
  expect(helpForCommands(commands)).toBe(
    "\ncustom:\n/hello $ARGUMENTS — Say hello to someone (project)\n/two $1 $2 — custom command (two.md) (user)",
  );
  expect(helpForCommands([])).toBe("");
});

test("rovecode run hook: expandSlashPrompt renders a known /name (case-insensitive), passes everything else through", () => {
  project("hello.md", "Say hi to $ARGUMENTS");
  expect(expandSlashPrompt("/hello big world", cwd, { home })).toBe("Say hi to big world");
  expect(expandSlashPrompt("/HELLO x", cwd, { home })).toBe("Say hi to x");
  expect(expandSlashPrompt("/hello", cwd, { home })).toBe("Say hi to ");
  expect(expandSlashPrompt("/nope x", cwd, { home })).toBe("/nope x");
  expect(expandSlashPrompt("plain prompt", cwd, { home })).toBe("plain prompt");
});

test("port #53: a BUILT-IN prompt beats a same-named custom command on the headless path — expandSlashPrompt consults the builtin table FIRST (a repo init.md must not swallow rovecode run \"/init\")", () => {
  project("init.md", "a custom command that would shadow /init if the order were reversed");
  // the builtin's rendered AGENTS.md prompt, not the custom body
  const out = expandSlashPrompt("/init", cwd, { home });
  expect(out).toContain("AGENTS.md");                                        // MUTATION: discoverCommands-first (the old order) → the custom body wins
  expect(out).not.toContain("shadow");
  // a name that is neither builtin nor custom still passes through verbatim
  expect(expandSlashPrompt("/init-extra", cwd, { home })).toBe("/init-extra");
});

// ---------- TUI dispatch semantics (stub renderer; the terminal e2e is in tui-app.test.ts) ----------

function stubCtx(modes: ModeManager, submit: (text: string) => Promise<void>) {
  const notes: string[] = [];
  let pushes = 0;
  const renderer = { addSystemNote: (t: string) => { notes.push(t); } } as unknown as Renderer;
  const cur = modes.modelFor();
  const state = { provider: cur.provider, model: cur.model, mode: modes.mode, busy: false };
  const ctx: CustomCommandCtx = { renderer, modes, state, pushStatus: () => { pushes++; }, submit };
  return { ctx, notes, state, pushes: () => pushes };
}
const cmd = (over: Partial<CustomCommand> = {}): CustomCommand =>
  ({ name: "c", description: "d", body: "Do $ARGUMENTS", hints: ["$ARGUMENTS"], path: "/x/c.md", scope: "project", ...over });

test("dispatch: unknown name → false (caller reports); known → true and the RENDERED prompt goes through submit", async () => {
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  const seen: string[] = [];
  const { ctx } = stubCtx(modes, async (t) => { seen.push(t); });
  expect(dispatchCustomCommand(ctx, [cmd()], "nope", "")).toBe(false);
  expect(dispatchCustomCommand(ctx, [cmd()], "c", "the thing")).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toEqual(["Do the thing"]);
});

test("dispatch: busy gate refuses with the house warning; nothing is submitted, switched, or re-pointed", async () => {
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  const seen: string[] = [];
  const { ctx, notes, state } = stubCtx(modes, async (t) => { seen.push(t); });
  state.busy = true;
  await runCustomCommand(ctx, cmd({ mode: "plan", model: "fast" }), "x");
  expect(seen).toEqual([]);
  expect(notes).toEqual(["finish or interrupt the run first (Esc)"]);
  expect(modes.mode).toBe("act");
  expect(modes.modelFor().model).toBe("m0");
});

test("dispatch: mode → switched through the /plan path BEFORE submit and left switched afterwards", async () => {
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  let modeAtSubmit: string | undefined;
  const { ctx, state, notes } = stubCtx(modes, async () => { modeAtSubmit = modes.mode; });
  await runCustomCommand(ctx, cmd({ mode: "plan" }), "x");
  expect(modeAtSubmit).toBe("plan");
  expect(modes.mode).toBe("plan"); // stays switched (documented semantics)
  expect(state.mode).toBe("plan");
  expect(modes.consumeSwitchNotice()).toEqual({ from: "act", to: "plan" }); // a real toggle(): the durable-entry notice is pending
  expect(notes.some((n) => n.startsWith("plan mode:"))).toBe(true);
  notes.length = 0; // already in plan → no second toggle, no "already in plan" chatter
  await runCustomCommand(ctx, cmd({ mode: "plan" }), "x");
  expect(notes).toEqual([]);
});

test("dispatch: model → per-run override visible to the run, restored (with a status push) after it", async () => {
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  let modelAtSubmit: string | undefined;
  const { ctx, state, notes, pushes } = stubCtx(modes, async () => { modelAtSubmit = modes.modelFor().model; });
  await runCustomCommand(ctx, cmd({ model: "fast" }), "x");
  expect(modelAtSubmit).toBe("fast");
  expect(modes.modelFor().model).toBe("m0");
  expect(state.model).toBe("m0");
  expect(notes).toEqual(["model → fast for /c (restored after the run)"]);
  expect(pushes()).toBe(2); // override + restore
});

test("dispatch: the model restore is skipped when the user re-pointed the model mid-run", async () => {
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  const { ctx, state } = stubCtx(modes, async () => { modes.setModel({ model: "user-choice" }); state.model = "user-choice"; });
  await runCustomCommand(ctx, cmd({ model: "fast" }), "x");
  expect(modes.modelFor().model).toBe("user-choice");
  expect(state.model).toBe("user-choice");
});

test("dispatch: a model equal to the current one is no override (no note, no pushes); a throwing submit still restores", async () => {
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  const same = stubCtx(modes, async () => {});
  await runCustomCommand(same.ctx, cmd({ model: "m0" }), "x");
  expect(same.notes).toEqual([]);
  expect(same.pushes()).toBe(0);
  const boom = stubCtx(modes, async () => { throw new Error("boom"); });
  await expect(runCustomCommand(boom.ctx, cmd({ model: "fast" }), "x")).rejects.toThrow("boom");
  expect(modes.modelFor().model).toBe("m0");
});

// ---------- wiring pass: port #30 critic LOW-2 (bounded echoes) / LOW-3 (symlinked files) ----------

test("LOW-2: a huge `mode:` value is echoed clipped (40 chars + …) in the parse error; a huge description is capped at 200 chars in discovery", () => {
  const r = parseCommandFile(`---\nmode: ${"y".repeat(5000)}\n---\nbody\n`);
  expect(r).toEqual({ error: `mode must be "plan" or "act" (got "${"y".repeat(39)}…")` }); // mutation: unbounded echo → 5000 chars
  if ("error" in r) expect(r.error.length).toBeLessThan(100);
  expect(parseCommandFile("---\nmode: yolo\n---\nbody\n")).toEqual({ error: 'mode must be "plan" or "act" (got "yolo")' }); // short values untouched
  project("long.md", `---\ndescription: ${"d".repeat(1000)}\n---\nbody\n`);
  project("short.md", "---\ndescription: fits\n---\nbody\n");
  const { commands, warnings } = discoverCommands(cwd, { home });
  expect(warnings).toEqual([]);
  expect(commands.map((c) => c.description)).toEqual([`${"d".repeat(199)}…`, "fits"]);
  expect(commands[0]!.description.length).toBe(200);
  expect(helpForCommands(commands).split("\n").every((l) => l.length < 260)).toBe(true);
});

/** Windows needs a privilege or Developer Mode for file symlinks — detect once; the test skips (not fails) without it. */
const canSymlink = (() => {
  const d = mkdtempSync(join(tmpdir(), "rovecode-cmds-sym-"));
  try { writeFileSync(join(d, "t.md"), "x"); symlinkSync(join(d, "t.md"), join(d, "l.md"), "file"); return true; }
  catch { return false; }
  finally { rmSync(d, { recursive: true, force: true }); }
})();

test.skipIf(!canSymlink)("LOW-3: a symlinked *.md is discovered through its target; a DANGLING link is reported unreadable, never silently dropped (skipped where symlinkSync is not permitted: Windows without Developer Mode)", () => {
  const target = write(cwd, join("elsewhere", "real.md"), "---\ndescription: via link\n---\nLinked $ARGUMENTS\n");
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  symlinkSync(target, projectPath("linked.md"), "file");
  symlinkSync(join(cwd, "elsewhere", "gone.md"), projectPath("dangling.md"), "file");
  const { commands, warnings } = discoverCommands(cwd, { home });
  // mutation: filter on e.isFile() alone → both links vanish silently (no command, no warning)
  expect(commands.map((c) => [c.name, c.body, c.description])).toEqual([["linked", "Linked $ARGUMENTS", "via link"]]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith(`${projectPath("dangling.md")}: skipped — unreadable (`);
});
