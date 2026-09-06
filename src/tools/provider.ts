/** provider_list / provider_edit — the agent's window onto the provider registry (providers/registry.ts).
 *
 *  Split like task/task_status (port #26): provider_list is kind "read" (policy action file.read →
 *  auto-allowed under gated rules and in plan mode; it never mutates and never prompts), provider_edit
 *  is kind "custom" → action tool.provider_edit, PROMPT under gated rules (cli/runtime.ts buildCfg),
 *  denied in plan mode by the blanket tool.* rule, allowed under yolo. Children (task tool) get neither.
 *
 *  Secrets: NEITHER tool accepts, returns or echoes an API key. provider_list prints key SOURCES
 *  (stored / env NAME / none); provider_edit refuses any key-shaped argument (looksLikeSecret) and
 *  tells the model how the human sets one — `rovecode auth set <id>` (masked prompt), `/provider key`
 *  in the TUI, or the env var named by keyEnv. A key the model was given would otherwise sit in the
 *  transcript and in the provider's logs forever.
 *
 *  Effects are live: the registry re-reads its files, so the run that follows an add/use — and the
 *  TUI, through registry.onChange — sees the new provider without a restart. */

import type { Tool, ToolOutput } from "../core/types.ts";
import { inferProtocol, isConfigured } from "../providers/provider-config.ts";
import { formatProviderList, type ProviderRegistry } from "../providers/registry.ts";

const SECRET_FIELD_RE = /^(api[_-]?key|key|secret|token|password|auth(orization)?|bearer)$/i;
/** common key prefixes — a value that starts like this is a secret whatever the field is called */
const SECRET_VALUE_RE = /^(sk-|sk_|key-|xai-|gsk_|AKIA|Bearer\s|ghp_)/;

/** The argument name that carries something key-shaped, or null. `keyEnv`/`noKey` are legitimate. */
export function looksLikeSecret(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k === "keyEnv" || k === "noKey") continue;
    if (typeof v !== "string" || v.trim().length === 0) continue;
    if (SECRET_FIELD_RE.test(k)) return k;
    if (SECRET_VALUE_RE.test(v.trim())) return k;
  }
  return null;
}

const refusal = (field: string): string =>
  `provider_edit never accepts API keys (argument "${field}" looks like one) — nothing was stored. Keys stay with the human: ask them to run \`rovecode auth set <id>\` (masked prompt) or \`/provider key <id> <key>\` in the TUI, or to set the env var you name in keyEnv. Then retry without the key.`;

export function providerListTool(reg: ProviderRegistry): Tool {
  return {
    schema: {
      name: "provider_list",
      description: "Inspect model providers (never prompts, never mutates, never shows a key). `list` shows the configured providers, the default provider/model and where each key comes from (stored / env NAME / none; `all` adds keyless built-ins); `models` lists the model ids a provider offers (its providers.json entry or its /models endpoint); `test` makes one tiny real call to a provider (optionally a specific model) and reports ok or the error. Use it before switching models, or when a run ends with a `config:` error.",
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "models", "test"] },
          id: { type: "string", description: "provider id (models / test)" },
          model: { type: "string", description: "model id to test (default: the provider's default model)" },
          all: { type: "boolean", description: "list: include built-in providers that have no key yet" },
        },
        required: ["action"],
      },
    },
    kind: "read",
    sequential: false,
    async execute(args): Promise<ToolOutput> {
      const a = (args && typeof args === "object" ? args : {}) as { action?: string; id?: string; model?: string; all?: boolean };
      switch (a.action) {
        case "list":
          return { ok: true, output: formatProviderList(reg, { all: a.all === true }) };
        case "models": {
          if (!a.id) return { ok: false, output: "models needs `id`" };
          const r = await reg.models(a.id);
          if (!r.ok) return { ok: false, output: r.error };
          return r.models.length > 0
            ? { ok: true, output: `${a.id} models (${r.source}, ${r.models.length}):\n${r.models.join("\n")}` }
            : { ok: true, output: `${a.id}: the endpoint listed no models (it may not implement /models — try a model id directly with test)` };
        }
        case "test": {
          if (!a.id) return { ok: false, output: "test needs `id`" };
          const r = await reg.probe(a.id, a.model);
          return { ok: r.ok, output: `${a.id}/${r.model}: ${r.detail}` };
        }
        default:
          return { ok: false, output: "action must be list | models | test" };
      }
    },
  };
}

