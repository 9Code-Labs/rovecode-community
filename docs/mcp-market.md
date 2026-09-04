# The MCP market

`rovecode mcp …` on a shell and `/mcp` in the TUI find MCP servers and put them in your `mcp.json`.
Two sources, one rule: **you see the exact command (or URL), who publishes it and which version before
anything is written, and nothing is written without your yes.**

## Where servers live

Three files, most local wins on a name clash (`src/mcp/config.ts loadMcpConfig`):

| file | scope | who writes it |
|---|---|---|
| `~/.rovecode/mcp.json` | you, every project | `rovecode mcp add <name>` (default) |
| `<repo>/.mcp.json` | harvested claude-code format | other tools; read as is |
| `<repo>/.rovecode/mcp.json` | this repo | `rovecode mcp add <name> --project` |

Format is the claude-code map: `{ "mcpServers": { "<name>": { "command", "args", "env" } | { "type": "http", "url", "headers" } } }`.
Any value in `args`, `env`, `headers` or `url` may say `${NAME}`; the loader fills it from the environment at launch.
An unset `${NAME}` **skips that server with a warning** instead of starting it with an empty key.

Servers are read once per process — restart rovecode after `add`/`remove`.

## Sources

**Curated shelf** (`src/mcp/market-catalog.ts`, offline). Servers we have looked at, from publishers we can name,
launch line spelled out: filesystem, memory, sequential-thinking, everything (test server), fetch, git, time
(all `modelcontextprotocol`), github (remote with a PAT header, or the official docker image), playwright
(Microsoft), context7 (Upstash), brave-search, firecrawl, tavily, exa, deepwiki (Cognition), cloudflare-docs.
Rules for an entry: secrets travel by environment variable or header, never as an argument; OAuth-only
remotes are left out because our http transport carries a header, not a browser flow.

**Official registry** (`registry.modelcontextprotocol.io`, `src/mcp/market.ts`). The API as verified live:

```
GET /v0/servers?search=<substring of name>&version=latest&limit=50   → { servers: [{ server, _meta }], metadata: { nextCursor, count } }
GET /v0/servers/<url-encoded name>/versions/latest                    → { server, _meta }
server: { name "io.github.owner/repo", description, title?, version, repository?, websiteUrl?,
          packages?: [{ registryType npm|pypi|oci|nuget|mcpb, identifier, version?, runtimeHint?, transport{type},
                        runtimeArguments?, packageArguments?, environmentVariables?[{name,isRequired,isSecret,value|default}] }],
          remotes?:  [{ type streamable-http|sse, url, headers?[{name, value "Bearer {var}", isSecret, isRequired}] }] }
_meta["io.modelcontextprotocol.registry/official"]: { status active|deprecated|deleted, isLatest, publishedAt, … }
```

Note `search=` matches the **server name** only, not the description — `rovecode mcp search postgres` finds
`io.github.x/postgres-mcp` but not a server described as "PostgreSQL access" under another name.

Registry answers are **untrusted data**. `market.ts` re-types every field, cuts strings (300 chars, descriptions
500), caps lists (32 args/env, 8 packages, 100 servers a page, 2 MB a body), refuses a `runtimeHint` that is not
a bare command name, drops `deleted` listings and keeps `deprecated` ones *with* the status shown, and never
evaluates anything. Package → launch line: npm → `npx -y <id>@<version>`, pypi → `uvx <id>==<version>`,
oci → `docker run -i --rm -e NAME… <id>:<version>` (variables ride the environment, never argv); nuget/mcpb and
`sse` remotes are refused with a note. A required argument the registry cannot fill (a directory, a database
URL) is listed as `needs …` in the plan and left for you to add in the file.

Responses are cached under `~/.rovecode/cache/mcp-market.json` for a day (40 most recent queries). With the
network down a stale cache answers with a note; with no cache the curated shelf still does.
`ROVECODE_MCP_REGISTRY=<base url>` points at another registry (tests inject `fetch` instead).

## `rovecode mcp`

```
rovecode mcp search [query]        curated rows first, then the registry's name matches
rovecode mcp info <name>           publisher, version, status, every launch form, the env names it asks for
rovecode mcp add <name> [--project] [--pick N] [--as <name>] [--yes] [--force]
rovecode mcp remove <name> [--project]
rovecode mcp list                  every configured server with its file
```

