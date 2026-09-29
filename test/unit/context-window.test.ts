/** providers/context-window.ts — the panel's promise: a model NEVER has an unknown window.
 *  Order pinned: per-model config > provider-wide config > catalog > the marked assumption. */
import { expect, test } from "bun:test";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { ASSUMED_CONTEXT_WINDOW, resolveContextWindow } from "../../src/providers/context-window.ts";

const catalog = new ModelCatalog(); // offline snapshot; deepseek-chat is in the local overlay (128k)

test("per-model config wins over everything, case-insensitively", () => {
  const spec = { contextWindow: 64_000, contextWindows: { "DeepSeek-Chat": 131_072 } };
  expect(resolveContextWindow(catalog, spec, "deepseek", "deepseek-chat")).toEqual({ window: 131_072, source: "config" });
});

test("provider-wide config beats the catalog; catalog beats the assumption", () => {
  expect(resolveContextWindow(catalog, { contextWindow: 64_000 }, "deepseek", "deepseek-chat")).toEqual({ window: 64_000, source: "config" });
  expect(resolveContextWindow(catalog, undefined, "deepseek", "deepseek-chat")).toEqual({ window: 128_000, source: "catalog" });
});

test("an unknown model on an unconfigured provider gets the marked assumption — never undefined", () => {
  expect(resolveContextWindow(catalog, undefined, "kaesra", "deepseek-v4.1-flash"))
    .toEqual({ window: ASSUMED_CONTEXT_WINDOW, source: "assumed" });
  expect(resolveContextWindow(catalog, { contextWindows: { "other-model": 1_000 } }, "kaesra", "deepseek-v4.1-flash"))
    .toEqual({ window: ASSUMED_CONTEXT_WINDOW, source: "assumed" }); // a non-matching per-model entry does not leak
});

test("malformed config numbers are ignored, not served", () => {
  const spec = { contextWindow: -5, contextWindows: { m: Number.NaN } };
  const r = resolveContextWindow(catalog, spec, "x", "m");
  expect(r.source).not.toBe("config");
});
