/** /model · /models · /provider — the TUI's provider surface over the runtime's LIVE registry
 *  (providers/registry.ts). Nothing here rebuilds the runtime: the registry's dispatching stream
 *  resolves model.provider per call, so a provider added or a key stored in this session serves the
 *  very next prompt. Kept out of app.ts (ADR-002 cap) like info-cmd.ts / session-cmd.ts.
 *
 *  Secrets: `/provider key <id> <secret>` stores through auth.ts saveCredential and echoes only the
 *  redacted prefix; slash commands never reach the agent or the session store, so the key is not in
 *  the transcript. Prefer `--key-env NAME` or `rovecode auth set <id>` (masked prompt) when possible. */

import type { Runtime } from "../cli/runtime.ts";
import type { ModeManager } from "../core/modes.ts";
import type { ModelRef } from "../core/types.ts";
import type { Renderer } from "./renderer.ts";
import { redactSecret, saveCredential } from "../providers/auth.ts";
import { isConfigured } from "../providers/provider-config.ts";
import { ADD_USAGE, formatProviderList, parseAddArgs } from "../providers/registry.ts";
import { PROVIDER_ID_RE } from "../providers/provider-config.ts";
import type { PickItem } from "./renderer.ts";
import { SETUP_PICKS } from "../cli/setup.ts";
import { CONNECT_WAITING, parseConnectArgs, runConnect } from "../cli/connect.ts";
import { next } from "../core/voice.ts";
import { ModelCatalog } from "../providers/catalog.ts"; // port #60: enrich existing picker rows
import { describeModel } from "../providers/model-list.ts"; // port #60

export interface ProviderCmdCtx {
  rt: Runtime;
  modes: ModeManager;
  state: { provider: string; model: string };
  renderer: Renderer;
  pushStatus: () => void;
  catalog?: Pick<ModelCatalog, "lookup">; // port #60: reuse the app's /cost catalog (offline fallback for other callers)
}

type NoteLevel = Parameters<Renderer["addSystemNote"]>[1];

export const MODEL_COMMAND = { name: "model", description: "Switch the model I use: /model <provider/model | model> [--save]", group: "model & provider" };

/** every `provider/model` id the configured providers list — the `/model` suggestions in the sextant. A
 *  provider that errors or lists nothing drops out silently here; `/models` is where the reasons show. */
export async function listModelIds(reg: Pick<Runtime["providers"], "list" | "models">): Promise<string[]> {
  const ids = reg.list().filter(isConfigured).map((p) => p.id);
  const results = await Promise.all(ids.map(async (id) => ({ id, r: await reg.models(id, { background: true }) })));
  return results.flatMap(({ id, r }) => (r.ok ? r.models.map((m) => `${id}/${m}`) : []));
}
export const SETUP_COMMAND = { name: "setup", description: "Connect a model step by step: provider, model, key, one test call", group: "start here" };
export const CONNECT_COMMAND = { name: "connect", description: "Connect a model: /connect (guided, same as /setup) · /connect <id> [<url>] [--model <id>] [--key-env NAME] [--no-key] [--project] [--no-test]", group: "start here" };
export const PROVIDER_COMMANDS = [
  { name: "models", description: "Pick a model from a list: /models [provider] [--save]", group: "model & provider" },
  { name: "provider", description: "Endpoints I can talk to: /provider list · add <id> <url> [--protocol …] [--key-env …] [--model …] [--no-key] [--project] · remove <id> · use <provider/model> · test <id> [model] · key <id> <secret>", group: "model & provider" },
];
/** the last line of a finished /setup */
export const SETUP_DONE_TUI = "Done. Tell me what you want done — try: explain this repo";

/** `/model …` / `/provider use` write the default themselves and report it — the watcher must not
 *  announce the same change a second time. Set around the write; refresh() fires synchronously. */
let localWrite = false;

const note = (ctx: ProviderCmdCtx, text: string, level?: NoteLevel): void => { ctx.renderer.addSystemNote(text, level); };

/** the session's model = the current mode's slot (port #20; mirrored to both when planActSeparateModels is off) */
function applyRef(ctx: ProviderCmdCtx, ref: ModelRef): void {
  ctx.modes.setModel({ provider: ref.provider, model: ref.model });
  const cur = ctx.modes.modelFor();
  ctx.state.model = cur.model;
  ctx.state.provider = cur.provider;
  ctx.pushStatus();
}

