/** Lane registry (#47): the four adapters by id, the `ROVECODE_LANES_ALLOW` gate, the LaneOpts defaults
 *  (+ the user-side knobs that shape a lane's permissions), and the ONE function that turns a lane's
 *  options into the approval-card text — the TaskManager stores the same string on the TaskInfo, so the
 *  card and the running lane agree.
 *
 *  THE GATE IS ON BY DEFAULT (changed 2026-09-07, at the user's request). It used to be an opt-in
 *  allow-list: unset meant no lane could start, so a CLI the user had installed was unreachable until
 *  they found an env knob nobody reads. Now an UNSET knob allows every adapter and a DEFINED knob is an
 *  exact list — `ROVECODE_LANES_ALLOW=` (empty) is the kill switch, and `=codex` still means codex only.
 *  Defined-wins is what makes that safe: turning the default on cannot silently widen a machine whose
 *  owner had already written a narrower list.
 *
 *  What replaces the gate as the thing that stops a lane is INSTALLEDNESS. With lanes off, a missing CLI
 *  was academic; with lanes on it is the common case, and the honest place to say so is here, before a
 *  worktree exists. Left to the spawn it surfaces as `spawn failed: codex: ENOENT` after the lane has
 *  built a worktree and burned a turn — a refusal at the gate costs neither. The probe reads PATH only
 *  (plus PATHEXT on win32); it is injectable so no test ever depends on what this machine has installed,
 *  and it is memoised per (bin, PATH) because `task start` may be called in a loop.
 *
 *  Turning the gate on removes the approval that came WITH it for anyone running permission=auto, where
 *  no card is ever shown. `laneStartNote` is the replacement: the text a surface states when a lane
 *  starts, at every permission level, so "an external CLI just began working in your repo" is never
 *  something the user has to infer from a spinner. It is the card's own sentence — one function builds
 *  both, so the note cannot drift from the flags the lane actually got. */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isObj } from "./events.ts";
import { ADAPTER_IDS, isAdapterId, type AdapterId, type AgentAdapter, type LaneOpts } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { opencodeAdapter } from "./opencode.ts";
import { agyAdapter } from "./agy.ts";

export const ADAPTERS: Readonly<Record<AdapterId, AgentAdapter>> = {
  claude: claudeAdapter, codex: codexAdapter, opencode: opencodeAdapter, agy: agyAdapter,
};

export type Env = Readonly<Record<string, string | undefined>>;

// The knobs, by their documented names. The harness this came from routed every read through a central
// core/env.ts that also consulted a settings file; rovecode has no such reader — it reads ROVECODE_* off
// the environment in 45 places — so the two helpers below are the whole of it, and a lane knob behaves
// like every other rovecode knob. `envName` exists so the name is written once and displayed the same
// way it is read: a refusal that names the wrong variable is worse than no refusal.
/** the full variable name for a knob: `LANES_ALLOW` → `ROVECODE_LANES_ALLOW` */
export const envName = (knob: string): string => `ROVECODE_${knob}`;
/** read a knob; DEFINED wins, even when empty (the call sites treat "" exactly as they treat unset) */
const readEnv = (knob: string, env: Env = process.env): string | undefined => env[envName(knob)];
/** comma list of adapter ids that may be STARTED at all; UNSET = all four, empty = none (the kill switch) */
export const LANES_ALLOW_ENV = envName("LANES_ALLOW");
/** comma list of adapter ids that get an explicit allow-all (agy: `--dangerously-skip-permissions`) */
export const LANES_ALLOW_ALL_ENV = envName("LANES_ALLOW_ALL");
/** claude `--allowedTools` rules, comma-separated (default Read,Edit,Write) */
export const LANE_CLAUDE_ALLOW_ENV = envName("LANE_CLAUDE_ALLOW");
/** claude `--bare`: "1" forces it, "0" drops it; unset = on only when ANTHROPIC_API_KEY is set in the lane
 *  env (live-verified 2026-09-03: `--bare` authenticates with the key ALONE — the CLI's login is never read) */
export const LANE_CLAUDE_BARE_ENV = envName("LANE_CLAUDE_BARE");
/** claude's documented headless login (`claude setup-token`) — the CLI reads it itself when the lane is not
 *  `--bare` (process.ts KEPT_ENV_EXACT lets it through); the registry reads it only for the card's auth word */
export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** the knob suffix of a lane's model flag (`--model` / `-m provider/model`): LANE_<ID>_MODEL — read through
 *  ROVECODE_LANE_<ID>_MODEL — unset means the lane's CLI picks its own default, which is not ours to guess */
export const laneModelKnob = (id: AdapterId): string => `LANE_${id.toUpperCase()}_MODEL`;
/** the documented name of that knob: ROVECODE_LANE_<ID>_MODEL */
export const laneModelEnv = (id: AdapterId): string => envName(laneModelKnob(id));
/** codex `--sandbox`: read-only | workspace-write (default) */
export const LANE_CODEX_SANDBOX_ENV = envName("LANE_CODEX_SANDBOX");
/** wall-clock budget per lane in ms (default 15 min) */
export const LANE_TIMEOUT_ENV = envName("LANE_TIMEOUT_MS");
export const DEFAULT_LANE_TIMEOUT_MS = 15 * 60_000;

function idList(raw: string | undefined): Set<AdapterId> {
  const out = new Set<AdapterId>();
  for (const tok of (raw ?? "").split(",")) {
    const id = tok.trim().toLowerCase();
    if (isAdapterId(id)) out.add(id);
  }
  return out;
}

