/** Cross-port integration: a pending /commit owns the same busy/quit lifecycle as !cmd and model turns. */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../helpers/scratch.ts";
const scratch = scratchDirs();
const MAIN = join(import.meta.dir, "../../src/cli/main.ts");

test("--plain blocks shell, compaction, branching and model input while drafting a commit; EOF cancels the draft without committing", async () => {
  const cwd = scratch("rove-merged-repl-");
  const home = scratch("rove-merged-repl-home-");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q");
  mkdirSync(join(cwd, ".nohooks"));
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", join(cwd, ".nohooks")]]) git("config", key!, value!);
  writeFileSync(join(cwd, "a.txt"), "before\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  writeFileSync(join(cwd, "a.txt"), "after\n"); git("add", "a.txt");
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await req.json(); requests++; await held;
    return Response.json({ choices: [{ message: { content: "feat: should not commit" }, finish_reason: "stop" }] });
  } });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(ROVECODE|AION|NIMBUS)_/.test(key) && !key.endsWith("_API_KEY")) env[key] = value;
  Object.assign(env, { HOME: home, ROVECODE_HOME: home, ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test", ROVECODE_MODEL: "gpt-4o", ROVECODE_RETRY_MAX: "0", ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_CHECKPOINTS: "1", ROVECODE_NO_UPDATE_CHECK: "1" });
  const proc = Bun.spawn([process.execPath, MAIN, "--plain"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let out = "", err = "";
  const pump = (async () => { const dec = new TextDecoder(); for await (const data of proc.stdout) out += dec.decode(data, { stream: true }); })();
  const errors = (async () => { const dec = new TextDecoder(); for await (const data of proc.stderr) err += dec.decode(data, { stream: true }); })();
  const wait = async (pred: () => boolean) => {
    const deadline = Date.now() + 15000;
    while (!pred() && Date.now() < deadline) await Bun.sleep(20);
    if (!pred()) throw new Error(`deadline: ${out}\n${err}`);
  };
  const type = (text: string) => { proc.stdin.write(text + "\n"); proc.stdin.flush(); };
  try {
    await wait(() => out.includes("rovecode>"));
    type("/commit"); await wait(() => requests === 1);
    for (const line of ["!echo MUST-NOT-RUN", "/compact", "/new", "overlapping model input", "/commit duplicate", "/undo"]) {
      const start = out.length; type(line);
      await wait(() => out.slice(start).includes("finish or interrupt the run first (Ctrl+C)"));
    }
    expect(requests).toBe(1);
    await proc.stdin.end();
    await wait(() => proc.exitCode !== null);
    await Promise.all([pump, errors]);
    expect(proc.exitCode).toBe(0);
    expect(out).toContain("saved (0 turns");
    expect(out).not.toContain("git commit -m");
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
    expect(git("diff", "--cached", "--name-only")).toBe("a.txt");
  } finally {
    release(); proc.kill(); await proc.exited;
    await Promise.all([pump, errors]); server.stop(true);
  }
}, 60000);
