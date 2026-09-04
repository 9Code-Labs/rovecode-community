/** Session todo / plan tool (PORT #32): `todo_write` + `todo_read` over one
 *  JSON file per session, plus pure render helpers for the TUI surface.
 *
 *  Ported from opencode (MIT, snapshot ebece6e):
 *  - tool contract — ONE `todos` array argument that REPLACES the whole list
 *    (packages/opencode/src/tool/todo.ts:6-8, :31-34; packages/core/src/tool/
 *    todowrite.ts:14-16, :49); the store's update is delete-all + insert in
 *    list order (packages/opencode/src/session/todo.ts:29-51), reads come back
 *    in that order (:53-66);
 *  - item shape content / status / priority with the status and priority sets
 *    (packages/schema/src/session-todo.ts:7-15);
 *  - the when-to-use / when-not / rules guidance folded into the tool
 *    description (packages/opencode/src/tool/todowrite.txt:3-16, :24-30, :44).
 *  Validation follows gemini-cli (Apache-2.0, snapshot 0bd1d43)
 *  packages/core/src/tools/write-todos.ts:100-129 validateToolParamValues —
 *  array check, per-item object / non-empty description / status-enum checks,
 *  and the at-most-ONE-in_progress rule (:120-126); "Cleared todo list" is
 *  gemini's wording (:52, :68). Both upstreams reject an invalid list whole.
 *
 *  Deviations: items carry a caller-chosen `id` (whole-list replace needs a
 *  stable handle the model can quote back; opencode is position-keyed, gemini
 *  has none); three statuses only (no cancelled/blocked — drop the item
 *  instead); bounds (≤50 items, id ≤64 chars, content ≤500 chars) so tool output
 *  stays bounded; storage is `<sessionDir>/todos.json` written tmp+rename
 *  (session.ts persistLeaf pattern; opencode uses SQLite, gemini is in-memory).
 *  No in-memory cache: every read hits disk, so a second tool instance, a
 *  resumed session and the TUI `/todos` surface all see the same truth. A
 *  corrupt file is reported as empty + note — loading never throws.
 *
 *  Policy: todo_write is kind "memory" — a disk write of agent-private,
 *  session-scoped metadata, the same class as memory_edit (BlockStore under
 *  <session>/memory). core/tools.ts actionFor() maps it to memory.write, which
 *  the runtime's default gated rules ALLOW (runtime.ts buildCfg), so the list
 *  never prompts; kind "read" would also auto-run but would let read-only rule
 *  sets write to disk unseen — the mirror of recall.ts's argument against
 *  mislabeling kinds. The schemas declare no `path`/`command`, so the policy
 *  resource is the tool name: `memory.write todo_write` targets it precisely —
 *  which is how plan mode (modes.ts planModeRules) denies memory.write wholesale
 *  and then re-allows exactly todo_write: the list is the plan's own artifact
 *  (agent-private session metadata, not workspace state), while memory_edit,
 *  file.write and shell.exec stay denied there; todo_read (kind "read" →
 *  file.read) is always available. Not in checkpoints.ts MUTATING_KINDS, so
 *  todo writes never trigger snapshots. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";

// ---------- schema ----------

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";
export interface TodoItem { id: string; content: string; status: TodoStatus; priority?: TodoPriority }

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
export const TODO_PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];
export const MAX_TODOS = 50;
export const MAX_ID_CHARS = 64;
export const MAX_CONTENT_CHARS = 500;
export const TODOS_FILE = "todos.json";
const FILE_VERSION = 1;
const RENDER_CONTENT_CHARS = 200; // per-line render clip (content is ≤500 on disk; the TUI note stays scannable)

function isStatus(v: unknown): v is TodoStatus { return (TODO_STATUSES as readonly unknown[]).includes(v); }
function isPriority(v: unknown): v is TodoPriority { return (TODO_PRIORITIES as readonly unknown[]).includes(v); }

/** Bounded echo of a rejected value — a 200k-char status must not reflect into the error. */
function show(v: unknown): string {
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > 40 ? s.slice(0, 40).replace(/[\uD800-\uDBFF]$/, "") + "…" : s;
}

