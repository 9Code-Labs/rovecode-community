# The market: one command for MCP servers, skills and plugins

`rovecode market` is one door to three kinds of thing rovecode can install. They are genuinely different —
one launches a process, one is read by the model, one runs code inside rovecode — so the market never
pretends they are the same. It gives them one place to be found, one way to be described, and one order of
events when something is installed.

```
rovecode market search [query] [--kind mcp|skill|plugin]
rovecode market info <id>
rovecode market install <id | kind:id | git-url | npm-package> [--project] [--as name] [--pick N] [--yes] [--force]
rovecode market remove <id | kind:id>
rovecode market list [--all]
rovecode market update [id] [--all] [--yes]
rovecode market sources
```

Every command takes `--json` (a script and the TUI read exactly what the terminal shows) and `--offline`
(no network at all). `rovecode mcp …` still works and is not deprecated: it is the MCP-only door into the
same code.

## The three kinds, and what installing one means

| | MCP server | skill | plugin |
|---|---|---|---|
| what it is | a process rovecode launches; the model gets its tools | a `SKILL.md` the model reads | a folder of code rovecode loads and **runs** |
| installing writes | an entry in `mcp.json` | files under `skills/<id>/` | a folder under `plugins/<id>/` |
| runs anything on install? | no (it launches at the next start) | **no — files only** | no, but its code runs at every start afterwards |
| trust gate | yes, on project files | none needed — a skill is text | yes, on project installs |
| where it comes from | curated shelf + the MCP registry | rovecode's skill catalog, or a git repo | rovecode's plugin catalog, a git repo, or a folder |

The risk is not equal, so the preview does not read the same. A skill preview says *files only, nothing is
executed*. A plugin preview says *a folder of CODE that rovecode loads and RUNS in this process* and names
the publisher. That difference is the point of showing a plan at all.

## One command, and what it does before it writes

Installing is always four steps in this order, and none can be skipped:

1. **Resolve** — turn what you typed into exactly one item (below).
2. **Plan** — build the whole change without touching the disk.
3. **Show** — print the plan: the exact command or clone URL, the publisher, the source, the target file or
   folder, the variables it will ask for, and what it replaces if anything.
4. **Ask, then write** — `y/N` on a terminal, `--yes` in a script. Without a TTY and without `--yes`
   nothing is written; you still see the plan, which makes `rovecode market install x` safe to run just to
   read what it would do.

Secrets are asked by name through the masked prompt: never echoed, never passed on the command line, never
written into a project file. In a project scope a secret is written as `${NAME}` and read from your
environment when the server launches, so the file can be committed.

## What you can name

```
filesystem                     a bare id — looked up in every kind
mcp:filesystem                 qualified, when two kinds share a name
https://example.com/thing.git  a git repo → a plugin (say skill:<url> for a skill repo)
@modelcontextprotocol/server-x an npm package → an MCP server launched with npx
./some/folder                  a local folder → a plugin
```

An id is a plain slug **inside its kind** (`filesystem`, `code-review`). If a name exists in two kinds,
rovecode does not guess: it prints both and exits 2, and you say which. A name a catalog owns is never
re-read as a package of the same name. A name that matches nothing prints the near misses rather than a
bare "not found".

## Where the rows come from, and what happens offline

Four sources, merged into one list:

| source | lives | needs network |
|---|---|---|
| `mcp:curated` | `src/mcp/market-catalog.ts`, built into rovecode | no |
| `mcp:registry` | registry.modelcontextprotocol.io | yes (cached a day) |
| `skills` | `src/market/catalogs/skills.json` (generated) | no |
| `plugins` | `src/market/catalogs/plugins.json` (generated) | no |

Three of the four are files, so `market search` answers on a plane. Only the MCP registry needs the
network, and it is cached by `src/mcp/market.ts` under `~/.rovecode/cache/mcp-market.json` with a TTL —
the market adds no second cache, because two caches over the same data eventually disagree with each other.

`rovecode market sources` says, right now, which source answered and how:

```
skills         built in / on disk
plugins        built in / on disk
mcp:curated    built in / on disk
mcp:registry   not consulted — a search term of two characters or more asks the registry
```

A source that fails does not fail the command: it contributes no rows, says why, and the other three still
answer. `--json` carries the same per-source status, so a UI can draw "empty", "offline" and "the registry
is down" as three different states instead of one blank box.

## Untrusted data

