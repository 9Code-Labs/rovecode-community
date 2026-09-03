/** Plan/Act modes (port #20, cline): plan-mode denial rides the EXISTING
 *  permission ladder, per-mode model slots resolve with tested precedence,
 *  toggles round-trip (including notice cancellation), and mode switches
 *  survive a session reload as durable entries. */

import { test, expect } from "bun:test";
import {
  ModeManager, applyModeRules, planModeRules, loadModesConfig,
  buildModeChangeEntry, modeFromEntries, modeSwitchOf, formatModeSwitchNotice,
  createModeSwitchNoticeTracker, planModePromptSection, DEFAULT_MODE,
} from "../../src/core/modes.ts";
import { evaluatePermissions, ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { Message, PermissionRule, Tool, ToolContext, RunEvent } from "../../src/core/types.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "rovecode-modes-"));
}

// ---------- plan-mode policy via the existing evaluatePermissions ladder ----------

test("plan mode denies writes/exec/spawn/memory/mcp over the REAL gated rules", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const rules = applyModeRules("plan", rt.buildCfg(false).permissionRules);
  expect(evaluatePermissions(rules, "file.write", "src/app.ts").effect).toBe("deny");
  expect(evaluatePermissions(rules, "shell.exec", "ls -la").effect).toBe("deny");
  expect(evaluatePermissions(rules, "spawn", "worker").effect).toBe("deny");
  expect(evaluatePermissions(rules, "memory.write", "block").effect).toBe("deny");
  expect(evaluatePermissions(rules, "tool.mcp_call", "server/tool").effect).toBe("deny");
  expect(evaluatePermissions(rules, "file.read", "src/app.ts").effect).toBe("allow");
  rmSync(cwd, { recursive: true, force: true });
});

test("plan mode overrides even yolo's blanket allow (last match wins)", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const yolo = rt.buildCfg(true).permissionRules;
  expect(evaluatePermissions(yolo, "file.write", "x").effect).toBe("allow"); // sanity: base allows
  const rules = applyModeRules("plan", yolo);
  expect(evaluatePermissions(rules, "file.write", "x").effect).toBe("deny");
  expect(evaluatePermissions(rules, "shell.exec", "rm -rf /").effect).toBe("deny");
  expect(evaluatePermissions(rules, "file.read", "x").effect).toBe("allow");
  rmSync(cwd, { recursive: true, force: true });
});

test("act mode passes base rules through unchanged (and never mutates them)", () => {
  const base: PermissionRule[] = [{ action: "file.write", resource: "*", effect: "prompt" }];
  const snapshot = JSON.parse(JSON.stringify(base));
  const act = applyModeRules("act", base);
  expect(act).toEqual(base);
  expect(evaluatePermissions(act, "file.write", "x").effect).toBe("prompt");
  applyModeRules("plan", base); // must not mutate base either
  expect(base).toEqual(snapshot);
});

test("plan mode guarantees reads even from an empty base rule set", () => {
  const rules = applyModeRules("plan", []);
  expect(evaluatePermissions(rules, "file.read", "anything").effect).toBe("allow");
  expect(evaluatePermissions(rules, "file.write", "anything").effect).toBe("deny");
});

test("allowTools re-allows vouched read-only custom tools after the blanket tool.* deny", () => {
  const rules = planModeRules(["mcp_list"]);
  expect(evaluatePermissions(rules, "tool.mcp_list", "x").effect).toBe("allow");
  expect(evaluatePermissions(rules, "tool.mcp_call", "x").effect).toBe("deny");
});

test("applyModeRules appends mode rules AFTER the base set — the append order IS the enforcement (FW2-G)", () => {
  // evaluatePermissions is last-match-wins: if the mode rules came FIRST, a
  // yolo/user allow-all base would win every evaluation and plan mode would be
  // decoration. Pin the physical order, then the outcome that order buys.
  const yolo: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];
  const rules = applyModeRules("plan", yolo, ["vouched"]);
  expect(rules.slice(0, yolo.length)).toEqual(yolo);                 // base first
  expect(rules.slice(yolo.length)).toEqual(planModeRules(["vouched"])); // mode rules appended last
  expect(evaluatePermissions(rules, "file.write", "x").effect).toBe("deny"); // …so denies beat allow-all
  expect(evaluatePermissions(rules, "shell.exec", "x").effect).toBe("deny");
  expect(evaluatePermissions(rules, "tool.vouched", "x").effect).toBe("allow"); // vouched re-allow stays last
});

// ---------- enforcement flows through the ONE dispatch pipeline ----------

function tool(name: string, kind: Tool["kind"], onRun: () => void): Tool {
  return {
    schema: { name, description: `${name} test tool`, args: { type: "object" } },
    kind,
    async execute() { onRun(); return { ok: true, output: `${name} ran` }; },
  };
}

function ctx(): ToolContext {
  return { sessionId: "s", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } };
}

