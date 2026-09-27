/** @rovecode/sdk — public surface (docs/design/sdk-blueprint.md §3). */
export { createClient, agentTree } from "./client.ts";
export { mockStream, textTurn, toolTurn } from "../providers/stream.ts";
export type { AgentNode, ClientOptions, RovecodeClient, SdkEvent, SessionHandle } from "./client.ts";
export type { LearningGraph, LearningNode, LearningEdge } from "../learning/graph.ts";
export type { SkillDraft, LearningNudge } from "../learning/draft.ts";
