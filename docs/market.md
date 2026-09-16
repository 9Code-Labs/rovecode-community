# The market: one command for MCP servers, skills and plugins

`rovecode market` is one door to three kinds of thing rovecode can install. They are genuinely different —
one launches a process, one is read by the model, one runs code inside rovecode — so the market never
pretends they are the same. It gives them one place to be found, one way to be described, and one order of
events when something is installed.

```
rovecode market search [query] [--kind mcp|skill|plugin]
rovecode market info <id>
rovecode market docs <id>
rovecode market install <id | kind:id | git-url | npm-package> [--project] [--as name] [--pick N]
                        [--ref <branch|tag|commit>] [--yes] [--force] [--local | --no-local]
rovecode market remove <id | kind:id>
rovecode market list [--all] [--kind mcp|skill|plugin]
rovecode market update [id] [--all] [--yes] [--yes-plugins]
rovecode market sources [probe]
rovecode market verify [id]
rovecode market validate <path|url> [--kind skill|plugin]
```

Every command takes `--json` (a script and the TUI read exactly what the terminal shows) and `--offline`
(no network at all). `rovecode mcp …` still works and is not deprecated: it is the MCP-only door into the
same code.

## The three kinds, and what installing one means

| the three kinds | MCP server | skill | plugin |
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

