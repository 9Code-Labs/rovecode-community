/** The one status the generator produces, and where it comes from.
 *
 *  `status: "archived"` is DERIVED — read from GitHub's `archived` flag on the source repository, one
 *  request per source. It is not a field anyone types into a catalog, because a hand-written status is
 *  correct the day it is written and wrong every day after, and `--check` cannot tell you which day it is.
 *
 *  This drives the real generator as a subprocess with `fetch` replaced, exactly like catalog-generator's
 *  refusal tests, and asks the only two questions worth asking: does a repository saying "archived" reach
 *  the rows, and does one saying nothing leave them alone. */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG = join(ROOT, "src", "market", "catalogs", "skills.json");
const SCRIPT = join(ROOT, "scripts", "build-skill-catalog.mjs");

/** The upstream the generator sees: the shipped shelf, served back, with one knob — whether the
 *  REPOSITORY endpoint says the repo is archived. The tree endpoint and the repository endpoint are
 *  different questions and answering both with one object is how this test would silently pass. */
function harness(archived: boolean): string {
  const rows = (JSON.parse(readFileSync(CATALOG, "utf8")) as { items: { id: string; description: string; bytes: number }[] }).items;
  return `
const rows = ${JSON.stringify(rows.map((r) => ({ id: r.id, description: r.description, bytes: r.bytes })))};
globalThis.fetch = async (u) => {
  const url = String(u);
  const json = (v) => new Response(JSON.stringify(v), { status: 200 });
  const text = (v) => new Response(v, { status: 200 });
  if (url.includes("api.github.com")) {
    const after = url.slice(url.indexOf("/repos/") + 7);
    if (after.split("/").length === 2) return json({ archived: ${archived} });
    return json({ tree: rows.map((r) => ({ type: "blob", path: "skills/" + r.id + "/SKILL.md" })) });
  }
  if (url.endsWith("marketplace.json")) return json({ plugins: [] });
  if (url.endsWith("LICENSE.txt")) return text("Apache License");
  // the folder is the SECOND-LAST segment. Splitting on "/skills/" looks equivalent and is not: the
  // repository is itself called "skills", so the first match lands on the branch name
  const parts = url.split("/");
  const r = rows.find((x) => x.id === parts[parts.length - 2]);
  if (!r || !url.endsWith("SKILL.md")) return new Response("nope", { status: 404 });
  const head = "---\\nname: " + r.id + "\\ndescription: " + r.description.replace(/\\n/g, " ") + "\\n---\\n\\n";
  return text(head + "b".repeat(Math.max(1, r.bytes - head.length)));
};
await import(${JSON.stringify(`file://${SCRIPT.split("\\").join("/")}`)});
`;
}

async function build(archived: boolean): Promise<{ code: number; err: string; items: { id: string; status?: string }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-arch-"));
  const runner = join(dir, "run.mjs");
  const out = join(dir, "skills.json");
  writeFileSync(runner, harness(archived));
  writeFileSync(out, readFileSync(CATALOG, "utf8"));   // a throwaway copy; the tracked file is never touched
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["GITHUB_TOKEN"];
    delete env["GH_TOKEN"];
    env["ROVECODE_CATALOG_OUT"] = out;
    const proc = Bun.spawn(["bun", runner], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, err, items: (JSON.parse(readFileSync(out, "utf8")) as { items: { id: string; status?: string }[] }).items };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a source GitHub reports as archived stamps every row it produced, and says so once", async () => {
  const r = await build(true);
  expect(r.code).toBe(0);
  expect(r.items.length).toBeGreaterThan(0);
  for (const item of r.items) expect(item.status).toBe("archived");
  // one warning about the SOURCE, not nineteen about the rows
  expect(r.err).toContain("archived on GitHub");
  expect(r.err.split("archived on GitHub").length - 1).toBe(1);
}, 60_000);

test("a source that is not archived leaves the field off entirely — absent, not \"active\"", async () => {
  const r = await build(false);
  expect(r.code).toBe(0);
  expect(r.items.length).toBeGreaterThan(0);
  // `status: "active"` would be a claim; the flag only ever says one thing, so only that is recorded
  for (const item of r.items) expect(item.status).toBeUndefined();
  expect(r.err).not.toContain("archived on GitHub");
}, 60_000);
