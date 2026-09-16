/** Provider credential store (port #37): backing for `rovecode auth set/list/remove`.
 *
 *  Ported from opencode packages/opencode/src/auth/index.ts @ ebece6e (MIT):
 *  - one JSON object keyed by provider id, entries discriminated by `type` (index.ts:14-36)
 *  - the "api" variant carries the secret in `key` (index.ts:23-27); the provider loader
 *    consumes it as the apiKey (provider.ts:1596-1601)
 *  - file written with mode 0o600 (index.ts:79,88)
 *  - a missing/corrupt file reads as {} and malformed entries are dropped per-entry, never
 *    fatal (index.ts:65-66, Record.filterMap over the schema decode)
 *  Deviations: the file lives at ~/.rovecode/credentials.json (bar) instead of opencode's
 *  <data>/auth.json; entries carry an rovecode-only optional `keyName` (which env var the
 *  secret stands in for); the "api" variant plus, since the OAuth port (aion port #66, brought over
 *  2026-09-07), the "oauth" variant (`rovecode auth login`): `access` (the bearer the provider seam
 *  sends), `refresh` (what mints a new access token; "" when the provider issues a permanent key),
 *  `expires` (ms since the epoch; Number.MAX_SAFE_INTEGER = never) — pi's OAuthCredential shape
 *  (packages/ai/src/auth/types.ts). The `type` field is the record's kind discriminator. Entries with
 *  any other `type` round-trip through save/remove unharmed but are not listed or resolved.
 *
 *  Also home to readSecret (the `rovecode auth set` prompt) so its TTY path is unit-testable
 *  in-process — main.ts cannot be imported by tests (it dispatches on load).
 *
 *  SECRETS ARE NEVER LOGGED from this module: the only terminal output is readSecret's
 *  prompt text plus cursor-control sequences, error messages never embed the credential
 *  value, and the store itself prints nothing. Rendering (redacted) is the caller's job
 *  via listProviders()/redactSecret().
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

/** The provider index, loaded ONLY when something asks for a key name.
 *
 *  Two things were wrong here and they compounded. The import was at the top of the module, and what it
 *  imported was the full models.dev snapshot: 63 MB resident, for one call site (`keyNameFor`). Meanwhile
 *  `rovecodeHome`, three lines of path arithmetic in this same file, is imported by hooks.ts, settings.ts,
 *  runtime.ts, the plugin loader and half the TUI — so all of them paid 63 MB to learn where `~/.rovecode`
 *  is, and the TUI paid it at startup before drawing a frame.
 *
 *  Now it is deferred, and it reads the trimmed index (src/providers/models-index.json, the same file the
 *  catalog reads) rather than the upstream snapshot. Only `env[0]` is ever used from it.
 *
 *  `require` rather than `await import` because `keyNameFor` is synchronous and called from synchronous
 *  code; making it async would push the change through a dozen call sites to save nothing extra. */
let snapshotCache: Record<string, { env?: string[] } | undefined> | null = null;
function snapshotProvidersLazy(): Record<string, { env?: string[] } | undefined> {
  if (snapshotCache === null) {
    const req = createRequire(import.meta.url);
    const m = req("./models-index.json") as { providers?: Record<string, { env?: string[] }> };
    snapshotCache = m.providers ?? {};
  }
  return snapshotCache;
}

export interface StoredCredential {
  type: "api";
  /** the secret itself (upstream field name — auth/index.ts:24) */
  key: string;
  /** rovecode extension: env var name this secret stands in for (e.g. ANTHROPIC_API_KEY) */
  keyName?: string;
}

/** An OAuth login (`rovecode auth login <provider>`), pi's OAuthCredential shape. */
export interface StoredOAuthCredential {
  type: "oauth";
  /** the bearer the provider seam sends (short-lived where the provider issues one) */
  access: string;
  /** what refresh() presents to mint a new access token (github-copilot: the GitHub OAuth token;
   *  openai: the refresh_token; "" when the provider issued a permanent key — openrouter) */
  refresh: string;
  /** access-token expiry, ms since the epoch; Number.MAX_SAFE_INTEGER = never expires */
  expires: number;
  /** openai: the ChatGPT account id from the access token's JWT claim (request header) */
  accountId?: string;
}

/** Port #76: an MCP server's OAuth token (`rovecode mcp login <name>`, stored under `mcp:<name>`) — the SDK-driven
 *  flow's whole session, so a connect needs no discovery or registration round trip: `url` (a record is attached
 *  only to the server whose configured url EQUALS it), `access` ("" once invalidated — the record then still carries
 *  the client + discovery), `refresh` ("" when the server issued none), `expires` (ms since the epoch;
 *  Number.MAX_SAFE_INTEGER = never), the registered client (`client_id`, plus a DCR-issued secret when the server
 *  insisted on one — never a configured one) and the SDK's discovery state (opaque here; mcp/oauth.ts reads it).
 *  Listed by `auth list` (kind oauth, key name `mcp server token`), removable, NEVER resolved as a chat provider. */
