/** What check this project runs before the agent's work counts as done — decided without ever guessing.
 *
 *  Berkay (2026-09-06): the CLI should govern its own work and catch its own mistakes before saying done. The
 *  loop's gate (core/verify-gate.ts, nimbus-99) runs a command after the last edit; THIS module decides which one,
 *  and it is the half that can do damage: a gate that runs the wrong command once — `npm test` that deploys,
 *  wipes a database, or takes twenty minutes — is turned off forever. Two measurements shaped it (nimbus-6f, same
 *  night): in Berkay's real projects (plain HTML/CSS/JS, no package.json) there is nothing to run at all, so
 *  "none" is the MAIN path and its text is what a person reads; and in a TypeScript project a type-check caught
 *  the same three constructed mistakes as the full suite in a tenth of the time (10 s against 170 s here). So:
 *
 *  1. Configuration first. `verify` in .rovecode/settings.json (project) or ~/.rovecode/settings.json (user),
 *     a command string or a list, project winning like every other key. This is the one source that needs
 *     no inference, and the ONLY way a test suite becomes the gate. `false` turns the gate off on purpose and
 *     stops the inference below as well.
 *  2. Inference second, aimed at the FAST check, and only where both the name and the shape are recognised:
 *     - package.json `typecheck` whose body is tsc; `lint` whose body is eslint, biome or oxlint. Name alone is
 *       not enough (a `lint` script may do anything); the body has to be a runner known to run unattended and end.
 *     - package.json `check`, only when neither of those was taken, and only when its body compiles or lints
 *       without running tests: a `check` that runs the suite is the thorough gate, and the thorough gate is
 *       configured, never inferred — the refusal names it and how to opt in.
 *     - Cargo.toml → `cargo check`; go.mod → `go vet ./...`; a ruff-configured Python project → `ruff check .`.
 *     - A `test` script, `cargo test`, `pytest`, Makefile targets: never inferred, always listed with the reason.
 *  3. Everything seen and NOT inferred goes into `refused`, in words specific enough that a person reads the
 *     line and either agrees or sets the key. "Nothing" is a good answer; "could not infer" is not.
 *
 *  The seam for the runner is `commands: string[]` it does not interpret, so per-file targeting ("tsc --noEmit"
 *  plus the tests that import the changed files) can be added here later without touching anything downstream.
 *  Pure apart from reading the files named above; never throws; never runs anything. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettingsScoped, settingsPath } from "./settings.ts";

export interface VerifyPlan {
  /** where the commands came from; "none" = the gate has nothing to run */
  source: "settings" | "inferred" | "none";
  /** the shell commands the gate runs, in order, uninterpreted; empty when source is "none" */
  commands: string[];
  /** one sentence: the file and key or script the answer came from, or why there is none */
  reason: string;
  /** what was seen and deliberately not inferred, each with its reason — the argument for trusting the gate */
  refused: string[];
}

export interface VerifyDeps {
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
}

/** words in a `check` script's body that mean it is not a check */
const DANGEROUS = /\b(deploy|publish|release|push|migrate|drop|rm\s+-rf|docker|kubectl|terraform|curl|wget|ssh|scp|rsync)\b/i;
/** a body that keeps running until killed — never a gate */
const WATCH = /(^|\s)(--watch(=\S*)?|-w|--watchAll)(\s|$)|\bnodemon\b|\bvitest\s*$/;
/** a body that runs a test suite — the thorough gate, configured only */
const RUNS_TESTS = /\b(bun test|vitest|jest|mocha|node --test|playwright test|cypress run|ava|tap|uvu)\b/;
/** runners whose bare invocation runs once, unattended, and exits */
const TYPECHECK_RUNNER = /^(bunx |npx |pnpm exec |yarn )?(tsc|vue-tsc|svelte-check)(\s|$)/;
const LINT_RUNNER = /^(bunx |npx |pnpm exec |yarn )?(eslint|biome (check|lint)|oxlint)(\s|$)/;

/** the package manager the lockfile says this project uses; npm when none says */
function packageRunner(cwd: string, exists: (p: string) => boolean): { run: string; from: string } {
  if (exists(join(cwd, "bun.lock")) || exists(join(cwd, "bun.lockb"))) return { run: "bun run", from: "bun.lock" };
  if (exists(join(cwd, "pnpm-lock.yaml"))) return { run: "pnpm run", from: "pnpm-lock.yaml" };
  if (exists(join(cwd, "yarn.lock"))) return { run: "yarn", from: "yarn.lock" };
  if (exists(join(cwd, "package-lock.json"))) return { run: "npm run", from: "package-lock.json" };
  return { run: "npm run", from: "no lockfile (npm assumed)" };
}

