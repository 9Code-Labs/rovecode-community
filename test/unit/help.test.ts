/** cli/help.ts — `rovecode help [topic]`: the default page is short and grouped (start here · everyday ·
 *  safety · more), `env` / `advanced` / `all` hold the reference the integration tests grep. */

import { test, expect } from "bun:test";
import { HELP_TOPICS, helpText } from "../../src/cli/help.ts";

test("default page: four groups, the three ways in, both permission modes by name, and it stays short", () => {
  const h = helpText("");
  for (const g of ["\nstart here\n", "\neveryday\n", "\nsafety\n", "\nmore\n"]) expect(h).toContain(g);
  expect(h).toContain("rovecode connect"); // the wizard AND its one-line form live under one name
  expect(h).toContain('rovecode "fix the failing test"');
  expect(h).toContain("ask first (default)");
  expect(h).toContain("auto (--yolo, ROVECODE_YOLO=1)");
  expect(h).toContain("rovecode help env");
  expect(h).toContain("rovecode help advanced");
  expect(h).toContain("rovecode help all");
  expect(h).not.toContain("ROVECODE_RETRY_MAX"); // the knobs live on the env page
  expect(h).not.toMatch(/\bgated\b|\byolo mode\b/);
  expect(h.split("\n").length).toBeLessThan(32);
  expect(helpText()).toBe(h);
});

test("env page: every knob the integration tests pin, plus ROVECODE_HOME and the providers block", () => {
  const e = helpText("env");
  expect(e).toMatch(/^\s*ROVECODE_MODEL\s+model id/m);
  expect(e).toMatch(/^\s*ROVECODE_RETRY_MAX\s+.*default 3.*0 = off/m);
  expect(e).toMatch(/^\s*ROVECODE_SANDBOX\s+.*direct.*wsl.*docker.*sandbox\.json/m);
  expect(e).toMatch(/^\s*ROVECODE_SANDBOX_IMAGE\s+.*docker rung/m);
  expect(e).toMatch(/^\s*ROVECODE_HOME\s+/m);
  expect(e).toContain("providers: built in");
  expect(e).not.toContain("rovecode run"); // commands are not on the env page
});

test("advanced page: the full command reference incl. smoke-tui (dev-only), --output and the exit codes", () => {
  const a = helpText("advanced");
  expect(a).toMatch(/^\s*rovecode smoke-tui\s.*\(dev-only\)\s*$/m);
  expect(a).toContain("--output <text|json|ndjson>");
  expect(a).toContain("0 done · 1 error/budget · 2 usage/startup error · 130 aborted");
  expect(a).toContain('"/name args" expands a custom command');
  expect(a).toContain("rovecode setup");
  expect(a).toContain("--key-stdin"); // connect: the scriptable key path is on the reference page
  expect(a).toContain("rovecode acp");
  expect(a).toContain("rovecode serve");
});

test("all = default + advanced + env, in that order; an unknown topic gets the default page and a note", () => {
  const all = helpText("all");
  const i0 = all.indexOf("start here"), i1 = all.indexOf("advanced — the full command reference"), i2 = all.indexOf("env — every ROVECODE_* setting");
  expect(i0).toBeGreaterThanOrEqual(0);
  expect(i1).toBeGreaterThan(i0);
  expect(i2).toBeGreaterThan(i1);
  expect(all).toContain(helpText("env"));
  expect(all).toContain(helpText("advanced"));
  const bad = helpText("nope");
  expect(bad).toContain(helpText(""));
  expect(bad).toContain('no help topic "nope"');
  expect([...HELP_TOPICS]).toEqual(["", "env", "advanced", "all"]);
});
