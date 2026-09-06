/** Port #32 todo tool: CRUD through a real ToolRegistry (round-trip, replace
 *  semantics, clear), validation (each failure precise AND leaves the file
 *  byte-identical), persistence (second instance / session isolation / corrupt
 *  file → empty + note / atomic tmp+rename), policy (auto-runs under the
 *  runtime's default gated rules with NO approver; plan mode ALLOWS the todo
 *  write by name while every other write class stays denied), registry pins,
 *  accept-side bounds, and the renderTodos golden. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planReminder,
  todoTools, todoWriteTool, todoReadTool, loadTodos, saveTodos, renderTodos, validateTodos,
  todoStatusLabel, todoCounts, MAX_TODOS, MAX_ID_CHARS, MAX_CONTENT_CHARS, TODOS_FILE, type TodoItem,
} from "../../src/tools/todo.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import { applyModeRules } from "../../src/core/modes.ts";
import type { ToolContext, ToolCallPart, ToolOutput, PermissionRule } from "../../src/core/types.ts";

// ---------- fixtures ----------

const ALLOW_ALL: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];

const ctx = (sessionId = "sess-a", cwd = process.cwd()): ToolContext => ({
  sessionId, cwd, signal: new AbortController().signal, permissions: { effect: "allow" as const },
});

let seq = 0;
const call = (tool: string, args: unknown): ToolCallPart => ({ kind: "tool_call", id: `c${++seq}`, tool, args });

/** Real registry over a fresh sessions root; `run` dispatches with allow-all rules and NO approver. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "rovecode-todo-"));
  const registry = new ToolRegistry();
  registry.register(...todoTools(root));
  const run = (tool: string, args: unknown, sessionId = "sess-a"): Promise<ToolOutput> =>
    registry.dispatch(call(tool, args), ctx(sessionId), undefined, ALLOW_ALL, undefined, () => {});
  const file = (sessionId = "sess-a") => join(root, sessionId, TODOS_FILE);
  return { root, registry, run, file, done: () => rmSync(root, { recursive: true, force: true }) };
}

const items = (): TodoItem[] => [
  { id: "t1", content: "write tests", status: "completed" },
  { id: "t2", content: "implement tool", status: "in_progress", priority: "high" },
  { id: "t3", content: "update notes", status: "pending", priority: "low" },
];

const dataItems = (out: ToolOutput): TodoItem[] => (out.data as { items: TodoItem[] }).items;

// ---------- CRUD via dispatch ----------

test("todo_write → todo_read round-trip: checkbox output, data.items, file at <root>/<sessionId>/todos.json", async () => {
  const h = harness();
  try {
    const w = await h.run("todo_write", { todos: items() });
    expect(w.ok).toBe(true);
    expect(w.output).toBe(renderTodos(items()));
    expect(dataItems(w)).toEqual(items());
    expect(existsSync(h.file())).toBe(true);

    const r = await h.run("todo_read", {});
    expect(r.ok).toBe(true);
    expect(r.output).toBe(renderTodos(items()));
    expect(dataItems(r)).toEqual(items());
    // on-disk shape is the versioned envelope, pretty-printed
    const disk = JSON.parse(readFileSync(h.file(), "utf8")) as { version: number; items: TodoItem[] };
    expect(disk.version).toBe(1);
    expect(disk.items).toEqual(items());
  } finally { h.done(); }
});

test("replace semantics: a second todo_write drops every item not re-sent (opencode delete-all + insert)", async () => {
  const h = harness();
  try {
    expect((await h.run("todo_write", { todos: items() })).ok).toBe(true);
    const next: TodoItem[] = [{ id: "t2", content: "implement tool", status: "completed" }, { id: "t9", content: "ship", status: "in_progress" }];
    const w = await h.run("todo_write", { todos: next });
    expect(w.ok).toBe(true);
    const r = await h.run("todo_read", {});
    expect(dataItems(r)).toEqual(next);       // t1/t3 gone, t9 new, order = list order
    expect(r.output).not.toContain("t1");
    expect(r.output).toContain("[>] t9: ship");
  } finally { h.done(); }
});

test("clear: writing [] empties the list with gemini's wording; todo_read then guides the model", async () => {
  const h = harness();
  try {
    expect((await h.run("todo_write", { todos: items() })).ok).toBe(true);
    const w = await h.run("todo_write", { todos: [] });
    expect(w.ok).toBe(true);
    expect(w.output).toBe("Cleared todo list.");
    expect(dataItems(w)).toEqual([]);
    expect(loadTodos(join(h.root, "sess-a"))).toEqual({ items: [] });
    const r = await h.run("todo_read", {});
    expect(r.ok).toBe(true);
    expect(r.output).toBe("No todos for this session yet — use todo_write to create a list.");
    expect(dataItems(r)).toEqual([]);
  } finally { h.done(); }
});

test("todo_read on a fresh session: empty message, ok:true, and NO file or session dir is created (pure read)", async () => {
  const h = harness();
  try {
    const r = await h.run("todo_read", {}, "never-written");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("No todos for this session yet — use todo_write to create a list.");
    expect(existsSync(join(h.root, "never-written"))).toBe(false);
  } finally { h.done(); }
});

// ---------- validation: precise messages, nothing written ----------

/** Two layers reject a bad list and they divide cleanly (core/validate.ts, added after the write-tool
 *  crash): the SCHEMA owns structure — wrong type, missing required key, a value outside a declared
 *  enum — and dispatch refuses those before the tool runs; the TOOL owns meaning — emptiness, lengths,
 *  duplicate ids, one in_progress, the item cap — which no JSON Schema expresses. `schema: true` marks
 *  the cases the first layer now answers, so this test pins the BOUNDARY, not just the rejection. */
