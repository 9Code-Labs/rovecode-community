/** Pins /cost's OWN context estimate (cost.ts) to ALL-parts token counting (#6 re-verify
 *  residual). The loop-site twin (loop.ts compaction trigger) is already pinned by its suite;
 *  this line was not — a text-only mutation of buildCostNote's estimate kept every suite green
 *  while /cost's context line would read near-zero forever on tool-heavy sessions. */

import { tokenScaleFor } from "../../src/core/token-scale.ts";
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildCostNote } from "../../src/tui/cost.ts";
import { partsTokenText } from "../../src/core/loop.ts";
import { countTokens } from "../../src/core/usage.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import type { Message, MessagePart } from "../../src/core/types.ts";

const mk = (role: Message["role"], parts: MessagePart[]): Message => ({
  id: randomUUID(), role, parts, parentId: null, createdAt: 0,
});

test("buildCostNote's context estimate counts ALL parts (tool calls/results), not just text", () => {
  const messages: Message[] = [
    mk("user", [{ kind: "text", text: "read the big file" }]),
    mk("assistant", [
      { kind: "text", text: "reading." },
      { kind: "tool_call", id: "t1", tool: "read", args: { path: "big.txt", ranges: [[1, 4000]] } },
      { kind: "tool_result", callId: "t1", ok: true, output: "tool output line\n".repeat(400) },
    ]),
  ];
  const catalog = new ModelCatalog(); // offline snapshot; haiku's 200000 window pinned by catalog.test.ts
  const note = buildCostNote(messages, catalog, { provider: "anthropic", model: "claude-haiku-4-5" });

  // expected mirrors cost.ts's exact counting path, recomputed independently here: the same
  // partsTokenText projection over ALL parts, the same "\n" join, the same o200k countTokens
  const expected = countTokens(messages.map((m) => partsTokenText(m.parts)).join("\n"));
  const textOnly = countTokens(
    messages.map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n")).join("\n"),
  );
  // the fixture must hold the two counting policies far apart, or this pins nothing
  expect(expected).toBeGreaterThan(textOnly * 10);
  // ...and the printed figure is that count corrected towards haiku's own tokenizer, because o200k is
  // not it. This assertion used to pin the RAW count, i.e. the panel's bug was the thing under test.
  const scale = tokenScaleFor({ provider: "anthropic", model: "claude-haiku-4-5" });
  expect(scale.scale).toBeGreaterThan(1); // otherwise the line below proves nothing
  expect(note).toContain(`context: ~${Math.ceil(expected * scale.scale)} of 200000`);
  expect(note).toContain(`o200k counted ${expected}`); // and it says so rather than correcting silently
});
