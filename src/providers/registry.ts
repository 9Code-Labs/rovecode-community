/** Live provider registry — the ADAPTER half of the provider layer, over provider-config.ts (data).
 *
 *  One registry per runtime. stream() returns a DISPATCHING StreamFn: every call resolves
 *  `model.provider` against the live snapshot (hot reload — provider-config.ts), so a provider added
 *  from another terminal, by `rovecode provider add`, by `/provider add` in the TUI or by the agent's
 *  provider_edit tool serves the very next model call. No restart, no runtime rebuild. Concrete
 *  adapters (stream.ts) are cached per provider id and rebuilt when baseUrl, protocol, key or
 *  headers change — a rotated key takes effect on the next call too.
 *
 *  Seam contract (ADR-003): the dispatcher never throws. An unknown provider or a missing key is ONE
 *  error turn whose text starts with `config: ` — router.ts classifyStreamError treats that prefix
 *  as non-retryable, so neither the same-model retry (port #23) nor a fallback chain (port #14)
 *  spins on a configuration mistake; the text tells the human exactly how to fix it.
 *
 *  Because the dispatcher honours model.provider per call, cross-provider fallback chains
 *  (ROVECODE_MODEL_<ROLE>=a/x,b/y) now really route each candidate to its own endpoint.
 *
 *  Secrets: this module reads keys to build adapters and to redact them from probe errors
 *  (scrubSecret). Nothing here prints or returns a key; formatProviderList shows key SOURCES. */

import type { AssistantTurn, Message, ModelRef, StreamEvent, StreamFn, StreamOptions } from "../core/types.ts";
import { fetchModels, providerStream, providerStreaming, wantsStreaming, type ProviderConfig as WireProviderConfig } from "./stream.ts";
import {
  ProviderConfig, isConfigured, parseSelector, pickDefault, providersPathFor, readProvidersFile, validateSpec, writeProvidersFile,
  type FileScope, type ProviderEntry, type ProviderSnapshot, type ProviderSpec, type ResolvedProvider,
} from "./provider-config.ts";
import { next } from "../core/voice.ts";

export type AdapterFactory = (p: ResolvedProvider, opts: { sse: boolean }) => StreamFn;

/** stream.ts ProviderConfig for a resolved provider (a keyless provider sends an empty bearer). */
export function toWireConfig(p: ResolvedProvider): WireProviderConfig {
  return {
    id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey ?? "", protocol: p.protocol,
    ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
    ...(p.headers !== undefined ? { headers: p.headers } : {}),
  };
}

export const defaultAdapterFactory: AdapterFactory = (p, { sse }) => {
  const wire = toWireConfig(p);
  // both protocols stream (openai SSE chunks, anthropic Messages events); `sse` is off only when
  // ROVECODE_STREAM asked for the one-shot JSON adapters
  return sse ? providerStreaming(wire) : providerStream(wire);
};

/** Error-text prefix the router/retry classifier treats as non-retryable (router.ts). */
export const CONFIG_ERROR_PREFIX = "config: ";

export function configErrorTurn(text: string): AssistantTurn {
  return { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: CONFIG_ERROR_PREFIX + text };
}

/** Replace a secret wherever it leaked into text (some proxies echo request headers in error bodies). */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  return secret !== null && secret !== undefined && secret.length > 0 ? text.split(secret).join("…") : text;
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  /** test seam: build adapters without touching the network */
  adapterFactory?: AdapterFactory;
  /** provider-config.ts reload throttle (ms); tests pass 0 */
  throttleMs?: number;
}

export class ProviderRegistry {
  readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cfg: ProviderConfig;
  private readonly factory: AdapterFactory;
  private readonly adapters = new Map<string, { sig: string; fn: StreamFn }>();

  constructor(cwd: string, opts: RegistryOptions = {}) {
    this.cwd = cwd;
    this.env = opts.env ?? process.env;
    this.factory = opts.adapterFactory ?? defaultAdapterFactory;
    this.cfg = new ProviderConfig(cwd, this.env, opts.throttleMs);
  }

  snapshot(): ProviderSnapshot { return this.cfg.snapshot(); }
  list(): ResolvedProvider[] { return this.snapshot().providers; }
  ids(): string[] { return this.list().map((p) => p.id); }
  get(id: string): ResolvedProvider | undefined { return this.list().find((p) => p.id === id); }
  /** at least one provider has a key (or needs none) */
  configured(): boolean { return this.list().some(isConfigured); }
  warnings(): string[] { return this.snapshot().warnings; }
  /** fires after every rebuild: external file edits (detected lazily) and in-process add/remove/setDefault */
  onChange(cb: (snap: ProviderSnapshot) => void): () => void { return this.cfg.onChange(cb); }
  /** re-read now (in-process writers call it right after writing) and notify listeners */
  refresh(): ProviderSnapshot { this.cfg.invalidate(); return this.cfg.snapshot(); }

