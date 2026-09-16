/** PORT #27 sandbox rung config: `.rovecode/sandbox.json` < `ROVECODE_SANDBOX` env <
 *  `direct` default; an unknown rung, a malformed file or a bad image is a
 *  SandboxConfigError with ONE actionable line — never a silent degrade to
 *  direct (that would be the fallback down the ladder #10 forbids). Pure
 *  fs + env-map tests; the boot wiring lives in
 *  test/integration/runtime-sandbox.test.ts. */

import { test, expect } from "bun:test";
import {
  loadSandboxConfig, SandboxConfigError, unavailableRungError, describeSandbox,
  SANDBOX_FILE, SANDBOX_ENV, SANDBOX_IMAGE_ENV,
} from "../../src/core/sandbox-config.ts";
import { DEFAULT_DOCKER_IMAGE, RungUnavailableError } from "../../src/core/executor.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";

function tmpCwd(): string { return mkdtempSync(join(tmpdir(), "rovecode-sbx-")); }
/** a project sandbox.json, approved as written in the test home (since 2026-09-07 an untrusted one contributes nothing —
 *  test/unit/project-trust.test.ts pins that; these tests are about what a trusted file says) */
function withFile(cwd: string, body: string): void {
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "sandbox.json"), body);
  trustProjectFiles(cwd);
}
/** Every load below passes an explicit env map: the host's ROVECODE_SANDBOX must
 *  never steer these tests (the process.env default is pinned once, below). */
const NONE = {};

function thrown(fn: () => unknown): SandboxConfigError {
  try { fn(); } catch (e) { return e as SandboxConfigError; }
  throw new Error("expected a throw");
}

/** The startup-error contract: typed, named, ONE line, actionable. */
function expectOneLine(err: SandboxConfigError): void {
  expect(err).toBeInstanceOf(SandboxConfigError);
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("SandboxConfigError");
  expect(err.message).not.toMatch(/[\r\n]/);
  expect(err.message).not.toContain("    at ");
  expect(err.message).toContain("default: direct"); // the fix is always stated
}

// ---------- precedence: default < file < env ----------

