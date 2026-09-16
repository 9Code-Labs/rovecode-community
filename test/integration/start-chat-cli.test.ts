/** Real CLI routing and screen ownership in a child. Fake TTY metadata + piped keys, no provider calls. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { scratchDirs } from "../helpers/scratch.ts";
const scratch = scratchDirs();
const MAIN = join(import.meta.dir, "../../src/cli/main.ts");
const ESC = String.fromCharCode(27);

function run(args: string[] = [], extra: Record<string, string> = {}) {
  const cwd = scratch("rove-start-cli-"); const home = scratch("rove-start-cli-home-");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(ROVECODE|NIMBUS|AION)_/.test(key) && !key.endsWith("_API_KEY") && key !== "GH_TOKEN" && key !== "GITHUB_TOKEN") env[key] = value;
  Object.assign(env, { HOME: home, ROVECODE_HOME: home, ROVECODE_TUI: "sextant", ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_UPDATE_CHECK: "1", ROVECODE_NO_CHECKPOINTS: "1" }, extra);
  const code = `Object.defineProperties(process.stdout, {isTTY:{value:true},columns:{value:160},rows:{value:44}});
    process.argv = ${JSON.stringify([process.execPath, MAIN, ...args])};
    process.on("exit", () => { const keys=Object.keys(require.cache); console.error("MODULES:"+JSON.stringify({
      classic:keys.some(k=>k.includes("pi-renderer.ts")),sextant:keys.some(k=>k.includes("sextant-renderer.ts")),app:keys.some(k=>k.endsWith("app.ts"))})); });
    await import(${JSON.stringify(MAIN)});`;
  const result = Bun.spawnSync([process.execPath, "-e", code], { cwd, env, stdin: Buffer.from("/exit\r\n"), stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const out = result.stdout.toString(), err = result.stderr.toString();
  const modules = JSON.parse(err.split("MODULES:").at(-1)!.trim()) as { classic: boolean; sextant: boolean; app: boolean };
  return { result, out, err, modules };
}

test("CLI shows intro before the sextant screen, exits cleanly, and never loads the classic renderer", () => {
  const { result, out, modules } = run();
  expect(result.exitCode).toBe(0);
  const intro = out.indexOf("░▀░ ░▀░");
  const screen = out.indexOf(`${ESC}[?1049h`);
  expect(intro).toBeGreaterThanOrEqual(0); expect(screen).toBeGreaterThan(intro);
  expect(out.slice(screen)).not.toContain("░▀░ ░▀░");
  expect(modules).toEqual({ classic: false, sextant: true, app: true });
});

test("--plain loads no renderer or TUI app and plays no intro", () => {
  const { result, out, modules } = run(["--plain"]);
  expect(result.exitCode).toBe(0);
  expect(out).toContain("plain chat"); expect(out).not.toContain(`${ESC}[2J`);
  expect(out).not.toContain("░▀░ ░▀░");
  expect(modules).toEqual({ classic: false, sextant: false, app: false });
});

test("--classic loads only the classic implementation", () => {
  const { result, modules } = run(["--classic"]);
  expect(result.exitCode).toBe(0);
  expect(modules).toEqual({ classic: true, sextant: false, app: true });
});

test("--no-intro still opens the usable sextant directly", () => {
  const { result, out } = run(["--no-intro"]);
  expect(result.exitCode).toBe(0);
  expect(out).not.toContain("░▀░ ░▀░"); expect(out).toContain(`${ESC}[?1049h`);
});

test("invalid startup settings restore the intro cursor and never enter the alternate screen", () => {
  const { result, out, err } = run([], { ROVECODE_SANDBOX: "invalid-rung" });
  expect(result.exitCode).toBe(2);
  expect(err).toContain("sandbox");
  expect(out).toContain("░▀░ ░▀░");
  expect(out).toContain(`${ESC}[?25h`); expect(out).not.toContain(`${ESC}[?1049h`);
});
