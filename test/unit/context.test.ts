import { test, expect } from "bun:test";
import { assembleContext, type ContextChunk } from "../../src/core/context.ts";

function chunk(name: string, priority: number, tokens: number): ContextChunk {
  return { name, text: name.repeat(tokens), priority, tokens };
}

test("under budget: everything kept, nothing dropped", () => {
  const chunks = [
    chunk("system", 100, 100),
    chunk("skills", 60, 50),
    chunk("history", 50, 500),
  ];
  const asm = assembleContext(chunks, 2_000);
  expect(asm.dropped).toEqual([]);
  expect(asm.overBudget).toBe(false);
  expect(asm.totalTokens).toBe(650);
  expect(asm.chunks.map((c) => c.name)).toEqual(["system", "skills", "history"]);
});

test("over budget: lowest priority dropped first, system last-dropped", () => {
  const chunks = [
    chunk("system", 100, 100),
    chunk("skills", 60, 500),
    chunk("repo-map", 70, 400),
    chunk("history", 50, 100),
  ];
  const asm = assembleContext(chunks, 1_000);
  // total 1100 > 1000 → drop skills (500) → 600 ≤ 1000 fits; repo-map and system kept
  expect(asm.dropped.map((c) => c.name)).toEqual(["skills"]);
  expect(asm.chunks.map((c) => c.name)).toEqual(["system", "repo-map", "history"]);
  expect(asm.overBudget).toBe(false);
  expect(asm.totalTokens).toBe(600);
});

test("extreme pressure: system is the last non-history chunk dropped", () => {
  const chunks = [
    chunk("system", 100, 100),
    chunk("repo-map", 70, 400),
    chunk("history", 50, 100),
  ];
  const asm = assembleContext(chunks, 150);
  // 600 > 150 → drop repo-map (400) → 200 > 150 → drop system (100) → history alone
  expect(asm.dropped.map((c) => c.name)).toEqual(["repo-map", "system"]);
  expect(asm.chunks.map((c) => c.name)).toEqual(["history"]);
  expect(asm.overBudget).toBe(false);
});

test("history is never dropped even when it alone exceeds budget", () => {
  const chunks = [
    chunk("system", 100, 100),
    chunk("history", 50, 5_000),
  ];
  const asm = assembleContext(chunks, 1_000);
  expect(asm.chunks.map((c) => c.name)).toEqual(["history"]);
  expect(asm.overBudget).toBe(true);
  expect(asm.totalTokens).toBe(5_000);
});
