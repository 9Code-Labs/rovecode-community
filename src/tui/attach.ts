/** Port #34 TUI wiring for image input: `/attach` stages image parts for the next user message,
 *  user turns echo (and replay) with image chips, and the stage survives a session switch.
 *
 *  The stage is the SessionStore's own (stageAttachments / stagedAttachments): the store folds it
 *  into the NEXT role:"user" entry that lands in append() — the run's goal message when idle
 *  (loop.ts userMsg), the queued steer when the loop drains it mid-run (loop.ts steering drain) —
 *  so the ONE agentLoop (ADR-003) needs no attach change and the TUI keeps no second copy of the
 *  list. Consequences, documented rather than hidden:
 *  - a steer queued BEFORE /attach is the next user entry and takes the images instead; if the
 *    run ends before any steer is drained, the images ride on the next run's goal message and the
 *    steer text follows it in the same request — nothing is ever dropped;
 *  - /sessions, /resume and a root /rewind replace the store INSTANCE: switchSession carries the
 *    stage across with a visible note (carryOverAttachments); same-store /new and /rewind move
 *    only the leaf, so the stage stays put;
 *  - no image-only messages: the editor drops empty input (pi-renderer.ts onSubmit), so text is
 *    required and every attach note says so — no "(see attached image)" text is invented on the
 *    user's behalf.
 *  Vision check at attach time (catalog.supportsImages on the current mode's model): false → warn
 *  (wire-messages.ts will send a text placeholder), undefined → info (unknown model: sent as-is,
 *  the provider may reject). Paths resolve against the runtime cwd; the loader sniffs magic bytes
 *  (core/images.ts), never the extension. */

import { resolve } from "node:path";
import { checkImageCount, describeImage, imageChip, imageFromBytes, loadImageAttachment, MAX_IMAGES_PER_MESSAGE } from "../core/images.ts";
import { clipboardImageName, readClipboardImage } from "./clipboard-image.ts";
import type { SessionStore } from "../core/session.ts";
import type { ImagePart, MessagePart } from "../core/types.ts";
import { supportsImages } from "../providers/catalog.ts";
import type { Renderer, SlashCommand } from "./renderer.ts";

/** The TUI_COMMANDS entry (/help, palette, custom-command reserved names). */
export const ATTACH_COMMAND: SlashCommand = {
  name: "attach",
  description: "Attach an image to your next message (text required): /attach <path> · /attach = list · /attach clear · or drag an image file onto the terminal",
};

export interface AttachCtx {
  renderer: Renderer;
  /** runtime cwd — relative paths resolve against it */
  cwd: string;
  /** the ACTIVE store, read live (/sessions and a root /rewind swap it) */
  store(): SessionStore;
  /** the current mode's model — the vision check */
  modelRef(): { provider: string; model: string };
}

const plural = (n: number): string => `${n} image${n === 1 ? "" : "s"}`;

/** `/attach <path>` stages one image · `/attach` lists the stage · `/attach clear` empties it.
 *  Never throws: a bad file, an oversize image or the 9th image is a note, nothing staged. */
