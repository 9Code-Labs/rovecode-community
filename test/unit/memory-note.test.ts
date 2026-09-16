/** `#<text>` and `/memory [--user] [text]` (src/tui/memory-note.ts, 2026-09-07).
 *
 *  The classifier is the whole risk here: the obvious "starts with #" rule swallows pasted code, and a swallowed
 *  paste is a prompt the model never sees plus a junk line in the project's memory. So a note is ONE line of `#`
 *  followed by a letter or digit, and everything else — a paste, a shebang, a markdown heading, an attribute, a
 *  `#` mid-sentence — goes to the model untouched. The rest pins where a note LANDS and that the line says so. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/memory/blocks.ts";
import { openScopedMemory, projectMemoryDir, userMemoryDir } from "../../src/memory/scope.ts";
import { appendMemory, memoryCommand, memoryNoteLine, runMemoryNote } from "../../src/tui/memory-note.ts";

let cwd = "", home = "", savedHome: string | undefined;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-note-cwd-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-note-home-"));
  savedHome = process.env.ROVECODE_HOME; process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
const store = (): BlockStore => openScopedMemory({ cwd, sessionsDir: join(cwd, ".rovecode", "sessions"), sessionId: "s1", home }).blocks;

/** the renderer slice runMemoryNote needs */
function fake() {
  const users: string[] = [], notes: { text: string; tone: string }[] = [];
  return { users, notes, renderer: { addUser: (t: string) => { users.push(t); }, addSystemNote: (t: string, tone = "info") => { notes.push({ text: t, tone }); } } };
}

describe("the classifier", () => {
  test("a note is ONE line of # then a letter or digit — in any script", () => {
    expect(memoryNoteLine("#always use bun")).toBe("always use bun");
    expect(memoryNoteLine("  #1 is flaky  ")).toBe("1 is flaky"); // the LINE may be padded; the # may not be
    expect(memoryNoteLine("#note  with  inner  spaces  ")).toBe("note  with  inner  spaces");
    expect(memoryNoteLine("#türkçe de olur")).toBe("türkçe de olur");
    expect(memoryNoteLine("#日本語")).toBe("日本語");
  });

  test("everything else is a prompt for the model — the pasted-code case above all", () => {
    const notNotes = [
      "#include <stdio.h>\nint main() {}",   // a pasted C file: MULTI-LINE, so never a note
      "#!/usr/bin/env bun\nconsole.log(1)",
      "#",                                    // a lone hash
      "# heading",                            // markdown: # then a space
      "#  spaced out",                        // the same shape — a heading, not a note
      "##x",                                  // a second hash
      "#!bang",
      "#[derive(Debug)]",                     // a Rust attribute
      "#-flag",
      "fix the #1 bug",                       // a hash INSIDE a line
      "explain #include to me",
      "",
      "   ",
      "what does # mean",
    ];
    for (const t of notNotes) expect([t, memoryNoteLine(t)]).toEqual([t, null]);
  });

  test("a single-line paste that happens to start with #word is taken as a note — the known edge, and why the line is echoed and the outcome said", () => {
    expect(memoryNoteLine("#define MAX 10")).toBe("define MAX 10"); // one line, # + a letter: indistinguishable from a note
    const f = fake();
    expect(runMemoryNote({ renderer: f.renderer, blocks: store }, "#define MAX 10")).toBe(true);
    expect(f.users).toEqual(["#define MAX 10"]);                     // the person sees exactly what happened…
    expect(f.notes[0]!.text).toContain("noted in MEMORY");           // …and where it went, so it can be undone
  });
});

describe("where a note lands, and what the line says", () => {
  test("runMemoryNote appends to the PROJECT block, echoes the line, and names the file and the budget", () => {
    const f = fake();
    expect(runMemoryNote({ renderer: f.renderer, blocks: store }, "#always use bun")).toBe(true);
    expect(f.users).toEqual(["#always use bun"]);
    const note = f.notes[0]!;
    expect(note.tone).toBe("info");
    expect(note.text).toContain("noted in MEMORY");
    expect(note.text).toContain(join(projectMemoryDir(cwd), "MEMORY.md")); // the path is the point: the old bug was a note landing unseen
    expect(note.text).toContain("in the prompt from the next run");
    expect(readFileSync(join(projectMemoryDir(cwd), "MEMORY.md"), "utf8")).toContain("always use bun");
  });

  test("a line that is not a note does nothing at all — no echo, no note, no file", () => {
    const f = fake();
    expect(runMemoryNote({ renderer: f.renderer, blocks: store }, "explain #include")).toBe(false);
    expect([f.users, f.notes]).toEqual([[], []]);
  });

  test("a refused append is a warning that carries the reason, and nothing is written", () => {
    const s = store();
    const f = fake();
    const huge = "x".repeat(s.cap("memory") + 10);
    const r = appendMemory(s, "memory", huge);
    expect(r.ok).toBe(false);
    expect(r.tone).toBe("warn");
    expect(r.text).toContain("not saved to MEMORY");
    expect(r.text).toContain("cap");
    void f;
  });
});

describe("/memory", () => {
  test("bare: both blocks with their paths and the (empty) placeholder; --user: the USER block alone", () => {
    const s = store();
    const both = memoryCommand(s, "");
    expect(both.text).toContain(`# MEMORY — ${join(projectMemoryDir(cwd), "MEMORY.md")}`);
    expect(both.text).toContain(`# USER — ${join(userMemoryDir(home), "USER.md")}`);
    expect(both.text).toContain("(empty)");
    const user = memoryCommand(s, "--user");
    expect(user.text).toContain("# USER");
    expect(user.text).not.toContain("# MEMORY");
  });

  test("with text: appends to MEMORY; `--user <text>`: to USER — the ONE composer path to the user block", () => {
    const s = store();
    expect(memoryCommand(s, "prefer tabs").text).toContain("noted in MEMORY");
    expect(memoryCommand(s, "--user I prefer short answers").text).toContain("noted in USER");
    expect(readFileSync(join(projectMemoryDir(cwd), "MEMORY.md"), "utf8")).toContain("prefer tabs");
    const userText = readFileSync(join(userMemoryDir(home), "USER.md"), "utf8");
    expect(userText).toContain("I prefer short answers");
    expect(userText).not.toContain("prefer tabs");                          // the two files never cross
    expect(memoryCommand(s, "").text).toContain("prefer tabs");             // the listing reads LIVE text, not the boot snapshot
  });

  test("the hints say why what you just wrote is not in the prompt yet", () => {
    const s = store();
    memoryCommand(s, "a fresh fact");
    expect(memoryCommand(s, "").text).toContain("(edited this run — in the prompt from the next run)");
    expect(s.renderForPrompt()).not.toContain("a fresh fact");              // the boot snapshot is frozen, as promised
    expect(store().renderForPrompt()).toContain("a fresh fact");            // …and the NEXT run has it
  });
});
