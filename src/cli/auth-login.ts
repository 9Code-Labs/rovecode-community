/** `rovecode auth login <provider>` and the `rovecode auth list` renderer (port #66). All of the auth
 *  CLI's OAuth logic lives here; main.ts only dispatches.
 *
 *  login: github-copilot (GitHub device code), openrouter (PKCE + loopback callback), openai (device
 *  code) — src/providers/oauth/registry.ts. The flow talks to the terminal only through notices
 *  rendered here: the device code + URL to open, the auth URL + callback address, progress. The
 *  credential goes to the credentials store (providers/auth.ts, `type: "oauth"`); the final line
 *  names the file and the expiry. `anthropic` is refused with the owner-decision note. Ctrl-C aborts
 *  the flow (exit 130). Nothing here prints, throws or logs a token: notices carry none by
 *  construction (oauth/common.ts) and the only value echoed from a credential is its expiry.
 *
 *  list: one row per stored entry — provider, kind (api | oauth), key name, redacted prefix, and
 *  for oauth the expiry (`expires <ISO>`, `EXPIRED <ISO>`, or `never expires`). */

import { credentialsPath, listProviders, saveOAuthCredential, type ProviderListing, type StoredOAuthCredential } from "../providers/auth.ts";
import type { OAuthDeps, OAuthNotice, OAuthProvider } from "../providers/oauth/common.ts";
import { OAUTH_PROVIDER_IDS, OAUTH_REFUSED, defaultOAuthDeps, oauthProvider } from "../providers/oauth/registry.ts";

export const AUTH_LOGIN_USAGE = `usage: rovecode auth login <${OAUTH_PROVIDER_IDS.join("|")}>`;

export interface AuthLoginDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  /** provider lookup (tests inject fake-endpoint instances); default: the registry */
  provider?: (id: string) => OAuthProvider | undefined;
  /** network/clock/timer overrides for the flow */
  oauth?: Partial<OAuthDeps>;
  /** Ctrl-C */
  signal?: AbortSignal;
  /** credential sink; default: providers/auth.ts saveOAuthCredential */
  save?: (id: string, cred: StoredOAuthCredential) => void;
}

/** `expires 2026-09-03T12:00:00.000Z` | `EXPIRED …` | `never expires` (MAX_SAFE_INTEGER / beyond Date's range).
 *  Never throws: a value below Date's range (or NaN) renders as EXPIRED instead of a RangeError (#66 fix). */
export function expiryText(expires: number, now: number = Date.now()): string {
  if (expires >= Number.MAX_SAFE_INTEGER || expires > 8.64e15) return "never expires";
  if (!(expires >= -8.64e15)) return "EXPIRED (invalid expiry)";
  const iso = new Date(expires).toISOString();
  return expires <= now ? `EXPIRED ${iso}` : `expires ${iso}`;
}

/** Rows for `rovecode auth list`. Secrets never enter: the entries are already redacted. */
export function formatAuthList(entries: ProviderListing[] = listProviders(), now: number = Date.now()): string[] {
  return entries.map((e) => {
    const tail = e.kind === "oauth" && e.expires !== undefined ? `  ${expiryText(e.expires, now)}` : "";
    return `${e.provider.padEnd(14)} ${e.kind.padEnd(6)} ${e.keyName.padEnd(24)} ${e.redacted}${tail}`;
  });
}

export function printAuthList(): void {
  const rows = formatAuthList();
  if (rows.length === 0) {
    console.log(`no stored credentials (${credentialsPath()}) — run: rovecode auth set <provider> | rovecode auth login <provider>`);
    return;
  }
  for (const row of rows) console.log(row);
}

/** What the terminal shows for a flow notice (indented by the caller). */
export function describeNotice(n: OAuthNotice): string[] {
  switch (n.type) {
    case "device_code":
      return [
        `open   ${n.verificationUri}`,
        `enter  ${n.userCode}`,
        `waiting for authorization — polling every ${n.intervalSeconds}s, up to ${Math.max(1, Math.round(n.expiresInSeconds / 60))} min (Ctrl-C cancels)`,
      ];
    case "auth_url":
      return [
        `open   ${n.url}`,
        `waiting for the browser to return to ${n.callbackUrl} (loopback — the browser must run on this machine; Ctrl-C cancels)`,
      ];
    case "progress":
      return [n.message];
  }
}

/** Run one login. Returns the exit code: 0 stored · 1 refused/unknown/failed · 130 cancelled. */
export async function runAuthLogin(id: string, deps: AuthLoginDeps): Promise<number> {
  // the refusals belong to the production registry; an injected `provider` (tests driving a flow against a
  // fake server, or a build that has the missing wire) replaces the registry, refusals included
  const refusal = deps.provider === undefined ? OAUTH_REFUSED[id] : undefined;
  if (refusal !== undefined) {
    deps.err(`rovecode auth login ${id}: refused — ${refusal}`);
    return 1;
  }
  const provider = (deps.provider ?? oauthProvider)(id);
  if (!provider) {
    if (id.length > 0) deps.err(`error: no OAuth login for "${id}"`);
    deps.err(AUTH_LOGIN_USAGE);
    return 1;
  }
  const signal = deps.signal ?? new AbortController().signal;
  const oauth: OAuthDeps = { ...defaultOAuthDeps(), ...deps.oauth };
  deps.out(`rovecode auth login ${id} — ${provider.label}`);
  try {
    const cred = await provider.login({ notify: (n) => { for (const line of describeNotice(n)) deps.out(`  ${line}`); }, signal }, oauth);
    (deps.save ?? saveOAuthCredential)(id, cred);
    deps.out(`stored OAuth token for ${id} in ${credentialsPath()} (${expiryText(cred.expires, oauth.now())})`);
    return 0;
  } catch (e) {
    if (signal.aborted) {
      deps.err("login cancelled");
      return 130;
    }
    deps.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** argv entry (main.ts `auth login …`): console output, SIGINT → abort. */
export async function cmdAuthLogin(args: string[]): Promise<number> {
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  try {
    return await runAuthLogin(args[0] ?? "", { out: (l) => console.log(l), err: (l) => console.error(l), signal: ac.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
