# Merging `aion-port`: what it costs and what will bite

Written 2026-09-07, measured against commit `1f62c5d`. Read the premise note first — this document was
commissioned twice under two different pictures of the world, and neither matched what git says.

## Premise, corrected twice

**As commissioned:** a second effort was said to be running on `main` in a separate checkout, so the
report was to rank textual conflicts between two diverged lines.

**First correction (from nimbus-52):** there is no second effort. The session mistaken for "the other
side" is working on an unrelated Discord bot on the Desktop, not a git repository. The merge is
therefore `aion-port` → `main`, ours into our own trunk, with no foreign commits.

**Second correction (measured here, and it changes the arithmetic):** there is nothing to merge.

```
main             1f62c5d
aion-port        1f62c5d
origin/main      1f62c5d
origin/aion-port 1f62c5d
merge-base(main, aion-port) = 1f62c5d
commits main..aion-port = 0        commits aion-port..main = 0
```

All four refs are the same commit. `main` already contains every one of tonight's 25 commits, including
`2b3ce4a` (`git merge-base --is-ancestor 2b3ce4a main` → true) and every file the port added:
`src/core/trust.ts`, `src/core/workspace.ts`, `src/eval/gauntlet-wave3.ts`, `src/mcp/oauth.ts`,
`test/helpers/mcp-trust.ts` are all present at `main`. The second working copy pinned to `main` is
therefore not an older tree — it is this tree.

**Consequences.**

- There is no divergence to reconcile, no conflict ranking to produce, and no cherry-pick to perform:
  the fix proposed for early cherry-pick is already on `main`. Section 3 keeps the analysis anyway,
  because it answers a question that outlives this moment: *if* someone needs these fixes on a line that
  does not have them (a `v0.3.2` patch, a revert, a future branch), which ones travel alone.
- The branch is a label, not a fork. Nothing merges until someone commits to one side. Whoever does
  should know the shape of what is already there, which is Section 1.
- Section 2 is the part that survives every correction intact, and it is the reason to keep this file.
  It is not about a merge at all: it is a list of behaviours that got **stricter** tonight, which code
  written against an older `main` — or a habit formed before tonight — will trip over. That list is
  what stops the next person debugging our correctness as their own bug.

## 1. The footprint of the port

Measured `v0.3.2` (`f51c149`, the last release before tonight) → `main`. This is the honest answer to
"how big is this": **235 files, +24 536 / −1 446 lines, 25 commits, no deletions.**

| | files | lines changed |
|---|---|---|
| **New files** (cannot conflict with anything) | 145 | ~21 500 |
| **Edits to pre-existing files** | 90 | 4 262 |
| — of which `src/` | 51 | 3 055 |
| — of which `test/` | 35 | 986 |
| — of which root docs (CHANGELOG, README, …) | 4 | 221 |

Two thirds of the port arrived as new files. The merge cost, if there is ever one, is the 90 edited
files — and specifically the 51 under `src/`.

### Edited files by churn, largest first

| lines | + | − | file |
|---|---|---|---|
| 368 | 193 | 175 | `src/mcp/client.ts` |
| 354 | 29 | 325 | `test/unit/otel.test.ts` (replaced by a split pair) |
| 242 | 143 | 99 | `src/telemetry/otel.ts` |
| 168 | 140 | 28 | `src/cli/runtime.ts` |
| 163 | 117 | 46 | `src/core/session.ts` |
| 154 | 149 | 5 | `src/mcp/tools.ts` |
| 151 | 14 | 137 | `src/coding/lsp.ts` |
| 147 | 131 | 16 | `src/providers/auth.ts` |
| 137 | 88 | 49 | `src/tui/app.ts` |
| 135 | 119 | 16 | `src/memory/blocks.ts` |
| 132 | 132 | 0 | `CHANGELOG.md` |
| 111 | 96 | 15 | `src/skills/index.ts` |
| 99 | 76 | 23 | `src/core/executor.ts` |
| 95 | 61 | 34 | `src/eval/gauntlet.ts` |
| 85 | 54 | 31 | `src/cli/main.ts` |
| 82 | 77 | 5 | `src/core/settings.ts` |
| 78 | 65 | 13 | `test/integration/gauntlet.test.ts` |
| 75 | 67 | 8 | `src/sextant/mentions.ts` |
| 71 | 66 | 5 | `src/core/tasks.ts` |

### Where the three wiring files were touched

Named by region rather than line number, because the character of a region decides how bad a
hand-resolution would be. A table of one-line entries is trivial to resolve; a nesting order is not.

**`src/cli/main.ts`** (+54 / −31) — three kinds of edit, all shallow:
- the command switch and the `known` set: one-line entries per new command (`skills`, `sessions`,
  `trust`, `mcp login`). Trivial to resolve.
- `cmdRun`'s preamble, around lines 68–120 of the new file: `guardStdout` before `bootRuntime`,
  `--add-dir` parsing, the run-limit parse, the `ROVECODE_MOCK` decision. **Order matters here** — the
  stdout guard must precede the boot, which is what the gauntlet's json-purity case pins.
