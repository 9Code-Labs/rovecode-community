/** app.ts must not load pi-renderer.ts (and the vendored pi-tui under it, ~27 MB resident) until a session
 *  constructs the classic renderer: a sextant session hands runTui its own renderer and never does. Checked
 *  in a child process — the test runner's own module cache may hold pi-renderer from another test file. */

import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const probe = (imports: string[]): string => {
  const src = `${imports.map((m) => `await import(${JSON.stringify(m)});`).join(" ")} console.log(JSON.stringify(Object.keys(require.cache).filter((k) => /pi-renderer|sextant-renderer|vendor[\\\\/]pi-tui[\\\\/]src[\\\\/](index|tui|terminal)\\.ts/.test(k)).map((k) => k.replace(/\\\\/g, "/").replace(/.*nimbus\\//, ""))));`;
  const r = Bun.spawnSync({ cmd: [process.execPath, "-e", src], cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim();
};

test("importing tui/app.ts (what `rovecode chat` does) leaves pi-renderer.ts and the pi-tui runtime unloaded", () => {
  const loaded = JSON.parse(probe(["./src/tui/app.ts", "./src/tui/sextant-io.ts"])) as string[];
  expect(loaded).toEqual([]);
});

test("the notification composition root and CLI loader defer both renderer implementations until surface selection", () => {
  expect(JSON.parse(probe(["./src/cli/start-chat.ts", "./src/tui/app.ts", "./src/tui/notify.ts"])) as string[]).toEqual([]);
});

test("the probe sees the module when it IS imported (the check is not vacuous)", () => {
  const loaded = JSON.parse(probe(["./src/tui/pi-renderer.ts"])) as string[];
  expect(loaded.some((k) => k.endsWith("src/tui/pi-renderer.ts"))).toBe(true);
  expect(loaded.some((k) => k.endsWith("vendor/pi-tui/src/index.ts"))).toBe(true);
});
