# First-party CLI download contract

This pipeline stages artifacts locally; it does not upload to GitHub Releases or production.

## Supported artifact

Only `windows-x64` is currently published by the staging script because it is built and smoke-tested on that host. Linux and macOS must not be added until their native single binaries pass the same extracted-artifact gates in CI.

Run:

```bash
bun run build
bun run release:stage -- ../rovecode-release-staging
```

For version `0.3.2`, the staging tree is:

```text
v0.3.2/
├── rovecode-v0.3.2-windows-x64.zip
├── SHA256SUMS
├── manifest.json
└── payload/rovecode/       # local audit input, not an upload artifact
    ├── rovecode.exe
    ├── INSTALL.txt
    ├── LICENSE
    ├── THIRD_PARTY_NOTICES.md
    └── README.md
```

## Manifest schema

```json
{
  "schemaVersion": 1,
  "product": "rovecode",
  "version": "0.3.2",
  "channel": "stable",
  "publishedAt": null,
  "artifacts": [{
    "platform": "windows",
    "arch": "x64",
    "filename": "rovecode-v0.3.2-windows-x64.zip",
    "url": "./rovecode-v0.3.2-windows-x64.zip",
    "bytes": 0,
    "sha256": "64 lowercase hex characters",
    "contentType": "application/zip"
  }]
}
```

The staging manifest uses `publishedAt: null`; the publication coordinator sets an ISO-8601 timestamp when the immutable files are uploaded. `url` is relative to the manifest. There is no signature field because no signing and verification chain exists yet.

## Smoke and audit contract

Extract into a fresh directory and run `rovecode.exe --version`, `--help`, `doctor --definitely-not-a-real-flag`, a no-provider `run` with an empty `ROVECODE_HOME`, and `smoke-tui --sextant`. The no-provider run must fail closed without network. Audit the ZIP file list against the five files above and verify its SHA-256 against both manifest and `SHA256SUMS`.

## Reproducibility

The payload selection, names, manifest, and checksums are deterministic inputs. ZIP metadata and Bun `--compile` output are not claimed byte-reproducible: Bun embeds a runtime and may include build metadata, while `Compress-Archive` records file timestamps. Two clean builds are compared and their hashes reported; a mismatch is documented rather than disguised. Reproducible byte-for-byte builds remain a roadmap item.

### Current reproducibility measurement

Two consecutive Windows x64 Bun 1.3.14 compile runs from the same checkout produced equal-size binaries but different SHA-256 values. This confirms that the current Bun single-binary output is **not byte reproducible**; artifact integrity is therefore anchored to the checksum of the exact staged/uploaded ZIP, not to an expectation that another compile reproduces it.
