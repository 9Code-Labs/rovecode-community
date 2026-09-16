/** SSE line reader shared by the streaming adapters (moved VERBATIM out of stream.ts — aion port #75 — so a
 *  second wire (the Codex Responses wire, not in this build yet) can import it without importing stream.ts).
 *  Yields every `data:` payload except the `[DONE]` sentinel; `event:` lines, comments and blank lines
 *  are skipped — the OpenAI Responses stream names its event in the payload's `type` field, so the
 *  `event:` line carries nothing the consumer needs (codex codex-api/src/sse/responses.rs:843-845 fixtures
 *  pair `event:` + `data:` lines the same way). */

export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