export const NONE_REASON = "nothing configured and nothing fast and safe to infer — set verify in .rovecode/settings.json (a command, or a list) to turn the gate on";
export const NOTHING_HERE = "no package.json, Cargo.toml, go.mod or pyproject.toml here, so there is no compiler, linter or test runner to run; for a plain HTML/CSS/JS site that is the normal answer, and the gate stays off";

/** Resolve this project's verify command(s). */
export function resolveVerify(cwd: string, deps: VerifyDeps = {}): VerifyPlan {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));

  // 1. configuration
  // loadSettingsScoped already applied the trust gate: an UNTRUSTED project file's `verify` is not here (core/settings.ts
  // COMMAND_KEYS) — a cloned repo does not choose the command this gate runs. `verify: false` is honoured from any file.
  const scoped = loadSettingsScoped(cwd);
  const settings = { ...scoped.user, ...scoped.project };
  if (settings.verify === false) {
    return { source: "none", commands: [], reason: "settings.json verify: false — the gate is off by choice, nothing is inferred", refused: [] };
  }
  if (settings.verify !== undefined) {
    const commands = Array.isArray(settings.verify) ? settings.verify : [settings.verify];
    const where = scoped.project.verify !== undefined ? scoped.projectPath : settingsPath("user", cwd);
    return { source: "settings", commands, reason: `${where} verify`, refused: [] };
  }

  // 2. inference
  const commands: string[] = [];
  const from: string[] = [];
  const refused: string[] = [];

  const pkgPath = join(cwd, "package.json");
  if (exists(pkgPath)) {
    let scripts: Record<string, string> = {};
    let ok = true;
    try {
      const raw = JSON.parse(read(pkgPath)) as { scripts?: unknown };
      const s = raw.scripts;
      if (s !== undefined && (typeof s !== "object" || s === null || Array.isArray(s))) { refused.push('package.json: "scripts" is not an object — nothing inferred from it'); ok = false; }
      else if (s) for (const [k, v] of Object.entries(s as Record<string, unknown>)) if (typeof v === "string") scripts[k] = v;
    } catch { refused.push("package.json is not valid JSON — nothing inferred from it"); ok = false; scripts = {}; }
    if (ok) {
      const pm = packageRunner(cwd, exists);
      const body = (name: string): string => scripts[name]!.trim();
      const optIn = (name: string) => `set \`"verify": "${pm.run} ${name}"\` in .rovecode/settings.json`;

      // the fast checks: a recognised runner, or a refusal that quotes the body
      const take = (name: string, runner: RegExp, what: string, known: string): void => {
        if (scripts[name] === undefined) return;
        const b = body(name);
        if (WATCH.test(b)) { refused.push(`package.json script "${name}" runs \`${b}\`: a watch mode never exits, so it cannot gate a run`); return; }
        if (!runner.test(b)) { refused.push(`package.json script "${name}" runs \`${b}\`: not a ${what} this gate knows runs unattended and ends (${known}) — ${optIn(name)} to run it anyway`); return; }
        commands.push(`${pm.run} ${name}`); from.push(`package.json script "${name}" (${pm.from})`);
      };
      take("typecheck", TYPECHECK_RUNNER, "type-checker", "tsc, vue-tsc, svelte-check");
      take("lint", LINT_RUNNER, "linter", "eslint, biome check, oxlint");

      // `check`: the convention means "verify, change nothing" — taken as the fallback fast check when it only
      // compiles or lints; refused, with the cost named, when it runs the suite or does anything a check must not
      if (scripts.check !== undefined) {
        const b = body("check");
        const bad = DANGEROUS.exec(b);
        const tests = RUNS_TESTS.exec(b);
        if (bad) refused.push(`package.json script "check" runs \`${b}\`: it names \`${bad[1]}\`, which a check must not do — ${optIn("check")} if that is really what you want the gate to run`);
        else if (WATCH.test(b)) refused.push(`package.json script "check" runs \`${b}\`: a watch mode never exits, so it cannot gate a run`);
        else if (tests) refused.push(`package.json script "check" runs \`${b}\`: it runs the test suite (\`${tests[1]}\`), which is minutes here rather than seconds; the thorough gate is configured, never inferred — ${optIn("check")} if that cost is right for this project`);
        else if (commands.length > 0) refused.push(`package.json script "check" runs \`${b}\`: a faster script already covers it (${from.map((f) => f.split(" (")[0]).join(", ")}) — ${optIn("check")} to run it instead`);
        else { commands.push(`${pm.run} check`); from.push(`package.json script "check" (${pm.from})`); }
      }

      // `test`: never inferred — the name promises nothing about the body, and a suite is the slow gate
      if (scripts.test !== undefined) {
        const b = body("test");
        refused.push(`package.json script "test" runs \`${b}\`: a test suite is never inferred, only configured (the fast gate is a type-check; a suite can take minutes and may need services) — ${optIn("test")} if it is quick enough here`);
      }
      if (commands.length === 0 && refused.length === 0) refused.push('package.json has no "typecheck", "lint", "check" or "test" script — name one, or set verify in .rovecode/settings.json');
    }
  }

  if (exists(join(cwd, "Cargo.toml"))) {
    commands.push("cargo check"); from.push("Cargo.toml");
    refused.push("`cargo test` is not inferred: it runs the crate's tests, which may be slow or need services — set verify to run it");
  }
  if (exists(join(cwd, "go.mod"))) {
    commands.push("go vet ./..."); from.push("go.mod");
    refused.push("`go test ./...` is not inferred: it runs the module's tests — set verify to run it");
  }
  const pyproject = join(cwd, "pyproject.toml");
  if (exists(pyproject) || exists(join(cwd, "ruff.toml"))) {
    const ruffToml = exists(join(cwd, "ruff.toml"));
    let ruff = ruffToml;
    if (!ruff && exists(pyproject)) { try { ruff = /^\[tool\.ruff(\.|\])/m.test(read(pyproject)); } catch { /* unreadable: no ruff */ } }
    if (ruff) { commands.push("ruff check ."); from.push(ruffToml ? "ruff.toml" : "pyproject.toml [tool.ruff]"); }
    else refused.push("pyproject.toml without a [tool.ruff] section: no linter is configured that this gate knows — set verify (for example `ruff check .` or `pytest -q`) to run one");
    refused.push("`pytest` is not inferred: it runs the project's tests — set verify to run it");
  }
  if (exists(join(cwd, "Makefile")) || exists(join(cwd, "makefile"))) {
    refused.push("a Makefile is here, but make targets are never inferred (a target can do anything) — set verify to `make check` or the target you mean");
  }

  if (commands.length > 0) {
    return { source: "inferred", commands, reason: `inferred from ${from.join(", ")}`, refused };
  }
  if (refused.length === 0) return { source: "none", commands: [], reason: NOTHING_HERE, refused: [] };
  return { source: "none", commands: [], reason: NONE_REASON, refused };
}


