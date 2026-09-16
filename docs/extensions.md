# Extension interfaces

Rovecode supports provider records, MCP servers, skills, and `plugin.json` plugins. Start with [plugins](plugins.md) and the examples in `plugins/`. Provider configuration is data-driven; copy `examples/provider-config.json` to `.rovecode/providers.json` and replace the local model. Keep secrets in environment variables or `rovecode auth`, never config. Tool/plugin interfaces are pre-1.0 and may change with a changelog entry; pin the Rovecode minor version for distributed extensions.
