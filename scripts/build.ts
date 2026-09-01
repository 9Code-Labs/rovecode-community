/** PORT #36 — single-binary build + smoke gate.
 *
 *  `bun run scripts/build.ts` (= `bun run build`):
 *    1. bun build --compile src/cli/main.ts --outfile dist/aion[.exe]
 *    2. smokes the BINARY (not the source tree):
 *       a. --version prints exactly package.json's version
 *       b. --help exits 0 and prints usage
 *       c. one-shot `run` in a fresh temp dir with AION_* and *_API_KEY scrubbed
 *          from the env — must take the mock-provider path and exit 0 (proves
 *          the full createRuntime→agentLoop pipeline works inside the binary,
 *          including the embedded @ast-grep/napi native addon)
 *
 *  The compile is deliberately NOT part of `bun test` (too slow for the suite);
 *  test/integration/packaging.test.ts covers the package invariants instead.
 *  Exit code: 0 only when the build and all three smokes pass. */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

const root = resolve(import.meta.dir, "..");
const outfile = join(root, "dist", process.platform === "win32" ? "aion.exe" : "aion");

/** Host env minus provider credentials — a host AION_BASE_URL or any *_API_KEY
 *  would flip resolveProvider() to a real endpoint and break smoke (c), the
 *  same hermeticity hazard the wave-2 /cost e2e hit (PORTS.md port #6 r2). */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^AION_/i.test(k) || /_API_KEY$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

interface Run { exitCode: number; stdout: string; stderr: string }
function run(cmd: string[], opts: { cwd?: string } = {}): Run {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? root, env: scrubbedEnv(), stdout: "pipe", stderr: "pipe" });
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
check("--help", help.exitCode === 0 && help.stdout.includes("commands:") && help.stdout.includes("aion"),
  `exit=${help.exitCode} stdout=${JSON.stringify(help.stdout.slice(0, 120))}`);

// 2c. one-shot mock run -------------------------------------------------
// Fresh temp cwd: keeps .aion/ session/checkpoint artifacts out of the repo
// and guarantees no .aion/mcp.json / project config is picked up.
const smokeDir = mkdtempSync(join(tmpdir(), "aion-smoke-"));
try {
  const oneShot = run([outfile, "run", "packaging smoke"], { cwd: smokeDir });
  check("one-shot mock run",
    oneShot.exitCode === 0 && oneShot.stdout.includes("Aion mock provider"),
    `exit=${oneShot.exitCode} stdout=${JSON.stringify(oneShot.stdout.slice(0, 200))} stderr=${JSON.stringify(oneShot.stderr.slice(0, 200))}`);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nbuild smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nbuild smoke: all green — ${outfile} v${pkg.version}`);
