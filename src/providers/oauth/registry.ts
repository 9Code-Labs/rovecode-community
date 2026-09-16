/** The OAuth provider registry (port #66): which `rovecode auth login <id>` flows exist, in the
 *  precedence order the provider seam consults stored tokens, plus the explicit refusals.
 *
 *  The ToS-safe subset only: GitHub Copilot (device code), OpenRouter (PKCE), OpenAI (ChatGPT device code —
 *  its token is accepted by chatgpt.com/backend-api/codex over /responses only, which providers/responses.ts
 *  speaks; it was refused here until that wire landed, 2026-09-07, because a login that stores a token no
 *  request can send is a success message for work that did not happen).
 *  Anthropic OAuth is REFUSED on purpose — an owner decision, not a port: pi's anthropic.ts is not
 *  ported and `rovecode auth login anthropic` prints the one-line note below (research/
 *  round3_landscape.md:64-66 — the Jan-2026 Anthropic OAuth crackdown that cut off third-party
 *  harnesses using the Claude subscription login). */

import { abortableSleep } from "./device-code.ts";
import { githubCopilotOAuth } from "./github-copilot.ts";
import { openAIOAuth } from "./openai.ts";
import { openRouterOAuth } from "./openrouter.ts";
import type { OAuthDeps, OAuthProvider } from "./common.ts";

/** login targets, also the seam's precedence order when several tokens are stored */
export const OAUTH_PROVIDER_IDS: readonly string[] = ["github-copilot", "openrouter", "openai"];

/** ids `rovecode auth login` refuses, with the one-line reason printed */
export const OAUTH_REFUSED: Readonly<Record<string, string>> = {
  anthropic: "Anthropic OAuth (the Claude subscription login) is an owner decision, not a port — third-party harnesses that used it were cut off in the Jan-2026 crackdown (research/round3_landscape.md:64-66); use `rovecode auth set anthropic` with an API key.",
};

/** Fresh provider instances (production endpoints) in precedence order. */
export function oauthProviders(): OAuthProvider[] {
  return [githubCopilotOAuth(), openRouterOAuth(), openAIOAuth()];
}

export function oauthProvider(id: string): OAuthProvider | undefined {
  return oauthProviders().find((p) => p.id === id);
}

/** Real network, real clock, real (abortable) timers. */
export function defaultOAuthDeps(): OAuthDeps {
  return { fetch: (input, init) => fetch(input, init), now: () => Date.now(), sleep: (ms, signal) => abortableSleep(ms, signal) };
}
