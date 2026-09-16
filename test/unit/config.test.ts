import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadProjectContext, type ProjectContext } from "../../src/core/config.ts";

/** Hermetic root: the `.git` marker stops the ancestor walk at the tmp dir,
 *  so nothing above it (real machine dirs) can leak into assertions. */
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-config-test-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("full harvest: every candidate path (incl. bare ROVECODE.md and .claude/CLAUDE.md) in precedence order, with rendered headers", () => {
  const dir = tmpDir();
  write(dir, ".rovecode/ROVECODE.md", "rovecode content");
  write(dir, "ROVECODE.md", "bare rovecode content");
  write(dir, "AGENTS.md", "agents content");
  write(dir, "CLAUDE.md", "claude content");
  write(dir, ".claude/CLAUDE.md", "dot-claude content");
  write(dir, "GEMINI.md", "gemini content");
  write(dir, ".cursorrules", "cursorrules content");
  write(dir, ".cursor/rules/a.mdc", "mdc a content");
  write(dir, ".github/copilot-instructions.md", "copilot content");

  const result = loadProjectContext(dir);

  const expectedOrder = [
    { path: ".rovecode/ROVECODE.md", family: "rovecode", content: "rovecode content" },
    { path: "ROVECODE.md", family: "rovecode", content: "bare rovecode content" },
    { path: "AGENTS.md", family: "agents", content: "agents content" },
    { path: "CLAUDE.md", family: "claude", content: "claude content" },
    { path: ".claude/CLAUDE.md", family: "claude", content: "dot-claude content" },
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
  expect(result.skippedFiles).toBe(0);

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

test("per-file truncation without a newline in the window: hard cut, marker appended, chars reflects the truncated length", () => {
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

test("per-file truncation cuts at the last newline inside the window, never mid-line (LOW-5)", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "aaa\nbbb\nccc\nddd");

  const result = loadProjectContext(dir, { maxPerFileChars: 9 });

  // window "aaa\nbbb\nc" → cut back to the last whole line
  expect(result.text).toBe("\n\n## From AGENTS.md\naaa\nbbb…[truncated]");
  expect(result.sources[0]?.chars).toBe("aaa\nbbb…[truncated]".length);
  expect(result.sources[0]?.truncated).toBe(true);

  cleanup(dir);
});

test("per-file truncation inside a ``` fence closes the fence so following sections aren't swallowed (LOW-5)", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "intro\n```js\nline1\nline2\nline3\n```\ntail");
  write(dir, "CLAUDE.md", "next section body");

  const result = loadProjectContext(dir, { maxPerFileChars: 20 });

  // window "intro\n```js\nline1\nli" → newline cut → odd fence count → closer appended
  const truncatedSection = "\n\n## From AGENTS.md\nintro\n```js\nline1…[truncated]\n```";
  expect(result.text).toBe(`${truncatedSection}\n\n## From CLAUDE.md\nnext section body`);
  // the rendered text has an even number of fence lines — nothing left open
  expect(result.text.split("\n").filter((l) => l.trimStart().startsWith("```")).length % 2).toBe(0);

  cleanup(dir);
});

test("per-file truncation after a closed fence appends no spurious closer (fence count even)", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "```\ncode\n```\nAAAA BBBB CCCC");

  const result = loadProjectContext(dir, { maxPerFileChars: 20 });

  expect(result.text).toBe("\n\n## From AGENTS.md\n```\ncode\n```…[truncated]");

  cleanup(dir);
});

test("total cap budgets the FULL section string — header included (HIGH-3)", () => {
  const dir = tmpDir();
  // section = "\n\n## From AGENTS.md\n" (20 chars) + 20 content chars = 40
  write(dir, "AGENTS.md", "a".repeat(20));

  // content alone (20) fits 30, but the full section (40) does not → dropped
  const result = loadProjectContext(dir, { maxTotalChars: 30, maxPerFileChars: 1000 });

  expect(result.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: 0, truncated: true },
  ]);
  expect(result.text).toBe("");

  cleanup(dir);
});

test("total cap exact boundary: a section that lands exactly on maxTotalChars is included; one char less drops it (<= vs <)", () => {
  const dir = tmpDir();
  // section length = 20 (header) + 30 (content) = 50
  write(dir, "AGENTS.md", "a".repeat(30));

  const atBoundary = loadProjectContext(dir, { maxTotalChars: 50, maxPerFileChars: 1000 });
  expect(atBoundary.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: 30, truncated: false },
  ]);
  expect(atBoundary.text.length).toBe(50);

  const oneUnder = loadProjectContext(dir, { maxTotalChars: 49, maxPerFileChars: 1000 });
  expect(oneUnder.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: 0, truncated: true },
  ]);
  expect(oneUnder.text).toBe("");

  cleanup(dir);
});

test("total-cap drop: file that would exceed maxTotalChars is omitted from text but kept as a chars:0/truncated:true stub", () => {
  const dir = tmpDir();
  // each section = 20-char header + 20-char content = 40
  write(dir, "AGENTS.md", "a".repeat(20));
  write(dir, "CLAUDE.md", "b".repeat(20));

  const result = loadProjectContext(dir, { maxTotalChars: 60, maxPerFileChars: 1000 });

  expect(result.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: 20, truncated: false },
    { path: "CLAUDE.md", family: "claude", chars: 0, truncated: true },
  ]);
  expect(result.text).toBe(`\n\n## From AGENTS.md\n${"a".repeat(20)}`);
  expect(result.text).not.toContain("CLAUDE.md");
  expect(result.text).not.toContain("b");

  cleanup(dir);
});

