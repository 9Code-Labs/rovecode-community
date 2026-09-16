/** The suite's floor (test/helpers/isolate-home.ts, preloaded by bunfig.toml) covers the environment half too:
 *  a developer's exported ANTHROPIC_API_KEY, ROVECODE_SANDBOX or GITHUB_TOKEN must not reach the code under
 *  test. Verified need: with an empty home and ANTHROPIC_API_KEY in the shell, a headless run on a clean
 *  checkout billed a real Anthropic call (2026-09-06). */

import { expect, test } from "bun:test";
import { isProviderEnvName, scrubProviderEnv } from "../helpers/isolate-home.ts";

test("what is scrubbed: provider keys, the release-check tokens, every ROVECODE_ knob except the home and the fuzz seeds", () => {
  const env: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk", KAESRA_API_KEY: "sk", MY_CUSTOM_API_KEY: "sk",
    GITHUB_TOKEN: "t", GH_TOKEN: "t",
    ROVECODE_BASE_URL: "http://x", ROVECODE_API_KEY: "k", ROVECODE_MODEL: "m", ROVECODE_SANDBOX: "wsl", ROVECODE_PERMISSION: "auto",
    ROVECODE_HOME: "/keep", ROVECODE_FUZZ_SEED: "1", ROVECODE_FUZZ_ROUNDS: "2",
    PATH: "/bin", HOME: "/home/x", ANTHROPIC_MODEL: "claude-code's own, not ours", API_KEY: "bare, nobody reads it",
  };
  const removed = scrubProviderEnv(env);
  expect(removed).toEqual([
    "ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "KAESRA_API_KEY", "MY_CUSTOM_API_KEY", "OPENAI_API_KEY",
    "ROVECODE_API_KEY", "ROVECODE_BASE_URL", "ROVECODE_MODEL", "ROVECODE_PERMISSION", "ROVECODE_SANDBOX",
  ]);
  expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_MODEL", "API_KEY", "HOME", "PATH", "ROVECODE_FUZZ_ROUNDS", "ROVECODE_FUZZ_SEED", "ROVECODE_HOME"]);
  expect(isProviderEnvName("ROVECODE_HOME")).toBe(false);
  expect(isProviderEnvName("ROVECODE_ANYTHING_NEW")).toBe(true);   // a knob added tomorrow is covered today
});

test("and it ran: this process carries none of them, whatever the shell that started it exported", () => {
  const leaked = Object.keys(process.env).filter(isProviderEnvName);
  expect(leaked).toEqual([]);
  expect(process.env.ROVECODE_HOME).toBeDefined();                  // the home half still holds
});
