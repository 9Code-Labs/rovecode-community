/** `rovecode doctor`: one pass over the checks that already exist, honest about what it did not check, never a
 *  secret in its output, one document with --json, and an exit code that means something — a fresh install with
 *  no provider is a note (exit 0), a configured server that cannot run is a failure (exit 1). */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDoctor, runDoctor, type DoctorReport } from "../../src/cli/doctor.ts";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const saved = process.env.ROVECODE_HOME;
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved; });

/** a scratch cwd + home; the home is ALSO what rovecodeHome() answers, because settings and providers read it there */
function scratch() {
  const cwd = tmp("rovecode-doctor-cwd-"), home = tmp("rovecode-doctor-home-");
  const platformHome = tmp("rovecode-doctor-user-");
  process.env.ROVECODE_HOME = home;
  // Populate both names: tests explicitly simulate either platform and CI hosts
  // must not inherit the runner account's real home directory.
  const env: Record<string, string | undefined> = { ROVECODE_HOME: home, PATH: "", USERPROFILE: platformHome, HOME: platformHome };
  return { cwd, home, env };
}
const none = () => null;
const byId = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id)!;

test("a fresh install: no provider is a NOTE and exit 0; every check present; the non-checks are named; --json is one document", async () => {
  const s = scratch();
  const r = await runDoctor({ cwd: s.cwd, home: s.home, env: s.env, which: none, prereqEnv: { PATH: "", windows: false }, connect: false });
  expect(r.exitCode).toBe(0);
  expect(r.ok).toBe(true);
  expect(r.checks.map((c) => c.id)).toEqual(["home", "provider", "permission", "trust", "mcp", "tools", "verify", "checkpoints"]); // trust (2026-09-07): the project files that could make rovecode run or import something
  expect(byId(r, "provider").status).toBe("note");
  expect(byId(r, "provider").summary).toContain("no provider configured yet");
  expect(byId(r, "mcp").summary).toContain("no MCP servers configured");
  expect(byId(r, "permission").summary).toContain("ask first");
  expect(byId(r, "permission").summary).toContain("from the default");
  expect(byId(r, "checkpoints").summary).toContain("no shadow repository");
  expect(r.notChecked.some((n) => n.includes("billed"))).toBe(true);
  // tools: nothing configured needs node/npm/npx/uvx, so their absence is a note; git's absence is a warn
  const tools = byId(r, "tools");
  expect(tools.status).toBe("warn");
  expect(tools.detail!.find((l) => l.includes("git"))).toContain("not on PATH");
  expect(tools.detail!.find((l) => l.includes(" npx "))).toContain("nothing configured here needs it yet");
  // and as a command, --json is exactly one document carrying the same report
  const out: string[] = [];
  expect(await cmdDoctor(["--json", "--no-connect"], { cwd: s.cwd, home: s.home, env: s.env, which: none, prereqEnv: { PATH: "", windows: false }, out: (l) => out.push(l), err: () => {} })).toBe(0);
  const doc = JSON.parse(out.join("\n")) as DoctorReport;
  expect(doc.checks.length).toBe(8); // + the trust row (2026-09-07)
  expect(doc.notChecked.some((n) => n.includes("--no-connect"))).toBe(false);   // nothing to connect, so nothing skipped
});

test("MCP: a placeholder is a warn, an unset ${VAR} is a warn, an untrusted project file is a note, an unparseable file is a FAIL (exit 1); npx servers get the install-once line; node/npx absence becomes a failure once something needs them", async () => {
  const s = scratch();
  writeFileSync(join(s.home, "mcp.json"), JSON.stringify({ mcpServers: {
    holey: { command: "npx", args: ["-y", "x-server", "<directory the server may touch>"] },
    keyed: { command: "npx", args: ["-y", "y-server"], env: { TOKEN: "${DOCTOR_UNSET_TOKEN_XYZ}" } },
    fine: { command: "npx", args: ["-y", "z-server"] },
    sleeper: { command: "npx", args: ["-y", "w-server"], enabled: false },
  } }));
  mkdirSync(join(s.cwd, ".rovecode"));
  writeFileSync(join(s.cwd, ".rovecode", "mcp.json"), JSON.stringify({ mcpServers: { stranger: { command: "npx", args: ["-y", "s"] } } }));
  writeFileSync(join(s.cwd, ".mcp.json"), "{ not json");
  const r = await runDoctor({ cwd: s.cwd, home: s.home, env: s.env, which: none, prereqEnv: { PATH: "", windows: false }, connect: false });
  const mcp = byId(r, "mcp");
  expect(mcp.status).toBe("fail");
  expect(r.exitCode).toBe(1);
  const line = (name: string) => mcp.detail!.find((l) => l.includes(` ${name} `))!;
  expect(line("holey")).toContain("still has <directory the server may touch> to fill in");
  expect(line("keyed")).toContain("needs ${DOCTOR_UNSET_TOKEN_XYZ}");
  expect(line("fine")).toContain("loads");
  expect(line("sleeper")).toContain("disabled");
  expect(line("stranger")).toContain("not trusted on this machine");
  expect(mcp.detail!.some((l) => l.startsWith("✗") && l.includes("invalid JSON"))).toBe(true);
  expect(mcp.detail!.some((l) => l.includes("start") && l.includes("through npx") && l.includes("fine"))).toBe(true);
  expect(mcp.summary).toContain("5 configured · 1 load");
  expect(r.notChecked.some((n) => n.includes("--no-connect"))).toBe(true);
  const tools = byId(r, "tools");
  expect(tools.status).toBe("fail");
  expect(tools.detail!.find((l) => l.includes(" npx "))).toContain("an MCP server here starts through npx");
});

