# Release process

Publishing is manual until a protected-environment, provenance-capable workflow can be enabled and reviewed. This avoids an untrusted or accidentally privileged release pipeline.

1. Start from a clean, up-to-date `main` and review the Unreleased changelog.
2. Run `bun install --frozen-lockfile` and `bun run release:check`.
3. Verify `npm pack --dry-run --json`; inspect the file list and package metadata.
4. Run Gitleaks against the working tree and complete Git history using `.gitleaks.toml`.
5. Update the version and move Unreleased entries into a dated release section.
6. Open and merge a release PR after required checks pass.
7. Create a signed annotated tag: `git tag -s vX.Y.Z -m "Rovecode vX.Y.Z"`.
8. Push the tag and create a GitHub release from the changelog.
9. If npm publishing is approved, publish from that exact tag with provenance and verify the registry tarball and checksum.

Never publish from a private-product branch, a dirty checkout, or a package whose dry-run contains session, credential, deployment, or customer material.
