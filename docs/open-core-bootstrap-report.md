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
