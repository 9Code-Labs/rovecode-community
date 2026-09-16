/** A package runner downloads before it runs, and a download is not a hang.
 *
 *  Measured on this machine before this existed: a first-ever `uvx mcp-server-time` took over 10 s and
 *  lost to the default connect budget, so the user saw "MCP error -32001: Request timed out" for a server
 *  that worked perfectly — and would have seen it again on the next start, because nothing had finished
 *  caching. `npx -y` has the same shape (7 s and 47 MB cold). Warm they are 1.5 s and 1.8 s, well inside
 *  the default, which is why this only ever bites on the very first run: the worst possible moment. */

import { describe, expect, test } from "bun:test";
import { RUNNER_CONNECT_MS, isPackageRunner, runnerTimeoutMessage } from "../../src/mcp/client.ts";

const stdio = (command?: string) => ({ name: "srv", transport: "stdio" as const, command });

describe("isPackageRunner", () => {
  test("the runners that fetch before they run, however the command is spelled", () => {
    for (const cmd of ["npx", "uvx", "pipx", "bunx", "NPX", "npx.cmd", "uvx.exe"]) {
      expect(isPackageRunner(stdio(cmd))).toBe(true);
    }
    // and by path, on either separator — a config may name the runner absolutely
    expect(isPackageRunner(stdio(String.raw`C:\Program Files\nodejs\npx.cmd`))).toBe(true);
    expect(isPackageRunner(stdio("/usr/local/bin/uvx"))).toBe(true);
  });

  test("an installed binary is not a runner — this is exactly what `--local` buys", () => {
    expect(isPackageRunner(stdio("node"))).toBe(false);
    expect(isPackageRunner(stdio(String.raw`C:\Users\b\.rovecode\mcp\node_modules\x\dist\index.js`))).toBe(false);
    expect(isPackageRunner(stdio("docker"))).toBe(false);          // pulls once, then cached by docker
    expect(isPackageRunner(stdio(undefined))).toBe(false);
    expect(isPackageRunner({ transport: "http" as const, command: "npx" })).toBe(false);   // a remote never spawns
  });
});

describe("runnerTimeoutMessage", () => {
  test("a runner's timeout says what happened and both ways out of it", () => {
    const m = runnerTimeoutMessage(stdio("uvx"), RUNNER_CONNECT_MS);
    expect(m).toContain('"srv"');
    expect(m).toContain("90s");
    expect(m).toContain("uvx downloads the server's package on first use");
    expect(m).toContain("Try again");                              // the download is cached now
    expect(m).toContain("--local --force");                        // or stop paying it every start
  });

  test("anything else gets the plain sentence — no advice that does not apply", () => {
    const m = runnerTimeoutMessage(stdio("node"), 10_000);
    expect(m).toBe('connect to MCP server "srv" timed out after 10s');
    expect(m).not.toContain("--local");
  });

  test("the runner budget is generous enough for a cold fetch, and only runners get it", () => {
    expect(RUNNER_CONNECT_MS).toBeGreaterThanOrEqual(60_000);      // 10 s lost a real uvx cold start
  });
});
