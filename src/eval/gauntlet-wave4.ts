/** Gauntlet Wave-4 adversarial/basic tasks (web_fetch SSRF · session tamper + resume · output-JSON
 *  purity). Each drives a REAL seam — the tool dispatch pipeline, the session store plus its wire
 *  lowering, or the actual `rovecode run` CLI as a subprocess — never a unit call. Offline + hermetic:
 *  injected fetch/DNS spies (no network), the ambient web_fetch knobs scoped off (withEnv), temp dirs
 *  under the run's scratch root, a scrubbed CLI env. Every session dir a task makes is cleaned so the
 *  workspace-leak assertion (gauntlet.ts) holds.
 *
 *  Ported 2026-09-07 from the upstream harness's wave 4, MINUS its cancel-mid-tool case. That case
 *  proved a real property (bash threads the run's signal into the executor, so an aborted run leaves no
 *  process tree) but its verdict rested on polling a process probe — a PowerShell CIM query per poll on
 *  this platform — so its failure mode was "a loaded machine" rather than "the guardrail broke". A
 *  gauntlet case nobody trusts costs more than it proves; cancellation belongs in an integration test
 *  where the probe is not the verdict. Named here so the gap is visible rather than silently missing. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentLoop, SteeringQueue, type LoopDeps } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { createWebFetchTool, type FetchLike, type Resolver } from "../tools/webfetch.ts";
import { textTurn, toOpenAiMessages, toolTurn } from "../providers/stream.ts";
import type { AgentDefinition, Message, MessagePart, PermissionRule, RunConfig, StreamFn } from "../core/types.ts";
import type { GauntletTask, GauntletTranscript } from "./gauntlet.ts";
import { withEnv } from "./gauntlet-support.ts";
import { trustFile } from "../core/trust.ts";

// ---------- shared ----------

const allowAll: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];
const DEF: AgentDefinition = { name: "gauntlet", systemPrompt: "eval", tools: ["*"], maxTurns: 8 };
const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

function tryParse(s: string): boolean { try { JSON.parse(s); return true; } catch { return false; } }

/** Drive one agent loop over a caller-owned store; collect the gauntlet transcript. The store is the
 *  caller's (so it can pre-seed it or run twice on it) — this never creates or cleans a session dir. */
async function driveLoop(store: SessionStore, opts: {
  goal: string; registry: ToolRegistry; stream: StreamFn; rules: PermissionRule[]; cwd: string;
  signal?: AbortSignal; maxTurns?: number;
}): Promise<GauntletTranscript> {
  const toolCalls: { tool: string; args: unknown }[] = [];
  const events: { type: string }[] = [];
  let finalText = "";
  const cfg: RunConfig = { maxTurns: opts.maxTurns ?? 8, contextBudgetTokens: 200_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: opts.rules };
  const deps: LoopDeps = { stream: opts.stream, registry: opts.registry, store, cwd: opts.cwd, ...(opts.signal ? { signal: opts.signal } : {}) };
  for await (const ev of agentLoop(DEF, opts.goal, {}, cfg, deps, new SteeringQueue())) {
    events.push({ type: ev.type });
    if (ev.type === "tool_execution_start") toolCalls.push({ tool: ev.tool, args: ev.args });
    if (ev.type === "run_end") finalText = ev.summary;
  }
  return { toolCalls, events, finalText, recovered: events.some((e) => e.type === "tool_execution_end") && finalText.length > 0 };
}

/** Run the REAL CLI (`bun main.ts …`) with a scrubbed env — no ROVECODE_* or *_API_KEY inherited,
 *  ROVECODE_HOME → the task's own dir, the canned provider asked for explicitly — so the run cannot
 *  reach a network or read the developer's config. */