const BAD: { name: string; todos: unknown; msg: string; schema?: true }[] = [
  { name: "empty content", todos: [{ id: "a", content: "", status: "pending" }], msg: 'todos[0] ("a"): content must be a non-empty string' },
  { name: "whitespace-only content", todos: [{ id: "a", content: "  \n ", status: "pending" }], msg: 'todos[0] ("a"): content must be a non-empty string' },
  { name: "content too long", todos: [{ id: "a", content: "x".repeat(MAX_CONTENT_CHARS + 1), status: "pending" }], msg: `todos[0] ("a"): content exceeds ${MAX_CONTENT_CHARS} chars` },
  { name: "duplicate ids", todos: [{ id: "a", content: "one", status: "pending" }, { id: "a", content: "two", status: "pending" }], msg: 'duplicate id "a" at todos[1] — ids must be unique' },
  { name: "duplicate ids after trim", todos: [{ id: "a", content: "one", status: "pending" }, { id: " a ", content: "two", status: "pending" }], msg: 'duplicate id "a" at todos[1]' },
  { name: "two in_progress", todos: [{ id: "a", content: "one", status: "in_progress" }, { id: "b", content: "two", status: "pending" }, { id: "c", content: "three", status: "in_progress" }], msg: "only one todo may be in_progress at a time (found 2: a, c)" },
  { name: "too many items", todos: Array.from({ length: MAX_TODOS + 1 }, (_, i) => ({ id: `t${i}`, content: `step ${i}`, status: "pending" })), msg: `too many todos: ${MAX_TODOS + 1} (max ${MAX_TODOS})` },
  { name: "bad status", todos: [{ id: "a", content: "one", status: "done" }], schema: true, msg: 'todos.0.status expected one of "pending" | "in_progress" | "completed", got "done"' },
  { name: "cancelled is not a status here", todos: [{ id: "a", content: "one", status: "cancelled" }], schema: true, msg: 'todos.0.status expected one of "pending" | "in_progress" | "completed", got "cancelled"' },
  { name: "bad priority", todos: [{ id: "a", content: "one", status: "pending", priority: "urgent" }], schema: true, msg: 'todos.0.priority expected one of "high" | "medium" | "low", got "urgent"' },
  { name: "missing id", todos: [{ content: "one", status: "pending" }], schema: true, msg: "todos.0.id is required but was not provided" },
  { name: "id too long", todos: [{ id: "i".repeat(MAX_ID_CHARS + 1), content: "one", status: "pending" }], msg: `todos[0].id exceeds ${MAX_ID_CHARS} chars` },
  { name: "item not an object", todos: ["write tests"], schema: true, msg: "todos.0 expected object, got string" },
  { name: "todos not an array", todos: { id: "a" }, schema: true, msg: "todos expected array, got object" },
  { name: "todos missing", todos: undefined, schema: true, msg: "todos is required but was not provided" },
];

