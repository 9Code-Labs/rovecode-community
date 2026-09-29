#!/usr/bin/env bun
/** Entrypoint wrapper.
 *
 *  PUBLISHED package (no src/ inside): always the bundled dist/cli/main.js — the tarball ships
 *  exactly that (minified; the source stays in the repo).
 *
 *  DEV repo (src/ present): TUI invocations route through the bundle for fast cold start
 *  (~90 ms vs ~230 ms), lightweight subcommands run from source — and the staleness guard skips a
 *  bundle older than src/ (a `git pull` used to silently serve the OLD code). Rebuild with
 *  `bun run build:cli`. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bundled = join(root, "dist", "cli", "main.js");
const srcMain = join(root, "src", "cli", "main.ts");

/** Newest file mtimeMs under `dir` (recursive); a missing/unreadable dir counts as 0. */
function newestMtime(dir: string): number {
  let max = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (m > max) max = m;
  }
  return max;
}

let useDist = false;
let stale = false;
if (!existsSync(srcMain)) {
  useDist = true; // published package: the bundle is all there is
} else if (existsSync(bundled)) {
  // dev repo: bundle only for the TUI, and only when it is newer than every source file
  const { isTuiInvocation } = await import("../src/cli/is-tui-invocation.ts");
  if (isTuiInvocation(process.argv)) {
    const distMtime = statSync(bundled).mtimeMs;
    const srcMtime = Math.max(
      newestMtime(join(root, "src")),
      newestMtime(join(root, "vendor")),
      statSync(join(root, "package.json")).mtimeMs,
    );
    useDist = distMtime >= srcMtime;
    stale = !useDist;
  }
}

if (stale) {
  process.stderr.write("note: dist/cli is older than src (pulled updates?) — running from source; `bun run build:cli` restores the fast path\n");
}
if (process.env.ROVECODE_TRACE_BOOT === "1") {
  process.stderr.write(`[boot] dist=${useDist}${stale ? " (stale bundle skipped)" : ""}\n`);
}

if (useDist) {
  await import(bundled);
} else {
  await import("../src/cli/main.ts");
}
