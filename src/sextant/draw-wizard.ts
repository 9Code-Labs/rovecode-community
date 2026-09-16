/** The connect wizard (/connect, /setup on the sextant surface): ONE overlay that walks a model
 *  connection end to end — provider, key, model, test — instead of a chain of pickers that each
 *  close and reopen. Berkay's design, chosen 2026-09-08: a COLUMNED wizard, the left column the step
 *  headers (✓ done / ● current / ○ ahead) and the right side the current step's content, separated by
 *  SPACE (his pick over a dim rule and a filled block), so the header column reads as an index rather
 *  than a frame.
 *
 *  Like draw-context.ts this file owns FLAT view types and imports no registry: the adapter that opens
 *  the wizard (sextant-renderer.ts openWizard) maps the provider table onto `WizardState`, and the
 *  effects the keys request come back as requests the renderer owns (keys.ts has no registry either).
 *  A test builds a state by hand.
 *
 *  THE SECRET ROW: the key step's input is masked (•••). This is the only typed secret anywhere in the
 *  surface — the question card types in the clear because its answers are conversation, and /provider
 *  key refuses on-card entry for the same reason this wizard exists: a key typed in the clear lands in
 *  the transcript. The wizard is not the composer; its input is a form field. */

import { st } from "./draw-util.ts";
import { openOverlay } from "./overlays.ts";
import { ATTR, type HitZone, type KeyEvent, type Layout, type ScreenLike, type SextantState, type Theme } from "./types.ts";

// ------------------------------------------------------------------ state

/** one provider row in step 1 — flat, from SETUP_PICKS + the registry's knowledge */
export interface WizardProvider {
  key: string;
  label: string;
  /** true when the registry already has a working entry: shown, and stepping onto it skips to MODEL */
  configured?: boolean;
  /** a local server: the KEY step is skipped for it */
  local?: boolean;
  /** one of the two "your own URL" doors (SETUP_PICKS 8/9): no registry row exists until the wizard
   *  has asked for a short id and a base URL and REGISTERED it — the protocol the row speaks */
  url?: "openai" | "anthropic";
}

/** what step 3 lists: the models the registry can name for the chosen provider (endpoint or file).
 *  `active` = the provider's pinned list today (spec.models — what /models serves from the file);
 *  `defaultModel` = the row's default. Both are FACTS the row carries, painted as tags, and the
 *  checked set starts FROM `active` so the step's opening state is the provider's current truth
 *  rather than a blank form that silently re-pins everything away. */
export interface WizardModel { id: string; note?: string; active?: boolean; defaultModel?: boolean }

/** The four steps, in walk order. ENDPOINT (id + base URL) is walked only for a url door row.
 *  There is no TEST step (Berkay, 2026-09-10): the walk ENDS at MODEL — the checked list is pinned
 *  and the default set the moment ⏎ confirms, no probe call runs after it. */
export const WIZARD_STEPS = ["PROVIDER", "ENDPOINT", "KEY", "MODEL"] as const;
export type WizardStepName = (typeof WIZARD_STEPS)[number];

export interface WizardState {
  /** 0..4 — WIZARD_STEPS[step] is current; a url door walks ENDPOINT (1), a local server skips KEY (2) */
  step: number;
  providers: WizardProvider[];
  /** index into `providers` once chosen */
  selected: number;
  /** the typed short id (ENDPOINT step) — the registry row this door will register under */
  idTyped: string;
  /** the typed base URL (ENDPOINT step) */
  urlTyped: string;
  /** which of the two ENDPOINT fields the caret is on: false = the id, true = the URL */
  urlField: boolean;
  /** the masked key input — the secret itself, never painted */
  secret: string;
  /** false while the key step is being confirmed: a paste that failed to store stays editable */
  keyAccepted: boolean;
  models: WizardModel[];
  /** index into `models`, or -1 when the list is empty and the id is typed */
  modelSel: number;
  /** the CHECKED model ids, in list order — what confirmModels carries as `models`. Space toggles
   *  the row under the caret; the set starts as the provider's `active` list, so an untouched walk
   *  through the step re-pins exactly what was already pinned (no silent change). */
  modelChecked: readonly string[];
  /** the id ⏎ will name as makeDefault: the marked row, or the FIRST checked one. The default is a
   *  separate fact from the list — every checked row becomes active, exactly one becomes default. */
  modelDefaultTo: string | undefined;
  /** the typed model id when the list is empty (a proxy with no /models endpoint) */
  modelTyped: string;
  /** true from the moment the step opens until the endpoint answers (or fails): an empty list the
   *  person can SEE is loading is a different thing from an empty list that claims there is none */
  modelsLoading: boolean;
  /** one line under the content when a step refused to advance (bad key, empty model id…) */
  error?: string;
}