/** /model <provider/model | model> [--save] — switch this session; --save also persists it as the default. */
export function cmdModel(ctx: ProviderCmdCtx, arg: string): void | Promise<void> {
  const words = arg.split(/\s+/).filter((w) => w.length > 0);
  const save = words.includes("--save");
  const sel = words.filter((w) => w !== "--save").join(" ");
  if (sel.length === 0) return cmdModels(ctx, save ? "--save" : ""); // port #60: bare /model uses the existing picker
  const ref = ctx.rt.providers.resolveSelector(sel, ctx.state.provider);
  if ("error" in ref) { note(ctx, `${ref.error} — add one with /provider add <id> <baseUrl>`, "warn"); return; }
  const switchedProvider = ref.provider !== ctx.state.provider;
  applyRef(ctx, ref);
  let saved = "";
  if (save) {
    localWrite = true;
    try {
      const r = ctx.rt.providers.setDefault(`${ref.provider}/${ref.model}`);
      saved = "error" in r ? ` (not saved: ${r.error})` : " (saved as default)";
    } finally { localWrite = false; }
  }
  const p = ctx.rt.providers.get(ref.provider);
  const keyNote = p !== undefined && !isConfigured(p) ? `\n${ctx.rt.providers.keyHint(p)}` : "";
  // same provider → the bare model id (the historical `/model <id>` note); a provider switch names both
  note(ctx, `model → ${switchedProvider ? `${ref.provider}/` : ""}${ref.model}${saved}${ctx.modes.separate ? ` (${ctx.modes.mode} mode)` : ""}${keyNote}`, keyNote.length > 0 ? "warn" : undefined);
}

/** /models [provider] — ids from providers.json `models` or the endpoint's /models. */
/** /models [provider] [--all] [--save] — PICK a model, do not read a wall of ids.
 *
 *  It used to print up to 60 rows as a note and leave you to retype one into `/model <id>`. The ids
 *  are long and often differ by a date suffix, so retyping is where the mistakes were. Now the same
 *  list opens in the picker the setup flow already uses: arrow, Enter, done — and Enter applies it
 *  to this session immediately.
 *
 *  Bare, it lists every CONFIGURED provider's models, so switching vendor is the same gesture as
 *  switching model; naming a provider narrows it to that one (and reaches an unconfigured one, which
 *  is how you look before you commit). `--save` also persists the pick as the default.
 *
 *  Fetching is per provider and concurrent — a provider whose endpoint is down or keyless reports
 *  itself as one row instead of failing the whole list. */
export async function cmdModels(ctx: ProviderCmdCtx, arg: string): Promise<void> {
  const words = arg.split(/\s+/).filter((w) => w.length > 0);
  const save = words.includes("--save");
  const named = words.filter((w) => !w.startsWith("-"))[0];
  const reg = ctx.rt.providers;

  const ids = named !== undefined ? [named] : reg.list().filter(isConfigured).map((p) => p.id);
  if (ids.length === 0) { note(ctx, `no provider is configured yet. ${next("/connect")}`, "warn"); return; }

  note(ctx, ids.length === 1 ? `fetching ${ids[0]} models…` : `fetching models from ${ids.length} providers…`);
  const results = await Promise.all(ids.map(async (id) => ({ id, r: await reg.models(id, { background: true }) })));

  const items: PickItem[] = [];
  const problems: string[] = [];
  const catalog = ctx.catalog ?? new ModelCatalog(); // port #60: lookup only, never refresh/fetch metadata
  const itemFor = (id: string, model: string): PickItem => {
    const current = ctx.state.provider === id && ctx.state.model === model;
    const description = [current ? "current" : "", describeModel(catalog.lookup(id, model))].filter(Boolean).join(" · ");
    return { value: `${id}/${model}`, label: `${current ? "* " : "  "}${id}/${model}`, ...(description ? { description } : {}) };
  }; // port #60
  for (const { id, r } of results) {
    if (!r.ok) { problems.push(`${id}: ${r.error}`); continue; }
    if (r.models.length === 0) { problems.push(`${id}: the endpoint listed no models (no /models route?) — /model ${id}/<model> still works`); continue; }
    for (const m of r.models) {
      items.push(itemFor(id, m)); // port #60: same live ids, optional context/pricing/capabilities
    }
  }
  for (const p of problems) note(ctx, p, "warn");
  // port #60: never hide the running model just because a provider's list does not know it.
  const currentRef = `${ctx.state.provider}/${ctx.state.model}`;
  if (ctx.state.model && ids.includes(ctx.state.provider) && !items.some((item) => item.value === currentRef)) items.unshift(itemFor(ctx.state.provider, ctx.state.model));
  if (items.length === 0) return;

  // the current model first: the list is long and the answer to "what am I on?" should not need scrolling
  items.sort((a, b) => Number(b.label.startsWith("*")) - Number(a.label.startsWith("*")));
  // short on purpose: the box clips its title, and it already draws an `esc` affordance of its own
  const picked = await ctx.renderer.pickOne(items, `pick a model · ${items.length} from ${ids.length} provider${ids.length === 1 ? "" : "s"}`);
  if (picked === null || (!save && picked === `${ctx.state.provider}/${ctx.state.model}`)) return; // port #60: cancel/re-pick changes no slot; --save still persists
  cmdModel(ctx, save ? `${picked} --save` : picked); // ONE path for applying a model, flags and all
}

