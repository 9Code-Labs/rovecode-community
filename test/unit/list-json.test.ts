/** `--json` was ACCEPTED and ignored by two listings: `rovecode provider list --json` and
 *  `rovecode auth list --json` printed prose and exited 0, so a script asking for a document got a
 *  paragraph and no way to know. The market surfaces had already been held to "one parseable document on
 *  stdout on every exit"; these two had not.
 *
 *  Spawned rather than called, because what is under test is what reaches stdout. */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function cli(home: string, cwd: string, args: string[]) {
  const env: Record<string, string> = { ROVECODE_HOME: home };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, stdout: await new Response(p.stdout).text() };
}

test("provider list --json is one document: the default, the same rows the prose shows, and the registry's warnings", async () => {
  const home = tmp("rovecode-lj-home-"), cwd = tmp("rovecode-lj-cwd-");
  const r = await cli(home, cwd, ["provider", "list", "--json"]);
  expect(r.code).toBe(0);
  const doc = JSON.parse(r.stdout) as { default: unknown; providers: { id: string; configured: boolean }[]; warnings: string[] };
  expect(doc.default).toBeNull();                       // nothing configured in a scratch home
  expect(Array.isArray(doc.providers)).toBe(true);
  expect(Array.isArray(doc.warnings)).toBe(true);

  // --all shows the built-ins without a key, exactly as the prose listing's "(+N built-in …)" line says
  const all = JSON.parse((await cli(home, cwd, ["provider", "list", "--json", "--all"])).stdout) as { providers: unknown[] };
  expect(all.providers.length).toBeGreaterThan(doc.providers.length);
}, 30_000);

test("auth list --json carries the redacted form and never the key itself", async () => {
  const home = tmp("rovecode-lj-home2-"), cwd = tmp("rovecode-lj-cwd2-");
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ acme: { type: "api", key: "sk-super-secret-value", keyName: "ACME_API_KEY" } }));
  const r = await cli(home, cwd, ["auth", "list", "--json"]);
  expect(r.code).toBe(0);
  const doc = JSON.parse(r.stdout) as { path: string; credentials: { provider: string; keyName: string; redacted: string }[] };
  expect(doc.credentials).toHaveLength(1);
  expect(doc.credentials[0]!.provider).toBe("acme");
  expect(doc.credentials[0]!.keyName).toBe("ACME_API_KEY");
  expect(r.stdout).not.toContain("sk-super-secret-value");   // the whole point of this listing
}, 30_000);
