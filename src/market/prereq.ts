/** Is the program this item needs actually on the machine?
 *
 *  The most common way an install "succeeds" and then does not work is that the launch line names a
 *  program nobody has: `npx …` without Node, `uvx …` without uv, `docker run …` without Docker. Today the
 *  only signal is prose in a description, which nobody reads at the moment it matters. This module turns
 *  that into one line in the plan, BEFORE the yes.
 *
 *  Three rules, and each one is a decision not to do more:
 *
 *  - **It never runs anything.** A prerequisite check that executes the program it is checking is a
 *    prerequisite check that can hang, prompt, or start a daemon. This looks the program up on PATH and
 *    stops there.
 *  - **It never compares versions.** "Needs node ≥ 20" reads well and is wrong often — a version probe
 *    means running the thing, parsing whatever it prints, and being wrong about pre-releases and vendored
 *    builds. A warning that lies once is a warning nobody reads again.
 *  - **It never blocks.** The result is a line in the plan, not a gate. Plenty of people install the tool
 *    after they install the thing that needs it, and refusing them would be worse than saying nothing.
 *
 *  A missing answer is `undefined`, not a false one: an item with nothing to check produces no line at all
 *  rather than a reassuring tick that means nothing.
 */

import { existsSync } from "node:fs";
import type { MarketItem } from "./types.ts";

export interface Prereq {
  /** the program a launch line would run: "npx", "uvx", "docker", "git" */
  program: string;
  found: boolean;
  /** where it was found, when it was */
  path?: string;
  /** a one-line "how to get it" — only for the handful we can name honestly */
  hint?: string;
}

/** Where to look and how, injectable so the tests do not depend on the machine running them. */
export interface PrereqEnv {
  PATH?: string;
  /** Windows only: the extensions that make a name executable (`.COM;.EXE;.BAT;.CMD`) */
  PATHEXT?: string;
  /** defaults to the running platform; decides the PATH separator and whether PATHEXT applies */
  windows?: boolean;
  /** how existence is tested; the default is `existsSync` */
  exists?: (p: string) => boolean;
}

/** Install advice only where we can give it without guessing. A program we cannot name a source for gets
 *  no hint, and the plan says "not on PATH" and nothing more — which is honest and still useful. */
const HINTS: Record<string, string> = {
  npx: "comes with Node.js — nodejs.org",
  npm: "comes with Node.js — nodejs.org",
  node: "nodejs.org",
  uvx: "pipx install uv — astral.sh/uv",
  uv: "pipx install uv — astral.sh/uv",
  docker: "docker.com/get-started",
  git: "git-scm.com/downloads",
  python: "python.org/downloads",
  python3: "python.org/downloads",
  deno: "deno.com",
  bun: "bun.sh",
};

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Join with the separator the CHECKED platform uses, not the one we happen to be running on. `join()`
 *  from node:path is bound to the host, so on Windows it turned `/usr/bin` + `docker` into
 *  `\usr\bin\docker` — harmless in production, where the flag matches the host, but it made the injected
 *  platform a half-truth and would have quietly broken any future cross-platform use. */
const joinPath = (dir: string, name: string, windows: boolean): string => {
  const sep = windows ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
};

/** Look one program up on PATH. No execution, no version, no shell. */
export function checkPrereq(program: string, env: PrereqEnv = {}): Prereq {
  const windows = env.windows ?? process.platform === "win32";
  const exists = env.exists ?? existsSync;
  const hint = HINTS[program.toLowerCase()];
  const base: Prereq = { program, found: false, ...(hint ? { hint } : {}) };

  // a launch line that names a path rather than a command is not a PATH question at all
  if (program.includes("/") || program.includes("\\")) {
    return exists(program) ? { ...base, found: true, path: program } : base;
  }

  const raw = env.PATH ?? process.env["PATH"] ?? "";
  const dirs = raw.split(windows ? ";" : ":").map((d) => d.trim().replace(/^"|"$/g, "")).filter((d) => d !== "");
  // On Windows a bare name is executable only with one of PATHEXT's extensions — `npx` on disk is
  // `npx.cmd`, and looking for `npx` alone reports every Node install as missing.
  const exts = windows
    ? ["", ...(env.PATHEXT ?? process.env["PATHEXT"] ?? DEFAULT_PATHEXT).split(";").map((e) => e.trim()).filter((e) => e !== "")]
    : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = joinPath(dir, program + ext, windows);
      if (exists(candidate)) return { ...base, found: true, path: candidate };
    }
  }
  return base;
}

/** The program an item's install would run, or undefined when there is nothing to check.
 *
 *  MCP: a stdio entry already carries the exact command — `mcp/market.ts` resolved the registry's
 *  `runtimeHint` (or the package type's default) into `command`, so nothing is re-derived here. An http
 *  entry runs nothing locally and gets no line.
 *
 *  Skills and plugins: `git`, when and only when the source is a repository. This is NOT the case the
 *  feature was proposed for, and it is the one that fires most: every row in both catalogs today is
 *  git-sourced (19 of 19 skills, 3 of 3 plugins), so without git every install in the market fails after
 *  the human has already said yes — which is exactly the failure this is here to move earlier. A skill
 *  that ships its files in the catalog, or a plugin installed from a local folder, needs nothing.
 */
export function prereqOf(item: MarketItem, env?: PrereqEnv): Prereq | undefined {
  const program = programFor(item);
  return program === undefined ? undefined : checkPrereq(program, env);
}

function programFor(item: MarketItem): string | undefined {
  const install = item.install;
  switch (install.kind) {
    case "mcp": {
      const first = install.entry.installs?.[0];
      // only the form that launches a process locally; a remote is a URL we connect to
      return first !== undefined && first.kind === "stdio" ? first.command : undefined;
    }
    case "plugin":
      return install.git ? "git" : undefined;
    case "skill":
      return install.source?.git !== undefined ? "git" : undefined;
  }
}

/** The plan's line for a prerequisite, or undefined when there is none to draw.
 *
 *  Here rather than at the call site so both surfaces say the same thing, and so the wording stays with
 *  the rules it describes: "not on PATH" is a statement about where we looked, not a claim that the
 *  program is not installed — someone may have it somewhere PATH does not reach, and the sentence should
 *  not tell them they are wrong. */
export function prereqLine(p: Prereq | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (p.found) return `${p.program} ✓`;
  return `${p.program} — not on PATH${p.hint ? ` (install: ${p.hint})` : ""}`;
}
