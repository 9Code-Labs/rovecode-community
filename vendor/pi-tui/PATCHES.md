# Local patches to vendored pi-tui

Every deviation from upstream `853a80d2` is listed here with a reason. Keep this list short;
prefer adapting on the rovecode side of the seam (src/tui/) over patching vendor code.

1. **All `src/**/*.ts`: prepended one `// @ts-nocheck` header line** (2026-09-01, port #1).
   Reason: rovecode's house tsconfig enables `noUncheckedIndexedAccess`, which upstream does not
   compile under; per-file compiler flags don't exist in tsc. The header mutes diagnostics
   for vendor internals only — exported types still flow fully typed across the seam to
   `rovecode/src/tui/*`. Vendor internals remain checked upstream at the pinned SHA. Mechanical,
   reversible: re-vendor = re-run the header loop (see git history of this port).
   No other source lines were modified.
