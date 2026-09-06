/** An app command with a fixed argument set (`/effort auto|off|low|medium|high`) offers its values as
 *  suggestions once the command is typed — the same rows a local command like /theme has — so the
 *  footer's `effort` click (frame-hits.ts prefills `/effort `) lands on a list, not a blank prompt. */

import { test, expect } from "bun:test";
import { fuzzy } from "../../src/sextant/engine.ts";
import { allCommands, suggestions } from "../../src/sextant/overlays.ts";
import { makeState, spyCtx, key, press, type } from "../helpers/sextant-fixtures-keys.ts";

const LEVELS = ["auto", "off", "low", "medium", "high"] as const;
const withEffort = () => makeState({ commands: [{ name: "effort", description: "How hard I think", choices: LEVELS }, { name: "exit", description: "Quit" }] });

test("the command row shows the set the way a local command does; `/effort ` lists every value, `/effort h` narrows it", () => {
  const s = withEffort();
  expect(allCommands(s).find((c) => c.name === "effort")?.arg).toBe("auto·off·low·medium·high");
  expect(allCommands(s).find((c) => c.name === "exit")?.arg).toBeUndefined();
  s.input.text = "/effort "; s.input.cur = s.input.text.length;
  expect(suggestions(s, [], fuzzy).map((x) => x.label)).toEqual([...LEVELS]);
  s.input.text = "/effort h"; s.input.cur = s.input.text.length;
  expect(suggestions(s, [], fuzzy).map((x) => x.label)).toEqual(["high"]);
  // a command without choices still offers nothing after its name
  s.input.text = "/exit x"; s.input.cur = s.input.text.length;
  expect(suggestions(s, [], fuzzy)).toEqual([]);
});

test("a live set (a function) is read at suggestion time and named, not listed, in the command row", () => {
  const ids: string[] = [];
  const s = makeState({ commands: [{ name: "model", description: "Switch the model", choices: () => ids }] });
  expect(allCommands(s).find((c) => c.name === "model")?.arg).toBe("provider/model");
  s.input.text = "/model "; s.input.cur = s.input.text.length;
  expect(suggestions(s, [], fuzzy)).toEqual([]); // nothing fetched yet
  ids.push("anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-5.2");
  expect(suggestions(s, [], fuzzy).map((x) => x.label)).toEqual(ids);
  s.input.text = "/model son"; s.input.cur = s.input.text.length;
  expect(suggestions(s, [], fuzzy).map((x) => x.label)).toEqual(["anthropic/claude-sonnet-5"]);
});

test("listModelIds: configured providers' models as provider/model ids; unconfigured, erroring and empty providers drop out", async () => {
  const { listModelIds } = await import("../../src/tui/providers-cmd.ts");
  const reg = {
    list: () => [
      { id: "anthropic", apiKey: "k", noKey: false }, { id: "local", apiKey: null, noKey: true },
      { id: "nokey", apiKey: null, noKey: false }, { id: "broken", apiKey: "k", noKey: false }, { id: "empty", apiKey: "k", noKey: false },
    ],
    models: async (id: string) => id === "anthropic" ? { ok: true as const, models: ["claude-opus-5", "claude-sonnet-5"] }
      : id === "local" ? { ok: true as const, models: ["qwen3"] }
      : id === "broken" ? { ok: false as const, error: "boom" }
      : { ok: true as const, models: [] },
  };
  expect(await listModelIds(reg as never)).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "local/qwen3"]);
});

test("a subcommand set (choicesThen complete): Enter fills `/mcp add ` and waits for the name instead of submitting", () => {
  const s = makeState({ commands: [{ name: "mcp", description: "MCP", choices: ["search", "add", "trust"], choicesThen: "complete" }] });
  const spy = spyCtx();
  type(s, spy, "/mcp ad");
  expect(suggestions(s, [], fuzzy).map((x) => `${x.label}:${x.enter}`)).toEqual(["add:complete"]);
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual([]);
  expect(s.input.text).toBe("/mcp add ");
  expect(s.input.cur).toBe(9);
});

test("Enter on the picked value submits `/effort high`", () => {
  const s = withEffort(), spy = spyCtx();
  type(s, spy, "/effort hi");
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/effort high"]);
});