/** /provider list|add|remove|use|test|key */
export async function cmdProvider(ctx: ProviderCmdCtx, arg: string): Promise<void> {
  const words = arg.split(/\s+/).filter((w) => w.length > 0);
  const [action, ...rest] = words;
  const reg = ctx.rt.providers;
  switch (action) {
    case undefined:
    case "list":
      note(ctx, formatProviderList(reg, { all: rest.includes("--all") }));
      return;
    case "add": {
      const parsed = parseAddArgs(rest);
      if ("error" in parsed) { note(ctx, parsed.error, "warn"); return; }
      const r = reg.add(parsed.spec, parsed.scope);
      if ("error" in r) { note(ctx, r.error, "warn"); return; }
      const key = isConfigured(r) ? "" : `\nkey: /provider key ${r.id} <secret>  ·  or set ${r.keyEnv} (live, no restart)`;
      note(ctx, `added ${r.id} (${r.protocol}, ${r.baseUrl}) [${parsed.scope}]${key}\nuse it: /model ${r.id}/${r.defaultModel ?? "<model>"}`);
      return;
    }
    case "remove": {
      if (rest[0] === undefined) break;
      const r = reg.remove(rest[0]);
      if ("error" in r) { note(ctx, r.error, "warn"); return; }
      note(ctx, r.removed.length > 0 ? `removed ${rest[0]} (${r.removed.join(", ")} providers.json)` : `${rest[0]} was not in any providers.json`);
      return;
    }
    case "use": {
      if (rest[0] === undefined) break;
      localWrite = true;
      let r: ReturnType<typeof reg.setDefault>;
      try { r = reg.setDefault(rest[0]); } finally { localWrite = false; }
      if ("error" in r) { note(ctx, r.error, "warn"); return; }
      applyRef(ctx, r);
      const p = reg.get(r.provider);
      const keyNote = p !== undefined && !isConfigured(p) ? `\n${reg.keyHint(p)}` : "";
      note(ctx, `default → ${r.provider}/${r.model} (saved; this session switched)${keyNote}`, keyNote.length > 0 ? "warn" : undefined);
      return;
    }
    case "test": {
      if (rest[0] === undefined) break;
      note(ctx, `testing ${rest[0]}${rest[1] !== undefined ? `/${rest[1]}` : ""}…`);
      const r = await reg.probe(rest[0], rest[1]);
      note(ctx, `${rest[0]}/${r.model}: ${r.detail}`, r.ok ? undefined : "warn");
      return;
    }
    case "key": {
      const [id, secret] = rest;
      if (id === undefined || secret === undefined) break;
      const p = reg.get(id);
      if (p === undefined) { note(ctx, `unknown provider "${id}" — /provider add ${id} <baseUrl> first`, "warn"); return; }
      saveCredential(id, secret, p.keyEnv);
      reg.refresh();
      note(ctx, `stored ${p.keyEnv} for ${id} (${redactSecret(secret)}) — live now`);
      return;
    }
    default:
      break;
  }
  note(ctx, `usage: /provider list [--all] · /provider ${ADD_USAGE} · remove <id> · use <provider/model> · test <id> [model] · key <id> <secret>`, "warn");
}

// ---------- /setup ----------

/** the watcher + poll an unfinished /setup left armed (one at a time; a new /setup replaces it) */
let pendingSetup: (() => void) | null = null;

/** /setup — the TUI's guided connect: provider from the picker, model from a question card, then the
 *  key. The cards have no masked input, so the key is a HAND-OFF: `rovecode auth set <id>` in another
 *  terminal (masked) or `/provider key` here. The live registry notices the key landing (a 1 s poll keeps
 *  its mtime check warm while a setup is pending) and this finishes the job — one test call, default,
 *  session switch — without another command. Wording: core/voice.ts. */
