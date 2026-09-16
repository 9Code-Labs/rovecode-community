/** Port #72 — `rovecode skills` through the REAL CLI (Bun.spawn of src/cli/main.ts, the cli-wiring idiom: a local
 *  hermetic env that scrubs ROVECODE_* and *_API_KEY, ROVECODE_HOME → a scratch home, cwd → a scratch workspace).
 *  Round trip: pack a spec-shaped skill → install the archive FILE → `list --json` carries every spec field, the
 *  loader warning and the bundled resources; `--user` lands under ROVECODE_HOME instead of the project; bare `skills`
 *  is the usage on stderr with exit 1.
 *
 *  The security pin of this file: `skills install <http url>` goes through the SAME SSRF guard as web_fetch and
 *  web_search, so the loopback fixture below — a real server, really serving the real archive — is REFUSED with exit 1
 *  and nothing is written. That asymmetry is the thing worth pinning: a model with bash can type this command, so the
 *  CLI must not be softer than the tools. The successful URL path is covered in skills-cmd-2.test.ts, which injects a
 *  resolver the way the websearch guard tests do. No provider is involved anywhere here. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { scratchDirs } from "../helpers/scratch.ts";
import { LONG_DESCRIPTION, mkSpecSkill, startSkillsFixture, type SkillsFixture } from "../helpers/skills-fixtures.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const T = 120_000;
const scratch = scratchDirs();

let fixture: SkillsFixture;
beforeAll(() => { fixture = startSkillsFixture(); });
afterAll(() => { fixture.stop(); });

function hermeticEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  }
  env.ROVECODE_HOME = home;
  env.NO_COLOR = "1";
  return env;
}

async function cli(args: string[], o: { cwd: string; home: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: o.cwd, env: hermeticEnv(o.home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** macOS: the child resolves its own cwd, so compare against the real path */
const workspace = (): string => realpathSync.native(scratch("rovecode-sk72cli-"));

describe("rovecode skills through the real CLI", () => {
  test("pack → install <file.tar.gz> → list --json round-trips every spec field, the loader warning and the bundled resources", async () => {
    const home = scratch("rovecode-sk72cli-"), work = workspace();
    const src = mkSpecSkill(scratch("rovecode-sk72cli-"));
    const out = join(scratch("rovecode-sk72cli-"), "pdf-processing.tar.gz");

    const p = await cli(["skills", "pack", src, "--out", out], { cwd: work, home });
    expect(p.code, p.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(p.stdout).toContain("packed pdf-processing → ");

    const i = await cli(["skills", "install", out], { cwd: work, home });
    expect(i.code, i.stderr).toBe(0);
    const target = join(work, ".rovecode", "skills", "pdf-processing");
    expect(i.stdout.trim()).toBe(`installed pdf-processing (v1.2.3) → ${target}`);
    expect(i.stderr.trim()).toBe("warning: unknown frontmatter keys: x-custom");
    expect(existsSync(join(target, "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(target, "references", "a.md"))).toBe(true);

    const l = await cli(["skills", "list", "--json"], { cwd: work, home });
    expect(l.code, l.stderr).toBe(0);
    const j = JSON.parse(l.stdout) as { skills: Array<Record<string, unknown>>; invalid: unknown[] };
    expect(j.invalid).toEqual([]);
    expect(j.skills).toEqual([expect.objectContaining({
      name: "pdf-processing", version: "1.2.3", scope: "project", path: join(target, "SKILL.md"),
      description: LONG_DESCRIPTION, // `list` shows it whole; only the prompt index clips (skills.test.ts)
      license: "Apache-2.0", metadata: { author: "rovecode-tests", version: "1.2.3" },
      allowedTools: ["read", "bash", "grep"], warnings: ["unknown frontmatter keys: x-custom"],
    })]);
  }, T);

  test("install from a LOOPBACK url is refused by the SSRF guard: exit 1, the address named, the server never asked, nothing written", async () => {
    const home = scratch("rovecode-sk72cli-"), work = workspace();
    const src = mkSpecSkill(scratch("rovecode-sk72cli-"), { unknownKey: false });
    const out = join(scratch("rovecode-sk72cli-"), "pdf-processing.tar.gz");
    expect((await cli(["skills", "pack", src, "--out", out], { cwd: work, home })).code).toBe(0);
    fixture.setArchive(readFileSync(out)); // the archive really is there to be had — the guard is what stops us
    const hitsBefore = fixture.hits["/skill.tar.gz"] ?? 0;

    const url = `${fixture.baseUrl}/skill.tar.gz`;
    const r = await cli(["skills", "install", url], { cwd: work, home });
    expect(r.code).toBe(1); // MUTATION TARGET: drop ssrfDenyReason from skills-cmd.ts download() → 0, installed
    expect(r.stderr).toContain(`error: refused ${url}`);
    expect(r.stderr).toMatch(/loopback|private/);
    expect(fixture.hits["/skill.tar.gz"] ?? 0).toBe(hitsBefore); // refused BEFORE the request
    expect(existsSync(join(work, ".rovecode", "skills"))).toBe(false);
  }, T);

  test("--user installs under ROVECODE_HOME/skills and leaves the project untouched; bare `skills` → usage on stderr, exit 1", async () => {
    const home = scratch("rovecode-sk72cli-"), work = workspace();
    const src = mkSpecSkill(scratch("rovecode-sk72cli-"), { unknownKey: false });

    const u = await cli(["skills", "install", src, "--user"], { cwd: work, home });
    expect(u.code, u.stderr).toBe(0);
    expect(existsSync(join(home, "skills", "pdf-processing", "SKILL.md"))).toBe(true);
    expect(existsSync(join(work, ".rovecode"))).toBe(false);

    const b = await cli(["skills"], { cwd: work, home });
    expect(b.code).toBe(1);
    expect(b.stdout).toBe("");
    expect(b.stderr).toContain("usage: rovecode skills list [--json]");
  }, T);
});
