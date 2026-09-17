/** Port #45 — rovecode, the CRT receiver companion of the sextant surface: sprite + quip tables, observation
 *  of written lines, moods derived from real activity, storms, sleep, pokes. Ported from the user's own
 *  sextant v0.4.0 prototype `src/pet.js` (user-owned; the mock typing/scenario hooks are gone — every
 *  input is a RunEvent-derived call from the renderer). PURE: every method takes `now`; no wall clock,
 *  no timers, no unseeded randomness, no environment access — randomness is a seeded PRNG stepped only
 *  by caller-driven events (never by drawing), so identical scripts at identical clocks draw identically. */

import type { ActivityState, SextantState } from "./types.ts";

// ------------------------------------------------------------------ data tables (pet.js:10-85)

/** outline cloud in the panels' rounded-line language: 18 cells wide, 6 rows */
export const SPRITE: readonly string[] = [
  "       ╭────╮     ",
  "   ╭───╯    ╰──╮  ",
  "  ╭╯           ╰╮ ",
  "  │             │ ",
  "  ╰╮           ╭╯ ",
  "   ╰───────────╯  ",
];
/** face anchors inside the sprite: eye columns, mouth column, eye/mouth rows */
export const FACE = { EYE_L: 6, EYE_R: 12, MOUTH: 9, EYE_ROW: 3, MOUTH_ROW: 4 } as const;
/** per row: [first, last] outline column — the storm fill paints strictly between them
 *  (pet.js:19 searched /S/, a typo for /\S/ that filled the whole box; the intent is the interior) */
export const INNER: readonly (readonly [number, number])[] = SPRITE.map((row) => {
  const a = row.search(/\S/);
  const b = row.length - 1 - [...row].reverse().join("").search(/\S/);
  return [a, b] as const;
});
/** glyphs that drizzle under the cloud while a file is being edited */
export const CODE_RAIN = "{};=()<>:.";

export type QuipKind =
  | "start" | "glob" | "grep" | "read" | "plan" | "permission" | "allowed" | "denied" | "edit" | "write"
  | "remove" | "run" | "pass" | "fail" | "error" | "done" | "stopped" | "fresh" | "theme" | "poke" | "idle"
  | "sleep" | "todo" | "long" | "failLine" | "risk" | "spawn" | "laneDone" | "laneFail" | "merge" | "thinking"
  | "fetch" | "crew" | "tinker"; // the network, a child's progress, housekeeping (providers/skills/memory/MCP) — acts no older kind covers

/** what the receiver says on events; `{n} {f} {q} {r} {a} {d} {changed}` are filled from the event data.
 *  `poke` is ordered so the first poke greets ("hi.") and later pokes cycle the pool. */
