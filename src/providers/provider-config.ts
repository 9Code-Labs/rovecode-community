/** Provider configuration — the DATA half of the provider layer (no adapters, no network).
 *
 *  Sources, merged per provider id in this order (later wins):
 *    1. BUILTIN_PROVIDERS (the table below)            scope "builtin"
 *    2. ~/.rovecode/providers.json (ROVECODE_HOME-aware)   scope "user"
 *    3. <cwd>/.rovecode/providers.json                  scope "project"
 *    4. ROVECODE_BASE_URL + ROVECODE_API_KEY                scope "env" — the "custom" provider, always the default
 *
 *  File shape (both scopes):
 *    { "default"?: "provider/model",
 *      "providers"?: { "<id>": { "baseUrl", "protocol"?, "keyEnv"?, "defaultModel"?, "models"?, "headers"?, "noKey"? } } }
 *
 *  Secrets never live in providers.json. A provider's key is the stored credential (auth.ts,
 *  `rovecode auth set <id>`, masked prompt) else process.env[keyEnv ?? keyNameFor(id)]; `noKey: true`
 *  marks local servers (ollama, vllm) that need none. The `default` selector is "provider/model"
 *  split on the FIRST slash (router.ts grammar) — a bare provider id selects its defaultModel.
 *
 *  Hot reload: ProviderConfig.snapshot() re-reads when the mtime or size of any source file changed
 *  (both providers.json + credentials.json), checked at most once per `throttleMs`. A provider added
 *  from another terminal — or by the agent through provider_edit — is live on the next model call;
 *  no restart. resolveProvider() (stream.ts) is the one-shot form of the same merge, so the CLI and
 *  a long-running TUI always agree on what "the default provider" is. */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialsPath, keyNameFor, loadCredentials, rovecodeHome, type StoredCredential } from "./auth.ts";

export type ProviderProtocol = "openai" | "anthropic";
export type ProviderScope = "builtin" | "user" | "project" | "env";
/** where a provider's key came from: stored credential, env var, the ROVECODE_API_KEY pair, or nowhere */
export type KeySource = "stored" | "env" | "inline" | "none";

export interface ProviderSpec {
  id: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** env var consulted when no credential is stored; default keyNameFor(id) (models.dev name or <ID>_API_KEY) */
  keyEnv?: string;
  defaultModel?: string;
  /** static model list for `/models` when the endpoint has no /models route */
  models?: string[];
  /** extra request headers (proxies, org ids) — sent on every call to this provider */
  headers?: Record<string, string>;
  /** local servers: no key required, the provider counts as configured without one */
  noKey?: boolean;
}

export interface ResolvedProvider extends ProviderSpec {
  keyEnv: string;
  scope: ProviderScope;
  apiKey: string | null;
  keySource: KeySource;
}

