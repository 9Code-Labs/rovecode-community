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
Rovecode also reads its own array form `{ "servers": [{ "name", … }] }` in the same file (array entries are
appended after the map entries), accepts `transport` as a synonym for `type` (`stdio` · `http` ·
`streamable-http`; an `sse` entry is skipped with a warning), and honours `"enabled": false` to keep an entry
in the file but out of the run — `mcp list` shows it as `(disabled)`.
An unset `${NAME}` **skips that server with a warning** instead of starting it with an empty key.

Some servers also take an argument only you can supply and that is not a secret — the filesystem server's
directory, a database URL. The catalog marks it `needs`, and an install that nobody answered writes it into `args`
as an angle-bracket placeholder, `<directory the server may touch>`. The loader **refuses to launch a server
still carrying one** and names the file and the hole instead:

```
~/.rovecode/mcp.json: server "filesystem" still has <directory the server may touch> to fill in; skipped (edit that line and it will connect)
```

Replace that one word in `args` and restart. `rovecode mcp list` shows such an entry with `(fill in <…>)` at the end
of its line — it is configured, not launchable — and prints on stderr whatever a file could not be parsed for
(invalid JSON, a nameless entry). Before a180ad2 the argument was dropped and the entry was written in a form that
could never start — `npx … server-filesystem` with no directory — and the only sign was a server that was never there.

A server the loader accepted but that never answers — a command that does not exist, a package `npx` cannot
resolve — is counted on the startup card as configured and, once its connect attempt has settled, named in a
warning: `mcp: server "ghost" did not connect — <error>`. The same note an in-session install shows when a
just-written server fails.

Servers are read once per process — restart rovecode after a shell `add`/`remove`. An install made from inside
a session (`/mcp`, `/market`) is the exception: the session re-reads the three files, trust gate included, and
connects the new server on the spot — "connected as <name> — no restart needed", or the name of the one that
failed. A session that started with no servers at all gets `mcp_list`/`mcp_call` registered at that moment (d30755f).

## Sources

**Curated shelf** (`src/mcp/market-catalog.ts`, offline). Servers we have looked at, from publishers we can name,
launch line spelled out: filesystem, memory, sequential-thinking, everything (test server), fetch, git, time
(all `modelcontextprotocol`), github (remote with a PAT header, or the official docker image), playwright
(Microsoft), context7 (Upstash), brave-search, firecrawl, tavily, exa, deepwiki (Cognition), cloudflare-docs.
Rules for an entry: secrets travel by environment variable or header, never as an argument; OAuth-only
remotes are left out because our http transport carries a header, not a browser flow.

**Official registry** (`registry.modelcontextprotocol.io`, `src/mcp/market.ts`). The API as verified live:

```
GET /v0/servers?search=<substring of name>&version=latest&limit=50
  -> { servers: [{ server, _meta }], metadata: { nextCursor, count } }
GET /v0/servers/<url-encoded name>/versions/latest
  -> { server, _meta }

server: { name "io.github.owner/repo", description, title?, version,
          repository?, websiteUrl?,
          packages?: [{ registryType npm|pypi|oci|nuget|mcpb, identifier,
                        version?, runtimeHint?, transport{type},
                        runtimeArguments?, packageArguments?,
                        environmentVariables?: [{ name, isRequired, isSecret,
                                                  value|default }] }],
          remotes?:  [{ type streamable-http|sse, url,
                        headers?: [{ name, value "Bearer {var}", isSecret,
                                     isRequired }] }] }

_meta["io.modelcontextprotocol.registry/official"]:
  { status active|deprecated|deleted, isLatest, publishedAt, ... }
```

A query shorter than two characters (and the empty query) is answered from the curated shelf only — the
registry is never asked, and nothing says so. Note `search=` matches the **server name** only, not the description — `rovecode mcp search postgres` finds
`io.github.x/postgres-mcp` but not a server described as "PostgreSQL access" under another name.

Registry answers are **untrusted data**. `market.ts` re-types every field, cuts strings (300 chars, descriptions
500), caps lists (32 args/env, 8 packages, 100 servers a page, 2 MB a body), refuses a `runtimeHint` that is not
a bare command name, drops `deleted` listings and keeps `deprecated` ones *with* the status shown, and never
evaluates anything. Package → launch line: npm → `npx -y <id>@<version>`, pypi → `uvx <id>==<version>`,
oci → `docker run -i --rm -e NAME… <id>:<version>` (variables ride the environment, never argv) — the version
is appended only when the registry gives one that is not `latest`, otherwise the bare identifier is launched,
and a `runtimeHint` that is a bare command name replaces `npx`/`uvx`/`docker`. nuget/mcpb packages are refused
with a note; an `sse` remote is refused with a note too (`<url>: sse remote (legacy transport) is not something
rovecode can connect to`), so when an entry ends up with no launch form `mcp info`/`mcp add` say why before
`<name> lists nothing rovecode can launch or connect to`. A required argument the registry cannot fill (a directory, a database
URL) is listed as `needs …` in the plan and left for you to add in the file.

