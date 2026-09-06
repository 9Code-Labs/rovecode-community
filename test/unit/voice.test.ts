/** core/voice.ts — the one place user-facing wording lives: mode labels by their screen names, the
 *  three-line no-model recipe (rovecode setup first), the welcome card in both states, empty-state hints.
 *  Pins the voice rules: first person, no emoji, every problem ends with "→ next:". */

import { test, expect } from "bun:test";
import {
  EMPTY, MOCK_PROVIDER_TEXT, MODE_ASK, MODE_AUTO, NEXT, modeLabel, modeLabelShort, modeMeaning, modeSwitchNote,
  loadedLine, next, noModelHint, resumedLine, welcomeCard,
} from "../../src/core/voice.ts";

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

test("mode labels: the screen says ask first / auto (never asks); the flags keep their names", () => {
  expect(modeLabel(false)).toBe("ask first");
  expect(modeLabel(true)).toBe("auto (never asks)");
  expect(MODE_ASK).toBe(modeLabel(false));
  expect(MODE_AUTO).toBe(modeLabel(true));
  expect(modeLabelShort(false)).toBe("ask first");
  expect(modeLabelShort(true)).toBe("auto");
  expect(modeMeaning(false)).toContain("I ask before");
  expect(modeMeaning(true)).toContain("won't stop to ask");
  expect(modeSwitchNote(true)).toBe("mode: auto (never asks) — I won't stop to ask before writes or shell commands");
  expect(modeSwitchNote(false)).toBe("mode: ask first — I ask before I write or run anything");
  for (const s of [modeLabel(true), modeLabel(false), modeSwitchNote(true)]) expect(s).not.toMatch(/yolo|gated/);
});

test("no-model recipe: three lines, stable first line, rovecode setup first, the surface's own commands", () => {
  const cli = noModelHint("cli");
  const lines = cli.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toStartWith("no provider configured"); // acp/http callers match this prefix
  expect(lines[1]).toContain(`${NEXT} rovecode setup`);
  expect(lines[2]).toContain("rovecode provider add <id> <baseUrl>");
  expect(lines[2]).toContain("ROVECODE_BASE_URL + ROVECODE_API_KEY");
  const tui = noModelHint("tui");
  expect(tui.split("\n")).toHaveLength(3);
  expect(tui).toContain(`${NEXT} /setup`);
  expect(tui).toContain("/provider key <id> <secret>");
  expect(tui).not.toContain("rovecode setup");
  expect(noModelHint()).toBe(cli); // cli is the default flavour
  expect(next("x")).toBe("→ next: x");
});

test("mock provider text keeps its stable prefix and points at rovecode setup", () => {
  expect(MOCK_PROVIDER_TEXT).toStartWith("Rovecode mock provider");
  expect(MOCK_PROVIDER_TEXT).toContain("→ next: rovecode setup");
});

test("welcome card, connected: greets, names provider/model, explains ask-first, points at /help by topic, cwd + mode on the last line", () => {
  const card = welcomeCard({ connected: { provider: "anthropic", model: "claude-opus-5" }, cwd: "C:/work/atlas", yolo: false });
  const lines = card.split("\n");
  expect(lines[0]).toBe("◆ rovecode here. Connected to anthropic/claude-opus-5.");
  expect(lines[1]).toBe("Tell me what you want done; I read first, then ask before I write or run anything.");
  expect(lines[2]).toBe("/help lists commands by topic.");
  expect(lines[3]).toBe("C:/work/atlas · ask first");
  const auto = welcomeCard({ connected: { provider: "kaesra", model: "glm" }, cwd: "/w", yolo: true, mode: "plan" });
  expect(auto).toContain("then work without asking");
  expect(auto.split("\n").at(-1)).toBe("/w · auto · plan mode (read-only)");
  // a provider with no model id yet names the provider alone, never a dangling slash
  expect(welcomeCard({ connected: { provider: "mock", model: "" }, cwd: "/w", yolo: false }).split("\n")[0]).toBe("◆ rovecode here. Connected to mock.");
});

test("welcome card, no model: says so plainly and points at /setup with a time estimate", () => {
  const card = welcomeCard({ connected: null, cwd: "/w", yolo: false });
  expect(card.split("\n")).toEqual([
    "◆ rovecode here. No model connected yet, so I can't think.",
    "/setup fixes that in about a minute.",
    "/w · ask first",
  ]);
  expect(card).not.toContain("/help lists"); // nothing to run yet — one pointer, not two
});

test("resumed session gets one line, not a card", () => {
  expect(resumedLine("0123456789abcdef", "/w", true)).toBe("◆ back in session 01234567 · /w · auto");
});

test("empty-state hints: first person, short, second lines only where a panel may have room", () => {
  expect(EMPTY.code).toBe("nothing open — when I read a file it shows here");
  expect(EMPTY.plan).toEqual(["no plan yet", "my steps show up here"]);
  expect(EMPTY.files).toEqual(["no files yet", "they appear as I read them"]);
  expect(EMPTY.usage).toBe("0 so far");
  for (const l of [EMPTY.code, ...EMPTY.plan, ...EMPTY.files]) expect(l.length).toBeLessThanOrEqual(48);
});

test("voice rules: no emoji anywhere in the shipped strings", () => {
  const all = [
    modeLabel(true), modeLabel(false), noModelHint("cli"), noModelHint("tui"), MOCK_PROVIDER_TEXT,
    welcomeCard({ connected: null, cwd: "/w", yolo: false }), welcomeCard({ connected: { provider: "a", model: "b" }, cwd: "/w", yolo: true }),
    resumedLine("abc", "/w", false), EMPTY.code, ...EMPTY.plan, ...EMPTY.files, EMPTY.usage,
  ];
  for (const s of all) expect(s).not.toMatch(EMOJI);
});

test("welcome banner: the wordmark appears only with a version and room, and every line under it is a fact this session can vouch for", () => {
  const full = welcomeCard({
    connected: { provider: "anthropic", model: "claude-opus-5" }, cwd: "C:/work/atlas", yolo: true,
    version: "0.2.0", loaded: { skills: 19, mcp: 2 }, update: "update available: 0.2.0 → 0.3.0", width: 100,
  });
  const lines = full.split("\n");
  expect(lines[1]).toContain("0.2.0");                              // the version rides the mark, not a line of its own
  expect(lines[3]).toBe("  anthropic/claude-opus-5 · 19 skills · 2 MCP servers");
  expect(lines[4]).toBe("  C:/work/atlas · auto");
  expect(lines.at(-1)).toBe("  update available: 0.2.0 → 0.3.0");
  expect(full).not.toContain("0 plugin");                           // a zero is not a fact worth a word

  // no version (a caller that does not know it) or no room: exactly the prose card, unchanged
  const narrow = welcomeCard({ connected: { provider: "anthropic", model: "claude-opus-5" }, cwd: "/w", yolo: false, version: "0.2.0", width: 40 });
  expect(narrow.split("\n")[0]).toBe("◆ rovecode 0.2.0 here. Connected to anthropic/claude-opus-5.");
  expect(narrow).not.toContain("█");

  // silence is the default: no loaded counts, no update line, no empty separators pretending to be facts
  const bare = welcomeCard({ connected: { provider: "mock", model: "" }, cwd: "/w", yolo: false, version: "0.2.0", width: 100 });
  expect(bare.split("\n")[3]).toBe("  mock");
  expect(bare).not.toContain("update");
  expect(loadedLine({ skills: 0, plugins: 0, mcp: 0 })).toBeNull();
  expect(loadedLine({ plugins: 1 })).toBe("1 plugin");              // singular, because it is one
});
