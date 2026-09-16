/** core/verify.ts — how rovecode knows what check this project runs, without guessing. Pinned: settings first
 *  (string, list, `false`, project over user, sanitised like the other keys); inference aims at the FAST check and
 *  only where the name AND the shape are recognised (typecheck/lint with a runner known to end; `check` only when
 *  it compiles or lints without running the suite; cargo check / go vet / ruff check); a test suite is never
 *  inferred, only configured; everything seen and not inferred is REFUSED with a reason a person can act on; the
 *  main path in Berkay's real projects is "none", so that text is pinned too; the doctor row names the cost. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";
import {
  describeVerify, formatDuration, lastVerifyTiming, NONE_REASON, NOTHING_HERE, recordVerifyTiming, resolveVerify,
  VERIFY_BLIND_SPOT, VERIFY_TIMING_FILE, verifyLabel, verifyLabelWithCost,
} from "../../src/core/verify.ts";
import { loadSettings } from "../../src/core/settings.ts";
import { runDoctor } from "../../src/cli/doctor.ts";

let cwd = "", home = "", savedHome: string | undefined;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-verify-cwd-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-verify-home-"));
  savedHome = process.env.ROVECODE_HOME; process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
// the project file is approved as written: `verify` is a command-bearing key and an UNTRUSTED project file's is dropped
// by the gate (test/unit/project-trust.test.ts pins that); these tests are about what a trusted file says
const project = (o: unknown) => { mkdirSync(join(cwd, ".rovecode"), { recursive: true }); writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify(o)); trustProjectFiles(cwd, home); };
const user = (o: unknown) => { writeFileSync(join(home, "settings.json"), JSON.stringify(o)); };
const LOCKS = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const pkg = (scripts: Record<string, string>, lock = "bun.lock") => {
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts }));
  for (const l of LOCKS) rmSync(join(cwd, l), { force: true });
  if (lock) writeFileSync(join(cwd, lock), "");
};

describe("configuration first", () => {
  test("a string, a list, project over user; `false` is off by choice and stops inference; junk is ignored like every other key", () => {
    pkg({ typecheck: "tsc --noEmit" });                                // inferable, but the key wins
    user({ verify: "make ci" });
    expect(resolveVerify(cwd)).toEqual({ source: "settings", commands: ["make ci"], reason: `${join(home, "settings.json")} verify`, refused: [] });
    project({ verify: ["bun run typecheck", "bun test"] });
    expect(resolveVerify(cwd)).toEqual({ source: "settings", commands: ["bun run typecheck", "bun test"], reason: `${join(cwd, ".rovecode", "settings.json")} verify`, refused: [] });
    project({ verify: false });
    expect(resolveVerify(cwd)).toEqual({ source: "none", commands: [], reason: "settings.json verify: false — the gate is off by choice, nothing is inferred", refused: [] });
    // sanitising: not a command → no key → inference runs
    user({});
    project({ verify: 42 });
    expect(loadSettings(cwd).verify).toBeUndefined();
    expect(resolveVerify(cwd).source).toBe("inferred");
    project({ verify: ["", "  ", 7, "bun test"] });
    expect(loadSettings(cwd).verify).toEqual(["bun test"]);
    project({ verify: "   " });
    expect(loadSettings(cwd).verify).toBeUndefined();
    project({ verify: "x".repeat(501) });
    expect(loadSettings(cwd).verify).toBeUndefined();
  });
});

describe("inference: the fast check, from a name we recognise in a shape we recognise, or nothing", () => {
  test("typecheck and lint are taken with a runner known to end, in that order; a `test` script is listed as never inferred", () => {
    pkg({ typecheck: "tsc --noEmit", lint: "eslint .", test: "bun test" });
    expect(resolveVerify(cwd)).toEqual({ source: "inferred", commands: ["bun run typecheck", "bun run lint"],
      reason: 'inferred from package.json script "typecheck" (bun.lock), package.json script "lint" (bun.lock)',
      refused: ['package.json script "test" runs `bun test`: a test suite is never inferred, only configured (the fast gate is a type-check; a suite can take minutes and may need services) — set `"verify": "bun run test"` in .rovecode/settings.json if it is quick enough here'] });
    pkg({ typecheck: "vue-tsc --noEmit -p tsconfig.app.json" });
    expect(resolveVerify(cwd).commands).toEqual(["bun run typecheck"]);
    pkg({ lint: "biome check ." }, "pnpm-lock.yaml");
    expect(resolveVerify(cwd).commands).toEqual(["pnpm run lint"]);
    // the name is not enough: an unrecognised body is refused by name, quoting it
    pkg({ typecheck: "./scripts/typecheck-and-deploy.sh", lint: "eslint . --fix --watch" }, "yarn.lock");
    expect(resolveVerify(cwd)).toEqual({ source: "none", commands: [], reason: NONE_REASON, refused: [
      'package.json script "typecheck" runs `./scripts/typecheck-and-deploy.sh`: not a type-checker this gate knows runs unattended and ends (tsc, vue-tsc, svelte-check) — set `"verify": "yarn typecheck"` in .rovecode/settings.json to run it anyway',
      'package.json script "lint" runs `eslint . --fix --watch`: a watch mode never exits, so it cannot gate a run',
    ] });
  });

  test("`check` is the fallback fast check when it only compiles or lints; the package manager comes from the lockfile", () => {
    pkg({ check: "tsc --noEmit && eslint ." });
    expect(resolveVerify(cwd)).toEqual({ source: "inferred", commands: ["bun run check"], reason: 'inferred from package.json script "check" (bun.lock)', refused: [] });
    rmSync(join(cwd, "bun.lock")); writeFileSync(join(cwd, "pnpm-lock.yaml"), "");
    expect(resolveVerify(cwd).commands).toEqual(["pnpm run check"]);
    rmSync(join(cwd, "pnpm-lock.yaml")); writeFileSync(join(cwd, "yarn.lock"), "");
    expect(resolveVerify(cwd).commands).toEqual(["yarn check"]);
    rmSync(join(cwd, "yarn.lock")); writeFileSync(join(cwd, "package-lock.json"), "");
    expect(resolveVerify(cwd).commands).toEqual(["npm run check"]);
    rmSync(join(cwd, "package-lock.json"));
    expect(resolveVerify(cwd).reason).toBe('inferred from package.json script "check" (no lockfile (npm assumed))');
    // when a faster script was already taken, `check` is not run on top of it
    pkg({ typecheck: "tsc --noEmit", check: "tsc --noEmit && eslint ." });
    const r = resolveVerify(cwd);
    expect(r.commands).toEqual(["bun run typecheck"]);
    expect(r.refused).toEqual(['package.json script "check" runs `tsc --noEmit && eslint .`: a faster script already covers it (package.json script "typecheck") — set `"verify": "bun run check"` in .rovecode/settings.json to run it instead']);
  });

  test("a `check` that runs the suite is the thorough gate: configured, never inferred, with the cost named — this repository's own", () => {
    pkg({ check: "node scripts/build-model-index.mjs --check && tsc --noEmit && bun test", test: "bun test", typecheck: "tsc --noEmit" });
    const r = resolveVerify(cwd);
    expect(r.commands).toEqual(["bun run typecheck"]);
    expect(r.refused).toEqual([
      'package.json script "check" runs `node scripts/build-model-index.mjs --check && tsc --noEmit && bun test`: it runs the test suite (`bun test`), which is minutes here rather than seconds; the thorough gate is configured, never inferred — set `"verify": "bun run check"` in .rovecode/settings.json if that cost is right for this project',
      'package.json script "test" runs `bun test`: a test suite is never inferred, only configured (the fast gate is a type-check; a suite can take minutes and may need services) — set `"verify": "bun run test"` in .rovecode/settings.json if it is quick enough here',
    ]);
    pkg({ check: "vitest run" });
    expect(resolveVerify(cwd)).toEqual({ source: "none", commands: [], reason: NONE_REASON, refused: [expect.stringContaining("it runs the test suite (`vitest`)")] });
  });

  test("a `check` whose body deploys, publishes, pushes or reaches the network is refused, quoting the body and the word; a watch mode too", () => {
    pkg({ check: "tsc --noEmit && npm publish" });
    expect(resolveVerify(cwd)).toEqual({ source: "none", commands: [], reason: NONE_REASON, refused: [
      'package.json script "check" runs `tsc --noEmit && npm publish`: it names `publish`, which a check must not do — set `"verify": "bun run check"` in .rovecode/settings.json if that is really what you want the gate to run',
    ] });
    pkg({ check: "tsc --noEmit --watch" });
    expect(resolveVerify(cwd).refused).toEqual(['package.json script "check" runs `tsc --noEmit --watch`: a watch mode never exits, so it cannot gate a run']);
    // the dangerous shape the feature exists to refuse: `npm test` that does something else — never inferred
    pkg({ test: "node scripts/deploy-and-test.js" }, "package-lock.json");
    const r = resolveVerify(cwd);
    expect(r.source).toBe("none");
    expect(r.refused).toEqual(['package.json script "test" runs `node scripts/deploy-and-test.js`: a test suite is never inferred, only configured (the fast gate is a type-check; a suite can take minutes and may need services) — set `"verify": "npm run test"` in .rovecode/settings.json if it is quick enough here']);
    pkg({ build: "tsc", start: "node ." });
    expect(resolveVerify(cwd).refused).toEqual(['package.json has no "typecheck", "lint", "check" or "test" script — name one, or set verify in .rovecode/settings.json']);
  });

  test("a broken package.json is a refusal, not a crash", () => {
    writeFileSync(join(cwd, "package.json"), "{ not json");
    const r = resolveVerify(cwd);
    expect(r.source).toBe("none");
    expect(r.refused[0]).toBe("package.json is not valid JSON — nothing inferred from it");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: ["bun test"] }));
    expect(resolveVerify(cwd).refused[0]).toBe('package.json: "scripts" is not an object — nothing inferred from it');
  });

  test("other ecosystems: only the compile/lint step is inferred and the test step is refused by name; Makefile targets never", () => {
    writeFileSync(join(cwd, "Cargo.toml"), "[package]\nname = \"x\"\n");
    let r = resolveVerify(cwd);
    expect(r.commands).toEqual(["cargo check"]);
    expect(r.reason).toBe("inferred from Cargo.toml");
    expect(r.refused).toEqual(["`cargo test` is not inferred: it runs the crate's tests, which may be slow or need services — set verify to run it"]);
    writeFileSync(join(cwd, "go.mod"), "module x\n");
    expect(resolveVerify(cwd).commands).toEqual(["cargo check", "go vet ./..."]);
    rmSync(join(cwd, "Cargo.toml")); rmSync(join(cwd, "go.mod"));
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"x\"\n");
    r = resolveVerify(cwd);
    expect(r.source).toBe("none");
    expect(r.refused).toEqual([
      "pyproject.toml without a [tool.ruff] section: no linter is configured that this gate knows — set verify (for example `ruff check .` or `pytest -q`) to run one",
      "`pytest` is not inferred: it runs the project's tests — set verify to run it",
    ]);
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"x\"\n[tool.ruff]\nline-length = 100\n");
    r = resolveVerify(cwd);
    expect(r.commands).toEqual(["ruff check ."]);
    expect(r.reason).toBe("inferred from pyproject.toml [tool.ruff]");
    writeFileSync(join(cwd, "Makefile"), "check:\n\tmake test\n");
    expect(resolveVerify(cwd).refused.at(-1)).toBe("a Makefile is here, but make targets are never inferred (a target can do anything) — set verify to `make check` or the target you mean");
  });

  test("the main path: a plain HTML/CSS/JS folder is none, said as the normal answer and not as a failure to infer", () => {
    writeFileSync(join(cwd, "index.html"), "<!doctype html>"); writeFileSync(join(cwd, "style.css"), "");
    expect(resolveVerify(cwd)).toEqual({ source: "none", commands: [], reason: NOTHING_HERE, refused: [] });
    expect(NOTHING_HERE).toBe("no package.json, Cargo.toml, go.mod or pyproject.toml here, so there is no compiler, linter or test runner to run; for a plain HTML/CSS/JS site that is the normal answer, and the gate stays off");
    expect(describeVerify(resolveVerify(cwd))).toBe(`none — ${NOTHING_HERE}`);
    // a Makefile alone: seen, refused, and the reason is the refusal rather than "nothing here"
    writeFileSync(join(cwd, "Makefile"), "all:\n");
    expect(resolveVerify(cwd).reason).toBe(NONE_REASON);
  });
});

describe("cost", () => {
  test("the gate records how long a command took here; the resolver reads it back; nothing is measured by the resolver itself", () => {
    expect(lastVerifyTiming(cwd, "bun run check")).toBeUndefined();
    recordVerifyTiming(cwd, "bun run check", 170_400, new Date("2026-09-06T21:00:00Z"));
    recordVerifyTiming(cwd, "bun run typecheck", 9_200);
    expect(lastVerifyTiming(cwd, "bun run check")).toBe(170_400);
    expect(JSON.parse(readFileSync(join(cwd, VERIFY_TIMING_FILE), "utf8"))["bun run check"]).toEqual({ ms: 170_400, at: "2026-09-06T21:00:00.000Z" });
    project({ verify: ["bun run typecheck", "bun run check", "bun test"] });
    const plan = resolveVerify(cwd);
    expect(verifyLabel(plan)).toBe("bun run typecheck  &&  bun run check  &&  bun test");
    expect(verifyLabelWithCost(cwd, plan)).toBe("bun run typecheck (9 s last time)  &&  bun run check (2 min 50 s last time)  &&  bun test (not run here yet)");
    // a corrupt file is an empty record, and recording over it repairs it
    writeFileSync(join(cwd, VERIFY_TIMING_FILE), "{ broken");
    expect(lastVerifyTiming(cwd, "bun run check")).toBeUndefined();
    recordVerifyTiming(cwd, "bun run check", 500);
    expect(lastVerifyTiming(cwd, "bun run check")).toBe(500);
    expect(existsSync(join(cwd, VERIFY_TIMING_FILE))).toBe(true);
  });

  test("durations as a person says them", () => {
    expect(formatDuration(300)).toBe("under a second");
    expect(formatDuration(3_400)).toBe("3 s");
    expect(formatDuration(119_600)).toBe("2 min");     // rounds to 120 s → 2 min
    expect(formatDuration(170_000)).toBe("2 min 50 s");
    expect(formatDuration(600_000)).toBe("10 min");
  });
});

describe("the doctor row", () => {
  const doctor = () => runDoctor({ cwd, home, env: { ROVECODE_HOME: home }, which: () => null, prereqEnv: { PATH: "", windows: false }, connect: false });
  const row = async () => (await doctor()).checks.find((c) => c.id === "verify")!;

  test("says what this project would run, at what cost, where that came from, and lists every refusal; configured is ok, inferred and none are notes", async () => {
    pkg({ check: "tsc --noEmit", test: "./everything.sh" });
    let r = await row();
    expect(r.status).toBe("note");
    expect(r.summary).toBe('bun run check (not run here yet) · inferred from package.json script "check" (bun.lock) — set `verify` in .rovecode/settings.json to pin or replace it');
    expect(r.detail).toEqual([
      'not inferred: package.json script "test" runs `./everything.sh`: a test suite is never inferred, only configured (the fast gate is a type-check; a suite can take minutes and may need services) — set `"verify": "bun run test"` in .rovecode/settings.json if it is quick enough here',
      VERIFY_BLIND_SPOT,
    ]);
    recordVerifyTiming(cwd, "bun run check", 3_100);
    expect((await row()).summary.startsWith("bun run check (3 s last time) · ")).toBe(true);
    pkg({ test: "./everything.sh" });
    r = await row();
    expect(r.status).toBe("note");
    expect(r.summary).toBe(`none · ${NONE_REASON}`);
    expect(r.detail).toEqual([expect.stringContaining('not inferred: package.json script "test" runs `./everything.sh`')]);
    project({ verify: "bun run check" });
    r = await row();
    expect(r.status).toBe("ok");
    expect(r.summary).toBe(`bun run check (3 s last time) · from ${join(cwd, ".rovecode", "settings.json")} verify`);
    expect(r.detail).toEqual([VERIFY_BLIND_SPOT]);
    expect((await doctor()).exitCode).toBe(0);                       // a missing gate is never a failure
  });

  test("the main path, as the row: a folder with nothing to run reads as the normal answer", async () => {
    writeFileSync(join(cwd, "index.html"), "<!doctype html>");
    const r = await row();
    expect(r.status).toBe("note");
    expect(r.summary).toBe(`none · ${NOTHING_HERE}`);
    expect(r.detail).toBeUndefined();
  });
});
