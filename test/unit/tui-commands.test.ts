/** Options/table extraction port: old import paths keep the exact table/type, not duplicate definitions. */
import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TUI_COMMANDS as publicCommands, type TuiAppOptions as PublicOptions } from "../../src/tui/app.ts";
import { TUI_COMMANDS, type TuiAppOptions } from "../../src/tui/tui-commands.ts";
import { discoverCommands } from "../../src/tui/commands.ts";
import { THINKING_EFFORTS } from "../../src/core/types.ts";
import { scratchDirs } from "../helpers/scratch.ts";
const scratch = scratchDirs();

test("app re-exports the ONE table; existing descriptions, topics and choices survive extraction", () => {
  expect(publicCommands).toBe(TUI_COMMANDS);
  expect(TUI_COMMANDS.find((c) => c.name === "effort")?.choices).toBe(THINKING_EFFORTS);
  expect(TUI_COMMANDS.find((c) => c.name === "sessions")).toEqual({ name: "sessions", description: "Pick an earlier session to continue — or manage them: /sessions rename <title…> | delete <id> | fork [<id>] | search <terms…>", group: "session", choices: ["rename", "delete", "fork", "search"], choicesThen: "complete" });
  const names = TUI_COMMANDS.map((c) => c.name);
  for (const name of ["help", "connect", "exit", "new", "sessions", "resume", "rewind", "tree", "export", "model", "models", "provider", "yolo", "accept-edits", "effort", "plan", "act", "checkpoints", "restore", "commit", "undo", "attach", "paste", "trust", "agents", "config", "mcp", "status", "cost", "todos", "tasks", "skills", "memory", "compact", "clear", "init", "copy"]) expect(names).toContain(name);
  expect(new Set(names).size).toBe(names.length);
});

test("every existing option remains assignable through both import paths (tsc verifies the types)", () => {
  const options: TuiAppOptions = { yolo: false, model: "m", cwd: "C:/repo", sessionId: "full-id", bootNote: "nothing to continue from — this is a new session", stream: null, exitOnClose: false, spawnRunner: async () => ({ code: 0, stdout: "", stderr: "" }), platform: "win32", addDirs: ["C:/extra"], pet: "rove", acceptEdits: false, permission: "ask", effort: "high" };
  const oldPath: PublicOptions = options;
  const newPath: TuiAppOptions = oldPath;
  expect(newPath).toBe(options);
  const source = readFileSync(join(import.meta.dir, "../../src/tui/app.ts"), "utf8");
  expect(source).not.toContain("export interface TuiAppOptions {"); expect(source).not.toContain("export const TUI_COMMANDS:");
  expect(source).toContain('export { TUI_COMMANDS, type TuiAppOptions } from "./tui-commands.ts"');
});

test("all extracted commands remain reserved against command-file collisions", () => {
  const cwd = scratch("rovecode-table-reserved-"); const dir = join(cwd, ".rovecode", "commands"); mkdirSync(dir, { recursive: true });
  for (const command of TUI_COMMANDS) writeFileSync(join(dir, `${command.name}.md`), "do not run this impostor");
  const found = discoverCommands(cwd, { reserved: TUI_COMMANDS.map((c) => c.name) });
  for (const command of TUI_COMMANDS) {
    expect(found.commands.some((c) => c.name === command.name)).toBe(false);
    expect(found.warnings).toContain(`/${command.name} is a built-in command — built-in kept (${join(dir, `${command.name}.md`)})`);
  }
});