- `cmdGauntlet` / `cmdGauntletLive`: the wave imports and the task list.

**`src/cli/runtime.ts`** (+140 / −28) — the file most worth reading before touching:
- new imports and `RuntimeOptions` / `Runtime` members (`lanes`, `addDirs`, `verifyResolver`, `tasks`,
  `hooks`, `blockStore`, …): additive, easy.
- the **tool registration block** in `createRuntime`: one line per tool, plus the wrapper composition
  (`withCheckpoint(withLspGate(editTool))`). Order of the wrappers is behaviour, not style.
- the **approval chain** in `buildCfg`, one line:
  `laneApprover(execPolicyApprover(hooks.approver(approval)), opts.lanes?.env)`. This is the single most
  dangerous line in the tree to resolve by hand. The nesting is the security property — execpolicy must
  sit *outside* the hook approver, or a project hook can wave through a forbidden command. Anyone
  resolving a conflict here should run `rovecode gauntlet` and check
  `adversarial-hook-allow-forbidden`, which fails within seconds if the order is wrong.
- the MCP boot block and `reloadMcp`, the trust-gate boot notes, the deferred connect timer.

**`src/tui/app.ts`** (+88 / −49) — the largest single edit is one contiguous block:
- `TUI_COMMANDS`: one-line entries (`MCP_COMMAND`, `/trust`, `/sessions`, …). Trivial.
- the slash dispatch `switch`: one `case` per command. Trivial.
- **lines ~434–483 of the new file**: a 37-line insertion replacing a 22-line block — the app's own
  approver, extracted so a model turn and a `!cmd` share one approval path. This is the one region in
  `app.ts` where a conflict needs a person who understands the intent, not a merge tool.
- the renderer composition root (`withNotifications`) near the end: `ring()` was removed from the
  renderers and the notification decision moved to one place. A resolution that reintroduces a
  renderer-level bell would silently undo the focus gate.

## 2. Behaviours that got stricter tonight

This is the section to read before writing code against this tree, and the one that would have saved
the most time if it had existed at 2am. Each entry is a thing that **used to work loosely and now
refuses**, with the symptom you will actually see and the fix.

| Behaviour | Before tonight | Now | Symptom if you assume the old behaviour | What to do |
|---|---|---|---|---|
| **Project trust gate** (`src/core/trust.ts`) | `.rovecode/hooks.ts`, `sandbox.json`, and the `verify` / `lsp` / `notify_command` settings keys loaded from a checkout unconditionally | Each is ignored unless this machine approved its exact bytes | A test that plants `.rovecode/hooks.ts` passes on an older line and **silently does nothing** here — the hook never loads, so an assertion about denial passes for the wrong reason, or one about a side effect fails with no error | Call `trustProjectFiles(cwd, home)` (`test/helpers/mcp-trust.ts`), or `trustFile(home, file)` in `src/`. Then assert the hook is live with something only the hook can write — see the gauntlet wave-3 header for why `rt.hooks.size` is not that thing |
| **Workspace boundary** (`src/core/workspace.ts`) | Reading an absolute path outside the cwd was silent and free | `file.external` is evaluated for every path-declared tool; the default gated rule prompts | Headless runs that read outside the project now fail closed instead of returning content | Pass `--add-dir <dir>`, or `yolo`, or expect the prompt |
| **MCP project config** | `.rovecode/mcp.json` / `.mcp.json` servers loaded from any checkout | Untrusted project files contribute nothing, with one warning | `mcp list` shows fewer servers than the file declares; `mcp login <name>` says "no MCP server" for a server plainly in the file | `rovecode mcp trust` |
| **`ROVECODE_MOCK`** | Advisory: a configured provider could win | Forces the canned provider always | Tests that set it *and* expect a real provider now get the mock; tests that relied on falling into the mock without asking now fail with "no provider configured" (exit 2) | Set it deliberately; a run with nothing configured is a startup failure by design |
| **`--resume <id>`** | An unknown, ambiguous or corrupt id silently started a NEW empty session | Exit 2 with one stderr line | Scripts that passed a stale id used to "work" (new session) and now stop | Resolve the id first; `rovecode sessions list` |
| **Session file with an ancestry cycle** | `path()` looped until `RangeError: Out of memory` | Path truncates at the cycle, `reload()` reports it | Nothing breaks — this one only got *safer*. Listed so nobody re-adds the old walk | — |
| **Registered tool set** | Smaller | `bash_list` / `bash_output` / `bash_kill`, the MCP prompt/resource quartet, `web_search`, skills, memory, task tools | Any test asserting an exact tool inventory fails; this already bit `runtime.test.ts` once tonight | Update the inventory, and prefer asserting membership over equality |
| **Notifications** | A renderer rang the bell whenever a turn ended | One composition root, gated on terminal focus (`notify_when: unfocused` by default) | A test expecting a bell on every turn sees silence when the terminal reports focus; `notify_command` from a project file also needs trust | Set `notify_when: always`, or assert through the notify seam |
| **External lanes** | — (new) | ON by default: unset `ROVECODE_LANES_ALLOW` allows all four; a value you set is an exact list; empty is the kill switch. A lane whose CLI is not on PATH is refused at the gate | `task start codex` now runs where it used to refuse. A test that relied on the old off-by-default (`env: {}` → refusal) passes the lane through instead; a machine without the CLI gets "needs the 'codex' CLI, which is not on PATH" rather than a spawn error after a worktree was built | Set `ROVECODE_LANES_ALLOW=` (empty) to turn every lane off, or name only the CLIs you want. This one got *looser* on purpose — the row is here because it is the only line in this table that did |
| **`web_fetch` / `web_search` / `skills install <url>`** | web_fetch guarded; the others did not exist | All three refuse loopback / private / link-local addresses, on the URL **and every redirect hop** | A loopback test fixture is refused — deliberately, and there is a gauntlet case pinning it | Inject a resolver (`resolve:`) in unit tests, as `skills-cmd-2.test.ts` does; there is no allow-private env knob for skills |
| **Skill loading** | Descendants of a skill dir could register as skills; a wrong `name:` loaded silently | A dir holding `SKILL.md` is a leaf; spec deviations load with a warning | Fixtures that nested a second `SKILL.md` under a skill now see one skill, not two | Expected; see `skills-spec.test.ts` |
| **Control bytes in shipped files** | Unnoticed | `test/unit/control-bytes.test.ts` fails the suite | A file written with a raw `NUL` (a Write/Edit escaping accident) now fails CI instead of shipping | Write such content via a script, not an escaped literal |

