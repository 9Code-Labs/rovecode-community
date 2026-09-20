/** The design protocol reaching the real runtime: the two tools registered, the section in the system
 *  prompt, the escape hatch working, and design_direction gated the way the other write-ish custom
 *  tools are. Wiring is the part that silently does not happen — src/design/* passing its own unit
 *  tests proves nothing if buildDef never appends the section. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { saveDirection } from "../../src/design/direction.ts";
import type { ModelRef } from "../../src/core/types.ts";

const MODEL: ModelRef = { provider: "anthropic", model: "claude-sonnet-5" };
const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "rovecode-designwire-"));

test("both design tools are registered, and only design_direction is a gated custom tool", () => {
  const cwd = tmpCwd();
  try {
    const rt = createRuntime({ cwd, stream: null });
    const names = rt.registry.list().map((t) => t.schema.name);
    expect(names).toContain("design_audit");
    expect(names).toContain("design_direction");

    const cfg = rt.buildCfg("ask");
    const actions = cfg.permissionRules.map((r) => `${r.action}:${r.effect}`);
    expect(actions).toContain("tool.design_direction:prompt");
    // design_audit is kind read -> covered by the file.read allow, never its own prompt rule
    expect(actions.some((a) => a.startsWith("tool.design_audit"))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("auto (yolo) allows design_direction without an approver, like every other tool", () => {
  const cwd = tmpCwd();
  try {
    const cfg = createRuntime({ cwd, stream: null }).buildCfg("auto");
    expect(cfg.permissionRules).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    expect(cfg.approval).toBeUndefined();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the system prompt carries the design STUB and asks for a direction before any UI is written — the ban list itself rides in design_direction's get answer, not in every request", () => {
  const cwd = tmpCwd();
  try {
    const prompt = createRuntime({ cwd, stream: null }).buildDef(MODEL).systemPrompt;
    expect(prompt).toContain("# Design");
    expect(prompt).toContain("No design direction is recorded yet");
    expect(prompt).toContain('design_direction {action:"get"}');
    // staged context (measured 2026-09-20): the ~2.2k-token proposal is lazy-disclosed, not idle weight
    expect(prompt).not.toContain("# Interface design");
    expect(prompt).not.toContain("Amber, orange and gold");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("ROVECODE_DESIGN=full restores the always-on proposal in the prompt", () => {
  const cwd = tmpCwd();
  const saved = process.env.ROVECODE_DESIGN;
  process.env.ROVECODE_DESIGN = "full";
  try {
    const prompt = createRuntime({ cwd, stream: null }).buildDef(MODEL).systemPrompt;
    expect(prompt).toContain("# Interface design");
    expect(prompt).toContain("Amber, orange and gold");
    expect(prompt).toContain("No design direction is recorded yet");
  } finally {
    if (saved === undefined) delete process.env.ROVECODE_DESIGN; else process.env.ROVECODE_DESIGN = saved;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("once a direction is recorded the prompt carries it instead, and stops asking", () => {
  const cwd = tmpCwd();
  try {
    saveDirection(cwd, { name: "ink band", palette: { ink: "#0b1a2e" }, typeface: { display: "Geist" }, corners: "sharp" });
    const prompt = createRuntime({ cwd, stream: null }).buildDef(MODEL).systemPrompt;
    expect(prompt).toContain("do not re-ask");
    expect(prompt).toContain("ink band");
    expect(prompt).toContain("#0b1a2e");
    expect(prompt).not.toContain("No design direction is recorded yet");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("ROVECODE_DESIGN=off drops the section for a run that has nothing to do with interfaces", () => {
  const cwd = tmpCwd();
  const prev = process.env["ROVECODE_DESIGN"];
  try {
    process.env["ROVECODE_DESIGN"] = "off";
    const prompt = createRuntime({ cwd, stream: null }).buildDef(MODEL).systemPrompt;
    expect(prompt).not.toContain("# Interface design");
    // the rest of the prompt is untouched
    expect(prompt).toContain("You are Rovecode");
  } finally {
    if (prev === undefined) delete process.env["ROVECODE_DESIGN"]; else process.env["ROVECODE_DESIGN"] = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});
