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

test("Enter on the picked value submits `/effort high`", () => {
  const s = withEffort(), spy = spyCtx();
  type(s, spy, "/effort hi");
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/effort high"]);
});
