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
  bin: Record<string, string>; files: string[]; exports?: Record<string, string>;
  engines?: Record<string, string>; scripts: Record<string, string>;
};

/** Host env minus provider credentials (PORTS.md #6 lesson): a host
 *  ROVECODE_BASE_URL or any *_API_KEY must not steer a spawned CLI onto a real
 *  endpoint. Mirrors scripts/build.ts scrubbedEnv. */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^ROVECODE_/i.test(k) || /_API_KEY$/i.test(k)) continue;
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

  test("name + semver version (a prerelease suffix is allowed — the npm channel ships betas)", () => {
    expect(pkg.name).toBe("rovecode");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  test("bin.rovecode points at an existing file with a bun shebang", () => {
    const target = pkg.bin["rovecode"];
    expect(target).toBeDefined();
    const abs = join(root, target!);
    expect(statSync(abs).isFile()).toBe(true);
    // npm's cmd-shim reads the shebang; without it, global installs shim to
    // node, which cannot execute a .ts entry.
    expect(readFileSync(abs, "utf8").startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  test("files[] entries all exist on disk — except dist, which prepack builds", () => {
    expect(pkg.files.length).toBeGreaterThan(0);
    for (const f of pkg.files) if (f !== "dist") expect(existsSync(join(root, f))).toBe(true);
    // dist is a BUILD PRODUCT, never committed: the prepack hook is what puts it in the tarball
    expect(pkg.scripts["prepack"]).toContain("build:npm");
    expect(pkg.scripts["build:npm"]).toBeDefined();
  });

  test("files[] ships the DIST tree only: bin + dist + the NOTICE, and no readable source", () => {
    // The npm build is minified on purpose; this public repository IS its AGPL source (the
    // description and the README say so), so the tarball carries no src/, vendor/ or tsconfig.
    for (const required of ["bin", "dist", "THIRD_PARTY_NOTICES.md"]) {
      expect(pkg.files).toContain(required);
    }
    for (const forbidden of ["src", "vendor", "tsconfig.json"]) {
      expect(pkg.files).not.toContain(forbidden);
    }
    const binTarget = pkg.bin["rovecode"]!;
    expect(binTarget.startsWith("bin/")).toBe(true);
    // every library export answers from the built bundles
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      if (sub !== "./package.json") expect(target.startsWith("./dist/lib/")).toBe(true);
    }
  });

  test("NOTICE copy is non-hollow (Apache attributions present)", () => {
    const notice = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const marker of ["openai/codex", "cline", "Aider", "gemini-cli", "Apache-2.0"]) {
      expect(notice).toContain(marker);
    }
  });

  test("engines pins bun; core scripts present", () => {
    expect(pkg.engines?.["bun"]).toMatch(/^>=\d/);
    for (const s of ["build", "test", "typecheck", "gauntlet", "build:npm", "prepack"]) {
      expect(pkg.scripts[s]).toBeDefined();
    }
    expect(pkg.scripts["build"]).toContain("scripts/build.ts");
    expect(existsSync(join(root, "scripts", "build.ts"))).toBe(true);
  });
});

describe("packaging: --version", () => {
  test("dev-mode `rovecode --version` prints exactly package.json version, exit 0", () => {
    // --version exits before dispatch, so no TUI/provider path can start.
    const p = cli(["src/cli/main.ts", "--version"]);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.trim()).toBe(pkg.version);
  }, 30_000);
});

/** The smoke-tui classification (a failed RESOLUTION of the devDependency is "dev-only"; any other
 *  import failure propagates as itself) is pinned from a SOURCE tree — the published tarball is the
 *  minified dist, which inherits exactly this logic through the bundle, and a minified tree cannot be
 *  surgically broken the way the second test below needs. src + vendor + package.json are copied under
 *  dist/ (gitignored, and INSIDE the repo so every runtime dependency still resolves upward to the
 *  real node_modules); `fn` gets the copy's root and its main.ts. Always removed afterwards. */
function withCopiedTree(fn: (pkgDir: string, main: string) => void): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  const pkgDir = mkdtempSync(join(root, "dist", "pkg-smoke-"));
  try {
    cpSync(join(root, "src"), join(pkgDir, "src"), { recursive: true });
    cpSync(join(root, "vendor"), join(pkgDir, "vendor"), { recursive: true });
    cpSync(join(root, "package.json"), join(pkgDir, "package.json"));
    fn(pkgDir, join(pkgDir, "src", "cli", "main.ts"));
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }
}

const DEV_ONLY = "smoke-tui is dev-only — run from a source checkout with devDependencies installed";

describe("packaging: smoke-tui is dev-only", () => {
  test("help annotates smoke-tui as (dev-only)", () => {
    const p = cli(["src/cli/main.ts", "help", "all"]); // smoke-tui is on the advanced page
    expect(p.exitCode).toBe(0);
    expect(p.stdout).toMatch(/^\s*rovecode smoke-tui\s.*\(dev-only\)\s*$/m);
  }, 30_000);

  test("with @xterm/headless unresolvable (the npm-installed tree) `rovecode smoke-tui` exits 1 with the dev-only message, no crash", () => {
    // The copied tree plus a NEARER stub of the devDependency whose empty
    // `exports` map makes it unresolvable — the same "Cannot find module
    // '@xterm/headless'" a production install produces. (A `main`-only stub falls
    // through to the real package; `exports: {}` is a hard stop — probed on bun
    // 1.3.14.) An uncaught import error ALSO exits 1, so the assertion is on OUR message.
    withCopiedTree((pkgDir, main) => {
      const stub = join(pkgDir, "node_modules", "@xterm", "headless");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@xterm/headless", version: "0.0.0", exports: {} }));
      const smoke = cli([main, "smoke-tui"], pkgDir);
      expect(smoke.exitCode).toBe(1);
      expect(smoke.stderr).toContain(DEV_ONLY);
      // control: the copied tree itself is healthy — the failure above is the stub, not a broken copy
      const version = cli([main, "--version"], pkgDir);
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(pkg.version);
    });
  }, 60_000);

  test("a NON-resolution import failure (module-init bug in smoke's graph) propagates as itself — exit 1, real error, NOT the dev-only text", () => {
    // Only a failed RESOLUTION is dev-only (Bun ResolveMessage, code
    // ERR_MODULE_NOT_FOUND). smoke.ts imports the live TUI modules, so a blanket
    // catch would relabel a genuine init bug in a dev checkout as "dev-only": the
    // copy's smoke.ts is made to import a module that resolves fine but THROWS at
    // top level (a plain Error, no code) — that error must reach stderr unmasked.
    withCopiedTree((pkgDir, main) => {
      const smokeTs = join(pkgDir, "src", "tui", "smoke.ts");
      writeFileSync(join(pkgDir, "src", "tui", "smoke-broken-dep.ts"),
        'throw new Error("smoke-init-boom: simulated module-init bug");\nexport const broken = true;\n');
      writeFileSync(smokeTs, 'import "./smoke-broken-dep.ts";\n' + readFileSync(smokeTs, "utf8"));
      const smoke = cli([main, "smoke-tui"], pkgDir);
      expect(smoke.exitCode).toBe(1);
      expect(smoke.stderr).toContain("smoke-init-boom");
      expect(smoke.stderr).not.toContain(DEV_ONLY);
    });
  }, 60_000);
});
