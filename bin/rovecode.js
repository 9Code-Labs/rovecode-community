#!/usr/bin/env bun
/** Published entry point. The npm tarball is DIST-ONLY (minified bundle; the public repository
 *  9Code-Labs/rovecode-community is its AGPL source), so this shim prefers dist/cli/main.js and
 *  falls back to the TypeScript source for a git checkout that has not been built yet.
 *  ROVECODE_TRACE_BOOT=1 prints which one runs. */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bundled = join(root, "dist", "cli", "main.js");
const source = join(root, "src", "cli", "main.ts");

if (process.env.ROVECODE_TRACE_BOOT === "1") {
  process.stderr.write(`[boot] dist=${existsSync(bundled)}\n`);
}

if (existsSync(bundled)) {
  await import(bundled);
} else if (existsSync(source)) {
  await import(source);
} else {
  console.error("rovecode: neither dist/cli/main.js nor src/cli/main.ts is here — run `bun run build:cli` in a source checkout, or reinstall the package");
  process.exit(2);
}
