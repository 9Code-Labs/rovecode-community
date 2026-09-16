/**
 * Stable public extension surface for Rovecode 0.x.
 *
 * Only symbols exported here and through the package subpath exports are public
 * API. Other `src/` modules remain internal and may change between minor
 * releases until 1.0. See docs/api-stability.md.
 */
export type {
  AgentDefinition,
  ApprovalFn,
  ApprovalRequest,
  AssistantTurn,
  ImageMime,
  ImagePart,
  Message,
  MessagePart,
  ModelRef,
  PermissionDecision,
  PermissionEffect,
  PermissionLevel,
  PermissionRule,
  Role,
  RunConfig,
  RunEvent,
  SpawnRequest,
  SpawnResult,
  StopReason,
  StreamEvent,
  StreamFn,
  StreamOptions,
  TextPart,
  ThinkingEffort,
  TokenUsage,
  Tool,
  ToolCallPart,
  ToolContext,
  ToolKind,
  ToolOutput,
  ToolResultPart,
  ToolSchema,
} from "./core/types.ts";
export { THINKING_EFFORTS, parseEffort } from "./core/types.ts";

export type {
  HookCtx,
  HookModule,
  HookName,
  HookSet,
  HookToolCall,
  RunResult,
} from "./core/hooks.ts";
export { HOOKS_API_VERSION, HOOK_NAMES } from "./core/hooks.ts";

export type { ExtensionHooks } from "./core/tools.ts";
export { ToolRegistry, evaluatePermissions } from "./core/tools.ts";

export type {
  AdapterOptions,
  MockScript,
  ModelCatalogEntry,
  ProviderConfig,
} from "./providers/stream.ts";
export {
  anthropicStream,
  anthropicStreaming,
  fetchModels,
  mockStream,
  openaiCompatStream,
  openaiCompatStreaming,
  providerStream,
  providerStreaming,
  textTurn,
  toolTurn,
} from "./providers/stream.ts";

export type {
  DiscoveredPlugin,
  LoadedPlugin,
  LoadedPlugins,
  LoadPluginsOptions,
  PluginCtx,
  PluginManifest,
  PluginModule,
  PluginScope,
  PluginStatus,
} from "./plugins/index.ts";
export {
  loadPlugins,
  MANIFEST_FILE,
  parseManifest,
  PLUGIN_API_VERSION,
  summarizePlugins,
} from "./plugins/index.ts";