test("validation: every invalid list is rejected with a precise message and the file stays byte-identical", async () => {
  const h = harness();
  try {
    expect((await h.run("todo_write", { todos: items() })).ok).toBe(true);
    const before = readFileSync(h.file(), "utf8");
    for (const c of BAD) {
      const out = await h.run("todo_write", { todos: c.todos });
      expect(out.ok, c.name).toBe(false);
      expect(out.output, c.name).toStartWith(c.schema ? "Invalid arguments for todo_write: " : "todo_write failed: ");
      expect(out.output, c.name).toContain(c.msg);
      // the tool's own refusal promises the list survived; the schema layer never reached the store
      if (!c.schema) expect(out.output, c.name).toContain("the list was not changed");
      expect(readFileSync(h.file(), "utf8"), c.name).toBe(before);
    }
    // the surviving list is still the original
    expect(dataItems(await h.run("todo_read", {}))).toEqual(items());
  } finally { h.done(); }
});

test("validation: a first write that fails creates nothing (no session dir, no tmp)", async () => {
  const h = harness();
  try {
    const out = await h.run("todo_write", { todos: [{ id: "a", content: "", status: "pending" }] }, "sess-new");
    expect(out.ok).toBe(false);
    expect(existsSync(join(h.root, "sess-new"))).toBe(false);
  } finally { h.done(); }
});

test("validateTodos normalizes: trims id/content, drops unknown keys, omits absent priority; exactly one in_progress is fine", () => {
  const v = validateTodos([
    { id: " a ", content: "  do it  ", status: "in_progress", priority: "medium", extra: 1 },
    { id: "b", content: "next", status: "pending", priority: null },
  ]);
  expect(v.ok).toBe(true);
  if (!v.ok) throw new Error(v.error);
  expect(v.items).toEqual([{ id: "a", content: "do it", status: "in_progress", priority: "medium" }, { id: "b", content: "next", status: "pending" }]);
  expect("extra" in v.items[0]!).toBe(false);
  expect("priority" in v.items[1]!).toBe(false);
  expect(validateTodos([]).ok).toBe(true);
  // bounded echo of a rejected value: a huge status string must not reflect back whole
  const huge = validateTodos([{ id: "a", content: "x", status: "s".repeat(10_000) }]);
  expect(huge.ok).toBe(false);
  if (!huge.ok) expect(huge.error.length).toBeLessThan(200);
});

// ---------- persistence ----------

test("persistence: a second tool instance over the same sessions root reads the list the first one wrote", async () => {
  const h = harness();
  try {
    expect((await h.run("todo_write", { todos: items() })).ok).toBe(true);
    const other = new ToolRegistry();
    other.register(todoReadTool(h.root), todoWriteTool(h.root));
    const r = await other.dispatch(call("todo_read", {}), ctx("sess-a"), undefined, ALLOW_ALL, undefined, () => {});
    expect(r.ok).toBe(true);
    expect(dataItems(r)).toEqual(items());
    // and the exported loader (the TUI /todos path) agrees
    expect(loadTodos(join(h.root, "sess-a"))).toEqual({ items: items() });
  } finally { h.done(); }
});

test("persistence: lists are per session — session B never sees session A's todos", async () => {
  const h = harness();
  try {
    expect((await h.run("todo_write", { todos: items() }, "sess-a")).ok).toBe(true);
    expect((await h.run("todo_write", { todos: [{ id: "b1", content: "other work", status: "pending" }] }, "sess-b")).ok).toBe(true);
    expect(dataItems(await h.run("todo_read", {}, "sess-a"))).toEqual(items());
    expect(dataItems(await h.run("todo_read", {}, "sess-b"))).toEqual([{ id: "b1", content: "other work", status: "pending" }]);
    expect(existsSync(h.file("sess-a"))).toBe(true);
    expect(existsSync(h.file("sess-b"))).toBe(true);
  } finally { h.done(); }
});

