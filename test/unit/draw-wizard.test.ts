/** The connect wizard (draw-wizard.ts): the walk, the masking, the skip rules — as pure lines and
 *  pure key transitions, no terminal. What each test pins is a way the wizard could lie:
 *    - a typed key that LEAKS (painted in the clear) — the whole reason this overlay exists
 *    - a step order that lets a MODEL be confirmed without a KEY having been stored
 *    - a local/configured provider that still walks the KEY step it has no use for
 *    - the overlay contract (openWizard closes everything else; the invariant test's fifth member)
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WIZARD_STEPS, masked, MASKED_MAX, stepMarker, wizardLines, wizardModelConfirmed,
  wizardKeyStored, wizardEndpointRegistered, onWizardKey, openWizard, closeWizard, wizardPaste,
  type WizardProvider, type WizardState,
} from "../../src/sextant/draw-wizard.ts";
import { makeState, spyCtx } from "../helpers/sextant-fixtures-keys.ts";
import type { KeyEvent } from "../../src/sextant/types.ts";

const key = (name: string, ch?: string): KeyEvent => ({ type: "key", name, ...(ch !== undefined ? { ch } : {}) });

const PROVIDERS: WizardProvider[] = [
  { key: "1", label: "anthropic — Claude models" },
  { key: "6", label: "ollama — local, no key needed", local: true },
  { key: "2", label: "openai", configured: true },
];

function wizard(over: Partial<WizardState> = {}): WizardState {
  return { step: 0, providers: PROVIDERS, selected: 0, idTyped: "", urlTyped: "", urlField: false, secret: "", keyAccepted: false, models: [], modelSel: 0, modelChecked: [], modelDefaultTo: undefined, modelTyped: "", modelsLoading: false, ...over };
}

// ------------------------------------------------------------------ the mask

test("masked(): one • per CODE POINT (😀 is one glyph), capped at 24 with a count — never the secret itself", () => {
  expect(masked("")).toBe("");
  expect(masked("sk-abc")).toBe("••••••");
  expect(masked("a😀b")).toBe("•••"); // three code points, not four UTF-16 units
  const long = "x".repeat(MASKED_MAX + 5);
  expect(masked(long)).toBe("•".repeat(MASKED_MAX) + " 5 more");
});

// ------------------------------------------------------------------ the columns

test("the left column: ✓ done / ● current / ○ ahead, in walk order PROVIDER ENDPOINT KEY MODEL — no TEST step (the walk ends at MODEL)", () => {
  expect(WIZARD_STEPS).toEqual(["PROVIDER", "ENDPOINT", "KEY", "MODEL"]);
  expect([0, 1, 2, 3].map((i) => stepMarker(i, 1))).toEqual(["✓", "●", "○", "○"]);
});

test("step 0's content lists the providers with the selection marked and configured rows said", () => {
  const lines = wizardLines(wizard({ selected: 1 }));
  expect(lines[0]).toMatchObject({ text: "Which provider? ↑↓ choose, ⏎ confirm.", tone: "head" });
  expect(lines[1]).toMatchObject({ text: "  anthropic — Claude models", tone: "normal" });
  expect(lines[2]).toMatchObject({ text: "❯ ollama — local, no key needed", tone: "accent" });
  expect(lines[3]).toMatchObject({ text: "  openai  · already set up", tone: "normal" });
});

test("the KEY step's content NEVER contains the secret — the masked row is the only trace", () => {
  const lines = wizardLines(wizard({ step: 2, secret: "sk-VERYSECRET-VALUE" }));
  const flat = lines.map((l) => l.text).join("\n");
  expect(flat).toContain("•".repeat(19));                       // the masked row is there…
  expect(flat).not.toContain("SECRET");                          // …and the secret is not, anywhere
  expect(lines.some((l) => l.caret)).toBe(true);                 // the caret rides the masked row
});

// ------------------------------------------------------------------ the walk

test("⏎ on a remote provider advances PROVIDER → KEY; a LOCAL provider skips KEY; a CONFIGURED one skips it too", () => {
  const a = wizard({ selected: 0 });
  onWizardKey({ ...makeState(), wizard: a }, key("enter"));
  expect(a.step).toBe(2);                                       // anthropic needs a key

  const b = wizard({ selected: 1 });                            // ollama: no key step
  expect(onWizardKey({ ...makeState(), wizard: b }, key("enter"))).toEqual({ kind: "loadModels" });
  expect(b.step).toBe(3);                                       // …and the step OPENS by fetching

  const c = wizard({ selected: 2 });                            // openai: key already works
  expect(onWizardKey({ ...makeState(), wizard: c }, key("enter"))).toEqual({ kind: "loadModels" });
  expect(c.step).toBe(3);
});

test("an EMPTY key refuses with an error line and stays; the storeKey request carries the secret only to the seam", () => {
  const s = { ...makeState(), wizard: wizard({ step: 2, secret: "   " }) };
  const r = onWizardKey(s, key("enter"));
  expect(r).toEqual({ kind: "none" });
  expect(s.wizard!.step).toBe(2);
  expect(s.wizard!.error).toContain("empty");

  const t = { ...makeState(), wizard: wizard({ step: 2, secret: "sk-real" }) };
  expect(onWizardKey(t, key("enter"))).toEqual({ kind: "storeKey", provider: "1", secret: "sk-real" });
  wizardKeyStored(t.wizard!, true);
  expect(t.wizard!.step).toBe(3);                               // stored → the model step…
  expect(t.wizard!.modelsLoading).toBe(true);                   // …which opens FETCHING (the renderer's job to fill)
});

test("a REFUSED key stays editable on step 1 with the error said", () => {
  const w = wizard({ step: 2, secret: "sk-bad" });
  wizardKeyStored(w, false, "the key could not be stored");
  expect(w.step).toBe(2);
  expect(w.keyAccepted).toBe(false);
  expect(w.error).toBe("the key could not be stored");
});

test("KEY typing is by code point and Backspace eats one glyph; ← goes back a step and clears the error", () => {
  const w = wizard({ step: 2, secret: "" });
  const s = { ...makeState(), wizard: w };
  onWizardKey(s, key("s", "s")); onWizardKey(s, key("k", "k")); onWizardKey(s, key("-", "-")); onWizardKey(s, key("1", "1"));
  expect(w.secret).toBe("sk-1");
  onWizardKey(s, key("backspace"));
  expect(w.secret).toBe("sk-");
  w.error = "stale";
  onWizardKey(s, key("left"));
  expect(w.step).toBe(1);
  expect(w.error).toBeUndefined();
});

test("a URL DOOR walks ENDPOINT first: ⏎ asks for id + base URL, refuses a bad id and a non-http(s) URL, and emits registerEndpoint — never \"unknown provider\"", () => {
  const doors: WizardProvider[] = [...PROVIDERS, { key: "8", label: "another OpenAI-compatible URL (a proxy, vLLM, …)", url: "openai" }];
  // ⏎ on the door row lands on ENDPOINT (1), not KEY
  const s = { ...makeState(), wizard: wizard({ providers: doors, selected: 3 }) };
  onWizardKey(s, key("enter"));
  expect(s.wizard!.step).toBe(1);
  // type an id, ⇥ to the URL field, type the URL
  onWizardKey(s, key("m", "m")); onWizardKey(s, key("y", "y"));
  onWizardKey(s, key("tab"));
  expect(s.wizard!.urlField).toBe(true);
  s.wizard!.urlTyped = "https://proxy.internal/v1";
  // a bad id is refused BEFORE the registry is touched
  s.wizard!.idTyped = "My Proxy!";
  expect(onWizardKey(s, key("enter"))).toEqual({ kind: "none" });
  expect(s.wizard!.error).toContain("won't work as an id");
  // a good id + a bad URL is refused too
  s.wizard!.idTyped = "myproxy"; s.wizard!.urlTyped = "proxy.internal";
  expect(onWizardKey(s, key("enter"))).toEqual({ kind: "none" });
  expect(s.wizard!.error).toContain("not an http(s) URL");
  // both good → the registerEndpoint request; the renderer's answer advances to KEY
  s.wizard!.urlTyped = "https://proxy.internal/v1";
  expect(onWizardKey(s, key("enter"))).toEqual({ kind: "registerEndpoint", id: "myproxy", url: "https://proxy.internal/v1", protocol: "openai" });
  wizardEndpointRegistered(s.wizard!, true);
  expect(s.wizard!.step).toBe(2);
  // a refusal keeps ENDPOINT editable with the error said
  const t = { ...makeState(), wizard: wizard({ providers: doors, selected: 3, step: 1, idTyped: "x", urlTyped: "https://x/v1" }) };
  wizardEndpointRegistered(t.wizard!, false, "id already in use");
  expect(t.wizard!.step).toBe(1);
  expect(t.wizard!.error).toBe("id already in use");
});

test("ENDPOINT paints ONE caret — on the ACTIVE field, after its text; the inactive field is dim with none (two ▌ read as two fields being typed into)", () => {
  const doors: WizardProvider[] = [{ key: "8", label: "another OpenAI-compatible URL (a proxy, vLLM, …)", url: "openai" }];
  const idActive = wizard({ providers: doors, selected: 0, step: 1, idTyped: "myproxy", urlTyped: "", urlField: false });
  const idLines = wizardLines(idActive);
  expect(idLines[1]).toMatchObject({ text: "Short name?  myproxy▌", tone: "normal", caret: true });
  expect(idLines[2]).toMatchObject({ text: "Base URL?    ", tone: "dim" });
  expect(idLines.filter((l) => l.text.includes("▌"))).toHaveLength(1);   // ONE caret on the screen
  const urlActive = wizard({ ...{ providers: doors, selected: 0, step: 1 }, idTyped: "myproxy", urlTyped: "https://p/v1", urlField: true } as Partial<WizardState> as WizardState);
  const urlLines = wizardLines(urlActive);
  expect(urlLines[1]).toMatchObject({ text: "Short name?  myproxy", tone: "dim" });
  expect(urlLines[2]).toMatchObject({ text: "Base URL?    https://p/v1▌", tone: "normal", caret: true });
  expect(urlLines.filter((l) => l.text.includes("▌"))).toHaveLength(1);
});

test("MODEL: a list CHECKS rows (space) and ⏎ emits confirmModels — the checked ids in list order + makeDefault; an EMPTY list still types one id", () => {
  const withList = { ...makeState(), wizard: wizard({ step: 3, models: [{ id: "m-a" }, { id: "m-b", note: "fast" }] }) };
  // ⏎ with NOTHING checked refuses: the checked set is the answer, not the caret
  expect(onWizardKey(withList, key("enter"))).toEqual({ kind: "none" });
  expect(withList.wizard!.error).toContain("no model checked");
  // space checks the row under the caret; ↓ + space checks a second; the FIRST checked is makeDefault
  onWizardKey(withList, key("space"));
  expect(withList.wizard!.modelChecked).toEqual(["m-a"]);
  expect(withList.wizard!.modelDefaultTo).toBe("m-a");
  onWizardKey(withList, key("down"));
  onWizardKey(withList, key(" ", " "));
  expect(onWizardKey(withList, key("enter"))).toEqual({ kind: "confirmModels", provider: "1", models: ["m-a", "m-b"], makeDefault: "m-a" });
  wizardModelConfirmed(withList.wizard!, [{ id: "m-a" }, { id: "m-b" }]);
  expect(withList.wizard!.step).toBe(3);   // the list step — the walk's LAST

  const typed = { ...makeState(), wizard: wizard({ step: 3, models: [], modelTyped: "" }) };
  onWizardKey(typed, key("g", "g")); onWizardKey(typed, key("p", "p")); onWizardKey(typed, key("t", "t"));
  expect(typed.wizard!.modelTyped).toBe("gpt");
  expect(onWizardKey(typed, key("enter"))).toEqual({ kind: "confirmModel", model: "gpt" });
});

test("confirmModels seeds from the provider's OWN facts: the checked set starts as the active list, the default marker on the default row", () => {
  const w = wizard({ step: 3 });
  // the fetched rows carry the provider's truth: m-b/m-c active, m-b default
  wizardModelConfirmed(w, [{ id: "m-a" }, { id: "m-b", active: true, defaultModel: true }, { id: "m-c", active: true }]);
  expect(w.modelChecked).toEqual(["m-b", "m-c"]);       // an untouched pass re-pins what was pinned
  expect(w.modelDefaultTo).toBe("m-b");                  // the marker starts on the default row
  // unchecking the marked row moves the marker to the next checked — the default is never a ghost
  w.step = 3; w.modelSel = 1;
  onWizardKey({ ...makeState(), wizard: w }, key("space"));
  expect(w.modelChecked).toEqual(["m-c"]);
  expect(w.modelDefaultTo).toBe("m-c");
  // the painted rows say both facts: the checkbox, the active/default tags, the • default marker
  const lines = wizardLines(w).map((l) => l.text).join("\n");
  expect(lines).toContain("☐ m-a");
  expect(lines).toContain("✓ m-c · active •");
  expect(lines).toContain("☐ m-b · active · default");
});

test("an empty model choice refuses with the error line — the walk cannot finish with no model", () => {
  const s = { ...makeState(), wizard: wizard({ step: 3, models: [], modelTyped: "  " }) };
  onWizardKey(s, key("enter"));
  expect(s.wizard!.step).toBe(3);
  expect(s.wizard!.error).toContain("no model");
});

test("MODEL is the LAST step: ⏎ on a checked list emits confirmModels and never a test request — the walk ends when the renderer pins the list (no runTest exists)", () => {
  // the caret moved after checking (a re-walk back and ↓) — the request still names the checked set
  const s = { ...makeState(), wizard: wizard({ step: 3, models: [{ id: "m-1" }, { id: "m-2" }], modelChecked: ["m-1"], modelDefaultTo: "m-1", modelSel: 1 }) };
  expect(onWizardKey(s, key("enter"))).toEqual({ kind: "confirmModels", provider: "1", models: ["m-1"], makeDefault: "m-1" });
  // a step past MODEL does not exist: the state machine caps at 3
  expect(s.wizard!.step).toBe(3);
  // the typed fallback ends the walk the same way (confirmModel, pinned by hand)
  const t = { ...makeState(), wizard: wizard({ step: 3, models: [], modelTyped: "gpt-x" }) };
  expect(onWizardKey(t, key("enter"))).toEqual({ kind: "confirmModel", model: "gpt-x" });
});

test("esc and ⌃c close the wizard; every other key is swallowed (never reaches the composer)", () => {
  const s = { ...makeState(), wizard: wizard() };
  for (const ev of [key("x", "x"), key("up"), key("enter"), { type: "key", name: "F9" } as KeyEvent]) {
    onWizardKey(s, ev);
    expect(s.wizard).not.toBeNull();          // nothing else closes it
  }
  onWizardKey(s, key("escape"));
  expect(s.wizard).toBeNull();

  const t = { ...makeState(), wizard: wizard() };
  onWizardKey(t, { type: "key", name: "c", ch: "c", ctrl: true });
  expect(t.wizard).toBeNull();
});

// ------------------------------------------------------------------ paste (the key step's input method)

test("wizardPaste: the KEY step takes the whole key as ONE paste (a trailing newline never becomes part of it), and the secret stays masked", () => {
  const s = makeState();
  s.wizard = wizard({ step: 2 });
  expect(wizardPaste(s, "sk-ant-abc123\n")).toBe(true);
  expect(s.wizard.secret).toBe("sk-ant-abc123 ");  // \n collapses: a paste is one line, the trim at ⏎ drops the rest
  expect(wizardLines(s.wizard).some((l) => l.text.includes("sk-ant"))).toBe(false);  // the mask, never the paste
  expect(wizardPaste(s, "x")).toBe(true);          // a second paste appends, like a second keystroke would
  expect(s.wizard.secret).toBe("sk-ant-abc123 x");
});

test("wizardPaste: the MODEL step takes a paste when the list is empty (typed id); with a list, or on PROVIDER/ENDPOINT, the paste is swallowed — nothing reaches the composer", () => {
  const noList = makeState();
  noList.wizard = wizard({ step: 3, models: [] });
  expect(wizardPaste(noList, "gpt-4o")).toBe(true);
  expect(noList.wizard.modelTyped).toBe("gpt-4o");
  const withList = makeState();
  withList.wizard = wizard({ step: 3, models: [{ id: "m1" }] });
  expect(wizardPaste(withList, "gpt-4o")).toBe(true);   // consumed (true)…
  expect(withList.wizard.modelTyped).toBe("");          // …but not typed: a paste onto a list is not a selection
  for (const step of [0, 1]) {
    const s = makeState();
    s.wizard = wizard({ step });
    expect(wizardPaste(s, "anything")).toBe(true);      // swallowed on every other step too
    expect(s.wizard.secret).toBe("");
  }
  const closed = makeState();
  expect(wizardPaste(closed, "hi")).toBe(false);        // no wizard: not this handler's paste
});

// ------------------------------------------------------------------ the overlay contract

test("openWizard is the FIFTH overlay: it closes palette/market/help/context, and closes cleanly", () => {
  const s = makeState();
  s.palette = { query: "", sel: 0, items: [] };
  openWizard(s, PROVIDERS);
  expect(s.palette).toBeNull();
  expect(s.wizard).not.toBeNull();
  expect(s.wizard!.providers).toBe(PROVIDERS);
  closeWizard(s);
  expect(s.wizard).toBeNull();
});

// ------------------------------------------------------------------ the surface routing

test("the sextant dispatch: /setup and /connect open the wizard (not onSubmit); /connect <args> still reaches the app", async () => {
  const { dispatch } = await import("../../src/sextant/local-commands.ts");
  const spy = spyCtx();
  const s = makeState();
  dispatch(s, "/setup", spy.ctx);
  dispatch(s, "/connect", spy.ctx);
  expect(spy.submits).toEqual([]);
  dispatch(s, "/connect anthropic --model x", spy.ctx);
  expect(spy.submits).toEqual(["/connect anthropic --model x"]);  // with answers on the line, the app's one-liner owns it
});

// ------------------------------------------------------------------ the provider list's source

test("the wizard's provider rows come from the LIVE registry, not SETUP_PICKS: configured first, custom rows present, the env pair never a row, the two url doors last (app.ts providers seam markers)", async () => {
  // The bug this pins (2026-09-10, "modeller fetch edilemiyor"): the list was SETUP_PICKS.map —
  // nine fixed rows — so the person's OWN providers (a kaesra default, an `hn` added by hand)
  // never appeared and the walk could not reach them at all.
  const app = readFileSync(join(import.meta.dir, "../../src/tui/app.ts"), "utf8");
  expect(app).toContain("rt.providers.list()");                                   // the registry is the source
  expect(app).toContain("Number(isConfigured(b)) - Number(isConfigured(a))");      // configured rows first
  expect(app).toContain('p.id === "custom"');                                      // the ROVECODE_BASE_URL env pair is not a row
  expect(app).toContain("for (const p of SETUP_PICKS) if (p.url !== undefined)");  // the doors stay, at the end
  expect(app).not.toContain("providers: () => SETUP_PICKS.map");                   // the old fixed list is gone
  // and the other seams resolve by registry id now (a row's key IS its id)
  expect(app).toContain("const row = rt.providers.get(provider);");                // storeKey
  expect(app).not.toContain("SETUP_PICKS.find");                                   // the key→pick lookup is gone everywhere
});

// ------------------------------------------------------------------ the model step opens by FETCHING

test("the MODEL step never claims \"no list\" while it is FETCHING: the loading line paints, keys wait, and a served list clears the flag", () => {
  // entering the step (skip or stored key) puts it in the loading state the renderer clears
  const s = { ...makeState(), wizard: wizard({ step: 3, modelsLoading: true }) };
  const lines = wizardLines(s.wizard!);
  expect(lines.some((l) => l.text.includes("Fetching the model list"))).toBe(true);
  expect(lines.some((l) => l.text.includes("No model list"))).toBe(false);   // not yet a claim
  // typing is inert while loading (there is no field to type into yet)
  expect(onWizardKey(s, key("g", "g"))).toEqual({ kind: "none" });
  expect(s.wizard!.modelTyped).toBe("");
  // the answer arrives: the flag clears, the rows paint, checking works
  wizardModelConfirmed(s.wizard!, [{ id: "m-1" }, { id: "m-2" }]);
  expect(s.wizard!.modelsLoading).toBe(false);
  expect(wizardLines(s.wizard!).some((l) => l.text.includes("☐ m-1"))).toBe(true);
  onWizardKey(s, key("space"));
  expect(s.wizard!.modelChecked).toContain("m-1");
});
