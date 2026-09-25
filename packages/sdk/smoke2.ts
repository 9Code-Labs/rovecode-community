import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, mockStream } from "./dist/index.js";
const rc = await createClient({ cwd: mkdtempSync(join(tmpdir(), "sdk-smoke-")), stream: mockStream({ turns: [{ type: "text", text: "hi" }] }) });
const s = await rc.session.create();
try {
  for await (const ev of s.prompt("hello") as AsyncGenerator<{ type: string }>) console.log("EV:", ev.type);
} catch (e) { console.log("THREW:", e instanceof Error ? e.message : String(e)); }
await rc.close();
process.exit(0);