For an MCP server that would start through `npx`, a terminal is asked one thing *before* step 2 — install the
package once (`node`, ~0.4 s per start) or keep the npx line (as today, ~2 s per start)? — and the plan in
step 3 is the one that runs. `--local` / `--no-local` answer it up front; `--yes`, `--json` and no terminal keep
npx without asking. The approval in step 4 is still the gate: npm runs only after it. The whole trade, the
numbers behind it and what goes on record are in [mcp-market.md](mcp-market.md#install-once-instead-of-npx-at-every-start---local).

`--dry-run` stops after step 3 and **exits 0**. That is the difference from just leaving `--yes` off: no
TTY and no `--yes` also shows you the plan, but exits 1, because it is reporting a refusal — correct as a
refusal, useless as a question. A script that wants to know what would happen should not have to read an
error code to find out. `--dry-run` overrides `--yes` rather than arguing with it: between "show me" and
"go ahead", the one that writes nothing wins.

It does **not** fetch. A git-sourced skill is not cloned, so what you see is the plan and its target, never
the repository's contents — and the last line says which of the two you got:

```
nothing written — --dry-run. The source was not fetched, so this is the plan, not its contents.
nothing written — --dry-run. This is the whole plan.
```

With `--json` the plan comes back as one object carrying `dryRun: true` and no `ok` field, so a caller
checking `ok` can never mistake a plan for a write.

Secrets are asked by name through the masked prompt: never echoed, never passed on the command line, never
written into a project file. In a project scope a secret is written as `${NAME}` and read from your
environment when the server launches, so the file can be committed.

Every `--json` output is **one document**, on every subcommand and every exit code. The human preview is
not printed above it — the same lines are inside the object, as `preview` — and a failure is a document
too, so a script that names a missing id gets something it can read rather than an empty stdout and a
number. Prose may still go to stderr; stderr is not the document. A usage error (an unknown command, a flag
the subcommand does not take) is `{ok: false, error, usage}` with exit 2, and `update --all --json` is one
object — `results` holds each item's outcome, `skipped` the plugins `--yes` set aside — however many items
it touched, including none.

`--json` also **never prompts**, terminal or not. The line that would let a person answer "install this?"
or "remove this?" is inside the object rather than on the screen, so asking would mean asking someone to
approve something they were not shown. Instead you get the plan with `needsApproval: true` and exit 1 —
rerun with `--yes`, or `--dry-run` if reading it was the point.

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

A generator that fetches has to tell "there is nothing here" apart from "I could not look", and the skill
one does: only a 404 — an answer — may shrink the catalog, while a network error or a rate limit fails the
run and leaves the file in the tree untouched. That distinction is not theoretical. GitHub allows an
anonymous client 60 requests an hour and a build makes about 40, so being cut off half way is ordinary; the
naive version would quietly write a 4-skill file over a 19-skill one and the diff would look deliberate. Two
more rules follow from the same idea: a catalog that would **shrink** is refused with the disappearing ids
named, and `--allow-shrink` is the only way to say "yes, they really are gone"; and the write is atomic
(temp file, then rename), so a half-written catalog cannot exist. A 404 on a `LICENSE.txt` is an answer, so
that skill stays on the shelf with its licence recorded as unknown. Setting `GITHUB_TOKEN` only raises the
rate limit — every URL fetched is public — and a wrong token reads as "could not look", which refuses rather
than prunes.

The two `--check`s run in different places on purpose. The plugin one is deterministic and local, so it runs
in CI on every push and a red build really means a broken commit. The skill one goes to the network, so it
runs on a weekly cron and by hand instead: hanging pull requests off a check that can fail for reasons with
nothing to do with the change would only teach people to ignore a red mark.

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

## Each item's own documentation

`rovecode market docs <id>` prints what the publisher wrote about the item, and `market info` says whether
there is any:

```
docs       82.5 KB from https://raw.githubusercontent.com/anthropics/skills/main/skills/claude-api/SKILL.md (truncated) — rovecode market docs skill:claude-api
docs       none — try https://github.com/modelcontextprotocol/servers
```

The documentation is fetched **at build time and carried inside the catalog**, not fetched when you look at
it. Three reasons, in order of how much they matter: the market has to work offline, the site's market page
is a static build with no server to proxy through, and pulling third-party text into a UI at display time is
a thing worth not doing when the alternative costs nothing. The body travels as text and only as text —
rovecode never executes it, never evaluates it, never parses it as HTML; each surface renders it safely on
its own side.

An item with no documentation is a normal item. Upstream may simply not have a readable doc, and a shelf
entry whose README has moved is still perfectly installable — so a **broken** docs block drops the
documentation and keeps the row, with a note saying which item and why. The same three rules the rest of the
catalog lives by apply here: `source` must be an `http(s)` URL, `format` must be `markdown`, and an empty
body is treated as no documentation at all.

Bodies are capped at 24 KB, which is its own limit and not the 300-character one every other string uses —
run a document through the general validator and it comes back silently cut to a label, still a valid
string, with nobody the wiser. `bytes` is the size **upstream, before truncation**, so a reader can be told
how much is missing; when it is absent or junk it is replaced by the size of what we actually carry rather
than trusted. Two of the current skills are cut this way — `claude-api` and `skill-creator`, the 82.5 KB and
31.5 KB above — and both say so.

Search does not carry bodies. `market search` and `market list` read the metadata — the size, the source,
whether it was truncated — but leave the ~200 KB of markdown alone, since no search ever reads it; asking
for one item with `market info`, `market docs` or an install brings the body with it. In the data that means
`docs.body` is `undefined` on a search result, which is deliberately not the same as an empty string: a
surface must send the reader to the document rather than tell them there is nothing in it.

MCP documentation arrives as a **sidecar**, `src/market/catalogs/mcp-docs.json`, keyed by the curated
entry's name. The curated shelf itself (`src/mcp/market-catalog.ts`) stays hand-written, because a
publisher, a launch command and an environment variable are human decisions, while a README is generated
data — mixing the two in one file would make the hand-written half look machine-owned. A missing sidecar
means MCP rows have no documentation, which is not an error.

## Installed, updates, trust

`market list` shows what is installed here; `--all` shows the whole market with badges; `--kind mcp|skill|plugin`
narrows either view to one kind. A flag a subcommand does not read is refused (exit 2), not ignored — `list
--kind mcp` once returned a skill row without a word.

`market update` with no argument lists what is out of date and writes nothing. Comparison is a string
difference, not a semver judgement, so both numbers are printed and you decide. An item nobody can compare —
a skill whose `SKILL.md` states no version, which is most of them — is **not silently skipped**: it is listed
saying why it cannot be compared and that updating reinstalls it. Then `market update <id>` or
`market update --all` runs the same four steps an install does: plan, show, approve, write. An update never
becomes a quieter install; it goes through the identical preview and the identical yes, and it reinstalls in
the scope the item already lives in rather than the flag's default. Installing over something by hand still
needs `--force`.

`--all --yes` deliberately **skips plugins**. A plugin is code rovecode loads and runs, and "yes to
everything out of date" is not consent to run a new version of somebody's code — so an unattended update
leaves plugins alone and says which ones it left. Naming one (`market update notes --yes`) updates it, and
`--yes-plugins` says the quiet part out loud for all of them. The flag exists so that the safe default does
not become an obstacle you route around by scripting `--force`.

`market list` says where each installed thing came from, on the line beneath it:

```
  skill:pdf              installed
         from anthropics/skills@main a1b2c3d, 2026-09-05
```

That record lives beside the disk rather than instead of it (`src/market/manifest.ts`): whether something
is installed is decided by looking for the folder, so a skill deleted by hand stops being installed
immediately. The record only carries what the disk cannot know — which row, which source, which commit it
resolved to. A missing record is not an error; the origin reads as unknown.

`market verify [id]` re-hashes what is on disk and reports what has changed since it was installed
(`src/market/digest.ts`). A digest detects drift; it does not prove provenance, and nothing in this space
signs anything, so the wording says the first and never the second.

Project scope (`--project`) is the trusted scope: an MCP file or a plugin folder installed this way records
that exact content as approved on this machine, because you just read the plan and said yes. Edit the file
afterwards and the gate asks again (`rovecode mcp trust`). A project row that is installed but unapproved
is shown as `[installed · NOT approved on this machine]`, which is the honest state — it is on disk and it
is not loading.

## When the publisher has stopped

An item whose upstream repository is archived on GitHub carries `status: "archived"`, and every place that
shows the item says so — a `[archived]` badge in `search` and `list`, the first line of the install preview,
and a `status` field in `--json`:

```
  !  archived on GitHub — the publisher has stopped maintaining it. It still installs; nothing here is blocked.
```

Three deliberate choices in that one line.

It is **first**, above `requires` and `context`. Those rows describe what an install costs, and someone
reading them has already decided they want the thing; "the publisher stopped maintaining this" is a reason
not to want it, so it belongs above the decision rather than inside it.

It **does not block**. An archived skill is a working skill, plenty of people install one deliberately, and
a market that refuses is a market people route around. The word "warning" is meant literally.

The wording is **the flag's own**. GitHub says `archived`, so the line says "archived on GitHub". It does
not say "abandoned" — that is a judgement about someone else's work which nobody upstream made and which
rovecode is in no position to make on their behalf.

The value is **derived, never typed**: the generator reads `archived` from the GitHub repository, one
request per source. A status written by hand is correct the day it is written and wrong every day after,
and `--check` could not tell you which. If a catalog row ever carries a status the generator cannot produce,
that is a hand edit, and a test says so.

## Maintaining the catalogs

Everything in `src/market/catalogs/` is generated. Nothing there should ever be hand-edited — `--check`
compares byte for byte, so an edit shows up as a failing build rather than as a surprise months later.

| generator | reads | network | writes |
|---|---|---|---|
| `scripts/build-skill-catalog.mjs` | `anthropics/skills` — the tree, each `SKILL.md`, each `LICENSE.txt`, the publisher's `marketplace.json` | yes, ~40 requests | `skills.json` |
| `scripts/build-plugin-catalog.mjs` | `plugins/*/plugin.json` and `plugins/*/README.md` **in this checkout** | no | `plugins.json` |
| `scripts/build-mcp-docs.mjs` | the keys in `src/mcp/market-catalog.ts`, then each entry's README upstream | yes, ~25 requests | `mcp-docs.json` |

```
bun scripts/build-skill-catalog.mjs          # regenerate
bun scripts/build-skill-catalog.mjs --check  # exit 1 if it would change (what CI runs)
```

`build-mcp-docs.mjs` reads the curated shelf by **parsing** it, not importing it: `market-catalog.ts` pulls
types from the rest of the tree, and a build script that had to typecheck the application to read sixteen
strings would be the wrong shape. It never writes to that file — the shelf stays a human document.

### Where each kind's documentation comes from

Skills carry their `SKILL.md` body, which the generator already has in hand for the frontmatter, so
documentation costs the skill build no extra requests. Plugins carry `plugins/<name>/README.md` from this
repository, and a plugin without one honestly has no documentation — the manifest's one-line description is
already the row's description, and repeating it under a "documentation" heading would dress an empty shelf
up as a full one. MCP entries carry their upstream README, located through the repository's own tree rather
than by assuming a folder name (our key is `sequential-thinking`; the folder upstream is
`sequentialthinking`). One curated entry, `deepwiki`, has no repository at all — only a homepage — so it has
no documentation, and that is the correct answer rather than a gap to fill.

### The four refusals

A generator would rather write nothing than write something diminished. Each refusal leaves the shipped file
exactly as it is, because a catalog that is a day stale is a small problem and one that has quietly lost
half its shelf is not.

1. **Produced nothing at all.**
2. **Fewer rows than ship today** — the vanishing ids are named.
3. **A row that has documentation today would come back without it** — the ids are named. This one is worth
   understanding: the row count does not move, every entry is still present, and the file is structurally
   perfect. Rule 2 would wave it through, and one rate-limited run would empty every document in the market.
4. **Could not reach the source at all** — the run fails before any of the above is even asked.

Behind all four is one distinction: a source that **answers** is not the same as a source we **could not
reach**. A 404 is an answer and may shrink the catalog. A network error, a 403, a 5xx or a rejected token
means we do not know what is upstream, and not knowing is never grounds for deleting anything.

`--allow-shrink` overrides rules 2 and 3, and nothing else — **not rule 1**, because a run that produced
nothing is a broken run rather than a shelf that emptied, and the flag exists to say "yes, that id really
went", not "write whatever you have over a good catalog". It is legitimate exactly when you have opened the
upstream repository in a browser and confirmed the loss is real: a skill was withdrawn, a README was
deleted. It is not a way to get a red build to go green.

### GITHUB_TOKEN

What it is and why a bad one can never prune the catalog is above, under *Where the catalogs come from*.
The operational part: you will rarely want one locally, and CI always sets it, because a runner's IP is
shared with the whole internet and 40 requests against a 60-per-hour anonymous budget is choosing a flaky
job. The workflow grants it `contents: read` and nothing else.

### Which check runs where, and why they are split

| job | when | red means |
|---|---|---|
| `ci.yml` — `build-plugin-catalog.mjs --check` | every push | a broken commit: a manifest or README changed without regenerating |
| `ci.yml` — the docs cleaner's shape fuzzing (fixed seed, 200 rounds, inside `bun test`) | every push | a regression this commit introduced |
| `catalogs.yml` — `build-skill-catalog.mjs --check`, `build-mcp-docs.mjs --check` | weekly + on demand | go look: upstream moved, or the run could not reach it |
| `catalogs.yml` — the same fuzzing with a **fresh seed and 40 000 rounds** | weekly | a shape we had never generated broke it: go look |

**None of the scheduled half has ever run.** Actions billing is off for this repository, so `catalogs.yml`
has never executed a single time — the table above describes what is committed and ready, not something
that has been happening weekly in the background. Read it as a design, and do not read a green repository
as evidence that upstream still matches: until billing is on, the only thing that has actually checked
these catalogs is someone running `--check` by hand. `docs/deploy.md` says the same about `site.yml`, and
for the same reason.

The split is the whole point, and it is the same judgement twice. A check that reaches the network can go
red for reasons that have nothing to do with the commit in front of it; hanging pull requests off one only
teaches people that a red mark is noise. So the deterministic, local checks guard the gate, and the ones
that can fail for outside reasons run on a schedule where a red result is an invitation to look rather than
an accusation.

The fuzzing follows the same rule. On every push it runs with a fixed seed — a net that fails for the commit
that broke it and for nothing else. Weekly it runs as a search: a new seed each time, so it explores shapes
it has never tried. Both knobs are environment variables, and any failure prints the seed:

```
ROVECODE_FUZZ_SEED=12345 ROVECODE_FUZZ_ROUNDS=40000 bun test ./test/unit/market-docs.test.ts
```

A randomised test's one real cost is that a failure can be hard to reproduce; printing the seed pays it.

### When you see red

Read the message before doing anything — these cases want different responses, and one of them has no
override at all.

| the message says | what happened | what to do |
|---|---|---|
| `cannot reach the source` / `HTTP 403 (rate limited?)` / `HTTP 5xx` | we could not look. Nothing was written. | Re-run the job. If it keeps failing, check whether the host is up before touching anything. |
| `catalog is out of date` / `sidecar is out of date` | upstream really changed. | Regenerate, read the diff, commit it: `bun scripts/build-skill-catalog.mjs` |
| `refusing to write … missing: <id>` / `… lost docs: <id>` | this run would remove something that ships today. | Open the named item upstream and confirm. If it is genuinely gone, re-run with `--allow-shrink`. If it is still there, this was a bad fetch — run it again. |
| `refusing to write … produced no items at all` | the run came back empty. | Nothing to confirm and **no `--allow-shrink` for this one** — an empty result is a broken run, never a shelf that legitimately emptied. Check the network and the source, then run it again. |
| `HTTP 401 (GITHUB_TOKEN rejected…)` | the token is wrong or expired. | Fix or unset it; unset falls back to anonymous, which works at a lower rate limit. |

Nothing in this table needs a hurry. Every one of these outcomes leaves the catalogs that ship exactly as
they were.

### Adding a source

For a skill repository, add it to `SOURCES` in `build-skill-catalog.mjs` — the publisher must be nameable
and the layout must be the standard `<root>/<name>/SKILL.md`. For a plugin, add its git URL and subfolder to
`SOURCES` in `build-plugin-catalog.mjs`; the manifest it publishes fills the row, and an unreadable manifest
drops the entry with a warning rather than guessing. In both cases run the generator, read the diff, and
commit the catalog with the change — a catalog and its generator should never be committed apart.

## Files

- `src/market/types.ts` — the item, the plan, the result unions, the caps. No I/O, so importing it is free.
- `src/market/registry.ts` — every source merged and re-typed; `searchMarket`, `findItem`, `allItems`.
- `src/market/resolve.ts` — one argument → one item, or the candidates.
- `src/market/install.ts` — `planInstall` (writes nothing) and `runInstall` (the only writer); delegates to
  `src/mcp/market-install.ts` and `src/plugins/install.ts`, and writes skills itself.
- `src/market/prereq.ts` — is the program a launch line names on PATH? Lookup only: never runs it, never
  reads a version, never blocks the install.
- `src/market/context-cost.ts` — what an item adds to the prompt: the index line every turn, the body only
  if the model opens it. Scaled by the measured factor in `src/core/token-scale.ts`.
- `src/market/manifest.ts` — where an installed thing came from, recorded beside the disk, with clone URLs
  scrubbed of any credential before they are written.
- `src/market/digest.ts` — what landed on disk as one number, so `verify` can answer "has this changed?"
- `src/market/clone.ts` — cloning at a `--ref`: a branch or tag clones directly, a bare commit needs
  `init` + `fetch` + `checkout`, and which one it is is never guessed from the string's shape.
- `src/market/validate.ts` — the checker behind `market validate`, and the rule that it may never call a
  row valid that `registry.ts` would drop.
- `src/market/catalogs/` — the generated data: `skills.json`, `plugins.json`, and the `mcp-docs.json`
  sidecar. Read at search time, not imported, so their size does not reach startup.
- `scripts/build-skill-catalog.mjs`, `scripts/build-plugin-catalog.mjs`, `scripts/build-mcp-docs.mjs` —
  the three generators. Each takes `--check`; see Maintaining the catalogs above.
- `scripts/lib/docs.mjs` — the one copy of the documentation cleaning pass all three generators share:
  HTML stripped, links absolutised, titles re-emitted canonically, bodies capped on a line boundary.
- `test/unit/market-docs.test.ts` — that cleaning pass, written from the attacker's side, plus the shape
  fuzzing (`ROVECODE_FUZZ_SEED`, `ROVECODE_FUZZ_ROUNDS`).
- `test/unit/market-prereq.test.ts` — the PATH lookup with PATH, PATHEXT and the platform all injected, so
  it says nothing about the machine it runs on.
- `src/cli/market-cmd.ts` — the shell face; `src/cli/main.ts` wires `case "market"` with a lazy import, so
  none of this is loaded unless you type it.
- `test/unit/market.test.ts` — the caps, the escapes, the ambiguity, the plan-before-write rule, offline.
