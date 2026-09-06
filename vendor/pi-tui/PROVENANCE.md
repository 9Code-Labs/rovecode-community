# Vendored: @earendil-works/pi-tui

- Upstream: https://github.com/earendil-works/pi (packages/tui)
- Version: 0.84.4 · License: MIT © 2025 Mario Zechner (see ./LICENSE)
- Vendored from local snapshot `research/source_snapshots/earendil-works-pi`
  at commit `853a80d26c90a14c1886f0ebb8ffaae133ca2185` on 2026-09-01 (rovecode port #1).
- Contents: `src/` (unmodified except patches logged in ./PATCHES.md),
  `native/win32/prebuilds/` (optional modifier-key addon; absence degrades gracefully,
  see src/native-modifiers.ts), upstream README as README.upstream.md.
- House rule: only `rovecode/src/tui/*` may import from this tree. Vendored files are exempt
  from the ≤400-line module budget (ADR-002 applies to house code).
- To update: re-snapshot upstream, diff against this tree, reapply PATCHES.md.
