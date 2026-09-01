/** Provider credential store (port #37): backing for `aion auth set/list/remove`.
 *
 *  Ported from opencode packages/opencode/src/auth/index.ts @ ebece6e (MIT):
 *  - one JSON object keyed by provider id, entries discriminated by `type` (index.ts:14-36)
 *  - the "api" variant carries the secret in `key` (index.ts:23-27); the provider loader
 *    consumes it as the apiKey (provider.ts:1596-1601)
 *  - file written with mode 0o600 (index.ts:79,88)
 *  - a missing/corrupt file reads as {} and malformed entries are dropped per-entry, never
 *    fatal (index.ts:65-66, Record.filterMap over the schema decode)
 *  Deviations: the file lives at ~/.aion/credentials.json (bar) instead of opencode's
 *  <data>/auth.json; entries carry an aion-only optional `keyName` (which env var the
 *  secret stands in for); only the "api" variant is implemented — entries with other
 *  `type` values (a future oauth port) round-trip through save/remove unharmed but are
 *  not listed or resolved.
 *
 *  SECRETS ARE NEVER LOGGED from this module: no console output at all, and error
 *  messages never embed the credential value. Rendering (redacted) is the caller's
 *  job via listProviders()/redactSecret().
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { providers as snapshotProviders } from "@opencode-ai/models/snapshot";

export interface StoredCredential {
  type: "api";
  /** the secret itself (upstream field name — auth/index.ts:24) */
  key: string;
  /** aion extension: env var name this secret stands in for (e.g. ANTHROPIC_API_KEY) */
  keyName?: string;
}

/** User-scope aion dir: AION_HOME overrides ~/.aion wholesale (tests point it at a temp
 *  dir). homedir() already respects HOME on POSIX and USERPROFILE on Windows. Mirrors the
 *  skills store's user-scope default (skills/index.ts: join(homedir(), ".aion", ...)). */
export function aionHome(): string {
  return process.env.AION_HOME ?? join(homedir(), ".aion");
}

export function credentialsPath(): string {
  return join(aionHome(), "credentials.json");
}

/** Raw file contents: every entry as stored, including unknown `type`s. Missing file,
 *  unreadable file, or non-object JSON -> {} (upstream orElseSucceed idiom). */
function readRaw(): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath(), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function isApiCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; key?: unknown; keyName?: unknown };
  if (v.type !== "api" || typeof v.key !== "string" || v.key.length === 0) return false;
  return v.keyName === undefined || typeof v.keyName === "string";
}

/** Valid "api" credentials only, keyed by provider id (malformed entries dropped). */
export function loadCredentials(): Record<string, StoredCredential> {
  const out: Record<string, StoredCredential> = {};
  for (const [id, value] of Object.entries(readRaw())) {
    if (isApiCredential(value)) out[id] = value;
  }
  return out;
}

/** Write the store with restrictive permissions.
 *
 *  Windows honesty note: fs mode bits on win32 map only onto the FILE_ATTRIBUTE_READONLY
 *  flag — 0o600 does NOT create owner-only protection there. Real isolation on Windows
 *  comes from the NTFS ACL on %USERPROFILE% (inherited by ~/.aion), which by default
 *  denies other non-admin users. So this is best-effort hardening on POSIX (where the
 *  0o600/0o700 bits are enforced) and effectively a no-op on Windows beyond the profile
 *  ACL it inherits — we do not claim otherwise. */
function writeStore(data: Record<string, unknown>): void {
  const path = credentialsPath();
  mkdirSync(aionHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // `mode` above only applies on create; re-assert on rewrites
  } catch {
    // best-effort (see Windows note) — a failed chmod must not lose the write
  }
}

/** Store/replace the credential for a provider. `secret` is never echoed or thrown. */
export function saveCredential(provider: string, secret: string, keyName?: string): void {
  const id = provider.trim();
  if (id.length === 0) throw new Error("provider id must not be empty");
  if (secret.length === 0) throw new Error(`refusing to store an empty secret for ${id}`);
  const data = readRaw();
  const entry: StoredCredential = { type: "api", key: secret, keyName: keyName ?? keyNameFor(id) };
  data[id] = entry;
  writeStore(data);
}

/** Remove a provider's entry. Returns false (and leaves the file alone) when absent.
 *  Removing the last entry deletes the file rather than leaving an empty {} around. */
export function removeCredential(provider: string): boolean {
  const data = readRaw();
  if (!(provider in data)) return false;
  delete data[provider];
  if (Object.keys(data).length === 0) {
    try {
      rmSync(credentialsPath());
    } catch {
      writeStore(data);
    }
    return true;
  }
  writeStore(data);
  return true;
}

/** First 4 chars + "…" (bar wording). Secrets of 8 chars or fewer collapse to "…" alone —
 *  half of a short key is most of the key, so nothing of it is shown. */
export function redactSecret(secret: string): string {
  return secret.length > 8 ? secret.slice(0, 4) + "…" : "…";
}

/** Redacted listing for `aion auth list`: provider + key NAME + redacted prefix.
 *  The full secret value never appears in the returned records. */
export function listProviders(): { provider: string; keyName: string; redacted: string }[] {
  return Object.entries(loadCredentials())
    .map(([provider, cred]) => ({
      provider,
      keyName: cred.keyName ?? keyNameFor(provider),
      redacted: redactSecret(cred.key),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** aion provider id -> models.dev provider key, mirroring catalog.ts PROVIDER_MAP for the
 *  non-identity ids (together -> "togetherai", fireworks -> "fireworks-ai") plus an
 *  auth-only alias: moonshot -> "moonshotai" (models.dev has no bare "moonshot" key — the
 *  catalog reaches it via VENDOR_PREFIX_MAP on model ids instead, which auth cannot use).
 *  Identity ids (anthropic/openai/deepseek/openrouter/...) need no entry: keyNameFor tries
 *  the id itself against the snapshot first. */
const AUTH_PROVIDER_MAP: Record<string, string> = {
  together: "togetherai",
  fireworks: "fireworks-ai",
  moonshot: "moonshotai",
};

/** Which env var / key name a provider expects. models.dev drives this (snapshot
 *  Provider.env, e.g. anthropic -> ANTHROPIC_API_KEY — same source opencode's provider
 *  loader reads at provider.ts:1583 @ ebece6e); providers absent from models.dev (kaesra,
 *  ollama, moondream, vllm) fall back to <ID>_API_KEY, which matches every envKey in
 *  stream.ts builtinProviders by construction. */
export function keyNameFor(providerId: string): string {
  const key = AUTH_PROVIDER_MAP[providerId] ?? providerId;
  const env = snapshotProviders[key]?.env;
  if (env !== undefined && env.length > 0 && env[0]) return env[0];
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}
