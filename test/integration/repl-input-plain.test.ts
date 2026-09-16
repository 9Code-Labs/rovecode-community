/** Port #78 end-to-end: the real --plain readline surface, piped stdin, a loopback-only provider.
 *  Unit tests use spy bash; this suite runs only a harmless echo through the real configured tool. */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../src/core/session.ts";
import { partsText } from "../../src/core/loop.ts";
import { parseShellRecord } from "../../src/tui/shell-cmd.ts";
import { MENTION_FRAME } from "../../src/sextant/mentions.ts";
import { PNG_1x1 } from "../fixtures/images.ts";
import { removeDir } from "../helpers/scratch.ts";
const NL = String.fromCharCode(10);
const MAIN = join(import.meta.dir, "../../src/cli/main.ts");

async function waitFor(pred: () => boolean, detail: () => string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(20);
  if (!pred()) throw new Error(`deadline: ${detail()}`);
}
function child(extra: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-repl-p78-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-repl-p78-home-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ROVECODE_") && !k.endsWith("_API_KEY")) env[k] = v;
  Object.assign(env, { ROVECODE_HOME: home, ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_CHECKPOINTS: "1", ROVECODE_NO_UPDATE_CHECK: "1", NO_COLOR: "1" }, extra);
  const proc = Bun.spawn([process.execPath, MAIN, "--plain"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const buf = { out: "", err: "" };
  const pump = (async () => { const dec = new TextDecoder(); for await (const c of proc.stdout) buf.out += dec.decode(c, { stream: true }); })();
  const errors = (async () => { const dec = new TextDecoder(); for await (const c of proc.stderr) buf.err += dec.decode(c, { stream: true }); })();
  const type = (line: string) => { proc.stdin.write(line + NL); proc.stdin.flush(); };
  const wait = (text: string, start = 0) => waitFor(() => buf.out.slice(start).includes(text), () => `${text}${NL}${buf.out}${NL}${buf.err}`);
  const exit = async () => { type("/exit"); await waitFor(() => proc.exitCode !== null, () => buf.out + buf.err); await pump; expect(proc.exitCode).toBe(0); };
  const close = async () => { proc.kill(); await proc.exited; await Promise.all([pump, errors]); removeDir(cwd); removeDir(home); };
  return { cwd, home, proc, buf, type, wait, exit, close };
}

test("--plain without a provider: gated shell denial records nothing; echo runs, records once, no model turn", async () => {
  const c = child();
  try {
    await c.wait("rovecode>");
    c.type("!frobnicate --yes"); await c.wait("allow? [y]es / [a]lways / [n]o:");
    c.type("n"); await c.wait("was denied at the approval card — nothing ran, nothing recorded");
    c.type("!echo PORT78-SHELL"); await c.wait("← ok");
    await c.exit(); expect(c.buf.out).toContain("saved (0 turns");
    const root = join(c.cwd, ".rovecode", "sessions"); const ids = readdirSync(root);
    expect(ids).toHaveLength(1);
    const messages = new SessionStore(root, ids[0]!).messages(); expect(messages).toHaveLength(1);
    expect(parseShellRecord(partsText(messages[0]!.parts))).toMatchObject({ cmd: "echo PORT78-SHELL", exit: "0", output: "PORT78-SHELL" });
  } finally { await c.close(); }
}, 30000);

test("--plain real prompt: @text and @image reach the next request; a busy run refuses another prompt and !cmd", async () => {
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    requests.push(await req.json() as typeof requests[number]); await held;
    return Response.json({ choices: [{ message: { content: "PORT78-ANSWER" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const c = child({ ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "local-test", ROVECODE_MODEL: "gpt-4o" });
  try {
    writeFileSync(join(c.cwd, "f.txt"), "PORT78-FILE-CONTENT"); writeFileSync(join(c.cwd, "dot.png"), PNG_1x1);
    await c.wait("rovecode>"); c.type("explain @f.txt @dot.png");
    await waitFor(() => requests.length === 1, () => c.buf.out + c.buf.err);
    const start = c.buf.out.length; c.type("!echo MUST-NOT-RUN"); await c.wait("finish or interrupt the run first (Ctrl+C)", start);
    const next = c.buf.out.length; c.type("overlapping model prompt"); await c.wait("finish or interrupt the run first (Ctrl+C)", next);
    expect(requests).toHaveLength(1);
    const user = requests[0]!.messages.findLast((m) => m.role === "user")!;
    expect(JSON.stringify(user.content)).toContain(MENTION_FRAME); expect(JSON.stringify(user.content)).toContain("PORT78-FILE-CONTENT");
    expect(JSON.stringify(user.content)).toContain("data:image/png;base64,");
    release(); await c.wait("PORT78-ANSWER");
    const initStart = c.buf.out.length; c.type("/init"); await c.wait("PORT78-ANSWER", initStart);
    expect(requests).toHaveLength(2);
    const init = requests[1]!.messages.findLast((m) => m.role === "user")!;
    expect(JSON.stringify(init.content)).toContain("Analyse this repository and write an AGENTS.md file");
    await c.exit();
    expect(c.buf.out).toContain("saved (2 turns"); expect(c.buf.out).not.toContain("→ bash");
  } finally { release(); await c.close(); server.stop(true); }
}, 30000);
