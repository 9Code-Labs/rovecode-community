---
name: conventional-commits
description: Conventional Commits: types, one scope, imperative subject
---
# Conventional Commits, the working version

A commit message has three parts and a reader for each: the **subject** is for `git log --oneline`
and the changelog, the **body** is for the person doing archaeology in a year, the **footer** is for
tools (issue links, breaking-change markers, co-authors).

## Subject: `type(scope): change`

- `type` from the closed list: `feat` (new behaviour), `fix` (a bug a user could hit), `docs`,
  `refactor` (same behaviour, different code), `perf`, `test`, `build`, `ci`, `chore`, `style`,
  `revert`. A behaviour change nobody reported is not a fix.
- `scope` names the module the change lives in — the folder under `src/` or the surface (`tui`,
  `cli`, `server`). One scope. A diff that spans several with no owner gets no scope; never
  `fix(a,b,c)`.
- The change, imperative, lowercase, no trailing period, at most 72 characters: "budget the run
  panel's command to three rows", not "Updated draw-code.ts" and not "fixes".
- `!` after the scope marks a breaking change: `feat(api)!: rename reasoning events`.

## Body

Why the change was needed and what is different now. The diff already shows *what* moved; the
body earns its place by saying what the reader cannot see: the bug's shape, the constraint, the
alternative you rejected. Wrap at 72. Omit it when the subject says everything.

## Footer

Only true statements: `BREAKING CHANGE: <what breaks and what to do>`, `Refs #123`, `Closes #45`,
`Co-authored-by: Name <email>`.

## Before writing

Read the staged diff (`git diff --cached`). Write the message for what is staged, not for what you
remember doing. Never stage or commit on the human's behalf unless they asked for exactly that.
