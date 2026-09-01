/** PORT #36 — packaging invariants (publish-readiness), WITHOUT the compile.
 *  The slow `bun build --compile` + binary smoke lives in scripts/build.ts;
 *  this suite pins everything that makes the npm tarball / bin entry valid:
 *  not private, semver version, bin target on disk, files[] entries on disk,
 *  NOTICE shipped + non-hollow, engines/scripts present, and the dev-mode
 *  `--version` output matching package.json (the binary prints the same
 *  bundled JSON — proven once per build by scripts/build.ts). */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string; version: string; private?: boolean;
  bin: Record<string, string>; files: string[];
  engines?: Record<string, string>; scripts: Record<string, string>;
};

describe("packaging: package.json publish invariants", () => {
  test("not private", () => {
    expect(Boolean(pkg.private)).toBe(false);
  });

  test("name + semver version", () => {
    expect(pkg.name).toBe("aion");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("bin.aion points at an existing file with a bun shebang", () => {
    const target = pkg.bin["aion"];
    expect(target).toBeDefined();
    const abs = join(root, target!);
    expect(statSync(abs).isFile()).toBe(true);
    // npm's cmd-shim reads the shebang; without it, global installs shim to
    // node, which cannot execute a .ts entry.
    expect(readFileSync(abs, "utf8").startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  test("files[] entries all exist on disk", () => {
    expect(pkg.files.length).toBeGreaterThan(0);
    for (const f of pkg.files) expect(existsSync(join(root, f))).toBe(true);
  });

  test("files[] ships the runtime tree, tsconfig, and the NOTICE", () => {
    // tsconfig is load-bearing at runtime: Bun's transpiler reads
    // useDefineForClassFields, which vendored pi-tui classes depend on.
    for (const required of ["src", "vendor", "tsconfig.json", "THIRD_PARTY_NOTICES.md"]) {
      expect(pkg.files).toContain(required);
    }
    // bin target must live inside a shipped dir
    expect(pkg.bin["aion"]!.startsWith("src/")).toBe(true);
  });

  test("NOTICE copy is non-hollow (Apache attributions present)", () => {
    const notice = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const marker of ["openai/codex", "cline", "Aider", "gemini-cli", "Apache-2.0"]) {
      expect(notice).toContain(marker);
    }
  });

  test("engines pins bun; core scripts present", () => {
    expect(pkg.engines?.["bun"]).toMatch(/^>=\d/);
    for (const s of ["build", "test", "typecheck", "gauntlet"]) {
      expect(pkg.scripts[s]).toBeDefined();
    }
    expect(pkg.scripts["build"]).toContain("scripts/build.ts");
    expect(existsSync(join(root, "scripts", "build.ts"))).toBe(true);
  });
});

describe("packaging: --version", () => {
  test("dev-mode `aion --version` prints exactly package.json version, exit 0", () => {
    // Scrub provider env so this is hermetic on any box (PORTS.md #6 lesson);
    // --version exits before dispatch, so no TUI/provider path can start.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || /^AION_/i.test(k) || /_API_KEY$/i.test(k)) continue;
      env[k] = v;
    }
    const p = Bun.spawnSync([process.execPath, "run", "src/cli/main.ts", "--version"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString().trim()).toBe(pkg.version);
  }, 30_000);
});
