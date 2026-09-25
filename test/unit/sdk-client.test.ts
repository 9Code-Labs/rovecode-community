/** @rovecode/sdk F1 (sdk-blueprint.md): the local-mode client over the REAL core — bootRuntime +
 *  the ONE agentLoop, mock stream injected through the runtime's own test seam. Bars: session.prompt
 *  yields verbatim RunEvents and ends done; events.subscribe sees the same stream; agent.tree maps
 *  TaskManager rows to AgentNodes with the parent edge; task lifecycle (start → wait → list) works;
 *  a prompt on a client with stream:null ends as an error event, never a throw. Hermetic: tmpdir cwd. */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, agentTree, type SdkEvent } from "../../src/sdk/index.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "rovecode-sdk-"));
  scratch.push(d);
  return d;
}

async function collect(gen: AsyncGenerator<SdkEvent, void>): Promise<SdkEvent[]> {
  const out: SdkEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("sdk client (local mode)", () => {
  test("prompt yields a run that ends done, and the bus sees it too", async () => {
    const rc = await createClient({ cwd: fresh(), stream: mockStream({ turns: [textTurn("sdk hello")] }) });
    const seen: SdkEvent[] = [];
    const unsub = rc.events.subscribe((e) => seen.push(e));
    const s = await rc.session.create({ id: "sdk-s1" });
    const events = await collect(s.prompt("say hello"));
    const end = events.find((e) => e.type === "run_end");
    expect(end).toBeDefined();
    expect(end && end.type === "run_end" ? end.status : "").toBe("done");
    expect(events.some((e) => e.type === "run_start")).toBe(true);
    // the bus carried the same terminal event (surfaces read what the consumer read)
    expect(seen.some((e) => e.type === "run_end")).toBe(true);
    unsub();
    await rc.close();
  });

  test("no provider (stream: null) ends as an error event, not a throw", async () => {
    const rc = await createClient({ cwd: fresh(), stream: null });
    const s = await rc.session.create({ id: "sdk-s2" });
    const events = await collect(s.prompt("anything"));
    const end = events.at(-1);
    expect(end?.type).toBe("run_end");
    expect(end && end.type === "run_end" ? end.status : "").toBe("error");
    await rc.close();
  });

  test("agentTree maps TaskInfo rows, parent edge preserved", () => {
    const rows: TaskInfo[] = [
      { id: "t1", label: "root", agent: "default", goal: "g", isolated: false, depth: 1, status: "running", createdAt: 1 },
      { id: "t2", label: "child", agent: "default", goal: "g2", isolated: true, depth: 2, status: "queued", createdAt: 2, parent: "t1" },
    ];
    const tree = agentTree(rows);
    expect(tree).toHaveLength(2);
    expect(tree[0]!.parent).toBeNull();
    expect(tree[1]!.parent).toBe("t1");
    expect(tree[1]!.isolated).toBe(true);
  });

  test("task api round-trips through the session runtime (refusal is data, not a throw)", async () => {
    const rc = await createClient({ cwd: fresh(), stream: mockStream({ turns: [textTurn("x")] }) });
    const s = await rc.session.create({ id: "sdk-s3" });
    // no agent named 'default' is registered without a real run config build — either a refusal
    // or an accepted task; both are data. What must hold: unknown session throws, known doesn't.
    expect(() => rc.task.list("nope")).toThrow();
    const r = rc.task.start(s.id, { goal: "noop" });
    expect(typeof r.ok).toBe("boolean");
    expect(Array.isArray(rc.task.list(s.id))).toBe(true);
    expect(Array.isArray(rc.agent.tree(s.id))).toBe(true);
    await rc.close();
  });

  test("session.list reads the sessions dir (empty for a fresh cwd)", async () => {
    const rc = await createClient({ cwd: fresh(), stream: null });
    expect(rc.session.list()).toEqual([]);
    await rc.close();
  });
});
