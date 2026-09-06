/** A stand-in for `npm install --prefix <dir> … <spec>` (mcp/local-package.ts): writes the node_modules
 *  tree npm would leave behind — the package's package.json with a bin, the bin file, and a lockfile v3
 *  entry with an integrity hash — without touching the network. Options shape the failure modes the
 *  record has to name: a lockfile without the entry, no lockfile at all, or npm failing outright. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Spawn } from "../../src/mcp/local-package.ts";

export interface FakeNpmOptions {
  /** the version the installed package.json states (default 1.2.3) */
  version?: string;
  /** what the lockfile says: a full entry (default), a lockfile without this package, or no lockfile */
  lock?: "full" | "no-entry" | "none";
  /** make npm fail with this on stderr */
  fail?: string;
  /** declare no bin — a package node cannot start */
  noBin?: boolean;
}

export const FAKE_INTEGRITY = "sha512-FAKEFAKEFAKEfakefakefakeFAKEFAKEFAKEfakefakefakeFAKEFAKEFAKEfakefakefakeFAKEFAKEFAKE==";

/** the package name inside an npm spec: `@scope/name@1.0.0` → `@scope/name`, `name@1.0.0` → `name` */
export function specName(spec: string): string {
  return spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]!}` : spec.split("@")[0]!;
}

export function fakeNpm(opts: FakeNpmOptions = {}): { spawn: Spawn; calls: { cmd: string[]; cwd: string }[] } {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const spawn: Spawn = async (cmd, cwd) => {
    calls.push({ cmd, cwd });
    if (opts.fail !== undefined) return { code: 1, stderr: opts.fail };
    const prefix = cmd[cmd.indexOf("--prefix") + 1]!;
    const spec = cmd[cmd.length - 1]!;
    const name = specName(spec);
    const version = opts.version ?? "1.2.3";
    const dir = join(prefix, "node_modules", ...name.split("/"));
    mkdirSync(join(dir, "dist"), { recursive: true });
    const short = name.split("/").pop()!;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, ...(opts.noBin ? {} : { bin: { [short]: "dist/index.js" } }) }, null, 2));
    writeFileSync(join(dir, "dist", "index.js"), "#!/usr/bin/env node\n// fake server\n");
    if (opts.lock !== "none") {
      const packages: Record<string, unknown> = { "": { name: "rovecode-mcp-servers", dependencies: { [name]: `^${version}` } } };
      if (opts.lock !== "no-entry") packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`, integrity: FAKE_INTEGRITY };
      writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({ name: "rovecode-mcp-servers", lockfileVersion: 3, requires: true, packages }, null, 2));
    }
    return { code: 0, stderr: "" };
  };
  return { spawn, calls };
}