Responses are cached under `~/.rovecode/cache/mcp-market.json` for a day (40 most recent queries). With the
network down a stale cache answers with a note; with no cache the curated shelf still does.
`ROVECODE_MCP_REGISTRY=<base url>` points at another registry (tests inject `fetch` instead).

## `rovecode mcp`

```
rovecode mcp search [query]        curated rows first, then the registry's name matches
rovecode mcp info <name>           publisher, version, status, every launch form, the env names it asks for
rovecode mcp add <name> [--project] [--pick N] [--as <name>] [--yes] [--force] [--local | --no-local]
rovecode mcp remove <name> [--project]
rovecode mcp list                  every configured server with its scope (user · harvest · project), and for
                                   project files whether they are trusted
rovecode mcp show                  each project file, its trust, its servers (env NAMES only)
rovecode mcp trust [--yes]         approve this repo's .rovecode/mcp.json and .mcp.json as they are now
rovecode mcp untrust               withdraw that approval
```

`add` in order: (1) prints the **plan** — title, version, status, source, publisher, repo, the exact `runs …`
or `connects …` line, each env/header **name** and how it will be filled, what still `needs` a hand, the file and
the server name; (2) asks `install? [y/N]` — skipped by `--yes`; (3) asks each secret by name through the same
masked prompt as `rovecode auth set` (`readSecret`: raw mode, never echoed, never in argv), each plain
required value on a normal line, and each `needs` argument in the clear, under its own placeholder text
(`<directory the server may touch>: `); (4) writes. `rovecode market install <server>` asks the same questions in
the same order — the two CLI faces share one plan and one prompt sequence.

Without a terminal: no `--yes` → nothing written, exit 1. With `--yes` but a required secret for the **user**
file → nothing written (there is no way to ask); for a **project** file the secret is `${NAME}` anyway, so the
write succeeds and the closing line names the variables to export. A `needs` argument nobody could answer is
written as its placeholder and the closing line says so — `fill in before use: <directory the server may
touch> — edit the args in that file; until then this server is skipped` — only for what is *still* a placeholder,
never for a question you answered at the prompt. That line replaces "restart rovecode": a restart changes nothing
for an entry the loader skips. Both faces close the same way.

Secrets go **as values only into `~/.rovecode/mcp.json`** (mode 0600 where the OS honours it). A `--project` file
gets `${NAME}` — a token never lands in a repo. `--as` renames (a registry `io.github.acme/widgets` is `widgets`
by default), `--pick N` chooses among several launch forms (`info` numbers them), `--force` replaces.

### Install once instead of `npx` at every start (`--local`)

Most servers in the market are launched as `npx -y <package>`. Measured (Windows 11, node 24, npm 11, the memory
and filesystem servers, medians through the real client): a warm `npx` takes **1.8–2.1 s** from spawn to the
initialize handshake, the same package installed once and started with `node <its bin>` takes **0.35–0.47 s**.
The difference is npx itself — `npx --version` alone is 0.6 s, and every warm launch still asks the npm
registry to revalidate the package (0.3–1.3 s; no network means a timeout path). A cold cache is 7 s and a
47 MB download, repeated whenever upstream publishes, because `-y <package>` means "latest".

So, for an entry whose launch line is a plain `npx [flags] <package> [args]`, `add` **asks one thing before the
plan** on a terminal:

```
widgets-mcp@1.2.0 would start through npx: ~2 s at every start, re-resolving the package (and asking the npm registry) each time.
Install it once instead? npm puts the package's code under ~/.rovecode/mcp — typically 20–30 MB and a few seconds, one time;
it then starts in ~0.4 s and needs no network to start. No keeps the npx line exactly as it is today.
install widgets-mcp@1.2.0 once? [y/N]
```

