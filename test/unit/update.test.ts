/** core/update.ts: honest install detection, channel discipline, the plan per mode, and a runner
 *  that stops at the first failure. The spawners are faked — no npm, no git, no network. */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelFor, detectInstallMode, planUpdate, runUpdate, type DetectedInstall } from "../../src/core/update.ts";

test("detectInstallMode: npm (global + local, scoped + plain), compiled binary, source checkout, unknown", () => {
  // npm global (Windows layout): the package root under the global prefix's node_modules
  const win = detectInstallMode({ entry: "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\rovecode\\dist\\cli\\main.js", npmGlobalPrefix: "C:\\Users\\x\\AppData\\Roaming\\npm" });
  expect(win).toEqual({ mode: "npm", root: "C:/Users/x/AppData/Roaming/npm/node_modules/rovecode", npmGlobal: true });
  // npm global (posix)
  const posix = detectInstallMode({ entry: "/home/u/.npm-global/lib/node_modules/rovecode/dist/cli/main.js", npmGlobalPrefix: "/home/u/.npm-global/lib" });
  expect(posix.mode).toBe("npm");
  expect(posix.npmGlobal).toBe(true);
  // a project-local install is NOT the global one
  const local = detectInstallMode({ entry: "/proj/node_modules/rovecode/dist/cli/main.js", npmGlobalPrefix: "/home/u/.npm-global/lib" });
  expect(local).toEqual({ mode: "npm", root: "/proj/node_modules/rovecode", npmGlobal: false });
  // a compiled binary runs from bun's virtual FS
  expect(detectInstallMode({ entry: "/$bunfs/root/src/cli/main.ts" }).mode).toBe("binary");
});

test("detectInstallMode: a git checkout is source; a bare directory is unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-update-src-"));
  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    const s = detectInstallMode({ entry: join(root, "src", "cli", "main.ts") });
    expect(s.mode).toBe("source");
    expect(s.root).toBe(root);
    const bare = mkdtempSync(join(tmpdir(), "rovecode-update-bare-"));
    try {
      expect(detectInstallMode({ entry: join(bare, "src", "cli", "main.ts") }).mode).toBe("unknown");
    } finally { rmSync(bare, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channelFor: a prerelease stays on beta, a release stays on latest, an explicit word wins", () => {
  expect(channelFor("0.4.0-beta.1")).toBe("beta");
  expect(channelFor("0.4.0")).toBe("latest");
  expect(channelFor("0.4.0", "latest")).toBe("latest");
  expect(channelFor("0.4.0-beta.1", "latest")).toBe("latest");
  expect(channelFor("0.4.0", "auto")).toBe("latest");
});

const npmGlobal: DetectedInstall = { mode: "npm", root: "/g/node_modules/rovecode", npmGlobal: true };
const npmOpen: DetectedInstall = { mode: "npm", root: "/somewhere/node_modules/rovecode" };

test("planUpdate: the plan per install mode", () => {
  expect(planUpdate(npmGlobal, { currentVersion: "0.4.0-beta.1" })).toEqual({ mode: "npm", channel: "beta", commands: [["npm", "install", "-g", "rovecode@beta"]] });
  const local = planUpdate({ mode: "npm", root: "/proj/node_modules/rovecode", npmGlobal: false }, { currentVersion: "0.4.0" });
  expect(local.commands).toEqual([["npm", "install", "rovecode@latest"]]);
  expect(local.cwd).toBe(process.platform === "win32" ? "\\proj" : "/proj"); // the project root, native separators
  const src = planUpdate({ mode: "source", root: "/repo" }, { currentVersion: "0.4.0", distBuilt: true });
  expect(src.commands).toEqual([["git", "pull", "--ff-only"], ["bun", "install"], ["bun", "run", "build:cli"]]);
  expect(src.cwd).toBe("/repo");
  const srcNoDist = planUpdate({ mode: "source", root: "/repo" }, { currentVersion: "0.4.0" });
  expect(srcNoDist.commands.length).toBe(2); // no dist was built: nothing to rebuild
  const bin = planUpdate({ mode: "binary" }, { currentVersion: "0.4.0" });
  expect(bin.commands).toEqual([]);
  expect(bin.manual).toContain("releases");
  expect(planUpdate({ mode: "unknown" }, { currentVersion: "0.4.0-beta.2" }).manual).toContain("rovecode@beta");
});

test("runUpdate: commands run in order, the first failure stops the rest, and the npm -g question is answered from `npm prefix -g` at run time", async () => {
  const ran: string[][] = [];
  const ok = await runUpdate(planUpdate(npmGlobal, { currentVersion: "0.4.0-beta.1" }), npmGlobal, {
    spawn: async (cmd) => { ran.push(cmd); return { code: 0, out: "done" }; },
  });
  expect(ok.ok).toBe(true);
  expect(ok.detail).toContain("restart");
  expect(ran).toEqual([["npm", "install", "-g", "rovecode@beta"]]);

  const ran2: string[][] = [];
  const failed = await runUpdate(planUpdate({ mode: "source", root: "/repo" }, { currentVersion: "0.4.0", distBuilt: true }), { mode: "source", root: "/repo" }, {
    spawn: async (cmd) => { ran2.push(cmd); return cmd[0] === "git" ? { code: 128, out: "fatal: diverged" } : { code: 0, out: "" }; },
  });
  expect(failed.ok).toBe(false);
  expect(failed.detail).toContain("diverged");
  expect(ran2.length).toBe(1); // git pull failed: bun install never ran

  // the open npm plan (prefix unknown at plan time): runUpdate resolves it and picks -g
  const ran3: string[][] = [];
  const resolved = await runUpdate(planUpdate(npmOpen, { currentVersion: "0.4.0" }), npmOpen, {
    spawn: async (cmd) => { ran3.push(cmd); return { code: 0, out: "" }; },
    npmGlobalPrefix: async () => "/somewhere",
  });
  expect(resolved.ok).toBe(true);
  expect(ran3).toEqual([["npm", "install", "-g", "rovecode@latest"]]);
});
