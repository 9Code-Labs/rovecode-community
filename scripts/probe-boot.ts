/** A sextant session's BOOT alone, in the current repo: runTui with a SextantRenderer over MemoryIO and a
 *  mock stream with no turns (no provider is contacted). Samples time since process start, RSS, heap and
 *  loaded-module count after the imports, at the first frame, and after 1 s and 3 s of idling, plus whether
 *  the three heavy optional loads (gpt-tokenizer tables, the @ast-grep addon, the MCP SDK) are resident.
 *  Mirrors tui/sextant-smoke.ts's boot without the scripted turns.
 *    bun scripts/probe-boot.ts            samples through 3 s of idle
 *    bun scripts/probe-boot.ts --quick    exits right after the first frame (for `bun --cpu-prof`)
 *    --session <id>                       resume that session from <cwd>/.rovecode/sessions (a transcript at boot)
 *    ROVECODE_TRACE_BOOT=1 adds app.ts's own [boot] phase trace. */
import { mockStream } from "../src/providers/stream.ts";
import { SextantRenderer } from "../src/sextant/sextant-renderer.ts";
import { runTui } from "../src/tui/app.ts";
import { MemoryIO } from "../src/tui/sextant-io.ts";

const quick = process.argv.includes("--quick");
const sessIx = process.argv.indexOf("--session");
const sessionId = sessIx !== -1 ? process.argv[sessIx + 1] : undefined;
const mb = (n: number): number => +(n / 1048576).toFixed(1);
const loaded = (needle: string): boolean => Object.keys(require.cache).some((k) => k.includes(needle));
const sample = (at: string): void => {
  const m = process.memoryUsage();
  console.log(JSON.stringify({ at, sinceStartMs: +performance.now().toFixed(0), rssMB: mb(m.rss), heapMB: mb(m.heapUsed), modules: Object.keys(require.cache).length, tokenizer: loaded("gpt-tokenizer"), astGrep: loaded("ast-grep"), mcpSdk: loaded("modelcontextprotocol") }));
};
sample("after imports");
const cwd = process.cwd();
const io = new MemoryIO(160, 44, { COLORTERM: "truecolor" });
const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
const t0 = performance.now();
const app = runTui({ renderer, stream: mockStream({ turns: [] }), cwd, permission: "ask", exitOnClose: false, model: "scripted", ...(sessionId !== undefined ? { sessionId } : {}) });
await new Promise((r) => setTimeout(r, 0));
console.log(JSON.stringify({ bootMs: +(performance.now() - t0).toFixed(0) }));
sample("first frame");
if (!quick) {
  await new Promise((r) => setTimeout(r, 1000));
  sample("idle 1 s");
  await new Promise((r) => setTimeout(r, 2000));
  Bun.gc(true);
  sample("idle 3 s (after gc)");
}
io.feed("\x03");
await app;
await renderer.drain().catch(() => {});
process.exit(0);
