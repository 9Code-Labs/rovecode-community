/** TUI /help — grouped by topic (info-cmd.ts groupedHelp over SlashCommand.group): every built-in
 *  lands under one of the six topics in a fixed order, /setup is listed first with the start-here
 *  group, descriptions read in rovecode's voice, and an ungrouped command falls under "more" at the end. */

import { test, expect } from "bun:test";
import { groupedHelp, HELP_GROUP_ORDER } from "../../src/tui/info-cmd.ts";
import { TUI_COMMANDS } from "../../src/tui/app.ts";

test("six topics in order, each built-in listed exactly once, /connect under start here (setup is gone from the table)", () => {
  const h = groupedHelp(TUI_COMMANDS);
  const heads = h.split("\n").filter((l) => !l.startsWith("  /"));
  expect(heads).toEqual([...HELP_GROUP_ORDER]); // no "more": every built-in carries a known group
  expect(h.startsWith("start here\n  /help — ")).toBe(true);
  for (const c of TUI_COMMANDS) expect(h.split(`  /${c.name} — `).length - 1).toBe(1);
  const startHere = h.split("\nsession\n")[0]!;
  expect(startHere).toContain("/connect — Connect a model:");
  const modes = h.split("\nmodes & safety\n")[1]!.split("\nfiles & history\n")[0]!;
  expect(modes).toContain("/yolo — Toggle ask first / auto (never asks)");
  expect(modes).toContain("/plan — Plan mode: I only read and plan");
});

test("descriptions: plain words, no gated/yolo jargon except the command's own name, no emoji", () => {
  for (const c of TUI_COMMANDS) {
    expect(c.description).not.toMatch(/\bgated\b/);
    expect(c.description).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(c.description.length).toBeGreaterThan(8);
  }
});

test("an unknown or missing group lands under `more`, after the known topics", () => {
  const h = groupedHelp([
    { name: "zeta", description: "odd one out" },
    { name: "help", description: "x", group: "start here" },
    { name: "weird", description: "unknown topic", group: "somewhere else" },
  ]);
  expect(h).toBe("start here\n  /help — x\nmore\n  /zeta — odd one out\n  /weird — unknown topic");
});
