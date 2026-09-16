/** The MCP market (src/mcp/market.ts, market-catalog.ts, market-install.ts) without a network: a fixture
 *  in the registry's live shape (verified 2026-09-04) behind an injected fetch. What is pinned: registry
 *  JSON is re-typed and capped (bad items skipped, deleted dropped, deprecated kept with its status, long
 *  strings cut, sse remotes and nuget packages refused); the cache serves within its TTL and as a stale
 *  fallback; a plan renders the EXACT command/args or URL before anything is written; secrets go into the
 *  user file as values and into a project file as `${NAME}`; the loader fills `${NAME}` from the
 *  environment and skips an entry whose name is unset. */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_TTL_MS, LIMITS, cachePath, entryFromRegistry, installLabel, marketInfo, parseRegistryPage, publisherOf, searchMarket, type MarketEntry, MAX_PAGES } from "../../src/mcp/market.ts";
import { CURATED } from "../../src/mcp/market-catalog.ts";
import { configuredServers, defaultServerName, describePlan, fillPlan, planInstall, removeServer, writeServer, type InstallPlan } from "../../src/mcp/market-install.ts";
import { loadMcpConfig } from "../../src/mcp/config.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ------------------------------------------------------------------ fixture: the registry's live shape

const official = (status = "active") => ({ "io.modelcontextprotocol.registry/official": { status, isLatest: true, publishedAt: "2026-04-13T17:32:20Z" } });
const WIDGETS = {
  server: {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.acme/widgets", title: "Widgets", description: "Widgets for agents.", version: "1.2.0",
    repository: { url: "https://github.com/acme/widgets", source: "github" },
    packages: [{ registryType: "npm", registryBaseUrl: "https://registry.npmjs.org", identifier: "widgets-mcp", version: "1.2.0", runtimeHint: "npx", transport: { type: "stdio" },
      runtimeArguments: [{ type: "positional", value: "-y" }],
      packageArguments: [{ type: "named", name: "--root", isRequired: true, description: "the folder" }, { type: "named", name: "--mode", value: "fast" }],
      environmentVariables: [{ name: "WIDGET_TOKEN", isRequired: true, isSecret: true, description: "API token" }, { name: "WIDGET_REGION", value: "eu" }] }],
  },
  _meta: official(),
};
const PAGE = {
  servers: [
    WIDGETS,
    { server: { name: "com.example/py", description: "Python one.", version: "0.3.0", packages: [{ registryType: "pypi", identifier: "py-mcp", version: "latest", transport: { type: "stdio" } }] }, _meta: official() },
    { server: { name: "io.github.acme/box", description: "In a box.", version: "2.0", packages: [{ registryType: "oci", identifier: "ghcr.io/acme/box", version: "2.0", transport: { type: "stdio" }, environmentVariables: [{ name: "BOX_KEY", isRequired: true, isSecret: true }] }] }, _meta: official() },
    { server: { name: "ai.smithery/remote", description: "Hosted.", version: "0.4.0", remotes: [{ type: "sse", url: "https://r.example/sse" }, { type: "streamable-http", url: "https://r.example/mcp", headers: [{ name: "Authorization", value: "Bearer {smithery_api_key}", isSecret: true, isRequired: true, description: "Smithery key" }] }] }, _meta: official("deprecated") },
    { server: { name: "io.github.gone/x", description: "Gone.", remotes: [{ type: "streamable-http", url: "https://gone.example/mcp" }] }, _meta: official("deleted") },
    { server: { name: "io.github.acme/dotnet", description: "x".repeat(2000), packages: [{ registryType: "nuget", identifier: "Acme.Mcp", transport: { type: "stdio" } }] }, _meta: official() },
    { server: "nope" }, { server: { name: "no slash" } }, 42,
    WIDGETS, // a duplicate name (an older version page would do this) — deduped
  ],
  metadata: { nextCursor: "x", count: 9 },
};

