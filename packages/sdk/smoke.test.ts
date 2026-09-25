import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as m from "./dist/index.js"; const { createClient, mockStream, textTurn } = m;

test("packed bundle: createClient + prompt end-to-end", async () => {
  const rc = await createClient({ cwd: mkdtempSync(join(tmpdir(), "sdk-smoke-")), stream: mockStream({ turns: [m.textTurn("hi")] }) });
  const s = await rc.session.create();
  let sawEnd = false;
  for await (const ev of s.prompt("hello") as AsyncGenerator<{ type: string }>) {
    if (ev.type === "run_end") sawEnd = true;
  }
  await rc.close();
  expect(sawEnd).toBe(true);
}, 30000);

test("learn + memory surfaces work from the bundle", async () => {
  const rc = await createClient({ cwd: process.cwd(), stream: mockStream({ turns: [textTurn("ok")] }) });
  expect(rc.memory.add("memory", "smoke memory fact for the learning graph").ok).toBe(true);
  const g = rc.learn.graph();
  expect(g.nodes.some((n) => n.kind === "memory")).toBe(true);
  const s = await rc.session.create();
  for await (const _ of s.prompt("noop")) { /* drain */ }
  expect(rc.learn.draftSkill(s.id)).toBeNull(); // thin transcript → no draft
  expect(Array.isArray(rc.learn.nudges())).toBe(true);
  await rc.close();
});
