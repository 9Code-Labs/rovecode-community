# notes

A scratchpad that survives the session. Two in-process tools that write and read
`.rovecode/notes.md` in the workspace.

## What it does

**`notes_add {text, tag?}`** appends one dated line:

```
- 2026-09-05 [decision] the accent went two-tone because the single tone failed AA at normal size
```

- `text` is required, one sentence, at most 500 characters. Whitespace is collapsed.
- `tag` is optional, matches `[a-z0-9][a-z0-9-]{0,23}`, and is lowercased. It exists so `notes_list` can
  filter — `decision`, `gotcha`, `todo` are the ones that get used.
- The file is created with a `# notes` heading on first write.

**`notes_list {tag?, last?}`** reads them back, newest last. `last` defaults to 50 and is clamped to 500.
With no notes it says so rather than returning an empty block.

## Where the file lives, and why there

`<cwd>/.rovecode/notes.md` — with the repository, not with the plugin. The `tools` export is a factory
that receives the plugin context and closes over `cwd`, so two projects keep two separate notebooks and
neither follows you home. It is a plain markdown file: read it, edit it, commit it, or delete it.

## Permissions

The two tools declare different kinds, and that is the whole permission story:

- `notes_add` is `memory` — the same class as the built-in `todo_write`, allowed by default.
- `notes_list` is `read`.

So a policy that already says something about memory or reads covers this plugin too, without a special
case. Nothing here shells out or reaches the network.

## Install

```
rovecode market install plugin:notes
```

Or from a checkout of this repository:

```
rovecode plugin add ./plugins/notes
```

It ships an entry module, so rovecode imports it in-process — the approval preview says so before anything
is installed.
