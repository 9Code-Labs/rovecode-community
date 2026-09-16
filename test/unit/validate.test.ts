/** core/validate.ts — the ADR-005 "validate" step that nothing used to do. Tools cast their args
 *  (`args as { path: string; content: string }`), so a wrong type reached Node and came back as
 *  `The "data" argument must be of type string…` — a message that names no tool, no property and no
 *  fix. These pin the shape of the replacement: what is rejected, what is deliberately allowed
 *  through, and that the text tells a model exactly what to send next time. */

import { test, expect } from "bun:test";
import { formatIssues, jsonTypeOf, validateArgs } from "../../src/core/validate.ts";
import { writeTool, editTool } from "../../src/coding/hashline.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { RunEvent } from "../../src/core/types.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OBJ = { type: "object", properties: { path: { type: "string" }, n: { type: "number" } }, required: ["path"] };

test("jsonTypeOf speaks the schema's words, integer included", () => {
  expect([null, [], {}, 1, 1.5, "s", true].map(jsonTypeOf)).toEqual(["null", "array", "object", "integer", "number", "string", "boolean"]);
});

test("a good call has nothing to say", () => {
  expect(validateArgs(OBJ, { path: "a.ts", n: 2 })).toEqual([]);
  expect(validateArgs(OBJ, { path: "a.ts" })).toEqual([]);          // an optional key may be absent
});

test("the wrong type is named with what was expected and what arrived", () => {
  expect(validateArgs(OBJ, { path: { a: 1 } })).toEqual([{ path: "path", message: "expected string, got object" }]);
  expect(validateArgs(OBJ, { path: "a", n: "2" })).toEqual([{ path: "n", message: "expected number, got string" }]);
  expect(validateArgs(OBJ, [])).toEqual([{ path: "", message: "expected object, got array" }]);
});

test("a missing required property is named — and present-but-undefined counts as missing", () => {
  expect(validateArgs(OBJ, {})).toEqual([{ path: "path", message: "is required but was not provided" }]);
  expect(validateArgs(OBJ, { path: undefined })).toEqual([{ path: "path", message: "is required but was not provided" }]);
});

test("integer vs number, and a type union", () => {
  expect(validateArgs({ type: "integer" }, 1.5)).toEqual([{ path: "", message: "expected integer, got number" }]);
  expect(validateArgs({ type: "number" }, 1)).toEqual([]);           // an integer IS a number
  expect(validateArgs({ type: ["string", "null"] }, null)).toEqual([]);
  expect(validateArgs({ type: ["string", "null"] }, 5)).toEqual([{ path: "", message: "expected string or null, got integer" }]);
});

test("enum values are checked, and array items are checked per element with their index", () => {
  expect(validateArgs({ enum: ["a", "b"] }, "c")).toEqual([{ path: "", message: 'expected one of "a" | "b", got "c"' }]);
  const arr = { type: "array", items: { type: "object", properties: { status: { enum: ["pending", "done"] } }, required: ["status"] } };
  expect(validateArgs(arr, [{ status: "pending" }, { status: "nope" }, {}])).toEqual([
    { path: "1.status", message: 'expected one of "pending" | "done", got "nope"' },
    { path: "2.status", message: "is required but was not provided" },
  ]);
});

test("what it deliberately does NOT reject: unknown properties, unknown keywords, a typeless schema", () => {
  expect(validateArgs(OBJ, { path: "a", extra: 1 })).toEqual([]);                    // providers decorate calls
  expect(validateArgs({ type: "string", pattern: "^x", minLength: 9 }, "a")).toEqual([]); // keywords we do not implement
  expect(validateArgs({}, { anything: true })).toEqual([]);
  expect(validateArgs(undefined, { anything: true })).toEqual([]);                   // a tool with no schema is not blocked
});

test("a schema that only lists properties still validates as an object", () => {
  expect(validateArgs({ properties: { a: { type: "string" } }, required: ["a"] }, {})).toEqual([{ path: "a", message: "is required but was not provided" }]);
});

test("formatIssues names the tool and bounds the list", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `todos.${i}.status`, message: "expected string, got integer" }));
  const line = formatIssues("todo_write", many);
  expect(line).toStartWith("Invalid arguments for todo_write: ");
  expect(line).toContain("todos.0.status expected string, got integer");
  expect(line).toContain("(+4 more)");                                // 5 shown of 9
  expect(line.split(";")).toHaveLength(5);
  expect(formatIssues("write", [{ path: "", message: "expected object, got string" }])).toBe("Invalid arguments for write: expected object, got string");
});

// ---------- the bug this was written for ----------

test("write with a non-string content is refused BEFORE node sees it, naming the property", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-validate-"));
  try {
    const reg = new ToolRegistry();
    reg.register(writeTool);
    const events: RunEvent[] = [];
    const ctx = { sessionId: "s", cwd, signal: new AbortController().signal } as never;
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }];

    // the exact shape from the user's screenshot: the model sent an object where a string belongs
    const bad = await reg.dispatch({ kind: "tool_call", id: "w1", tool: "write", args: { path: join(cwd, "index.html"), content: { html: "<p>hi</p>" } } },
      ctx, undefined, rules, undefined, (e) => events.push(e));
    expect(bad.ok).toBe(false);
    expect(bad.output).toBe("Invalid arguments for write: content expected string, got object");
    expect(bad.output).not.toContain("TypedArray");            // never Node's internal message again
    expect(events.at(-1)).toMatchObject({ type: "tool_call_failed", reason: "invalid_args" });
    expect(existsSync(join(cwd, "index.html"))).toBe(false);   // and nothing was written

    // the corrected call still works: validation is a gate, not a wall
    const good = await reg.dispatch({ kind: "tool_call", id: "w2", tool: "write", args: { path: join(cwd, "index.html"), content: "<p>hi</p>" } },
      ctx, undefined, rules, undefined, () => {});
    expect(good.ok).toBe(true);
    expect(readFileSync(join(cwd, "index.html"), "utf8")).toBe("<p>hi</p>");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("edit with a malformed ops array is refused per element, and the file is untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-validate-edit-"));
  try {
    const file = join(cwd, "a.ts");
    writeFileSync(file, "one\ntwo\n");
    const reg = new ToolRegistry();
    reg.register(editTool);
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }];
    const ctx = { sessionId: "s", cwd, signal: new AbortController().signal } as never;
    const r = await reg.dispatch({ kind: "tool_call", id: "e1", tool: "edit", args: { path: file, tag: "x", edits: "not-an-array" } },
      ctx, undefined, rules, undefined, () => {});
    expect(r.ok).toBe(false);
    expect(r.output).toContain("edits expected array, got string");
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
