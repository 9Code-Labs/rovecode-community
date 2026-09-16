/** Port #72 — `rovecode skills install <file.tar.gz|url>` (cli/skills-cmd.ts + skills/pack.ts): the pre-write key
 *  check (M3 — Bun 1.3.14 `extract` would flatten `../x` INTO the target and drop `C:/x`, so the pin is exit 2 + an
 *  UNCHANGED skills-dir listing, not "a file outside"), the archive shape rules, the tar-member walk (fixer: symlink /
 *  hard-link / fifo members are invisible to `files()` and are refused; directory members create nothing because the
 *  tree is written from the validated Map, never `extract`), the URL path through an INJECTED fetch
 *  (HTTP 500, a non-archive body, a network error → exit 2 with no staging dir left; a non-http(s) scheme → exit 1
 *  without any fetch), and a staged skill the loader marks invalid → exit 2. Hermetic: the injected fetch answers from
 *  memory; every store is pointed at a scratch global dir.
 *
 *  The URL rows also inject the SSRF guard's RESOLVER (the websearch-guard idiom): production resolves through DNS and
 *  refuses loopback/private/link-local answers — pinned at the CLI level in test/integration/skills-cli.test.ts — so a
 *  test host must answer with a public address or the guard, not the code under test, is what these rows would measure. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdSkills } from "../../src/cli/skills-cmd.ts";
import { checkArchiveEntries, findLinkMember, INFLATE_CAP, MAX_ARCHIVE_ENTRIES } from "../../src/skills/pack.ts";
import type { FetchLike, Resolver } from "../../src/tools/webfetch.ts";
import { scratchDirs } from "../helpers/scratch.ts";
import { collectIo, craftArchive, craftTar, skillMd, write, type TarMember } from "../helpers/skills-fixtures.ts";

const scratch = scratchDirs();
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
const skillsDirOf = (cwd: string): string => join(cwd, ".rovecode", "skills");
/** every test host resolves to one public address, so the guard passes and the injected fetch is what answers */
const PUBLIC: Resolver = async () => ["93.184.216.34"];
async function run(args: string[], cwd: string, fetchImpl?: FetchLike): Promise<{ code: number; out: string[]; err: string[] }> {
  const c = collectIo();
  const code = await cmdSkills(args, cwd, { io: c.io, globalDir: join(cwd, "no-global"), resolve: PUBLIC, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { code, out: c.out, err: c.err };
}
const good = (): Promise<Uint8Array> => craftArchive({ "alpha/SKILL.md": skillMd("alpha"), "alpha/scripts/run.sh": "echo\n" });

describe("install <file.tar.gz>", () => {
  test("a good archive lands under <cwd>/.rovecode/skills/alpha with its files; the listing shows exactly the skill (no .install-*)", async () => {
    const cwd = scratch("rovecode-sk72tar-");
    const file = join(scratch("rovecode-sk72tar-"), "alpha.tar.gz");
    writeFileSync(file, await good());
    const r = await run(["install", file], cwd);
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(r.out).toEqual([`installed alpha (v0.0.0) → ${join(skillsDirOf(cwd), "alpha")}`]); // rovecode's version default
    expect(listing(skillsDirOf(cwd))).toEqual(["alpha"]);
    expect(listing(join(skillsDirOf(cwd), "alpha"))).toEqual(["SKILL.md", "scripts"]);
  });

  const manyEntries: Record<string, string> = { "alpha/SKILL.md": skillMd("alpha") };
  for (let i = 0; i <= MAX_ARCHIVE_ENTRIES; i++) manyEntries[`alpha/f${i}`] = "";
  const unsafe: Array<[string, Record<string, string>, RegExp]> = [
    ["a `..` segment", { "alpha/SKILL.md": skillMd("alpha"), "../x": "x" }, /relative segment/],
    ["a drive letter", { "alpha/SKILL.md": skillMd("alpha"), "C:/x": "x" }, /drive letter/],
    ["a leading slash", { "alpha/SKILL.md": skillMd("alpha"), "/etc/x": "x" }, /absolute path/],
    ["an empty segment", { "alpha/SKILL.md": skillMd("alpha"), "alpha//x": "x" }, /empty path segment/],
    ["two top-level dirs", { "alpha/SKILL.md": skillMd("alpha"), "beta/SKILL.md": skillMd("beta") }, /exactly one top-level directory/],
    ["no SKILL.md at the top level", { "alpha/README.md": "x", "alpha/deep/SKILL.md": skillMd("deep") }, /has no SKILL\.md/],
    ["a top-level file", { "alpha/SKILL.md": skillMd("alpha"), "README.md": "x" }, /not inside a top-level directory/],
    [`${MAX_ARCHIVE_ENTRIES + 2} entries`, manyEntries, /entries \(max 2000\)/],
  ];
  for (const [title, entries, why] of unsafe) {
    test(`${title} → exit 2 and the skills dir is UNCHANGED (M3)`, async () => {
      const cwd = scratch("rovecode-sk72tar-");
      const file = join(scratch("rovecode-sk72tar-"), "bad.tar.gz");
      writeFileSync(file, await craftArchive(entries));
      write(join(skillsDirOf(cwd), "keep", "SKILL.md"), skillMd("keep")); // pre-existing content the install must not touch
      const before = listing(skillsDirOf(cwd));
      const r = await run(["install", file], cwd);
      expect(r.code, r.err.join("\n")).toBe(2); // MUTATION TARGET M3: no pre-write check → `../x` is written beside the staging dir, exit 0
      expect(r.err.join("\n")).toMatch(why);
      expect(listing(skillsDirOf(cwd))).toEqual(before);
      expect(existsSync(join(cwd, ".rovecode", "x"))).toBe(false);
      expect(existsSync(join(cwd, "x"))).toBe(false);
    });
  }

  test("checkArchiveEntries: a backslash key, an empty archive, a `.` segment are refused; the good shape passes", () => {
    expect(checkArchiveEntries(["alpha/SKILL.md", "alpha\\x"])).toMatch(/backslash/);
    expect(checkArchiveEntries([])).toMatch(/empty/);
    expect(checkArchiveEntries(["alpha/SKILL.md", "alpha/./x"])).toMatch(/relative segment/);
    expect(checkArchiveEntries(["alpha/SKILL.md", "alpha/scripts/run.sh"])).toBeNull();
  });

  test("not a tar.gz (a text file) → exit 2 and no skills dir is created; a staged skill the loader marks INVALID (empty description) → exit 2, no .install-* left", async () => {
    const cwd = scratch("rovecode-sk72tar-"), dir = scratch("rovecode-sk72tar-");
    const txt = join(dir, "notes.tar.gz");
    writeFileSync(txt, "<html>not a tarball</html>");
    let r = await run(["install", txt], cwd);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/not a tar\.gz archive/);
    expect(existsSync(skillsDirOf(cwd))).toBe(false);
    const bad = join(dir, "bad.tar.gz");
    writeFileSync(bad, await craftArchive({ "alpha/SKILL.md": '---\nname: alpha\ndescription: ""\n---\n' }));
    r = await run(["install", bad], cwd);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/staged skill is invalid/);
    expect(listing(skillsDirOf(cwd))).toEqual([]);
  });
});

