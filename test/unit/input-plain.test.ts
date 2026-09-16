/** Port #78: adapted from aion/test/unit/input-plain.test.ts. Real runtime policy, spy bash (no spawn),
 *  rovecode's three-way ladder and hashline-aware mentions. No aion permissions/save or XML abstractions. */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { WorkspaceRoots } from "../../src/core/workspace.ts";
import { agentLoop, partsText } from "../../src/core/loop.ts";
import type { Message, StreamFn, Tool } from "../../src/core/types.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { MENTION_FRAME, expandMentions } from "../../src/sextant/mentions.ts";
import { askPlainApproval, expandPlainInput, PLAIN_APPROVAL_QUESTION, runPlainShellLine, type PlainInputDeps } from "../../src/tui/input-plain.ts";
import { parseShellRecord, REFUSED_DETAIL } from "../../src/tui/shell-cmd.ts";
import { PNG_1x1 } from "../fixtures/images.ts";
import { scratchDirs } from "../helpers/scratch.ts";
const scratch = scratchDirs();
const NL = String.fromCharCode(10);

function boot(over: { yolo?: boolean; busy?: boolean; answer?: string } = {}) {
  const cwd = scratch("rovecode-p78-");
  writeFileSync(join(cwd, "f.txt"), ["alpha", "beta", ""].join(NL));
  writeFileSync(join(cwd, "dot.png"), PNG_1x1); mkdirSync(join(cwd, "sub"));
  const rt = createRuntime({ cwd, stream: null });
  const executed: string[] = [], out: string[] = [], questions: string[] = [], askedWhen: number[] = [];
  const aborts: (AbortController | null)[] = [];
  const flags = { busy: over.busy ?? false, answer: over.answer ?? "y" };
  const tool: Tool = {
    schema: { name: "bash", description: "spy", args: { type: "object", properties: { command: { type: "string" } } } }, kind: "execute",
    async execute(args, ctx) {
      const cmd = String((args as { command: string }).command); executed.push(cmd);
      if (cmd === "hang") {
        await new Promise<void>((res) => { if (ctx.signal.aborted) res(); else ctx.signal.addEventListener("abort", () => res(), { once: true }); });
        return { ok: false, output: ["exit=143", "[killed]", ""].join(NL) };
      }
      return cmd === "false" ? { ok: false, output: `exit=1${NL}` } : { ok: true, output: ["exit=0", `ran ${cmd}`, ""].join(NL) };
    },
  };
  rt.registry.register(tool);
  const deps: PlainInputDeps = { rt, yolo: () => over.yolo ?? false, busy: () => flags.busy, bindAbort: (ac) => { aborts.push(ac); }, ask: async (q) => { questions.push(q); askedWhen.push(executed.length); return flags.answer; }, modelRef: () => ({ provider: "custom", model: "vision-test" }), out: (line) => out.push(line) };
  return { cwd, rt, deps, out, executed, questions, askedWhen, aborts, flags,
    run: (line: string) => runPlainShellLine(deps, line),
    records: () => rt.store.messages().map((m) => parseShellRecord(partsText(m.parts))),
    close: async () => { for (const ac of aborts) ac?.abort(); await rt.hooks.close(); await rt.mcp?.close(); rt.bashJobs.dispose(); resetExecutor(); },
  };
}

test("T1: gated shell asks the shared question BEFORE dispatch; one record, card pair, no double echo, abort slot cleared", async () => {
  const b = boot();
  try {
    await b.run("  !frobnicate --yes  ");
    expect(PLAIN_APPROVAL_QUESTION).toBe("  allow? [y]es / [a]lways / [n]o: ");
    expect(b.questions).toEqual([PLAIN_APPROVAL_QUESTION]); expect(b.askedWhen).toEqual([0]);
    expect(b.executed).toEqual(["frobnicate --yes"]);
    expect(b.records()).toEqual([{ cmd: "frobnicate --yes", exit: "0", output: "ran frobnicate --yes" }]);
    expect(b.rt.store.messages().map((m) => m.role)).toEqual(["user"]);
    expect(b.out).toEqual([`${NL}  approval needed: bash {"command":"frobnicate --yes"}`, `${NL}  → bash {"command":"frobnicate --yes"}`, "  ← ok exit=0 ⏎ ran frobnicate --yes ⏎ ", `  exit=0${NL}ran frobnicate --yes`]);
    expect(b.aborts).toEqual([expect.any(AbortController), null]);
  } finally { await b.close(); }
});