export const BUILTIN_PROVIDERS: readonly ProviderSpec[] = [
  { id: "kaesra", baseUrl: "https://api.example.invalid/v1", protocol: "openai", keyEnv: "KAESRA_API_KEY", defaultModel: "zai-org/glm-5.3-flash" },
  { id: "openai", baseUrl: "https://api.openai.com/v1", protocol: "openai", keyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5" },
  { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai", keyEnv: "GROQ_API_KEY" },
  { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", keyEnv: "OPENROUTER_API_KEY" },
  { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", protocol: "openai", keyEnv: "OLLAMA_API_KEY" },
  { id: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", protocol: "openai", keyEnv: "LMSTUDIO_API_KEY" },
  { id: "together", baseUrl: "https://api.together.xyz/v1", protocol: "openai", keyEnv: "TOGETHER_API_KEY" },
  { id: "mistral", baseUrl: "https://api.mistral.ai/v1", protocol: "openai", keyEnv: "MISTRAL_API_KEY" },
  { id: "cerebras", baseUrl: "https://api.cerebras.ai/v1", protocol: "openai", keyEnv: "CEREBRAS_API_KEY" },
  { id: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", protocol: "openai", keyEnv: "FIREWORKS_API_KEY" },
  { id: "perplexity", baseUrl: "https://api.perplexity.ai", protocol: "openai", keyEnv: "PERPLEXITY_API_KEY" },
  { id: "xai", baseUrl: "https://api.x.ai/v1", protocol: "openai", keyEnv: "XAI_API_KEY" },
  { id: "moondream", baseUrl: "https://api.moondream.ai/v1", protocol: "openai", keyEnv: "MOONDREAM_API_KEY" },
  { id: "vllm", baseUrl: "http://127.0.0.1:8000/v1", protocol: "openai", keyEnv: "VLLM_API_KEY" },
];

// ---------- files ----------

/** one providers.json entry as written: baseUrl required, protocol may be omitted (inferred on read) */
export interface ProviderEntry extends Partial<Omit<ProviderSpec, "id" | "baseUrl">> { baseUrl: string }

export interface ProvidersFile {
  default?: string;
  providers?: Record<string, ProviderEntry>;
}

export type FileScope = "user" | "project";

export function userProvidersPath(): string { return join(rovecodeHome(), "providers.json"); }
export function projectProvidersPath(cwd: string): string { return join(cwd, ".rovecode", "providers.json"); }
export function providersPathFor(scope: FileScope, cwd: string): string {
  return scope === "project" ? projectProvidersPath(cwd) : userProvidersPath();
}

/** ids are lowercase slugs — they name env vars (keyNameFor) and appear in "provider/model" selectors */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function inferProtocol(baseUrl: string): ProviderProtocol {
  return baseUrl.includes("anthropic.com") ? "anthropic" : "openai";
}

/** Validate one provider entry (file entry or CLI/tool input) into a spec. Pure; never throws. */
export function validateSpec(id: string, raw: unknown): { spec: ProviderSpec } | { error: string } {
  if (!PROVIDER_ID_RE.test(id)) return { error: `provider id "${id}" must be a lowercase slug (a-z 0-9 _ . -), at most 40 chars` };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: `provider "${id}": entry must be an object` };
  const r = raw as Record<string, unknown>;
  const baseUrl = typeof r["baseUrl"] === "string" ? r["baseUrl"].trim().replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) return { error: `provider "${id}": baseUrl must be an http(s) URL` };
  const protocol = r["protocol"] === undefined ? inferProtocol(baseUrl) : r["protocol"];
  if (protocol !== "openai" && protocol !== "anthropic") return { error: `provider "${id}": protocol must be "openai" or "anthropic"` };
  const spec: ProviderSpec = { id, baseUrl, protocol };
  if (r["keyEnv"] !== undefined) {
    if (typeof r["keyEnv"] !== "string" || !ENV_NAME_RE.test(r["keyEnv"])) return { error: `provider "${id}": keyEnv must be an ENV_VAR_NAME` };
    spec.keyEnv = r["keyEnv"];
  }
  if (r["defaultModel"] !== undefined) {
    if (typeof r["defaultModel"] !== "string" || r["defaultModel"].trim().length === 0) return { error: `provider "${id}": defaultModel must be a non-empty string` };
    spec.defaultModel = r["defaultModel"].trim();
  }
  if (r["models"] !== undefined) {
    if (!Array.isArray(r["models"]) || !r["models"].every((m) => typeof m === "string" && m.trim().length > 0)) return { error: `provider "${id}": models must be a list of model ids` };
    spec.models = (r["models"] as string[]).map((m) => m.trim());
  }
  if (r["headers"] !== undefined) {
    const h = r["headers"];
    if (typeof h !== "object" || h === null || Array.isArray(h) || !Object.values(h as Record<string, unknown>).every((v) => typeof v === "string")) return { error: `provider "${id}": headers must be an object of strings` };
    spec.headers = { ...(h as Record<string, string>) };
  }
  if (r["noKey"] !== undefined) {
    if (typeof r["noKey"] !== "boolean") return { error: `provider "${id}": noKey must be true or false` };
    if (r["noKey"]) spec.noKey = true;
  }
  return { spec };
}

/** Read one providers.json: a missing file is {} silently; a corrupt file or a malformed entry is
 *  dropped with a warning, never fatal (auth.ts loadCredentials idiom). */
export function readProvidersFile(path: string): { data: ProvidersFile; warnings: string[] } {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { data: {}, warnings: [] }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { data: {}, warnings: [`${path}: invalid JSON — ignored`] }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { data: {}, warnings: [`${path}: expected an object — ignored`] };
  const o = parsed as Record<string, unknown>;
  const data: ProvidersFile = {};
  const warnings: string[] = [];
  if (o["default"] !== undefined) {
    if (typeof o["default"] === "string" && o["default"].trim().length > 0) data.default = o["default"].trim();
    else warnings.push(`${path}: "default" must be "provider/model" — ignored`);
  }
  if (o["providers"] !== undefined) {
    const p = o["providers"];
    if (typeof p !== "object" || p === null || Array.isArray(p)) warnings.push(`${path}: "providers" must be an object — ignored`);
    else {
      data.providers = {};
      for (const [id, raw] of Object.entries(p as Record<string, unknown>)) {
        const v = validateSpec(id, raw);
        if ("error" in v) { warnings.push(`${path}: ${v.error} — ignored`); continue; }
        const { id: _id, ...rest } = v.spec;
        data.providers[id] = rest;
      }
    }
  }
  return { data, warnings };
}

export function writeProvidersFile(path: string, data: ProvidersFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// ---------- merge ----------

export interface ProviderSnapshot {
  /** builtins in table order, then file-only providers in file order, then the env "custom" provider */
  providers: ResolvedProvider[];
  /** the `default` selector — project file beats user file */
  defaultSelector?: string;
  defaultScope?: FileScope;
  warnings: string[];
}

export function resolveKey(spec: ProviderSpec, scope: ProviderScope, env: NodeJS.ProcessEnv, creds: Record<string, StoredCredential>): ResolvedProvider {
  const keyEnv = spec.keyEnv ?? keyNameFor(spec.id);
  const stored = creds[spec.id]?.key;
  if (stored !== undefined && stored.trim().length > 0) return { ...spec, keyEnv, scope, apiKey: stored, keySource: "stored" };
  const fromEnv = env[keyEnv];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return { ...spec, keyEnv, scope, apiKey: fromEnv, keySource: "env" };
  return { ...spec, keyEnv, scope, apiKey: null, keySource: "none" };
}

/** The ROVECODE_BASE_URL/ROVECODE_API_KEY pair (ROVECODE_API_KEY falls back to OPENAI_API_KEY, as before). */
export function envCustomProvider(env: NodeJS.ProcessEnv): ResolvedProvider | null {
  const base = env["ROVECODE_BASE_URL"];
  const key = env["ROVECODE_API_KEY"] ?? env["OPENAI_API_KEY"];
  if (!base || !key) return null;
  return {
    id: "custom", baseUrl: base, protocol: inferProtocol(base), keyEnv: "ROVECODE_API_KEY", scope: "env", apiKey: key, keySource: "inline",
    ...(env["ROVECODE_MODEL"] ? { defaultModel: env["ROVECODE_MODEL"] } : {}),
  };
}

export function isConfigured(p: ResolvedProvider): boolean {
  return p.apiKey !== null || p.noKey === true;
}

export function buildSnapshot(cwd: string, env: NodeJS.ProcessEnv = process.env): ProviderSnapshot {
  const warnings: string[] = [];
  const order: string[] = [];
  const specs = new Map<string, { spec: ProviderSpec; scope: ProviderScope }>();
  for (const b of BUILTIN_PROVIDERS) { specs.set(b.id, { spec: b, scope: "builtin" }); order.push(b.id); }
  let defaultSelector: string | undefined;
  let defaultScope: FileScope | undefined;
  const layer = (path: string, scope: FileScope): void => {
    const { data, warnings: w } = readProvidersFile(path);
    warnings.push(...w);
    for (const [id, rest] of Object.entries(data.providers ?? {})) {
      const prev = specs.get(id);
      specs.set(id, { spec: { ...(prev?.spec ?? {}), ...rest, id } as ProviderSpec, scope });
      if (prev === undefined) order.push(id);
    }
    if (data.default !== undefined) { defaultSelector = data.default; defaultScope = scope; }
  };
  layer(userProvidersPath(), "user");
  layer(projectProvidersPath(cwd), "project");
  const creds = loadCredentials();
  const providers = order.map((id) => { const e = specs.get(id)!; return resolveKey(e.spec, e.scope, env, creds); });
  const custom = envCustomProvider(env);
  if (custom) providers.push(custom);
  return { providers, ...(defaultSelector !== undefined ? { defaultSelector, defaultScope } : {}), warnings };
}

// ---------- selection ----------

export interface Selection { provider: string; model?: string }

/** "provider/model" split on the FIRST slash so model ids keep their own slashes; a bare id is a provider. */
export function parseSelector(selector: string): Selection {
  const s = selector.trim();
  const i = s.indexOf("/");
  if (i <= 0) return { provider: s };
  const model = s.slice(i + 1).trim();
  return model.length > 0 ? { provider: s.slice(0, i), model } : { provider: s.slice(0, i) };
}

export interface DefaultPick { provider: ResolvedProvider; model?: string; via: "env-pair" | "default" | "stored" | "env-key" | "no-key" }

/** The default provider (+ its model, when one is known WITHOUT env ROVECODE_MODEL — callers layer
 *  that on top): env pair > file `default` (when that provider is configured) > first stored
 *  credential in order > first env key in order > first keyless file provider > null. The first
 *  three ranks are resolveProvider()'s historical precedence, pinned by test/unit/auth.test.ts. */
export function pickDefault(snap: ProviderSnapshot): DefaultPick | null {
  const custom = snap.providers.find((p) => p.scope === "env");
  if (custom) return { provider: custom, model: custom.defaultModel, via: "env-pair" };
  if (snap.defaultSelector !== undefined) {
    const sel = parseSelector(snap.defaultSelector);
    const p = snap.providers.find((x) => x.id === sel.provider);
    if (p && isConfigured(p)) return { provider: p, model: sel.model ?? p.defaultModel, via: "default" };
  }
  const stored = snap.providers.find((p) => p.keySource === "stored");
  if (stored) return { provider: stored, model: stored.defaultModel, via: "stored" };
  const fromEnv = snap.providers.find((p) => p.keySource === "env");
  if (fromEnv) return { provider: fromEnv, model: fromEnv.defaultModel, via: "env-key" };
  const noKey = snap.providers.find((p) => p.noKey === true);
  if (noKey) return { provider: noKey, model: noKey.defaultModel, via: "no-key" };
  return null;
}

// ---------- live view (hot reload) ----------

export class ProviderConfig {
  private snap: ProviderSnapshot | null = null;
  private stamp = "";
  private checkedAt = -Infinity;
  private readonly listeners = new Set<(snap: ProviderSnapshot) => void>();

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly throttleMs = 250,
  ) {}

  /** the files whose mtime/size drive reloads */
  sourcePaths(): string[] { return [userProvidersPath(), projectProvidersPath(this.cwd), credentialsPath()]; }

  private stampNow(): string {
    return this.sourcePaths().map((p) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } }).join("|");
  }

  /** Current merged view. Re-reads when a source file changed (checked at most every throttleMs);
   *  listeners fire on every rebuild after the first. */
  snapshot(): ProviderSnapshot {
    const now = Date.now();
    if (this.snap !== null && now - this.checkedAt < this.throttleMs) return this.snap;
    this.checkedAt = now;
    const stamp = this.stampNow();
    if (this.snap === null || stamp !== this.stamp) {
      const first = this.snap === null;
      this.stamp = stamp;
      this.snap = buildSnapshot(this.cwd, this.env);
      if (!first) for (const cb of this.listeners) cb(this.snap);
    }
    return this.snap;
  }

  /** Force a re-read on the next snapshot() (in-process writers call this right after writing). */
  invalidate(): void { this.checkedAt = -Infinity; this.stamp = ""; }

  onChange(cb: (snap: ProviderSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
