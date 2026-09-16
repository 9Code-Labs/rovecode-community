# Open-core architecture

## Boundary and inventory

This repository is the useful local coding-agent core, not a reduced demo.

| Source area | Classification | Rationale |
|---|---|---|
| `src/core`, `coding`, `providers`, `tools` | Public core | Agent loop, context/compaction, provider seams, policy, local tools |
| `src/tui`, `sextant`, `cli`, `acp`, `server` | Public core | Local CLI/TUI and optional local protocol surfaces |
| `src/mcp`, `plugins`, `skills`, `memory` | Public core | Extension and local knowledge interfaces |
| `src/eval`, `test` | Public core | Deterministic eval and regression primitives |
| `src/telemetry` | Public optional | Explicitly configured OpenTelemetry; disabled by default |
| `src/lanes`, `market`, bundled plugins | Public optional | Local integrations/catalogs with trust gates |
| Website/auth/deployment repository | Excluded | Separate system and not extraction source material |
| Hosted account/control-plane, billing, managed services, private connectors | Private overlay | Commercial/operational concerns; no dependency from public code |
| Production credentials, inventories, customer data, logs/sessions, internal docs | Excluded | Secrets/privacy/operations |
| Current single-package module graph | Needs refactor | Exported coherently now; stable package seams remain to be made explicit |

Dependency rule: **public code never imports private code; private modules may import public interfaces**. CI in the private downstream should enforce this with an import-boundary check.

## Sync models considered

1. **Periodic allowlist export:** safest initial disclosure and easy to audit, but creates drift and repeated conflict resolution.
2. **Public upstream + private downstream:** one canonical OSS history; private development consumes the public package/subtree and carries overlays. Best long-term review and promotion flow, but requires package boundaries.
3. **One monorepo/package split:** atomic refactors and strong boundaries, but risks accidental publication and complicates access control.

**Near term:** audited, tracked-file allowlist exports while extracting stable package entry points. **Target state:** this public repository is upstream; the private product consumes a versioned core package or read-only subtree. Private overlays implement public interfaces, never the reverse. The monorepo model is rejected for now because disclosure mistakes have higher cost than synchronized refactors.

## Feature promotion

1. Prototype behind a public interface in the private downstream; use no private data in fixtures.
2. Decide whether the capability belongs in core, optional OSS, or remains an overlay.
3. Reimplement/generalize on a public branch with provenance, threat model, docs, tests, and third-party notices.
4. Verify no private imports, names, hosts, credentials, metadata, or operational assumptions.
5. Open a public PR; document API compatibility and add `CHANGELOG.md` under Unreleased.
6. Release publicly, then update the private dependency and delete the duplicate prototype.

Do not cherry-pick private commits when their metadata or mixed content is unsuitable for publication.

## Releases, stability, security, governance

The project remains pre-1.0: patch releases fix defects, minor releases may evolve extension APIs with migration notes, and removals require deprecation where practical. Tags and GitHub releases are created manually after CI; package publication is intentionally manual until trusted provenance automation is established. The lockfile and Bun version are committed. AGPL-3.0-only is intentional for this extraction; third-party obligations are listed in `THIRD_PARTY_NOTICES.md`.

Public decisions happen in issues/PRs under `GOVERNANCE.md`. Vulnerabilities use GitHub private vulnerability reporting per `SECURITY.md`, never public issues. Stable interfaces will be explicitly exported and documented rather than inferred from internal paths.