/** a fetch that answers the two registry routes from the fixture and counts calls */
function fakeFetch(opts: { fail?: boolean } = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    if (opts.fail) throw new Error("ECONNREFUSED");
    if (url.includes("/servers?")) return new Response(JSON.stringify(PAGE), { status: 200 });
    const m = /\/servers\/([^/]+)\/versions\/latest/.exec(url);
    if (m) { const name = decodeURIComponent(m[1]!); const hit = PAGE.servers.find((s) => typeof s === "object" && s !== null && typeof (s as { server?: unknown }).server === "object" && ((s as { server: { name?: string } }).server).name === name); return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("{}", { status: 404 }); }
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;
  return { fetch: f, urls };
}

test("registry JSON is re-typed and capped: npm/pypi/oci become exact launch lines, a header template becomes a question, sse and nuget are refused, deleted is dropped, deprecated is kept with its status, junk items and long strings are cut", () => {
  const notes: string[] = [];
  const entries = parseRegistryPage(PAGE, notes);
  expect(entries.map((e) => e.key)).toEqual(["io.github.acme/widgets", "com.example/py", "io.github.acme/box", "ai.smithery/remote", "io.github.acme/dotnet"]);
  const [widgets, py, box, remote, dotnet] = entries as [MarketEntry, MarketEntry, MarketEntry, MarketEntry, MarketEntry];
  // npm: runtimeHint npx, the fixture's own -y is not doubled, version pinned, the valued named arg inlined, the required empty one pending
  expect(widgets.installs).toEqual([{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "widgets-mcp@1.2.0", "--mode", "fast"], pending: ["--root <value>"],
    env: [{ name: "WIDGET_TOKEN", required: true, secret: true, description: "API token" }, { name: "WIDGET_REGION", required: false, secret: false, default: "eu" }] }]);
  expect(widgets).toMatchObject({ title: "Widgets", version: "1.2.0", publisher: "github.com/acme", repository: "https://github.com/acme/widgets", source: "registry" });
  expect(widgets.status).toBeUndefined();
  expect(installLabel(py.installs[0]!)).toBe("uvx py-mcp"); // "latest" is not a pin
  expect(installLabel(box.installs[0]!)).toBe("docker run -i --rm -e BOX_KEY ghcr.io/acme/box:2.0"); // the key rides the environment, never argv
  expect(remote.installs).toEqual([{ kind: "http", url: "https://r.example/mcp", headers: [{ name: "Authorization", template: "Bearer {smithery_api_key}", required: true, secret: true, description: "Smithery key" }] }]);
  expect(remote.status).toBe("deprecated");
  expect(remote.publisher).toBe("smithery.ai");
  expect(dotnet.installs).toEqual([]);
  expect(dotnet.description.length).toBe(LIMITS.desc);
  expect(dotnet.description.endsWith("…")).toBe(true);
  expect(notes).toContain('Acme.Mcp: package type "nuget" is not something rovecode can launch');
  expect(notes).toContain("https://r.example/sse: sse remote (legacy transport) is not something rovecode can connect to"); // the human learns why, not just that nothing was written
  // caps: a page of 500 servers keeps LIMITS.servers
  const big = { servers: Array.from({ length: 500 }, (_, i) => ({ server: { name: `io.github.a/s${i}`, description: "d" }, _meta: official() })) };
  expect(parseRegistryPage(big, []).length).toBe(LIMITS.servers);
  expect(parseRegistryPage("junk", notes)).toEqual([]);
  expect(entryFromRegistry({ server: { name: "io.github.a/b", packages: [{ registryType: "npm", identifier: "x", runtimeHint: "bash -c" }] } }, notes)?.installs).toEqual([]); // a hint that is not a bare command is refused
  expect(publisherOf("com.pulsemcp/remote-filesystem")).toBe("pulsemcp.com");
});

