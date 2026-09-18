/** Real CLI → runtime → SSE adapter → tool dispatch → follow-up wire request.
 * No credentials/network services: an isolated child talks only to a loopback provider. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../../src/cli/main.ts");
const sse = (...events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

for (const protocol of ["openai", "anthropic"] as const) {
  test(`CLI ${protocol} streaming: read → write → final answer, with real tool results on the wire`, async () => {
    const work = mkdtempSync(join(tmpdir(), "rovecode-cli-tools-"));
    const home = mkdtempSync(join(tmpdir(), "rovecode-cli-tools-home-"));
    writeFileSync(join(work, "input.txt"), "tool-roundtrip-canary");
    const requests: { path: string; body: any }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.json() as any;
        requests.push({ path: new URL(req.url).pathname, body });
        if (new URL(req.url).pathname !== (protocol === "openai" ? "/chat/completions" : "/messages")) {
          return Response.json({ error: { message: "wrong protocol endpoint" } }, { status: 400 });
        }
        const n = requests.length;
        const name = n === 1 ? "read" : "write";
        const args = n === 1 ? { path: "input.txt" } : { path: "output.txt", content: "tool-roundtrip-complete" };
        if (protocol === "openai") {
          return n <= 2 ? sse(
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] },
          ) : sse({ choices: [{ delta: { content: "finished" }, finish_reason: "stop" }] });
        }
        return n <= 2 ? sse(
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${n}`, name, input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" } },
          { type: "message_stop" },
        ) : sse(
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "finished" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        );
      },
    });
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k))) as Record<string, string>;
      Object.assign(env, { ROVECODE_HOME: home, ROVECODE_NO_REPOMAP: "1", ROVECODE_RETRY_MAX: "0" });
      // Default SSE for OpenAI; the explicit old opt-in must still honor Anthropic's protocol.
      if (protocol === "anthropic") env.ROVECODE_STREAM = "sse";
      writeFileSync(join(home, "providers.json"), JSON.stringify({
        default: "local/test-model",
        providers: { local: { baseUrl: `http://127.0.0.1:${server.port}`, protocol, noKey: true } },
      }));
      child = Bun.spawn([process.execPath, MAIN, "run", "Read input.txt, write output.txt, then finish", "--accept-edits", "--max-turns", "4", "--output", "json"], {
        cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      const result = JSON.parse(stdout.trim());
      expect(result.status).toBe("done");
      expect(result.toolCalls.map((c: { tool: string; ok: boolean }) => ({ tool: c.tool, ok: c.ok }))).toEqual([{ tool: "read", ok: true }, { tool: "write", ok: true }]);
      expect(readFileSync(join(work, "output.txt"), "utf8")).toBe("tool-roundtrip-complete");
      expect(requests).toHaveLength(3);
      expect(requests[0]!.body.tools.some((t: any) => (t.name ?? t.function?.name) === "read")).toBe(true);
      expect(JSON.stringify(requests[1]!.body.messages)).toContain("tool-roundtrip-canary");
      if (protocol === "openai") {
        expect(requests[1]!.body.messages.find((m: any) => m.role === "tool")).toMatchObject({ tool_call_id: "call_1" });
      } else {
        expect(requests[1]!.body.messages.flatMap((m: any) => m.content).find((p: any) => p.type === "tool_result")).toMatchObject({ tool_use_id: "call_1", is_error: false });
      }
    } finally {
      child?.kill();
      if (child) await child.exited;
      await server.stop(true);
      rmSync(work, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
}
