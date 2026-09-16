# API stability

Rovecode is pre-1.0. The supported programmatic surface is intentionally smaller than the source tree.

## Supported entry points

- `rovecode` — core types, agent primitives, sessions, context, and local coding helpers preserved for compatibility.
- `rovecode/extensions` — the curated provider, tool, hook, and plugin extension API.
- `rovecode/plugins` — plugin discovery/manifest API.
- `rovecode/providers` — provider adapter API.

Do not import `rovecode/src/...` or repository-relative internal modules from a distributed extension. Those paths are implementation details and are not present in the package export map.

## Compatibility policy

During 0.x:

- patch releases preserve supported API signatures and fix behavior;
- minor releases may add APIs and may remove an API only after a documented deprecation when practical;
- plugin manifests and modules use the numeric `PLUGIN_API_VERSION` compatibility gate;
- hook modules use `HOOKS_API_VERSION`;
- every supported API change requires contract tests, a changelog entry, and migration notes when user action is needed.

The project intends semantic-version stability for documented entry points at 1.0. No stability is implied for unexported source modules.

## Downstream rule

Public code must not import private overlays. A private product may depend on the documented public entry points. `bun run check:boundary` enforces the public side of this rule; downstream CI should independently reject reverse imports from its copy of the public package.