export type TodoValidation = { ok: true; items: TodoItem[] } | { ok: false; error: string };

/** Whole-list validation (gemini-cli write-todos.ts:100-129 shape, plus ids and
 *  bounds). Returns NORMALIZED items — ids/content trimmed, unknown keys
 *  dropped, `priority` omitted when absent — or the first precise error. */
export function validateTodos(raw: unknown): TodoValidation {
  const err = (error: string): TodoValidation => ({ ok: false, error });
  if (!Array.isArray(raw)) return err("`todos` must be an array of {id, content, status, priority?}");
  if (raw.length > MAX_TODOS) return err(`too many todos: ${raw.length} (max ${MAX_TODOS})`);
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  const inProgress: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t: unknown = raw[i];
    const at = `todos[${i}]`;
    if (!t || typeof t !== "object" || Array.isArray(t)) return err(`${at} must be an object {id, content, status, priority?}`);
    const o = t as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.trim().length === 0) return err(`${at}.id must be a non-empty string`);
    const id = o.id.trim();
    if (id.length > MAX_ID_CHARS) return err(`${at}.id exceeds ${MAX_ID_CHARS} chars`);
    if (seen.has(id)) return err(`duplicate id "${id}" at ${at} — ids must be unique`);
    seen.add(id);
    if (typeof o.content !== "string" || o.content.trim().length === 0) return err(`${at} ("${id}"): content must be a non-empty string`);
    const content = o.content.trim();
    if (content.length > MAX_CONTENT_CHARS) return err(`${at} ("${id}"): content exceeds ${MAX_CONTENT_CHARS} chars`);
    if (!isStatus(o.status)) return err(`${at} ("${id}"): status must be one of ${TODO_STATUSES.join(", ")} (got ${show(o.status)})`);
    const item: TodoItem = { id, content, status: o.status };
    if (o.priority !== undefined && o.priority !== null) {
      if (!isPriority(o.priority)) return err(`${at} ("${id}"): priority must be one of ${TODO_PRIORITIES.join(", ")} (got ${show(o.priority)})`);
      item.priority = o.priority;
    }
    if (item.status === "in_progress") inProgress.push(id);
    items.push(item);
  }
  // gemini-cli write-todos.ts:120-126: only one task can be in_progress at a time
  if (inProgress.length > 1) return err(`only one todo may be in_progress at a time (found ${inProgress.length}: ${inProgress.join(", ")})`);
  return { ok: true, items };
}

// ---------- persistence (<sessionDir>/todos.json) ----------

export interface LoadedTodos { items: TodoItem[]; note?: string }

/** Read the session's list. Missing file = empty (the normal initial state, no
 *  note). Unreadable / malformed / schema-invalid content = empty + a note
 *  saying so — never throws; the next todo_write replaces the file. */
export function loadTodos(sessionDir: string): LoadedTodos {
  const file = join(sessionDir, TODOS_FILE);
  const tail = "treating the list as empty; the next todo_write replaces it";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ENOENT") return { items: [] };
    return { items: [], note: `${TODOS_FILE} could not be read (${e instanceof Error ? e.message : String(e)}) — ${tail}` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { items: [], note: `${TODOS_FILE} is not valid JSON — ${tail}` }; }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || o.version !== FILE_VERSION || !Array.isArray(o.items)) {
    return { items: [], note: `${TODOS_FILE} has an unexpected shape (expected {version: ${FILE_VERSION}, items: [...]}) — ${tail}` };
  }
  const v = validateTodos(o.items);
  if (!v.ok) return { items: [], note: `${TODOS_FILE} failed validation (${v.error}) — ${tail}` };
  return { items: v.items };
}

/** Atomic replace: write `todos.json.tmp`, then rename over the target (session.ts
 *  persistLeaf). Creates the session dir if needed. IO errors propagate — the
 *  tool turns them into ok:false. */
export function saveTodos(sessionDir: string, items: readonly TodoItem[]): void {
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, TODOS_FILE);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, items }, null, 2) + "\n");
  renameSync(tmp, file);
}