## 3. Merge order, and which fixes travel alone

**Order.** There is nothing to merge today. When there is: `aion-port` → `main`, and keep `main`
fast-forwardable by branching any new work from the current tip rather than from `v0.3.2`. A
fast-forward has no conflicts by construction, which is the cheapest possible answer and is available
for free as long as nobody commits to `main` directly.

**Cherry-picks.** Moot for `main` — every commit is already there. Recorded for the case where these
fixes are needed on a line that lacks them (a `v0.3.2` patch release, a revert of the port, a branch cut
from before tonight). These are the commits with no dependency on ported code, smallest first:

| commit | lines | files | why it travels alone |
|---|---|---|---|
| `2b3ce4a` session cycle | 38 | `src/core/session.ts`, its test | Fixes an out-of-memory crash reachable from a cloned repo's session file. Eight production lines, no port dependency. The strongest candidate, as nimbus-52 judged |
| `3a6d3b1` executor grandchildren | 98 | `src/core/executor.ts`, its test | Killing a command left its grandchildren running on POSIX. Pure process-group fix, touches nothing ported |
| `22b2085` control bytes | 90 | 4 shipped files + a guard test | Four shipped files could not be shown in a diff. Byte hygiene, plus the test that keeps it from recurring |
| `1708c2b` uncommitted import | 4 | `src/cli/main.ts` | One line: `HEAD` imported a module that was not committed. Trivially portable, and the kind of thing that breaks a fresh clone |

Everything else in the 25 depends on the port: it either adds a new subsystem (lanes, OAuth, OTel,
MCP depth, skills packaging, sessions, notifications, custom agents, waves 3–4) or wires one in.

## The one reported loose end, which was not one

Signing off, the session that ported the gauntlet waves named a single open item: the cancel-mid-tool
guardrail — an aborted run must leave no surviving process tree — described as real but untested,
because the upstream gauntlet case for it was dropped (its verdict rested on polling the OS for a dead
process, so its failure mode was "the machine was busy" rather than "the guardrail broke").

It is tested, and has been all along: `test/integration/abort.test.ts:201`, "abort mid-bash kills the
shell AND the child it waits on". It starts a real shell that writes a marker, waits until the shell
proves it is running, aborts the RUN controller (deliberately not the consumer's `.return()`, so a
mutation that disconnects the tool's signal from the run's fails the test), and then checks three
things: on Windows the tagged sleep is gone, on POSIX the second side effect never lands inside the
window a surviving shell would have written it in, and either way the run ends `stopped` with the
issued call answered and no orphan tool_call on the wire. Ten of ten green.

So dropping the gauntlet case cost nothing: it was redundant with existing coverage AND the flakier of
the two ways to assert the same property. Nothing is owed. If someone picks up that note and writes a
new test, they will be writing a second copy of this one — check `abort.test.ts` first.

Worth keeping as a pattern rather than a footnote: the reason to drop a case is that its verdict is
unreliable, and the reason it was safe to drop is that the property was already pinned somewhere the
verdict is not a race. Those are two separate facts and both had to be checked. Only the first one was.

## What this document does not tell you

- Nothing about a parallel effort's code, because there is none. Any ranking of "how likely is a
  conflict here" would have been invented, and an invented number in a merge report is worse than a
  blank.
- Nothing measured against the second checkout's working tree. It is off limits by instruction, and
  `git` shows its branch at the same commit, so there is nothing there to measure.
- The strictness list in Section 2 is derived from tonight's 25 commits and their tests. It is the
  shape of change worth looking for, not a proof of completeness: a behaviour made stricter without a
  test would not appear here.
