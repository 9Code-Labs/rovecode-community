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
 *    garbage     — like diagnostics, but emit malformed frames (JSON `null` body, scalar
 *                  body, publishDiagnostics with params:null) at startup, before the
 *                  initialize answer, and before every publish; the good publishes omit
 *                  params.version (versionless publishes must stay accepted)
 *    laggy       — publishes lag one edit behind: didOpen/didChange for version N first
 *                  re-publishes version N-1's stale diagnostics (params.version = N-1),
 *                  then N's own after 150ms (stale-version rejection path)
 *    echo-root   — like diagnostics, but the error message embeds initialize's rootUri
 *                  (per-root default-gate path: each root must get its own server)
 *    echo-lang [tail…] — like diagnostics, but the error message embeds didOpen's languageId and
 *                  the argv after the mode (`lang=<id> argv=<tail>`): the table's exact-argv / languageId path
 */

type Json = Record<string, unknown>;

const mode = process.argv[2] ?? "diagnostics";
const LAG_MS = 150;
let rootUri = "";
let languageId = "";

function send(msg: Json): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

/** raw Content-Length frame around an arbitrary (possibly non-object) JSON body */
function sendRaw(body: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`);
  process.stdout.write(body);
}

/** the malformed-frame kinds that once killed the client's reader loop for good */
function sendGarbage(): void {
  sendRaw("null"); // valid JSON, not an object
  sendRaw("42");   // scalar body
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: null }); // null params
}

function diagnosticsFor(version: number): Json[] {
  if (mode === "clean") return [];
  const message =
    mode === "echo-root"
      ? `root=${rootUri} (v${version})`
      : mode === "echo-lang"
        ? `lang=${languageId} argv=${process.argv.slice(3).join(" ")} (v${version})`
        : `Type 'string' is not assignable to type 'number'. (v${version})`;
  return [
    {
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
      severity: 1,
      code: 2322,
      source: "fake-ts",
      message,
    },
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 2,
      code: 6133,
      source: "fake-ts",
      message: `'unused' is declared but its value is never read. (v${version})`,
    },
  ];
}

function sendPublish(uri: string, version: number, withVersion: boolean): void {
  const params: Json = { uri, diagnostics: diagnosticsFor(version) };
  if (withVersion) params["version"] = version;
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params });
}

function publish(uri: string, version: number): void {
  if (mode === "mute") return;
  if (mode === "laggy") {
    // slow analyzer: the previous edit's publish lands now, this edit's only after a lag
    if (version > 0) sendPublish(uri, version - 1, true);
    setTimeout(() => sendPublish(uri, version, true), LAG_MS);
    return;
  }
  if (mode === "garbage") {
    sendGarbage(); // the client must survive these and still decode the very next frame
    sendPublish(uri, version, false); // no params.version: versionless publishes stay accepted
    return;
  }
  sendPublish(uri, version, true);
}

function handle(msg: Json): void {
  if (mode === "wedged") return; // swallow everything, answer nothing
  const method = msg["method"] as string | undefined;
  const id = msg["id"];
  if (method === "initialize") {
    rootUri = String(((msg["params"] as Json | null)?.["rootUri"] as string | undefined) ?? "");
    if (mode === "garbage") sendGarbage(); // garbage BEFORE the initialize answer
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
    languageId = String(doc["languageId"] ?? "");
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

if (mode === "garbage") sendGarbage(); // greet the client with poison before it even asks

process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  drain();
});
process.stdin.on("end", () => process.exit(0));