/** A session id must be a plain directory name: `<root>/<id>/todos.json` may never
 *  resolve outside the sessions root (listSessions identity = directory name). */
function sessionDirFor(root: string, sessionId: string): string | null {
  // both slashes are refused on every host: a backslash is a legal file-name byte on POSIX, but an id
  // that would be a path on Windows is not a plain directory name anywhere
  if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId) || basename(sessionId) !== sessionId) return null;
  return join(root, sessionId);
}

// ---------- rendering (pure; shared by tool output and the TUI) ----------

export interface TodoCounts { total: number; pending: number; inProgress: number; completed: number }

export function todoCounts(items: readonly TodoItem[]): TodoCounts {
  const c: TodoCounts = { total: items.length, pending: 0, inProgress: 0, completed: 0 };
  for (const t of items) {
    if (t.status === "completed") c.completed++;
    else if (t.status === "in_progress") c.inProgress++;
    else c.pending++;
  }
  return c;
}

const GLYPH: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

/** Single-line content: whitespace collapsed, clipped with an ellipsis (surrogate-safe). */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RENDER_CONTENT_CHARS
    ? flat.slice(0, RENDER_CONTENT_CHARS).replace(/[\uD800-\uDBFF]$/, "") + "…"
    : flat;
}

/** Checkbox rendering: a summary line, then one `[glyph] id: content (priority)`
 *  row per item in list order. Bounded: ≤MAX_TODOS rows, content clipped, and the
 *  id flattened too (a trimmed id may still carry an inner newline — one row per item). */
export function renderTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return "todos: (empty)";
  const c = todoCounts(items);
  const lines = [`todos: ${c.total} total · ${c.completed} completed · ${c.inProgress} in progress · ${c.pending} pending`];
  for (const t of items.slice(0, MAX_TODOS)) {
    lines.push(`${GLYPH[t.status]} ${oneLine(t.id)}: ${oneLine(t.content)}${t.priority ? ` (${t.priority})` : ""}`);
  }
  if (items.length > MAX_TODOS) lines.push(`(+${items.length - MAX_TODOS} more not shown)`);
  return lines.join("\n");
}

/** The re-send the loop makes while a plan is open (loop.ts LoopDeps.planReminder).
 *
 *  A list written twenty turns ago is buried under tool results: the model stops marking items done,
 *  starts a second item without finishing the first, or forgets the tail of the plan entirely. This is
 *  the same shape as the tool's own output, plus the one instruction that matters right now — so the
 *  plan is always the most recent thing in the request, not the oldest.
 *
 *  null when there is nothing to chase (no list, or everything completed): a finished plan must not
 *  keep nagging, and an empty one has nothing to say. */
export function planReminder(items: readonly TodoItem[]): string | null {
  const c = todoCounts(items);
  if (c.total === 0 || c.completed === c.total) return null;
  return [
    "<plan-reminder>",
    "Your own todo list for this task, still open — not a message from the user.",
    renderTodos(items),
    c.inProgress === 0
      ? "Nothing is in progress. Mark the next item in_progress with todo_write before you start it."
      : "Mark the in_progress item completed with todo_write the moment it is done, then start the next one.",
    "Rewrite the list if the plan changed. Never mention this reminder in your reply.",
    "</plan-reminder>",
  ].join("\n");
}

/** Status-bar label, e.g. "todos 1/3" (completed/total); "" when the list is empty. */
export function todoStatusLabel(items: readonly TodoItem[]): string {
  if (items.length === 0) return "";
  const c = todoCounts(items);
  return `todos ${c.completed}/${c.total}`;
}

// ---------- tools ----------

