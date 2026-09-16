#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";

const ROOT = process.cwd();
const roots = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "GOVERNANCE.md", "ROADMAP.md", "MAINTAINERS.md", "CHANGELOG.md", "docs"];
const markdown = [];
async function collect(path) {
  const full = join(ROOT, path);
  const entries = await readdir(full, { withFileTypes: true }).catch(() => null);
  if (!entries) { if (extname(full) === ".md") markdown.push(full); return; }
  for (const entry of entries) {
    const child = join(full, entry.name);
    if (entry.isDirectory()) await collect(relative(ROOT, child));
    else if (extname(entry.name) === ".md") markdown.push(child);
  }
}
for (const path of roots) await collect(path);

const missing = [];
const links = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of markdown) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(links)) {
    const raw = match[1].trim().replace(/^<|>$/g, "").split(/\s+["']/)[0];
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = decodeURIComponent(raw.split("#")[0]);
    const target = normalize(resolve(dirname(file), path));
    if (!target.startsWith(ROOT) || !existsSync(target)) missing.push(`${relative(ROOT, file)} -> ${raw}`);
  }
}
if (missing.length) {
  console.error("Broken local documentation links:\n" + missing.map((v) => `- ${v}`).join("\n"));
  process.exit(1);
}
console.log(`documentation links: PASS (${markdown.length} files)`);