"No" is today's behaviour, unchanged. "Yes" changes the **plan you then read**: `runs node ~/.rovecode/mcp/
node_modules/<package>/<its bin> …`, an `installs` row with the exact `npm install --prefix …` command and, in so
many words, that rovecode runs a package manager for you and puts the package's code on this machine, and a
`records` row. Installing code is a bigger act than writing a config line, and the plan says so. The approval
(`install? [y/N]`) is still the gate: npm runs **only after that yes** — a "no" leaves no folder, no file and no
record, whatever you answered to the offer. If npm fails, nothing is written and its last lines are shown.

`--local` answers the offer with yes and `--no-local` with no, so neither asks; `--yes` (a script) and no
terminal never ask and keep npx. `--local` on an entry that is not a plain npx package (docker, uvx, an http
remote) is an error, not a silent fallback. `--offline --local` is refused: installing once means fetching now.
**User scope only**: the launch line is this machine's absolute path under its `ROVECODE_HOME`, and a project
`mcp.json` is shared with every clone of the repo — so the offer is not made for `--project`, and an explicit
`--project --local` is refused with the way out (drop `--project`, or keep the npx line, which works everywhere).

What lands: one shared prefix `~/.rovecode/mcp/` (its own `package.json`, one `node_modules`, so several servers
share one copy of the SDK — two servers are ~30 MB where npx's cache keeps a copy of the SDK per server). The
launch line is `node` plus the bin's **absolute path as one argument** (never the `.cmd` shim: that means
`cmd.exe` and its quoting), so a home directory with a space in it works. `~/.rovecode/installed.json` records
`package: { name, version, prefix, bin, integrity, resolved }` — npm's integrity hash from the lockfile, i.e.
*what ran is on record*, which an `npx -y` line never gives you. When the lockfile cannot supply the hash the
record says so in a `missing` list and stderr says `record incomplete: …`, rather than the field being silently
absent. `rovecode market update` keeps an install-once server on `node` (npm runs again) and an npx one on npx;
it never asks the offer, because an update must not change how a server starts.

`rovecode mcp list` prints, under the rows, one line for servers that still start through npx — how many, which,
the cost, and the command to reinstall them once — and **rewrites nothing**: an npx entry keeps working for as
long as you keep it. The same offer is one more pick in the TUI's `/mcp` (`install once` / `run through npx at
every start — as today`), before the approval card, whose detail carries the same `installs` rows — and in the
sextant's `/market`, Enter on an npx row opens a **how to start it** card first (↑↓ choose, ⏎ show the plan,
esc back), then the plan card drawn for that answer; ⏎ on the plan card is still the only thing that installs,
and npm runs only then.

## `/mcp` in the TUI

`/mcp [query] [--project]` opens the **palette** (`Renderer.pickOne` — the same box, keys and fuzzy filter as ⌃k)
titled `mcp market · <query>` over the curated shelf plus the registry's matches; a server with several launch
forms gets one more pick (`<title> · how`); then the **approval card** (`Renderer.askApproval`) with the one line
that runs as the preview and the whole plan as the detail. Any yes writes; deny or Esc writes nothing.

The TUI has **no masked input, so it never asks for a secret**: every **required** asked value is written as
`${NAME}` — optional ones are left out of the written entry altogether (the file works without them; add one by
hand if you want it). The closing note lists only the names the file now refers to, to set before the restart —
or says to run `rovecode mcp add <name>` on a shell, where the prompt is masked. Nothing typed into the TUI's
prompt ever becomes a key. The CLI's closing line follows the same rule: it names what the written entry refers to.
The TUI cannot ask for a `needs` argument either: the placeholder is written and a warning note names it
(`mcp: fill in <directory the server may touch> in that file's args before use`); the server connects once the
line is edited.

Flags: each `rovecode mcp` subcommand accepts only its own (`add`: `--project --pick --as --yes --force --local --no-local`; `remove`,
`show`: `--project`; `trust`: `--yes --project`); any other `--flag`, a missing name, or an unknown subcommand is a
one-line usage error with exit 2, like the rest of the CLI.

## Trust: project files pass the same gate as project plugins

A repo's `.rovecode/mcp.json` and `.mcp.json` describe commands that would run on your machine. Since
Berkay's decision ("Kapı + kendi projelerimi otomatik güven") they load only once **you** have approved them
on this machine; until then they contribute **nothing** — no server, no `mcp_list`/`mcp_call` — and the launch
carries one warning per file:

```
mcp: /path/.rovecode/mcp.json: not trusted on this machine — its 2 MCP servers
stay off (they would run commands from this repo).
Review: rovecode mcp show · approve: rovecode mcp trust
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
- **Manual path**: `rovecode mcp show` prints each project file, its trust, and every server with the
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
