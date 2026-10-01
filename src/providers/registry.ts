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
import { ModelCatalog, type ModelInfo } from "@rovecode-labs/models";
import {
  ProviderConfig, isConfigured, parseSelector, pickDefault, providersPathFor, readProvidersFile, validateSpec, writeProvidersFile,
  type FileScope, type ProviderSnapshot, type ProviderSpec, type ResolvedProvider,
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

  keyHint(p: ResolvedProvider): string {
    return `no API key for provider "${p.id}" — I can't call it without one. ${next(`rovecode auth set ${p.id}`)} (masked prompt) · or /provider key ${p.id} <key> in the TUI · or set ${p.keyEnv}`;
  }

  /** The provider's models, from the first source that has any: the providers.json `models` list, the
   *  endpoint's /models route (only when a key is stored — no key means the fetch could not answer
   *  anyway), then the model catalog. The catalog rung is what makes `rovecode model list anthropic`
   *  useful: Anthropic's API has no /models route at all, and "add a key first" was the answer to a
   *  question the shipped data could already answer. `source` says which rung answered, so the caller
   *  can say so. */
  async models(id: string): Promise<{ ok: true; models: string[]; source: ModelListSource } | { ok: false; error: string }> {
    const p = this.get(id);
    if (p === undefined) return { ok: false, error: `unknown provider "${id}" — known: ${this.ids().join(" ")}` };
    if (p.models !== undefined && p.models.length > 0) return { ok: true, models: p.models, source: "file" };
    if (isConfigured(p)) {
      const list = await fetchModels(toWireConfig(p), true);
      if (list.length > 0) return { ok: true, models: list.map((m) => m.id), source: "endpoint" };
    }
    const known = new ModelCatalog().modelsFor(id);
    if (known !== undefined) return { ok: true, models: known.ids, source: "catalog" };
    if (!isConfigured(p)) return { ok: false, error: this.keyHint(p) };
    return { ok: true, models: [], source: "endpoint" };
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
    const sig = [p.baseUrl, p.protocol, p.apiKey ?? "", JSON.stringify(p.headers ?? {}), sse ? "sse" : "json"].join(" ");
    const hit = this.adapters.get(p.id);
    if (hit !== undefined && hit.sig === sig) return hit.fn;
    const fn = this.factory(p, { sse });
    this.adapters.set(p.id, { sig, fn });
    return fn;
  }
}

// ---------- shared CLI / TUI helpers ----------

export const ADD_USAGE = "add <id> <baseUrl> [--protocol openai|anthropic] [--key-env NAME] [--model <id>] [--context-window <tokens>] [--no-key] [--project]";

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
      case "--context-window": {
        // the provider-wide fallback contextWindow — the catalog answers for known models; this is the
        // word the usage panel and history budget stand on for the ones it does not (context-window.ts
        // rung 2). Without it an off-catalog provider shows ≈128k forever.
        const v = value(); if (typeof v !== "string") return v;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { error: `--context-window must be a positive token count (e.g. --context-window 131072)` };
        raw["contextWindow"] = Math.floor(n); break;
      }
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
/** where a `models()` answer came from, in precedence order */
export type ModelListSource = "file" | "endpoint" | "catalog";

/** one row of a formatted model list, annotated with what the catalog knows (or not — undefined fields
 *  render as "—", never as a guess) */
export interface ModelListRow {
  id: string;
  /** the session default gets a `*` */
  default: boolean;
  contextWindow?: number;
  priceIn?: number;
  priceOut?: number;
  reasoning?: boolean;
  tools?: boolean;
  vision?: boolean;
  /** priced from rovecode's own table (catalog-local.ts), not models.dev — marked † with a footnote */
  localSource?: boolean;
}

/** ModelInfo → a row, or a bare row when the model is not in the catalog. `vision` is a separate
 *  input because it is a catalog METHOD (supportsImages), not a ModelInfo field. */
export function annotateModel(id: string, isDefault: boolean, info: ModelInfo | undefined, vision?: boolean): ModelListRow {
  if (info === undefined) return { id, default: isDefault };
  return {
    id, default: isDefault,
    ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
    ...(info.pricing?.inputPerMTok !== undefined ? { priceIn: info.pricing.inputPerMTok } : {}),
    ...(info.pricing?.outputPerMTok !== undefined ? { priceOut: info.pricing.outputPerMTok } : {}),
    ...(info.supportsReasoning !== undefined ? { reasoning: info.supportsReasoning } : {}),
    ...(info.supportsTools !== undefined ? { tools: info.supportsTools } : {}),
    ...(vision === true ? { vision: true } : {}),
    ...(info.source === "local" ? { localSource: true } : {}),
  };
}

/** 1_050_000 → "1.05M", 131_072 → "131k", 8_000 → "8k" — the column is six wide, so precision past
 *  that is noise; `model show` carries the exact number. */
export function formatContextTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) { const v = n / 1_000_000; return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`; }
  if (n >= 1_000) { const v = n / 1_000; return `${Number.isInteger(v) ? v : Math.round(v)}k`; }
  return String(n);
}

const SOURCE_LABEL: Record<ModelListSource, string> = {
  file: "providers.json",
  endpoint: "the endpoint's /models route",
  catalog: "rovecode's model catalog — the endpoint has no /models route, or no key is stored yet",
};

/** `rovecode model list <provider>`: one aligned row per model with its context window, its price and
 *  its capabilities — the three facts a person chooses a model on. Unknowns render as "—" rather than
 *  a guess (a guessed context window is how the usage panel's ≈ convention got invented, and it does
 *  not belong in a list). Pure: the rows arrive annotated, nothing here does I/O. */
export function formatModelList(providerId: string, rows: ModelListRow[], source: ModelListSource): string {
  const header = `${providerId} — ${rows.length} model${rows.length === 1 ? "" : "s"} (${SOURCE_LABEL[source]})`;
  if (rows.length === 0) return `${header}
  (none)`;
  const idW = Math.min(Math.max(...rows.map((r) => r.id.length)), 48);
  const money = (n: number | undefined): string => (n === undefined ? "—" : `$${n}`);
  const caps = (r: ModelListRow): string =>
    [r.reasoning === true ? "reasoning" : "", r.tools === true ? "tools" : "", r.vision === true ? "vision" : ""].filter(Boolean).join(" · ");
  const lines = [header];
  let anyLocal = false;
  for (const r of rows) {
    if (r.localSource) anyLocal = true;
    const id = (r.id.length > idW ? r.id.slice(0, idW - 1) + "…" : r.id).padEnd(idW);
    const ctx = formatContextTokens(r.contextWindow).padStart(6);
    const price = r.priceIn === undefined && r.priceOut === undefined ? "—".padStart(11) : `${money(r.priceIn)}/${money(r.priceOut)}`.padStart(11);
    const cap = caps(r);
    lines.push(`${r.default ? "*" : " "} ${id} ${ctx}  ${price}${cap ? `  ${cap}` : ""}${r.localSource ? " †" : ""}`);
  }
  if (anyLocal) lines.push("† priced from rovecode's own table, not models.dev — `rovecode model show <id>` says which page and which day");
  if (rows.length > 60) lines.push(`(${rows.length} models — narrow it: rovecode model list ${providerId} | grep <word>)`);
  return lines.join("\n");
}

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
