/** Providers: StreamFn adapters (ADR-003 seam). Errors cross as stopReason "error", never throws.
 *
 *  Wire protocols supported:
 *  - OpenAI-compatible /chat/completions (JSON + SSE streaming), with tools
 *  - Anthropic /messages (x-api-key), with tools
 *  - Any custom base URL + key (AION_BASE_URL/AION_API_KEY or explicit config)
 *  Model catalogs are FETCHED from the endpoint (/v1/models) — never hard-coded (pi pattern). */

import type { StreamFn, Message, AssistantTurn, StreamEvent, ModelRef } from "../core/types.ts";
import { partsText } from "../core/loop.ts";

export interface ProviderConfig {
  id: string;             // provider id, e.g. "kaesra"
  baseUrl: string;        // e.g. https://api.kaesra.tech/v1
  apiKey: string;
  protocol: "openai" | "anthropic";
  defaultModel?: string;
}

export interface ModelCatalogEntry {
  id: string;
  ownedBy?: string;
  type?: string;
}

// ---------- catalog (fetched, cached) ----------

const catalogCache = new Map<string, { models: ModelCatalogEntry[]; fetchedAt: number }>();
const CATALOG_TTL_MS = 5 * 60_000;

export async function fetchModels(cfg: ProviderConfig, force = false): Promise<ModelCatalogEntry[]> {
  const hit = catalogCache.get(cfg.id);
  if (!force && hit && Date.now() - hit.fetchedAt < CATALOG_TTL_MS) return hit.models;
  const url = cfg.baseUrl.replace(/\/$/, "") + "/models";
  let models: ModelCatalogEntry[] = [];
  try {
    const res = await fetch(url, { headers: authHeaders(cfg) });
    if (res.ok) {
      const json = (await res.json()) as { data?: { id: string; owned_by?: string; type?: string }[] };
      models = (json.data ?? []).map((m) => ({ id: m.id, ownedBy: m.owned_by, type: m.type }));
    }
  } catch { /* errors are empty catalog — provider seam never throws */ }
  catalogCache.set(cfg.id, { models, fetchedAt: Date.now() });
  return models;
}