export async function cmdSetup(ctx: ProviderCmdCtx): Promise<void> {
  const reg = ctx.rt.providers;
  pendingSetup?.(); pendingSetup = null;
  const items = SETUP_PICKS.map((p) => ({ value: p.key, label: p.label }));
  const key = await ctx.renderer.pickOne(items, "◆ connect a model — which provider? (Esc = cancel)");
  if (key === null) { note(ctx, "setup cancelled — nothing changed. /setup whenever you like"); return; }
  const pick = SETUP_PICKS.find((p) => p.key === key);
  if (pick === undefined) return;
  const askText = async (question: string): Promise<string | null> => {
    const a = await ctx.renderer.askQuestion({ question, options: [], allowFreeText: true }).catch(() => null);
    return a?.text?.trim() ?? null;
  };
  let id: string;
  if (pick.url !== undefined) {
    const idText = ((await askText("Short name for it? (letters, digits, - _ .)")) ?? "").toLowerCase();
    if (!PROVIDER_ID_RE.test(idText)) { note(ctx, `setup stopped — "${idText}" won't work as an id. ${next("/setup, and pick a name like myproxy")}`, "warn"); return; }
    const baseUrl = (await askText(`Base URL for ${idText}? (e.g. https://host/v1)`)) ?? "";
    if (!/^https?:\/\//.test(baseUrl)) { note(ctx, `setup stopped — "${baseUrl}" is not an http(s) URL. ${next("/setup")}`, "warn"); return; }
    const keyA = await ctx.renderer.askQuestion({ question: "Does it need an API key?", options: ["yes", "no — it is a local server"], allowFreeText: false }).catch(() => null);
    const noKey = keyA?.choice === 1;
    const r = reg.add({ id: idText, baseUrl, protocol: pick.url, ...(noKey ? { noKey: true } : {}) }, "user");
    if ("error" in r) { note(ctx, `setup stopped — ${r.error}`, "warn"); return; }
    id = idText;
    note(ctx, `◆ ${id} registered (${pick.url} protocol, ${baseUrl}).`);
  } else {
    id = pick.id ?? "";
    const known = reg.get(id);
    if (known === undefined) { note(ctx, `setup stopped — ${id} is missing from the built-in table`, "warn"); return; }
    if (pick.local === true && known.noKey !== true) {
      // the built-in row expects a key env; a local server needs none — the user entry says so
      const r = reg.add({ id, baseUrl: known.baseUrl, protocol: known.protocol, noKey: true, ...(known.defaultModel !== undefined ? { defaultModel: known.defaultModel } : {}) }, "user");
      if ("error" in r) { note(ctx, `setup stopped — ${r.error}`, "warn"); return; }
      note(ctx, `◆ ${id} marked as a local server (${known.baseUrl}, no key).`);
    }
  }
  const spec = reg.get(id);
  if (spec === undefined) return;
  // A provider that ships a default model does not need a question: taking it is right nearly always,
  // and `/model <id>/<other> --save` changes it in one line afterwards. Only an endpoint with no
  // default (a bare proxy, a self-hosted server) still has to be asked — there is nothing to assume.
  let model = spec.defaultModel;
  if (model === undefined) {
    const mA = await ctx.renderer.askQuestion({ question: `Which model id on ${id}?`, options: [], allowFreeText: true }).catch(() => null);
    model = mA?.text?.trim() || mA?.label;
    if (model === undefined || model.length === 0) { note(ctx, `◆ ${id} is set up but has no model yet. ${next(`/models ${id}, then /model ${id}/<model> --save`)}`); return; }
  } else {
    note(ctx, `◆ model → ${id}/${model}  (change it any time: /model ${id}/<other> --save)`);
  }

  const finish = async (): Promise<void> => {
    note(ctx, `◆ testing ${id}/${model} …`);
    const r = await reg.probe(id, model);
    if (r.ok) note(ctx, `  ${r.detail}`);
    else note(ctx, `  that didn't work: ${r.detail}\n  ${next(`check the key and the URL, then /provider test ${id} ${model}`)}`, "warn");
    localWrite = true;
    let d: ReturnType<typeof reg.setDefault>;
    try { d = reg.setDefault(`${id}/${model}`, "user"); } finally { localWrite = false; }
    if ("error" in d) { note(ctx, `  ${d.error}`, "warn"); return; }
    applyRef(ctx, d);
    note(ctx, `◆ default → ${d.provider}/${d.model} — this session switched too.\n${SETUP_DONE_TUI}`);
  };
  if (isConfigured(spec)) { await finish(); return; }
  note(ctx, [
    `◆ I need the key for ${id}. Paste it hidden in another terminal:`,
    `    rovecode auth set ${id}`,
    `  or here (this line only, redacted in the note): /provider key ${id} <secret>`,
    `  or set ${spec.keyEnv} in your environment.`,
    "  I'll notice as soon as it lands and finish the setup.",
  ].join("\n"));
  armKeyWatch(reg, id, finish);
}

/** Park until the key for `id` lands, then run `finish` once. The registry's mtime check only runs on
 *  access, so a 1 s poll keeps it warm while we wait; one watch at a time — a new /setup or /connect
 *  replaces the one before it. */
function armKeyWatch(reg: ProviderCmdCtx["rt"]["providers"], id: string, finish: () => Promise<void>): void {
  const timer = setInterval(() => { reg.snapshot(); }, 1000);
  timer.unref?.();
  const off = reg.onChange(() => {
    const p = reg.get(id);
    if (p === undefined || !isConfigured(p)) return;
    stop();
    void finish();
  });
  const stop = (): void => { clearInterval(timer); off(); if (pendingSetup === stop) pendingSetup = null; };
  pendingSetup = stop;
}

/** /connect — the same job as /setup, but with the answers on the line instead of in cards, so it is one
 *  command to paste. Bare, it IS /setup. It runs cli/connect.ts against this session's LIVE registry and
 *  applies the new default to the session, like /setup does.
 *
 *  There is no masked input in here, so `--key` and `--key-stdin` are refused rather than quietly
 *  ignored: a key typed on this line would sit in the transcript. When a key is simply missing,
 *  `deferKey` hands over the same way /setup does and the watcher finishes the job when it lands. */
export async function cmdConnect(ctx: ProviderCmdCtx, arg: string): Promise<void> {
  const words = arg.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) { await cmdSetup(ctx); return; }
  const parsed = parseConnectArgs(words);
  if ("error" in parsed) { note(ctx, `${parsed.error.replace("usage: rovecode connect", "usage: /connect")}`, "warn"); return; }
  if (parsed.key === "prompt" || parsed.key === "stdin") {
    note(ctx, `there is no hidden prompt in here — a key on this line would sit in the transcript.\n  ${next(`rovecode auth set ${parsed.id} in another terminal, or /provider key ${parsed.id} <secret>`)}`, "warn");
    return;
  }
  const reg = ctx.rt.providers;
  pendingSetup?.(); pendingSetup = null;

  /** the default is written by the time connect returns (even on a failed test call) — bring the
   *  session with it, the way /setup does. Also runs on the deferred pass, after the key lands. */
  const follow = (code: number): void => {
    if (code === CONNECT_WAITING || code === 2) return;
    const d = reg.defaultRef();
    if (d !== null && d.provider === parsed.id && d.model.length > 0) applyRef(ctx, d);
  };

  const run = async (): Promise<number> => {
    localWrite = true; // the watcher must not announce a default this command already reported
    try {
      return await runConnect(parsed, {
        registry: reg,
        tty: false, // cards, not a terminal: never let runConnect reach for a prompt or for stdin
        out: (l) => note(ctx, l),
        done: SETUP_DONE_TUI,
        where: "tui", // the "→ next:" steps are slash commands in here, not shell lines
        deferKey: (spec) => {
          note(ctx, [
            `◆ I need the key for ${parsed.id}. Paste it hidden in another terminal:`,
            `    rovecode auth set ${parsed.id}`,
            `  or here (this line only, redacted in the note): /provider key ${parsed.id} <secret>`,
            `  or set ${spec.keyEnv} in your environment.`,
            "  I'll notice as soon as it lands and finish the job.",
          ].join("\n"));
          armKeyWatch(reg, parsed.id, async () => { follow(await run()); });
        },
      });
    } finally { localWrite = false; }
  };

  follow(await run());
}

/** Boot-time subscription: when the persisted default changes underneath this session (another
 *  terminal's `rovecode model use`, the agent's provider_edit use) the session follows it; when the
 *  first provider appears, say so. In-process slash writes report themselves (localWrite). */
export function watchProviders(ctx: ProviderCmdCtx): () => void {
  let lastSelector = ctx.rt.providers.defaultSelector();
  let hadProvider = ctx.rt.noProviderReason() === null;
  return ctx.rt.providers.onChange(() => {
    const sel = ctx.rt.providers.defaultSelector();
    if (sel !== lastSelector) {
      lastSelector = sel;
      const d = ctx.rt.providers.defaultRef();
      if (d !== null && d.model.length > 0 && !localWrite) { applyRef(ctx, d); note(ctx, `default model changed → ${d.provider}/${d.model}`); }
    }
    const has = ctx.rt.noProviderReason() === null;
    if (has && !hadProvider) note(ctx, "provider configured — ready for the next prompt");
    hadProvider = has;
  });
}
