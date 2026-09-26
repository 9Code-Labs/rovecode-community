/** Minimal SSE parser: turns a fetch ReadableStream into an async iterator of
 *  parsed `data:` payloads. Handles the platform's mid-stream error events by
 *  throwing them as typed errors instead of yielding them as data. */

import { APIError } from "./errors.js";

const INCIDENT_RE = /\(incident ([0-9a-f]{6,})\)/i;

export async function* sseEvents<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alive comment or partial frame — skip
        }
        // platform sends mid-stream failures as {"error": {...}} events
        const err = (parsed as { error?: { message?: string; type?: string } }).error;
        if (err?.message) {
          const incident = INCIDENT_RE.exec(err.message)?.[1];
          throw new APIError(err.message, { ...(incident ? { incident } : {}), ...(err.type ? { type: err.type } : {}) });
        }
        yield parsed as T;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
