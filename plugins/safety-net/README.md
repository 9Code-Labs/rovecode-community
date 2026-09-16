# safety-net

A second look before a destructive shell command, and a nudge when a test run prints `FAIL`.

Two hooks. That is the entire plugin.

## What it does

**`pre_tool` — refuses a shell command that matches a known-destructive shape.** The refusal names the
pattern and echoes the command back, so if you meant it you can run it yourself:

```
safety-net: recursive forced delete — not from the agent. Run it yourself if you mean it: rm -rf ./build
```

The seven shapes it looks for:

| pattern | what it catches |
|---|---|
| `rm -rf` (in either flag order) | recursive forced delete |
| `git push --force` / `-f` | force push |
| `git reset --hard` | hard reset |
| `git clean -f` | untracked files gone for good |
| `chmod 777` | world-writable permissions |
| `curl …` / `wget …` piped into a shell | network piped into a shell |
| `drop table` / `database` / `schema` | dropping a table or database |

**`post_tool` — when a shell run prints a `FAIL` line, it appends one sentence the model cannot miss:**
fix it before moving on, do not mark the step done. The command's own output is left intact; the sentence
is added after it, and never twice.

## What it deliberately cannot do

A hook can only **deny**. It cannot grant permission, widen policy, or approve something the permission
rules would have refused — see `src/core/hooks.ts`: policy wins, and a hook is your own stricter layer on
top. For a safety net that is exactly the right amount of power.

It is also **not a security boundary**. The patterns are regular expressions over the command string, and
anything determined to get past them will (`rm -r -f` with an odd spelling, a variable holding the flags, a
script that does the deleting). It is there to catch the ordinary accident, which is what actually happens.

## Install

```
rovecode market install plugin:safety-net
```

Or from a checkout of this repository:

```
rovecode plugin add ./plugins/safety-net
```

It ships an entry module, so rovecode imports it in-process — the approval preview says so before anything
is installed.

## Configuration

None. It applies to tools named `bash`, `shell` or `run`, and does nothing to any other tool.