/** open the wizard at its first step; the adapter has already built the provider rows */
export function openWizard(s: SextantState, providers: WizardProvider[]): void {
  openOverlay(s, null); // one overlay at a time — closes palette/market/help/context like every opener
  s.wizard = { step: 0, providers, selected: 0, idTyped: "", urlTyped: "", urlField: false, secret: "", keyAccepted: false, models: [], modelSel: 0, modelChecked: [], modelDefaultTo: undefined, modelTyped: "", modelsLoading: false };
}
export function closeWizard(s: SextantState): void { s.wizard = null; }

// ------------------------------------------------------------------ view (pure — tests read these)

export const MASK = "•";
/** the masked row: one • per code point, capped so a pasted 2 KB token cannot push the layout */
export const MASKED_MAX = 24;
export function masked(secret: string): string {
  const n = [...secret].length;
  return MASK.repeat(Math.min(n, MASKED_MAX)) + (n > MASKED_MAX ? ` ${n - MASKED_MAX} more` : "");
}

/** the left column's marker for step i: done, current or ahead */
export function stepMarker(i: number, step: number): string { return i < step ? "✓" : i === step ? "●" : "○"; }

/** what the right side of each step shows, as plain lines tagged with a tone — the drawer paints them,
 *  the tests pin them. `secretLine` is the masked row; `caret` marks the row the caret sits on. */
export type WizardTone = "head" | "normal" | "dim" | "warn" | "ok" | "accent";
export interface WizardLine { text: string; tone: WizardTone; caret?: boolean }

export function wizardLines(w: WizardState): WizardLine[] {
  const provider = w.providers[w.selected];
  const out: WizardLine[] = [];
  if (w.step === 0) {
    out.push({ text: "Which provider? ↑↓ choose, ⏎ confirm.", tone: "head" });
    w.providers.forEach((p, i) => out.push({ text: `${i === w.selected ? "❯ " : "  "}${p.label}${p.configured ? "  · already set up" : ""}`, tone: i === w.selected ? "accent" : "normal" }));
    return out;
  }
  if (provider === undefined) return out;
  if (w.step === 1) {
    // the url door's own two fields: a short id (the registry row this becomes) and the base URL.
    // ONE caret — on the active field, after its text (the inactive field is dim, no caret anywhere
    // else: two ▌ on screen at once read as two fields being typed into at the same time).
    const idCaret = !w.urlField;
    out.push({ text: `${provider.label.split(" (")[0] ?? provider.label} — name it and point it at the server.`, tone: "head" });
    out.push({ text: `Short name?  ${w.idTyped}${idCaret ? "▌" : ""}`, tone: idCaret ? "normal" : "dim", ...(idCaret ? { caret: true } : {}) });
    out.push({ text: `Base URL?    ${w.urlTyped}${w.urlField ? "▌" : ""}`, tone: w.urlField ? "normal" : "dim", ...(w.urlField ? { caret: true } : {}) });
    out.push({ text: "⇥ switches the field · ⏎ registers it and moves to the key", tone: "dim" });
    if (w.error !== undefined) out.push({ text: w.error, tone: "warn" });
    return out;
  }
  if (w.step === 2) {
    out.push({ text: `Paste the API key for ${provider.label.split(" — ")[0] ?? provider.label}.`, tone: "head" });
    out.push({ text: "It is stored in the credentials file, never in the transcript.", tone: "dim" });
    out.push({ text: "", tone: "dim" });
    out.push({ text: masked(w.secret) || "", tone: "normal", caret: true });
    if (w.error !== undefined) out.push({ text: w.error, tone: "warn" });
    return out;
  }
  if (w.step === 3) {
    out.push({ text: `Which models on ${provider.label.split(" — ")[0] ?? provider.label}? Space checks, ⏎ confirms.`, tone: "head" });
    if (w.modelsLoading && w.models.length === 0) {
      out.push({ text: "Fetching the model list from the endpoint…", tone: "accent" });
      return out;
    }
    if (w.models.length > 0) {
      w.models.forEach((m, i) => {
        // the checkbox is the row's state (✓ checked / ☐ not); the tags behind the id are the
        // provider's OWN facts — `active` (pinned today) and `default` — so the person edits a list
        // they can see the current truth of, and `•` marks which checked row becomes the default
        const checked = w.modelChecked.includes(m.id);
        const tags = `${m.active === true ? " · active" : ""}${m.defaultModel === true ? " · default" : ""}`;
        const mark = checked && w.modelDefaultTo === m.id ? "•" : "";
        out.push({ text: `${i === w.modelSel ? "❯ " : "  "}${checked ? "✓" : "☐"} ${m.id}${tags}${mark ? ` ${mark}` : ""}`, tone: i === w.modelSel ? "accent" : "normal" });
      });
    } else {
      out.push({ text: "No model list from this endpoint — type the model id:", tone: "dim" });
      out.push({ text: w.modelTyped, tone: "normal", caret: true });
    }
    if (w.error !== undefined) out.push({ text: w.error, tone: "warn" });
    return out;
  }
  return out;
}