test("searchMarket: curated first, registry matches deduped after; the cache answers inside the TTL, serves stale with a note when the network fails, and a one-letter query never leaves the machine", async () => {
  const home = tmp("rovecode-mkt-home-");
  let clock = 1_000_000;
  const net = fakeFetch();
  const deps = { fetch: net.fetch, home, now: () => clock };
  const one = await searchMarket("widgets", deps);
  expect(one.fromCache).toBe(false);
  // the cursor is followed (the fixture's page always says nextCursor "x"), and the SECOND identical
  // cursor stops the walk rather than looping the client forever
  expect(net.urls).toEqual([
    "https://registry.modelcontextprotocol.io/v0/servers?search=widgets&version=latest&limit=50",
    "https://registry.modelcontextprotocol.io/v0/servers?search=widgets&version=latest&limit=50&cursor=x",
  ]);
  expect(one.entries.map((e) => e.key)).toEqual(["io.github.acme/widgets", "com.example/py", "io.github.acme/box", "ai.smithery/remote", "io.github.acme/dotnet"]); // the registry does the name matching; we do not re-filter its page
  expect(existsSync(cachePath(home))).toBe(true);
  const two = await searchMarket("widgets", deps);
  expect(two.fromCache).toBe(true);
  expect(net.urls.length).toBe(2);   // still the first search's two pages: the cache answered, nothing new went out
  // curated rows lead and the registry's copy of a curated repo is dropped
  const gh = await searchMarket("github", { ...deps, fetch: fakeFetch().fetch });
  expect(gh.entries[0]!.key).toBe("github");
  expect(gh.entries[0]!.source).toBe("curated");
  // past the TTL with the network down: stale results + a note
  clock += CACHE_TTL_MS + 1;
  const stale = await searchMarket("widgets", { ...deps, fetch: fakeFetch({ fail: true }).fetch });
  expect(stale.fromCache).toBe(true);
  expect(stale.entries.length).toBe(5);
  expect(stale.notes[0]).toMatch(/registry unreachable \(ECONNREFUSED\) — showing cached results/);
  // no cache, network down: curated only, the reason named
  const cold = await searchMarket("zzz-nothing", { fetch: fakeFetch({ fail: true }).fetch, home: tmp("rovecode-mkt-home-") });
  expect(cold.entries).toEqual([]);
  expect(cold.notes[0]).toMatch(/registry unreachable/);
  const short = await searchMarket("g", { ...deps, fetch: fakeFetch({ fail: true }).fetch });
  expect(short.entries.every((e) => e.source === "curated")).toBe(true);
  expect(short.notes).toEqual([]);
  const all = await searchMarket("", deps);
  expect(all.entries.length).toBe(CURATED.length);
  expect(net.urls.length).toBe(2);   // still the first search's two pages: the cache answered, nothing new went out
  // offline: curated + whatever the cache holds, no fetch
  const off = await searchMarket("widgets", { ...deps, offline: true, fetch: fakeFetch({ fail: true }).fetch });
  expect(off.fromCache).toBe(true);
  expect(off.notes).toEqual(["offline: showing cached registry results"]);
});

test("marketInfo: a curated key answers offline; a registry key hits /servers/<name>/versions/latest; a bare unknown word says what names look like", async () => {
  const home = tmp("rovecode-mkt-home-");
  const net = fakeFetch();
  expect((await marketInfo("filesystem", { fetch: net.fetch, home })).entry?.source).toBe("curated");
  expect(net.urls).toEqual([]);
  const r = await marketInfo("io.github.acme/widgets", { fetch: net.fetch, home });
  expect(r.entry?.title).toBe("Widgets");
  expect(net.urls).toEqual(["https://registry.modelcontextprotocol.io/v0/servers/io.github.acme%2Fwidgets/versions/latest"]);
  const miss = await marketInfo("nothing-here", { fetch: net.fetch, home });
  expect(miss.entry).toBeUndefined();
  expect(miss.notes[0]).toMatch(/not a curated name and not a registry name/);
  const gone = await marketInfo("io.github.nobody/x", { fetch: net.fetch, home });
  expect(gone.notes).toEqual(["registry unreachable (registry answered 404)"]);
});

