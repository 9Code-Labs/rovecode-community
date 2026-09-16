/** Port #60: aion picker contracts adapted to the existing /models picker, not a second implementation. */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../../src/cli/runtime.ts";
import { ModeManager } from "../../src/core/modes.ts";
import { describeModel, fmtContext, fmtPrice } from "../../src/providers/model-list.ts";
import type { ModelInfo } from "../../src/providers/catalog.ts";
import { cmdModel, cmdModels, type ProviderCmdCtx } from "../../src/tui/providers-cmd.ts";
import { plainInputRenderer } from "../../src/tui/input-plain.ts";
import type { PickItem } from "../../src/tui/renderer.ts";
import { removeDir } from "../helpers/scratch.ts";

const metadata: Record<string, ModelInfo> = {
  "gpt-4o": { provider: "openai", model: "gpt-4o", contextWindow: 128000, pricing: { inputPerMTok: 2.5, outputPerMTok: 10 } },
  o3: { provider: "openai", model: "o3", contextWindow: 200000, pricing: { inputPerMTok: 2, outputPerMTok: 8 }, supportsReasoning: true },
};
async function rig(run: (ctx: ProviderCmdCtx, log: { items: PickItem[][]; notes: string[]; pushes: number; pick: string | null }) => Promise<void>, opts: { model?: string; separate?: boolean } = {}): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-model-picker-")), home = mkdtempSync(join(tmpdir(), "rovecode-model-home-"));
  const saved = process.env.ROVECODE_HOME; process.env.ROVECODE_HOME = home;
  const rt = createRuntime({ cwd, stream: null });
  rt.providers.add({ id: "openai", baseUrl: "http://127.0.0.1:1/v1", protocol: "openai", noKey: true, models: ["o3", "gpt-4o"] }, "project");
  rt.providers.models = async () => ({ ok: true, models: ["o3", "gpt-4o"], source: "file" });
  const state = { provider: "openai", model: opts.model ?? "gpt-4o" };
  const modes = new ModeManager({ planActSeparateModels: opts.separate ?? false }, state);
  const log = { items: [] as PickItem[][], notes: [] as string[], pushes: 0, pick: null as string | null };
  const ctx: ProviderCmdCtx = { rt, modes, state, catalog: { lookup: (_provider, model) => metadata[model] }, pushStatus: () => { log.pushes++; }, renderer: {
    ...plainInputRenderer(async () => "", () => {}),
    addSystemNote: (text) => { log.notes.push(text); },
    pickOne: async (items) => { log.items.push(items); return log.pick; },
  } };
  try { await run(ctx, log); }
  finally { await rt.hooks.close(); await rt.mcp?.close(); rt.bashJobs.dispose(); if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved; removeDir(cwd); removeDir(home); }
}

test("row formatting: context and per-MTok in/out prices, zero and partial prices, capabilities, unknown metadata", () => {
  expect(describeModel(metadata["gpt-4o"])).toBe("128k ctx · $2.5/$10");
  expect(describeModel(metadata.o3)).toBe("200k ctx · $2/$8 · reasoning");
  expect(describeModel({ provider: "custom", model: "no-tools", supportsTools: false })).toBe("no tools");
  expect(describeModel(undefined)).toBe(""); expect(fmtContext(undefined)).toBe("");
  expect(fmtContext(1500000)).toBe("1.5M ctx"); expect(fmtContext(800)).toBe("800 ctx");
  expect(fmtPrice({ inputPerMTok: 0, outputPerMTok: 0 })).toBe("$0/$0");
  expect(fmtPrice({ inputPerMTok: 3 })).toBe("$3/?"); expect(fmtPrice({ outputPerMTok: 15 })).toBe("?/$15"); expect(fmtPrice({})).toBe("");
});

test("bare /model delegates to the existing picker: current first, same qualified values and labels, metadata descriptions", async () => {
  await rig(async (ctx, log) => {
    await cmdModel(ctx, "");
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toEqual([
      { value: "openai/gpt-4o", label: "* openai/gpt-4o", description: "current · 128k ctx · $2.5/$10" },
      { value: "openai/o3", label: "  openai/o3", description: "200k ctx · $2/$8 · reasoning" },
    ]);
    expect(log.pushes).toBe(0); expect(ctx.state.model).toBe("gpt-4o");
  });
});

test("Esc and re-picking current leave mode slots/status unchanged; unknown current still leads the list", async () => {
  await rig(async (ctx, log) => {
    await cmdModel(ctx, ""); expect(log.items[0]![0]).toEqual({ value: "openai/finetune", label: "* openai/finetune", description: "current" });
    log.pick = "openai/finetune"; await cmdModel(ctx, "");
    expect(log.pushes).toBe(0); expect(log.notes.filter((n) => n.startsWith("model →"))).toEqual([]);
    expect(ctx.modes.modelFor()).toEqual({ provider: "openai", model: "finetune" });
  }, { model: "finetune" });
});

test("a new pick goes through cmdModel: both slots mirror by default, status and switch note are updated once", async () => {
  await rig(async (ctx, log) => {
    log.pick = "openai/o3"; await cmdModel(ctx, "");
    expect(ctx.modes.modelFor("act")).toEqual({ provider: "openai", model: "o3" });
    expect(ctx.modes.modelFor("plan")).toEqual({ provider: "openai", model: "o3" });
    expect(ctx.state.model).toBe("o3"); expect(log.pushes).toBe(1); expect(log.notes.at(-1)).toBe("model → o3");
    expect(existsSync(join(process.env.ROVECODE_HOME!, "providers.json"))).toBe(false);
  });
});

test("separate model slots stay separate: picker updates only the active mode", async () => {
  await rig(async (ctx, log) => {
    log.pick = "openai/o3"; await cmdModels(ctx, "");
    expect(ctx.modes.modelFor("act").model).toBe("o3"); expect(ctx.modes.modelFor("plan").model).toBe("gpt-4o");
    expect(log.notes.at(-1)).toBe("model → o3 (act mode)");
  }, { separate: true });
});

test("bare /model --save retains rovecode's persistence, even for the current model", async () => {
  await rig(async (ctx, log) => {
    log.pick = "openai/gpt-4o"; await cmdModel(ctx, "--save");
    expect(JSON.parse(readFileSync(join(process.env.ROVECODE_HOME!, "providers.json"), "utf8")).default).toBe("openai/gpt-4o");
    expect(log.notes.at(-1)).toBe("model → gpt-4o (saved as default)");
  });
});

test("endpoint error stays visible but does not hide the active model; unknown listed models have no invented metadata", async () => {
  await rig(async (ctx, log) => {
    ctx.rt.providers.models = async () => ({ ok: false, error: "offline" }); await cmdModel(ctx, "");
    expect(log.notes).toContain("openai: offline"); expect(log.items[0]!.map((i) => i.value)).toEqual(["openai/gpt-4o"]);
    ctx.rt.providers.models = async () => ({ ok: true, models: ["custom-model"], source: "file" }); await cmdModel(ctx, "");
    expect(log.items[1]![1]).toEqual({ value: "openai/custom-model", label: "  openai/custom-model" });
  });
});
