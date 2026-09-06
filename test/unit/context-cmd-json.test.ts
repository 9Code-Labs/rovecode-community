/** `rovecode context --json`: one document on stdout on EVERY exit, the failing ones included.
 *
 *  The --json sweep (2026-09-06) found the three early exits — no sessions here, an unknown id, no default
 *  model — wrote a sentence to stderr and nothing to stdout. A script that piped the report got "" and a 1.
 *  The market commands settled this long ago: stderr may carry prose, stdout carries the document. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cmdContext } from "../../src/cli/context-cmd.ts";
import { SessionStore } from "../../src/core/session.ts";

function harness(cwd: string, currentRef: () => { provider: string; model: string } | null) {
  const lines: string[] = []; const errs: string[] = [];
  return { lines, errs, deps: { cwd, currentRef, log: (l: string) => lines.push(l), err: (l: string) => errs.push(l) } };
}

test("no sessions, an unknown id, and no default model each put `{error}` on stdout with --json", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-ctx-json-"));
  try {
    const ref = () => ({ provider: "anthropic", model: "claude-opus-5" });
    const empty = harness(cwd, ref);
    expect(await cmdContext(["--json"], empty.deps)).toBe(1);
    expect(JSON.parse(empty.lines.join("\n"))).toEqual({ error: "no sessions here — run rovecode in this directory first" });
    expect(empty.errs.join("\n")).toContain("no sessions here");           // the prose is still there, on stderr

    const store = new SessionStore(join(cwd, ".rovecode", "sessions"), "real");
    store.append({ id: randomUUID(), role: "user", parts: [{ kind: "text", text: "count me" }], parentId: null, createdAt: Date.now() });

    const unknown = harness(cwd, ref);
    expect(await cmdContext(["nope", "--json"], unknown.deps)).toBe(1);
    expect((JSON.parse(unknown.lines.join("\n")) as { error: string }).error).toContain("no session nope here");

    const noModel = harness(cwd, () => null);
    expect(await cmdContext(["--json", "--no-runtime"], noModel.deps)).toBe(1);
    expect((JSON.parse(noModel.lines.join("\n")) as { error: string }).error).toContain("no default model");

    // and off --json nothing changed: stderr prose, empty stdout
    const plain = harness(cwd, () => null);
    expect(await cmdContext(["--no-runtime"], plain.deps)).toBe(1);
    expect(plain.lines).toEqual([]);
    expect(plain.errs.join("\n")).toContain("no default model");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
