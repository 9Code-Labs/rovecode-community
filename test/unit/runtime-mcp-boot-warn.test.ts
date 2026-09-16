/** A server the loader accepted but that never connects is REPORTED at boot, not just counted.
 *
 *  Found on a clean checkout (2026-09-06): mcp.json with a valid server and one whose command does not exist
 *  gave a startup card reading "2 MCP servers" and no note, ever, about the second — runtime.ts kicked
 *  connect() off on a timer and discarded its `failed` list. reloadMcp (the in-session install path) already
 *  returned failures; boot now sends them down the same channel the loader's own "skipped" lines use
 *  (pluginWarn → the TUI's warn notes, `plugins: …` on stderr headless). The card's number stays what it
 *  is — servers configured — and the one that failed says so. */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ToolCallPart, ToolContext } from "../../src/core/types.ts";
import { scratchHome, writeTrustedMcpJson } from "../helpers/mcp-trust.ts";

const dirs: string[] = [];
const restoreHome = scratchHome();
afterAll(() => { restoreHome(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a configured server whose command does not exist is counted AND named: `mcp: server \"…\" did not connect — …` reaches the plugin warnings once connect() settles", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-bootwarn-")); dirs.push(cwd);
  writeTrustedMcpJson(cwd, { ghost: { command: "rovecode-not-a-real-binary-bootwarn" } });
  const rt = createRuntime({ cwd, stream: null });
  const seen: string[] = [];
  rt.plugins.onWarning((w) => seen.push(w));
  expect(rt.mcp?.serverNames()).toEqual(["ghost"]);                       // the card's number: configured
  expect(seen.some((w) => w.includes("did not connect"))).toBe(false);    // nothing claimed before anyone tried
  // mcp_list awaits mcpReady, which settles when connect() has: the same gate the tools use
  const ctx: ToolContext = { sessionId: "t", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
  const call: ToolCallPart = { kind: "tool_call", id: "c1", tool: "mcp_list", args: {} };
  const cfg = rt.buildCfg(true);
  const out = await rt.registry.dispatch(call, ctx, undefined, cfg.permissionRules, cfg.approval, () => {});
  expect(out.output).toContain("no MCP servers connected");
  const note = seen.find((w) => w.startsWith('mcp: server "ghost" did not connect — '));
  expect(note).toBeDefined();
  expect(note!.length).toBeGreaterThan('mcp: server "ghost" did not connect — '.length); // the error travels with it
  // buffered for a late subscriber too (the TUI attaches its note listener after createRuntime)
  const late: string[] = [];
  rt.plugins.onWarning((w) => late.push(w));
  expect(late).toContain(note!);
  await rt.mcp?.close();
});