test("rendered text NEVER exceeds maxTotalChars, even with many .cursor/rules files (header-bypass regression)", () => {
  const dir = tmpDir();
  // 50 rules × (32-char header + 470 content) = 25,100 > 24,000 default cap;
  // 47 sections of 502 chars fit (23,594), the last 3 become stubs
  for (let i = 0; i < 50; i++) {
    // unique 470-char bodies — byte-identical content would collapse in dedupe
    write(dir, `.cursor/rules/r${String(i).padStart(2, "0")}.mdc`, String(i).padStart(3, "0") + "r".repeat(467));
  }

  const result = loadProjectContext(dir, { maxFiles: 100 });

  expect(result.text.length).toBeLessThanOrEqual(24000);
  expect(result.text.length).toBe(47 * 502);
  expect(result.sources).toHaveLength(50);
  expect(result.sources.filter((s) => s.chars === 0 && s.truncated)).toHaveLength(3);
  expect(result.skippedFiles).toBe(0);

  cleanup(dir);
});

test("maxFiles bounds how many files are read; further existing candidates are counted in skippedFiles (HIGH-3)", () => {
  const dir = tmpDir();
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    write(dir, `.cursor/rules/${name}.mdc`, `${name} body`);
  }

  const result = loadProjectContext(dir, { maxFiles: 3 });

  expect(result.sources.map((s) => s.path)).toEqual([
    ".cursor/rules/a.mdc", ".cursor/rules/b.mdc", ".cursor/rules/c.mdc",
  ]);
  expect(result.skippedFiles).toBe(3);
  expect(result.text).not.toContain("d body");

  cleanup(dir);
});

test("default maxFiles bound holds without explicit opts", () => {
  const dir = tmpDir();
  for (let i = 0; i < 30; i++) {
    write(dir, `.cursor/rules/r${String(i).padStart(2, "0")}.mdc`, `body ${i}`);
  }

  const result = loadProjectContext(dir);

  expect(result.sources).toHaveLength(24);
  expect(result.skippedFiles).toBe(6);

  cleanup(dir);
});

test("empty and whitespace-only files are skipped entirely — no header-only section, no dedupe swallow (LOW-6)", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "");
  write(dir, "CLAUDE.md", "");            // previously swallowed by the "" dedupe entry
  write(dir, ".claude/CLAUDE.md", " \n\t\n");
  write(dir, "GEMINI.md", "real content");

  const result = loadProjectContext(dir);

  expect(result.sources).toEqual([
    { path: "GEMINI.md", family: "gemini", chars: "real content".length, truncated: false },
  ]);
  expect(result.text).toBe("\n\n## From GEMINI.md\nreal content");
  expect(result.text).not.toContain("AGENTS.md");
  expect(result.skippedFiles).toBe(0);

  cleanup(dir);
});

test("an .mdc file that is only frontmatter strips to blank and is skipped (LOW-6)", () => {
  const dir = tmpDir();
  write(dir, ".cursor/rules/only-fm.mdc", "---\ndescription: nothing else\n---\n");

  const result = loadProjectContext(dir);
  expect(result).toEqual({ text: "", sources: [], skippedFiles: 0 });

  cleanup(dir);
});

test("the frontmatter strip is gated to .mdc candidates: a non-mdc file starting with a --- block keeps it verbatim (FW2-Q)", () => {
  const dir = tmpDir();
  // Same leading block shape an .mdc would carry — but CLAUDE.md is not an
  // mdc candidate, so nothing may be stripped. Kills the strip-ALWAYS mutant
  // (deleting the `candidate.mdc ?` gate survived every other config test).
  const claude = "---\ndescription: looks like frontmatter\n---\nreal claude rules";
  write(dir, "CLAUDE.md", claude);
  write(dir, ".cursor/rules/x.mdc", "---\ndescription: real frontmatter\n---\nmdc body");

  const result = loadProjectContext(dir);

  expect(result.sources).toEqual([
    { path: "CLAUDE.md", family: "claude", chars: claude.length, truncated: false }, // full length: block kept
    { path: ".cursor/rules/x.mdc", family: "cursor", chars: "mdc body".length, truncated: false }, // stripped
  ]);
  expect(result.text).toContain("---\ndescription: looks like frontmatter\n---\nreal claude rules");
  expect(result.text).not.toContain("description: real frontmatter");

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
  const missing = join(tmpdir(), `rovecode-config-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let result: ProjectContext | undefined;
  expect(() => {
    result = loadProjectContext(missing, { stopAt: missing });
  }).not.toThrow();
  expect(result).toEqual({ text: "", sources: [], skippedFiles: 0 });
});

test("existing but empty cwd yields an empty result (every candidate skipped silently)", () => {
  const dir = tmpDir();

  const result = loadProjectContext(dir);
  expect(result).toEqual({ text: "", sources: [], skippedFiles: 0 });

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
