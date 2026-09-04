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

## Trust: project files pass the same gate as project plugins

A repo's `.rovecode/mcp.json` and `.mcp.json` describe commands that would run on your machine. Since
Berkay's decision ("Kapı + kendi projelerimi otomatik güven") they load only once **you** have approved them
on this machine; until then they contribute **nothing** — no server, no `mcp_list`/`mcp_call` — and the launch
carries one warning per file:

```
mcp: /path/.rovecode/mcp.json: not trusted on this machine — its 2 MCP servers stay off (they would run commands from this repo). Review: rovecode mcp show --project · approve: rovecode mcp trust
```

- **Store**: the plugin trust store, `~/.rovecode/plugins.json` → `trusted`, keyed by the file's absolute path,
  value = sha256 of its bytes (`src/mcp/trust.ts`). It lives in the USER home, so a repo cannot trust itself.
  Plugins and MCP files share one map: "trust this project" is one decision, not two stores.
- **Any edit asks again**: a changed byte changes the digest; the file drops back to untrusted and warns.
- **Your own writes are approved as you approve them**: `rovecode mcp add --project` (after the plan and the
  y/N) and `/mcp … --project` (after the approval card) record the digest of the file they just wrote — but only
  when the file was already trusted or held no other server. Adding into a cloned file that still holds
  unapproved strangers writes the entry and says `NOT trusted yet`, pointing at `show`/`trust`; it never blesses
  what you did not see. `remove --project` keeps a trusted file trusted.
- **Manual path**: `rovecode mcp show --project` prints each project file, its trust, and every server with the
  exact command/URL and the env/header **names** (never values); `rovecode mcp trust [--yes]` approves both
  files as they are now after showing them (no TTY + no `--yes` → nothing); `rovecode mcp untrust` undoes.
  In the TUI `/mcp trust` raises one approval card per file (the file as the preview, its servers as the detail).
- **The user file is never gated** — `~/.rovecode/mcp.json` is yours.
- **Migration**: a project file that existed before this shipped is inert until trusted once; nothing is
  auto-trusted retroactively. `loadMcpConfig` without a `trusted` predicate (other callers, tests) behaves as
  before; the runtime always passes one.

## Files

- `src/mcp/market.ts` — types, registry re-typing (`parseRegistryPage`, `entryFromRegistry`), cache, `searchMarket`, `marketInfo`
- `src/mcp/market-catalog.ts` — the curated shelf
- `src/mcp/market-install.ts` — `planInstall` → `describePlan` → `fillPlan` → `writeServer` / `removeServer` / `configuredServers`
- `src/mcp/trust.ts` — `trustedPredicate`, `trustMcpFile`, `untrustMcpFile`, `mcpTrustStatus`, `projectMcpFiles`
- `src/mcp/config.ts` — `loadMcpConfig(cwd, warnings, { home, env, trusted })`, `mcpConfigFiles`, `expandVars`, `parseConfigFile`
- `src/cli/mcp-market-cmd.ts` — `rovecode mcp …`; `src/tui/mcp-cmd.ts` — `/mcp`
- `test/unit/mcp-market.test.ts`, `test/unit/mcp-market-cmd.test.ts`, `test/unit/mcp-trust.test.ts` (the gate through bootRuntime) — fixture registry + injected fetch; no network