test("T2: execpolicy refuses force-push before any question, execution or record; honest policy refusal", async () => {
  const b = boot();
  try {
    await b.run("!git push --force");
    expect(b.questions).toEqual([]); expect(b.executed).toEqual([]); expect(b.records()).toEqual([]);
    expect(b.out).toContain(`  ← FAIL permission_denied: ${REFUSED_DETAIL}`);
    expect(b.out.join(NL)).not.toContain("user denied"); expect(b.out.at(-1)).toContain("nothing ran, nothing recorded");
  } finally { await b.close(); }
});

test("T3: no/empty deny, always remembers only in-session, all existing other answers retain once semantics", async () => {
  for (const answer of ["n", "", "a", "yes", "x"]) {
    const b = boot({ answer });
    try {
      await b.run("!frobnicate --yes");
      if (answer === "n" || answer === "") { expect(b.executed).toEqual([]); expect(b.records()).toEqual([]); expect(b.out.at(-1)).toContain("denied at the approval card"); }
      else {
        expect(b.executed).toEqual(["frobnicate --yes"]);
        await b.run("!frobnicate --yes");
        expect(b.questions).toHaveLength(answer === "a" ? 1 : 2);
      }
    } finally { await b.close(); }
  }
});

test("T4: allow-listed argv and yolo skip the card; failed execution still records its exit", async () => {
  const b = boot();
  try {
    await b.run("!ls -la"); expect(b.questions).toEqual([]); expect(b.executed).toEqual(["ls -la"]);
    await b.run("!false"); expect(b.questions).toEqual([PLAIN_APPROVAL_QUESTION]);
    expect(b.records().at(-1)).toEqual({ cmd: "false", exit: "1", output: "" }); expect(b.out.at(-1)).toBe("  warn: exit=1");
  } finally { await b.close(); }
  const y = boot({ yolo: true });
  try { await y.run("!frobnicate"); expect(y.questions).toEqual([]); expect(y.executed).toEqual(["frobnicate"]); }
  finally { await y.close(); }
});

test("T5: busy refuses without binding an abort; non-shell text never dispatches", async () => {
  const b = boot({ busy: true });
  try {
    await b.run("!ls"); expect(b.executed).toEqual([]); expect(b.aborts).toEqual([]); expect(b.out[0]).toContain("runs only while the agent is idle");
    b.out.length = 0; b.flags.busy = false;
    for (const line of ["!", "! x", "!!x", "hello !world", "me@example.com", ""]) await b.run(line);
    expect(b.out).toEqual([]); expect(b.records()).toEqual([]);
  } finally { await b.close(); }
});

test("T6: the bound Ctrl+C controller aborts a hanging shell, preserves the killed record, then clears", async () => {
  const b = boot({ yolo: true });
  let pending: Promise<void> | undefined;
  try {
    pending = b.run("!hang");
    const end = Date.now() + 2000;
    while (!b.executed.length && Date.now() < end) await Bun.sleep(10);
    expect(b.executed).toEqual(["hang"]); b.aborts[0]!.abort(); await pending;
    expect(b.records()).toEqual([{ cmd: "hang", exit: "143", output: "[killed]" }]); expect(b.aborts.at(-1)).toBeNull();
  } finally { await b.close(); await pending; }
}, 5000);

test("T7: mentions use rovecode's ONE hashline expansion; images use cmdAttach and the live model; misses/directories warn", async () => {
  const b = boot();
  try {
    const expected = expandMentions("hi @f.txt", { cwd: b.cwd, resolve: (p) => p }).text;
    expect(expandPlainInput(b.deps, "hi @f.txt")).toBe(expected); expect(expected).toContain(MENTION_FRAME);
    expect(b.out).toEqual(["  attached: f.txt (3 lines)"]); b.out.length = 0;
    expect(expandPlainInput(b.deps, "look @dot.png")).toBe("look @dot.png");
    expect(b.rt.store.stagedAttachments.map((p) => [p.kind, p.mime])).toEqual([["image", "image/png"]]);
    expect(b.out[0]).toBe("  attached dot.png, 1x1, 70 B (1/8) — type your message and press Enter to send it");
    expect(b.out.some((l) => l.includes("custom/vision-test"))).toBe(true); b.out.length = 0;
    expect(expandPlainInput(b.deps, "@missing.txt hi")).toBe("@missing.txt hi");
    expect(b.out).toEqual(["  warn: @missing.txt: no file in the workspace matches"]); b.out.length = 0;
    expect(expandPlainInput(b.deps, "see @sub")).toBe("see @sub"); expect(b.out).toEqual(["  warn: @sub: a directory — name a file in it"]); b.out.length = 0;
    expect(expandPlainInput(b.deps, "mail me@example.com")).toBe("mail me@example.com"); expect(b.out).toEqual([]); expect(b.records()).toEqual([]);
  } finally { await b.close(); }
});