export function providerEditTool(reg: ProviderRegistry): Tool {
  return {
    schema: {
      name: "provider_edit",
      description: "Add, remove or select model providers; the human approves each call. `add` registers an endpoint {id, baseUrl, protocol? (openai|anthropic — inferred from the URL), keyEnv? (env var holding the key), defaultModel?, noKey? (local servers), scope? (user|project)} in providers.json. `remove` deletes a file-defined provider. `use` sets the default provider/model (`selector` = \"provider/model\" or a provider id) and takes effect immediately: the TUI switches now, the next run uses it, no restart. NEVER pass an API key here — the call is refused and nothing is stored. After `add`, tell the user to run `rovecode auth set <id>` (or `/provider key <id> <key>` in the TUI), or to set the keyEnv variable; the key is picked up live.",
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "remove", "use"] },
          id: { type: "string" },
          baseUrl: { type: "string", description: "http(s) endpoint root, e.g. https://llm.example.com/v1" },
          protocol: { type: "string", enum: ["openai", "anthropic"] },
          keyEnv: { type: "string", description: "env var that holds the key (default <ID>_API_KEY)" },
          defaultModel: { type: "string" },
          noKey: { type: "boolean", description: "local server: no key required" },
          scope: { type: "string", enum: ["user", "project"], description: "which providers.json: ~/.rovecode (default) or ./.rovecode" },
          selector: { type: "string", description: "use: provider/model" },
        },
        required: ["action"],
      },
    },
    kind: "custom",
    sequential: true,
    async execute(args): Promise<ToolOutput> {
      const leaked = looksLikeSecret(args);
      if (leaked !== null) return { ok: false, output: refusal(leaked) };
      const a = (args && typeof args === "object" ? args : {}) as {
        action?: string; id?: string; baseUrl?: string; protocol?: "openai" | "anthropic"; keyEnv?: string;
        defaultModel?: string; noKey?: boolean; scope?: "user" | "project"; selector?: string;
      };
      const scope = a.scope === "project" ? "project" : "user";
      switch (a.action) {
        case "add": {
          if (!a.id || !a.baseUrl) return { ok: false, output: "add needs `id` and `baseUrl`" };
          const r = reg.add({
            id: a.id, baseUrl: a.baseUrl, protocol: a.protocol ?? inferProtocol(a.baseUrl),
            ...(a.keyEnv !== undefined ? { keyEnv: a.keyEnv } : {}),
            ...(a.defaultModel !== undefined ? { defaultModel: a.defaultModel } : {}),
            ...(a.noKey === true ? { noKey: true } : {}),
          }, scope);
          if ("error" in r) return { ok: false, output: r.error };
          const key = !isConfigured(r)
            ? `key: NOT SET — the user must run \`rovecode auth set ${r.id}\` (or \`/provider key ${r.id} <key>\` in the TUI), or set ${r.keyEnv}; it is picked up immediately, no restart`
            : r.keySource === "stored" ? "key: stored credential" : r.keySource === "env" ? `key: env ${r.keyEnv} (present)` : "key: not needed";
          return { ok: true, output: `added provider "${r.id}" (${r.protocol}, ${r.baseUrl}) to the ${scope} providers.json\n${key}${r.defaultModel !== undefined ? `\ndefault model: ${r.defaultModel}` : ""}\nselect it with provider_edit use ${r.id}/<model>` };
        }
        case "remove": {
          if (!a.id) return { ok: false, output: "remove needs `id`" };
          const r = reg.remove(a.id);
          if ("error" in r) return { ok: false, output: r.error };
          return { ok: true, output: r.removed.length > 0 ? `removed provider "${a.id}" from the ${r.removed.join(" and ")} providers.json` : `provider "${a.id}" was not in any providers.json` };
        }
        case "use": {
          const sel = a.selector ?? a.id;
          if (!sel) return { ok: false, output: "use needs `selector` (provider/model)" };
          const r = reg.setDefault(sel, scope);
          if ("error" in r) return { ok: false, output: r.error };
          const p = reg.get(r.provider);
          const note = p !== undefined && !isConfigured(p) ? `\nnote: ${reg.keyHint(p)}` : "";
          return { ok: true, output: `default → ${r.provider}/${r.model} (saved to the ${scope} providers.json; the TUI switches now, headless runs use it from the next run)${note}` };
        }
        default:
          return { ok: false, output: "action must be add | remove | use" };
      }
    },
  };
}