export interface StoredMcpOAuthRecord {
  type: "mcp-oauth";
  url: string;
  access: string;
  refresh: string;
  expires: number;
  clientInformation?: { client_id: string; client_secret?: string; client_id_issued_at?: number; client_secret_expires_at?: number };
  discovery?: Record<string, unknown>;
}

/** The mode the store is written with (create AND re-asserted on rewrite) — the single source
 *  the tests pin; see the Windows note on writeStore. */
export const CREDENTIALS_FILE_MODE = 0o600;

/** User-scope rovecode dir: ROVECODE_HOME overrides ~/.rovecode wholesale (tests point it at a temp
 *  dir). homedir() already respects HOME on POSIX and USERPROFILE on Windows. Mirrors the
 *  skills store's user-scope default (skills/index.ts: join(homedir(), ".rovecode", ...)). */
/** what node's homedir() promises, spelled out so every runtime agrees on every host: HOME on POSIX,
 *  USERPROFILE on Windows, the OS account's directory only when neither is set (tests point HOME at a
 *  scratch dir and expect the home to follow) */
const userHome = (): string => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();

export function rovecodeHome(): string {
  const explicit = process.env.ROVECODE_HOME;
  const home = explicit ?? join(userHome(), ".rovecode");
  migrateLegacyHome(home, { explicit: explicit !== undefined });
  return home;
}

/** The config directory used to be `~/.cumulus` (the project was called nimbus). A rename must not
 *  cost anyone their stored API keys and providers, so the first call that resolves the new home
 *  COPIES the old one into it — copy, not move: the old directory is left exactly as it was, so
 *  downgrading to an older build keeps working and nothing is destroyed if this goes wrong.
 *
 *  Runs once per process, only when the new home does not exist yet and the old one does, and ONLY for
 *  the default home. An explicit ROVECODE_HOME used to be migrated the same way "which is what makes it
 *  testable", and that was a real hazard rather than a convenience: pointing ROVECODE_HOME at a fresh
 *  path — the ordinary way to get an isolated home for a test, a script or a clean-room check — silently
 *  filled it with a copy of the old credentials. It billed two real API calls during this repository's
 *  own release verification (2026-09-06) before anyone noticed the scratch home was not scratch. Tests
 *  that need to exercise the migration pass `legacyDir`; nothing else copies a user's keys into a path
 *  they chose for isolation.
 *
 *  Any failure is swallowed: a migration that cannot run must not stop the agent from starting — the
 *  user simply sees "no provider configured" and runs `rovecode connect`. */
let migrated = false;
export function migrateLegacyHome(home: string, opts: { explicit?: boolean; legacyDir?: string; note?: (line: string) => void } = {}): void {
  if (migrated && opts.legacyDir === undefined) return;
  if (opts.legacyDir === undefined) migrated = true;
  try {
    if (existsSync(home)) return;                        // already living in the new place
    const legacy = opts.legacyDir ?? join(userHome(), ".cumulus");
    // an explicit ROVECODE_HOME is a request for THIS directory, not for a copy of another one. The
    // injected legacyDir does not override it: a test that wants the explicit case must SEE the refusal.
    if (opts.explicit === true) return;
    if (home === legacy || !existsSync(legacy)) return;
    cpSync(legacy, home, { recursive: true });
    // and it says so: a copy of someone's credentials appearing in a new directory is not a silent event
    (opts.note ?? ((l: string) => console.error(l)))(`migrated ${legacy} → ${home} (the config directory was renamed; the old one is untouched)`);
    // the credentials file carries the 0600 the old one had only on POSIX; re-assert it here
    const creds = join(home, "credentials.json");
    if (existsSync(creds) && process.platform !== "win32") chmodSync(creds, CREDENTIALS_FILE_MODE);
  } catch { /* best effort: a failed migration is a fresh config, never a crash */ }
}

export function credentialsPath(): string {
  return join(rovecodeHome(), "credentials.json");
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
  // whitespace-only counts as empty: a hand-edited `"key": " "` must not shadow a valid env key
  if (v.type !== "api" || typeof v.key !== "string" || v.key.trim().length === 0) return false;
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

function isOAuthCredential(value: unknown): value is StoredOAuthCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; access?: unknown; refresh?: unknown; expires?: unknown; accountId?: unknown };
  if (v.type !== "oauth" || typeof v.access !== "string" || v.access.trim().length === 0) return false;
  if (typeof v.refresh !== "string" || typeof v.expires !== "number" || !Number.isFinite(v.expires)) return false;
  // `expires` must sit inside Date's range (±8.64e15 ms) or be the "never" sentinel — `auth list` renders it
  // through toISOString, which throws RangeError beyond that, and a hand-edited entry is never fatal
  if (Math.abs(v.expires) > 8.64e15 && v.expires !== Number.MAX_SAFE_INTEGER) return false;
  return v.accountId === undefined || typeof v.accountId === "string";
}

