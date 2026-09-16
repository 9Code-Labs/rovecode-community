/** Notifications negatives at the process boundary. (1) A real CLI child `rovecode run "say hi" --output json` with every
 *  notify knob set (bell, always, a marker-writing notify_command) against the mock provider: stdout is ONE JSON object with
 *  zero BEL bytes and no DECSET, and the marker never appears — headless surfaces never build the notifier. (2) The static
 *  half of the same promise: under src/cli only main.ts (the interactive boot) imports tui/notify.ts; run, repl (--plain),
 *  serve and acp do not. Env scrubbed of every ROVECODE_* and *_API_KEY; ROVECODE_HOME → an empty temp dir. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
let cwd = "", home = "";
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "rovecode-notify-cli-")); home = mkdtempSync(join(tmpdir(), "rovecode-notify-home-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test("`rovecode run … --output json` with ROVECODE_NOTIFY=bell, NOTIFY_WHEN=always and a marker-writing NOTIFY_COMMAND: one JSON object, zero BEL, zero DECSET, no marker", () => {
  const marker = join(cwd, "hook-ran.txt");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  env.HOME = home; env.USERPROFILE = home; env.ROVECODE_HOME = home;
  env.ROVECODE_MOCK = "1";
  env.ROVECODE_NOTIFY = "bell"; env.ROVECODE_NOTIFY_WHEN = "always";
  env.ROVECODE_NOTIFY_COMMAND = JSON.stringify([process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.at(-1) ?? "")`]);
  const r = Bun.spawnSync([process.execPath, MAIN, "run", "say hi", "--output", "json"], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000, killSignal: "SIGKILL" });
  const stdout = r.stdout.toString();
  expect(r.exitCode).toBe(0);
  expect(stdout).not.toContain("\x07");        // MUTATION: the notifier built on a headless surface
  expect(stdout).not.toContain("\x1b[?1004");
  expect(r.stderr.toString()).not.toContain("\x07");
  const parsed = JSON.parse(stdout) as { status: string };
  expect(parsed.status).toBe("done");
  expect(existsSync(marker)).toBe(false);      // the hook never ran
  expect(readdirSync(cwd).filter((f) => f !== ".rovecode")).toEqual([]);
});

test("only the interactive boot (cli/start-chat.ts, main.ts's stage) imports tui/notify.ts — run, repl, serve, acp and every other CLI module do not", () => {
  const cli = join(ROOT, "src", "cli");
  const importers = readdirSync(cli).filter((f) => f.endsWith(".ts") && /tui\/notify\.ts/.test(readFileSync(join(cli, f), "utf8")));
  // start-chat.ts IS the interactive boot now (main.ts delegates to it; the intro/loading screen owns
  // stdout through module loading, so the renderer+notifier pick lives there). The pin's promise is
  // unchanged: no HEADLESS surface — run, repl, serve, acp — ever builds the notifier.
  expect(importers).toEqual(["start-chat.ts"]);
  for (const dir of ["acp", "server"]) {
    const p = join(ROOT, "src", dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p).filter((x) => x.endsWith(".ts"))) expect([f, /tui\/notify/.test(readFileSync(join(p, f), "utf8"))]).toEqual([f, false]);
  }
});