// ------------------------------------------------------------------ draw

export function drawWizard(scr: ScreenLike, L: Layout, C: Theme, s: SextantState, hits?: HitZone[]): { x: number; y: number } | null {
  const w = s.wizard;
  if (!w) return null;
  hits?.push({ rect: { x: 0, y: 0, w: L.w, h: L.h }, onClick: () => { /* the box below swallows it */ } });

  const lines = wizardLines(w);
  const w0 = Math.min(L.w - 4, 64);
  const h = Math.max(10, Math.min(L.h - 4, Math.max(WIZARD_STEPS.length, lines.length) + 5));
  const x = Math.floor((L.w - w0) / 2), y = Math.max(1, Math.floor((L.h - h) / 2));
  scr.box(x, y, w0, h, st(C.accent), C.bg2);
  scr.text(x + 2, y, [[" connect a model ", st(C.accent, -1, ATTR.BOLD)]]);
  scr.put(x + w0 - 13, y, " esc closes ", st(C.dim, C.bg2));
  hits?.push({ rect: { x, y, w: w0, h }, onClick: () => {} }); // a click inside is not a close

  // the left column: the step headers, MARKED — done ✓ / current ● / ahead ○. Space separates the
  // columns (Berkay's pick): no rule, no fill — the markers carry the progression on their own.
  const leftW = 13;
  WIZARD_STEPS.forEach((name, i) => {
    const current = i === w.step;
    scr.put(x + 2, y + 2 + i, `${stepMarker(i, w.step)} ${name}`, current ? st(C.accent, C.bg2, ATTR.BOLD) : i < w.step ? st(C.fg2, C.bg2) : st(C.muted, C.bg2));
  });

  // the right side: the step's lines, clipped to the inner width, with the caret row on the box's edge
  const innerX = x + 2 + leftW + 2;
  const innerW = Math.max(10, w0 - (innerX - x) - 3);
  const rows = h - 3;
  lines.slice(0, rows).forEach((line, i) => {
    const style = line.tone === "head" ? st(C.fg, C.bg2, ATTR.BOLD)
      : line.tone === "warn" ? st(C.warn, C.bg2)
      : line.tone === "ok" ? st(C.ok, C.bg2)
      : line.tone === "accent" ? st(C.accent, C.bg2)
      : line.tone === "dim" ? st(C.muted, C.bg2)
      : st(C.fg2, C.bg2);
    // a caret row with TEXT carries its own ▌ in the text (the endpoint fields); an EMPTY caret row
    // (the masked secret, the typed model id) gets the ▌ painted here — exactly one caret either way
    const text = line.text === "" && line.caret ? "" : line.text;
    scr.clip(innerX, y + 1 + i, line.caret && line.text === "" ? `${text}▌` : text, style, innerW + 1);
  });

  // the footer hints, under both columns
  const back = w.step > 0 ? "  ← back" : "";
  scr.put(x + 2, y + h - 1, `⏎ ${w.step === 0 ? "choose" : "next"}${back}   esc cancel`, st(C.dim, C.bg2));
  return null; // no composer caret: the wizard paints its own on the secret/model row
}

// ------------------------------------------------------------------ keys

/** What a key asked the renderer to DO. keys.ts owns no registry: the requests come back here and
 *  sextant-renderer.ts runs them against the live runtime. `none` = the key only moved the state. */
export type WizardRequest =
  | { kind: "none" }
  /** ENDPOINT confirmed for a url door: register the row (reg.add) under this id/URL/protocol */
  | { kind: "registerEndpoint"; id: string; url: string; protocol: "openai" | "anthropic" }
  /** KEY confirmed with a non-empty secret: store it (saveCredential + refresh) */
  | { kind: "storeKey"; provider: string; secret: string }
  /** MODEL confirmed (from a list): the CHECKED ids in list order — what the provider's active list
   *  becomes (setModels) — and `makeDefault`, the id that also becomes the default (the marked row,
   *  else the first checked; undefined only in the typed fallback, where there is no list to edit) */
  | { kind: "confirmModels"; provider: string; models: string[]; makeDefault: string | undefined }
  /** MODEL confirmed by TYPING (no list from the endpoint): one id, no list to pin */
  | { kind: "confirmModel"; model: string }
  /** the model step OPENED (or was re-entered after a key change): load the endpoint's list —
   *  the renderer fetches through the wizardModels seam and answers with wizardModelConfirmed */
  | { kind: "loadModels" };

