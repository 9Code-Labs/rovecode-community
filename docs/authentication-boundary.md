# Authentication boundary

Rovecode Community includes authentication needed for a useful local coding agent:

- provider API keys from environment variables or the local credential store;
- provider OAuth implementations for supported public providers;
- MCP OAuth client state;
- redacted listing, removal, refresh, and token-safe error handling.

It intentionally excludes product authentication and authorization:

- no Rovecode hosted account login;
- no website/dashboard session or cookie handling;
- no billing, entitlement, subscription, license-server, or control-plane client;
- no production client secrets, callback inventory, signing keys, tenant data, or deployment configuration.

This is a trust boundary, not obfuscation. Open-source client code can always be inspected and modified; anti-reverse-engineering measures would not protect server-side secrets and would make legitimate development harder. Security must come from keeping authoritative checks and secrets server-side in the private product, using short-lived scoped tokens, validating every privileged request on the server, and treating the public client as untrusted.

## Extension rule

A private product may implement its own account adapter outside this repository and depend on the public core. The public core must not import or require it. Provider and MCP authentication stay generic and usable without any Rovecode account.

`bun run check:product-boundary` rejects hosted-product paths, imports, and environment contracts from public source. `bun run check:boundary` separately enforces the broader private-overlay dependency direction.

## Credential guarantees

Local credentials are ignored by Git, never accepted as ordinary CLI flag values, redacted in listings, omitted from errors, and isolated from tests through a fresh `ROVECODE_HOME`. POSIX stores are written with restrictive modes; Windows relies on the user profile's ACL and does not claim POSIX mode semantics. Contributors must use synthetic credentials in tests.
