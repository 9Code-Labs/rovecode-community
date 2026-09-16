# Main integration record

## Inputs

- GitHub `main`: `baf72721cc3baf18296942e6aec46667416ed140`.
- GitHub `aion-port`: `a224baa4ffb1dd512ba5e4cc69a27f653980923a`.
- GitHub `harness/nimbus-main`: `8355de754e58ca110defd3d31d2a5503ce372453`.
- Local `aion-heavy-work`: TUI ports `99becc4` and cooperative warmup `510437f`, based on `c5f553d`.

Work took place in `orca/workspaces/rovecode/main-integration`. No files in the separate
`rovecode-main` installation or the original `rovecode` checkout were edited. Local `.orca-agent/`
metadata and generated build/cache files are not part of the commits.

## Resolution

1. Fast-forward the integration branch from GitHub main to `aion-port`.
2. Merge `aion-heavy-work`, resolving the two overlapping files by behavior, not whole-file choice:
   - Move the complete `aion-port` options/command declaration block into `tui/tui-commands.ts`.
     Preserve the command entries and all handlers, including ports #53 and #65.
   - Combine REPL busy gates, preserve built-in `/init` expansion before mention processing, and
     give git commands the shared abort/drain lifecycle.
3. Join `harness/nimbus-main` using an **ours-strategy history merge**. This is deliberate and
   does not import its source tree wholesale. Its tip is itself a submission merge that retains
   the entire Nimbus tree and attaches Rovecode `f51c149` as its second parent. PR #1 explicitly
   warns that a normal merge would undo the rename and remove product additions.

The history merge marks that snapshot as superseded by the Rovecode implementation plus the
feature ports already present. It is **not a claim of byte-for-byte or complete feature parity**
with Nimbus. Future upstream features must be evaluated as feature deltas, not imported by
replacing the application tree. Both remote branch tips and the local work remain ancestors;
no branch is deleted and no published history is rewritten.

## Feature mapping and retained differences

Inspection included the incoming commit descriptions, PR #1, source-file inventories, the
Rovecode changelog and the existing port report (`merge-aion-port.md`, a historical report,
not a current statement that the refs are equal).

| Incoming area | Integrated Rovecode implementation / resolution |
| --- | --- |
| Plain input, picker metadata, boot notes, command declarations | This merge's remaining local ports; reuse hashline mentions, `cmdAttach`, provider registry and the existing picker. |
| Git/context/config/agents commands and reasoning rows | `aion-port` handlers and tests retained; command declarations moved without dropping entries. |
| External CLI lanes and task workflow cards | Existing `src/lanes/`, `core/tasks.ts`, `sextant/crew-cards.ts`; retain newer availability, process isolation and progress fixes. |
| Responses API, provider OAuth, MCP OAuth/tools/resources/prompts | Existing `providers/responses.ts`, `providers/oauth/`, `mcp/oauth.ts`, `mcp/tools.ts` and related modules. |
| Skills packaging, LSP table, session management/HTTP resume, OTel, notifications | Existing Rovecode ports retained instead of duplicating their Nimbus adapters. |
| Nimbus boot-module/env/path splits | Keep Rovecode's current composition root, `ROVECODE_*`, `.rovecode`, provider registry and package entry. No `core/env.ts` compatibility layer added. |
| Attachments and approval semantics | Keep anchored file content and once/always/deny; do not import Nimbus XML attachments or persistent-save approval semantics. |
| Compaction summarizer (#68) | **Not imported**: `/compact` remains the durable deterministic fallback already documented in CHANGELOG; a production summarizer is still unwired. |
| Folder trust | Keep Rovecode's per-file content-approval model. The Nimbus folder-wide ask-list/settings implementation is **not substituted** for it. |
| CI/hygiene | Keep Rovecode's current workflow and tests, not Nimbus's matrix, external-workspace notice generator or changelog-coverage ratchet. |
| Product additions | Retain `bin/rovecode.ts`, AGPL license/notices, plugins, market, verify, design and current sextant behavior. |

## Optimization and lifecycle fixes

The initial fix yielded during file enumeration and cold extraction, but ranking still ran
synchronously. The integrated version also yields during graph construction, PageRank and budget
search. Sync and async paths consume the same ranking steps and produce identical chunks in the
parity tests. Individual parses, sorts and cache serialization remain synchronous: there is no
hard real-time latency guarantee.

Warmup now has cancellation and a drain operation. The first combined test run exposed two
Windows `EBUSY` cleanup failures: the asynchronous git listing could still own the cwd after the
app resolved. The fix is in runtime/app teardown, not a weakened test or a cleanup retry. Cancellation
waits for the git listing to exit (its existing five-second timeout remains), stops subsequent work
and prevents partial cache writes. The subsequent combined run is green.

The other initial failure was an obsolete source-text assertion expecting shell-only settlement;
it now checks the combined shell/git/compaction drain. A real REPL subprocess test verifies that
EOF while a COMMIT model request is pending exits without committing, and that concurrent shell,
compaction, branch, git and model input is refused. The existing provider test also verifies that
plain `/init` still expands after the merge.

## Validation

Windows, Bun 1.3.14; **targeted suites only**, not the entire suite:

- `bunx tsc --noEmit`: clean.
- TUI / REPL / runtime / repo-map / commands / attachments / boot / control-byte group:
  **283 pass, 1 skip, 0 fail across 41 files**. The skip is the existing Windows symlink-permission test.
- Lanes / workflow cards / task batches / sextant / gauntlet integration group:
  **204 pass, 0 fail across 15 files**.
- Combined: **487 pass, 1 skip, 0 fail across 56 files**.
- `bun run build:cli`: bundle succeeds; bundled version and bundled sextant smoke pass.
- `git diff --check` and the control-byte guard: clean.

A fresh `MemoryIO` boot probe over **400 cold source files, 80 functions each** measured all five
panels visible at **428 ms**, a maximum sampled 10-ms timer gap of **98 ms**, and quit/drain in
**3 ms**. This is a synthetic local measurement, not a claim about every terminal or repository.
The earlier synchronous implementation reproduced a roughly 10-second cold-repository freeze.

GitHub CI and POSIX execution are not represented by these local Windows measurements. Updating
GitHub main does not automatically update an already installed/global executable.