/** A paste, while the wizard is up — the KEY step's whole input method: a key arrives as ONE paste
 *  event, not as keystrokes, and keys.ts's onPaste routes every paste it does not recognise into the
 *  composer (which is how the pasted key ended up in the chat box). Returns true when the paste was
 *  consumed: KEY appends to the secret, MODEL appends to the typed id when there is no list, and
 *  every other step swallows it (a paste onto a list step is not a selection). Multi-line text
 *  collapses to one space — a secret or a model id is one line, and a trailing newline from a
 *  terminal copy never becomes part of it. */
export function wizardPaste(s: SextantState, text: string): boolean {
  const w = s.wizard;
  if (!w) return false;
  const one = text.replace(/\s+/g, " ");
  if (w.step === 1) { if (w.urlField) w.urlTyped += one; else w.idTyped += one; }
  else if (w.step === 2) w.secret += one;
  else if (w.step === 3 && w.models.length === 0) w.modelTyped += one;
  else return true; // swallowed, not typed: nothing leaves the overlay
  w.error = undefined;
  return true;
}

/** Keys, while the wizard is up. Swallows everything (an overlay that let keystrokes reach the
 *  composer would type into a message the human cannot see) except ⌃c, which closes like every overlay. */
export function onWizardKey(s: SextantState, ev: KeyEvent): WizardRequest {
  const w = s.wizard;
  if (!w) return { kind: "none" };
  const { name, ctrl, ch, alt } = ev;
  if (name === "escape" || (ctrl && name === "c")) { closeWizard(s); return { kind: "none" }; }

  // the ENDPOINT step's two fields: ⇥ (and ⇧⇥) move the caret between the id and the URL
  if (w.step === 1) {
    if (name === "tab" || name === "shift-tab") { w.urlField = !w.urlField; return { kind: "none" }; }
  }
  const inList = w.step === 0 || (w.step === 3 && w.models.length > 0);
  if (inList) {
    const n = w.step === 0 ? w.providers.length : w.models.length;
    if (name === "up" || name === "k") { if (w.step === 0) w.selected = (w.selected - 1 + n) % n; else w.modelSel = (w.modelSel - 1 + n) % n; return { kind: "none" }; }
    if (name === "down" || name === "j") { if (w.step === 0) w.selected = (w.selected + 1) % n; else w.modelSel = (w.modelSel + 1) % n; return { kind: "none" }; }
    if (name === "tab" && w.step === 3) { w.modelSel = (w.modelSel + 1) % n; return { kind: "none" }; }
    // space on the model list: check/uncheck the row under the caret. Checking the FIRST box moves
    // the default marker onto it (there was none); unchecking the marked row moves the marker to the
    // next checked row — the default is always a checked id, never a ghost
    if ((name === "space" || (ch === " " && !ctrl && !alt)) && w.step === 3) { toggleModelCheck(w); return { kind: "none" }; }
  }
  if (name === "left" && w.step > 0) { w.step -= 1; w.error = undefined; return { kind: "none" }; }
  if (name === "enter") return wizardConfirm(s);

  // the three typing steps: ENDPOINT (the two fields), KEY, and MODEL when the list is empty AND
  // the fetch has answered (while loading there is no field to type into yet — keys wait)
  const typing = w.step === 1 || w.step === 2 || (w.step === 3 && w.models.length === 0 && !w.modelsLoading);
  if (typing) {
    if (name === "backspace") {
      if (w.step === 1) { if (w.urlField) w.urlTyped = [...w.urlTyped].slice(0, -1).join(""); else w.idTyped = [...w.idTyped].slice(0, -1).join(""); }
      else if (w.step === 2) w.secret = [...w.secret].slice(0, -1).join("");
      else w.modelTyped = [...w.modelTyped].slice(0, -1).join("");
      w.error = undefined;
      return { kind: "none" };
    }
    const c = name === "space" ? " " : ch;
    if (!c || alt || ctrl) return { kind: "none" };
    if (w.step === 1) { if (w.urlField) w.urlTyped += c; else w.idTyped += c; }
    else if (w.step === 2) w.secret += c;
    else w.modelTyped += c;
    w.error = undefined;
    return { kind: "none" };
  }
  return { kind: "none" };
}