test("default: no file, no env → direct from default, no dockerImage key", () => {
  const cwd = tmpCwd();
  try {
    expect(loadSandboxConfig(cwd, NONE)).toEqual({ rung: "direct", source: "default" });
    mkdirSync(join(cwd, ".rovecode"), { recursive: true }); // an .rovecode dir without the file is still the default
    expect(loadSandboxConfig(cwd, NONE)).toEqual({ rung: "direct", source: "default" });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("file: rung wsl + dockerImage → both, source file; names are trimmed + lower-cased", () => {
  const cwd = tmpCwd();
  try {
    withFile(cwd, JSON.stringify({ rung: " WSL ", dockerImage: " rovecode/dev:1 " }));
    expect(loadSandboxConfig(cwd, NONE)).toEqual({ rung: "wsl", dockerImage: "rovecode/dev:1", source: "file" });
    // docker without an image resolves the executor's default (what will actually run)
    withFile(cwd, JSON.stringify({ rung: "docker" }));
    expect(loadSandboxConfig(cwd, NONE)).toEqual({ rung: "docker", dockerImage: DEFAULT_DOCKER_IMAGE, source: "file" });
    // an image-only file keeps the default rung
    withFile(cwd, JSON.stringify({ dockerImage: "x/y:1" }));
    expect(loadSandboxConfig(cwd, NONE)).toEqual({ rung: "direct", dockerImage: "x/y:1", source: "default" });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("env: ROVECODE_SANDBOX beats the file's rung, ROVECODE_SANDBOX_IMAGE beats its image; blank env falls through", () => {
  const cwd = tmpCwd();
  try {
    withFile(cwd, JSON.stringify({ rung: "wsl", dockerImage: "file/img:1" }));
    // env rung + file image
    expect(loadSandboxConfig(cwd, { ROVECODE_SANDBOX: "docker" })).toEqual({ rung: "docker", dockerImage: "file/img:1", source: "env" });
    // env image wins over the file image
    expect(loadSandboxConfig(cwd, { ROVECODE_SANDBOX: "docker", ROVECODE_SANDBOX_IMAGE: "env/img:2" }))
      .toEqual({ rung: "docker", dockerImage: "env/img:2", source: "env" });
    // blank / whitespace env is "unset": the file rules
    expect(loadSandboxConfig(cwd, { ROVECODE_SANDBOX: "  ", ROVECODE_SANDBOX_IMAGE: "" })).toEqual({ rung: "wsl", dockerImage: "file/img:1", source: "file" });
    expect(loadSandboxConfig(cwd, { ROVECODE_SANDBOX: " Direct " })).toEqual({ rung: "direct", dockerImage: "file/img:1", source: "env" });
    // override semantics: the file's rung is not even consulted when env sets one
    withFile(cwd, JSON.stringify({ rung: "bubblewrap" }));
    expect(loadSandboxConfig(cwd, { ROVECODE_SANDBOX: "direct" })).toEqual({ rung: "direct", source: "env" });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the env parameter defaults to process.env", () => {
  const cwd = tmpCwd();
  const saved = { rung: process.env.ROVECODE_SANDBOX, image: process.env.ROVECODE_SANDBOX_IMAGE };
  try {
    process.env.ROVECODE_SANDBOX = "docker";
    process.env.ROVECODE_SANDBOX_IMAGE = "proc/env:3";
    expect(loadSandboxConfig(cwd)).toEqual({ rung: "docker", dockerImage: "proc/env:3", source: "env" });
  } finally {
    if (saved.rung === undefined) delete process.env.ROVECODE_SANDBOX; else process.env.ROVECODE_SANDBOX = saved.rung;
    if (saved.image === undefined) delete process.env.ROVECODE_SANDBOX_IMAGE; else process.env.ROVECODE_SANDBOX_IMAGE = saved.image;
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- errors: typed, one line, actionable — never a silent direct ----------

test("unknown rung in the file → SandboxConfigError naming the value, the rungs and the file", () => {
  const cwd = tmpCwd();
  try {
    withFile(cwd, JSON.stringify({ rung: "bubblewrap" }));
    const err = thrown(() => loadSandboxConfig(cwd, NONE));
    expectOneLine(err);
    expect(err.message).toContain('"bubblewrap"');
    expect(err.message).toContain("direct, wsl, docker");
    expect(err.message).toContain(join(cwd, ".rovecode", "sandbox.json")); // where the bad value lives
    // a non-string rung is just as unknown
    withFile(cwd, JSON.stringify({ rung: 5 }));
    const num = thrown(() => loadSandboxConfig(cwd, NONE));
    expectOneLine(num);
    expect(num.message).toContain("is not a rung");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unknown rung via env → the message names ROVECODE_SANDBOX", () => {
  const cwd = tmpCwd();
  try {
    const err = thrown(() => loadSandboxConfig(cwd, { ROVECODE_SANDBOX: "seatbelt" }));
    expectOneLine(err);
    expect(err.message).toContain('"seatbelt"');
    expect(err.message).toContain("from ROVECODE_SANDBOX");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("malformed JSON / non-object file → error, even when env would override (intent unreadable)", () => {
  const cwd = tmpCwd();
  try {
    withFile(cwd, '{ "rung": "wsl"');
    const bad = thrown(() => loadSandboxConfig(cwd, NONE));
    expectOneLine(bad);
    expect(bad.message).toContain("is not valid JSON");
    expect(bad.message).toContain(join(cwd, ".rovecode", "sandbox.json"));
    expect(thrown(() => loadSandboxConfig(cwd, { ROVECODE_SANDBOX: "direct" })).message).toContain("is not valid JSON");
    for (const body of ["[1]", '"wsl"', "null", "42"]) {
      withFile(cwd, body);
      const err = thrown(() => loadSandboxConfig(cwd, NONE));
      expectOneLine(err);
      expect(err.message).toContain("must be a JSON object");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("bad dockerImage (empty / non-string) → error", () => {
  const cwd = tmpCwd();
  try {
    for (const image of ["", "   ", 3, null]) {
      withFile(cwd, JSON.stringify({ rung: "docker", dockerImage: image }));
      const err = thrown(() => loadSandboxConfig(cwd, NONE));
      expectOneLine(err);
      expect(err.message).toContain("dockerImage");
      expect(err.message).toContain("non-empty string");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- unavailable rung → the same one-line class ----------

test("unavailableRungError: rung, origin, probe detail and the fix on ONE line; cause preserved", () => {
  const cause = new RungUnavailableError("wsl", "wsl trial (wsl.exe --exec bash -c true) exited 1:\n  execvpe(bash) failed: No such file or directory");
  const err = unavailableRungError({ rung: "wsl", source: "file" }, cause);
  expectOneLine(err);
  expect(err.message).toContain('sandbox rung "wsl"');
  expect(err.message).toContain("from .rovecode/sandbox.json");
  expect(err.message).toContain("unavailable");
  expect(err.message).toContain("execvpe(bash) failed: No such file or directory"); // the detail, newline collapsed
  expect(err.cause).toBe(cause);
  // env origin + a non-RungUnavailableError cause
  const env = unavailableRungError({ rung: "docker", dockerImage: "x:1", source: "env" }, new Error("spawn exploded"));
  expect(env.message).toContain("from ROVECODE_SANDBOX");
  expect(env.message).toContain("spawn exploded");
  expect(unavailableRungError({ rung: "docker", source: "default" }, "weird").message).toContain("weird");
});

// ---------- /status rendering ----------

test("describeSandbox: rung + origin, image shown for docker only; constants pinned", () => {
  expect(describeSandbox({ rung: "direct", source: "default" })).toBe("direct (default)");
  expect(describeSandbox({ rung: "wsl", source: "file" })).toBe("wsl (.rovecode/sandbox.json)");
  expect(describeSandbox({ rung: "wsl", dockerImage: "ignored:1", source: "file" })).toBe("wsl (.rovecode/sandbox.json)");
  expect(describeSandbox({ rung: "docker", dockerImage: "rovecode/dev:1", source: "env" })).toBe("docker rovecode/dev:1 (ROVECODE_SANDBOX)");
  expect(describeSandbox({ rung: "docker", source: "file" })).toBe(`docker ${DEFAULT_DOCKER_IMAGE} (.rovecode/sandbox.json)`);
  expect(SANDBOX_FILE).toBe(".rovecode/sandbox.json");
  expect(SANDBOX_ENV).toBe("ROVECODE_SANDBOX");
  expect(SANDBOX_IMAGE_ENV).toBe("ROVECODE_SANDBOX_IMAGE");
});