test("dispatch under plan rules: write/exec blocked unexecuted, read executes", async () => {
  const reg = new ToolRegistry();
  let writes = 0, execs = 0, reads = 0;
  reg.register(
    tool("w", "write", () => writes++),
    tool("x", "execute", () => execs++),
    tool("r", "read", () => reads++),
  );
  const rules = applyModeRules("plan", [{ action: "*", resource: "*", effect: "allow" }]);
  const events: RunEvent[] = [];
  const calls = [
    { kind: "tool_call" as const, id: "c1", tool: "w", args: { path: "a.txt" } },
    { kind: "tool_call" as const, id: "c2", tool: "x", args: { command: "echo hi" } },
    { kind: "tool_call" as const, id: "c3", tool: "r", args: { path: "a.txt" } },
  ];
  const results = await reg.dispatchBatch(calls, ctx(), undefined, rules, undefined, (e) => events.push(e), false);
  expect(writes).toBe(0);
  expect(execs).toBe(0);
  expect(reads).toBe(1);
  expect(results.get("c1")?.ok).toBe(false);
  expect(results.get("c1")?.output).toContain("Permission denied");
  expect(results.get("c2")?.ok).toBe(false);
  expect(results.get("c3")?.ok).toBe(true);
  const denied = events.filter((e) => e.type === "tool_call_failed" && e.reason === "permission_denied");
  expect(denied.length).toBe(2);
});

// ---------- per-mode model resolution precedence ----------

test("config per-mode entry beats fallback; missing fields merge from fallback", () => {
  const m = new ModeManager(
    { planActSeparateModels: true, plan: { model: "o1" } },
    { provider: "anthropic", model: "sonnet" },
  );
  expect(m.modelFor("plan")).toEqual({ provider: "anthropic", model: "o1" });
  expect(m.modelFor("act")).toEqual({ provider: "anthropic", model: "sonnet" });
});

test("runtime setModel beats the config seed for that mode's slot", () => {
  const m = new ModeManager(
    { defaultMode: "plan", planActSeparateModels: true, plan: { model: "o1" } },
    { provider: "p", model: "base" },
  );
  m.setModel({ model: "o3" }); // current mode is plan
  expect(m.modelFor("plan").model).toBe("o3");
  expect(m.modelFor("act").model).toBe("base");
});

test("separate models ON: setModel writes only the current mode's slot", () => {
  const m = new ModeManager({ planActSeparateModels: true }, { provider: "p", model: "shared" });
  expect(m.mode).toBe("act");
  m.setModel({ model: "act-model" });
  expect(m.modelFor("act").model).toBe("act-model");
  expect(m.modelFor("plan").model).toBe("shared"); // untouched
});

test("separate models OFF (default): setModel mirrors into both slots", () => {
  const m = new ModeManager({}, { provider: "p", model: "shared" });
  expect(m.separate).toBe(false); // upstream default (state-keys.ts:272)
  m.setModel({ model: "gpt" });
  expect(m.modelFor("act").model).toBe("gpt");
  expect(m.modelFor("plan").model).toBe("gpt");
  m.toggle("plan");
  m.setModel({ provider: "q" });
  expect(m.modelFor("act")).toEqual({ provider: "q", model: "gpt" });
});

test("defaults: mode act, empty slots resolve to fallback then empty string", () => {
  expect(DEFAULT_MODE).toBe("act");
  const m = new ModeManager();
  expect(m.mode).toBe("act");
  expect(m.modelFor()).toEqual({ provider: "", model: "" });
  const withCfgDefault = new ModeManager({ defaultMode: "plan" });
  expect(withCfgDefault.mode).toBe("plan");
});

// ---------- toggle round-trip + notice semantics ----------

test("toggle to the current mode is a no-op returning null", () => {
  const m = new ModeManager();
  expect(m.toggle("act")).toBeNull();
  expect(m.mode).toBe("act");
  expect(m.consumeSwitchNotice()).toBeNull();
});

test("toggle round-trip: act→plan→act restores mode and cancels the notice", () => {
  const m = new ModeManager();
  expect(m.toggle("plan")).toEqual({ from: "act", to: "plan" });
  expect(m.mode).toBe("plan");
  expect(m.toggle("act")).toEqual({ from: "plan", to: "act" });
  expect(m.mode).toBe("act");
  // the mode the model last saw never changed → no notice (format.ts:64-73)
  expect(m.consumeSwitchNotice()).toBeNull();
});

test("single switch yields exactly one notice, cleared on consume", () => {
  const m = new ModeManager();
  m.toggle("plan");
  expect(m.consumeSwitchNotice()).toEqual({ from: "act", to: "plan" });
  expect(m.consumeSwitchNotice()).toBeNull();
});

test("restore() sets the mode without leaking a notice across sessions", () => {
  const m = new ModeManager();
  m.toggle("plan"); // pending notice from the old session's life
  m.restore("act");
  expect(m.mode).toBe("act");
  expect(m.consumeSwitchNotice()).toBeNull();
});