const WRITE_DESCRIPTION =
  "Create or update this session's structured todo list (your plan). REPLACES the whole list: send every item " +
  `you want kept — items {id, content, status, priority?}; at most ${MAX_TODOS} items, ids unique and non-empty ` +
  `(≤${MAX_ID_CHARS} chars), content non-empty (≤${MAX_CONTENT_CHARS} chars). Statuses: pending | in_progress ` +
  "(exactly ONE at a time) | completed. Priority: high | medium | low (optional). An invalid list is rejected whole " +
  "and nothing changes; an empty list clears the todos. Use proactively when: the task needs 3+ distinct steps; the " +
  "work is non-trivial and benefits from planning; the user gives multiple tasks or asks for a todo list; new " +
  "instructions arrive (capture them as todos); you start a step (mark it in_progress first) or finish one (mark it " +
  "completed only once the work, including verification, is actually done — never on intent; add follow-ups " +
  "discovered on the way). Skip it for a single straightforward task, a purely informational request, or when " +
  "tracking adds no value. Update in real time — don't batch completions. When in doubt, use it.";

const READ_DESCRIPTION =
  "Read this session's todo list as last written by todo_write: ids, content, status, priority. Use it to get the " +
  "current ids before updating the list, or to check what remains. Empty until todo_write creates a list.";

const itemSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: `stable short id, unique within the list (e.g. "t1"); ≤${MAX_ID_CHARS} chars` },
    content: { type: "string", description: `brief, specific, actionable description of the task; ≤${MAX_CONTENT_CHARS} chars` },
    status: { type: "string", enum: [...TODO_STATUSES], description: "pending | in_progress (exactly one at a time) | completed" },
    priority: { type: "string", enum: [...TODO_PRIORITIES], description: "optional priority" },
  },
  required: ["id", "content", "status"],
};

/** `todo_write` bound to a sessions root; the list lives at <root>/<ctx.sessionId>/todos.json. */
export function todoWriteTool(sessionsRoot: string): Tool {
  return {
    schema: {
      name: "todo_write",
      description: WRITE_DESCRIPTION,
      args: {
        type: "object",
        properties: {
          todos: { type: "array", description: "the complete, updated todo list (replaces the current one)", maxItems: MAX_TODOS, items: itemSchema },
        },
        required: ["todos"],
      },
    },
    kind: "memory",
    sequential: true,
    execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const dir = sessionDirFor(sessionsRoot, ctx.sessionId);
      if (!dir) return Promise.resolve({ ok: false, output: `todo_write failed: invalid session id ${show(ctx.sessionId)}` });
      // keep ONLY the schema arg (recall.ts idiom): smuggled keys never influence behavior
      const raw = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const v = validateTodos(raw.todos);
      if (!v.ok) return Promise.resolve({ ok: false, output: `todo_write failed: ${v.error}; the list was not changed` });
      try {
        saveTodos(dir, v.items);
      } catch (e) {
        return Promise.resolve({ ok: false, output: `todo_write failed: could not write ${TODOS_FILE}: ${e instanceof Error ? e.message : String(e)}` });
      }
      // gemini write-todos.ts:52/:68 wording for the clear case; otherwise the checkbox view
      const output = v.items.length === 0 ? "Cleared todo list." : renderTodos(v.items);
      return Promise.resolve({ ok: true, output, data: { items: v.items } });
    },
  };
}

/** `todo_read` bound to the same root. Pure read (kind "read"): never creates the file. */
export function todoReadTool(sessionsRoot: string): Tool {
  return {
    schema: {
      name: "todo_read",
      description: READ_DESCRIPTION,
      args: { type: "object", properties: {} },
    },
    kind: "read",
    sequential: false,
    execute(_args: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const dir = sessionDirFor(sessionsRoot, ctx.sessionId);
      if (!dir) return Promise.resolve({ ok: false, output: `todo_read failed: invalid session id ${show(ctx.sessionId)}` });
      const { items, note } = loadTodos(dir);
      if (items.length === 0) {
        const head = note ? `${note}\n` : "";
        return Promise.resolve({ ok: true, output: `${head}No todos for this session yet — use todo_write to create a list.`, data: { items, ...(note ? { note } : {}) } });
      }
      return Promise.resolve({ ok: true, output: renderTodos(items), data: { items } });
    },
  };
}

/** Both tools over one sessions root — the runtime registration unit. */
export function todoTools(sessionsRoot: string): Tool[] {
  return [todoWriteTool(sessionsRoot), todoReadTool(sessionsRoot)];
}
