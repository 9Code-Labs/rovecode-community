/** Port #8 runtime wiring: config snapshotted ONCE per runtime (MED-4) and
 *  emitted as an ADR-007 "config" chunk on the AgentDefinition (HIGH-2). */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { estimateTokens } from "../../src/core/context.ts";

/** Hermetic cwd: `.git` stops the ancestor walk at the tmp dir. */
function tmpCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-rtconfig-"));
  mkdirSync(join(cwd, ".git"));
  return cwd;
}

test("project config is snapshotted at createRuntime — mid-session edits do NOT diverge the prompt (MED-4)", () => {
  const cwd = tmpCwd();
  writeFileSync(join(cwd, "AGENTS.md"), "config v1", "utf8");
  const rt = createRuntime({ cwd, stream: null });

  expect(rt.projectContext.text).toContain("config v1");
  const def1 = rt.buildDef({ provider: "p", model: "m" });
  expect(def1.contextChunks?.[0]?.text).toContain("config v1");

  // an agent edits AGENTS.md mid-session — the snapshot must not move
  writeFileSync(join(cwd, "AGENTS.md"), "config v2", "utf8");
  const def2 = rt.buildDef({ provider: "p", model: "m" });
  expect(def2.contextChunks?.[0]?.text).toContain("config v1");
  expect(def2.contextChunks?.[0]?.text).not.toContain("config v2");
  expect(rt.projectContext.text).not.toContain("config v2");
  // byte-stable across builds — prompt-cache friendly (port #5 interplay)
  expect(def2.contextChunks?.[0]?.text).toBe(def1.contextChunks?.[0]?.text);

  rmSync(cwd, { recursive: true, force: true });
});

test("harvested config rides buildDef as a 'config' chunk (priority 70), NOT string-concat in systemPrompt (HIGH-2)", () => {
  const cwd = tmpCwd();
  writeFileSync(join(cwd, "AGENTS.md"), "repo conventions here", "utf8");
  const rt = createRuntime({ cwd, stream: null });

  const def = rt.buildDef({ provider: "p", model: "m" });
  expect(def.contextChunks).toHaveLength(1);
  const chunk = def.contextChunks![0]!;
  expect(chunk.name).toBe("config");
  expect(chunk.priority).toBe(70);
  expect(chunk.tokens).toBe(estimateTokens(chunk.text));
  expect(chunk.text.startsWith("# Project context")).toBe(true);
  expect(chunk.text).toContain("## From AGENTS.md\nrepo conventions here");

  // the config text lives ONLY in the chunk — systemPrompt carries none of it
  expect(rt.systemPrompt()).not.toContain("repo conventions here");
  expect(rt.systemPrompt()).not.toContain("# Project context");
  expect(typeof def.systemPrompt === "string" && def.systemPrompt).not.toContain("repo conventions here");

  rmSync(cwd, { recursive: true, force: true });
});

test("no config files → no config chunk on the definition", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });

  expect(rt.projectContext).toEqual({ text: "", sources: [], skippedFiles: 0 });
  const def = rt.buildDef({ provider: "p", model: "m" });
  expect(def.contextChunks).toBeUndefined();
  expect(rt.systemPrompt()).not.toContain("# Project context");

  rmSync(cwd, { recursive: true, force: true });
});

test("runtime exposes provenance: truncation stubs survive into rt.projectContext.sources", () => {
  const cwd = tmpCwd();
  writeFileSync(join(cwd, "AGENTS.md"), "x\n".repeat(5000), "utf8"); // 10,000 chars > 8,000 per-file cap
  const rt = createRuntime({ cwd, stream: null });

  expect(rt.projectContext.sources).toHaveLength(1);
  expect(rt.projectContext.sources[0]).toMatchObject({ path: "AGENTS.md", family: "agents", truncated: true });
  expect(rt.projectContext.skippedFiles).toBe(0);

  rmSync(cwd, { recursive: true, force: true });
});