  /** default provider + model with env ROVECODE_MODEL layered on top; null when nothing is configured */
  defaultRef(): ModelRef | null {
    const d = pickDefault(this.snapshot());
    if (d === null) return null;
    return { provider: d.provider.id, model: this.env["ROVECODE_MODEL"] ?? d.model ?? "" };
  }

  /** stream.ts-shaped config of the default provider (Runtime.provider compatibility) */
  defaultConfig(): WireProviderConfig | null {
    const d = pickDefault(this.snapshot());
    if (d === null) return null;
    return { ...toWireConfig(d.provider), ...(d.model !== undefined ? { defaultModel: d.model } : {}) };
  }

  defaultSelector(): string | undefined { return this.snapshot().defaultSelector; }

  /** "provider/model" or a bare model on `currentProvider`. A leading segment counts as a provider
   *  only when it names one, so "zai-org/glm-5.3" stays a model id on the current provider. The
   *  current provider is not validated (it may be "mock" or an injected test stream): a bare model
   *  always lands there, exactly as `/model <id>` always did. */
  resolveSelector(selector: string, currentProvider: string): ModelRef | { error: string } {
    const s = selector.trim();
    if (s.length === 0) return { error: "empty model selector" };
    const i = s.indexOf("/");
    if (i > 0) {
      const head = s.slice(0, i);
      const tail = s.slice(i + 1).trim();
      if (this.get(head) !== undefined) return tail.length > 0 ? { provider: head, model: tail } : { error: `"${s}" names no model — use ${head}/<model>` };
    }
    return { provider: currentProvider, model: s };
  }

  add(spec: ProviderSpec, scope: FileScope = "user"): ResolvedProvider | { error: string } {
    const { id, ...raw } = spec;
    const v = validateSpec(id, raw);
    if ("error" in v) return v;
    if (this.get(id)?.scope === "env") return { error: `"custom" is reserved for the ROVECODE_BASE_URL/ROVECODE_API_KEY pair — pick another id` };
    const path = providersPathFor(scope, this.cwd);
    const { data } = readProvidersFile(path);
    const { id: _id, ...rest } = v.spec;
    data.providers = { ...(data.providers ?? {}), [id]: rest };
    writeProvidersFile(path, data);
    this.refresh();
    return this.get(id)!;
  }

  remove(id: string): { removed: FileScope[] } | { error: string } {
    const p = this.get(id);
    if (p === undefined) return { error: `unknown provider "${id}" — known: ${this.ids().join(" ")}` };
    if (p.scope === "builtin") return { error: `"${id}" is built in; drop its key with \`rovecode auth remove ${id}\` instead` };
    if (p.scope === "env") return { error: `"custom" comes from ROVECODE_BASE_URL/ROVECODE_API_KEY — unset those env vars` };
    const removed: FileScope[] = [];
    for (const scope of ["user", "project"] as const) {
      const path = providersPathFor(scope, this.cwd);
      const { data } = readProvidersFile(path);
      if (data.providers !== undefined && id in data.providers) {
        delete data.providers[id];
        if (Object.keys(data.providers).length === 0) delete data.providers;
        writeProvidersFile(path, data);
        removed.push(scope);
      }
    }
    this.refresh();
    return { removed };
  }

  setDefault(selector: string, scope: FileScope = "user"): ModelRef | { error: string } {
    const sel = parseSelector(selector);
    const p = this.get(sel.provider);
    if (p === undefined) return { error: `unknown provider "${sel.provider}" — known: ${this.ids().join(" ")}` };
    const model = sel.model ?? p.defaultModel;
    if (model === undefined) return { error: `"${selector}" names no model and ${p.id} has no default — use ${p.id}/<model>` };
    const path = providersPathFor(scope, this.cwd);
    const { data } = readProvidersFile(path);
    data.default = `${p.id}/${model}`;
    writeProvidersFile(path, data);
    this.refresh();
    return { provider: p.id, model };
  }

