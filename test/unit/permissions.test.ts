import { test, expect } from "bun:test";
import { evaluatePermissions } from "../../src/core/tools.ts";
import type { PermissionRule } from "../../src/core/types.ts";

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
