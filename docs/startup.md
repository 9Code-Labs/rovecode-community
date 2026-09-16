# Startup: intro → complete TUI

The user must not see the half-drawn outer frame/files-only stage. The animated intro stays on the
terminal while the actual textbox, cursor, transcript and panels are prepared offscreen. The first
visible TUI frame is complete, not a placeholder that finishes drawing in front of the user.

## Readiness, not just a timer

`src/cli/start-chat.ts` starts the intro before loading interactive modules or resolving a resumed
session. Release requires **both**:

1. The existing intro choreography has played through (nominally ~1.1s; timer scheduling can extend it).
2. Session/runtime preparation, sandbox readiness, renderer layout and the first file snapshot are ready.

These run concurrently. Slow loading holds the completed intro with its activity line; fast loading
no longer makes the intro flash and disappear. `--no-intro`, `ROVECODE_INTRO=0`, small/non-TTY terminals
and `--plain` retain their opt-outs. Intro-disabled sessions have no animation wait.

## Offscreen preparation and one reveal

- `beforeFirstRender` seeds the transcript and status, but **does not end the intro**.
- Sextant computes its panel geometry, textbox/cursor and hit zones in memory, without subscribing to
  input, entering raw mode or writing its frame. The initial file scan starts under the intro.
- Classic renders its real editor and serializes its first frame through `StagedTerminal`; queued
  `requestRender` calls cannot leak output onto the intro.
- Before release, both surfaces rebuild using the latest dimensions/state. An intervening resize or
  completed file/status update cannot reveal an obsolete frame.
- `onReveal` releases the intro only when the complete frame is ready to write. DECSET 2026 synchronized
  output brackets the handoff, so supporting terminals do not display the clear/partial-write stage.
  Sextant's separate panel-stagger animation is disabled for this path.
- Cancellation discards prepared output. Late readiness cannot reopen raw input or focus reporting.
  Startup errors restore the intro; git children, repo-map work and MCP connections drain on close.

The intro never reads stdin. Input attaches at reveal, preserving terminal-buffered keystrokes.
`runTui` callers without `startup` retain their synchronous input-wiring behavior. Injected legacy
renderers may ignore optional preparation hooks and receive the post-start seed fallback.

## Work that does not block readiness

Repo-map AST indexing, model-list refreshes and the update check still run in the background. They are
not prerequisites for drawing a usable textbox. A failed initial file listing gives a warning instead
of making the whole app unusable; later file refreshes remain asynchronous.

Automatic interactive repo-map warmup skips the canonical home directory and filesystem root. A
project **under** home still gets its map, including non-git projects. Explicit headless map building
and the file browser are unchanged by this indexing guard.

Only the selected renderer implementation is loaded. Plain chat imports neither renderer nor the TUI
app. The notification wrapper forwards and awaits the renderer's optional asynchronous startup.

## Validation

Windows, Bun 1.3.14:

- **271 passed, 0 failed across 33 targeted files**: intro, offscreen editor/layout, lazy modules, file
  snapshot readiness, renderer lifecycle, hooks/resume/notifications, runtime warmup and plain REPL.
- TypeScript (`bunx tsc --noEmit`), `git diff --check`, LF/control-byte checks passed.
- `bun run build:cli` passed, including the bundled Sextant smoke test.
- A separate packaged interactive launch at **210×54** verified byte ordering:
  intro → synchronized-output begin → alternate-screen entry → complete textbox frame → synchronized
  output end. `/exit` restored the terminal and exited 0.
- In that isolated run the first frame was prepared at **+193 ms**, the intro was released at **+1418 ms**,
  and `interface ready` was traced at **+1425 ms**. This deliberately distinguishes fast preparation
  from the visible intro duration; it does not claim a 67-ms visible startup anymore.

Focused regression checks:

```sh
bun test test/unit/intro.test.ts test/unit/staged-terminal.test.ts test/unit/sextant-repo.test.ts test/integration/start-chat-cli.test.ts test/integration/tui-startup.test.ts
```

Coverage includes a slow sandbox, a fast runtime with the intro still playing, resize during hidden
preparation, initial files in the first frame, immediately functional textboxes, cancellation before
and after preparation, and classic/plain/no-intro CLI paths. The entire suite was not run; this does
not establish Linux/macOS or every terminal emulator's synchronized-output support.

## Local installation

After user approval, `bun link` registered `main-integration` as the global `rovecode` package.
PowerShell's existing `.bun/bin/rovecode.exe` now resolves to this tree; the Nimbus `rovecode.cmd`
wrapper delegates to that same executable instead of launching Nimbus's older source. Both preserve
arguments, exit codes and the current project directory. The older `rovecode-main` source checkout
was not modified.

Six installed-command checks passed: version, real startup and invalid-argument exit 2 through both
PowerShell and the CMD wrapper. Startup traces confirmed `dist=true` and the new first-frame handoff;
the global junction and bundled file matched the validated workspace. These installation checks used
pipes (intro disabled); the 210×54 TTY handoff check above covers the animated path.

The previous launchers and link target are backed up in
`C:/Users/berkaycik/.bun/rovecode-backups/20260908-171000-before-intro-ready`.
This is a local link, not a published release: keep `main-integration` available, and rebuild its
`dist/cli` after changing startup code. Already-running sessions must be closed and relaunched to use
it. The current source edits remain uncommitted/unpushed.