export const QUIPS: Readonly<Record<QuipKind, readonly string[]>> = {
  start: ["on it.", "let's see what we've got.", "rolling in."],
  glob: ["sniffing for {q}…", "where is {q}…", "looking for {q}."], // a search STARTS here (glob and grep, {q} = the pattern); grep's count lands in `grep`
  grep: ["found {n}.", "{n}. noted."],
  fetch: ["fetching {f}.", "off to {f}.", "knocking on {f}."],
  crew: ["checking on {a}.", "{a}, how's it going.", "peeking at {a}."],
  tinker: ["poking at {f}.", "a look at {f}.", "fiddling with {f}."],
  read: ["reading {f}.", "let me skim {f}."],
  plan: ["{n} steps. easy.", "got a plan. {n} steps."],
  permission: ["your call ▸", "need a nod from you."],
  allowed: ["thanks ♥", "♥ on it."],
  denied: ["okay, hands off.", "fair. stopping."],
  edit: ["tuning {f}.", "editing {f}.", "adjusting {f}."],
  write: ["a fresh {f}.", "new signal: {f}."],
  remove: ["blowing {f} away.", "bye, {f}."],
  run: ["powering the tool.", "running the tool.", "charging up…"],
  pass: ["{r}. signal clear.", "clear signal · {r}.", "{r}. locked."],
  fail: ["{r}. GRR.", "red. i hate red.", "{r}. fixing it. NOW."],
  error: ["signal fault.", "who wrote THAT.", "no. no no no.", "grr."],
  done: ["all clear.", "nice work, us.", "signal locked."],
  stopped: ["okay, stopping.", "standing by."],
  fresh: ["fresh channel.", "clean slate."],
  theme: ["new display mode.", "display tuned."],
  poke: ["hi.", "hehe.", "♪", "that tickles.", "yes?"],
  idle: ["humming ♪", "ready when you are.", "channel is quiet.", "ready for a refactor.", "♪ ♪"],
  sleep: ["zzz…", "…", "mm."],
  todo: ["one down.", "{d}/{n}. moving.", "check.", "that's {d} of {n}."],
  long: ["still going. hang tight.", "big one. i'm here."],
  failLine: ["GRR.", "red. RED.", "that one leaked. grr."],
  risk: ["hm. that one's risky.", "i'd look at that twice."],
  spawn: ["sending {a} in.", "{a}, you're up.", "go, {a}. i'll watch."],
  laneDone: ["{a} is back · {r}.", "{a}: {r}. nice.", "{a} done. {r}."],
  laneFail: ["{a} tripped · {r}.", "hm. {a} didn't make it."],
  merge: ["stitching it together.", "all hands back. merging."],
  // the run header's word while the model reasons and nothing else moves: weather for a cloud working
  // something out — the familiar word first, and the rotation (not a stuck spinner) is what says "still alive"
  thinking: ["thinking", "brewing", "gathering", "mulling", "sifting", "condensing", "circling", "weighing"],
};

/** the word for `elapsedMs` into a reasoning phase: one step every 4 s — slow enough to read, fast enough that 15 s changes it three times */
export const thinkingWord = (elapsedMs: number): string => QUIPS.thinking[Math.floor(Math.max(0, elapsedMs) / 4000) % QUIPS.thinking.length] ?? "thinking";

