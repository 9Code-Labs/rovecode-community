#!/usr/bin/env node
/** Fail closed if hosted-product concerns enter the OSS core.
 * Provider API-key/OAuth and MCP OAuth are deliberately public local capabilities.
 * Product accounts, entitlements and control-plane authentication are not.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["src", "bin", "scripts", "plugins", "examples"];
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const FORBIDDEN_PATH = /(?:^|[\\/])(?:website|dashboard|control-plane|billing|product-auth|account-service)(?:[\\/]|\.|$)/i;
const FORBIDDEN_CODE = [
  /@rovecode\/(?:product-auth|account|billing|control-plane)(?:[\/"'])/i,
  /ROVECODE_(?:ACCOUNT|BILLING|ENTITLEMENT|LICENSE|CONTROL_PLANE)_(?:TOKEN|KEY|URL)/,
  /(?:from|import\s*)\s*["'][^"']*(?:product-auth|account-service|billing|control-plane)[^"']*["']/i,
];

async function walk(path, out) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".rovecode"].includes(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (TEXT.has(extname(entry.name))) out.push(full);
  }
}

const files = [];
for (const root of ROOTS) await walk(join(ROOT, root), files);
const violations = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  if (FORBIDDEN_PATH.test(rel)) violations.push(`${rel}: forbidden hosted-product path`);
  const source = await readFile(file, "utf8");
  for (const pattern of FORBIDDEN_CODE) if (pattern.test(source)) violations.push(`${rel}: forbidden hosted-product dependency (${pattern})`);
}
if (violations.length) {
  console.error("Hosted-product boundary violated:\n" + violations.map((v) => `- ${v}`).join("\n"));
  process.exit(1);
}
console.log("product/auth boundary: PASS (local provider and MCP auth remain allowed)");
