/** PORT #26 fix-wave (critic MED-1 / L1): background tasks vs the CLI process, through the REAL CLI.
 *  Hermetic like output-modes.test.ts — ROVECODE_* and *_API_KEY scrubbed, ROVECODE_HOME → an empty temp dir,
 *  cwd → a temp workspace — with ONE loopback OpenAI-compatible provider scripting parent AND child.
 *  A run is identified by its LAST "PARENT …"/"CHILD …" user message (completion notes are user
 *  messages too, so the first user message would mislead in a multi-turn repl session).
 *  Policy under test: a one-shot `rovecode run` and a closed `--plain` repl do not outlive their process —
 *  live children are cancelled and DRAINED before exit (their in-flight bash trees die and their runs
 *  settle, answering the in-flight tool_call), and the plain repl hands rt.steering to the loop so a
 *  completion note reaches the model on the next turn. The tree-death probe is a Win32_Process query
 *  for a tagged msys `sleep` (abort.test.ts idiom; Windows only). The session check is cross-platform
 *  and is the discriminator where a Job Object already reaps the tree at process exit (win-job.ts
 *  KILL_ON_JOB_CLOSE): only a run that was cancelled AND drained answers its tool_call before exit. */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listSessions, SessionStore } from "../../src/core/session.ts";
import type { MessagePart } from "../../src/core/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const isWin = process.platform === "win32";
const T = 120_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let work = "", home = "";
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "rovecode-tcli-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-tcli-home-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Bounded await (server.test.ts idiom): a hang-shaped mutant reads as OUR failure, finally blocks still run. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
async function until(pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(50); }
}

// ---------- tagged msys `sleep` probes (abort.test.ts) ----------

