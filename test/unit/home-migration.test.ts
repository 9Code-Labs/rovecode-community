/** providers/auth.ts migrateLegacyHome — the config directory moved from ~/.cumulus to ~/.rovecode
 *  when the project was renamed. A rename must not cost anyone their stored keys, and it must not
 *  destroy the old directory either: an older build has to keep working if they go back.
 *
 *  The tests drive the real thing through a fake home (homedir() follows USERPROFILE/HOME, checked
 *  in-process) and a fresh module instance per case, because the migration deliberately runs once
 *  per process. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rovecode-migrate-"));
  for (const k of ["ROVECODE_HOME", "USERPROFILE", "HOME"]) saved[k] = process.env[k];
  process.env.USERPROFILE = root;
  process.env.HOME = root;
  delete process.env.ROVECODE_HOME;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

/** a module instance of its own: migrateLegacyHome fires once per process by design */
const freshAuth = () => import(`../../src/providers/auth.ts?m=${Math.random()}`) as Promise<typeof import("../../src/providers/auth.ts")>;

function legacyWithKeys(): string {
  const legacy = join(root, ".cumulus");
  mkdirSync(join(legacy, "sessions", "s1"), { recursive: true });
  writeFileSync(join(legacy, "credentials.json"), JSON.stringify({ anthropic: { type: "api", key: "sk-legacy-secret", keyName: "ANTHROPIC_API_KEY" } }));
  writeFileSync(join(legacy, "providers.json"), JSON.stringify({ default: "anthropic/claude-opus-5" }));
  writeFileSync(join(legacy, "sessions", "s1", "todos.json"), '{"version":1,"items":[]}');
  return legacy;
}

test("the old home is COPIED into the new one: keys, providers and sessions all arrive", async () => {
  const legacy = legacyWithKeys();
  const auth = await freshAuth();
  const home = auth.rovecodeHome();
  expect(home).toBe(join(root, ".rovecode"));
  expect(auth.loadCredentials().anthropic!.key).toBe("sk-legacy-secret");
  expect(JSON.parse(readFileSync(join(home, "providers.json"), "utf8")).default).toBe("anthropic/claude-opus-5");
  expect(existsSync(join(home, "sessions", "s1", "todos.json"))).toBe(true); // the whole tree, not just the two files
  // copy, not move: going back to an older build must still find everything
  expect(existsSync(join(legacy, "credentials.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(legacy, "credentials.json"), "utf8")).anthropic.key).toBe("sk-legacy-secret");
});

test("an existing new home is never overwritten — the migration only fills an empty seat", async () => {
  legacyWithKeys();
  const home = join(root, ".rovecode");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "providers.json"), '{"default":"mine/model"}');
  const auth = await freshAuth();
  expect(auth.rovecodeHome()).toBe(home);
  expect(JSON.parse(readFileSync(join(home, "providers.json"), "utf8")).default).toBe("mine/model");
  expect(existsSync(join(home, "credentials.json"))).toBe(false); // nothing was merged in behind the user's back
});

test("no legacy directory: a fresh install starts empty and resolving the path creates nothing", async () => {
  const auth = await freshAuth();
  expect(auth.rovecodeHome()).toBe(join(root, ".rovecode"));
  expect(auth.loadCredentials()).toEqual({});
  expect(existsSync(join(root, ".rovecode"))).toBe(false);
});

test("ROVECODE_HOME is NOT migrated into — a path you chose is a request for that path, not for a copy", async () => {
  // This test used to assert the opposite ("the override is a home like any other"), and that behaviour
  // was a hazard rather than a convenience: pointing ROVECODE_HOME at a fresh path is how everyone
  // isolates a test, a script or a clean-room check, and it silently filled the path with the user's
  // stored keys. It billed two real API calls during this repository's own release verification
  // (2026-09-06). The default home still inherits, and now says so — see the test above and
  // test/unit/legacy-home.test.ts for the injected-legacyDir form.
  legacyWithKeys();
  const home = join(root, "explicit");
  process.env.ROVECODE_HOME = home;
  const auth = await freshAuth();
  expect(auth.rovecodeHome()).toBe(home);
  expect(existsSync(home)).toBe(false);                       // nothing was created, nothing was copied
  expect(auth.loadCredentials().anthropic).toBeUndefined();   // and the old key did not follow
});
