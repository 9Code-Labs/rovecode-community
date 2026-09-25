import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as m from "./dist/index.js"; const { createClient, mockStream } = m;

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
