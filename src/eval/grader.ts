/**
 * Patch/test-based graders (eval P0-2).
 *
 * The gauntlet's string-contains verify is deterministic-by-construction but it scores
 * words, not work. These graders score the WORKSPACE: a fixture snapshot (trajectory.ts
 * snapshotFixture) is the baseline, and each spec checks a real end state — file content
 * changed relative to the baseline, a regex the new content must satisfy, or a test
 * command that must exit green inside the workspace. Specs are JSON-serializable so a
 * recorded trajectory can re-run them on replay.
 *
 * The composite gate (eval P0-2's teeth): a grader set of ONLY final-text specs is a
 * configuration error. String-contains on the model's own words can corroborate a
 * behavioral check (advisory), but it can never be the success criterion. The existing
 * deterministic gauntlet is untouched — this is the optional, composable layer on top.
 */

import { readFileSync } from "node:fs";
import { createTwoFilesPatch } from "diff";
import { join } from "node:path";
import type { FixtureSpec } from "./trajectory.ts";
import type { GauntletTranscript } from "./gauntlet.ts";

export type GraderSpec =
  | { type: "file-equals"; path: string; content: string }
  | { type: "file-matches"; path: string; pattern: string; flags?: string }
  | { type: "file-changed"; path: string; mustMatch?: string; mustNotMatch?: string; flags?: string }
  | { type: "command"; command: string; args?: string[]; expectExit?: number; timeoutMs?: number }
  | { type: "final-text"; pattern: string; flags?: string };

export interface GraderContext {
  workspace: string;
  /** the pre-run snapshot — file-changed's baseline */
  fixture: FixtureSpec;
  transcript: Pick<GauntletTranscript, "finalText" | "toolCalls" | "events" | "recovered">;
}

export interface GraderOutcome {
  spec: GraderSpec;
  name: string;
  pass: boolean;
  detail: string;
  /** true = recorded but NEVER sufficient (final-text); false = strict */
  advisory: boolean;
}

export class GraderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderConfigError";
  }
}

function specName(spec: GraderSpec): string {
  switch (spec.type) {
    case "file-equals":
    case "file-matches":
    case "file-changed":
      return `${spec.type}:${spec.path}`;
    case "command":
      return `command:${spec.command}`;
    case "final-text":
      return "final-text";
  }
}

/** Only final-text is advisory; everything else judges the workspace or a real process. */
export function isBehavioral(spec: GraderSpec): boolean {
  return spec.type !== "final-text";
}

export type GraderValidation = { ok: true } | { ok: false; reason: string };

/** A grader set must contain at least one behavioral (non-string-contains) spec. */
export function validateGraderSpecs(specs: readonly GraderSpec[]): GraderValidation {
  if (specs.length === 0) return { ok: false, reason: "no graders configured" };
  const unknown = specs.find((s) => !["file-equals", "file-matches", "file-changed", "command", "final-text"].includes(s.type));
  if (unknown) return { ok: false, reason: `unknown grader type: ${(unknown as { type: string }).type}` };
  const behavioral = specs.some(isBehavioral);
  if (!behavioral) {
    return {
      ok: false,
      reason:
        "string-contains alone does not pass: every spec is final-text. Add a behavioral grader " +
        "(file-changed / file-equals / file-matches / command) that judges the workspace.",
    };
  }
  return { ok: true };
}

const DETAIL_DIFF_LINES = 40;