describe("install <file.tar.gz>: tar member types (fixer — `files()` lists regular files only, so links were invisible to the key check)", () => {
  const SKILL: TarMember = { name: "alpha/SKILL.md", data: skillMd("alpha") };
  const dirs: TarMember[] = [{ name: "alpha/", type: "5" }, SKILL, { name: "alpha/empty/", type: "5" }, { name: "alpha/scripts/", type: "5" }, { name: "alpha/scripts/run.sh", data: "echo\n" }];

  test("a symlink member `alpha/link → ../../../escape` + a file written THROUGH it → exit 2 naming the symlink; the skills dir is UNCHANGED and nothing lands outside it", async () => {
    const cwd = scratch("rovecode-sk72tar-");
    const file = join(scratch("rovecode-sk72tar-"), "sym.tar.gz");
    writeFileSync(file, craftTar([SKILL, { name: "alpha/link", type: "2", link: "../../../escape" }, { name: "alpha/link/pwned.txt", data: "pwned\n" }]));
    write(join(skillsDirOf(cwd), "keep", "SKILL.md"), skillMd("keep"));
    const r = await run(["install", file], cwd);
    expect(r.code, r.err.join("\n")).toBe(2); // MUTATION TARGET: no header walk → pwned.txt lands under a plain `link/` dir, exit 0
    expect(r.err.join("\n")).toMatch(/unsafe entry "alpha\/link": symlink member/);
    expect(listing(skillsDirOf(cwd))).toEqual(["keep"]);
    expect(existsSync(join(cwd, ".rovecode", "escape"))).toBe(false); // where `../../../escape` from `<staging>/alpha/` would resolve
    expect(existsSync(join(cwd, "escape"))).toBe(false);
  });

  test("a hard-link member and a fifo member → exit 2 naming the type (a raw .tar takes the same walk); the skills dir is never created", async () => {
    const cwd = scratch("rovecode-sk72tar-"), dir = scratch("rovecode-sk72tar-");
    const hard = join(dir, "hard.tar.gz");
    writeFileSync(hard, craftTar([SKILL, { name: "alpha/hl", type: "1", link: "alpha/SKILL.md" }]));
    let r = await run(["install", hard], cwd);
    expect(r.code, r.err.join("\n")).toBe(2); // without the walk files() silently DROPS the hard link → exit 0 with a file missing
    expect(r.err.join("\n")).toMatch(/unsafe entry "alpha\/hl": hard link member/);
    const fifo = join(dir, "fifo.tar");
    writeFileSync(fifo, craftTar([SKILL, { name: "alpha/pipe", type: "6" }], false));
    r = await run(["install", fifo], cwd);
    expect(r.code, r.err.join("\n")).toBe(2);
    expect(r.err.join("\n")).toMatch(/"alpha\/pipe": fifo member/);
    expect(existsSync(skillsDirOf(cwd))).toBe(false);
  });

  test("directory members create nothing — the staged tree is written from the validated file list, never `extract`: `alpha/empty/` is absent, the files are byte-exact", async () => {
    const cwd = scratch("rovecode-sk72tar-");
    const file = join(scratch("rovecode-sk72tar-"), "dirs.tar.gz");
    writeFileSync(file, craftTar(dirs));
    const r = await run(["install", file], cwd);
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(r.out).toEqual([`installed alpha (v0.0.0) → ${join(skillsDirOf(cwd), "alpha")}`]); // rovecode's version default
    expect(listing(skillsDirOf(cwd))).toEqual(["alpha"]);
    expect(listing(join(skillsDirOf(cwd), "alpha"))).toEqual(["SKILL.md", "scripts"]); // MUTATION TARGET: extract(staging) restored → ["SKILL.md", "empty", "scripts"]
    expect(readFileSync(join(skillsDirOf(cwd), "alpha", "SKILL.md"), "utf8")).toBe(skillMd("alpha"));
    expect(readFileSync(join(skillsDirOf(cwd), "alpha", "scripts", "run.sh"), "utf8")).toBe("echo\n");
  });

  test("findLinkMember: files + directories + a pax header → null (gzip and raw); a non-ustar body → null; symlink / hard link / device named, also after a two-block file", () => {
    const clean: TarMember[] = [{ name: "alpha/", type: "5" }, SKILL, { name: "alpha/x", type: "x", data: "17 comment=hello\n" }, { name: "alpha/f", data: "f" }];
    expect(findLinkMember(craftTar(clean))).toBeNull();
    expect(findLinkMember(craftTar(clean, false))).toBeNull();
    expect(findLinkMember(new TextEncoder().encode("<html>not a tarball</html>"))).toBeNull();
    expect(findLinkMember(craftTar([SKILL, { name: "alpha/l", type: "2", link: "x" }], false))).toBe('unsafe entry "alpha/l": symlink member');
    expect(findLinkMember(craftTar([{ name: "alpha/h", type: "1", link: "alpha/SKILL.md" }, SKILL]))).toBe('unsafe entry "alpha/h": hard link member');
    expect(findLinkMember(craftTar([SKILL, { name: "alpha/dev", type: "3" }]))).toBe('unsafe entry "alpha/dev": character device member');
    // the walk must step over a member's data blocks: a symlink AFTER a 600-byte file (two data blocks) is still found
    expect(findLinkMember(craftTar([{ name: "alpha/big", data: "z".repeat(600) }, { name: "alpha/l", type: "2", link: "x" }]))).toMatch(/"alpha\/l": symlink/);
    // a gzip body that inflates past INFLATE_CAP (a header-only bomb: `files()` counts none of its members) is refused, not inflated
    expect(findLinkMember(Bun.gzipSync(new Uint8Array(INFLATE_CAP + 1)))).toBe(`archive inflates past ${INFLATE_CAP} bytes`);
  });
});

