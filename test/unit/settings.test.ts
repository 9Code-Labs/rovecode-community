/** core/settings.ts — the answers you should only give once. The permission level used to die with
 *  the session; these pin the ladder that replaced that (flag → env → project → user → "ask"), the
 *  two scopes, and the rule that a malformed file is "no preference", never an error. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, loadSettingsScoped, readSettingsFile, resolveEffort, resolvePermission, saveSetting, settingsPath } from "../../src/core/settings.ts";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";

let home: string; let cwd: string; let saved: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rovecode-settings-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-settings-cwd-"));
  saved = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const writeUser = (o: unknown) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, "settings.json"), JSON.stringify(o)); };
const writeProject = (o: unknown) => { mkdirSync(join(cwd, ".rovecode"), { recursive: true }); writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify(o)); };

test("nothing anywhere: the deny-default stands", () => {
  expect(loadSettings(cwd)).toEqual({});
  expect(resolvePermission(cwd, undefined, {})).toBe("ask");
});

test("resolveEffort: the same ladder — flag beats env, env beats files, project beats user, the floor is auto", () => {
  expect(resolveEffort(cwd, undefined, {})).toBe("auto");
  writeUser({ effort: "medium" });
  expect(resolveEffort(cwd, undefined, {})).toBe("medium");
  writeProject({ effort: "low" });
  expect(resolveEffort(cwd, undefined, {})).toBe("low"); // project pins the repo's dial
  expect(resolveEffort(cwd, undefined, { ROVECODE_EFFORT: "high" })).toBe("high");
  expect(resolveEffort(cwd, "off", { ROVECODE_EFFORT: "high" })).toBe("off");
  expect(resolveEffort(cwd, undefined, { ROVECODE_EFFORT: "turbo" })).toBe("low"); // a bad env word is no answer at all
});

test("the project file beats the user file, key by key", () => {
  writeUser({ permission: "auto", effort: "high" });
  writeProject({ permission: "accept-edits" });
  expect(loadSettings(cwd)).toEqual({ permission: "accept-edits", effort: "high" }); // effort still yours
  expect(resolvePermission(cwd, undefined, {})).toBe("accept-edits");
});

test("the ladder: a flag beats the env, the env beats the files", () => {
  writeUser({ permission: "ask" });
  expect(resolvePermission(cwd, undefined, {})).toBe("ask");
  expect(resolvePermission(cwd, undefined, { ROVECODE_PERMISSION: "accept-edits" })).toBe("accept-edits");
  expect(resolvePermission(cwd, "auto", { ROVECODE_PERMISSION: "accept-edits" })).toBe("auto");
  // the older single-purpose switches keep working; auto is the wider of the two, so it wins
  expect(resolvePermission(cwd, undefined, { ROVECODE_YOLO: "1" })).toBe("auto");
  expect(resolvePermission(cwd, undefined, { ROVECODE_ACCEPT_EDITS: "1" })).toBe("accept-edits");
  expect(resolvePermission(cwd, undefined, { ROVECODE_YOLO: "1", ROVECODE_ACCEPT_EDITS: "1" })).toBe("auto");
});

test("a word we do not recognize is no preference at all — never a truthy something", () => {
  writeUser({ permission: "yes", effort: "maximum", nonsense: 1 });
  expect(loadSettings(cwd)).toEqual({});
  expect(resolvePermission(cwd, undefined, { ROVECODE_PERMISSION: "please" })).toBe("ask");
});

test("a corrupt or missing file is no preference, not a crash", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), "{ this is not json");
  expect(() => loadSettings(cwd)).not.toThrow();
  expect(loadSettings(cwd)).toEqual({});
});

test("saveSetting merges into its scope and leaves the other one alone", () => {
  writeUser({ effort: "medium" });
  const path = saveSetting("permission", "auto", "user", cwd);
  expect(path).toBe(settingsPath("user", cwd));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ effort: "medium", permission: "auto" }); // effort survived
  saveSetting("permission", "ask", "project", cwd);
  expect(loadSettings(cwd)).toEqual({ effort: "medium", permission: "ask" });                      // the project pin wins
  expect(JSON.parse(readFileSync(settingsPath("user", cwd), "utf8")).permission).toBe("auto");      // the user file untouched
});

test("the notification keys (2026-09-07): notify / notify_when take only their words, notify_command only a non-blank string; loadSettingsScoped keeps the two files apart and names the project path", () => {
  writeUser({ notify: "osc9", notify_when: "always", notify_command: '["notify-send","rovecode"]' });
  writeProject({ notify: "toast", notify_when: "sometimes", notify_command: "   ", bell: "off" });
  expect(loadSettings(cwd)).toEqual({ notify: "osc9", notify_when: "always", notify_command: '["notify-send","rovecode"]' }); // the project's unrecognised words are no preference
  const scoped = loadSettingsScoped(cwd);
  expect(scoped.projectPath).toBe(join(cwd, ".rovecode", "settings.json"));
  expect(scoped.project).toEqual({});
  expect(scoped.user.notify_command).toBe('["notify-send","rovecode"]');
  writeProject({ notify: "bell", notify_when: "unfocused", notify_command: "toast.exe --title rovecode", bell: false });
  // notify_command is a command-bearing key: gone from an UNTRUSTED project file (core/trust.ts), back once approved
  expect(loadSettingsScoped(cwd)).toMatchObject({ project: { notify: "bell", notify_when: "unfocused", bell: false }, dropped: ["notify_command"] });
  expect(readSettingsFile(join(cwd, ".rovecode", "settings.json")).notify_command).toBe("toast.exe --title rovecode"); // the ungated reader still says what the file says
  trustProjectFiles(cwd, home);
  expect(loadSettingsScoped(cwd).project).toEqual({ notify: "bell", notify_when: "unfocused", notify_command: "toast.exe --title rovecode", bell: false });
  expect(readSettingsFile(join(cwd, "nope.json"))).toEqual({});
  writeProject({ notify_command: "x".repeat(2_001), notify: 3, notify_when: true });
  expect(loadSettingsScoped(cwd).project).toEqual({}); // too long / wrong type: dropped, never a truthy something
});

test("saveSetting creates the directory it needs", () => {
  const path = saveSetting("effort", "high", "project", cwd);
  expect(path).toBe(join(cwd, ".rovecode", "settings.json"));
  expect(JSON.parse(readFileSync(path, "utf8")).effort).toBe("high");
});
