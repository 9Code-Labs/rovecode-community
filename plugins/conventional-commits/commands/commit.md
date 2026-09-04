---
description: Write a Conventional Commits message for the staged changes ($ARGUMENTS = an optional scope or hint)
---
Write ONE commit message for what is currently staged.

1. Run `git diff --cached --stat` and then `git diff --cached`. If nothing is staged, say so and stop — do not stage anything yourself.
2. Read the diff before writing. The subject must describe the CHANGE, not the files ("teach the run panel to budget the command", not "update draw-code.ts").
3. Format, exactly:

```
<type>(<scope>): <subject in imperative mood, lowercase, no period, ≤ 72 chars>

<body: why the change was needed and what it does differently, wrapped at 72 — omit when the subject says it all>

<footer: BREAKING CHANGE: … · Refs #123 · Co-authored-by: … — only when true>
```

Types: feat · fix · docs · refactor · perf · test · build · ci · chore · style · revert. Pick `fix` only for a bug a user could hit; a behaviour change nobody reported is `feat` or `refactor`.
Scope: the module the change lives in (the folder under src/, or the surface: tui, cli, server). One scope; when the diff spans several with no owner, omit the scope rather than listing three.
A hint from me, if any: $ARGUMENTS

Print the message in a fenced block and nothing else after it. Do NOT run `git commit` — I commit.