/** ⏎ on the current step: advance, refuse with an error line, or emit the step's request */
function wizardConfirm(s: SextantState): WizardRequest {
  const w = s.wizard!;
  const provider = w.providers[w.selected];
  if (w.step === 0) {
    if (provider === undefined) return { kind: "none" };
    w.error = undefined;
    // a url door names its endpoint first; a local server has no key step; a configured provider's key already works
    const skip = provider.url !== undefined ? 1 : provider.local === true || provider.configured === true ? 3 : 2;
    w.step = skip;
    return skip === 3 ? { kind: "loadModels" } : { kind: "none" };
  }
  if (w.step === 1) {
    if (provider === undefined || provider.url === undefined) return { kind: "none" };
    const id = w.idTyped.trim().toLowerCase();
    if (id.length === 0) { w.error = "the short name is empty — it becomes the registry row's id"; return { kind: "none" }; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) { w.error = `"${id}" won't work as an id — letters, digits, - _ . (myproxy, vllm-home)`; return { kind: "none" }; }
    if (!/^https?:\/\//.test(w.urlTyped.trim())) { w.error = `"${w.urlTyped.trim()}" is not an http(s) URL — the base URL the server answers on`; return { kind: "none" }; }
    w.error = undefined;
    return { kind: "registerEndpoint", id, url: w.urlTyped.trim(), protocol: provider.url };
  }
  if (w.step === 2) {
    const secret = w.secret.trim();
    if (secret.length === 0) { w.error = "the key is empty — paste it, or ← back to change provider"; return { kind: "none" }; }
    if (provider === undefined) return { kind: "none" };
    w.error = undefined;
    return { kind: "storeKey", provider: provider.key, secret };
  }
  if (w.step === 3) {
    if (provider === undefined) return { kind: "none" };
    if (w.models.length > 0) {
      const checked = w.models.filter((m) => w.modelChecked.includes(m.id)).map((m) => m.id);
      if (checked.length === 0) { w.error = "no model checked — space checks a row, or ← back to the key"; return { kind: "none" }; }
      w.error = undefined;
      const makeDefault = w.modelDefaultTo !== undefined && checked.includes(w.modelDefaultTo) ? w.modelDefaultTo : checked[0]!;
      return { kind: "confirmModels", provider: provider.key, models: checked, makeDefault };
    }
    const model = w.modelTyped.trim();
    if (model.length === 0) { w.error = "no model chosen — pick a row or type the id"; return { kind: "none" }; }
    w.error = undefined;
    return { kind: "confirmModel", model };
  }
  return { kind: "none" };
}

/** the renderer's answers, written back onto the state: registerEndpoint → the row exists now (or
 *  the error line says why not); storeKey → advance or refuse; confirmModel → the model list / advance;
 *  runTest → the probe outcome. */
export function wizardEndpointRegistered(w: WizardState, ok: boolean, error?: string): void {
  if (ok) { w.step = 2; w.error = undefined; }
  else w.error = error ?? "the endpoint could not be registered";
}
export function wizardKeyStored(w: WizardState, ok: boolean, error?: string): void {
  if (ok) { w.keyAccepted = true; w.step = 3; w.modelsLoading = true; w.error = undefined; }
  else { w.keyAccepted = false; w.error = error ?? "the key could not be stored"; }
}
export function wizardModelConfirmed(w: WizardState, models: WizardModel[]): void {
  w.models = models;
  w.modelsLoading = false;
  w.modelSel = 0;
  // the checked set starts as the provider's OWN active list (a fact the rows carry): an untouched
  // pass through the step re-pins what was pinned, and the default marker starts on the row that is
  // the provider's default today — the form opens on the current truth, not on blank
  w.modelChecked = models.filter((m) => m.active === true).map((m) => m.id);
  const def = models.find((m) => m.defaultModel === true);
  w.modelDefaultTo = def !== undefined && w.modelChecked.includes(def.id) ? def.id : w.modelChecked[0];
  w.step = 3;
  w.error = undefined;
}

/** space on a model row: check/uncheck it, keeping the default marker on a CHECKED row */
export function toggleModelCheck(w: WizardState): void {
  const m = w.models[w.modelSel];
  if (m === undefined) return;
  const has = w.modelChecked.includes(m.id);
  const next = has ? w.modelChecked.filter((id) => id !== m.id) : [...w.modelChecked, m.id];
  w.modelChecked = next;
  if (w.modelDefaultTo === undefined || !next.includes(w.modelDefaultTo)) w.modelDefaultTo = next[0];
  w.error = undefined;
}
