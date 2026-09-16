/** Port #78: --plain shell/mention parity over rovecode's existing dispatch and hashline attachments.
 *  No second executor, classifier, policy or file reader. Unlike aion, rovecode's approval contract has
 *  once/always/deny (no persistent-save verdict), and mentions carry read-tool anchors, not XML file blocks.
 *  This console renderer shares the REPL's once/always/deny approval ladder; git confirmations stay yes/no. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Runtime } from "../cli/runtime.ts";
import type { ApprovalFn } from "../core/types.ts";
import { expandMentions } from "../sextant/mentions.ts";
import { cmdAttach, type AttachCtx } from "./attach.ts";
import type { Renderer } from "./renderer.ts";
import { runShellLine, type ShellCtx } from "./shell-cmd.ts";

export const PLAIN_APPROVAL_QUESTION = "  allow? [y]es / [a]lways / [n]o: ";
type Ask = (question: string) => Promise<string>;
type Out = (line: string) => void;
const NL = String.fromCharCode(10);

/** The existing REPL ladder, shared by model calls and shell calls; always is session-only. */
export async function askPlainApproval(ask: Ask, tool: string, args: string, detail?: string, out: Out = console.log): ReturnType<ApprovalFn> {
  out(`${NL}  approval needed: ${tool} ${args}`);
  if (detail) for (const line of detail.split(NL)) out(`    ${line}`);
  const answer = await ask(PLAIN_APPROVAL_QUESTION);
  return answer === "a" ? "always" : answer === "n" || answer === "" ? "deny" : "once";
}

export interface PlainInputDeps {
  rt: ShellCtx["rt"] & Pick<Runtime, "store" | "roots">;
  yolo(): boolean;
  busy(): boolean;
  bindAbort(ac: AbortController | null): void;
  ask: Ask;
  modelRef(): { provider: string; model: string };
  out?: Out;
}

/** Readline already echoed the typed input; only the tool cards and notes are printed here. */
export function plainInputRenderer(ask: Ask, out: Out): Renderer {
  return {
    start() {}, stop() {}, setCommands() {}, addUser() {},
    addSystemNote(text, tone = "info") { out(`  ${tone === "info" ? "" : `${tone}: `}${text}`); },
    beginAssistant() { return { append() {}, done() {} }; },
    toolStart(_id, tool, args) { out(`${NL}  → ${tool} ${args}`); },
    toolUpdate() {},
    toolEnd(_id, ok, preview) { out(`  ← ${ok ? "ok" : "FAIL"} ${preview.split(NL).join(" ⏎ ")}`); },
    askApproval: (tool, args, detail) => askPlainApproval(ask, tool, args, detail, out),
    async askQuestion() { return null; }, async pickOne() { return null; },
    clearTranscript() {}, prefillEditor() {}, setBusy() {}, setStatus() {},
  };
}

export async function runPlainShellLine(deps: PlainInputDeps, line: string): Promise<void> {
  const out = deps.out ?? console.log;
  const ctx: ShellCtx = {
    renderer: plainInputRenderer(deps.ask, out), rt: deps.rt, store: () => deps.rt.store,
    level: () => deps.yolo() ? "auto" : "ask",
    approve: () => deps.yolo() ? undefined : (req) => askPlainApproval(deps.ask, req.tool, JSON.stringify(req.revisedArgs).slice(0, 140), undefined, out),
    busy: () => deps.busy(), setBusy() {}, bindAbort: (ac) => deps.bindAbort(ac),
  };
  await runShellLine(ctx, line);
}

/** LAST transform before agentLoop: exact paths (like the classic renderer), added roots, existing
 *  containment/caps, valid edit anchors, and images staged on the same SessionStore through cmdAttach. */
export function expandPlainInput(deps: PlainInputDeps, text: string): string {
  const renderer = plainInputRenderer(deps.ask, deps.out ?? console.log);
  const attach: AttachCtx = { renderer, cwd: deps.rt.cwd, store: () => deps.rt.store, modelRef: () => deps.modelRef() };
  const result = expandMentions(text, {
    cwd: deps.rt.cwd, roots: deps.rt.roots.dirs,
    resolve: (path) => existsSync(resolve(deps.rt.cwd, path)) ? path : null,
    attachImage: (path) => cmdAttach(attach, path),
  });
  for (const note of result.notes) renderer.addSystemNote(note, note.includes(": attached as an image (") ? "info" : "warn");
  if (result.attached.length > 0) renderer.addSystemNote(`attached: ${result.attached.map((file) => `${file.path} (${file.shown} lines${file.capped ? ", capped" : ""})`).join(" · ")}`);
  return result.text;
}
