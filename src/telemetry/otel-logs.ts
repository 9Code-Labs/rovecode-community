/** OTLP log records for the #39 hook set (port #82): the ExportLogsServiceRequest encoder plus the approval
 *  ledger that turns the EXISTING `approval` hook member (core/hooks.ts:98) into `rovecode.approval` records.
 *  The hook set's approval() records the request and returns void — the human is still asked and their
 *  verdict stands — so the record's decision has to be OBSERVED from the tool events that follow: the
 *  `pre_tool` hook runs BEFORE the prompt (core/tools.ts:112 → :128), which means a tool span is already open
 *  and "awaiting execution" when the card fires; the next `tool_execution_start` for a same-tool span still
 *  awaiting execution is the allow, a `tool_call_failed{permission_denied}` for such a span the deny, and a
 *  request still pending at post_run is `unanswered` (a run aborted while the card was up — tools.ts:141).
 *  otel.ts owns the spans and does that matching (the ids ride along only when exactly ONE candidate span
 *  matched — never a guessed id); this module owns the pending queue and the records.
 *
 *  One LogRecord per request: body `rovecode.approval`, attrs rovecode.tool · rovecode.session_id (the approval ctx
 *  is the runtime's {cwd, sessionId}, hooks.ts:298 — no runId exists there) · rovecode.decision ∈ allow|deny|
 *  unanswered · rovecode.lane (the adapter id, for a `task start` of an external lane — never the card text) ·
 *  rovecode.call_id + traceId/spanId when correlated; severityNumber 9/INFO for allow and unanswered, 13/WARN
 *  for deny. args / revisedArgs / reason / card text are never exported. Approvals a cached "always" verdict
 *  answers (tools.ts:122) never reach the hook and so are not recorded.
 *
 *  Pattern sources (shape only, no code copied): Claude Code's monitoring docs (proprietary — pattern mention
 *  only) publish a `tool_decision` event with tool_name + decision (accept|reject) + source; pi
 *  packages/telemetry (MIT @ 853a80d, README.md:385-391) for the attribute policy (ids/outcomes only).
 *  OTLP/JSON field names are the public opentelemetry-proto logs spec, hand-encoded. */

import { kv, resourceAttrs, scopeOf, str, unixNano, type OtlpKeyValue, type OtlpValue } from "./otlp.ts";

export type ApprovalDecision = "allow" | "deny" | "unanswered";
export const SEVERITY_INFO = 9;
export const SEVERITY_WARN = 13;

export interface LogRecord {
  time: number;
  severityNumber: number;
  severityText: string;
  body: string;
  attrs: Map<string, OtlpValue>;
  traceId?: string;
  spanId?: string;
}

// ---------- wire types (OTLP/HTTP JSON, ExportLogsServiceRequest subset) ----------

export interface OtlpLogRecord {
  timeUnixNano: string; observedTimeUnixNano: string;
  severityNumber: number; severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
  traceId?: string; spanId?: string;
}
export interface OtlpLogsRequest {
  resourceLogs: { resource: { attributes: OtlpKeyValue[] }; scopeLogs: { scope: { name: string; version?: string }; logRecords: OtlpLogRecord[] }[] }[];
}

export function encodeLogsRequest(serviceName: string, records: readonly LogRecord[]): OtlpLogsRequest {
  return {
    resourceLogs: [{
      resource: { attributes: resourceAttrs(serviceName) },
      scopeLogs: [{
        scope: scopeOf(),
        logRecords: records.map((r) => ({
          timeUnixNano: unixNano(r.time), observedTimeUnixNano: unixNano(r.time),
          severityNumber: r.severityNumber, severityText: r.severityText,
          body: { stringValue: r.body }, attributes: kv(r.attrs),
          ...(r.traceId ? { traceId: r.traceId } : {}), ...(r.spanId ? { spanId: r.spanId } : {}),
        })),
      }],
    }],
  };
}

// ---------- approval ledger ----------

export interface PendingApproval {
  tool: string;
  sessionId: string;
  /** adapter id of an external lane start (`task start {agent:"codex"}`) */
  lane?: string;
  /** stable fingerprint of the request args, matched against the awaiting span's — null = unknown (tool-only match) */
  fp: string | null;
  at: number;
}
/** what the correlator attaches when exactly one span matched */
export interface ApprovalIds { traceId: string; spanId: string; callId: string }

export interface ApprovalLedger {
  /** a card fired for `tool` (the human is being asked now) */
  request(req: PendingApproval): void;
  /** the oldest pending request for `tool` whose fingerprint matches (or is unknown) — removed and answered */
  resolve(tool: string, fp: string | null, decision: "allow" | "deny", now: number, ids?: ApprovalIds): boolean;
  /** pending requests for `tool` (the correlator's candidate count) */
  pendingFor(tool: string): number;
  /** every request still pending becomes `unanswered` (post_run / session_close) */
  drain(now: number): void;
  /** records recorded since the last take() */
  take(): LogRecord[];
  readonly size: number;
}

export function createApprovalLedger(): ApprovalLedger {
  const pending: PendingApproval[] = [];
  let records: LogRecord[] = [];
  const record = (p: PendingApproval, decision: ApprovalDecision, now: number, ids?: ApprovalIds): void => {
    const attrs = new Map<string, OtlpValue>([["rovecode.tool", str(p.tool)], ["rovecode.session_id", str(p.sessionId)], ["rovecode.decision", str(decision)]]);
    if (p.lane) attrs.set("rovecode.lane", str(p.lane));
    if (ids) attrs.set("rovecode.call_id", str(ids.callId));
    const warn = decision === "deny";
    records.push({ time: now, severityNumber: warn ? SEVERITY_WARN : SEVERITY_INFO, severityText: warn ? "WARN" : "INFO", body: "rovecode.approval", attrs, ...(ids ? { traceId: ids.traceId, spanId: ids.spanId } : {}) });
  };
  return {
    request(req) { pending.push(req); },
    resolve(tool, fp, decision, now, ids) {
      const i = pending.findIndex((p) => p.tool === tool && (p.fp === null || fp === null || p.fp === fp));
      if (i < 0) return false;
      const [p] = pending.splice(i, 1);
      record(p!, decision, now, ids);
      return true;
    },
    pendingFor: (tool) => pending.filter((p) => p.tool === tool).length,
    drain(now) { for (const p of pending.splice(0)) record(p, "unanswered", now); },
    take() { const out = records; records = []; return out; },
    get size() { return records.length; },
  };
}

/** a stable fingerprint of hook-visible args (object keys sorted); undefined when not serializable */
export function argsFingerprint(args: unknown): string | null {
  try {
    return JSON.stringify(args, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v)) ?? null;
  } catch { return null; }
}