/** Valid "oauth" credentials only, keyed by provider id (malformed entries dropped). */
export function loadOAuthCredentials(): Record<string, StoredOAuthCredential> {
  const out: Record<string, StoredOAuthCredential> = {};
  for (const [id, value] of Object.entries(readRaw())) {
    if (isOAuthCredential(value)) out[id] = value;
  }
  return out;
}

/** Port #76: the mcp-oauth variant — same range rule on `expires` as isOAuthCredential; `access` may be "" (invalidated). */
export function isMcpOAuthRecord(value: unknown): value is StoredMcpOAuthRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "mcp-oauth" || typeof v.url !== "string" || v.url.length === 0) return false;
  if (typeof v.access !== "string" || typeof v.refresh !== "string" || typeof v.expires !== "number" || !Number.isFinite(v.expires)) return false;
  if (Math.abs(v.expires) > 8.64e15 && v.expires !== Number.MAX_SAFE_INTEGER) return false;
  const ci = v.clientInformation;
  if (ci !== undefined && (typeof ci !== "object" || ci === null || typeof (ci as { client_id?: unknown }).client_id !== "string")) return false;
  const d = v.discovery;
  return d === undefined || (typeof d === "object" && d !== null && !Array.isArray(d));
}

/** Port #76: one raw entry as stored (any `type`), or undefined. The MCP module validates it (isMcpOAuthRecord). */
export function readEntry(id: string): unknown {
  return readRaw()[id];
}

/** Port #76: store/replace one entry verbatim (0600 on create and rewrite), or delete it (`undefined` — the file goes
 *  when it was the last entry, like removeCredential). The value is never echoed or thrown. */
export function writeEntry(id: string, value: object | undefined): void {
  if (id.trim().length === 0) throw new Error("credential id must not be empty");
  if (value === undefined) {
    removeCredential(id);
    return;
  }
  const data = readRaw();
  data[id] = value;
  writeStore(data);
}

/** Store/replace a provider's OAuth credential (an "api" entry under the same id is replaced —
 *  one entry per provider). Tokens are never echoed or thrown. */
export function saveOAuthCredential(provider: string, cred: StoredOAuthCredential): void {
  const id = provider.trim();
  if (id.length === 0) throw new Error("provider id must not be empty");
  if (!isOAuthCredential(cred)) throw new Error(`refusing to store a malformed OAuth credential for ${id}`);
  const data = readRaw();
  data[id] = { type: "oauth", access: cred.access, refresh: cred.refresh, expires: cred.expires, ...(cred.accountId !== undefined ? { accountId: cred.accountId } : {}) };
  writeStore(data);
}

/** Write the store with restrictive permissions.
 *
 *  Windows honesty note: fs mode bits on win32 map only onto the FILE_ATTRIBUTE_READONLY
 *  flag — 0o600 does NOT create owner-only protection there. Real isolation on Windows
 *  comes from the NTFS ACL on %USERPROFILE% (inherited by ~/.rovecode), which by default
 *  denies other non-admin users. So this is best-effort hardening on POSIX (where the
 *  0o600/0o700 bits are enforced) and effectively a no-op on Windows beyond the profile
 *  ACL it inherits — we do not claim otherwise. */
function writeStore(data: Record<string, unknown>): void {
  const path = credentialsPath();
  mkdirSync(rovecodeHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: CREDENTIALS_FILE_MODE });
  try {
    chmodSync(path, CREDENTIALS_FILE_MODE); // `mode` above only applies on create; re-assert on rewrites
  } catch {
    // best-effort (see Windows note) — a failed chmod must not lose the write
  }
}

