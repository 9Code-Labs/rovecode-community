/** Scripted fake LSP server for lsp.test.ts (PORT #13). Speaks LSP-over-stdio
 *  (Content-Length framing) with its OWN hand-rolled parser — independent of
 *  src/coding/lsp.ts on purpose, so tests are a real wire round-trip and a
 *  shared framing bug cannot pass silently.
 *
 *  Usage: bun test/fixtures/fake-lsp.ts <mode>
 *    diagnostics — answer initialize; publish 1 error + 1 warning per didOpen/didChange
 *                  (error message embeds the received document version, e.g. "(v2)")
 *    clean       — answer initialize; publish empty diagnostics per didOpen/didChange
 *    mute        — answer initialize; never publish anything (settle-window expiry path)
 *    wedged      — consume stdin, never respond to anything (init-timeout / kill path)
 */

type Json = Record<string, unknown>;

const mode = process.argv[2] ?? "diagnostics";

function send(msg: Json): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function publish(uri: string, version: number): void {
  if (mode === "mute") return;
  const diagnostics =
    mode === "clean"
      ? []
      : [
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
            severity: 1,
            code: 2322,
            source: "fake-ts",
            message: `Type 'string' is not assignable to type 'number'. (v${version})`,
          },
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 2,
            code: 6133,
            source: "fake-ts",
            message: `'unused' is declared but its value is never read. (v${version})`,
          },
        ];
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics } });
}

function handle(msg: Json): void {
  if (mode === "wedged") return; // swallow everything, answer nothing
  const method = msg["method"] as string | undefined;
  const id = msg["id"];
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id: id as number, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: id as number, result: null });
    return;
  }
  if (method === "exit") process.exit(0);
  if (method === "textDocument/didOpen") {
    const doc = (msg["params"] as Json)["textDocument"] as Json;
    publish(doc["uri"] as string, doc["version"] as number);
    return;
  }
  if (method === "textDocument/didChange") {
    const doc = (msg["params"] as Json)["textDocument"] as Json;
    publish(doc["uri"] as string, doc["version"] as number);
    return;
  }
}

// ---- independent incremental Content-Length frame reader over stdin ----

let buf = Buffer.alloc(0);

function drain(): void {
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buf.subarray(0, headerEnd).toString("latin1");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.byteLength < start + len) return; // body not complete yet
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    try {
      handle(JSON.parse(body) as Json);
    } catch {
      /* scripted server: ignore malformed frames */
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  drain();
});
process.stdin.on("end", () => process.exit(0));
