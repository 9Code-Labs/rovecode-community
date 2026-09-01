import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadProjectContext, type ProjectContext } from "../../src/core/config.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aion-config-test-"));
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("full harvest: all families present, in precedence order, with rendered headers", () => {
  const dir = tmpDir();
  write(dir, ".aion/AION.md", "aion content");
  write(dir, "AGENTS.md", "agents content");
  write(dir, "CLAUDE.md", "claude content");
  write(dir, "GEMINI.md", "gemini content");
  write(dir, ".cursorrules", "cursorrules content");
  write(dir, ".cursor/rules/a.mdc", "mdc a content");
  write(dir, ".github/copilot-instructions.md", "copilot content");

  const result = loadProjectContext(dir);

  const expectedOrder = [
    { path: ".aion/AION.md", family: "aion", content: "aion content" },
    { path: "AGENTS.md", family: "agents", content: "agents content" },
    { path: "CLAUDE.md", family: "claude", content: "claude content" },
    { path: "GEMINI.md", family: "gemini", content: "gemini content" },
    { path: ".cursorrules", family: "cursor", content: "cursorrules content" },
    { path: ".cursor/rules/a.mdc", family: "cursor", content: "mdc a content" },
    { path: ".github/copilot-instructions.md", family: "copilot", content: "copilot content" },
  ] as const;

  expect(result.sources.map((s) => ({ path: s.path, family: s.family }))).toEqual(
    expectedOrder.map(({ path, family }) => ({ path, family })),
  );
  expect(result.sources.every((s) => !s.truncated)).toBe(true);
  expect(result.sources.map((s) => s.chars)).toEqual(expectedOrder.map((e) => e.content.length));

  const expectedText = expectedOrder.map((e) => `\n\n## From ${e.path}\n${e.content}`).join("");
  expect(result.text).toBe(expectedText);

  cleanup(dir);
});

test("dedupe: byte-identical AGENTS.md and CLAUDE.md collapse to the higher-precedence family, later one omitted entirely", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "shared content");
  write(dir, "CLAUDE.md", "shared content");

  const result = loadProjectContext(dir);

  expect(result.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: "shared content".length, truncated: false },
  ]);
  expect(result.text).toBe("\n\n## From AGENTS.md\nshared content");
  expect(result.text).not.toContain("CLAUDE.md");

  cleanup(dir);
});

test("per-file truncation: content cut to maxPerFileChars, marker appended, chars reflects the truncated length", () => {
  const dir = tmpDir();
  const long = "x".repeat(50);
  write(dir, "AGENTS.md", long);

  const result = loadProjectContext(dir, { maxPerFileChars: 10 });

  expect(result.sources).toHaveLength(1);
  const src = result.sources[0];
  expect(src?.truncated).toBe(true);
  expect(src?.chars).toBe(10 + "…[truncated]".length);
  expect(result.text).toBe(`\n\n## From AGENTS.md\n${"x".repeat(10)}…[truncated]`);
  // discriminates a mutant that forgets to actually slice the content
  expect(result.text).not.toContain("x".repeat(11));

  cleanup(dir);
});

test("total-cap drop: file that would exceed maxTotalChars is omitted from text but kept as a chars:0/truncated:true stub", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "a".repeat(20));
  write(dir, "CLAUDE.md", "b".repeat(20));

  const result = loadProjectContext(dir, { maxTotalChars: 25, maxPerFileChars: 1000 });

  expect(result.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: 20, truncated: false },
    { path: "CLAUDE.md", family: "claude", chars: 0, truncated: true },
  ]);
  expect(result.text).toBe(`\n\n## From AGENTS.md\n${"a".repeat(20)}`);
  expect(result.text).not.toContain("CLAUDE.md");
  expect(result.text).not.toContain("b");

  cleanup(dir);
});

test("mdc frontmatter is stripped from .cursor/rules/*.mdc, body content is kept verbatim", () => {
  const dir = tmpDir();
  write(dir, ".cursor/rules/x.mdc", "---\ndescription: foo\nalwaysApply: true\n---\nActual rule body text");

  const result = loadProjectContext(dir);

  expect(result.sources).toEqual([
    { path: ".cursor/rules/x.mdc", family: "cursor", chars: "Actual rule body text".length, truncated: false },
  ]);
  expect(result.text).toBe("\n\n## From .cursor/rules/x.mdc\nActual rule body text");
  expect(result.text).not.toContain("alwaysApply");
  expect(result.text).not.toContain("description: foo");
  expect(result.text).not.toContain("---");

  cleanup(dir);
});

test("missing cwd returns an empty result without throwing", () => {
  const missing = join(tmpdir(), `aion-config-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let result: ProjectContext | undefined;
  expect(() => {
    result = loadProjectContext(missing);
  }).not.toThrow();
  expect(result).toEqual({ text: "", sources: [] });
});

test("existing but empty cwd yields an empty result (every candidate skipped silently)", () => {
  const dir = tmpDir();

  const result = loadProjectContext(dir);
  expect(result).toEqual({ text: "", sources: [] });

  cleanup(dir);
});

test(".cursor/rules/*.mdc files are sorted by filename, not by creation order", () => {
  const dir = tmpDir();
  write(dir, ".cursor/rules/b.mdc", "b body");
  write(dir, ".cursor/rules/a.mdc", "a body");
  write(dir, ".cursor/rules/c.mdc", "c body");

  const result = loadProjectContext(dir);
  const cursorMdcPaths = result.sources.map((s) => s.path).filter((p) => p.endsWith(".mdc"));

  expect(cursorMdcPaths).toEqual([".cursor/rules/a.mdc", ".cursor/rules/b.mdc", ".cursor/rules/c.mdc"]);

  cleanup(dir);
});
