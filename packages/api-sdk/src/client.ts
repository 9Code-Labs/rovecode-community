import { errorFromResponse, RateLimitError, RovecodeError } from "./errors.js";
import { sseEvents } from "./sse.js";
import type {
  ChatCompletion,
  ChatCompletionRequest,
  ChatChunk,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ModelList,
  VideoGenerateRequest,
  VideoJob,
} from "./types.js";

export interface RovecodeOptions {
  /** `rove_live_...` — from the dashboard's API Keys section */
  apiKey: string;
  /** default: https://api.rovecode.dev/v1 */
  baseURL?: string;
  /** request ceiling in ms (default 10 min — reasoning models think long) */
  timeoutMs?: number;
  /** automatic retries on 429/5xx with exponential backoff (default 2) */
  maxRetries?: number;
  /** extra headers merged into every request */
  headers?: Record<string, string>;
  /** test seam */
  fetch?: typeof fetch;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class Rovecode {
  readonly chat: { completions: Completions };
  readonly models: Models;
  readonly images: Images;
  readonly videos: Videos;

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(opts: RovecodeOptions) {
    if (!opts.apiKey) throw new RovecodeError("apiKey is required — get one at rovecode.dev dashboard");
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? "https://api.rovecode.dev/v1").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.extraHeaders = opts.headers ?? {};
    this.fetchFn = opts.fetch ?? fetch;
    this.chat = { completions: new Completions(this) };
    this.models = new Models(this);
    this.images = new Images(this);
    this.videos = new Videos(this);
  }

  /** internal: one HTTP call with retry/backoff; throws typed errors */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchFn(this.baseURL + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...this.extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) { await sleep(backoff(attempt++)); continue; }
        throw new RovecodeError(`network error: ${(e as Error).message}`);
      }
      clearTimeout(timer);

      if (res.ok) return (await res.json()) as T;

      const parsed = await res.json().catch(() => undefined);
      const err = errorFromResponse(res.status, parsed, res.headers);
      if (attempt < this.maxRetries && RETRYABLE.has(res.status)) {
        await sleep(err instanceof RateLimitError ? err.retryAfterMs : backoff(attempt++));
        continue;
      }
      throw err;
    }
  }

  /** internal: streaming POST — caller iterates chunks. Same retry policy as
   *  request(): network failures and 429/5xx before headers get backoff. */
  async requestStream(path: string, body: unknown): Promise<ReadableStream<Uint8Array>> {
    let attempt = 0;
    for (;;) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchFn(this.baseURL + path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...this.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) { await sleep(backoff(attempt++)); continue; }
        throw new RovecodeError(`network error: ${(e as Error).message}`);
      }
      clearTimeout(timer);

      if (res.ok && res.body) return res.body;

      const parsed = await res.json().catch(() => undefined);
      const err = errorFromResponse(res.status, parsed, res.headers);
      if (attempt < this.maxRetries && RETRYABLE.has(res.status)) {
        await sleep(err instanceof RateLimitError ? err.retryAfterMs : backoff(attempt++));
        continue;
      }
      throw err;
    }
  }
}

class Completions {
  constructor(private readonly c: Rovecode) {}

  /** one-shot completion */
  create(req: ChatCompletionRequest & { stream?: false }): Promise<ChatCompletion>;
  /** streaming — returns an async iterable of chunks */
  create(req: ChatCompletionRequest & { stream: true }): Promise<AsyncGenerator<ChatChunk, void>>;
  async create(req: ChatCompletionRequest): Promise<ChatCompletion | AsyncGenerator<ChatChunk, void>> {
    if (req.stream) return this.stream(req);
    return this.c.request<ChatCompletion>("POST", "/chat/completions", req);
  }

  /** explicit streaming helper (same as create({stream:true})) */
  async stream(req: ChatCompletionRequest): Promise<AsyncGenerator<ChatChunk, void>> {
    const body = await this.c.requestStream("/chat/completions", { ...req, stream: true });
    return sseEvents<ChatChunk>(body);
  }

  /** convenience: stream and accumulate the full text (+ reasoning if present) */
  async collect(req: ChatCompletionRequest): Promise<{ content: string; reasoning: string; usage?: import("./types.js").Usage }> {
    let content = "";
    let reasoning = "";
    let usage: import("./types.js").Usage | undefined;
    for await (const chunk of await this.stream(req)) {
      const d = chunk.choices[0]?.delta;
      if (d?.content) content += d.content;
      if (d?.reasoning_content) reasoning += d.reasoning_content;
      if (chunk.usage) usage = chunk.usage;
    }
    const out: { content: string; reasoning: string; usage?: import("./types.js").Usage } = { content, reasoning };
    if (usage) out.usage = usage;
    return out;
  }
}

class Models {
  constructor(private readonly c: Rovecode) {}
  /** the live catalog — text, image and video entries with their capabilities */
  list(): Promise<ModelList> {
    return this.c.request<ModelList>("GET", "/models");
  }
}

class Images {
  constructor(private readonly c: Rovecode) {}
  generate(req: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    return this.c.request<ImageGenerateResponse>("POST", "/images/generations", req);
  }
}

class Videos {
  constructor(private readonly c: Rovecode) {}
  /** submit a render job */
  generate(req: VideoGenerateRequest): Promise<VideoJob> {
    return this.c.request<VideoJob>("POST", "/videos/generations", req);
  }
  /** poll until done (default: every 5s, up to 10 min) */
  async wait(id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<VideoJob> {
    const interval = opts.intervalMs ?? 5_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    for (;;) {
      const job = await this.c.request<VideoJob>("GET", `/videos/${encodeURIComponent(id)}`);
      if (job.status === "completed" || job.status === "failed") return job;
      if (Date.now() > deadline) throw new RovecodeError(`video job ${id} did not finish in time`);
      await sleep(interval);
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(2 ** attempt * 500, 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
