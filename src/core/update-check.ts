/** Is there a newer rovecode than the one running?
 *
 *  The release channel is GitHub Releases on 9Code-Labs/rovecode-community (Berkay's call, 2026-09-06;
 *  pointed at the public community fork for the npm build, 2026-09-19). The repository is PUBLIC, so
 *  the check works anonymously — `GITHUB_TOKEN`, `GH_TOKEN` or a `gh auth login` only raise the rate
 *  limit. Failures stay honest: when the check could not look, the result says why instead of claiming
 *  "you are up to date". A version check that reports "current" when it could not look is worse than no
 *  check, since it is indistinguishable from a real answer.
 *
 *  Three rules, because this runs at startup:
 *  - **It never blocks.** The caller fires it and paints; the answer arrives or it does not.
 *  - **It never throws.** Offline, rate-limited, no token, a repository that has no releases yet — each
 *    is a reason string, and the surface can decide whether to say anything.
 *  - **It asks rarely.** The answer is cached per release repo in ~/.rovecode/update-check-<repo>.json
 *    for six hours, so opening
 *    the terminal twenty times in an afternoon is one request. A cache that cannot be read or written is
 *    not an error either; it just means asking again. */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";

export interface UpdateStatus {
  /** the version this process is */
  current: string;
  /** the newest release, when one could be read */
  latest?: string;
  /** true only when `latest` is genuinely newer than `current` */
  newer: boolean;
  /** why there is no `latest` — absent when the check succeeded */
  reason?: string;
  /** where the answer came from, so a stale line can be explained */
  from: "network" | "cache";
  /** the release page, for a surface that wants to point at it */
  url?: string;
}

export interface UpdateCheckOptions {
  repo?: string;
  token?: string | undefined;
  fetchFn?: typeof fetch;
  /** overridden in tests; production caches under rovecodeHome() */
  cacheFile?: string;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** answer from the cache or not at all — never open a socket. `rovecode --version` uses this: a courtesy
   *  line must not make a command scripts call wait on a network round-trip (measured 3.2 s on a cold
   *  cache before this existed, against 84–103 ms for everything else the command does). */
  cacheOnly?: boolean;
  /** last-resort token source; the default asks the gh CLI. Injected in tests so no process is spawned. */
  ghToken?: () => Promise<string | undefined>;
}

const REPO = "9Code-Labs/rovecode-community";
const TTL_MS = 6 * 60 * 60 * 1000;
// 8s, not the 3s this started with. Nothing waits on this — the card is already painted and the notice
// arrives when it arrives — so the only thing a short timeout buys is the wrong answer on exactly the run
// that matters: measured cold on this machine the first api.github.com request took 12.7s and the next
// 0.36s, which a 3s cap turns into "the check timed out" every single first start of the day.
const TIMEOUT_MS = 8_000;

/** semver-ish compare, tolerant of a leading v and of extra dot-parts; prerelease suffixes lose to the
 *  same version without one, which is the conservative direction — it never invents an update. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string): { nums: number[]; pre: boolean } => {
    const clean = v.trim().replace(/^v/i, "");
    const [core = "", ...rest] = clean.split("-");
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: rest.length > 0 };
  };
  const a = parts(latest), b = parts(current);
  const len = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < len; i++) {
    const x = a.nums[i] ?? 0, y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  // same numbers: a prerelease is not newer than the release, and never newer than itself
  return b.pre && !a.pre;
}

function readCache(file: string, ttlMs: number, now: number): UpdateStatus | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { at?: number; status?: UpdateStatus };
    if (typeof raw.at !== "number" || !raw.status) return null;
    if (now - raw.at > ttlMs) return null;
    return { ...raw.status, from: "cache" };
  } catch {
    return null;   // unreadable, missing, or written by an older shape — ask again
  }
}

function writeCache(file: string, status: UpdateStatus, now: number): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: now, status: { ...status, from: "network" } }));
  } catch {
    /* a read-only home must not turn a successful check into a failure */
  }
}

/** `gh auth token`, or undefined for every way that can fail — no gh, not logged in, slow, noisy. This is
 *  a convenience, so it is never allowed to become a reason the terminal waits. */
function ghAuthToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("gh", ["auth", "token"], { timeout: 1_500, windowsHide: true }, (err, stdout) => {
        const t = typeof stdout === "string" ? stdout.trim() : "";
        resolve(err !== null || t.length === 0 ? undefined : t);
      });
    } catch { resolve(undefined); }
  });
}

export async function checkForUpdate(current: string, opts: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  // ROVECODE_NO_UPDATE_CHECK=1 disables the check outright — no cache read, no `gh` spawn, no socket.
  // The test preload sets it (test/helpers/isolate-home.ts): the token comes from a SPAWNED `gh auth
  // token`, which the env scrub cannot see, so on a machine with gh logged in a real "update available"
  // note used to land in TUI tests mid-assertion during long full runs (measured 2026-09-19: three
  // failures whose received text was the release note). An injected seam (fetchFn/token/cacheFile/
  // ghToken) means the caller is exercising the check itself — those runs are not disabled.
  const noSeam = opts.fetchFn === undefined && opts.token === undefined && opts.cacheFile === undefined && opts.ghToken === undefined;
  if (noSeam && process.env.ROVECODE_NO_UPDATE_CHECK === "1") {
    return { current, newer: false, from: "cache", reason: "ROVECODE_NO_UPDATE_CHECK=1" };
  }
  const now = (opts.now ?? Date.now)();
  // The cache is keyed PER REPO: a machine that runs two builds pointed at two release repos (the
  // private dev one and the public community one share ~/.rovecode) used to answer each other's
  // question — "no release published yet" from one silenced the other's real "update available"
  // (observed 2026-09-20).
  const repo = opts.repo ?? REPO;
  const cacheFile = opts.cacheFile ?? join(rovecodeHome(), `update-check-${repo.replace(/[^\w.-]+/g, "_")}.json`);
  const ttl = opts.ttlMs ?? TTL_MS;

  const cached = readCache(cacheFile, ttl, now);
  if (cached) return { ...cached, current, newer: cached.latest !== undefined && isNewer(cached.latest, current) };

  // GITHUB_TOKEN, then GH_TOKEN, then whatever `gh auth login` already stored — OPTIONAL for this
  // build: the community release repository is public, so the check works anonymously (GitHub's
  // unauthenticated rate limit is 60/h per IP, and this asks at most once every six hours). A token
  // only raises the limit. The token is used and dropped: it never enters the cache.
  if (opts.cacheOnly === true) {
    return { current, newer: false, from: "cache", reason: "not asked yet — rovecode checks at startup, at most once every six hours" };
  }
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? await (opts.ghToken ?? ghAuthToken)();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await (opts.fetchFn ?? fetch)(`https://api.github.com/repos/${opts.repo ?? REPO}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json", "user-agent": "rovecode",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: ac.signal,
    });
    if (res.status === 404) {
      const status: UpdateStatus = { current, newer: false, from: "network", reason: "no release published yet" };
      writeCache(cacheFile, status, now);   // worth caching: it will stay true until someone publishes
      return status;
    }
    if (!res.ok) return { current, newer: false, from: "network", reason: `GitHub answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as { tag_name?: string; html_url?: string } | null;
    const tag = typeof body?.tag_name === "string" ? body.tag_name : undefined;
    if (!tag) return { current, newer: false, from: "network", reason: "the release carries no tag name" };
    const status: UpdateStatus = {
      current, latest: tag.replace(/^v/i, ""), newer: isNewer(tag, current), from: "network",
      ...(typeof body?.html_url === "string" ? { url: body.html_url } : {}),
    };
    writeCache(cacheFile, status, now);
    return status;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { current, newer: false, from: "network", reason: ac.signal.aborted ? "the check timed out" : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** The one line a surface shows, or null when there is nothing worth saying. Deliberately silent for
 *  "up to date" and for every failure: a startup screen that reports its own plumbing every time trains
 *  people to stop reading it. `verbose` is for `rovecode --version`, where asking WAS the point. */
export function updateLine(s: UpdateStatus, verbose = false): string | null {
  if (s.newer && s.latest !== undefined) return `update available: ${s.current} → ${s.latest}${s.url ? ` · ${s.url}` : ""}`;
  if (!verbose) return null;
  if (s.reason !== undefined) return `update check: ${s.reason}`;
  return `up to date (${s.current})${s.from === "cache" ? " · cached" : ""}`;
}
