/** Figures the page shows, read from the repository at build time so none of them can go stale.
 *
 *    node scripts/facts.mjs   →  src/generated/facts.json
 *
 *  tests      number of test()/it() calls under ../test (a lower bound of what `bun test` runs — table-driven
 *             cases count once here); the page rounds it down to the nearest hundred and says "+"
 *  testFiles  *.test.ts files under ../test
 *  providers  entries in src/providers/provider-config.ts (the built-in provider table)
 *  locales    languages the site itself ships (src/i18n/index.tsx)
 *  layers     rungs of the safety ladder as the page names them (src/content.ts LADDER)
 *  license    SPDX id read from ../LICENSE */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dirname, "..");
const REPO = join(SITE, "..");

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const testFiles = walk(join(REPO, "test"));
const tests = testFiles.reduce((n, f) => n + (readFileSync(f, "utf8").match(/^\s*(?:test|it)\(/gm) ?? []).length, 0);

const providerSrc = readFileSync(join(REPO, "src", "providers", "provider-config.ts"), "utf8");
const providers = (providerSrc.match(/^\s*\{\s*id:\s*"[a-z0-9-]+"/gm) ?? []).length;

const i18n = readFileSync(join(SITE, "src", "i18n", "index.tsx"), "utf8");
const locales = (i18n.match(/^\s*\{\s*code:\s*"[a-z]{2}"/gm) ?? []).length;

const content = readFileSync(join(SITE, "src", "content.ts"), "utf8");
const ladder = /export const LADDER = \[([^\]]+)\]/.exec(content);
const layers = ladder ? ladder[1].split(",").filter((s) => s.trim()).length : 0;

const licenseText = readFileSync(join(REPO, "LICENSE"), "utf8");
const license = /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/.test(licenseText) ? "AGPL-3.0" : "see LICENSE";

const facts = { tests, testFiles: testFiles.length, providers, locales, layers, license, generatedAt: new Date().toISOString().slice(0, 10) };
for (const [k, v] of Object.entries(facts)) if (v === 0 || v === "") throw new Error(`facts: ${k} came out empty — the source it is read from moved`);

mkdirSync(join(SITE, "src", "generated"), { recursive: true });
writeFileSync(join(SITE, "src", "generated", "facts.json"), JSON.stringify(facts, null, 2) + "\n");
console.log("facts", JSON.stringify(facts));
