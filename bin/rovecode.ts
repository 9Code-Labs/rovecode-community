#!/usr/bin/env bun
/** Entrypoint wrapper: routes TUI invocations through the pre-bundled dist/cli/main.js for fast
 *  cold start (~90 ms vs ~230 ms), and falls back to src/cli/main.ts for lightweight subcommands
 *  (--help, --version, provider, model, …) which are already instant from source.
 *  Run `bun run build:cli` to produce dist/cli/main.js; re-run after `git pull`. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTuiInvocation } from "../src/cli/is-tui-invocation.ts";

const bundled = join(import.meta.dir, "..", "dist", "cli", "main.js");
const useDist = isTuiInvocation(process.argv) && existsSync(bundled);

if (process.env.ROVECODE_TRACE_BOOT === "1") {
  process.stderr.write(`[boot] dist=${useDist}\n`);
}

if (useDist) {
  await import(bundled);
} else {
  await import("../src/cli/main.ts");
}