async function gradeOne(spec: GraderSpec, ctx: GraderContext): Promise<GraderOutcome> {
  const name = specName(spec);
  const advisory = !isBehavioral(spec);
  switch (spec.type) {
    case "file-equals": {
      try {
        const actual = readFileSync(join(ctx.workspace, ...spec.path.split("/")), "utf8");
        return { spec, name, advisory, pass: actual === spec.content, detail: actual === spec.content ? "exact match" : `content mismatch (${actual.length} vs ${spec.content.length} chars)` };
      } catch {
        return { spec, name, advisory, pass: false, detail: "file missing" };
      }
    }
    case "file-matches": {
      try {
        const actual = readFileSync(join(ctx.workspace, ...spec.path.split("/")), "utf8");
        const re = new RegExp(spec.pattern, spec.flags ?? "");
        const pass = re.test(actual);
        return { spec, name, advisory, pass, detail: pass ? `matches /${spec.pattern}/` : `does not match /${spec.pattern}/` };
      } catch {
        return { spec, name, advisory, pass: false, detail: "file missing" };
      }
    }
    case "file-changed": {
      const abs = join(ctx.workspace, ...spec.path.split("/"));
      let actual: string;
      try {
        actual = readFileSync(abs, "utf8");
      } catch {
        return { spec, name, advisory, pass: false, detail: "file missing" };
      }
      const baseline = ctx.fixture.files[spec.path];
      if (baseline !== undefined && actual === baseline) {
        return { spec, name, advisory, pass: false, detail: "unchanged relative to the fixture baseline" };
      }
      let pass = true;
      const checks: string[] = [];
      if (spec.mustMatch !== undefined) {
        const ok = new RegExp(spec.mustMatch, spec.flags ?? "").test(actual);
        pass = pass && ok;
        checks.push(ok ? `matches /${spec.mustMatch}/` : `missing /${spec.mustMatch}/`);
      }
      if (spec.mustNotMatch !== undefined) {
        const ok = !new RegExp(spec.mustNotMatch, spec.flags ?? "").test(actual);
        pass = pass && ok;
        checks.push(ok ? `clean of /${spec.mustNotMatch}/` : `still contains /${spec.mustNotMatch}/`);
      }
      const diff = baseline !== undefined
        ? createTwoFilesPatch("a/" + spec.path, "b/" + spec.path, baseline, actual, undefined, undefined, { context: 1 }).split("\n").slice(0, DETAIL_DIFF_LINES).join("\n")
        : `(new file, ${actual.length} chars)`;
      return { spec, name, advisory, pass, detail: `${checks.join("; ") || "changed"} — ${diff}` };
    }
    case "command": {
      const expectExit = spec.expectExit ?? 0;
      const timeoutMs = spec.timeoutMs ?? 30_000;
      const argv = [spec.command, ...(spec.args ?? [])];
      try {
        const proc = Bun.spawn(argv, { cwd: ctx.workspace, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
        const code = await proc.exited;
        clearTimeout(timer);
        if (timedOut) {
          return { spec, name, advisory, pass: false, detail: `timeout after ${timeoutMs}ms` };
        }
        const pass = code === expectExit;
        const tail = (await new Response(proc.stderr).text()).trim().split("\n").slice(-3).join(" | ").slice(0, 300);
        return { spec, name, advisory, pass, detail: pass ? `exit ${code}` : `exit ${code} (expected ${expectExit})${tail ? ` — ${tail}` : ""}` };
      } catch (e) {
        return { spec, name, advisory, pass: false, detail: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case "final-text": {
      const pass = new RegExp(spec.pattern, spec.flags ?? "").test(ctx.transcript.finalText);
      return { spec, name, advisory, pass, detail: pass ? "final text matches" : `final text lacks /${spec.pattern}/` };
    }
  }
}

/** Validate, then run every spec. Throws GraderConfigError when the set is empty,
 *  unknown, or advisory-only — the contains-only gate is enforced here, not left to
 *  the caller's discipline. */
export async function runGraders(specs: readonly GraderSpec[], ctx: GraderContext): Promise<GraderOutcome[]> {
  const v = validateGraderSpecs(specs);
  if (!v.ok) throw new GraderConfigError(v.reason);
  return Promise.all(specs.map((s) => gradeOne(s, ctx)));
}

/** The composite verdict: every strict (behavioral) grader must pass; advisory outcomes
 *  are recorded as evidence but never decide. */
export function gradersPassed(outcomes: readonly GraderOutcome[]): boolean {
  return outcomes.filter((o) => !o.advisory).every((o) => o.pass);
}