test("corrupt todos.json (invalid JSON / wrong shape / schema-invalid) → empty + note, never throws; the next write repairs it", async () => {
  const h = harness();
  try {
    const dir = join(h.root, "sess-a");
    mkdirSync(dir, { recursive: true });
    const cases: [string, string, string][] = [
      ["{not json", "is not valid JSON", "invalid JSON"],
      [JSON.stringify(items()), "has an unexpected shape", "bare array (no envelope)"],
      [JSON.stringify({ version: 2, items: [] }), "has an unexpected shape", "unknown version"],
      [JSON.stringify({ version: 1, items: [{ id: "a", content: "x", status: "in_progress" }, { id: "b", content: "y", status: "in_progress" }] }), "failed validation (only one todo may be in_progress", "two in_progress on disk"],
      [JSON.stringify({ version: 1, items: [{ id: "a", content: "", status: "pending" }] }), "failed validation", "empty content on disk"],
    ];
    for (const [text, note, name] of cases) {
      writeFileSync(join(dir, TODOS_FILE), text);
      const loaded = loadTodos(dir);          // must not throw
      expect(loaded.items, name).toEqual([]);
      expect(loaded.note, name).toContain(TODOS_FILE);
      expect(loaded.note, name).toContain(note);
      expect(loaded.note, name).toContain("treating the list as empty");
      const r = await h.run("todo_read", {});
      expect(r.ok, name).toBe(true);
      expect(r.output, name).toContain(note);
      expect(r.output, name).toContain("No todos for this session yet");
      expect((r.data as { note?: string }).note, name).toContain(note);
    }
    // a directory where the file should be is "unreadable", not a crash
    rmSync(join(dir, TODOS_FILE));
    mkdirSync(join(dir, TODOS_FILE));
    expect(loadTodos(dir).note).toContain("could not be read");
    rmSync(join(dir, TODOS_FILE), { recursive: true });
    // recovery: a valid write replaces the corrupt file outright
    writeFileSync(join(dir, TODOS_FILE), "{not json");
    expect((await h.run("todo_write", { todos: items() })).ok).toBe(true);
    expect(loadTodos(dir)).toEqual({ items: items() });
    // absent file = plain empty, no note
    expect(loadTodos(join(h.root, "nope"))).toEqual({ items: [] });
  } finally { h.done(); }
});

test("atomic write: tmp+rename — no tmp file is ever left behind and the file is valid JSON after every write", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 5; i++) {
      const list: TodoItem[] = Array.from({ length: i + 1 }, (_, k) => ({ id: `t${k}`, content: `step ${k} of round ${i}`, status: "pending" }));
      expect((await h.run("todo_write", { todos: list })).ok).toBe(true);
      expect(readdirSync(join(h.root, "sess-a"))).toEqual([TODOS_FILE]); // no todos.json.tmp (or any other leftover)
      expect(JSON.parse(readFileSync(h.file(), "utf8")).items).toEqual(list);
    }
    // the exported saver used directly behaves the same, creating the dir on demand
    saveTodos(join(h.root, "fresh"), items());
    expect(readdirSync(join(h.root, "fresh"))).toEqual([TODOS_FILE]);
    expect(loadTodos(join(h.root, "fresh"))).toEqual({ items: items() });
  } finally { h.done(); }
});