test("T8: next agent turn sees the shell record then the expanded goal, with image folded into the goal only", async () => {
  const b = boot();
  try {
    expandPlainInput(b.deps, "@dot.png"); await b.run("!frobnicate --yes");
    expect(b.rt.store.stagedAttachments).toHaveLength(1); expect(b.rt.store.messages()[0]!.parts.map((p) => p.kind)).toEqual(["text"]);
    const goal = expandPlainInput(b.deps, "what happened? @f.txt"); let seen: Message[] = [];
    const stream: StreamFn = async function* (_model, messages) { seen = messages; yield { type: "turn", turn: textTurn("done") }; };
    for await (const _ of agentLoop({ name: "main", model: { provider: "mock", model: "scripted" }, tools: ["*"], systemPrompt: "test" }, goal, {}, b.rt.buildCfg(true), { stream, registry: b.rt.registry, store: b.rt.store, cwd: b.cwd, hooks: b.rt.hooks }, b.rt.steering)) { /* drain */ }
    const users = seen.filter((m) => m.role === "user"); expect(users).toHaveLength(2);
    expect(parseShellRecord(partsText(users[0]!.parts))?.cmd).toBe("frobnicate --yes"); expect(partsText(users[1]!.parts)).toBe(goal);
    expect(users[1]!.parts.map((p) => p.kind)).toEqual(["text", "image"]); expect(b.rt.store.stagedAttachments).toEqual([]); expect(b.executed).toEqual(["frobnicate --yes"]);
  } finally { await b.close(); }
});

test("T9: shared approval detail/ladder and source wiring; no new dispatch, executor or environment abstraction", async () => {
  const out: string[] = [];
  expect(await askPlainApproval(async (q) => { expect(q).toBe(PLAIN_APPROVAL_QUESTION); return "n"; }, "bash", "args", ["one", "two"].join(NL), (line) => out.push(line))).toBe("deny");
  expect(out).toEqual([`${NL}  approval needed: bash args`, "    one", "    two"]);
  const adapter = readFileSync(join(import.meta.dir, "../../src/tui/input-plain.ts"), "utf8");
  for (const forbidden of ["child_process", "core/executor", "Bun.spawn", ".dispatch(", "process.env"]) expect(adapter).not.toContain(forbidden);
  const repl = readFileSync(join(import.meta.dir, "../../src/cli/repl.ts"), "utf8");
  expect(repl.indexOf("if (shellLine(text)")).toBeLessThan(repl.indexOf("const reason = rt.noProviderReason()"));
  expect(repl).toContain("agentLoop(def, goal,"); expect(repl).toContain("shellRun?.abort()"); expect(repl).toContain("await Promise.all([shellPending, gitPending, compactPending]");
});

test("T10: added roots, binary/cap notes and relative traversal retain rovecode's existing boundaries", async () => {
  const b = boot();
  try {
    const root = scratch("rovecode-p78-root-"); writeFileSync(join(root, "external.txt"), "root content");
    b.deps.rt = { ...b.rt, roots: new WorkspaceRoots(b.cwd, { dirs: [root], notes: [] }) };
    expect(expandPlainInput(b.deps, "@external.txt")).toContain("root content");
    writeFileSync(join(b.cwd, "binary.bin"), Buffer.from([0, 1, 2])); b.out.length = 0;
    expect(expandPlainInput(b.deps, "@binary.bin")).toBe("@binary.bin"); expect(b.out[0]).toContain("a binary file — not attached");
    writeFileSync(join(b.cwd, "long.txt"), Array.from({ length: 500 }, () => "line").join(NL)); b.out.length = 0;
    expect(expandPlainInput(b.deps, "@long.txt")).toContain("capped: read it with offset 401"); expect(b.out.some((s) => s.includes("attached the first 400"))).toBe(true);
    expect(expandPlainInput(b.deps, `@../${root.split(/[\\/]/).at(-1)}/external.txt`)).not.toContain("root content");
  } finally { await b.close(); }
});
