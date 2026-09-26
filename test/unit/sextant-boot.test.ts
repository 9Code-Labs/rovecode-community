/** The boot gate (src/sextant/boot.ts): the cockpit holds its reveal until every live panel has
 *  painted clean, a faulting panel counts (the toast carries the story), and the cap guarantees the
 *  gate opens no matter what. If a future version changes the boot sequence, these are the contract. */

import { test, expect } from "bun:test";
import { createBoot, BOOT_ANIM_MS, BOOT_CAP_MS } from "../../src/sextant/boot.ts";

const T0 = 1_000_000;
const PANELS = ["files", "code", "messages"];

test("not ready before the animation finishes, even if every panel is clean", () => {
  const b = createBoot(T0);
  b.tick(T0 + 100, PANELS);
  for (const p of PANELS) b.clean(p);
  expect(b.gate.ready).toBe(false);
  expect(b.gate.progress).toBeLessThan(1);
});

test("ready once the animation finished AND every live panel painted clean", () => {
  const b = createBoot(T0);
  const now = T0 + BOOT_ANIM_MS;
  b.tick(now, PANELS);
  b.clean("files");
  b.clean("code");
  expect(b.gate.ready).toBe(false); // messages still pending
  expect(b.gate.pending).toEqual(["messages"]);
  b.clean("messages");
  expect(b.gate.ready).toBe(true);
  expect(b.gate.progress).toBe(1);
});

test("a faulting panel does not lock the gate — it counts as settled", () => {
  const b = createBoot(T0);
  const now = T0 + BOOT_ANIM_MS;
  b.tick(now, PANELS);
  b.clean("files");
  b.clean("code");
  b.fault("messages"); // e.g. the messages painter threw; the toast names it
  expect(b.gate.ready).toBe(true);
});

test("the cap forces readiness even with panels that never reported", () => {
  const b = createBoot(T0);
  b.tick(T0 + BOOT_CAP_MS, PANELS); // nothing clean, nothing faulted
  expect(b.gate.ready).toBe(true);
});

test("a panel that recovers after a fault is clean again", () => {
  const b = createBoot(T0);
  b.tick(T0 + BOOT_ANIM_MS, PANELS);
  b.fault("code");
  expect(b.gate.ready).toBe(false);
  b.clean("files");
  b.clean("messages");
  expect(b.gate.ready).toBe(true); // fault counts
  b.clean("code");
  b.fault("code"); // and a NEW fault after recovery drops readiness again? no — fault settles it
  expect(b.gate.ready).toBe(true);
});

test("the live set follows the layout — a panel that does not exist is never waited on", () => {
  const b = createBoot(T0);
  b.tick(T0 + BOOT_ANIM_MS, ["code", "messages"]); // narrow terminal: no files column
  b.clean("code");
  b.clean("messages");
  expect(b.gate.ready).toBe(true);
});
