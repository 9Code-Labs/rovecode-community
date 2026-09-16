/** The provider seam for stored OAuth tokens (port #66) — ADR-003: no second loop, no second
 *  provider path. A stored token becomes an ordinary ProviderConfig (resolveProvider's LAST resort,
 *  after the explicit ROVECODE_BASE_URL/ROVECODE_API_KEY pair, stored API keys and env keys — "a stored
 *  token is used when no API key is set"), and providerStream wraps the OpenAI-compatible adapter in
 *  `oauthStream`: before each request the credential is re-read from the store and, when its expiry
 *  has passed, refreshed ONCE through the provider's refresh() and written back; the request then
 *  carries the fresh token, base URL and headers (GitHub Copilot's base URL is derived from the
 *  token itself). A failed refresh is not retried — it crosses the seam as an error turn (never a
 *  throw) whose text names the provider and the `rovecode auth login` remedy, never the token.
 *
 *  Pattern: pi's `getOAuthApiKey` (packages/ai/src/auth/oauth/index.ts, MIT) — refresh when
 *  `expires` has passed, persist, hand back the auth; here it is per request rather than per
 *  process so a long TUI session outlives a 30-minute Copilot token. Clock, fetch, timers, the
 *  provider list and the store are injectable (`OAuthSeamDeps`) so the tests drive an expired
 *  token against an in-process fake without real time passing. */

import type { Message, ModelRef, StreamEvent, StreamFn, StreamOptions } from "../../core/types.ts";
import { loadOAuthCredentials, saveOAuthCredential } from "../auth.ts";
import { failedTurn } from "../stream-errors.ts";
import type { ProviderConfig } from "../stream.ts";
import type { OAuthAuth, OAuthCredential, OAuthDeps, OAuthProvider } from "./common.ts";
import { defaultOAuthDeps, oauthProviders } from "./registry.ts";

export interface OAuthSeamDeps extends Partial<OAuthDeps> {
  /** provider instances to consult (default: the registry, production endpoints) */
  providers?: OAuthProvider[];
  /** credential store reads/writes (default: providers/auth.ts) */
  load?: () => Record<string, OAuthCredential>;
  save?: (id: string, cred: OAuthCredential) => void;
}

/** the OpenAI-compatible adapter factory (providers/stream.ts openaiCompatStream) — passed in, not
 *  imported, so this module never imports stream.ts at runtime */
export type MakeStream = (opts: { baseUrl: string; apiKey: string; headers?: Record<string, string> }) => StreamFn;

function configFor(provider: OAuthProvider, auth: OAuthAuth): ProviderConfig {
  return {
    id: provider.id, baseUrl: auth.baseUrl, apiKey: auth.apiKey, protocol: "openai", oauth: true,
    ...(auth.headers ? { headers: auth.headers } : {}), ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    ...(auth.wire ? { wire: auth.wire } : {}), // port #75: the OpenAI token pins the Responses wire
  };
}

/** The first provider (registry order) with a stored OAuth credential, as a ProviderConfig whose
 *  apiKey is the CURRENT access token (possibly expired — oauthStream refreshes per request); null
 *  when nothing is stored. */
export function resolveOAuthProviderConfig(deps: OAuthSeamDeps = {}): ProviderConfig | null {
  const stored = (deps.load ?? loadOAuthCredentials)();
  for (const provider of deps.providers ?? oauthProviders()) {
    const cred = stored[provider.id];
    if (cred) return configFor(provider, provider.toAuth(cred));
  }
  return null;
}

/** The auth to send NOW for `id`: the stored credential, refreshed once (and persisted) when its
 *  expiry has passed. Throws a token-free Error when nothing is stored or the refresh fails. */
export async function freshOAuthAuth(id: string, signal: AbortSignal | undefined, deps: OAuthSeamDeps = {}): Promise<OAuthAuth> {
  const provider = (deps.providers ?? oauthProviders()).find((p) => p.id === id);
  if (!provider) throw new Error(`${id}: no OAuth provider under that id`);
  const cred = (deps.load ?? loadOAuthCredentials)()[id];
  if (!cred) throw new Error(`${id}: no stored OAuth credential — run \`rovecode auth login ${id}\``);
  const oauthDeps: OAuthDeps = { ...defaultOAuthDeps(), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  if (oauthDeps.now() < cred.expires) return provider.toAuth(cred);
  let refreshed: OAuthCredential;
  try {
    refreshed = await provider.refresh(cred, signal, oauthDeps);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${id}: OAuth token expired and the refresh failed (${reason}) — run \`rovecode auth login ${id}\``);
  }
  (deps.save ?? saveOAuthCredential)(id, refreshed);
  return provider.toAuth(refreshed);
}

/** StreamFn over a stored OAuth credential: refresh-once-if-expired, then the OpenAI-compatible
 *  adapter with the current token/base URL/headers. Errors cross as turns (ADR-003). */
export function oauthStream(cfg: ProviderConfig, makeStream: MakeStream, deps: OAuthSeamDeps = {}): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
    let auth: OAuthAuth;
    try {
      auth = await freshOAuthAuth(cfg.id, options?.signal, deps);
    } catch (e) {
      yield { type: "turn", turn: failedTurn(e, options?.signal) };
      return;
    }
    yield* makeStream({ baseUrl: auth.baseUrl, apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}) })(model, messages, options);
  };
}
