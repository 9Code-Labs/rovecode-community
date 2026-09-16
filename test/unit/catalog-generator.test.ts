/** The catalog generator's refusal rules, exercised as subprocesses with `fetch` fully replaced.
 *
 *  The failure that matters is not a crash, it is a QUIET one: GitHub allows 60 anonymous requests an
 *  hour and a full skill build makes about forty, so a rate limit part-way through is the normal bad day.
 *  Left alone, the generator would have written a catalog of four skills over a good one of nineteen and
 *  said nothing — the market would lose most of its shelf and the diff would look deliberate. So the rule
 *  is: only a source that ANSWERS (a 404) may shrink the catalog; a source that cannot be reached leaves
 *  the shipped file exactly as it is.
 *
 *  NOTHING here touches the network — not even the happy path. `fetch` is replaced before the script is
 *  imported, and upstream is served from the catalog that ships, so the tests run identically offline and
 *  in CI (where an anonymous GitHub build would be rate-limited anyway). The cost of that choice: these
 *  tests prove the REFUSAL logic, not that the real repository is still reachable. `--check` in CI is what
 *  proves the second thing, and it is a separate job for exactly that reason. */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "build-skill-catalog.mjs");
const CATALOG = join(ROOT, "src", "market", "catalogs", "skills.json");
const IMPORT = `await import(${JSON.stringify(`file:///${SCRIPT.replace(/\\/g, "/")}`)});`;

/** A complete fake upstream, derived from the catalog that ships so it can never drift from it: the
 *  Trees API listing, each SKILL.md rebuilt from the row's own description, each LICENSE.txt from its
 *  recorded licence, and the grouping file that supplies the tags. */
const UPSTREAM = `
const doc = JSON.parse(${JSON.stringify(JSON.stringify(JSON.parse(readFileSync(CATALOG, "utf8"))))});
const rows = doc.items;
const LIC = {
  "Apache-2.0": "Apache License\\nVersion 2.0",
  "source-available": "\\u00a9 2025 Anthropic, PBC. All rights reserved.",
  "unknown": null,
};
const groups = { plugins: [{ name: "example-skills", skills: rows.filter((r) => r.tags.includes("example-skills")).map((r) => "./skills/" + r.id) },
                           { name: "document-skills", skills: rows.filter((r) => r.tags.includes("document-skills")).map((r) => "./skills/" + r.id) }] };
globalThis.__rows = rows;
globalThis.__serve = (url) => {
  if (url.includes("api.github.com")) {
    // the REPOSITORY endpoint and the TREE endpoint are different questions and the fake must not answer
    // both with the same object: "archived" is read from the first, and a fake that served a tree for it
    // would report every repository as maintained no matter what the test set up
    // written without a regex on purpose: this string is a template literal that becomes a script, and
    // every backslash in it has to survive two levels of quoting to still mean what it reads as
    const after = url.slice(url.indexOf("/repos/") + "/repos/".length);
    if (url.includes("/repos/") && after.split("/").length === 2) return { json: { archived: globalThis.__archived === true } };
    return { json: { tree: rows.map((r) => ({ type: "blob", path: "skills/" + r.id + "/SKILL.md" })) } };
  }
  if (url.endsWith("marketplace.json")) return { text: JSON.stringify(groups) };
  const lic = /\\/skills\\/([^/]+)\\/LICENSE\\.txt$/.exec(url);
  if (lic) { const r = rows.find((x) => x.id === lic[1]); const t = r && LIC[r.license]; return t ? { text: t } : { status: 404 }; }
  const sk = /\\/skills\\/([^/]+)\\/SKILL\\.md$/.exec(url);
  if (sk) {
    const r = rows.find((x) => x.id === sk[1]);
    if (!r) return { status: 404 };
    const head = "---\\nname: " + r.id + "\\ndescription: " + r.description.replace(/\\n/g, " ") + "\\n---\\n\\n";
    // the generator records each file's byte length, so the fake must match it: otherwise the
    // "reproduces the shipped catalog exactly" invariant — the one that makes every case below mean
    // something — would fail for a reason unrelated to the refusal rules
    return { text: head + "b".repeat(Math.max(1, r.bytes - head.length)) };
  }
  return { status: 404 };
};
`;

