/** The thinking dial in the footer tag. `/effort` changed a level nobody could see afterwards — the
 *  classic renderer paints it next to the model, the sextant footer did not. Now the bottom-right tag
 *  reads `model · effort <level> · theme · vX` whenever the status carries an effort, and stays exactly
 *  `model · theme · vX` when it does not (the goldens are built without one and must not move). */

import { test, expect } from "bun:test";
import { dumpFrame } from "../../src/sextant/frame.ts";
import { setUsage } from "../../src/sextant/model.ts";
import { makeState } from "../helpers/sextant-fixtures-keys.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const theme = nightTheme();
const NOW = 10_000_000;

test("the footer tag carries the effort level next to the model when the status reports one", () => {
  const s = makeState();
  setUsage(s, { provider: "anthropic", model: "claude-x", effort: "high" });
  expect(dumpFrame(s, 160, 44, NOW, theme)).toContain("claude-x · effort high · night · v0.2.0");
  setUsage(s, { effort: "auto" });
  expect(dumpFrame(s, 160, 44, NOW, theme)).toContain("claude-x · effort auto · night · v0.2.0");
});

test("no effort reported → the tag is unchanged (goldens rely on this)", () => {
  const s = makeState();
  setUsage(s, { provider: "anthropic", model: "claude-x" });
  const f = dumpFrame(s, 160, 44, NOW, theme);
  expect(f).toContain("claude-x · night · v0.2.0");
  expect(f).not.toContain("effort");
});