`add` in order: (1) prints the **plan** — title, version, status, source, publisher, repo, the exact `runs …`
or `connects …` line, each env/header **name** and how it will be filled, what still `needs` a hand, the file and
the server name; (2) asks `install? [y/N]` — skipped by `--yes`; (3) asks each secret by name through the same
masked prompt as `rovecode auth set` (`readSecret`: raw mode, never echoed, never in argv) and each plain
required value on a normal line; (4) writes.

Without a terminal: no `--yes` → nothing written, exit 1. With `--yes` but a required secret for the **user**
file → nothing written (there is no way to ask); for a **project** file the secret is `${NAME}` anyway, so the
write succeeds and the closing line names the variables to export.

Secrets go **as values only into `~/.rovecode/mcp.json`** (mode 0600 where the OS honours it). A `--project` file
gets `${NAME}` — a token never lands in a repo. `--as` renames (a registry `io.github.acme/widgets` is `widgets`
by default), `--pick N` chooses among several launch forms (`info` numbers them), `--force` replaces.

## `/mcp` in the TUI

`/mcp [query] [--project]` opens the **palette** (`Renderer.pickOne` — the same box, keys and fuzzy filter as ⌃k)
titled `mcp market · <query>` over the curated shelf plus the registry's matches; a server with several launch
forms gets one more pick (`<title> · how`); then the **approval card** (`Renderer.askApproval`) with the one line
that runs as the preview and the whole plan as the detail. Any yes writes; deny or Esc writes nothing.

The TUI has **no masked input, so it never asks for a secret**: every asked value is written as `${NAME}` and the
closing note lists the names to set before the restart — or says to run `rovecode mcp add <name>` on a shell,
where the prompt is masked. Nothing typed into the TUI's prompt ever becomes a key.

## Trust: what runs on first open, and the proposed gate

**Today, project-scope MCP entries run on first open.** `.rovecode/mcp.json` and the harvested `.mcp.json` in a
freshly cloned repo are read by `createRuntime` and their `command` is spawned (lazily, on the first
`mcp_list`/`mcp_call`) with no confirmation — the same class of hole `docs/plugins.md` closes for project
plugins. The market does not widen it (a `--project` add writes to the same file the repo already controls) and
this pass does not close it either, because closing it changes what existing checkouts do. The design below is
what closing it should look like; it is one decision, not a new store.

**Proposed gate — one "trust this project" for plugins and MCP alike.**

- Reuse `~/.rovecode/plugins.json` (`src/plugins/state.ts`): `trusted: Record<absDir, digest>`. Add the project's
  two MCP files as trust subjects keyed by their absolute path, digest = sha256 of the file bytes (the plugin
  digest routine over a one-file "folder" gives exactly that). No second file, no second CLI verb.
- `loadMcpConfig` grows a `trusted?: (file: string, digest: string) => boolean` predicate; `createRuntime` passes
  `isTrusted(state, path, digest)`. The user file is always trusted (it is yours). A project file that is not
  trusted contributes **nothing** and yields one warning per file: `.rovecode/mcp.json holds 2 MCP servers that
  would run commands from this repo — review with \`rovecode mcp show --project\`, then \`rovecode mcp trust\``.
- `rovecode mcp show --project` prints each entry's exact command/args/URL (the same `describePlan` lines);
  `rovecode mcp trust` records the digest; any later edit to the file flips it back to untrusted, like a plugin
  whose files changed. `rovecode plugin trust <name>` and `rovecode mcp trust` write the same map, and a future
  `rovecode trust` could do both in one step.
- `rovecode mcp add --project` records the digest of the file it just wrote — the human approved that exact
  content on the card, so the gate does not ask twice. A clone by someone else still has to trust it.
- Migration: on the first run after the gate ships, an existing project file that has never been seen prints the
  warning once and stays inert until trusted. That is the behaviour change to take to Berkay.

## Files

- `src/mcp/market.ts` — types, registry re-typing (`parseRegistryPage`, `entryFromRegistry`), cache, `searchMarket`, `marketInfo`
- `src/mcp/market-catalog.ts` — the curated shelf
- `src/mcp/market-install.ts` — `planInstall` → `describePlan` → `fillPlan` → `writeServer` / `removeServer` / `configuredServers`
- `src/mcp/config.ts` — `loadMcpConfig(cwd, warnings, { home, env })`, `mcpConfigFiles`, `expandVars`, `parseConfigFile`
- `src/cli/mcp-market-cmd.ts` — `rovecode mcp …`; `src/tui/mcp-cmd.ts` — `/mcp`
- `test/unit/mcp-market.test.ts`, `test/unit/mcp-market-cmd.test.ts` — fixture registry + injected fetch; no network
