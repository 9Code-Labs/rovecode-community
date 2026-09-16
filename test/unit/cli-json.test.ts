/** `--json` outside the market: the same promise, checked the same way.
 *
 *  nimbus-a5 found that `market install --json` had spent its whole life printing the human preview and
 *  then an object on one stream, unnoticed because every test until then asserted the flag was ACCEPTED
 *  rather than parsing what the command actually wrote. test/unit/market-json.test.ts closes that for the
 *  market. Sweeping the rest of the CLI the same way turned up `model list --json`, which was in a third
 *  state — neither honoured nor rejected, just silently ignored, so a script asking for data got prose
 *  and no error to notice it by.
 *
 *  Two decisions about how this is checked, both learned by getting them wrong first.
 *
 *  It runs the real binary as a subprocess rather than importing the handler. main.ts is an entry point
 *  with top-level work — importing it starts the TUI — and in any case the promise is about what lands
 *  on a pipe, so testing anything other than a pipe would test a different thing than the one that broke.
 *
 *  And it asserts SHAPE, not a fixture. A temp providers.json was the obvious way to make the output
 *  deterministic, and it does not work: the machine's own configuration and environment still decide
 *  which provider answers, so the fixture quietly had no effect and the test only looked pinned. What
 *  holds for every configuration is that stdout parses, that every row is self-consistent, and that at
 *  most one model is the default — and those are exactly the properties the bug violated. A machine with
 *  no provider configured is handled by its own branch rather than by pretending it cannot happen. */

import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "rovecode.ts");

/** the child hits the REAL default provider's /models endpoint, and that endpoint can legitimately
 *  take tens of seconds under load (measured 638 rows, 30 s+ on a slow evening, 2026-09-10) — the
 *  5 s default killed the run mid-fetch and the timeout read as a failure. 90 s is generous, not
 *  optimistic: the assertions still check shape, never speed. */
async function run(args: string[], timeoutMs = 90_000): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { out, err, code: await p.exited };
  } finally { clearTimeout(timer); }
}

test("model list --json is one parseable document, or nothing at all", async () => {
  const { out, code } = await run(["model", "list", "--json"]);
  if (code !== 0) {
    // no provider configured here: the reason belongs on stderr and stdout must stay empty, so a
    // script's `JSON.parse` fails on nothing rather than on half a sentence
    expect(out.trim()).toBe("");
    return;
  }
  // the exact failure this file exists for: prose and an object down the same stream, parseable as
  // neither. One JSON.parse over the whole of stdout is the only assertion that catches it.
  expect(() => JSON.parse(out)).not.toThrow();
  expect(out.trim().startsWith("{")).toBe(true);

  const doc = JSON.parse(out) as { provider: string; models: { id: string; ref: string; default: boolean }[] };
  expect(typeof doc.provider).toBe("string");
  expect(Array.isArray(doc.models)).toBe(true);
  for (const m of doc.models) {
    expect(typeof m.id).toBe("string");
    expect(m.ref).toBe(`${doc.provider}/${m.id}`);   // the ref a caller would pass back to `model use`
    expect(typeof m.default).toBe("boolean");
  }
  // the terminal marks the default with a leading "*"; a script must be able to read the same fact
  // without parsing a character off the front of a line, and exactly one row can carry it
  expect(doc.models.filter((m) => m.default).length).toBeLessThanOrEqual(1);
}, 90_000);

test("without --json the terminal still gets its list, and nothing that looks like a document", async () => {
  const { out, code } = await run(["model", "list"]);
  if (code !== 0) return;
  expect(out).not.toContain('"models"');
  // trailing whitespace only: `trim()` would eat the leading marker column of the FIRST line, which is
  // exactly the character this loop exists to check
  for (const line of out.replace(/\s+$/, "").split(/\r?\n/).filter(Boolean)) {
    // "* provider/model" or "  provider/model", or the one sentence for an endpoint that listed none
    expect(/^[* ] \S+\/\S+$/.test(line) || line.includes("listed no models")).toBe(true);
  }
}, 90_000);
