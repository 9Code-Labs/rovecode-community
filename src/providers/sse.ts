/** Bounded SSE reader shared by the wire adapters. Frames may span transport chunks or
 * multiple data lines; EOF alone is NOT proof of provider completion (the adapter checks it).
 * Owns the reader, abort listener and idle/deadline timer for exactly the generator lifetime. */
import type { StreamOptions } from "../core/types.ts";

/** Compatibility name used by the Responses adapter. */
export { sseData as sseLines };

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export function streamIdleTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ROVECODE_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

export async function* sseData(body: ReadableStream<Uint8Array>, options?: Pick<StreamOptions, "signal" | "deadlineAt">): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleMs = streamIdleTimeoutMs();
  let buffer = "";
  let data: string[] = [];
  let eof = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPending: ((reason: unknown) => void) | undefined;
  const abort = (): void => rejectPending?.(new Error("provider stream aborted"));
  options?.signal?.addEventListener("abort", abort, { once: true });
  const read = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    if (options?.signal?.aborted) throw new Error("provider stream aborted");
    const remaining = options?.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("provider stream exceeded run deadline");
    const deadline = remaining <= idleMs;
    const failure = new Promise<never>((_, reject) => {
      rejectPending = reject;
      timer = setTimeout(() => reject(new Error(deadline
        ? "provider stream exceeded run deadline"
        : `provider stream idle timeout: no data for ${idleMs} ms`)), Math.min(idleMs, remaining));
    });
    try { return await Promise.race([reader.read(), failure]); }
    finally { clearTimeout(timer); timer = undefined; rejectPending = undefined; }
  };
  try {
    while (!eof) {
      const next = await read();
      eof = next.done;
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      // Treat an unterminated final line as a line too. No byte/Unicode fragments are lost.
      if (eof && buffer.length > 0 && !/[\r\n]$/.test(buffer)) buffer += "\n";
      for (;;) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0) break;
        // CRLF can itself be split across network chunks.
        if (!eof && buffer[end] === "\r" && end === buffer.length - 1) break;
        const line = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        if (line === "") {
          if (data.length === 0) continue;
          const payload = data.join("\n"); data = [];
          if (payload.trim() === "[DONE]") return;
          if (payload.trim()) yield payload;
        } else if (line.startsWith("data:")) {
          const value = line.slice(5);
          data.push(value.startsWith(" ") ? value.slice(1) : value);
        } else if (line === "data") data.push("");
        // comments, event, id and retry fields are intentionally ignored
      }
    }
    const payload = data.join("\n");
    if (payload.trim() && payload.trim() !== "[DONE]") yield payload;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", abort);
    // Do not wait on a misbehaving underlying source's cancel promise.
    if (!eof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