export function cmdAttach(ctx: AttachCtx, arg: string): void {
  const { renderer } = ctx;
  const store = ctx.store();
  const staged = store.stagedAttachments;
  if (arg === "") {
    renderer.addSystemNote(staged.length === 0
      ? "no images attached — /attach <path>"
      : `attached (${staged.length}/${MAX_IMAGES_PER_MESSAGE}):\n${staged.map((p, i) => `${i + 1}. ${describeImage(p)}`).join("\n")}`);
    return;
  }
  if (arg === "clear") {
    store.stageAttachments([]);
    renderer.addSystemNote(staged.length === 0 ? "no images attached" : `attachments cleared (${plural(staged.length)} removed)`);
    return;
  }
  const path = arg.replace(/^(["'])(.*)\1$/, "$2"); // a quoted path keeps its spaces
  const loaded = loadImageAttachment(resolve(ctx.cwd, path));
  if ("error" in loaded) { renderer.addSystemNote(loaded.error, "error"); return; }
  const over = checkImageCount(staged.length + 1);
  if (over !== undefined) { renderer.addSystemNote(over, "error"); return; }
  store.stageAttachments([...staged, loaded]); // replaces the stage; folds into the next user entry
  renderer.addSystemNote(`attached ${describeImage(loaded)} (${staged.length + 1}/${MAX_IMAGES_PER_MESSAGE}) — type your message and press Enter to send it`);
  const ref = ctx.modelRef();
  const vision = supportsImages(ref);
  if (vision === false) renderer.addSystemNote(`model ${ref.provider}/${ref.model} has no image input — it will be sent as a text placeholder`, "warn");
  else if (vision === undefined) renderer.addSystemNote(`unknown model ${ref.provider}/${ref.model}; image sent as-is (provider may reject)`);
}

/** `/paste` — the clipboard image as an attachment (⌃v in the sextant surface lands here). */
export const PASTE_COMMAND: SlashCommand = {
  name: "paste",
  description: "attach the image on the clipboard (⌃v)",
};

/** Stage the image currently on the system clipboard. Berkay: "gorsel gonderebilme olayini yapalim" —
 *  /attach <path> existed, but the thing everyone tries first is copying a screenshot and pressing ⌃v,
 *  and a terminal delivers only TEXT pastes, so that did nothing. tui/clipboard-image.ts asks the OS.
 *  Same rules as /attach: magic-byte sniff, size cap, the 8-image cap, the vision note; never throws.
 *  `read` is injectable (tests never touch a real clipboard). */
export function cmdPasteImage(ctx: AttachCtx, read: () => Uint8Array | null = () => readClipboardImage(), name = clipboardImageName()): void {
  const { renderer } = ctx;
  const bytes = read();
  if (bytes === null) { renderer.addSystemNote("no image on the clipboard — copy a screenshot or picture first, or /attach <path>"); return; }
  const loaded = imageFromBytes(bytes, { name });
  if ("error" in loaded) { renderer.addSystemNote(loaded.error, "error"); return; }
  const store = ctx.store();
  const staged = store.stagedAttachments;
  const over = checkImageCount(staged.length + 1);
  if (over !== undefined) { renderer.addSystemNote(over, "error"); return; }
  store.stageAttachments([...staged, loaded]);
  renderer.addSystemNote(`attached ${describeImage(loaded)} from the clipboard (${staged.length + 1}/${MAX_IMAGES_PER_MESSAGE}) — type your message and press Enter to send it`);
  const ref = ctx.modelRef();
  const vision = supportsImages(ref);
  if (vision === false) renderer.addSystemNote(`model ${ref.provider}/${ref.model} has no image input — it will be sent as a text placeholder`, "warn");
}

/** Transcript line for a user turn: the text, then one chip per image on a second line; an
 *  image-only turn is just its chips; "" when there is nothing to show. Used by the submit echo
 *  (with the stage about to fold) and by replay (with the persisted parts). */
export function userTurnLine(text: string, parts: readonly MessagePart[]): string {
  const chips = parts.filter((p): p is ImagePart => p.kind === "image").map(imageChip).join(" ");
  return text && chips ? `${text}\n${chips}` : text || chips;
}

/** Suffix for the busy-submit note: what the queued steer will carry when the loop drains it. */
export function queuedAttachNote(store: SessionStore): string {
  const n = store.stagedAttachments.length;
  return n === 0 ? "" : ` — ${plural(n)} attached to your queued message`;
}

/** After a store swap (/sessions, /resume, root /rewind): re-stage the images the OLD instance held
 *  on the new one and say so — the switch must never lose them silently. */
export function carryOverAttachments(ctx: AttachCtx, pending: readonly ImagePart[]): void {
  if (pending.length === 0) return;
  ctx.store().stageAttachments(pending);
  ctx.renderer.addSystemNote(`${plural(pending.length)} still attached — carried over to this session, rides on your next message`);
}