test("tools: a TypeScript project without the language server gets the LSP line; with it, a tick; a project without tsconfig says the gate does not apply. permission names the rung that set it", async () => {
  const s = scratch();
  writeFileSync(join(s.cwd, "tsconfig.json"), "{}");
  const found = (n: string) => `/bin/${n}`;
  const missing = await runDoctor({ cwd: s.cwd, home: s.home, env: s.env, which: none, prereqEnv: { PATH: "", windows: false }, connect: false });
  expect(byId(missing, "tools").detail!.some((l) => l.includes("typescript-language-server is not on PATH") && l.includes("NOT type-checked"))).toBe(true);
  const present = await runDoctor({ cwd: s.cwd, home: s.home, env: s.env, which: found, prereqEnv: { PATH: "", windows: false }, connect: false });
  expect(byId(present, "tools").detail!.some((l) => l.startsWith("✓ typescript-language-server"))).toBe(true);
  rmSync(join(s.cwd, "tsconfig.json"));
  const notTs = await runDoctor({ cwd: s.cwd, home: s.home, env: s.env, which: none, prereqEnv: { PATH: "", windows: false }, connect: false });
  expect(byId(notTs, "tools").detail!.some((l) => l.includes("gate does not apply"))).toBe(true);

  mkdirSync(join(s.cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(s.cwd, ".rovecode", "settings.json"), JSON.stringify({ permission: "auto" }));
  const fromProject = await runDoctor({ cwd: s.cwd, home: s.home, env: s.env, which: none, prereqEnv: { PATH: "", windows: false }, connect: false });
  expect(byId(fromProject, "permission").status).toBe("note");
  expect(byId(fromProject, "permission").summary).toContain("auto");
  expect(byId(fromProject, "permission").summary).toContain(join(s.cwd, ".rovecode", "settings.json"));
  const fromEnv = await runDoctor({ cwd: s.cwd, home: s.home, env: { ...s.env, ROVECODE_PERMISSION: "accept-edits" }, which: none, prereqEnv: { PATH: "", windows: false }, connect: false });
  expect(byId(fromEnv, "permission").summary).toContain("accept edits");
  expect(byId(fromEnv, "permission").summary).toContain("from ROVECODE_PERMISSION");
});

test("never a secret: a stored key and an env key are named by NAME only; the legacy home is mentioned; a big checkpoints dir is a warn", async () => {
  const s = scratch();
  const SECRET = "sk-ant-doctor-must-never-print-this-9f8e7d";
  writeFileSync(join(s.home, "credentials.json"), JSON.stringify({ anthropic: { type: "api", key: SECRET } }));
  const platformHome = process.platform === "win32" ? s.env.USERPROFILE! : s.env.HOME!;
  mkdirSync(join(platformHome, ".cumulus"));
  mkdirSync(join(s.cwd, ".rovecode", "checkpoints", "sess-1"), { recursive: true });
  writeFileSync(join(s.cwd, ".rovecode", "checkpoints", "sess-1", "blob"), Buffer.alloc(201 * 1024 * 1024, 0));
  const out: string[] = [];
  const code = await cmdDoctor(["--no-connect"], { cwd: s.cwd, home: s.home, env: { ...s.env, OPENAI_API_KEY: "sk-openai-" + SECRET }, which: none, prereqEnv: { PATH: "", windows: false }, out: (l) => out.push(l), err: (l) => out.push(l) });
  const text = out.join("\n");
  expect(text).not.toContain(SECRET);
  expect(text).toContain("anthropic (builtin, key from stored)");               // the id and where the key comes from
  expect(text).toContain("openai (builtin, key from env OPENAI_API_KEY)");     // the NAME of the variable, never its value
  expect(text).toContain("legacy");
  expect(text).toContain(".cumulus");
  expect(text).toContain("that is large");
  expect(text).toContain("201.0 MB");
  expect(code).toBe(0);                                                        // large is a warning, not a break
  const json: string[] = [];
  await cmdDoctor(["--json", "--no-connect"], { cwd: s.cwd, home: s.home, env: { ...s.env, OPENAI_API_KEY: "sk-openai-" + SECRET }, which: none, prereqEnv: { PATH: "", windows: false }, out: (l) => json.push(l), err: () => {} });
  expect(json.join("\n")).not.toContain(SECRET);
  expect((JSON.parse(json.join("\n")) as DoctorReport).checks.find((c) => c.id === "checkpoints")!.status).toBe("warn");
});

test("usage: an unknown flag is exit 2, and a document with --json", async () => {
  const s = scratch();
  const out: string[] = [], err: string[] = [];
  expect(await cmdDoctor(["--nope"], { cwd: s.cwd, home: s.home, env: s.env, out: (l) => out.push(l), err: (l) => err.push(l) })).toBe(2);
  expect(out).toEqual([]);
  expect(err[0]).toBe("unknown flag --nope");
  expect(await cmdDoctor(["--nope", "--json"], { cwd: s.cwd, home: s.home, env: s.env, out: (l) => out.push(l), err: () => {} })).toBe(2);
  expect((JSON.parse(out.join("\n")) as { ok: boolean; error: string }).error).toBe("unknown flag --nope");
});
