# conventional-commits

`/commit` writes a Conventional Commits message for the staged diff. The bundled skill teaches the format
so the model gets it right without the command having to re-explain it every time.

This is the **files-only** plugin: no entry module, nothing is imported, nothing runs in-process. It
contributes a command and a skill, both plain markdown.

## What it contributes

**`commands/commit.md` → the `/commit` command.** It reads what is staged (`git diff --cached --stat`,
then the diff itself), writes one message, and prints it in a fenced block.

Three things it does on purpose:

- **It does not stage anything.** Nothing staged means it says so and stops.
- **It does not commit.** It prints the message; you commit. That is stated twice in the command for a
  reason — a commit is a decision, and the point of the command is the wording, not the act.
- **It describes the change, not the files.** "teach the run panel to budget the command", not
  "update draw-code.ts".

`$ARGUMENTS` is an optional scope or hint: `/commit tui` or `/commit this is the retry fix`.

**`skills/conventional-commits/SKILL.md` → the format itself.** Types and which one a given change really
is (a behaviour change nobody reported is not a `fix`), one scope or none, the imperative subject at ≤72
characters, what a body earns its place by saying, and the footer forms that tools read.

## Install

```
rovecode market install plugin:conventional-commits
```

Or from a checkout of this repository:

```
rovecode plugin add ./plugins/conventional-commits
```

## Adapting it to your project

The scope list is the part that is project-specific. It currently names rovecode's own layout — the folder
under `src/`, or a surface (`tui`, `cli`, `server`). Edit that line in both `commands/commit.md` and the
skill to match your tree; everything else is the general format and transfers as it is.
