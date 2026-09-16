/** Approval-card text for external lanes (#47). Starting a lane is the existing `spawn` action of the
 *  `task` tool (gated rules prompt ONCE, at dispatch — core/tools.ts:118-133), and the card the human
 *  sees is built from the ApprovalRequest: the classic TUI shows `tool` + JSON of `revisedArgs` (tui/
 *  app.ts:286), so the lane's own permission flags must be IN the request BEFORE the lane starts. This
 *  decorator sits outermost in the ApprovalFn chain (cli/runtime.ts buildCfg: lanes → execpolicy →
 *  approval hook → human) and, for a `task start` that names an external lane, rewrites `reason` to the
 *  card text and puts it FIRST in `revisedArgs` (`lane: "spawn codex lane · sandbox workspace-write …"`)
 *  so it survives the 140-char preview. Everything else passes through untouched; codex/agy grant their
 *  permissions up front by flag, which is exactly why the card must state them here and not mid-run. */

import type { ApprovalFn } from "../core/types.ts";
import { isObj } from "./events.ts";
import { laneApprovalText, type Env } from "./registry.ts";

export function laneApprover(next: ApprovalFn | undefined, env: Env = process.env): ApprovalFn | undefined {
  if (!next) return undefined; // no approver = fail closed at dispatch, unchanged
  return (req) => {
    if (req.tool !== "task") return next(req);
    const args = req.revisedArgs ?? req.args;
    const text = laneApprovalText(args, env);
    if (!text) return next(req);
    return next({ ...req, reason: text, revisedArgs: { lane: text, ...(isObj(args) ? args : {}) } });
  };
}
