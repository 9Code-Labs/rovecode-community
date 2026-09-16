/** Built-in prompt commands (port #53): slash commands whose whole effect is a prompt the ONE agent
 *  loop runs — today `/init`, which asks the agent to analyse the repo and write (or improve)
 *  AGENTS.md. They expand exactly where custom commands do: the TUI submits the rendered prompt as a
 *  plain user turn (context-cmds.ts) and `rovecode run "/init"` renders it headlessly through
 *  commands.ts expandSlashPrompt, which consults this table BEFORE the custom-command files (a
 *  built-in beats a same-named custom command, as in the TUI). No renderer, store or loop import
 *  here — both the TUI and the headless path can depend on this module without a cycle.
 *
 *  Pattern reference only, no code ported: gemini-cli @ 0bd1d43 packages/cli/src/ui/commands/
 *  initCommand.ts (the command checks whether the context file exists in the target dir and turns
 *  into a submitted prompt, :33-49) and packages/core/src/commands/init.ts performInit (:9-57 — a
 *  guided analysis prompt: explore, read the README, pick up to ~10 key files, identify the project
 *  type, then write the file). Deviation: gemini refuses when its file already exists ("No changes
 *  were made", :10-17); rovecode asks for targeted improvements instead, and the write itself goes
 *  through the ordinary edit/write approval seam — the command never touches the file. */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The file the agent writes — the project-context file cli/boot-context.ts harvests (port #8). */
export const INIT_TARGET = "AGENTS.md";

/** `/init` — the analysis prompt; the variant depends on whether `<cwd>/AGENTS.md` exists. */
export function initPrompt(cwd: string): string {
  const exists = existsSync(join(cwd, INIT_TARGET));
  const head = exists
    ? `${INIT_TARGET} already exists in this project. Analyse the repository, read the current ${INIT_TARGET}, and propose TARGETED improvements to it: fix what is stale or wrong, add what a future agent session would need and cannot infer quickly, remove nothing that is still true. Apply the changes with the edit tool (small anchored edits, never a wholesale rewrite) and finish with a short list of what changed and why.`
    : `Analyse this repository and write an ${INIT_TARGET} file at the project root: the instructional context a future agent session reads first.`;
  return `${head}

Analysis:
1. List the top-level files and directories for an overview. Read the README (README.md or similar) first if there is one.
2. Read the files that matter most, up to about ten, letting each discovery guide the next: build/package manifests (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, …), the main entry points, existing agent or contributor guides (AGENTS.md, CLAUDE.md, CONTRIBUTING.md), CI config.
3. Decide whether this is a code project or something else (documentation, notes, data).

${INIT_TARGET} content — concise, factual, only what you verified in the files:
- Project overview: purpose, main technologies, architecture in a few sentences.
- Build, run and test: the exact commands, inferred from the manifests and scripts you read; mark anything you could not confirm with a TODO instead of guessing.
- Conventions: code style, testing practice, layout rules, review or contribution rules the files reveal.
- For a non-code directory: what it holds, the key files and how the contents are meant to be used.

${exists ? `Edit ${INIT_TARGET} in place; do not create a second file.` : `Write the complete file with the write tool as well-formatted Markdown; do not touch other files.`} Keep it under about 150 lines.`;
}

/** Built-in prompt commands by name → their renderer. `arg` is the remainder of the line (unused by
 *  /init, which takes no arguments — kept in the signature so a later built-in can accept some). */
export const BUILTIN_PROMPTS: Readonly<Record<string, (cwd: string, arg: string) => string>> = {
  init: (cwd) => initPrompt(cwd),
};

/** `"/name args"` → the rendered built-in prompt, or undefined when the line names no built-in
 *  prompt command (a custom command, another built-in, plain text). Case-insensitive like custom
 *  command names. */
export function expandBuiltinSlash(prompt: string, cwd: string): string | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!m) return undefined;
  const render = Object.hasOwn(BUILTIN_PROMPTS, m[1]!.toLowerCase()) ? BUILTIN_PROMPTS[m[1]!.toLowerCase()] : undefined;
  return render ? render(cwd, (m[2] ?? "").trim()) : undefined;
}
