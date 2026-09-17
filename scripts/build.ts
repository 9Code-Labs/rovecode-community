/** Single-binary build + hermetic smoke gate.
 *
 * The binary is tested without credentials or network: version/help, typo guard,
 * fail-closed no-provider run, and the deterministic terminal render smoke. */

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
check("--help", help.exitCode === 0 && help.stdout.includes("rovecode — a coding agent") && help.stdout.includes("start here"),
  `exit=${help.exitCode} stdout=${JSON.stringify(help.stdout.slice(0, 120))}`);

// 2c. typo guard + fail-closed offline run -------------------------------
const smokeDir = mkdtempSync(join(tmpdir(), "rovecode-smoke-"));
try {
  const home = join(smokeDir, ".rovecode-home");
  const typo = run([outfile, "doctor", "--definitely-not-a-real-flag"], { cwd: smokeDir, env: { ROVECODE_HOME: home } });
  check("typo guard", typo.exitCode === 2 && /unknown (flag|command)/i.test(typo.stderr),
    `exit=${typo.exitCode} stderr=${JSON.stringify(typo.stderr.slice(0, 200))}`);
  const offline = run([outfile, "run", "offline packaging smoke"], { cwd: smokeDir, env: { ROVECODE_HOME: home } });
  check("offline no-provider fails closed without network", offline.exitCode === 2 && /no provider configured/i.test(offline.stderr),
    `exit=${offline.exitCode} stdout=${JSON.stringify(offline.stdout.slice(0, 100))} stderr=${JSON.stringify(offline.stderr.slice(0, 200))}`);
  const tui = run([outfile, "smoke-tui", "--sextant"], { cwd: smokeDir, env: { ROVECODE_HOME: home } });
  check("terminal receiver render smoke", tui.exitCode === 0 && tui.stdout.includes("smoke-tui --sextant: PASS") && tui.stdout.includes("╭────────────╮"),
    `exit=${tui.exitCode} stdout=${JSON.stringify(tui.stdout.slice(-200))}`);
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nbuild smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nbuild smoke: all green — ${outfile} v${pkg.version}`);