describe("install <url> (injected fetch)", () => {
  const respond = (body: Uint8Array | string, status = 200): FetchLike => async () => new Response(body as BodyInit, { status });

  test("an http URL → the body is unpacked like a file; the fetch is called once with the URL", async () => {
    const cwd = scratch("rovecode-sk72url-");
    const bytes = await good();
    const calls: string[] = [];
    const f: FetchLike = async (u) => { calls.push(u); return new Response(bytes as BodyInit); };
    const r = await run(["install", "http://skills.example.test/alpha.tar.gz"], cwd, f);
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(calls).toEqual(["http://skills.example.test/alpha.tar.gz"]);
    expect(listing(skillsDirOf(cwd))).toEqual(["alpha"]);
  });

  test("a redirect is followed but RE-GUARDED: a hop to a private address is refused (exit 1) and its body never read; a hop to another public host installs", async () => {
    const bytes = await good();
    const hops: string[] = [];
    const redirectTo = (location: string): FetchLike => async (u) => {
      hops.push(u);
      if (hops.length === 1) return new Response(null, { status: 302, headers: { location } });
      return new Response(bytes as BodyInit);
    };
    // hop → link-local metadata: the guard runs again on the new host, so the second request never happens
    const cwd = scratch("rovecode-sk72url-");
    const c = collectIo();
    const code = await cmdSkills(["install", "https://start.test/a.tar.gz"], cwd, {
      io: c.io, globalDir: join(cwd, "no-global"),
      fetch: redirectTo("http://169.254.169.254/latest/meta-data/"),
      resolve: async (host) => (host === "start.test" ? ["93.184.216.34"] : ["169.254.169.254"]),
    });
    expect(code).toBe(1); // MUTATION TARGET: redirect: "follow" instead of the manual re-guarded loop → 0/2, body fetched
    expect(c.err.join("\n")).toContain("refused http://169.254.169.254/latest/meta-data/");
    expect(hops.length).toBe(1);
    expect(listing(skillsDirOf(cwd))).toEqual([]);
    // and the ordinary case still works: one hop to another public host, then the archive
    hops.length = 0;
    const cwd2 = scratch("rovecode-sk72url-");
    const r = await run(["install", "https://start.test/a.tar.gz"], cwd2, redirectTo("https://cdn.test/a.tar.gz"));
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(hops).toEqual(["https://start.test/a.tar.gz", "https://cdn.test/a.tar.gz"]);
    expect(listing(skillsDirOf(cwd2))).toEqual(["alpha"]);
  });

  test("HTTP 500 / a non-archive body / a network error → exit 2, no .install-* left; file: and ftp: schemes → exit 1 without any fetch", async () => {
    const cwd = scratch("rovecode-sk72url-");
    let r = await run(["install", "https://x.test/a.tar.gz"], cwd, respond("boom", 500));
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/HTTP 500/);
    r = await run(["install", "https://x.test/a.tar.gz"], cwd, respond("<html>nope</html>"));
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/not a tar\.gz/);
    r = await run(["install", "https://x.test/a.tar.gz"], cwd, async () => { throw new Error("ECONNREFUSED (injected)"); });
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/download failed: ECONNREFUSED/);
    expect(listing(skillsDirOf(cwd)).filter((n) => n.startsWith(".install-"))).toEqual([]);
    let fetched = 0;
    const spy: FetchLike = async () => { fetched++; return new Response(""); };
    for (const u of ["file:///tmp/a.tar.gz", "ftp://x.test/a.tar.gz"]) {
      r = await run(["install", u], cwd, spy);
      expect(r.code, u).toBe(1);
      expect(r.err.join("\n")).toMatch(/only http\(s\) URLs/);
    }
    expect(fetched).toBe(0);
  });
});
