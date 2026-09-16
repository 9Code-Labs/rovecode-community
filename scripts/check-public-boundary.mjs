#!/usr/bin/env node
/** Enforce the one-way open-core dependency rule.
 *
 * Public source must remain self-contained. A downstream product may import these
 * APIs, but this repository may not reach into private/commercial/hosted overlays.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const PUBLIC_DIRS = ["src", "bin", "scripts", "plugins", "examples"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const FORBIDDEN = [
  /(?:from|import\s*)\s*["'][^"']*(?:\/|^)(?:private|commercial|hosted|control-plane)(?:\/|["'])/i,
  /@rovecode\/(?:private|commercial|hosted)(?:\/|["'])/i,
  /(?:^|\/)packages\/(?:private|commercial|hosted)(?:\/|$)/i,
];

async function filesUnder(dir) {
  const out = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".rovecode"].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (SOURCE_EXTENSIONS.has(extname(entry.name))) out.push(full);
    }
  }
  await walk(join(ROOT, dir));
  return out;
}

const violations = [];
for (const dir of PUBLIC_DIRS) {
  for (const file of await filesUnder(dir)) {
    const text = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) violations.push(`${relative(ROOT, file)}: ${pattern}`);
    }
  }
}

if (violations.length) {
  console.error("Public/private dependency boundary violated:\n" + violations.map((v) => `- ${v}`).join("\n"));
  process.exit(1);
}
console.log("public boundary: PASS");
