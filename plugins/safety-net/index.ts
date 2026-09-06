/** safety-net — a first-party rovecode plugin. Two hooks, the whole plugin:
 *    pre_tool   refuses a shell command that deletes recursively, force-pushes, rewrites history,
 *               opens permissions to the world, pipes the network into a shell or drops a table.
 *               The refusal names the pattern and echoes the command, so the human can run it by hand
 *               if they meant it — a hook can only deny (core/hooks.ts: policy wins, a hook is the
 *               user's own stricter layer), which is exactly the right power for a safety net.
 *    post_tool  when a shell run prints a FAIL line, appends one sentence the model cannot miss: fix
 *               before moving on, do not mark the step done. The output itself is left intact.
 *  No imports: a plugin runs from ~/.rovecode/plugins as well as from this repo, so it cannot reach
 *  rovecode's source by path. The shapes below mirror core/hooks.ts HookSet (api 1). */

interface Ctx { cwd: string; sessionId: string; runId?: string }
interface Call { id: string; tool: string; args: unknown }
interface Result { ok: boolean; output: string }

const SHELL_TOOLS = new Set(["bash", "shell", "run"]);
const RISKY: readonly (readonly [RegExp, string])[] = [
  [/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, "recursive forced delete"],
  [/\bgit\s+push\b[^|;&]*\s(?:-f|--force)\b/i, "force push"],
  [/\bgit\s+reset\s+--hard\b/i, "hard reset"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f (untracked files gone for good)"],
  [/\bchmod\s+(?:-R\s+)?777\b/i, "world-writable permissions"],
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da)?sh\b/i, "network piped into a shell"],
  [/\bdrop\s+(?:table|database|schema)\b/i, "dropping a table or database"],
];

const commandOf = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;
  return typeof a.command === "string" ? a.command : typeof a.cmd === "string" ? a.cmd : "";
};

export default {
  api: 1,
  hooks: {
    pre_tool(_ctx: Ctx, call: Call): { deny: string } | undefined {
      if (!SHELL_TOOLS.has(call.tool)) return undefined;
      const cmd = commandOf(call.args);
      for (const [re, what] of RISKY) {
        if (re.test(cmd)) return { deny: `safety-net: ${what} — not from the agent. Run it yourself if you mean it: ${cmd.replace(/\s+/g, " ").slice(0, 160)}` };
      }
      return undefined;
    },
    post_tool(_ctx: Ctx, call: Call, result: Result): { output: string } | undefined {
      if (!SHELL_TOOLS.has(call.tool) || !/^\s*FAIL\b/m.test(result.output) || result.output.includes("safety-net:")) return undefined;
      return { output: `${result.output}\n\nsafety-net: a FAIL line above. Fix it before moving on; do not mark the step done.` };
    },
  },
};
