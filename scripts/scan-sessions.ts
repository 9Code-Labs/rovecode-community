/** Every real transcript under the given `.rovecode/sessions` roots (default: the cwd's and the home's), one line per session:
 *  goal, model origin(s), tool calls by name, successful edit/write count, `task start` calls, and whether THIS session's goal
 *  is the goal argument of some other session's `task start` (= it ran as a task child). Written 2026-09-07 to answer one
 *  question — were the no-file runs on this machine subagent runs (a child on a native tool-calling model received a request
 *  with no tools until 437fcf1)? — and kept because it answers it again. The answer that night: 10 transcripts, 0 task starts,
 *  the 4 no-file runs were root sessions (greetings and a question). Hollow session dirs (meta.json only) are skipped.
 *
 *  usage: bun scripts/scan-sessions.ts [<sessions dir>…]     (a project root is accepted too: <root>/.rovecode/sessions is used) */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const roots = (args.length > 0 ? args : [process.cwd(), homedir()]).map((r) => (r.endsWith("sessions") ? r : join(r, ".rovecode", "sessions")));
interface Part { kind: string; id?: string; tool?: string; args?: unknown; callId?: string; ok?: boolean; text?: string }
interface Entry { role: string; parts: Part[]; origin?: { provider: string; model: string }; createdAt: number }
interface Row { root: string; id: string; goal: string; models: string[]; calls: Record<string, number>; writesOk: number; taskStarts: string[]; turns: number; first: number }
const rows: Row[] = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const id of readdirSync(root)) {
    const f = join(root, id, "entries.jsonl");
    if (!existsSync(f)) continue;
    const entries: Entry[] = readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => (JSON.parse(l) as { entry: Entry }).entry).filter((e) => e && e.role);
    const results = new Map<string, boolean>();
    for (const e of entries) if (e.role === "tool") for (const p of e.parts) if (p.kind === "tool_result" && p.callId) results.set(p.callId, p.ok === true);
    const calls: Record<string, number> = {}; let writesOk = 0; const taskStarts: string[] = []; const models = new Set<string>(); let turns = 0;
    for (const e of entries) {
      if (e.role !== "assistant") continue;
      turns++;
      if (e.origin) models.add(`${e.origin.provider}/${e.origin.model}`);
      for (const p of e.parts) {
        if (p.kind !== "tool_call" || !p.tool) continue;
        calls[p.tool] = (calls[p.tool] ?? 0) + 1;
        if ((p.tool === "edit" || p.tool === "write") && results.get(p.id ?? "") === true) writesOk++;
        if (p.tool === "task") { const a = p.args as { action?: string; goal?: string } | undefined; if (a?.action === "start" && a.goal) taskStarts.push(a.goal); }
      }
    }
    const goal = entries.find((e) => e.role === "user")?.parts.find((p) => p.kind === "text")?.text ?? "";
    rows.push({ root, id: id.slice(0, 8), goal, models: [...models], calls, writesOk, taskStarts, turns, first: entries[0]?.createdAt ?? 0 });
  }
}
const allStarts = new Set(rows.flatMap((r) => r.taskStarts));
console.log(`transcripts: ${rows.length} (roots: ${roots.join(", ")})`);
for (const r of rows.sort((a, b) => a.first - b.first)) {
  const child = allStarts.has(r.goal) ? "CHILD" : "root ";
  console.log(`${child} ${r.id} turns=${String(r.turns).padStart(2)} writesOk=${r.writesOk} models=${r.models.join(",") || "-"} calls=${JSON.stringify(r.calls)} taskStarts=${r.taskStarts.length} goal=${JSON.stringify(r.goal.slice(0, 70))}`);
}
console.log(`no-file runs: ${rows.filter((r) => r.writesOk === 0).length} of ${rows.length}; of those, task children: ${rows.filter((r) => r.writesOk === 0 && allStarts.has(r.goal)).length}; sessions that started a task: ${rows.filter((r) => r.taskStarts.length > 0).length}`);
