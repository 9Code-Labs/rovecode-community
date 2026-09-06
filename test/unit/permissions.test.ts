import { test, expect } from "bun:test";
import { evaluatePermissions, ToolRegistry } from "../../src/core/tools.ts";
import { applyModeRules } from "../../src/core/modes.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ApprovalRequest, PermissionRule, Tool } from "../../src/core/types.ts";

// Ordered most-general first: last match wins (opencode permission.ts:126 semantics).
const rules: PermissionRule[] = [
  { action: "file.read", resource: "*", effect: "allow" },
  { action: "shell.exec", resource: "*", effect: "prompt" },
  { action: "file.write", resource: "src/**", effect: "allow" },
  { action: "shell.exec", resource: "rm *", effect: "deny" },
  { action: "file.write", resource: ".env*", effect: "deny" },
];

test("deny by default when no rule matches", () => {
  const d = evaluatePermissions(rules, "spawn", "*");
  expect(d.effect).toBe("deny");
});

test("last match wins: rm denied after generic prompt", () => {
  const d = evaluatePermissions(rules, "shell.exec", "rm -rf /");
  expect(d.effect).toBe("deny");
});

test("generic exec prompts", () => {
  const d = evaluatePermissions(rules, "shell.exec", "ls -la");
  expect(d.effect).toBe("prompt");
});

test("glob allow for src writes; deny for dotenv", () => {
  expect(evaluatePermissions(rules, "file.write", "src/app.ts").effect).toBe("allow");
  expect(evaluatePermissions(rules, "file.write", ".env.local").effect).toBe("deny");
});

test("read allowed everywhere", () => {
  expect(evaluatePermissions(rules, "file.read", "any/path/x").effect).toBe("allow");
});

// ---------- the middle tier: accept-edits ----------

test("accept-edits allows writes INSIDE the workspace and nothing else — shell, spawn, network and outside writes still prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-perm-"));
  const s = sep;
  const rt = createRuntime({ cwd });
  const rules = rt.buildCfg("accept-edits").permissionRules;
  const at = (action: string, resource: string) => evaluatePermissions(rules, action, resource).effect;

  expect(at("file.write", `${cwd}${s}src${s}a.ts`)).toBe("allow");     // the whole point
  expect(at("file.write", `${cwd}${s}deep${s}x${s}y.json`)).toBe("allow");
  // a sibling whose name merely STARTS with the cwd is not inside it — the separator is in the glob
  expect(at("file.write", `${cwd}-backup${s}a.ts`)).toBe("prompt");
  expect(at("file.write", process.platform === "win32" ? "C:\Users\me\.ssh\id_rsa" : "/home/me/.ssh/id_rsa")).toBe("prompt");
  // the tiers this does NOT move
  expect(at("shell.exec", "rm -rf /")).toBe("prompt");
  expect(at("spawn", "task")).toBe("prompt");
  expect(at("net.fetch", "example.com")).toBe("prompt");
  expect(at("tool.provider_edit", "provider_edit")).toBe("prompt");
  rmSync(cwd, { recursive: true, force: true });
});

test("the three tiers are ordered: ask prompts every write, accept-edits allows the inside ones, auto allows everything", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-perm-"));
  const s = sep;
  const rt = createRuntime({ cwd });
  const inside = `${cwd}${s}a.ts`;
  const eff = (level: Parameters<typeof rt.buildCfg>[0], action: string, resource: string) =>
    evaluatePermissions(rt.buildCfg(level).permissionRules, action, resource).effect;

  expect(eff("ask", "file.write", inside)).toBe("prompt");
  expect(eff("accept-edits", "file.write", inside)).toBe("allow");
  expect(eff("auto", "file.write", inside)).toBe("allow");
  expect(eff("ask", "shell.exec", "ls")).toBe("prompt");
  expect(eff("accept-edits", "shell.exec", "ls")).toBe("prompt");
  expect(eff("auto", "shell.exec", "ls")).toBe("allow");
  // the booleans every existing caller passes still mean what they meant
  expect(eff(false, "file.write", inside)).toBe("prompt");
  expect(eff(true, "shell.exec", "ls")).toBe("allow");
  // only auto drops the approver; accept-edits still has one for the calls that DO ask
  expect(rt.buildCfg("auto").approval).toBeUndefined();
  expect(rt.buildCfg("accept-edits").approval).toBeDefined();
  rmSync(cwd, { recursive: true, force: true });
});

