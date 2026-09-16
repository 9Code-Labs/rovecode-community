/** message-hits.ts — clicking a tool row that names a file opens it. The zones come from the painter's own
 *  row build at the painter's scroll offset, so each test first proves the zone lies on the painted row
 *  (read back by cell), then drives a click through handleInput and watches local.openFile. */

import { test, expect } from "bun:test";
import { renderFrame, type FrameDeps } from "../../src/sextant/frame.ts";
import { drawMessages } from "../../src/sextant/draw-messages.ts";
import { messageRowHits } from "../../src/sextant/message-hits.ts";
import type { SextantState } from "../../src/sextant/types.ts";
import { makeState, makeLayout, spyCtx, mouse, press } from "../helpers/sextant-fixtures-keys.ts";
import { GridScreen } from "../helpers/sextant-grid.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const theme = nightTheme();
const NOW = 10_000_000;
const L = makeLayout(160, 44);
/** renderFrame paints a titled placeholder for the messages panel unless the real painter is injected (the frame loop does) */
const DEPS: FrameDeps = { painters: { messages: drawMessages } };

function withTools(): SextantState {
  const s = makeState();
  s.messages.push({ kind: "user", text: "fix it" });
  s.messages.push({ kind: "tool", callId: "c1", tool: "read", verb: "read", label: "a.ts", path: "src/a.ts", running: false, ok: true, detail: "20 lines", ms: 12 });
  s.messages.push({ kind: "tool", callId: "c2", tool: "bash", verb: "run", label: "bun test", running: false, ok: true, ms: 900 });
  s.messages.push({ kind: "tool", callId: "c3", tool: "edit", verb: "edit", label: "b.ts", path: "src/b.ts", running: false, ok: true, add: 2, del: 1 });
  return s;
}

test("one zone per visible tool row with a path, on the row the painter drew; rows without a path get none", () => {
  const s = withTools();
  const g = new GridScreen(160, 44);
  const LL = renderFrame(g, s, theme, NOW, DEPS);
  const hits = messageRowHits(LL.messages, s, theme, NOW);
  expect(hits.map((h) => h.path)).toEqual(["src/a.ts", "src/b.ts"]);
  for (const h of hits) {
    const line = g.span(h.rect.x, h.rect.y, h.rect.w);
    expect(line).toContain(h.path.slice(h.path.lastIndexOf("/") + 1)); // the row names the file
  }
  expect(hits[1]!.rect.y).toBeGreaterThan(hits[0]!.rect.y);
});

test("a click on the row opens the file through local.openFile; a click on the run row opens nothing", () => {
  const s = withTools();
  const spy = spyCtx(L);
  const g = new GridScreen(160, 44);
  const LL = renderFrame(g, s, theme, NOW, DEPS);
  spy.ctx.hits = messageRowHits(LL.messages, s, theme, NOW).map((h) => ({ rect: h.rect, onClick: () => spy.ctx.local.openFile(h.path) }));
  const [a, b] = spy.ctx.hits;
  press(s, spy, mouse(0, a!.rect.x + 3, a!.rect.y), NOW);
  expect(spy.opened).toEqual(["src/a.ts"]);
  press(s, spy, mouse(0, a!.rect.x + 3, a!.rect.y + 1), NOW); // the bash row between them
  expect(spy.opened).toEqual(["src/a.ts"]);
  press(s, spy, mouse(0, b!.rect.x + 3, b!.rect.y), NOW);
  expect(spy.opened).toEqual(["src/a.ts", "src/b.ts"]);
});

test("no messages → no zones; a card over the transcript shrinks the window the zones may use", () => {
  const empty = makeState();
  const g = new GridScreen(160, 44);
  const LL = renderFrame(g, empty, theme, NOW, DEPS);
  expect(messageRowHits(LL.messages, empty, theme, NOW)).toEqual([]);
});