test("tracker collapses chained switches to net effect (from stays first)", () => {
  const t = createModeSwitchNoticeTracker();
  t.record("act", "plan");
  t.record("plan", "act");
  expect(t.consume()).toBeNull(); // round trip cancels
  t.record("plan", "act");
  t.record("act", "plan"); // cancels again
  t.record("plan", "act");
  expect(t.consume()).toEqual({ from: "plan", to: "act" });
});

// ---------- durable session entries ----------

function userMsg(text: string, parentId: string | null): Message {
  return { id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() };
}

test("mode switches persist as session entries and survive a reload; last wins", () => {
  const root = tmpCwd();
  const store = new SessionStore(root, "sess-modes");
  const u1 = userMsg("hello", null);
  store.append(u1);
  const e1 = buildModeChangeEntry({ from: "act", to: "plan" }, u1.id);
  store.append(e1);
  const u2 = userMsg("plan please", e1.id);
  store.append(u2);
  store.append(buildModeChangeEntry({ from: "plan", to: "act" }, u2.id));

  expect(modeFromEntries(store.messages())).toBe("act"); // last switch wins

  // fresh store on the same dir = restart: entries reload from JSONL
  const reloaded = new SessionStore(root, "sess-modes");
  const msgs = reloaded.messages();
  expect(modeFromEntries(msgs)).toBe("act");
  const noticeTexts = msgs
    .filter((m) => m.role === "system")
    .map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
  expect(noticeTexts).toContain(formatModeSwitchNotice("act", "plan"));
  expect(noticeTexts).toContain(formatModeSwitchNotice("plan", "act"));
  rmSync(root, { recursive: true, force: true });
});

test("modeFromEntries ignores plain system messages and junk modeSwitch fields", () => {
  const plain: Message = { id: "a", role: "system", parts: [{ kind: "text", text: "summary" }], parentId: null, createdAt: 1 };
  const junk = { ...plain, id: "b", modeSwitch: { from: "turbo", to: "plan" } };
  expect(modeFromEntries([plain, junk])).toBeNull();
  expect(modeFromEntries([])).toBeNull();
  const real = buildModeChangeEntry({ from: "act", to: "plan" }, "a");
  expect(modeFromEntries([plain, junk, real])).toBe("plan");
});

test("modeSwitchOf extracts the switch from real entries, null for notes/junk (replay seam)", () => {
  expect(modeSwitchOf(buildModeChangeEntry({ from: "plan", to: "act" }, null))).toEqual({ from: "plan", to: "act" });
  const plain: Message = { id: "a", role: "system", parts: [{ kind: "text", text: "note" }], parentId: null, createdAt: 1 };
  expect(modeSwitchOf(plain)).toBeNull();
  expect(modeSwitchOf({ ...plain, modeSwitch: { from: "turbo", to: "act" } })).toBeNull(); // junk mode
  expect(modeSwitchOf({ ...plain, role: "user", modeSwitch: { from: "act", to: "plan" } })).toBeNull(); // wrong role
  expect(modeSwitchOf(null)).toBeNull();
});

// ---------- config file loading ----------

test("loadModesConfig parses .rovecode/modes.json and validates fields", () => {
  const cwd = tmpCwd();
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "modes.json"), JSON.stringify({
    defaultMode: "plan",
    planActSeparateModels: true,
    plan: { model: "o1", provider: "openai" },
    act: { model: "sonnet" },
  }));
  expect(loadModesConfig(cwd)).toEqual({
    defaultMode: "plan",
    planActSeparateModels: true,
    plan: { model: "o1", provider: "openai" },
    act: { model: "sonnet", provider: undefined },
  });
  rmSync(cwd, { recursive: true, force: true });
});

test("loadModesConfig degrades junk to defaults, never throws", () => {
  const missing = tmpCwd();
  expect(loadModesConfig(missing)).toEqual({}); // no file

  const cwd = tmpCwd();
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "modes.json"), "{not json");
  expect(loadModesConfig(cwd)).toEqual({}); // malformed

  writeFileSync(join(cwd, ".rovecode", "modes.json"), JSON.stringify({
    defaultMode: "turbo",              // invalid mode
    planActSeparateModels: "yes",      // wrong type
    plan: { model: 42 },               // wrong type → dropped selection
    act: "sonnet",                     // wrong shape
  }));
  expect(loadModesConfig(cwd)).toEqual({});

  // config feeds the manager end to end
  writeFileSync(join(cwd, ".rovecode", "modes.json"), JSON.stringify({
    defaultMode: "plan", planActSeparateModels: true, plan: { model: "o1" },
  }));
  const m = new ModeManager(loadModesConfig(cwd), { provider: "anthropic", model: "sonnet" });
  expect(m.mode).toBe("plan");
  expect(m.modelFor()).toEqual({ provider: "anthropic", model: "o1" });
  rmSync(missing, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// ---------- prompt section sanity (used by TUI wiring) ----------

test("plan prompt section states the no-self-switch contract", () => {
  const p = planModePromptSection();
  expect(p).toContain("Plan mode");
  expect(p).toContain("toggle to Act mode");
  expect(p).toContain("do NOT have the ability to switch");
});
