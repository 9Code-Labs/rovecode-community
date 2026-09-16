# Plugins

A plugin is a **folder with a `plugin.json`**. It bundles the ways rovecode can already be extended —
an in-process module of tools and hooks, custom `/commands`, skills, MCP servers — so one
`rovecode plugin add` installs all of it, `rovecode plugin list` shows all of it, and a repository can
ship its own under `.rovecode/plugins/`. The plugin is the *package*; there is no new API surface.
Every contribution lands on a seam that exists already and is governed the same way:

| contribution | manifest field | lands on | governed by |
|---|---|---|---|
| tools (in-process) | `entry` → `tools` | `ToolRegistry` | the same permission rules as built-ins: `kind` → action, deny-default, `/yolo` semantics; a plugin tool cannot shadow a built-in |
| hooks | `entry` → `hooks` | `HookRunner.add()` | timeout-bounded, isolated; can only deny, never un-deny (core/hooks.ts) |
| commands | `commands` | `tui/commands.ts` loader | same `*.md` format as `.rovecode/commands`; built-in names win |
| skills | `skills` | `skills/index.ts` store | same `SKILL.md` format; project scope wins on a name clash |
| MCP servers | `mcp` | `loadMcpConfig` | same entry shape as `.rovecode/mcp.json`; lazy connect. On a name clash the first plugin to declare it wins, and an `mcp.json` entry of that name overrides the plugin's — both are warned |

## Layout

```
my-plugin/
  plugin.json          required
  index.ts             entry (optional) — export default { api: 1, tools?, hooks? }
  commands/*.md        custom commands (optional)
  skills/**/SKILL.md   skills (optional)
```

`plugin.json`:

```json
{
  "api": 1,
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "one line, ≤ 200 chars",
  "entry": "index.ts",
  "commands": "commands",
  "skills": "skills",
  "mcp": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } }
}
```

- `api` is a hard gate: anything but `1` skips the plugin with a warning naming the version (the
  hooks.ts rule). `name` is `[a-z0-9-]`, ≤ 64, must start alphanumeric, and is the plugin's identity —
  it should equal the folder name. A non-empty `version` (trimmed, capped at 40 chars) is a hard
  requirement too: a manifest missing either is `broken` and contributes nothing, the same class of
  failure as a wrong `api`. Paths are relative and may not leave the folder.
- Unknown fields are warned about and ignored; a bad `skills` path costs the skills, not the plugin.

The entry module:

```ts
export default {
  api: 1,
  // an array, or a factory that gets { cwd, home, pluginDir }
  tools: (ctx) => [{
    // permission class: read | write | execute | spawn | memory | network | custom
    kind: "read",
    schema: { name: "my_tool", description: "…", args: { type: "object", properties: {} } },
    async execute(args, toolCtx) { return { ok: true, output: "…" }; },
  }],
  hooks: {
    pre_tool(ctx, call) { if (/* … */) return { deny: "why" }; },
    post_tool(ctx, call, result) { return { output: result.output + "\n…" }; },
  },
};
```

A plugin must not import rovecode's source by relative path — it runs from `~/.rovecode/plugins` too.
Mirror the shapes (they are small); `api` versions them.

## Scopes, trust, and the kill switch

- **User** — `~/.rovecode/plugins/<name>/` (`ROVECODE_HOME` aware). Installed by you, trusted by that
  act.
- **Project** — `<cwd>/.rovecode/plugins/<name>/`. A checkout is data from the network, so a project
  plugin is **listed but never run** until you approve it on this machine:
  `rovecode plugin show <name>` lists every file without importing anything;
  `rovecode plugin trust <name>` records the folder's content digest in `~/.rovecode/plugins.json`.
  Any later change to any file in it (a `git pull`) puts it back to `untrusted` and asks again. The
  record lives in your home, never in the repository — a repo cannot trust itself.
  `rovecode plugin add <folder> --project` installs *and* trusts, because you ran it.
- **The same name in both scopes**: the *project* copy shadows the user copy (the commands loader's
  rule), and discovery warns `plugin "<name>" shadows <user dir> (project over user)`. The user copy
  does not load.
- `rovecode plugin disable <name>` / `enable` switch a plugin off/on in every scope.
- `ROVECODE_NO_PLUGINS=1` skips discovery entirely (the `ROVECODE_NO_HOOKS` idiom).
- Plugins are read **once per process**, like hooks: restart rovecode after `add`, `trust`, `enable`.

Statuses in `plugin list`: `active` · `disabled` · `untrusted` · `broken` (the manifest failed; the
problems are listed under `plugin show`).

## The CLI

```
rovecode plugin list
rovecode plugin add <folder|git-url> [--project] [--force]     # git: shallow clone, validated before it lands
rovecode plugin remove <name> [--project]
rovecode plugin enable|disable <name>
rovecode plugin trust|untrust <name>
rovecode plugin show <name>
```

Aliases: `ls` = `list` (also what bare `rovecode plugin` does), `rm` = `remove`, `info` = `show`;
`rovecode plugin help` prints the usage. A usage error exits 2, a failed operation exits 1.

`add` copies the folder **without** `node_modules` and `.git` — a plugin's entry module has to run on
rovecode's own runtime with no installed dependencies of its own. One that works from its source folder
and then fails with `Cannot find module` after `plugin add` is hitting this.

Loader warnings are echoed at boot the way hook warnings are (`plugins: <warning>`), followed by one summary
line whenever at least one plugin was found — `summarizePlugins()` in `src/plugins/index.ts`, e.g.
`plugins: 2 active (safety-net, notes) · 1 untrusted (acme)` — on stderr for `rovecode run` and as a system note
in the TUI, so what loaded and what stayed off is visible without `rovecode plugin list`.

## Failure model

Nothing in a plugin can stop rovecode from starting. A missing entry, a module that throws, a module
that hangs past `ROVECODE_PLUGIN_TIMEOUT_MS` (default 5000) or a `tools()` factory that does — each
costs one warning and that plugin's code contributions; its commands and skills still load; the
other plugins are untouched. A tool with a bad name, kind, schema or no `execute` is dropped by
name. An unknown hook name is dropped by name.

## First-party plugins (`plugins/` in this repo)

- **safety-net** — `pre_tool` refuses `rm -rf`, force push, `reset --hard`, `git clean -f`,
  `chmod 777`, `curl | sh`, `DROP TABLE` from the agent (you can still run them yourself);
  `post_tool` appends one sentence under a `FAIL` line so the model does not mark a red step done.
  Hooks only.
- **notes** — `notes_add` (kind memory) appends a dated line to `<cwd>/.rovecode/notes.md`,
  `notes_list` (kind read) reads it back by tag or count. Tools only, via the factory.
- **conventional-commits** — `/commit` writes a Conventional Commits message for the staged diff
  (never commits); the skill teaches the format. Declarative only: no code.

Install one: `rovecode plugin add ./plugins/safety-net`.

Source: `src/plugins/` — `manifest.ts` (parse) · `state.ts` (plugins.json, digests) · `discover.ts`
(roots → status, no code run) · `load.ts` (import + validate) · `install.ts` (the verbs) · `cli.ts`.
Tests: `test/unit/plugins*.test.ts`.