function authHeaders(cfg: ProviderConfig): Record<string, string> {
  return cfg.protocol === "anthropic"
    ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${cfg.apiKey}` };
}

// ---------- factories ----------

export function providerStream(cfg: ProviderConfig): StreamFn {
  return cfg.protocol === "anthropic" ? anthropicStream(cfg) : openaiCompatStream({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
}

export function openaiCompatStream(opts: { baseUrl: string; apiKey: string }): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: { signal?: AbortSignal; tools?: unknown[] }): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    try {
      const res = await fetch(opts.baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: model.model,
          messages: toOpenAiMessages(messages),
          ...(options?.tools?.length ? { tools: toOpenAiToolSchemas(options.tools) } : {}),
          stream: false,
          ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
        }),
        signal: options?.signal,
      });
      if (!res.ok) {
        turn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      } else {
        turn = parseOpenAiResponse(await res.json());
      }
    } catch (e) {
      turn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
    }
    yield { type: "turn", turn };
  };
}

/** Streaming variant: emits text_delta events as they arrive, then the final turn. */
export function openaiCompatStreaming(opts: { baseUrl: string; apiKey: string }): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: { signal?: AbortSignal; tools?: unknown[] }): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    let buffer = "";
    const toolArgs = new Map<number, { id: string; name: string; args: string }>();
    try {
      const res = await fetch(opts.baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: model.model,
          messages: toOpenAiMessages(messages),
          ...(options?.tools?.length ? { tools: toOpenAiToolSchemas(options.tools) } : {}),
          stream: true,
          ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
        }),
        signal: options?.signal,
      });
      if (!res.ok || !res.body) {
        turn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
        yield { type: "turn", turn };
        return;
      }
      let finish = "end_turn";
      const usage = { input: 0, output: 0 };
      for await (const line of sseLines(res.body)) {
        const ev = JSON.parse(line) as {
          choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]; finish_reason?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const c = ev.choices?.[0];
        if (c?.delta?.content) { buffer += c.delta.content; yield { type: "text_delta", text: c.delta.content }; }
        for (const tc of c?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = toolArgs.get(idx) ?? { id: tc.id ?? `tc${idx}`, name: tc.function?.name ?? "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolArgs.set(idx, cur);
        }
        if (c?.finish_reason) finish = c.finish_reason === "tool_calls" ? "tool_use" : c.finish_reason === "length" ? "length" : "end_turn";
        if (ev.usage) { usage.input = ev.usage.prompt_tokens ?? usage.input; usage.output = ev.usage.completion_tokens ?? usage.output; }
      }
      const parts: AssistantTurn["parts"] = [];
      if (buffer) parts.push({ kind: "text", text: buffer });
      for (const [, tc] of [...toolArgs].sort((a, b) => a[0] - b[0])) {
        let args: unknown = {};
        try { args = JSON.parse(tc.args || "{}"); } catch { args = { _raw: tc.args }; }
        parts.push({ kind: "tool_call", id: tc.id, tool: tc.name, args });
      }
      turn = { parts, stopReason: finish, usage };
    } catch (e) {
      turn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
    }
    yield { type: "turn", turn };
  };
}

/** Anthropic Messages protocol adapter. */
export function anthropicStream(opts: { baseUrl: string; apiKey: string }): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: { signal?: AbortSignal; tools?: unknown[] }): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    try {
      const system = messages.filter((m) => m.role === "system").map((m) => partsText(m.parts)).join("\n");
      const body: Record<string, unknown> = {
        model: model.model,
        max_tokens: model.maxTokens ?? 4096,
        messages: toAnthropicMessages(messages),
      };
      if (options?.tools?.length) {
        body.tools = (options.tools as { schema: { name: string; description: string; args: Record<string, unknown> } }[]).map((t) => ({ name: t.schema.name, description: t.schema.description, input_schema: t.schema.args }));
      }
      if (system) body.system = system;
      const res = await fetch(opts.baseUrl.replace(/\/$/, "") + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      if (!res.ok) {
        turn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      } else {
        turn = parseAnthropicResponse(await res.json());
      }
    } catch (e) {
      turn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
    }
    yield { type: "turn", turn };
  };
}

// ---------- parsing ----------

function parseOpenAiResponse(json: unknown): AssistantTurn {
  const j = json as {
    choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string | null }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const c = j.choices?.[0];
  const parts: AssistantTurn["parts"] = [];
  if (c?.message.content) parts.push({ kind: "text", text: c.message.content });
  for (const tc of c?.message.tool_calls ?? []) {
    let args: unknown = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = { _raw: tc.function.arguments }; }
    parts.push({ kind: "tool_call", id: tc.id, tool: tc.function.name, args });
  }
  const stop = (c?.message.tool_calls?.length ?? 0) > 0
    ? "tool_use"
    : c?.finish_reason === "length" ? "length" : "end_turn";
  return { parts, stopReason: stop, usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 } };
}

function parseAnthropicResponse(json: unknown): AssistantTurn {
  const j = json as {
    content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
  const parts: AssistantTurn["parts"] = [];
  for (const b of j.content ?? []) {
    if (b.type === "text" && b.text) parts.push({ kind: "text", text: b.text });
    if (b.type === "tool_use" && b.id) parts.push({ kind: "tool_call", id: b.id, tool: b.name ?? "unknown", args: b.input ?? {} });
  }
  const stop = (j.content ?? []).some((b) => b.type === "tool_use") ? "tool_use" : j.stop_reason === "max_tokens" ? "length" : "end_turn";
  return { parts, stopReason: stop, usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 } };
}

// ---------- message lowering ----------

export function toOpenAiMessages(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    const text = partsText(m.parts);
    const calls = m.parts.filter((p) => p.kind === "tool_call");
    const results = m.parts.filter((p) => p.kind === "tool_result");
    if (m.role === "tool") {
      for (const r of results) {
        if (r.kind === "tool_result") out.push({ role: "tool", tool_call_id: r.callId, content: r.output });
      }
      continue;
    }
    if (m.role === "assistant" && calls.length > 0) {
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.map((c) => c.kind === "tool_call" ? {
          id: c.id, type: "function", function: { name: c.tool, arguments: JSON.stringify(c.args) },
        } : {}),
      });
    } else if (text || m.role === "system") {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

export function toOpenAiToolSchemas(tools: unknown[]): Record<string, unknown>[] {
  return tools.map((t) => {
    const tool = t as { schema: { name: string; description: string; args: Record<string, unknown> } };
    return { type: "function", function: { name: tool.schema.name, description: tool.schema.description, parameters: tool.schema.args } };
  });
}

function toAnthropicMessages(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = partsText(m.parts);
    const calls = m.parts.filter((p) => p.kind === "tool_call");
    const results = m.parts.filter((p) => p.kind === "tool_result");
    if (m.role === "tool") {
      for (const r of results) {
        if (r.kind === "tool_result") {
          out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: r.callId, content: r.output, is_error: !r.ok }] });
        }
      }
      continue;
    }
    if (m.role === "assistant" && calls.length > 0) {
      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: "text", text });
      for (const c of calls) {
        if (c.kind === "tool_call") content.push({ type: "tool_use", id: c.id, name: c.tool, input: c.args });
      }
      out.push({ role: "assistant", content });
    } else if (text) {
      out.push({ role: m.role === "user" ? "user" : "assistant", content: text });
    }
  }
  return out;
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith("data:")) {
        const payload = t.slice(5).trim();
        if (payload && payload !== "[DONE]") yield payload;
      }
    }
  }
}

// ---------- mock (test seam) ----------

export interface MockScript { turns: AssistantTurn[] }

export function mockStream(script: MockScript): StreamFn {
  let i = 0;
  return async function* (_model: ModelRef, _messages: Message[]): AsyncGenerator<StreamEvent> {
    const turn = script.turns[Math.min(i, script.turns.length - 1)]!;
    i++;
    yield { type: "turn", turn };
  };
}

export function textTurn(text: string): AssistantTurn {
  return { parts: [{ kind: "text", text }], stopReason: "end_turn", usage: { input: 0, output: 1 } };
}

export function toolTurn(calls: { id: string; tool: string; args: unknown }[]): AssistantTurn {
  return { parts: calls.map((c) => ({ kind: "tool_call" as const, ...c })), stopReason: "tool_use", usage: { input: 0, output: 1 } };
}

// ---------- registry: named providers from env/config ----------

const builtinProviders: Record<string, { baseUrl: string; protocol: "openai" | "anthropic"; envKey: string }> = {
  kaesra: { baseUrl: "https://api.kaesra.tech/v1", protocol: "openai", envKey: "KAESRA_API_KEY", defaultModel: "zai-org/glm-5.3-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", protocol: "openai", envKey: "OPENAI_API_KEY" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", protocol: "openai", envKey: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", protocol: "openai", envKey: "GROQ_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", protocol: "openai", envKey: "OPENROUTER_API_KEY" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", protocol: "openai", envKey: "OLLAMA_API_KEY" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", protocol: "openai", envKey: "LMSTUDIO_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", protocol: "openai", envKey: "TOGETHER_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", protocol: "openai", envKey: "MISTRAL_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", protocol: "openai", envKey: "CEREBRAS_API_KEY" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", protocol: "openai", envKey: "FIREWORKS_API_KEY" },
  perplexity: { baseUrl: "https://api.perplexity.ai", protocol: "openai", envKey: "PERPLEXITY_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", protocol: "openai", envKey: "XAI_API_KEY" },
  moondream: { baseUrl: "https://api.moondream.ai/v1", protocol: "openai", envKey: "MOONDREAM_API_KEY" },
  vllm: { baseUrl: "http://127.0.0.1:8000/v1", protocol: "openai", envKey: "VLLM_API_KEY" },
};

/** Resolve a provider config: AION_BASE_URL/AION_API_KEY override, else named builtin, else custom id. */
export function resolveProvider(overrides: { baseUrl?: string; apiKey?: string; id?: string; protocol?: "openai" | "anthropic"; defaultModel?: string } = {}): ProviderConfig | null {
  const base = overrides.baseUrl ?? process.env.AION_BASE_URL;
  const key = overrides.apiKey ?? process.env.AION_API_KEY ?? process.env.OPENAI_API_KEY;
  if (base && key) {
    const looksAnthropic = overrides.protocol === "anthropic" || base.includes("anthropic.com");
    return { id: overrides.id ?? "custom", baseUrl: base, apiKey: key, protocol: looksAnthropic ? "anthropic" : "openai", defaultModel: overrides.defaultModel ?? process.env.AION_MODEL };
  }
  for (const [id, p] of Object.entries(builtinProviders)) {
    const k = process.env[p.envKey];
    if (k) return { id, baseUrl: p.baseUrl, apiKey: k, protocol: p.protocol, defaultModel: p.defaultModel };
  }
  return null;
}

export function listBuiltinProviders(): { id: string; baseUrl: string; protocol: string; envKey: string; configured: boolean }[] {
  return Object.entries(builtinProviders).map(([id, p]) => ({
    id, baseUrl: p.baseUrl, protocol: p.protocol, envKey: p.envKey, configured: Boolean(process.env[p.envKey]),
  }));
}