test("plan mode outranks accept-edits: the tier only ever moves the PROMPT branch, never a deny", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-perm-"));
  const rt = createRuntime({ cwd });
  const inside = `${cwd}${sep}a.ts`;
  // the ordering that makes this true: evaluatePermissions is LAST-match-wins, buildCfg's base set
  // contains no deny at all, and applyModeRules APPENDS plan's read-only denies after it. So the
  // accept-edits allow can never sit after a deny and revive it. (nimbus-3c found the mirror of this
  // bug in the gauntlet fixtures, where a deny written FIRST was dead.)
  for (const level of ["ask", "accept-edits", "auto"] as const) {
    const base = rt.buildCfg(level).permissionRules;
    const planned = applyModeRules("plan", base);
    expect(evaluatePermissions(planned, "file.write", inside).effect, level).toBe("deny");
    expect(evaluatePermissions(planned, "shell.exec", "ls", ).effect, level).toBe("deny");
    expect(evaluatePermissions(planned, "file.read", inside).effect, level).toBe("allow"); // plan still reads
    // and act mode leaves the tier exactly as it was
    expect(evaluatePermissions(applyModeRules("act", base), "file.write", inside).effect, level)
      .toBe(level === "ask" ? "prompt" : "allow");
  }
  rmSync(cwd, { recursive: true, force: true });
});

test("the accept-edits rule is appended AFTER the file.write prompt rule — order is the whole mechanism", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-perm-"));
  const rules = createRuntime({ cwd }).buildCfg("accept-edits").permissionRules;
  const promptIdx = rules.findIndex((r) => r.action === "file.write" && r.resource === "*" && r.effect === "prompt");
  const allowIdx = rules.findIndex((r) => r.action === "file.write" && r.effect === "allow");
  expect(promptIdx).toBeGreaterThanOrEqual(0);
  expect(allowIdx).toBeGreaterThan(promptIdx); // swap them and accept-edits silently stops working
  expect(rules.some((r) => r.effect === "deny")).toBe(false); // no deny to accidentally outrank
  rmSync(cwd, { recursive: true, force: true });
});

// ---------- Tool.resource: a tool that tells the policy WHICH mode this call is ----------

/** A tool whose modes differ in what they may do cannot say so through a path, a command or a URL, so
 *  the policy resource used to fall back to the tool NAME and one rule had to cover every mode. That is
 *  how a read-only `design_direction {"action":"get"}` came to raise an approval card. */
test("a tool's own resource() decides the policy resource; without one the tool NAME is still the fallback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-perm-"));
  const asked: string[] = [];
  const reg = new ToolRegistry();
  const shape = { type: "object" as const, properties: { action: { type: "string" } } };
  const modal: Tool = {
    schema: { name: "modal", description: "", args: shape },
    kind: "custom",
    resource: (args) => ((args as { action?: string } | undefined)?.action === "get" ? "get" : "set"),
    async execute() { return { ok: true, output: "ran" }; },
  };
  const plain: Tool = {
    schema: { name: "plain", description: "", args: shape },
    kind: "custom",
    async execute() { return { ok: true, output: "ran" }; },
  };
  reg.register(modal, plain);
  const rules: PermissionRule[] = [
    { action: "tool.modal", resource: "*", effect: "prompt" },
    { action: "tool.modal", resource: "get", effect: "allow" },
    { action: "tool.plain", resource: "*", effect: "prompt" },
  ];
  const ctx = { sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } } as never;
  const approve = async (req: ApprovalRequest): Promise<"once"> => { asked.push(req.reason); return "once"; };
  const call = (id: string, tool: string, args: unknown) =>
    reg.dispatch({ kind: "tool_call", id, tool, args } as never, ctx, undefined, rules, approve, () => {});

  const got = await call("1", "modal", { action: "get" });
  expect(got.ok).toBe(true);
  expect(asked).toEqual([]);                                   // the allow rule matched: nobody was asked

  await call("2", "modal", { action: "set", name: "x" });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("set");                            // and the human is asked about the MODE
  expect(asked[0]).not.toContain("modal get");

  await call("3", "plain", { action: "get" });                  // no resource() → unchanged: the tool name
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain("plain");
  rmSync(cwd, { recursive: true, force: true });
});

test("design_direction: `get` is allowed and `set` prompts, at every tier below auto", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-perm-"));
  const rt = createRuntime({ cwd });
  for (const level of ["ask", "accept-edits"] as const) {
    const rules = rt.buildCfg(level).permissionRules;
    // reading the project's own record costs nothing: it writes nothing, and a card here would train
    // the human to allow the card that matters
    expect(evaluatePermissions(rules, "tool.design_direction", "get").effect).toBe("allow");
    // recording the project's design identity IS the one card worth spending
    expect(evaluatePermissions(rules, "tool.design_direction", "set").effect).toBe("prompt");
    // an unknown mode is treated as the write, never as the safer of the two
    expect(evaluatePermissions(rules, "tool.design_direction", "whatever").effect).toBe("prompt");
    // design_audit is kind read and never prompts
    expect(evaluatePermissions(rules, "file.read", "design_audit").effect).toBe("allow");
  }
  // plan mode still denies the write: the seam turns a prompt into an allow, never a deny into one
  const planned = applyModeRules("plan", rt.buildCfg("ask").permissionRules);
  expect(evaluatePermissions(planned, "tool.design_direction", "set").effect).toBe("deny");
  rmSync(cwd, { recursive: true, force: true });
});