test("curated shelf: every entry has a publisher, a launch form rovecode can run, secrets only through env or a header, and a key the market accepts as a server name", () => {
  expect(CURATED.length).toBeGreaterThanOrEqual(12);
  for (const e of CURATED) {
    expect(e.source).toBe("curated");
    expect(e.publisher).toBeTruthy();
    expect(e.installs.length).toBeGreaterThan(0);
    expect(e.key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    for (const i of e.installs) {
      // a NAME after docker's -e is fine; a value on the line (--token=…, KEY=…) is not
      if (i.kind === "stdio") { expect(["npx", "uvx", "docker"]).toContain(i.command); for (const a of i.args) expect(a).not.toMatch(/(token|key|secret)=/i); }
      else expect(i.url).toMatch(/^https:\/\//);
    }
  }
  expect(new Set(CURATED.map((e) => e.key)).size).toBe(CURATED.length);
});

test("planInstall + describePlan + fillPlan: the preview names the exact command, source, publisher, env NAMES and file; a secret is a value in the user file and ${NAME} in a project file; a header template is filled; docker keeps -e NAME", () => {
  const cwd = tmp("rovecode-mkt-cwd-"), home = tmp("rovecode-mkt-home-");
  const [widgets, , box, remote] = parseRegistryPage(PAGE, []) as [MarketEntry, MarketEntry, MarketEntry, MarketEntry];
  const user = planInstall(widgets, { scope: "user", cwd, home }) as InstallPlan;
  expect(user.name).toBe("widgets");
  expect(user.file).toBe(join(home, "mcp.json"));
  expect(user.asks.map((a) => a.name)).toEqual(["WIDGET_TOKEN"]); // WIDGET_REGION has a value: not a question
  // a required flag with no value is a FRAGMENT, not a bare flag: appending "--root" alone would write a
  // server that launches and then rejects its own arguments (see pendingWords)
  expect(user.pending).toEqual(["--root <value>"]);
  const lines = describePlan(user);
  expect(lines).toContain("  runs       npx -y widgets-mcp@1.2.0 --mode fast");
  expect(lines).toContain("  source     MCP registry (registry.modelcontextprotocol.io)");
  expect(lines).toContain("  publisher  github.com/acme");
  expect(lines).toContain("  env        WIDGET_TOKEN (asked, masked, never shown)");
  expect(lines).toContain("  env        WIDGET_REGION = eu  optional");
  expect(lines).toContain("  needs      --root <value> — asked here; unanswered it is written as the placeholder");
  expect(lines.at(-1)).toBe(`  writes     ${join(home, "mcp.json")}  as "widgets"`);
  expect(lines.join("\n")).not.toContain("s3cret");
  // unanswered, the hole is written into args — visible, editable, and refused by the loader until it is
  // filled. Dropping it wrote a server that could never start and a note pointing at a line that was not there.
  expect(fillPlan(user, { WIDGET_TOKEN: "s3cret" })).toEqual({ command: "npx", args: ["-y", "widgets-mcp@1.2.0", "--mode", "fast", "--root", "<value>"], env: { WIDGET_TOKEN: "s3cret", WIDGET_REGION: "eu" } });
  // answered, the flag survives and the hole becomes the answer
  expect((fillPlan(user, { WIDGET_TOKEN: "s3cret", "--root <value>": "/srv/data" }) as { args: string[] }).args)
    .toEqual(["-y", "widgets-mcp@1.2.0", "--mode", "fast", "--root", "/srv/data"]);
  // project scope: the secret never lands in the repo file even when answered
  const proj = planInstall(widgets, { scope: "project", cwd, home, name: "wid" }) as InstallPlan;
  expect(proj.file).toBe(join(cwd, ".rovecode", "mcp.json"));
  expect(fillPlan(proj, { WIDGET_TOKEN: "s3cret" }).env).toEqual({ WIDGET_TOKEN: "${WIDGET_TOKEN}", WIDGET_REGION: "eu" });
  expect(describePlan(proj).at(-1)).toContain("secrets stay out of this file");
  // "env" mode (the TUI): nothing asked, every question is a ${NAME}
  expect(describePlan(user, "env")).toContain("  env        WIDGET_TOKEN (${WIDGET_TOKEN} — from your environment)");
  expect(fillPlan(user, {}).env).toEqual({ WIDGET_TOKEN: "${WIDGET_TOKEN}", WIDGET_REGION: "eu" });
  // header template
  const http = planInstall(remote, { scope: "user", cwd, home }) as InstallPlan;
  expect(http.asks).toEqual([{ name: "smithery_api_key", required: true, secret: true, description: "Smithery key" }]);
  expect(describePlan(http)[0]).toBe("Hosted. 0.4.0  [deprecated]".replace("Hosted.", "ai.smithery/remote").replace(" 0.4.0", " 0.4.0")); // title falls back to the key, status shown
  expect(describePlan(http)).toContain("  connects   https://r.example/mcp");
  expect(fillPlan(http, { smithery_api_key: "k" })).toEqual({ type: "http", url: "https://r.example/mcp", headers: { Authorization: "Bearer k" } });
  expect(fillPlan(http, {})).toEqual({ type: "http", url: "https://r.example/mcp", headers: { Authorization: "Bearer ${smithery_api_key}" } });
  // docker
  const dock = planInstall(box, { scope: "user", cwd, home }) as InstallPlan;
  expect(fillPlan(dock, { BOX_KEY: "b" })).toEqual({ command: "docker", args: ["run", "-i", "--rm", "-e", "BOX_KEY", "ghcr.io/acme/box:2.0"], env: { BOX_KEY: "b" } });
  // errors are values, not throws
  expect(planInstall({ ...widgets, installs: [] }, { scope: "user", cwd, home })).toMatchObject({ error: expect.stringContaining("nothing rovecode can launch") });
  expect(planInstall(widgets, { scope: "user", cwd, home, pick: 3 })).toMatchObject({ error: expect.stringContaining("--pick 3 is out of range") });
  expect(planInstall(widgets, { scope: "user", cwd, home, name: "Bad Name" })).toMatchObject({ error: expect.stringContaining("not a usable server name") });
  expect(defaultServerName("io.github.Acme/My_Server.v2")).toBe("my_server.v2");
  // the curated github entry offers two forms: remote with a header, docker with an env
  const gh = CURATED.find((e) => e.key === "github")!;
  expect(gh.installs.map((i) => i.kind)).toEqual(["http", "stdio"]);
  expect((planInstall(gh, { scope: "user", cwd, home, pick: 0 }) as InstallPlan).asks.map((a) => a.name)).toEqual(["GITHUB_PAT"]);
});

test("writeServer/removeServer keep the rest of the file, refuse a silent overwrite, and only write what the loader accepts; loadMcpConfig reads the user file lowest and fills ${NAME} from the environment — an unset name skips the entry with a warning", () => {
  const cwd = tmp("rovecode-mkt-cwd-"), home = tmp("rovecode-mkt-home-");
  const userFile = join(home, "mcp.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(userFile, JSON.stringify({ $comment: "mine", mcpServers: { old: { command: "old-server" } } }, null, 2));
  const cfg = writeServer(userFile, "widgets", { command: "npx", args: ["-y", "widgets-mcp"], env: { WIDGET_TOKEN: "${WIDGET_TOKEN}" } });
  expect(cfg).toMatchObject({ name: "widgets", transport: "stdio" });
  const json = JSON.parse(readFileSync(userFile, "utf8")) as { $comment: string; mcpServers: Record<string, unknown> };
  expect(json.$comment).toBe("mine");
  expect(Object.keys(json.mcpServers)).toEqual(["old", "widgets"]);
  expect(() => writeServer(userFile, "widgets", { command: "x" })).toThrow(/already has a server named "widgets"/);
  expect(() => writeServer(userFile, "bad", { url: "not a url" })).toThrow(/invalid url/);
  writeServer(userFile, "widgets", { command: "npx", args: ["-y", "widgets-mcp@1.2.0"], env: { WIDGET_TOKEN: "${WIDGET_TOKEN}" } }, { replace: true });
  // the loader: user file present only when a home is given; ${WIDGET_TOKEN} unset → skipped + warned; set → filled
  expect(loadMcpConfig(cwd).map((c) => c.name)).toEqual([]);
  const w1: string[] = [];
  expect(loadMcpConfig(cwd, w1, { home, env: {} }).map((c) => c.name)).toEqual(["old"]);
  expect(w1).toEqual([`${userFile}: server "widgets" needs \${WIDGET_TOKEN} set in the environment; skipped`]);
  const w2: string[] = [];
  const loaded = loadMcpConfig(cwd, w2, { home, env: { WIDGET_TOKEN: "tok" } });
  expect(loaded.find((c) => c.name === "widgets")).toEqual({ name: "widgets", transport: "stdio", command: "npx", args: ["-y", "widgets-mcp@1.2.0"], env: { WIDGET_TOKEN: "tok" } });
  expect(w2).toEqual([]);
  // a project file with the same name wins over the user file; headers and urls expand too
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeServer(join(cwd, ".rovecode", "mcp.json"), "widgets", { type: "http", url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${K}" } });
  const merged = loadMcpConfig(cwd, [], { home, env: { WIDGET_TOKEN: "tok", HOST: "h.example", K: "k" } });
  expect(merged.find((c) => c.name === "widgets")).toEqual({ name: "widgets", transport: "http", url: "https://h.example/mcp", headers: { Authorization: "Bearer k" } });
  // configuredServers lists every layer with its scope, unfilled names and all
  expect(configuredServers(cwd, home).map((r) => [r.server.name, r.scope])).toEqual([["old", "user"], ["widgets", "user"], ["widgets", "project"]]);
  expect(removeServer(userFile, "widgets")).toBe(true);
  expect(removeServer(userFile, "widgets")).toBe(false);
  expect(Object.keys((JSON.parse(readFileSync(userFile, "utf8")) as { mcpServers: object }).mcpServers)).toEqual(["old"]);
});

test("registry pagination: a match on page two is found, the walk is bounded, and a looping cursor cannot spin us forever", async () => {
  const official = () => ({ "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } });
  const server = (n: string) => ({ server: { name: n, description: "d" }, _meta: official() });

  // three pages, distinct cursors, the wanted server last — the single-page version reported it missing
  const pages: Record<string, unknown> = {
    "": { servers: [server("io.github.a/one")], metadata: { nextCursor: "c1" } },
    c1: { servers: [server("io.github.a/two")], metadata: { nextCursor: "c2" } },
    c2: { servers: [server("io.github.a/needle")] },   // no cursor: the end
  };
  const urls: string[] = [];
  const paged = (async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    const cursor = /[?&]cursor=([^&]*)/.exec(url)?.[1] ?? "";
    return new Response(JSON.stringify(pages[decodeURIComponent(cursor)] ?? { servers: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const found = await searchMarket("needle", { fetch: paged, home: tmp("rovecode-page-home-"), now: () => 5_000_000 });
  expect(found.entries.map((e) => e.key)).toEqual(["io.github.a/one", "io.github.a/two", "io.github.a/needle"]);
  expect(urls.length).toBe(3);   // stopped when the registry stopped offering a cursor, not before

  // a registry that keeps handing back the SAME cursor is stopped at once, not followed to MAX_PAGES
  const loopUrls: string[] = [];
  const looping = (async (input: string | URL | Request) => {
    loopUrls.push(String(input));
    return new Response(JSON.stringify({ servers: [server("io.github.a/loop")], metadata: { nextCursor: "same" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const looped = await searchMarket("loop", { fetch: looping, home: tmp("rovecode-loop-home-"), now: () => 6_000_000 });
  expect(loopUrls.length).toBe(2);
  expect(looped.entries.map((e) => e.key)).toEqual(["io.github.a/loop"]);   // deduped across pages

  // a registry that always advances is still bounded by MAX_PAGES
  let n = 0;
  const endless = (async () => new Response(JSON.stringify({ servers: [server(`io.github.a/s${n++}`)], metadata: { nextCursor: `c${n}` } }), { status: 200 })) as unknown as typeof fetch;
  const capped = await searchMarket("endless", { fetch: endless, home: tmp("rovecode-endless-home-"), now: () => 7_000_000 });
  expect(capped.entries.length).toBe(MAX_PAGES);
});