Everything a catalog says is treated as untrusted input, including the JSON files in this repository —
they arrive through a `git pull` like any other file. Every field is re-typed on the way in: strings are
capped (300 chars, 500 for a description), lists are capped (32 tags, 24 variables, 200 items per source),
a body over 2 MB is refused. A row that cannot be made valid is skipped with a note naming it; one bad row
never blanks a catalog.

Two things are refused outright rather than trimmed: a skill file whose path is absolute or climbs out of
its own folder, and a plugin source that is not a real URL. Nothing read from a catalog is ever executed
while it is being read.

## Where the catalogs come from

The two catalog files are **generated, never hand-written**, because a shelf of other people's work is only
honest if every entry can be re-checked. `node scripts/build-skill-catalog.mjs` enumerates `skills/*/SKILL.md`
in the upstream repository (today: `github.com/anthropics/skills`, `main`), reads each file with rovecode's
own frontmatter parser — the same one `src/skills/index.ts` uses — and takes the name, description and
version from the skill itself. A skill without a version gets no version field (all 19 currently lack one);
a licence comes from the `LICENSE.txt` beside it, or is recorded as unknown. Tags are the publisher's own
grouping, read from the repository's `.claude-plugin/marketplace.json`, so no category is invented here: 12
skills are tagged `example-skills`, 4 `document-skills`, and 3 carry no tag because their group name is just
their own name. `--check` re-generates the file and compares it to the one on disk **byte for byte**, exiting
1 on any difference — which catches both a stale catalog and a hand-edited one, and makes it usable in CI.
The plugin catalog has its own generator (`build-plugin-catalog.mjs`) that never touches the network: it
reads `plugins/*/plugin.json` from this checkout, takes the licence from `package.json`, and derives what
each plugin contributes from its manifest rather than guessing.

The plugin catalog holds three entries, and that is the honest number rather than a small one. rovecode's
plugin format is new: a plugin is a folder with `plugin.json` **at its root** carrying `api: 1`, and its
`entry` is an in-process module contract (`export default { api: 1, tools?, hooks? }`). Claude Code's
plugins look close enough to be tempting and are not compatible: their manifest lives at
`.claude-plugin/plugin.json` and carries no `api` field, so rovecode's manifest reader rejects one outright —
feeding a real installed example to `parseManifest` returns null with `plugin API version missing is not
supported (this rovecode speaks 1) — skipped`. Even with the manifest moved and the field added, their
contributions are declared by directory convention rather than an exported module, so nothing would bind.
Listing them would be claiming a compatibility that does not exist, so the catalog lists what actually
installs and runs.

## Installed, updates, trust

`market list` shows what is installed here; `--all` shows the whole market with badges.

`market update` with no argument lists what is out of date and writes nothing. Comparison is a string
difference, not a semver judgement, so both numbers are printed and you decide. An item nobody can compare —
a skill whose `SKILL.md` states no version, which is most of them — is **not silently skipped**: it is listed
saying why it cannot be compared and that updating reinstalls it. Then `market update <id>` or
`market update --all` runs the same four steps an install does: plan, show, approve, write. An update never
becomes a quieter install; it goes through the identical preview and the identical yes, and it reinstalls in
the scope the item already lives in rather than the flag's default. Installing over something by hand still
needs `--force`.

Project scope (`--project`) is the trusted scope: an MCP file or a plugin folder installed this way records
that exact content as approved on this machine, because you just read the plan and said yes. Edit the file
afterwards and the gate asks again (`rovecode mcp trust`). A project row that is installed but unapproved
is shown as `[installed · NOT approved on this machine]`, which is the honest state — it is on disk and it
is not loading.

## Files

- `src/market/types.ts` — the item, the plan, the result unions, the caps. No I/O, so importing it is free.
- `src/market/registry.ts` — every source merged and re-typed; `searchMarket`, `findItem`, `allItems`.
- `src/market/resolve.ts` — one argument → one item, or the candidates.
- `src/market/install.ts` — `planInstall` (writes nothing) and `runInstall` (the only writer); delegates to
  `src/mcp/market-install.ts` and `src/plugins/install.ts`, and writes skills itself.
- `src/cli/market-cmd.ts` — the shell face; `src/cli/main.ts` wires `case "market"` with a lazy import, so
  none of this is loaded unless you type it.
- `test/unit/market.test.ts` — the caps, the escapes, the ambiguity, the plan-before-write rule, offline.