  /** pin a provider's ACTIVE model list (the connect wizard's model step): writes `models` on the
   *  provider's row in the scope's file — creating the row for a builtin, which is how `add` works
   *  too. An EMPTY list removes the field: the provider goes back to asking its /models endpoint
   *  every time (the "use them all" answer — nothing frozen). Returns the written list. */
  setModels(id: string, models: readonly string[], scope: FileScope = "user"): { models: string[] } | { error: string } {
    const p = this.get(id);
    if (p === undefined) return { error: `unknown provider "${id}" — known: ${this.ids().join(" ")}` };
    if (p.scope === "env") return { error: `"custom" comes from ROVECODE_BASE_URL/ROVECODE_API_KEY — a model list cannot be pinned on it` };
    for (const m of models) if (m.trim().length === 0) return { error: "model ids must be non-empty strings" };
    const path = providersPathFor(scope, this.cwd);
    const { data } = readProvidersFile(path);
    const rows = data.providers ?? {};
    const existing = rows[id];
    // a builtin with no file row yet carries its baseUrl in the spec — the new row must too
    const row: ProviderEntry = existing ?? { baseUrl: p.baseUrl };
    const deduped = [...new Set(models.map((m) => m.trim()))];
    if (deduped.length === 0) {
      delete row.models;
    } else {
      row.models = deduped;
      // a pinned list that does not contain the current default silently breaks the default —
      // keep the field only when it still names a usable model
      if (row.defaultModel !== undefined && !deduped.includes(row.defaultModel)) delete row.defaultModel;
    }
    rows[id] = row;
    data.providers = rows;
    writeProvidersFile(path, data);
    this.refresh();
    return { models: deduped };
  }

  keyHint(p: ResolvedProvider): string {
    return `no API key for provider "${p.id}" — I can't call it without one. ${next(`rovecode auth set ${p.id}`)} (masked prompt) · or /provider key ${p.id} <key> in the TUI · or set ${p.keyEnv}`;
  }

  /** The provider's model ids: providers.json `models` when it lists them, else the endpoint's
   *  /models through the memory+disk cache (stream.ts fetchModels) — a warm cache answers in the
   *  same tick, so `/models` and the suggestion box open instantly instead of waiting on the
   *  slowest configured provider. `force` bypasses both layers (setup/connect flows want the
   *  network's truth right now); `background` lets a stale disk hit revalidate itself while the
   *  caller proceeds — long-lived surfaces only (a pending fetch keeps a Bun process alive, so a
   *  one-shot CLI command must not set it; stream.ts fetchModels header). */
  async models(id: string, opts: { force?: boolean; background?: boolean } = {}): Promise<{ ok: true; models: string[]; source: "file" | "endpoint" } | { ok: false; error: string }> {
    const p = this.get(id);
    if (p === undefined) return { ok: false, error: `unknown provider "${id}" — known: ${this.ids().join(" ")}` };
    if (p.models !== undefined && p.models.length > 0) return { ok: true, models: p.models, source: "file" };
    if (!isConfigured(p)) return { ok: false, error: this.keyHint(p) };
    const list = await fetchModels(toWireConfig(p), opts);
    return { ok: true, models: list.map((m) => m.id), source: "endpoint" };
  }

  /** One tiny real call ("ping", ≤8 output tokens): proves url + key + model together. */
  async probe(id: string, model?: string): Promise<{ ok: boolean; model: string; detail: string }> {
    const p = this.get(id);
    if (p === undefined) return { ok: false, model: model ?? "", detail: `unknown provider "${id}" — known: ${this.ids().join(" ")}` };
    if (!isConfigured(p)) return { ok: false, model: model ?? "", detail: this.keyHint(p) };
    const m = model ?? p.defaultModel;
    if (m === undefined) return { ok: false, model: "", detail: `${p.id} has no default model — pass one: test ${p.id} <model>` };
    const probeMsg: Message = { id: "probe", role: "user", parts: [{ kind: "text", text: "ping" }], parentId: null, createdAt: Date.now() };
    const t0 = Date.now();
    let turn: AssistantTurn | undefined;
    try {
      for await (const ev of this.adapterFor(p)({ provider: p.id, model: m, maxTokens: 8 }, [probeMsg], { tools: [] })) if (ev.type === "turn") turn = ev.turn;
    } catch (e) {
      return { ok: false, model: m, detail: scrubSecret(e instanceof Error ? e.message : String(e), p.apiKey) };
    }
    if (turn === undefined) return { ok: false, model: m, detail: "stream produced no turn" };
    if (turn.stopReason === "error") return { ok: false, model: m, detail: scrubSecret(turn.error ?? "stream error", p.apiKey) };
    return { ok: true, model: m, detail: `ok in ${Date.now() - t0} ms (${turn.usage.input} in / ${turn.usage.output} out tokens)` };
  }

  /** The dispatching StreamFn (see the header). */
  stream(): StreamFn {
    const self = this;
    return async function* (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
      const p = self.get(model.provider);
      if (p === undefined) {
        yield { type: "turn", turn: configErrorTurn(`provider "${model.provider}" is not configured — I can't route to it. ${next(`rovecode provider add ${model.provider} <baseUrl> [--protocol openai|anthropic]`)} (or /provider add in the TUI); known: ${self.ids().join(" ")}`) };
        return;
      }
      if (!isConfigured(p)) { yield { type: "turn", turn: configErrorTurn(self.keyHint(p)) }; return; }
      yield* self.adapterFor(p)(model, messages, options);
    };
  }