const sleepTag = () => "600." + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
async function taggedSleeps(tag: string): Promise<number[]> {
  const ps = Bun.spawn(["powershell", "-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='sleep.exe' AND CommandLine LIKE '%${tag}%'").ProcessId`],
    { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
}
async function killTagged(tag: string): Promise<void> {
  for (const pid of await taggedSleeps(tag)) await Bun.spawn(["taskkill", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" }).exited;
}
/** poll (≤ms) until no tagged sleep is alive; returns the survivors */
async function survivors(tag: string, ms: number): Promise<number[]> {
  const t0 = Date.now();
  let alive = await taggedSleeps(tag);
  while (alive.length > 0 && Date.now() - t0 < ms) { await sleep(150); alive = await taggedSleeps(tag); }
  return alive;
}

// ---------- hermetic CLI ----------

function hermeticEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  }
  env.ROVECODE_HOME = home;
  return Object.assign(env, extra);
}

/** Long-lived CLI child with ONE pump per pipe (cli-wiring.test.ts spawnPumped idiom). */
function spawnCli(args: string[], extra: Record<string, string>, stdin: "pipe" | "ignore") {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: work, env: hermeticEnv({ NO_COLOR: "1", ...extra }), stdin, stdout: "pipe", stderr: "pipe" });
  const buf = { out: "", err: "" };
  const pump = (s: ReadableStream<Uint8Array>, sink: (t: string) => void) => (async () => {
    const dec = new TextDecoder();
    for await (const c of s) sink(dec.decode(c, { stream: true }));
  })().catch(() => {});
  const pumps = Promise.all([pump(p.stdout, (t) => { buf.out += t; }), pump(p.stderr, (t) => { buf.err += t; })]);
  const waitOut = async (pred: (out: string) => boolean, ms: number, what: string): Promise<void> => {
    const t0 = Date.now();
    while (!pred(buf.out)) {
      if (Date.now() - t0 > ms) throw new Error(`${what}: not seen within ${ms}ms\n--- stdout ---\n${buf.out.slice(-3000)}\n--- stderr ---\n${buf.err.slice(-3000)}`);
      await sleep(50);
    }
  };
  const exited = (async () => { const code = await p.exited; await pumps; return code; })();
  /** write a line to the child's stdin (pipe mode only) and flush it through */
  const type = (line: string): void => { const sink = p.stdin as import("bun").FileSink; sink.write(line); sink.flush(); };
  const closeStdin = (): void => { try { (p.stdin as import("bun").FileSink).end(); } catch { /* already closed */ } };
  const stop = async (): Promise<void> => { p.kill(); await p.exited.catch(() => {}); await pumps; };
  return { p, buf, waitOut, exited, type, closeStdin, stop };
}

// ---------- loopback provider (parent + child scripts) ----------

interface Recorded { goal: string; users: string[] }

/** OpenAI-compatible JSON-mode provider. Scripts, keyed by the run's current goal and the number of
 *  tool results since it:
 *    PARENT sleep → `task start` a child whose bash runs a tagged msys `sleep`; the final text is held
 *                   until that shell is PROVABLY live, so the process exit races a running tree
 *    PARENT quick → `task start` a child that answers at once; the final text waits for that child
 *    PARENT next  → text (its request shows whether the completion note reached the model)
 *    CHILD sleep  → `bash sleep <tag>`      CHILD quick → "CHILD-DONE-77" */
function fakeProvider(tag: string) {
  const requests: Recorded[] = [];
  const served = (goalPrefix: string): boolean => requests.some((r) => r.goal.startsWith(goalPrefix));
  const hold = isWin ? `sleep ${tag}` : "sleep 600";
  const usage = { prompt_tokens: 1, completion_tokens: 1 };
  const text = (content: string) => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage });
  const call = (name: string, args: unknown) => Response.json({
    choices: [{ message: { content: null, tool_calls: [{ id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
    usage,
  });
  /** Windows: the tagged sleep is visible to the OS; POSIX: the child's bash turn was served (+ a spawn beat) */
  const childShellLive = async (): Promise<boolean> => {
    if (isWin) return (await taggedSleeps(tag)).length > 0;
    if (!served("CHILD sleep")) return false;
    await sleep(300);
    return true;
  };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content?: unknown }[] };
      const content = (m: { content?: unknown }): string => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const goalIx = body.messages.findLastIndex((m) => m.role === "user" && /^(PARENT|CHILD) /.test(content(m)));
      const goal = goalIx >= 0 ? content(body.messages[goalIx]!) : "";
      const tools = body.messages.slice(goalIx + 1).filter((m) => m.role === "tool").length;
      requests.push({ goal, users: body.messages.filter((m) => m.role === "user").map(content) });
      if (goal.startsWith("PARENT sleep")) {
        if (tools === 0) return call("task", { action: "start", goal: `CHILD sleep ${tag}`, label: "sleeper" });
        await until(childShellLive, 20_000, "child shell live");
        return text("PARENT-DONE");
      }
      if (goal.startsWith("CHILD sleep")) return tools === 0 ? call("bash", { command: hold }) : text("CHILD-DONE");
      if (goal.startsWith("PARENT quick")) {
        if (tools === 0) return call("task", { action: "start", goal: "CHILD quick", label: "quick" });
        await until(() => served("CHILD quick"), 20_000, "quick child served");
        return text("PARENT-DONE");
      }
      if (goal.startsWith("CHILD quick")) return text("CHILD-DONE-77");
      return text("NEXT-DONE");
    },
  });
  return {
    env: { ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: "probe-model", ROVECODE_NO_REPOMAP: "1" },
    requests, served,
    stop: () => { server.stop(true); },
  };
}

type Call = Extract<MessagePart, { kind: "tool_call" }>;
type Result = Extract<MessagePart, { kind: "tool_result" }>;

/** The child's OWN session (runChild: one store per child, its preview is its goal) as calls + results. */
function childSession(goalPrefix: string): { calls: Call[]; results: Result[] } {
  const root = join(work, ".rovecode", "sessions");
  const all = listSessions(root);
  const s = all.find((x) => x.preview.startsWith(goalPrefix));
  if (!s) throw new Error(`no session with goal "${goalPrefix}" — have: ${all.map((x) => x.preview).join(" | ")}`);
  const parts = new SessionStore(root, s.id).messages().flatMap((m) => m.parts);
  return { calls: parts.filter((p): p is Call => p.kind === "tool_call"), results: parts.filter((p): p is Result => p.kind === "tool_result") };
}

// ---------- MED-1: rovecode run ----------

test("MED-1: `rovecode run` ending with a child mid-bash — the task is cancelled + drained before exit: exit 0, no tagged sleep survives, the child's session answers its bash call", async () => {
  const tag = sleepTag();
  const p = fakeProvider(tag);
  const cli = spawnCli(["run", "PARENT sleep", "--yolo"], p.env, "ignore");
  try {
    const code = await deadline(cli.exited, 90_000, "rovecode run exits");
    expect(cli.buf.out).toContain("PARENT-DONE");
    expect(code).toBe(0);
    expect(p.served(`CHILD sleep ${tag}`)).toBe(true); // the child WAS mid-bash when the parent finished (the provider gated PARENT-DONE on it)
    if (isWin) expect(await survivors(tag, 3_000)).toEqual([]);
    // the cancelled child's run SETTLED before the process went: its bash tool_call has an answer (the
    // killed shell's exit or the loop's aborted synthesis). Mutation target: drop cancelAll + drain from
    // cmdRun's exit() → process.exit lands mid-run and the call stays orphaned
    const child = childSession(`CHILD sleep ${tag}`);
    expect(child.calls.map((c) => c.tool)).toEqual(["bash"]);
    expect(child.results).toHaveLength(1);
    expect(child.results[0]!.ok).toBe(false);
  } finally {
    await cli.stop();
    if (isWin) await killTagged(tag);
    p.stop();
  }
}, T);

// ---------- L1: rovecode --plain ----------

test("L1: `rovecode --plain` — a task's completion note reaches the model on the NEXT turn (rt.steering), and quitting cancels + drains a live task (exit 0, no survivor, no orphan)", async () => {
  const tag = sleepTag();
  const p = fakeProvider(tag);
  const cli = spawnCli(["--plain", "--yolo"], p.env, "pipe");
  try {
    await cli.waitOut((o) => o.includes("rovecode>"), 30_000, "repl prompt");
    cli.type("PARENT quick\n");
    await cli.waitOut((o) => o.includes("PARENT-DONE"), 30_000, "turn 1 done");
    await sleep(500); // the child answered before PARENT-DONE (provider-gated); its task settles right after → note queued
    cli.type("PARENT next\n");
    await cli.waitOut((o) => o.includes("NEXT-DONE"), 30_000, "turn 2 done");
    const next = p.requests.find((r) => r.goal === "PARENT next");
    expect(next).toBeDefined();
    // mutation target: the repl hands agentLoop a fresh SteeringQueue instead of rt.steering → no note in the request
    expect(next!.users.some((u) => /^task t1 \(quick\) finished: CHILD-DONE-77/.test(u))).toBe(true);
    // a LIVE task at quit
    cli.type("PARENT sleep\n");
    await cli.waitOut((o) => o.split("PARENT-DONE").length > 2, 60_000, "turn 3 done");
    cli.type("/exit\n"); // rl.close() → "close" → cancelAll + drain → bye → exit 0
    const code = await deadline(cli.exited, 30_000, "repl exits after /exit");
    expect(code).toBe(0);
    expect(cli.buf.out).toContain("bye");
    if (isWin) expect(await survivors(tag, 3_000)).toEqual([]);
    // mutation target: drop cancelAll + drain from the close path → the child's bash call stays orphaned
    const child = childSession(`CHILD sleep ${tag}`);
    expect(child.calls.map((c) => c.tool)).toEqual(["bash"]);
    expect(child.results).toHaveLength(1);
  } finally {
    cli.closeStdin();
    await cli.stop();
    if (isWin) await killTagged(tag);
    p.stop();
  }
}, T);
