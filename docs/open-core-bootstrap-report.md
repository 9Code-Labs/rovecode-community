# Open-core bootstrap report

## Export

Exported from one private source revision using `git archive HEAD` and an explicit tracked-file allowlist: runnable `src/`, `bin/`, tests/fixtures, vendored TUI with provenance, bundled plugins, build/catalog scripts, package/lock/config files, license/notices/changelog, and user-facing core docs. A fresh Git repository was initialized; no private history was copied.

Excluded: `.git`, ignored/untracked `.rovecode`, `dist`, `node_modules`; deployment/site publishing script; private integration/merge/market research docs; website screenshots and site deployment docs. The separate website/auth/deployment repository was not read or used.

## Security and validation

Record final command results before publication. Required gates: frozen install, typecheck, all tests, CLI build/help/version, package dry run, exported-tree scan, committed-history scan, and fresh-clone repeat. Search findings that are examples, public provider endpoints, loopback/test addresses, or secret-handling code must be reviewed rather than blindly removed.

## Strategy and remaining refactors

Near term is an audited allowlist export; target is public-upstream/private-downstream as detailed in `open-core-architecture.md`. Next private refactors: consume a versioned public core boundary; move overlay adapters behind public interfaces; add an automated private-import prohibition; promote features through public PRs; eliminate duplicate implementations after public release.

## GitHub controls

Record enabled and unavailable controls after repository creation. Branch rules must require CI without preventing the sole maintainer from recovering the repository.

Bootstrap baseline: Bun 1.3.14 frozen install and TypeScript typecheck passed. The complete local suite passed after the tracked source was restored byte-for-byte; final counts are recorded after the final clean run. GitHub repository/settings are intentionally not created until all remaining gates pass.

Final local gates: frozen install passed; `tsc --noEmit` passed; 3,264 tests passed, 5 platform skips, 0 failures across 318 files; CLI bundle and sextant smoke passed; `--version` returned 0.3.2; `--help` passed; npm dry-run contained 334 files (1,491,619 bytes). High-confidence key/private-key scan and forbidden private-host/absolute-user-path scan returned zero findings. Gitleaks is not installed locally; the repository remains non-public until a history scan is performed with an ephemeral official gitleaks binary or equivalent.

Gitleaks v8.24.3 initially identified 21 generic-key matches. Manual review found synthetic credential test fixtures plus a typed event field name, not credentials; these exact paths are documented in `.gitleaks.toml`. Re-scans of both committed history and the working tree with that reviewed configuration returned zero findings.

Final excluded-document check removed deployment, private merge/integration, market-planning, and internal design-research material that had been reintroduced while restoring tested source files. These are not required to run or contribute to the core.

GitHub setup: repository created private, pushed, then made public only after gates; default branch is `main`. Private vulnerability reporting, Dependabot security updates, secret scanning, and push protection are enabled. Branch protection requires Ubuntu/Windows validation plus secret scan, strict up-to-date branches, resolved conversations, and forbids force-push/deletion; admin enforcement/review count is intentionally off for the current single-maintainer team. Discussions and issues are enabled. Non-provider secret patterns and validity checks are unavailable/disabled. Initial hosted Actions jobs were rejected before any steps ran (empty job step list), indicating an organization Actions/billing policy rather than a test failure; local and fresh-clone gates remain green, but required checks cannot become green until that organization setting is corrected.

## Risk-hardening follow-up

The remaining architectural risks were addressed in the public core: explicit package subpath exports and API contract tests now define the supported extension surface; a boundary checker forbids public imports from private/commercial/hosted overlays; API stability and signed manual release policies are documented; local documentation links are checked; website render generators and their tests were removed as out of scope. CI actions are immutable-SHA pinned. The licensed Gitleaks Action was replaced by a checksum-verified Gitleaks CLI invocation. GitHub's empty-step failures were confirmed by check annotations to be account payment/spending-limit rejection, not source/test failures; that external organization billing control cannot be changed from repository code.

Authentication-boundary follow-up: generic local provider API-key/OAuth and MCP OAuth remain public so the agent is runnable. Hosted Rovecode account auth, website/dashboard sessions, billing, entitlements, and control-plane contracts are explicitly excluded and mechanically checked by `check:product-boundary`. This is intentionally a server-side trust boundary, not obfuscation: an OSS client is treated as inspectable and untrusted. Cross-platform CI failures uncovered three POSIX tests that incorrectly lowercased case-sensitive paths and one home-variable mismatch; the tests were made platform-correct. Final local result remains 3,238 pass, 5 Windows-specific skips, 0 failures across 317 files; build and package dry-run pass.

CRT/release follow-up: the public upstream now owns the receiver painter, compiled-binary fixes, release staging, and deterministic offline quality runner. No website/deploy source was used. The host-built support claim remains Windows x64 only. Two same-checkout Bun 1.3.14 compiled binaries differed in SHA-256, so byte reproducibility is not claimed. Artifact publication remains blocked pending coordinator approval and public CI.

Final staged Windows x64 ZIP: `rovecode-v0.3.2-windows-x64.zip`, 42,317,296 bytes, SHA-256 `2968448887e59e9c44d3047c9894e9866a8a10523fb4e314b4350857ae446b6e`. Extracted smoke: version 0.3.2, help pass, typo exit 2, no-provider offline run fail-closed, CRT receiver render pass. Offline quality runner: 12 group/seed runs, 778 assertions passed, 0 failed, 0 process failures, 0 flaky group signatures, 98,627 captured output bytes in 26.65 s. This report is staged outside Git and not uploaded.
