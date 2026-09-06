/** Rovecode public API surface. */

export * from "./core/types.ts";
export { agentLoop, SteeringQueue, extractToolCalls, partsText } from "./core/loop.ts";
export { ToolRegistry, evaluatePermissions } from "./core/tools.ts";
export type { ExtensionHooks } from "./core/tools.ts";
export { SessionStore, chainHash } from "./core/session.ts";
export type { Entry, Corruption, CorruptionKind, SessionMeta } from "./core/session.ts";
export { assembleContext, planCompaction, estimateTokens } from "./core/context.ts";
export { preflightSpawn, runChild, createIsolation, DEFAULT_MAX_DEPTH } from "./core/orchestrator.ts";
export type { SpawnContext, ChildRunnerDeps, IsolationWorkspace } from "./core/orchestrator.ts";
export { mockStream, openaiCompatStream, textTurn, toolTurn } from "./providers/stream.ts";
export type { MockScript } from "./providers/stream.ts";
export { lineHash, fileTag, readAnchored, renderAnchored, applyEdits, readTool, editTool, writeTool, bashTool } from "./coding/hashline.ts";
export type { AnchoredFile, EditOp, EditFailure, EditResult } from "./coding/hashline.ts";
export { MemoryStore, defaultLimits } from "./memory/store.ts";
export type { MemoryRecord, MemoryKind, MemoryLimits } from "./memory/store.ts";