  private adapterFor(p: ResolvedProvider): StreamFn {
    const sse = wantsStreaming({ ROVECODE_STREAM: this.env["ROVECODE_STREAM"] }); // default ON
    const sig = [p.baseUrl, p.protocol, p.apiKey ?? "", JSON.stringify(p.headers ?? {}), sse ? "sse" : "json"].join("\u0000");
    const hit = this.adapters.get(p.id);
    if (hit !== undefined && hit.sig === sig) return hit.fn;
    const fn = this.factory(p, { sse });
    this.adapters.set(p.id, { sig, fn });
    return fn;
  }
}

// ---------- shared CLI / TUI helpers ----------

export const ADD_USAGE = "add <id> <baseUrl> [--protocol openai|anthropic] [--key-env NAME] [--model <id>] [--no-key] [--project]";

export interface AddArgs { spec: ProviderSpec; scope: FileScope; promptKey: boolean }

/** Parse `add` words (CLI argv tail or TUI slash args) into a validated spec + scope. `--key` (CLI:
 *  prompt for the secret afterwards) is recorded, never a value. Pure; never throws. */
export function parseAddArgs(words: readonly string[]): AddArgs | { error: string } {
  const pos: string[] = [];
  const raw: Record<string, unknown> = {};
  let scope: FileScope = "user";
  let promptKey = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const value = (): string | { error: string } => {
      const v = words[i + 1];
      if (v === undefined || v.startsWith("-")) return { error: `${w} needs a value — ${ADD_USAGE}` };
      i++;
      return v;
    };
    switch (w) {
      case "--protocol": { const v = value(); if (typeof v !== "string") return v; raw["protocol"] = v; break; }
      case "--key-env": { const v = value(); if (typeof v !== "string") return v; raw["keyEnv"] = v; break; }
      case "--model": { const v = value(); if (typeof v !== "string") return v; raw["defaultModel"] = v; break; }
      case "--scope": {
        const v = value(); if (typeof v !== "string") return v;
        if (v !== "user" && v !== "project") return { error: "--scope must be user or project" };
        scope = v; break;
      }
      case "--project": scope = "project"; break;
      case "--user": scope = "user"; break;
      case "--no-key": raw["noKey"] = true; break;
      case "--key": promptKey = true; break;
      default:
        if (w.startsWith("-")) return { error: `unknown flag ${w} — ${ADD_USAGE}` };
        pos.push(w);
    }
  }
  const [id, baseUrl] = pos;
  if (id === undefined || baseUrl === undefined) return { error: `usage: ${ADD_USAGE}` };
  raw["baseUrl"] = baseUrl;
  const v = validateSpec(id, raw);
  if ("error" in v) return v;
  return { spec: v.spec, scope, promptKey };
}

/** One row per provider — key SOURCE only, never the value. */
export function formatProviderLine(p: ResolvedProvider): string {
  const key = p.keySource === "stored" ? "key: stored"
    : p.keySource === "env" ? `key: env ${p.keyEnv}`
    : p.keySource === "inline" ? "key: ROVECODE_API_KEY"
    : p.noKey === true ? "key: not needed"
    : `key: NONE (rovecode auth set ${p.id} · or set ${p.keyEnv})`;
  return `${p.id.padEnd(12)} ${p.protocol.padEnd(9)} ${p.baseUrl.padEnd(40)} ${key}${p.defaultModel !== undefined ? `  model: ${p.defaultModel}` : ""}  [${p.scope}]`;
}

/** Listing for `rovecode provider list`, `/provider list` and the provider_list tool. Built-in providers
 *  without a key are folded into a count unless `all` — sixteen dead rows hide the live ones. */
export function formatProviderList(reg: ProviderRegistry, opts: { all?: boolean } = {}): string {
  const d = reg.defaultRef();
  const all = reg.list();
  const rows = all.filter((p) => opts.all === true || isConfigured(p) || p.scope !== "builtin");
  const lines = [d !== null
    ? `default → ${d.provider}/${d.model || "(no model — pass one with /model or ROVECODE_MODEL)"}${reg.defaultSelector() !== undefined ? `  (providers.json default: ${reg.defaultSelector()})` : ""}`
    : `default → none yet. ${next("rovecode setup")} (or rovecode provider add <id> <baseUrl>, then rovecode auth set <id>)`];
  lines.push(...rows.map(formatProviderLine));
  const hidden = all.length - rows.length;
  if (hidden > 0) lines.push(`(+${hidden} built-in providers without a key — \`list --all\` shows them)`);
  lines.push(...reg.warnings().map((w) => `warning: ${w}`));
  return lines.join("\n");
}
