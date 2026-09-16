/** PORT #36 — single-binary build + smoke gate.
 *
 *  `bun run scripts/build.ts` (= `bun run build`):
 *    1. bun build --compile src/cli/main.ts --outfile dist/rovecode[.exe]
 *    2. smokes the BINARY (not the source tree):
 *       a. --version prints exactly package.json's version
 *       b. --help exits 0 and prints usage
 *       c. one-shot `run` in a fresh temp workspace — git-initialised, holding
 *          one small .ts file — with ROVECODE_* and *_API_KEY scrubbed from the env
 *          and ROVECODE_HOME pointed at an empty dir (a host `rovecode auth set`
 *          credential beats env, port #37, and would steer resolveProvider onto
 *          a real endpoint): must take the mock-provider path and exit 0 AND
 *          leave a repo-map tags
 *          cache naming that file's symbol. That proves the createRuntime→
 *          agentLoop pipeline works inside the binary and that the embedded
 *          @ast-grep/napi native addon actually PARSED source (an empty dir only
 *          showed it loaded; runtime.ts swallows extraction failures into a null
 *          chunk, so the persisted cache is the one observable).
 *
 *  The compile is deliberately NOT part of `bun test` (too slow for the suite);
 *  test/integration/packaging.test.ts covers the package invariants instead.
 *  Exit code: 0 only when the build and all three smokes pass. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

const root = resolve(import.meta.dir, "..");
const outfile = join(root, "dist", process.platform === "win32" ? "rovecode.exe" : "rovecode");

/** Host env minus provider credentials — a host ROVECODE_BASE_URL or any *_API_KEY
 *  would flip resolveProvider() to a real endpoint and break smoke (c), the
 *  same hermeticity hazard the wave-2 /cost e2e hit (PORTS.md port #6 r2). */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^ROVECODE_/i.test(k) || /_API_KEY$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

interface Run { exitCode: number; stdout: string; stderr: string }
function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Run {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? root, env: { ...scrubbedEnv(), ...opts.env }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// 1. compile ------------------------------------------------------------
console.log(`build: bun build --compile src/cli/main.ts --outfile ${outfile}`);
const build = run([process.execPath, "build", "--compile", "src/cli/main.ts", "--outfile", outfile]);
if (build.exitCode !== 0) {
  console.error(`FAIL  compile exited ${build.exitCode}\n${build.stdout}\n${build.stderr}`);
  process.exit(1);
}
const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`built ${outfile} (${mb} MB — bun runtime + bundled deps + embedded native addons)`);

// 2a. --version ---------------------------------------------------------
const ver = run([outfile, "--version"]);
check("--version", ver.exitCode === 0 && ver.stdout.trim() === pkg.version,
  `exit=${ver.exitCode} stdout=${JSON.stringify(ver.stdout.trim())} want ${pkg.version}`);

// 2b. --help ------------------------------------------------------------
const help = run([outfile, "--help"]);
check("--help", help.exitCode === 0 && help.stdout.includes("commands:") && help.stdout.includes("rovecode"),
  `exit=${help.exitCode} stdout=${JSON.stringify(help.stdout.slice(0, 120))}`);

// 2c. one-shot mock run + repo-map extraction ---------------------------
// Fresh temp cwd: keeps .rovecode/ session/checkpoint artifacts out of the repo
// and guarantees no .rovecode/mcp.json / project config is picked up. It is a
// REAL (tiny) workspace: the repo map only builds when source files exist, and
// `git init` exercises the git ls-files enumeration path the binary uses.
// ROVECODE_HOME → an empty dir beside it: the user-scope credential store must not
// leak in (the env scrub cannot see ~/.rovecode/credentials.json).
const smokeDir = mkdtempSync(join(tmpdir(), "rovecode-smoke-"));
try {
  const PROBE_SYMBOL = "smokeProbeSymbol";
  writeFileSync(join(smokeDir, "probe.ts"), `export function ${PROBE_SYMBOL}(): number { return 42; }\n`);
  const gi = Bun.spawnSync(["git", "init", "-q"], { cwd: smokeDir, stdout: "pipe", stderr: "pipe" });
  if (gi.exitCode !== 0) console.warn("warn: git init failed in the smoke dir — enumeration falls back to the walk");
  const oneShot = run([outfile, "run", "packaging smoke"], { cwd: smokeDir, env: { ROVECODE_HOME: join(smokeDir, ".rovecode-home") } });
  // the tags cache is persisted only after a successful extraction over probe.ts
  const cachePath = join(smokeDir, ".rovecode", "cache", "repomap.json");
  const cache = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : "";
  check("one-shot mock run + repo-map extraction",
    oneShot.exitCode === 0 && oneShot.stdout.includes("Rovecode mock provider") && cache.includes(PROBE_SYMBOL),
    `exit=${oneShot.exitCode} stdout=${JSON.stringify(oneShot.stdout.slice(0, 200))} stderr=${JSON.stringify(oneShot.stderr.slice(0, 200))}`
    + ` cache=${cache ? JSON.stringify(cache.slice(0, 200)) : "(absent)"}`);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nbuild smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nbuild smoke: all green — ${outfile} v${pkg.version}`);