test("session id must be a plain directory name: traversal / separators are refused and nothing is written", async () => {
  // the sessions root sits INSIDE a private outer dir so an escaping write ("../escape")
  // would land in outer/, not the shared OS tmpdir — the assertion stays hermetic and
  // a failing (mutated) run cannot pollute later runs
  const outer = mkdtempSync(join(tmpdir(), "rovecode-todo-esc-"));
  try {
    const root = join(outer, "sessions");
    mkdirSync(root);
    const registry = new ToolRegistry();
    registry.register(...todoTools(root));
    for (const sid of ["../escape", "..", ".", "a/b", "a\\b", ""]) {
      const w = await registry.dispatch(call("todo_write", { todos: items() }), ctx(sid), undefined, ALLOW_ALL, undefined, () => {});
      expect(w.ok, sid).toBe(false);
      expect(w.output, sid).toContain("invalid session id");
      const r = await registry.dispatch(call("todo_read", {}), ctx(sid), undefined, ALLOW_ALL, undefined, () => {});
      expect(r.ok, sid).toBe(false);
    }
    expect(existsSync(join(outer, "escape", TODOS_FILE))).toBe(false);
    expect(existsSync(join(outer, TODOS_FILE))).toBe(false);      // sid ".." would write to outer/todos.json
    expect(existsSync(join(root, TODOS_FILE))).toBe(false);       // sid "." would write to root/todos.json
    expect(readdirSync(outer)).toEqual(["sessions"]);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

// ---------- policy ----------

test("policy: under the runtime's default gated rules with NO approver, todo_write (kind memory → memory.write allow) and todo_read (kind read → file.read allow) auto-run; deny-default blocks both", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-todo-rt-"));
  try {
    const rt = createRuntime({ cwd, sessionId: "sess-p", stream: null });
    const write = rt.registry.list().find((t) => t.schema.name === "todo_write")!;
    const read = rt.registry.list().find((t) => t.schema.name === "todo_read")!;
    expect(write.kind).toBe("memory");
    expect(read.kind).toBe("read");
    const cfg = rt.buildCfg(false); // headless gated: no approver → a prompt would fail closed
    const events: string[] = [];
    const emit = (e: { type: string }) => { events.push(e.type); };
    const c = ctx("sess-p", cwd);
    const w = await rt.registry.dispatch(call("todo_write", { todos: items() }), c, undefined, cfg.permissionRules, cfg.approval, emit);
    expect(w.ok).toBe(true);
    expect(events).not.toContain("tool_call_failed");
    const r = await rt.registry.dispatch(call("todo_read", {}), c, undefined, cfg.permissionRules, cfg.approval, emit);
    expect(r.ok).toBe(true);
    expect(dataItems(r)).toEqual(items());
    // bound to the runtime's sessions dir
    expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-p", TODOS_FILE))).toBe(true);
    // deny-default: with no rules neither runs
    for (const name of ["todo_write", "todo_read"]) {
      const denied = await rt.registry.dispatch(call(name, name === "todo_write" ? { todos: [] } : {}), c, undefined, [], undefined, () => {});
      expect(denied.ok, name).toBe(false);
      expect(denied.output, name).toContain("Permission denied");
    }
    expect(dataItems(await rt.registry.dispatch(call("todo_read", {}), c, undefined, cfg.permissionRules, cfg.approval, () => {}))).toEqual(items()); // the denied clear never ran
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("policy: plan mode ALLOWS todo_write (the plan's own artifact — modes.ts re-allows `memory.write todo_write` after the memory deny) and todo_read; memory_edit, file.write and shell.exec stay denied, even over yolo's allow-all", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-todo-plan-"));
  try {
    const rt = createRuntime({ cwd, sessionId: "sess-plan", stream: null });
    const cfg = rt.buildCfg(false);
    const c = ctx("sess-plan", cwd);
    const plan = applyModeRules("plan", cfg.permissionRules);
    const w = await rt.registry.dispatch(call("todo_write", { todos: items() }), c, undefined, plan, cfg.approval, () => {});
    expect(w.ok).toBe(true); // mutation: drop the `memory.write todo_write allow` in planModeRules → Permission denied
    expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-plan", TODOS_FILE))).toBe(true);
    const r = await rt.registry.dispatch(call("todo_read", {}), c, undefined, plan, cfg.approval, () => {});
    expect(r.ok).toBe(true);
    expect(dataItems(r)).toEqual(items());
    // the re-allow is scoped to the tool NAME: every other write class in plan mode is still denied
    const denied: ToolCallPart[] = [
      call("memory_edit", { op: "add", block: "memory", text: "leak" }),  // the same memory.write action, a different resource
      call("write", { path: join(cwd, "leak.txt"), content: "leak\n" }),   // file.write
      call("bash", { command: "echo leak" }),                              // shell.exec
    ];
    for (const d of denied) {
      const out = await rt.registry.dispatch(d, c, undefined, plan, cfg.approval, () => {});
      expect(out.ok, d.tool).toBe(false);
      expect(out.output, d.tool).toContain("Permission denied");
    }
    expect(existsSync(join(cwd, "leak.txt"))).toBe(false);
    expect(rt.blockStore.renderForPrompt()).not.toContain("leak");
    // plan rules are appended LAST, so they override yolo's `* * allow` too: write denied, todo allowed
    const planYolo = applyModeRules("plan", rt.buildCfg(true).permissionRules);
    expect((await rt.registry.dispatch(call("write", { path: join(cwd, "leak2.txt"), content: "x" }), c, undefined, planYolo, undefined, () => {})).ok).toBe(false);
    expect((await rt.registry.dispatch(call("todo_write", { todos: [] }), c, undefined, planYolo, undefined, () => {})).ok).toBe(true);
    expect(loadTodos(join(cwd, ".rovecode", "sessions", "sess-plan"))).toEqual({ items: [] }); // the plan-mode clear ran
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("policy: the resource is the tool name (no path/command in the schemas) — `memory.write todo_write deny` targets it precisely", async () => {
  const h = harness();
  try {
    expect(Object.keys((todoWriteTool(h.root).schema.args["properties"] as object))).toEqual(["todos"]);
    expect(Object.keys((todoReadTool(h.root).schema.args["properties"] as object))).toEqual([]);
    const rules: PermissionRule[] = [...ALLOW_ALL, { action: "memory.write", resource: "todo_write", effect: "deny" }];
    const w = await h.registry.dispatch(call("todo_write", { todos: items() }), ctx(), undefined, rules, undefined, () => {});
    expect(w.ok).toBe(false);
    expect(w.output).toContain("Permission denied");
    // a smuggled `path` key cannot re-aim the rule at another resource
    const smuggled = await h.registry.dispatch(call("todo_write", { todos: items(), path: "/elsewhere" }), ctx(), undefined, rules, undefined, () => {});
    expect(smuggled.ok).toBe(false);
    expect(existsSync(h.file())).toBe(false);
  } finally { h.done(); }
});

// ---------- registry / description pins ----------

test("registry: todoTools yields exactly todo_write (sequential) and todo_read (parallel-safe); description carries the when-to-use guidance, bounded", () => {
  const tools = todoTools("unused-root");
  expect(tools.map((t) => t.schema.name)).toEqual(["todo_write", "todo_read"]);
  const [write, read] = tools;
  expect(write!.sequential).toBe(true);
  expect(read!.sequential).toBe(false);
  const d = write!.schema.description;
  expect(d).toContain("REPLACES the whole list");
  expect(d).toContain("3+ distinct steps");        // opencode todowrite.txt:5
  expect(d).toContain("exactly ONE at a time");     // todowrite.txt:9, gemini :120-126
  expect(d).toContain("don't batch completions");   // todowrite.txt:25
  expect(d).toContain("When in doubt, use it.");    // todowrite.txt:44
  expect(d.length).toBeLessThan(1400);
  expect((write!.schema.args["required"] as string[])).toEqual(["todos"]);
  const todosSchema = (write!.schema.args["properties"] as Record<string, Record<string, unknown>>)["todos"]!;
  expect(todosSchema["maxItems"]).toBe(MAX_TODOS);
  const item = todosSchema["items"] as { required: string[]; properties: Record<string, { enum?: string[] }> };
  expect(item.required).toEqual(["id", "content", "status"]);
  expect(item.properties["status"]!.enum).toEqual(["pending", "in_progress", "completed"]);
  expect(item.properties["priority"]!.enum).toEqual(["high", "medium", "low"]);
});

// ---------- render smoke ----------

test("renderTodos golden: mixed list (pinned string), empty list, clipped/collapsed content, overflow note", () => {
  expect(renderTodos(items())).toBe(
    "todos: 3 total · 1 completed · 1 in progress · 1 pending\n" +
    "[x] t1: write tests\n" +
    "[>] t2: implement tool (high)\n" +
    "[ ] t3: update notes (low)",
  );
  expect(renderTodos([])).toBe("todos: (empty)");
  // multi-line / padded content renders as ONE row; >200 chars is clipped with an ellipsis
  const messy = renderTodos([{ id: "m", content: "  line one\n\tline   two  ", status: "pending" }]);
  expect(messy.split("\n")).toEqual(["todos: 1 total · 0 completed · 0 in progress · 1 pending", "[ ] m: line one line two"]);
  const long = renderTodos([{ id: "L", content: "y".repeat(300), status: "completed" }]).split("\n")[1]!;
  expect(long).toBe(`[x] L: ${"y".repeat(200)}…`);
  // bounded even for an over-long (hand-built) list
  const many: TodoItem[] = Array.from({ length: MAX_TODOS + 3 }, (_, i) => ({ id: `t${i}`, content: `s${i}`, status: "pending" }));
  const rows = renderTodos(many).split("\n");
  expect(rows.length).toBe(1 + MAX_TODOS + 1);
  expect(rows.at(-1)).toBe("(+3 more not shown)");
});

test("bounds accept-side: exactly MAX_TODOS items, a MAX_ID_CHARS id and MAX_CONTENT_CHARS content are all ACCEPTED (the limits are inclusive)", async () => {
  const h = harness();
  try {
    const full: TodoItem[] = Array.from({ length: MAX_TODOS }, (_, i) => ({ id: `t${i}`, content: `step ${i}`, status: "pending" }));
    expect((await h.run("todo_write", { todos: full })).ok).toBe(true); // mutation: `>=` on the count → rejected
    expect(dataItems(await h.run("todo_read", {}))).toHaveLength(MAX_TODOS);
    const edge: TodoItem[] = [{ id: "i".repeat(MAX_ID_CHARS), content: "c".repeat(MAX_CONTENT_CHARS), status: "in_progress" }];
    const w = await h.run("todo_write", { todos: edge });
    expect(w.ok).toBe(true); // mutation: `>=` on either length → rejected
    expect(dataItems(w)).toEqual(edge);
    expect(validateTodos(edge)).toEqual({ ok: true, items: edge });
    // and one over each bound is still rejected (the existing BAD table pins the messages)
    expect(validateTodos([{ id: "i".repeat(MAX_ID_CHARS + 1), content: "x", status: "pending" }]).ok).toBe(false);
    expect(validateTodos([{ id: "a", content: "c".repeat(MAX_CONTENT_CHARS + 1), status: "pending" }]).ok).toBe(false);
    expect(validateTodos([...full, { id: "extra", content: "x", status: "pending" }]).ok).toBe(false);
  } finally { h.done(); }
});

test("renderTodos flattens an id with an embedded newline to ONE row (validation trims the ends only, so the newline reaches the renderer)", () => {
  const v = validateTodos([{ id: "a\nb", content: "two-line id", status: "pending" }]);
  expect(v.ok).toBe(true);
  if (!v.ok) throw new Error(v.error);
  expect(v.items[0]!.id).toBe("a\nb");
  const rows = renderTodos(v.items).split("\n");
  expect(rows).toEqual(["todos: 1 total · 0 completed · 0 in progress · 1 pending", "[ ] a b: two-line id"]); // mutation: raw t.id → three rows
});

test("todoCounts / todoStatusLabel: counts by status; label is completed/total, empty for no todos", () => {
  expect(todoCounts(items())).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });
  expect(todoStatusLabel(items())).toBe("todos 1/3");
  expect(todoStatusLabel([])).toBe("");
  expect(todoStatusLabel([{ id: "a", content: "x", status: "completed" }])).toBe("todos 1/1");
});

// ---------- the plan reminder (loop.ts LoopDeps.planReminder) ----------

test("planReminder: nothing to chase — an empty list and a finished one both stay quiet", () => {
  expect(planReminder([])).toBeNull();
  expect(planReminder([
    { id: "a", content: "one", status: "completed" },
    { id: "b", content: "two", status: "completed" },
  ])).toBeNull();
});

test("planReminder: an open list comes back with the checkboxes and the next move", () => {
  const r = planReminder([
    { id: "a", content: "read the config", status: "completed" },
    { id: "b", content: "fix the parser", status: "in_progress" },
    { id: "c", content: "run the tests", status: "pending" },
  ]);
  expect(r).not.toBeNull();
  expect(r).toContain("<plan-reminder>");
  expect(r).toContain("todos: 3 total · 1 completed · 1 in progress · 1 pending");
  expect(r).toContain("[x] a: read the config");
  expect(r).toContain("[>] b: fix the parser");
  expect(r).toContain("[ ] c: run the tests");
  expect(r).toContain("Mark the in_progress item completed");
  expect(r).toContain("not a message from the user"); // it must not read as the human speaking
  expect(r).toContain("Never mention this reminder");
});

test("planReminder: with nothing in progress it asks for the next item to be claimed first", () => {
  const r = planReminder([
    { id: "a", content: "one", status: "completed" },
    { id: "b", content: "two", status: "pending" },
  ]);
  expect(r).toContain("Nothing is in progress. Mark the next item in_progress");
  expect(r).not.toContain("Mark the in_progress item completed");
});