/** Adapter ids that may start. UNSET `ROVECODE_LANES_ALLOW` = all four; a DEFINED value is an exact
 *  list, so an empty string allows nothing (the kill switch) and unknown tokens are ignored. */
export const lanesAllowed = (env: Env = process.env): Set<AdapterId> => {
  const raw = readEnv("LANES_ALLOW", env);
  return raw === undefined ? new Set(ADAPTER_IDS) : idList(raw);
};
/** The binary an adapter would run, without building a lane: `command()` is pure and takes no process. */
export const laneBinary = (id: AdapterId, env: Env = process.env): string =>
  ADAPTERS[id].command({ goal: "probe" }, laneOptsFor(id, ".", env)).bin;

/** Is `bin` runnable? PATH only (plus PATHEXT on win32) — the same lookup the OS would do at spawn.
 *  Injectable and memoised; a bare name with no PATH at all is assumed present rather than refused,
 *  because guessing "missing" would block a lane the OS could in fact have started. */
export type PathProbe = (bin: string, env: Env) => boolean;
const probeCache = new Map<string, boolean>();
export const onPath: PathProbe = (bin, env) => {
  const path = env["PATH"] ?? env["Path"] ?? "";
  const key = `${process.platform}|${bin}|${path}`;
  const hit = probeCache.get(key);
  if (hit !== undefined) return hit;
  const ok = lookup(bin, path, env);
  probeCache.set(key, ok);
  return ok;
};
function lookup(bin: string, path: string, env: Env): boolean {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);   // an explicit path is not a PATH lookup
  if (path === "") return true;                                          // nothing to search: do not claim it is missing
  const exts = process.platform === "win32"
    ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean)
    : [""];
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}
/** test seam: forget what was probed (the cache is keyed by PATH, so only a test needs this) */
export const resetPathProbe = (): void => { probeCache.clear(); };

/** null when `id` may start; otherwise the refusal text `task start` returns (no process is spawned,
 *  and no worktree is built — both refusals below land before the lane exists). */
export function laneRefusal(id: AdapterId, env: Env = process.env, probe: PathProbe = onPath): string | null {
  const allowed = lanesAllowed(env);
  if (!allowed.has(id)) {
    // Only reachable when the user wrote a list themselves, so the refusal talks about THEIR list
    // rather than telling them to opt in to something that is already on by default.
    const now = allowed.size ? [...allowed].join(",") : "none";
    return `external lane '${id}' is not in ${LANES_ALLOW_ENV} (currently allowed: ${now}) — add it, or unset ${LANES_ALLOW_ENV} to allow all of ${ADAPTER_IDS.join(",")}`;
  }
  const bin = laneBinary(id, env);
  if (!probe(bin, env)) return `external lane '${id}' needs the '${bin}' CLI, which is not on PATH — install it, or start a different lane (${ADAPTER_IDS.filter((o) => o !== id).join(", ")})`;
  return null;
}

/** The sentence a surface states when a lane starts — shown at EVERY permission level, because
 *  permission=auto shows no approval card and an external CLI beginning work in the user's repo is
 *  not something to leave implicit. Built from `lanePermissions`, so it names the flags the lane
 *  actually got rather than a description of them. */
export function laneStartNote(id: AdapterId, env: Env = process.env, over: Partial<LaneOpts> = {}): string {
  return `${lanePermissions(id, env, over)} — started; it works in its own worktree and its diff comes back as a patch`;
}

export function laneTimeoutFromEnv(env: Env = process.env): number {
  const n = Number(readEnv("LANE_TIMEOUT_MS", env) ?? "");
  return Number.isInteger(n) && n >= 1_000 ? n : DEFAULT_LANE_TIMEOUT_MS;
}

/** The options a lane of `id` runs with in `cwd` (its worktree): env knobs, then `over`; cwd always wins. */
export function laneOptsFor(id: AdapterId, cwd: string, env: Env = process.env, over: Partial<LaneOpts> = {}): LaneOpts {
  const opts: LaneOpts = { cwd, timeoutMs: laneTimeoutFromEnv(env) };
  const model = (readEnv(laneModelKnob(id), env) ?? "").trim();
  if (model) opts.model = model;
  if (id === "claude") {
    const raw = readEnv("LANE_CLAUDE_ALLOW", env);
    if (raw !== undefined) opts.allowlist = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const bare = readEnv("LANE_CLAUDE_BARE", env);
    opts.bare = bare === "1" ? true : bare === "0" ? false : (env["ANTHROPIC_API_KEY"] ?? "") !== "";
    if ((env[CLAUDE_OAUTH_TOKEN_ENV] ?? "") !== "") opts.oauthToken = true;
  }
  if (id === "codex") {
    const sb = readEnv("LANE_CODEX_SANDBOX", env);
    opts.sandbox = sb === "read-only" ? "read-only" : "workspace-write";
  }
  if (id === "agy" && idList(readEnv("LANES_ALLOW_ALL", env)).has("agy")) opts.allowAll = true;
  return { ...opts, ...over, cwd };
}

/** The approval-card text for a lane — `spawn codex lane · sandbox workspace-write · approval never · worktree`. */
export function lanePermissions(id: AdapterId, env: Env = process.env, over: Partial<LaneOpts> = {}): string {
  return `spawn ${id} lane · ${ADAPTERS[id].permissionSummary(laneOptsFor(id, "<worktree>", env, over))}`;
}

/** A `task start` args object naming an external lane → its card text; null for every other call. */
export function laneApprovalText(args: unknown, env: Env = process.env): string | null {
  if (!isObj(args) || args["action"] !== "start" || !isAdapterId(args["agent"])) return null;
  return lanePermissions(args["agent"], env);
}
