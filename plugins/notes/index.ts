/** notes — a first-party rovecode plugin that shows the TOOLS half of the seam. Two in-process tools:
 *    notes_add  {text, tag?}  appends `- YYYY-MM-DD [tag] text` to <cwd>/.rovecode/notes.md   (kind memory)
 *    notes_list {tag?, last?} returns the last N lines, optionally only one tag               (kind read)
 *  `tools` is a factory: it receives the plugin ctx (cwd, home, its own folder) and closes over the
 *  cwd, so the file lives with the repository, not with the plugin. The kind is the tool's permission
 *  class — the same policy path as every built-in (memory.write is allowed by default, like todo_write;
 *  read is read). No imports: a plugin must run from ~/.rovecode/plugins too. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Ctx { cwd: string; home: string; pluginDir: string }
interface Out { ok: boolean; output: string }
const MAX_TEXT = 500;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/i;

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const today = (): string => new Date().toISOString().slice(0, 10);

export default {
  api: 1,
  tools: (ctx: Ctx) => {
    const file = join(ctx.cwd, ".rovecode", "notes.md");
    const lines = (): string[] => (existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.startsWith("- ")) : []);
    return [
      {
        kind: "memory",
        sequential: true,
        schema: {
          name: "notes_add",
          description: `Append one dated note to ${".rovecode/notes.md"} in the workspace (a scratchpad that survives the session). Use it for decisions, gotchas and follow-ups worth keeping; keep each note to one sentence (≤${MAX_TEXT} chars). Optional tag groups notes for notes_list.`,
          args: {
            type: "object",
            properties: {
              text: { type: "string", description: "the note, one sentence" },
              tag: { type: "string", description: "optional group, e.g. decision · gotcha · todo" },
            },
            required: ["text"],
          },
        },
        async execute(args: unknown): Promise<Out> {
          const a = rec(args);
          const text = typeof a.text === "string" ? a.text.replace(/\s+/g, " ").trim() : "";
          if (!text) return { ok: false, output: "notes_add: text is required" };
          if (text.length > MAX_TEXT) return { ok: false, output: `notes_add: text is ${text.length} chars; keep a note under ${MAX_TEXT}` };
          const tag = typeof a.tag === "string" && a.tag.trim() ? a.tag.trim().toLowerCase() : "";
          if (tag && !TAG_RE.test(tag)) return { ok: false, output: `notes_add: tag must match ${TAG_RE}` };
          mkdirSync(dirname(file), { recursive: true });
          if (!existsSync(file)) appendFileSync(file, "# notes\n\n");
          const line = `- ${today()}${tag ? ` [${tag}]` : ""} ${text}`;
          appendFileSync(file, line + "\n");
          return { ok: true, output: `noted (${lines().length} notes): ${line}` };
        },
      },
      {
        kind: "read",
        sequential: false,
        schema: {
          name: "notes_list",
          description: "Read the workspace notes written with notes_add (newest last). Optional tag filters; last (default 50) bounds the count.",
          args: {
            type: "object",
            properties: {
              tag: { type: "string", description: "only notes with this tag" },
              last: { type: "integer", description: "how many of the most recent notes (default 50, max 500)" },
            },
          },
        },
        async execute(args: unknown): Promise<Out> {
          const a = rec(args);
          const tag = typeof a.tag === "string" ? a.tag.trim().toLowerCase() : "";
          const last = Math.min(500, Math.max(1, typeof a.last === "number" && Number.isFinite(a.last) ? Math.floor(a.last) : 50));
          const all = lines().filter((l) => !tag || l.includes(`[${tag}]`));
          if (all.length === 0) return { ok: true, output: tag ? `no notes tagged [${tag}]` : "no notes yet (notes_add writes .rovecode/notes.md)" };
          const shown = all.slice(-last);
          return { ok: true, output: `${shown.length} of ${all.length} note${all.length === 1 ? "" : "s"}:\n${shown.join("\n")}` };
        },
      },
    ];
  },
};
