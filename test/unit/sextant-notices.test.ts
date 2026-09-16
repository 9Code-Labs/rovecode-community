/** Notifications (model.ts notify / Notice, overlays.ts openNotices, the frame badge). Berkay chose
 *  four triggers — a run finishing, a failed tool, a card waiting for the human, and a history to
 *  read back — because toasts vanish in three seconds and what you missed while looking at another
 *  window was gone. These pin: notify writes BOTH surfaces, the four triggers fire from real events,
 *  the badge counts unread, ⌃b / /notices open the history newest-first and mark everything read. */

import { test, expect } from "bun:test";
import { applyEvent, markNoticesRead, notify, unreadNotices } from "../../src/sextant/model.ts";
import { agoLabel, openNotices } from "../../src/sextant/overlays.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import { drawFrame } from "../../src/sextant/draw-frame.ts";
import { MAX_NOTICES } from "../../src/sextant/types.ts";
import { makeState, makeLayout, spyCtx, ctrl, press, type, key, THEME } from "../helpers/sextant-fixtures-keys.ts";

const T0 = 1_000_000;

test("notify writes a toast AND a notice; the notice is unread until the history is opened", () => {
  const s = makeState();
  notify(s, "run done", T0, "info", "done");
  expect(s.toasts.map((t) => t.text)).toEqual(["run done"]);
  expect(s.notices).toHaveLength(1);
  expect(s.notices[0]).toMatchObject({ id: 1, at: T0, tone: "info", kind: "done", text: "run done", read: false });
  expect(unreadNotices(s)).toBe(1);
  markNoticesRead(s);
  expect(unreadNotices(s)).toBe(0);
});

test("the history is bounded: older notices fall off the front, ids keep climbing", () => {
  const s = makeState();
  for (let i = 0; i < MAX_NOTICES + 5; i++) notify(s, `n${i}`, T0 + i);
  expect(s.notices).toHaveLength(MAX_NOTICES);
  expect(s.notices[0]!.text).toBe("n5");
  expect(s.notices[s.notices.length - 1]!.id).toBe(MAX_NOTICES + 5);
});

test("run_end raises a notice in every status: done is info, error carries the first line, stopped is a warning", () => {
  const done = makeState();
  applyEvent(done, { type: "run_end", runId: "r", status: "done", summary: "" } as never, T0);
  expect(done.notices.at(-1)).toMatchObject({ kind: "done", tone: "info", text: "run done" });

  const err = makeState();
  applyEvent(err, { type: "run_end", runId: "r", status: "error", summary: "provider 500\nstack…" } as never, T0);
  expect(err.notices.at(-1)).toMatchObject({ kind: "error", tone: "error", text: "run failed: provider 500" });

  const stopped = makeState();
  applyEvent(stopped, { type: "run_end", runId: "r", status: "stopped", summary: "interrupted" } as never, T0);
  expect(stopped.notices.at(-1)).toMatchObject({ kind: "done", tone: "warn", text: "run stopped" });
});

test("a failed tool call raises an error notice naming the tool row when there is one", () => {
  const s = makeState();
  applyEvent(s, { type: "tool_call_failed", callId: "c1", reason: "invalid_args", detail: "path must be a string" } as never, T0);
  expect(s.notices.at(-1)).toMatchObject({ kind: "error", tone: "error" });
  expect(s.notices.at(-1)!.text).toContain("invalid args");
});

test("the frame badge shows the unread count and disappears once read", () => {
  const s = makeState();
  const L = makeLayout(160, 44);
  const paint = (): string => { const scr = new GridScreen(160, 44, THEME.bg); drawFrame(scr, L, s, THEME, T0); return scr.toText().split("\n")[0]!; };
  expect(paint()).not.toContain("◆ 2");
  notify(s, "a", T0); notify(s, "b", T0);
  expect(paint()).toContain("◆ 2");
  markNoticesRead(s);
  expect(paint()).not.toContain("◆ 2");
});

test("⌃b opens the history newest-first with ages as hints, and marks everything read", () => {
  const s = makeState(), spy = spyCtx();
  notify(s, "first", T0 - 90_000, "info", "done");
  notify(s, "second", T0 - 3_000, "error", "error");
  expect(unreadNotices(s)).toBe(2);
  press(s, spy, ctrl("b"), T0);
  expect(s.palette).not.toBeNull();
  expect(s.palette!.title).toBe("notifications");
  expect(s.palette!.items.map((i) => i.label)).toEqual(["✗ second", "· first"]);
  expect(unreadNotices(s)).toBe(0);
});

test("openNotices with an empty history shows one explanatory row instead of an empty box", () => {
  const s = makeState();
  openNotices(s, T0);
  expect(s.palette!.items).toHaveLength(1);
  expect(s.palette!.items[0]!.label).toContain("no notifications yet");
});

test("/notices does the same from the prompt and never reaches onSubmit", () => {
  const s = makeState(), spy = spyCtx();
  notify(s, "x", T0);
  type(s, spy, "/notices");
  press(s, spy, key("enter"));
  expect(s.palette?.title).toBe("notifications");
  expect(spy.submits).toEqual([]);
});

test("agoLabel is coarse on purpose", () => {
  expect([agoLabel(0), agoLabel(12_000), agoLabel(180_000), agoLabel(7_200_000)]).toEqual(["just now", "12s", "3m", "2h"]);
});
