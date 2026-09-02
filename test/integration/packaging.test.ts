/** PORT #36 — packaging invariants (publish-readiness), WITHOUT the compile.
 *  The slow `bun build --compile` + binary smoke lives in scripts/build.ts;
 *  this suite pins everything that makes the npm tarball / bin entry valid:
 *  not private, semver version, bin target on disk, files[] entries on disk,
 *  NOTICE shipped + non-hollow, engines/scripts present, the dev-mode
 *  `--version` output matching package.json (the binary prints the same
 *  bundled JSON — proven once per build by scripts/build.ts), and the dev-only
 *  `smoke-tui` failing CLEANLY where its devDependency is not installed. */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string; version: string; private?: boolean;
  bin: Record<string, string>; files: string[];
  engines?: Record<string, string>; scripts: Record<string, string>;
};

/** Host env minus provider credentials (PORTS.md #6 lesson): a host
 *  AION_BASE_URL or any *_API_KEY must not steer a spawned CLI onto a real
 *  endpoint. Mirrors scripts/build.ts scrubbedEnv. */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^AION_/i.test(k) || /_API_KEY$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** `bun run <entry> <args>` in dev mode, hermetic env. */
function cli(args: string[], cwd = root): { exitCode: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync([process.execPath, "run", ...args], { cwd, env: scrubbedEnv(), stdout: "pipe", stderr: "pipe" });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

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
    // tsconfig ships so the installed source stays typecheckable in place
    // (`bun x tsc --noEmit` with the repo's flags). It is NOT read by Bun at
    // runtime — bun 1.3.14 transpiles byte-identically with the file absent or
    // useDefineForClassFields flipped — so this pins a typecheck contract only.
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
    // --version exits before dispatch, so no TUI/provider path can start.
    const p = cli(["src/cli/main.ts", "--version"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.trim()).toBe(pkg.version);
  }, 30_000);
});

describe("packaging: smoke-tui is dev-only", () => {
  test("help annotates smoke-tui as (dev-only)", () => {
    const p = cli(["src/cli/main.ts", "help"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toMatch(/^\s*aion smoke-tui\s.*\(dev-only\)\s*$/m);
  }, 30_000);

  test("with @xterm/headless unresolvable (the npm-installed tree) `aion smoke-tui` exits 1 with the dev-only message, no crash", () => {
    // Simulate the published tree without a second install: src + vendor +
    // package.json copied under dist/ (gitignored, and INSIDE the repo so every
    // runtime dependency still resolves upward to the real node_modules), plus
    // a NEARER stub of the devDependency whose empty `exports` map makes it
    // unresolvable — the same "Cannot find module '@xterm/headless'" a
    // production install produces. (A `main`-only stub falls through to the
    // real package; `exports: {}` is a hard stop — probed on bun 1.3.14.) An
    // uncaught import error ALSO exits 1, so the assertion is on OUR message.
    mkdirSync(join(root, "dist"), { recursive: true });
    const pkgDir = mkdtempSync(join(root, "dist", "pkg-smoke-"));
    try {
      cpSync(join(root, "src"), join(pkgDir, "src"), { recursive: true });
      cpSync(join(root, "vendor"), join(pkgDir, "vendor"), { recursive: true });
      cpSync(join(root, "package.json"), join(pkgDir, "package.json"));
      const stub = join(pkgDir, "node_modules", "@xterm", "headless");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@xterm/headless", version: "0.0.0", exports: {} }));
      const main = join(pkgDir, "src", "cli", "main.ts");
      const smoke = cli([main, "smoke-tui"], pkgDir);
      expect(smoke.exitCode).toBe(1);
      expect(smoke.stderr).toContain("smoke-tui is dev-only — run from a source checkout with devDependencies installed");
      // control: the copied tree itself is healthy — the failure above is the stub, not a broken copy
      const version = cli([main, "--version"], pkgDir);
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(pkg.version);
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  }, 60_000);
});