/** what the receiver notices in lines being written (first matching row wins, per line) */
export const OBSERVE: readonly (readonly [RegExp, string])[] = [
  [/httpOnly/i, "httpOnly. good call."],
  [/secure:\s*true/, "secure cookie ♥"],
  [/sameSite/i, "sameSite too. tidy."],
  [/TODO|FIXME/, "a TODO. i'll remember it."],
  [/console\.log/, "leftover console.log?"],
  [/throw new/, "throwing. brave."],
  [/try \{/, "try… fingers crossed for the catch."],
  [/catch \(/, "…and a catch. phew."],
  [/^import .* from/, "imports rolling in."],
  [/^export (default |async )?(function|const|class)/, "a new export."],
  [/status\(4\d\d\)/, "a 4xx. firm but fair."],
  [/status\(5\d\d\)/, "a 5xx? hope that's on purpose."],
  [/sqlite|\bdb\.|prepare\(/i, "talking to the database."],
  [/crypto|randomBytes|timingSafeEqual/, "crypto. spooky."],
  [/\b(test|it|describe)\(/, "a test! my favorite."],
  [/req\.ip|forwarded/i, "who's calling? checking the ip."],
  [/SIGTERM|process\.exit|\.close\(/, "graceful. i like graceful."],
  [/rateLimit|429/, "rate limits. slow down, world."],
  [/csrf|verifyState|\bstate\b/i, "state check. no sneaky redirects."],
  [/expires|maxAge/i, "expiry set. nothing lives forever."],
  [/cookie/i, "cookies. i want one."],
  [/redirect\(/, "and… redirect."],
  [/async /, "async. i'll wait."],
];
/** what the receiver notices in lines being removed */
export const OBSERVE_DEL: readonly (readonly [RegExp, string])[] = [
  [/legacy/i, "goodbye, legacy."],
  [/new Map\(\)/, "bye, in-memory Map."],
  [/console\.log/, "console.log, gone. clean."],
  [/token\.access_token/, "raw token in a cookie, gone. good."],
];

// ------------------------------------------------------------------ types + tunables

/** the pinned mood table, in precedence order (see mood()) */
export type Mood = "furious" | "patient" | "conducting" | "focused" | "zapping" | "sunny" | "sleepy" | "humming";
export const MOODS: readonly Mood[] = ["furious", "patient", "conducting", "focused", "zapping", "sunny", "sleepy", "humming"];

/** what the pet knows about the world this frame — derived from SextantState by moodCtxFrom() */
export interface MoodCtx {
  state: ActivityState;
  running: boolean;
  /** an approval or ask_user card is open → WAITING */
  waiting: boolean;
  /** the crew has queued/running tasks → DELEGATING */
  delegating: boolean;
  /** clock of the last error the state knows about (null = none) — informational: the storm is armed by
   *  tick() on the state's edge into ERROR, never by comparing this clock (a failed tool the model leaves
   *  with endedAt null shares one clock across the whole run; one error = one storm must hold per episode) */
  errorAt: number | null;
  tokens: number;
  /** last run activity clock known to the state (0 = none) — keeps the pet awake */
  activeAt: number;
  /** startedAt of the run in flight (null when not running) — "still going" after 25 s */
  runStartedAt: number | null;
  /** modified files in the repo — the "busy branch" hum */
  changed: number;
  /** the prompt has text — the eyes glance at the input */
  typing: boolean;
  /** first 1.3 s after boot — the receiver powers on its eyes last, no ambient hums yet */
  booting: boolean;
}

export type FxKind = "bounce" | "shiver" | "sparkle" | "hearts";
export interface PetFx { kind: FxKind; until: number; seed: number }
export type QuipTone = "event" | "observe" | "ambient";
export interface PetQuip { text: string; until: number; kind: QuipTone }

export interface PetState {
  name: string;
  pokes: number;
  quip: PetQuip | null;
  lastQuipAt: number;
  lastEventKind: PetEventKind | null; // the last event quip that took the bubble (the rate rule collapses same-kind repeats)
  /** null until the first tick/event — "born on first sight", since createPet takes no clock */
  lastActiveAt: number | null;
  fx: PetFx[];
  glance: { dir: -1 | 0 | 1; until: number } | null;
  nextObserveAt: number;
  /** an observation made while an event quip was showing; said once that quip ends — unless it is older than
   *  OBSERVE_DEFER_MS by then (dropped: a 2-minute permission quip must not surface it minutes later) */
  pendingObserve: { text: string; at: number } | null;
  nextSuggestAt: number;
  lastSuggest: string;
  saidLong: boolean;
  stormUntil: number;
  /** the state was ERROR on the previous tick — the storm arms on the edge into ERROR, so a lingering ERROR
   *  is one storm and a second ERROR episode in the same run is a second storm */
  wasError: boolean;
  todosDone: number;
}

export type PetEventKind = QuipKind | "tool_fail" | "todo_done";
export type PetEventData = Readonly<Record<string, string | number | undefined>>;
export type ReactKind = "fail-line" | "pass-line" | "risk";

export interface Pet {
  readonly state: PetState;
  /** a line was written ("ins") or removed ("del"); one utterance per OBSERVE_GAP_MS */
  observe(text: string, kind: "ins" | "del", now: number): void;
  /** immediate reaction to an output line (a red test line storms at once) */
  react(kind: ReactKind, now: number): void;
  event(kind: PetEventKind, data: PetEventData | undefined, now: number): void;
  /** the user is typing; the receiver suggests the command ("/help? sure.") */
  suggest(label: string, now: number): void;
  /** a click: jump + hearts + a greeting; event("poke") is the same call — both count the poke, so the first
   *  says "hi." and later pokes cycle the pool (the integration may use either) */
  poke(now: number): void;
  /** an event-tone quip from the surface itself — app.js used pet.say for `/pet <name>` ("<name>? i like it.",
   *  after setting state.name), /mode and /crew; ms defaults to 4200 and observations defer behind it */
  say(text: string, now: number, ms?: number): void;
  /** 1 + floor(sqrt(tokens / 1500)) — grows stepwise with tokens */
  level(tokens: number): number;
  mood(ctx: MoodCtx, now: number): Mood;
  /** a quip, an effect or a storm is live (the renderer may want a faster frame) */
  animating(now: number): boolean;
  /** per-frame housekeeping: expire fx, arm a storm on the state's edge into ERROR, clear storms on SUCCESS,
   *  flush (or drop, past 10 s) a deferred observation, ambient hums / snores / "still going" — drawPet calls
   *  it once per frame */
  tick(now: number, ctx?: MoodCtx): void;
}

export const OBSERVE_GAP_MS = 5500;
/** a deferred observation older than this is dropped instead of spoken late */
export const OBSERVE_DEFER_MS = 10_000;
export const STORM_MIN_MS = 5000;
export const STORM_MAX_MS = 7000;
export const SLEEP_AFTER_MS = 45_000;
export const LONG_RUN_MS = 25_000;
export const BOOT_MS = 1300;
const IDLE_HUM_MS = 11_000;
const SLEEP_HUM_MS = 16_000;
const PERMISSION_QUIP_MS = 120_000;

/** mulberry32 — a tiny seeded PRNG in [0, 1); stepped only by events, never by drawing */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ROVECODE_PET=0 (or false/off/no) removes the panel; the renderer passes its environment map */
export function petEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = (env.ROVECODE_PET ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** the pet's view of the surface state (app.js:749 ctx, minus the mock fields) */
export function moodCtxFrom(s: SextantState, now: number): MoodCtx {
  const a = s.activity;
  return {
    state: a.state,
    running: s.running,
    waiting: s.card != null,
    delegating: s.crew.some((t) => t.status === "queued" || t.status === "running"),
    errorAt: a.state === "ERROR" ? (a.errorAt ?? a.endedAt ?? a.startedAt ?? 0) : null,
    tokens: s.usage.tokensIn + s.usage.tokensOut,
    activeAt: Math.max(a.startedAt ?? 0, a.endedAt ?? 0),
    runStartedAt: s.running ? a.startedAt : null,
    changed: s.repo.modified,
    typing: s.input.text.length > 0,
    booting: now - s.bootAt < BOOT_MS,
  };
}

// ------------------------------------------------------------------ the pet (pet.js makePet)

const GLANCE_KINDS: readonly PetEventKind[] = ["read", "edit", "write", "plan", "grep", "glob", "run", "remove", "spawn", "laneDone", "fetch", "crew", "tinker"];
const CALM_KINDS: readonly PetEventKind[] = ["done", "pass", "start", "fresh", "stopped"];
/** kinds that always take the bubble (the rate rule in event()): outcomes, refusals, asks, the user */
const URGENT_KINDS: ReadonlySet<PetEventKind> = new Set<PetEventKind>(["start", "done", "stopped", "pass", "fail", "error", "failLine", "denied", "permission", "allowed", "poke", "theme", "fresh", "laneDone", "laneFail", "merge", "risk", "long", "todo", "todo_done", "tool_fail"]);
export const MIN_DWELL_MS = 1500; // a routine quip holds the floor at least this long before another routine kind may replace it

export function createPet(opts: { name?: string; seed?: number } = {}): Pet {
  const rnd = seededRandom(opts.seed ?? 7);
  const P: PetState = {
    name: (opts.name || "rovecode").slice(0, 14),
    pokes: 0, quip: null, lastQuipAt: 0, lastEventKind: null, lastActiveAt: null, fx: [], glance: null,
    nextObserveAt: 0, pendingObserve: null, nextSuggestAt: 0, lastSuggest: "", saidLong: false,
    stormUntil: 0, wasError: false, todosDone: 0,
  };
  const pick = (arr: readonly string[], idx?: number): string => arr[(idx ?? Math.floor(rnd() * 1e6)) % arr.length] ?? "";
  const fmt = (t: string, d?: PetEventData): string =>
    t.replace(/\{(\w+)\}/g, (_m, k: string) => { const v = d?.[k]; return v == null ? "" : String(v); });
  /** first sight = birth (the prototype stamped creation with the wall clock) */
  const wake = (now: number): void => { if (P.lastActiveAt == null) { P.lastActiveAt = now; P.lastQuipAt = now - 5000; } };
  /** also the public Pet.say (event tone); wake() is a no-op for the internal callers, which already woke */
  const say = (text: string, now: number, ms = 4200, kind: QuipTone = "event"): void => { wake(now); P.quip = { text, until: now + ms, kind }; P.lastQuipAt = now; };
  const quipActive = (now: number): boolean => P.quip != null && P.quip.until > now;
  const eventQuipActive = (now: number): boolean => quipActive(now) && P.quip?.kind === "event";
  const glance = (dir: -1 | 0 | 1, now: number, ms: number): void => { P.glance = { dir, until: now + ms }; };
  const fx = (kind: FxKind, now: number, ms: number): void => { P.fx.push({ kind, until: now + ms, seed: Math.floor(rnd() * 9973) }); };
  /** a storm lasts 5-7 s (seeded); a new error never shortens a live one — cleared early by SUCCESS / done / start */
  const storm = (now: number): void => {
    P.stormUntil = Math.max(P.stormUntil, now + STORM_MIN_MS + Math.floor(rnd() * (STORM_MAX_MS - STORM_MIN_MS)));
  };

  function observe(text: string, kind: "ins" | "del", now: number): void {
    wake(now);
    if (now < P.nextObserveAt) return;
    const table = kind === "del" ? OBSERVE_DEL : OBSERVE;
    let found: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const hit = table.find(([re]) => re.test(line));
      if (hit) { found = hit[1]; break; }
    }
    if (found == null) return;
    P.nextObserveAt = now + OBSERVE_GAP_MS;
    // an edit's event quip ("tuning x.ts.") keeps the floor; the observation follows it
    if (eventQuipActive(now)) P.pendingObserve = { text: found, at: now };
    else say(found, now, 3200, "observe");
  }

  function react(kind: ReactKind, now: number): void {
    wake(now);
    P.lastActiveAt = now;
    if (kind === "fail-line") { say(pick(QUIPS.failLine), now, 2600); fx("shiver", now, 640); storm(now); }
    else if (kind === "pass-line") fx("bounce", now, 400);
    else if (kind === "risk") say(pick(QUIPS.risk), now, 3600, "observe");
  }

  function suggest(label: string, now: number): void {
    wake(now);
    if (label === P.lastSuggest) return;
    P.lastSuggest = label;
    if (now < P.nextSuggestAt || eventQuipActive(now)) return;
    say(`${label}? sure.`, now, 2200, "observe");
    P.nextSuggestAt = now + 4000;
  }

  function event(kind: PetEventKind, data: PetEventData | undefined, now: number): void {
    wake(now);
    P.lastActiveAt = now;
    if (kind === "todo_done") {
      const d = Number(data?.d ?? P.todosDone + 1), n = data?.n;
      P.todosDone = d;
      const pool = n == null ? QUIPS.todo.filter((q) => !q.includes("{n}")) : QUIPS.todo;
      say(fmt(pick(pool), { d, n }), now, 2600, "observe");
      fx("bounce", now, 240);
      return;
    }
    if (kind === "tool_fail") { say(fmt(pick(QUIPS.error), data), now); fx("shiver", now, 640); storm(now); return; }
    // the rate rule — routine quips (tool starts) must not flap at machine speed: a live same-kind quip keeps the
    // floor (ten reads name the first file), a different routine kind waits MIN_DWELL_MS (the time to read six
    // words); verdicts, refusals, asks and the user's pokes always take it
    if (!URGENT_KINDS.has(kind) && eventQuipActive(now) && (kind === P.lastEventKind || now - P.lastQuipAt < MIN_DWELL_MS)) {
      if (GLANCE_KINDS.includes(kind)) glance(1, now, 2600); // the receiver still looks over at the work
      return;
    }
    P.lastEventKind = kind;
    if (kind === "poke") P.pokes++; // counted here so event("poke") and poke() are the same click
    const pool = QUIPS[kind];
    const text = kind === "poke" ? pick(pool, P.pokes - 1) : pick(pool);
    say(fmt(text, data), now, kind === "permission" ? PERMISSION_QUIP_MS : kind === "done" || kind === "pass" ? 6000 : 4200);
    if (kind === "pass" || kind === "done") fx("sparkle", now, 3600);
    if (kind === "allowed") fx("hearts", now, 1800);
    if (kind === "poke") { fx("bounce", now, 800); fx("hearts", now, 1800); glance(0, now, 1500); }
    if (kind === "theme") fx("sparkle", now, 1400);
    if (kind === "error" || kind === "fail") storm(now);
    if (CALM_KINDS.includes(kind)) P.stormUntil = 0;
    if (GLANCE_KINDS.includes(kind)) glance(1, now, 2600);
    if (kind === "start") { P.saidLong = false; P.lastSuggest = ""; }
  }

  function poke(now: number): void { event("poke", undefined, now); }
  const level = (tokens: number): number => 1 + Math.floor(Math.sqrt(Math.max(0, tokens) / 1500));

  function mood(ctx: MoodCtx, now: number): Mood {
    if (ctx.state === "ERROR" || now < P.stormUntil) return "furious";
    if (ctx.waiting || ctx.state === "WAITING") return "patient";
    if (ctx.delegating || ctx.state === "DELEGATING") return "conducting";
    if (ctx.state === "EDITING") return "focused";
    if (ctx.state === "RUNNING" || ctx.state === "TESTING") return "zapping";
    if (ctx.state === "SUCCESS") return "sunny";
    const last = Math.max(P.lastActiveAt ?? now, ctx.activeAt);
    if (!ctx.running && now - last >= SLEEP_AFTER_MS) return "sleepy";
    return "humming";
  }

  const animating = (now: number): boolean => quipActive(now) || now < P.stormUntil || P.fx.some((f) => f.until > now);

  function tick(now: number, ctx?: MoodCtx): void {
    wake(now);
    P.fx = P.fx.filter((f) => f.until > now);
    if (P.glance && P.glance.until <= now) P.glance = null;
    if (P.quip && P.quip.until <= now) P.quip = null;
    if (P.pendingObserve != null) {
      if (now - P.pendingObserve.at > OBSERVE_DEFER_MS) P.pendingObserve = null; // stale: dropped, never spoken late
      else if (!eventQuipActive(now)) { say(P.pendingObserve.text, now, 3200, "observe"); P.pendingObserve = null; }
    }
    if (!ctx) return;
    // edge-trigger: the storm arms when the state enters ERROR (one episode = one storm however long it lingers;
    // a second failed tool in the same run — ERROR → READING → ERROR — storms again even with one error clock)
    const inError = ctx.state === "ERROR";
    if (inError && !P.wasError) storm(now);
    P.wasError = inError;
    if (ctx.state === "SUCCESS") P.stormUntil = 0;
    const sleeping = mood(ctx, now) === "sleepy";
    if (!ctx.running && !ctx.booting && !quipActive(now) && now - P.lastQuipAt > (sleeping ? SLEEP_HUM_MS : IDLE_HUM_MS)) {
      const pool = sleeping ? QUIPS.sleep : ctx.changed > 8 ? [...QUIPS.idle, "{changed} modified files. busy branch."] : QUIPS.idle;
      say(fmt(pick(pool), { changed: ctx.changed }), now, 3800, "ambient");
    }
    if (ctx.running && ctx.runStartedAt != null && now - ctx.runStartedAt > LONG_RUN_MS && !P.saidLong && !quipActive(now)) {
      P.saidLong = true;
      say(pick(QUIPS.long), now, 3500, "ambient");
    }
  }

  return { state: P, observe, react, event, suggest, poke, say, level, mood, animating, tick };
}