async function cliRun(args: string[], cwd: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  env.ROVECODE_HOME = home;
  env.ROVECODE_MOCK = "1";
  env.NO_COLOR = "1";
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

// ---------- tasks ----------

export function wave4Tasks(): GauntletTask[] {
  return [
    // 1) web_fetch's SSRF guard refuses loopback / link-local / IPv6-loopback literals, a public NAME
    //    whose (injected) resolver answers with a private address, AND a 302 from a public host to
    //    127.0.0.1 — the guard re-runs on EVERY hop, so the only href the injected fetch spy ever sees
    //    is the redirect's public first hop (fetches=1) and no private href reaches it (leaked=0).
    //    The ambient ROVECODE_WEBFETCH_* knobs are scoped off so the task cannot inherit an
    //    allow-private shell. The refusal REASON is pinned, not just the count: rovecode also refuses a
    //    CROSS-HOST redirect (a separate rule, applied after the guard), so counting refusals alone
    //    would still pass with the SSRF check deleted. Mutations: force allowPrivate=true in
    //    tools/webfetch.ts → the spy runs 5× and PRIVATE-FETCHED.txt appears; guard the first hop only
    //    → the redirect target comes back with the cross-host wording instead of an address reason.
    {
      id: "adversarial-webfetch-ssrf", category: "adversarial",
      prompt: "fetch internal URLs",
      timeoutMs: 20_000,
      setup: (root) => mkdtempSync(join(root ?? "", "rovecode-g-")),
      run: (_task, workspace, root) => withEnv({ ROVECODE_WEBFETCH_ALLOW_PRIVATE: undefined, ROVECODE_WEBFETCH_TIMEOUT_MS: undefined }, async () => {
        const PUBLIC = "redir.test"; // the one host whose (public) first hop may legitimately be fetched
        const marker = join(workspace, "PRIVATE-FETCHED.txt");
        const seen: string[] = [];
        const spyFetch: FetchLike = async (url) => {
          seen.push(url);
          if (new URL(url).hostname === PUBLIC) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
          writeFileSync(marker, `${url}\n`, { flag: "a" });
          return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
        };
        const spyResolve: Resolver = async (host) => (host === "public.test" ? ["10.0.0.5"] : ["93.184.216.34"]);
        const reg = new ToolRegistry();
        reg.register(createWebFetchTool({ fetch: spyFetch, resolve: spyResolve }));
        const urls = ["http://127.0.0.1:1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://public.test/", `http://${PUBLIC}/`];
        const stream: StreamFn = async function* (_m, messages) {
          const toolMsgs = messages.filter((m) => m.role === "tool");
          if (toolMsgs.length === 0) { yield { type: "turn", turn: toolTurn(urls.map((u, i) => ({ id: `f${i}`, tool: "web_fetch", args: { url: u } }))) }; return; }
          const outs = toolMsgs.flatMap((m) => m.parts).filter((p): p is Extract<MessagePart, { kind: "tool_result" }> => p.kind === "tool_result");
          const refused = outs.filter((p) => !p.ok && p.output.includes("refused")).length;
          // every refusal must name an ADDRESS reason, not the cross-host rule — that is what makes this
          // case about the SSRF guard rather than about redirect policy
          const addressReason = outs.filter((p) => !p.ok && /refused .*(loopback|private|link-local|reserved|unique-local)/i.test(p.output)).length;
          yield { type: "turn", turn: textTurn(`SSRF-REFUSED-${refused} address-${addressReason}`) };
        };
        const cliDir = mkdtempSync(join(root, "rovecode-cli-g-"));
        try {
          const store = new SessionStore(cliDir, randomUUID());
          const t = await driveLoop(store, { goal: "fetch internal URLs", registry: reg, stream, rules: allowAll, cwd: workspace, maxTurns: 6 });
          const leaked = seen.filter((h) => new URL(h).hostname !== PUBLIC);
          return { ...t, finalText: `${t.finalText} fetches=${seen.length} leaked=${leaked.length}${leaked.length > 0 ? ` [${leaked.join(" ")}]` : ""}` };
        } finally { rmSync(cliDir, { recursive: true, force: true }); }
      }),
      verify: (workspace, t) => ["SSRF-REFUSED-5", "address-5", "fetches=1", "leaked=0"].every((s) => t.finalText.split(" ").includes(s))
        && !existsSync(join(workspace, "PRIVATE-FETCHED.txt")),
    },

    // 2) Resuming a TAMPERED session JSONL (a self-parented cycle line, an id-less line, and an image
    //    part whose ABSOLUTE path points at a PNG outside the session) must not hang, must report the
    //    corruption, and the planted file must never be read: its wire lowering is a placeholder.
    //    Mutations: drop the isAbsolute branch in session-images.ts hydrateImageParts → the planted bytes
    //    are read and base64'd into the wire, so noleak=false; remove the cycle guard in session.ts
    //    wrappedPath → the run never finishes.
    //    This case found a REAL defect on the way in (2026-09-07): SessionStore.path() walked parentId
    //    links with no visited set, so the self-parented line below made every resume — run --resume,
    //    trace, export, context — spin until `RangeError: Out of memory`. reload() already REPORTED the
    //    cycle; the walk just did not use that. Fixed in core/session.ts wrappedPath.
    {
      id: "adversarial-session-tamper", category: "adversarial",
      prompt: "resume a tampered session",
      timeoutMs: 15_000,
      setup: (root) => mkdtempSync(join(root ?? "", "rovecode-g-")),
      run: async (_task, workspace) => {
        const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const planted = join(workspace, "planted.png");
        writeFileSync(planted, Buffer.from(PNG_B64, "base64"));
        const sessRoot = join(workspace, "sessions");
        const sid = "tampered";
        const seed = new SessionStore(sessRoot, sid);
        seed.append({ id: "u1", role: "user", parts: [{ kind: "text", text: "hello" }], parentId: null, createdAt: 1 });
        seed.append({ id: "img1", role: "user", parts: [{ kind: "image", mime: "image/png", path: planted } as MessagePart], parentId: "u1", createdAt: 2 });
        const entriesPath = join(sessRoot, sid, "entries.jsonl");
        const cycle = { id: "loop", parentId: "loop", createdAt: 3, prevHash: "", hash: "dead", entry: { id: "loop", role: "user", parts: [{ kind: "text", text: "loop" }], parentId: "loop", createdAt: 3 } };
        const idless = { parentId: null, createdAt: 4, prevHash: "", hash: "", entry: { role: "user", parts: [{ kind: "text", text: "x" }] } };
        // a VALID last line parented to the image, so the resumed leaf is a real entry and the active path
        // still reaches img1. Without it the tail is the cycle line, the path truncates to that one entry,
        // and the case would report placeholder=false for the boring reason that no image was in the
        // prompt at all — a tamper case must still get as far as lowering the tampered part.
        const tail = { id: "u2", parentId: "img1", createdAt: 5, prevHash: "", hash: "tail", entry: { id: "u2", role: "user", parts: [{ kind: "text", text: "carry on" }], parentId: "img1", createdAt: 5 } };
        writeFileSync(entriesPath, `${JSON.stringify(cycle)}\n${JSON.stringify(idless)}\n${JSON.stringify(tail)}\n`, { flag: "a" });

        const store = new SessionStore(sessRoot, sid);
        const findings = store.reload();
        const hasCycle = findings.some((f) => f.kind === "cycle");
        const hasIdless = findings.some((f) => f.kind === "unknown-shape");
        const b64Prefix = PNG_B64.slice(0, 40);
        const stream: StreamFn = async function* (_m, messages) {
          const imgs = messages.flatMap((m) => m.parts).filter((p): p is Extract<MessagePart, { kind: "image" }> => p.kind === "image");
          const leaked = imgs.some((p) => p.bytes !== undefined || p.path !== undefined);
          const wire = JSON.stringify(toOpenAiMessages(messages));
          const placeholder = wire.includes("file unavailable");
          const noLeak = !wire.includes(b64Prefix);
          yield { type: "turn", turn: textTurn(`RESUMED leaked=${leaked} placeholder=${placeholder} noleak=${noLeak}`) };
        };
        const t = await driveLoop(store, { goal: "resume the tampered session", registry: new ToolRegistry(), stream, rules: allowAll, cwd: workspace, maxTurns: 3 });
        return { ...t, finalText: `${t.finalText} cyc=${hasCycle} idless=${hasIdless}` };
      },
      verify: (_w, t) => ["leaked=false", "placeholder=true", "noleak=true", "cyc=true", "idless=true"].every((s) => t.finalText.includes(s)),
    },

    // 3) `rovecode run --output json` through the REAL CLI (subprocess, scratch cwd + home, scrubbed
    //    env): a project `.rovecode/hooks.ts` that writes to stdout from session_open (during boot) AND
    //    from pre_run still leaves exactly ONE JSON object on stdout — the leaks go to stderr — with
    //    exit 0; ndjson stays all-JSON. Mutation: install guardStdout AFTER bootRuntime in cli/main.ts
    //    cmdRun (it is at main.ts:83, the boot at :91) → the boot-time leak lands on stdout and the
    //    whole-stdout JSON.parse fails.
    //    CONTROL, and the reason this case is not the upstream one: rovecode has no `--trust` flag, and
    //    an untrusted project hooks.ts simply does not load — the leak would never happen and the case
    //    would pass with nothing tested. So the task seeds the scratch home's trust store for the file
    //    it wrote (core/trust.ts trustFile) and REQUIRES the leak on stderr: stderrLeak=false fails.
    {
      id: "basic-output-json-purity", category: "basic",
      prompt: "run through the CLI with --output json",
      timeoutMs: 60_000,
      setup: (root) => mkdtempSync(join(root ?? "", "rovecode-g-")),
      run: async (_task, workspace) => {
        const home = join(workspace, "home"); mkdirSync(home, { recursive: true });
        const hooks = join(workspace, ".rovecode", "hooks.ts");
        mkdirSync(join(workspace, ".rovecode"), { recursive: true });
        writeFileSync(hooks,
          `export default { version: 1, hooks: {\n  session_open() { console.log("BOOT-LEAK-LOG"); process.stdout.write("BOOT-LEAK-WRITE\\n"); },\n  pre_run() { console.log("RUN-LEAK-LOG"); },\n} };\n`);
        const trusted = trustFile(home, hooks);
        if (!trusted.ok) throw new Error(`gauntlet: could not trust ${hooks}: ${trusted.reason}`);
        const j = await cliRun(["run", "say hi", "--output", "json"], workspace, home);
        const n = await cliRun(["run", "say hi", "--output", "ndjson"], workspace, home);
        const jl = j.stdout.split("\n");
        const oneObject = jl.length === 2 && jl[1] === "" && tryParse(jl[0]!);
        const status = oneObject && (JSON.parse(jl[0]!) as { status: string }).status === "done";
        const stderrLeak = j.stderr.includes("BOOT-LEAK-LOG") && j.stderr.includes("BOOT-LEAK-WRITE");
        const nlines = n.stdout.endsWith("\n") ? n.stdout.slice(0, -1).split("\n") : [n.stdout];
        const ndjson = n.stdout.endsWith("\n") && nlines.every(tryParse);
        return {
          toolCalls: [], events: [{ type: "run_end" }],
          finalText: `JSONPURE oneObject=${oneObject} status=${status} exit0=${j.code === 0} stderrLeak=${stderrLeak} ndjson=${ndjson} nexit0=${n.code === 0}`,
          recovered: true,
        };
      },
      verify: (_w, t) => ["oneObject=true", "status=true", "exit0=true", "stderrLeak=true", "ndjson=true", "nexit0=true"].every((s) => t.finalText.includes(s)),
    },
  ];
}