/** the commands as one label — the SAME words in the doctor row and in the loop's `verify` RunEvent ("running
 *  bun run check  &&  bun test"), so a person sees one name for one thing */
export function verifyLabel(plan: VerifyPlan): string {
  return plan.commands.join("  &&  ");
}

/** one line for `rovecode doctor` and the settings docs */
export function describeVerify(plan: VerifyPlan): string {
  if (plan.source === "none") return `none — ${plan.reason}`;
  return `${verifyLabel(plan)} — ${plan.reason}`;
}

/** what the gate does NOT see, said wherever the gate is described (doctor, README): the loop counts edits made
 *  through `edit` and `write`; a run that changed files only through `bash` has no counted write, so it is not
 *  verified. Owned here so the doctor row and the docs cannot drift apart. */
export const VERIFY_BLIND_SPOT = "runs after edits made with `edit` or `write`; a run that changed files only through `bash` is not counted, so it is not verified";

// ---- cost: a check's duration is the fact that makes the doctor row honest ("bun run check, 170 s last time").
// The resolver never runs anything, so it cannot measure; the gate can, and records here after each run. Project-local
// because the same command costs different amounts in different repos; one small file, one entry per command.

export const VERIFY_TIMING_FILE = join(".rovecode", "verify-timing.json");
type Timings = Record<string, { ms: number; at: string }>;

function readTimings(cwd: string): Timings {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, VERIFY_TIMING_FILE), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Timings = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as { ms?: unknown }).ms === "number" && typeof (v as { at?: unknown }).at === "string") out[k] = v as { ms: number; at: string };
    }
    return out;
  } catch { return {}; }
}

/** for the gate: remember how long `command` took in this project. Never throws (a timing is not worth a crash). */
export function recordVerifyTiming(cwd: string, command: string, ms: number, now: Date = new Date()): void {
  try {
    const t = readTimings(cwd);
    t[command] = { ms: Math.max(0, Math.round(ms)), at: now.toISOString() };
    mkdirSync(join(cwd, ".rovecode"), { recursive: true });
    writeFileSync(join(cwd, VERIFY_TIMING_FILE), JSON.stringify(t, null, 2) + "\n");
  } catch { /* a timing is not worth a crash */ }
}

/** the last measured duration of `command` here, or undefined when it has not run yet */
export function lastVerifyTiming(cwd: string, command: string): number | undefined {
  return readTimings(cwd)[command]?.ms;
}

/** "3 s" / "170 s" / "2 min 50 s" — the cost as a person says it */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under a second";
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

/** the label with each command's last cost when known: "bun run typecheck (9 s)  &&  bun test (not run yet)" */
export function verifyLabelWithCost(cwd: string, plan: VerifyPlan): string {
  return plan.commands.map((c) => { const ms = lastVerifyTiming(cwd, c); return ms === undefined ? `${c} (not run here yet)` : `${c} (${formatDuration(ms)} last time)`; }).join("  &&  ");
}