/** Store/replace the credential for a provider. `secret` is never echoed or thrown. */
export function saveCredential(provider: string, secret: string, keyName?: string): void {
  const id = provider.trim();
  if (id.length === 0) throw new Error("provider id must not be empty");
  if (secret.trim().length === 0) throw new Error(`refusing to store an empty secret for ${id}`);
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

export interface ProviderListing {
  provider: string;
  /** the record's `type` — api (`auth set`) or oauth (`auth login`; also the mcp-oauth records of port #76) */
  kind: "api" | "oauth";
  /** api: the env var the key stands in for; oauth: the literal "oauth token"; mcp-oauth: "mcp server token" */
  keyName: string;
  redacted: string;
  /** oauth only: access-token expiry, ms since the epoch (Number.MAX_SAFE_INTEGER = never) */
  expires?: number;
}

/** Redacted listing for `rovecode auth list`: provider + kind + key NAME + redacted prefix (+ expiry
 *  for OAuth entries). No secret value — key, access token or refresh token — appears in the records. */
export function listProviders(): ProviderListing[] {
  const api: ProviderListing[] = Object.entries(loadCredentials()).map(([provider, cred]) => ({
    provider, kind: "api", keyName: cred.keyName ?? keyNameFor(provider), redacted: redactSecret(cred.key),
  }));
  const oauth: ProviderListing[] = Object.entries(loadOAuthCredentials()).map(([provider, cred]) => ({
    provider, kind: "oauth", keyName: "oauth token", redacted: redactSecret(cred.access), expires: cred.expires,
  }));
  // port #76: MCP server tokens (`mcp:<name>`) — listed and removable like any entry, never a chat provider
  const mcp: ProviderListing[] = Object.entries(readRaw()).flatMap(([provider, value]) => isMcpOAuthRecord(value)
    ? [{ provider, kind: "oauth" as const, keyName: "mcp server token", redacted: redactSecret(value.access), expires: value.expires }]
    : []);
  return [...api, ...oauth, ...mcp].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** rovecode provider id -> models.dev provider key, mirroring catalog.ts PROVIDER_MAP for the
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
  const env = snapshotProvidersLazy()[key]?.env;
  if (env !== undefined && env.length > 0 && env[0]) return env[0];
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}

// ---------- secret prompt (`rovecode auth set`) ----------

type SecretInput = NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean };
type SecretOutput = NodeJS.WritableStream & { columns?: number };
/** Streams readSecret talks to — injectable so tests can drive a fake TTY in-process. */
export interface SecretPromptIO { input?: SecretInput; output?: SecretOutput }

/** Cursor-control sequence for the cooked-mode fallback: after Enter the terminal has echoed
 *  prompt+line and moved to the next row, so erase ONE row per wrapped row the echo occupied
 *  (cursor-up + erase-line each), then "\r". A single row is not enough — a 33-col prompt plus
 *  a 108-char Anthropic key wraps on any terminal narrower than 141 columns. Pure: pinned by
 *  the headless-xterm test at 80 and 120 columns. Unknown/zero width assumes 80. */
export function echoScrubSequence(promptLen: number, lineLen: number, columns: number): string {
  const cols = columns > 0 ? Math.floor(columns) : 80;
  const rows = Math.max(1, Math.ceil((promptLen + lineLen) / cols));
  return "\x1b[1A\x1b[2K".repeat(rows) + "\r";
}

/** Read one secret line for `rovecode auth set`. What is guaranteed:
 *  - TTY stdin: the prompt goes to stderr and readline runs in terminal mode, which calls
 *    setRawMode(true): the terminal driver's echo is OFF and readline's own echo goes to a
 *    sink, so the keystrokes are never written to the terminal at all. Verified on a real
 *    Windows console under Bun 1.3.14 — the console input mode drops ENABLE_ECHO_INPUT and
 *    ENABLE_LINE_INPUT, the screen buffer stays clean, and the mode is restored on close.
 *  - Fallback, only if raw mode did not take (no/failing setRawMode, input.isRaw stays false):
 *    the driver echoed, so after Enter every row the prompt+echo wrapped onto is erased
 *    (echoScrubSequence). A terminal that ignores VT cursor sequences keeps that echo.
 *  - Piped stdin (scripts, tests): one line, no prompt, nothing written to any stream.
 *  The value is returned trimmed and is never logged or embedded in an error. */
export function readSecret(promptText: string, io: SecretPromptIO = {}): Promise<string> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const tty = input.isTTY === true;
  if (tty) output.write(promptText);
  const rl = tty
    ? createInterface({ input, output: new Writable({ write: (_c, _e, cb) => cb() }), terminal: true })
    : createInterface({ input });
  const raw = tty && input.isRaw === true;
  return new Promise((resolve) => {
    let settled = false; // rl.close() emits "close" SYNCHRONOUSLY — guard the race
    rl.once("line", (line) => {
      if (settled) return;
      settled = true;
      // raw: nothing was echoed, just end the prompt line; not raw: erase the echoed rows
      if (tty) output.write(raw ? "\n" : echoScrubSequence(promptText.length, line.length, output.columns ?? 80));
      rl.close();
      resolve(line.trim());
    });
    rl.once("close", () => { // EOF / Ctrl+C / Ctrl+D without a line
      if (settled) return;
      settled = true;
      if (tty) output.write("\n");
      resolve("");
    });
  });
}