/** Wrap the fake upstream in a `fetch`, letting a case interpose its own failure first. */
const harness = (interpose = "return null;") => `
${UPSTREAM}
const decide = (url) => { ${interpose} };
globalThis.fetch = async (u, init) => {
  const url = String(u);
  // report the first request's authorization header, so a test can pin whether a token was sent
  if (!globalThis.__hdr) { globalThis.__hdr = 1; console.error("AUTH=" + ((init && init.headers && init.headers.authorization) || "none")); }
  const forced = decide(url);
  if (forced) return new Response(forced.body ?? "x", { status: forced.status });
  const r = globalThis.__serve(url);
  if (r.status) return new Response("nope", { status: r.status });
  return new Response(r.json ? JSON.stringify(r.json) : r.text, { status: 200 });
};
${IMPORT}`;

async function run(script: string, args: string[] = [], env: Record<string, string> = {}): Promise<{ code: number; err: string; wrote: boolean; ids: string[]; items: { id: string; status?: string }[] }> {
  const before = readFileSync(CATALOG, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "rovecode-gen-"));
  const runner = join(dir, "run.mjs");
  writeFileSync(runner, script);
  // The run writes a THROWAWAY copy, seeded with what ships so the refusal rules still compare against a
  // real baseline. Writing the tracked file and restoring it afterwards is correct in isolation and wrong
  // in a suite: bun runs test files concurrently, and plugin-subfolder-install.test.ts read skills.json
  // during the --allow-shrink case — when xlsx is deliberately gone — and failed for our reasons, not its
  // own. A test that mutates a tracked file is a test that can fail any other test.
  const out = join(dir, "skills.json");
  writeFileSync(out, before);
  try {
    // the ambient environment is scrubbed of both token names: a developer who happens to export one
    // must not change what these tests observe
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) clean[k] = v;
    delete clean["GITHUB_TOKEN"];
    delete clean["GH_TOKEN"];
    Object.assign(clean, env);
    clean["ROVECODE_CATALOG_OUT"] = out;
    const proc = Bun.spawn(["bun", runner, ...args], { cwd: ROOT, env: clean, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const after = readFileSync(out, "utf8");
    const items = (JSON.parse(after) as { items: { id: string; status?: string }[] }).items;
    const ids = items.map((i) => i.id);
    // the tracked catalog is never in play, so this also asserts the run stayed inside its sandbox
    expect(readFileSync(CATALOG, "utf8")).toBe(before);
    return { code, err, wrote: after !== before, ids, items };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The fake serves every row the shipped catalog has, so a run against it produces the same SHELF. It is
 *  not byte-identical and is not asked to be: a description that was a YAML block scalar upstream and was
 *  then folded and capped at 500 chars cannot be re-served and re-read to the same bytes. What the refusal
 *  rules actually compare is which ids survive, so that is what this pins. */
test("the fake upstream serves the same shelf the shipped catalog holds", async () => {
  const shipped = (JSON.parse(readFileSync(CATALOG, "utf8")) as { items: { id: string }[] }).items.map((i) => i.id);
  const r = await run(harness());
  expect(r.code).toBe(0);
  expect(r.ids).toEqual(shipped);
  expect(r.ids.length).toBe(19);
}, 30_000);

test("no network at all: says so, exits 1, leaves the shipped catalog alone", async () => {
  const r = await run(`globalThis.fetch = async () => { throw new Error("ENOTFOUND (test)"); };\n${IMPORT}`);
  expect(r.code).toBe(1);
  expect(r.err).toContain("cannot reach the source");
  expect(r.err).toContain("nothing was written");
  expect(r.wrote).toBe(false);
}, 30_000);

test("rate limited part-way through: refused, not a catalog of the few files that arrived", async () => {
  const r = await run(harness(`
    if (url.includes("SKILL.md")) { globalThis.__n = (globalThis.__n ?? 0) + 1; if (globalThis.__n > 3) return { status: 403 }; }
    return null;`));
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/HTTP 403/);
  expect(r.err).toContain("rate limited?");
  expect(r.wrote).toBe(false);          // three files arrived; none of them was written
}, 30_000);

test("a skill really withdrawn (404) is refused too, and names what would be lost", async () => {
  const r = await run(harness(`return url.includes("/skills/xlsx/SKILL.md") ? { status: 404 } : null;`));
  expect(r.code).toBe(1);
  expect(r.err).toContain("refusing to write");
  expect(r.err).toContain("missing: xlsx");     // the reader is told which row would vanish
  expect(r.err).toContain("--allow-shrink");    // and how to say "yes, it really went"
  expect(r.wrote).toBe(false);
}, 30_000);

test("--allow-shrink is the deliberate way through, and only that", async () => {
  const r = await run(harness(`return url.includes("/skills/xlsx/SKILL.md") ? { status: 404 } : null;`), ["--allow-shrink"]);
  expect(r.code).toBe(0);
  expect(r.err).toContain("--allow-shrink given: writing anyway");
  expect(r.wrote).toBe(true);
}, 30_000);

test("a 404 on a LICENSE.txt is an answer, not a failure: the row stays, its licence is unknown", async () => {
  // doc-coauthoring is exactly this case upstream, which is why the shipped catalog records "unknown"
  const doc = JSON.parse(readFileSync(CATALOG, "utf8")) as { items: { id: string; license: string }[] };
  expect(doc.items.find((i) => i.id === "doc-coauthoring")?.license).toBe("unknown");
  const r = await run(harness());
  expect(r.code).toBe(0);                        // a missing licence file never fails the run
  expect(r.ids).toContain("doc-coauthoring");    // and the row stays on the shelf
}, 30_000);

/** GITHUB_TOKEN is a rate-limit lever and nothing else. CI sets it because 40 requests against a 60/hour
 *  anonymous budget, from a runner IP shared with the whole internet, is a job that fails for reasons
 *  unrelated to the commit. It must stay optional: a contributor with no token still gets a working run. */
test("a token is sent when the environment has one, and the run works identically without one", async () => {
  const withToken = await run(harness(), [], { GITHUB_TOKEN: "ghp_test_not_a_real_token" });
  expect(withToken.code).toBe(0);
  expect(withToken.err).toContain("AUTH=Bearer ghp_test_not_a_real_token");

  const without = await run(harness());
  expect(without.code).toBe(0);
  expect(without.err).toContain("AUTH=none");
  expect(without.ids).toEqual(withToken.ids);          // the token changes the budget, never the shelf
}, 30_000);

/** A wrong or expired token comes back 401. That is "unreachable", not "absent", so the run refuses —
 *  the failure mode of a bad secret is a red job, never a catalog quietly cut down to nothing. */
test("a rejected token refuses the run and says which knob to turn", async () => {
  const r = await run(harness(`return url.includes("githubusercontent") || url.includes("api.github") ? { status: 401 } : null;`),
                      [], { GITHUB_TOKEN: "expired" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("HTTP 401");
  expect(r.err).toContain("unset it to fall back to anonymous");
  expect(r.wrote).toBe(false);
}, 30_000);

/** Losing the documentation is the count check's blind spot: every row still present, every row now blank.
 *  One rate-limited run would empty every doc in the market and the item count would not move a digit, so
 *  a row that HAS docs today must still have them — or this was not a good run. */
test("a run that would blank a row's documentation is refused, and names the row", async () => {
  // serve one skill as frontmatter and nothing else: valid row, no body, therefore no docs
  const r = await run(harness(`
    if (url.includes("/skills/pdf/SKILL.md")) {
      const nl = String.fromCharCode(10);      // spelled out: this string is built here and read one level down
      return { status: 200, body: ["---", "name: pdf", "description: d", "---", ""].join(nl) };
    }
    return null;`));
  expect(r.code).toBe(1);
  expect(r.err).toContain("refusing to write");
  expect(r.err).toContain("lost docs: pdf");
  expect(r.err).toContain("--allow-shrink");
  expect(r.wrote).toBe(false);
}, 30_000);

test("every row the generator produces carries documentation, and the big ones say they were cut", async () => {
  const r = await run(harness());
  expect(r.code).toBe(0);
  const doc = JSON.parse(readFileSync(CATALOG, "utf8")) as { items: { id: string; docs?: { truncated: boolean; bytes: number; body: string; source: string } }[] };
  expect(doc.items.every((i) => i.docs !== undefined)).toBe(true);
  for (const i of doc.items) {
    expect(Buffer.byteLength(i.docs!.body, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(i.docs!.source).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    if (i.docs!.truncated) expect(i.docs!.body).toContain(i.docs!.source);   // it says where the rest is
  }
  // the two upstream files that genuinely exceed the cap
  expect(doc.items.filter((i) => i.docs!.truncated).map((i) => i.id).sort()).toEqual(["claude-api", "skill-creator"]);
}, 30_000);
