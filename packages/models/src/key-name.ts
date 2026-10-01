/** Which env var a provider's key is read from: `ANTHROPIC_API_KEY` for anthropic, `<ID>_API_KEY` for a
 *  provider the catalog does not know.
 *
 *  The answer comes from the manifest (models-manifest.json — every provider's env name, 12 KB), read
 *  LAZILY and with a bare literal `require`: literal specifiers are what bun's bundler inlines and the
 *  single-binary compiler embeds (the catalog's index files ride the same mechanism); an earlier
 *  createRequire(import.meta.url) version stayed a RUNTIME lookup that found the file next to a dist
 *  chunk but went silent inside the compiled binary, where it degraded zai's key name to ZAI_API_KEY
 *  instead of ZHIPU_API_KEY. `require` rather than `await import` because keyNameFor is synchronous and
 *  called from synchronous code (rovecode's buildSnapshot asks it for every provider without an
 *  explicit keyEnv), so an async import would push through a dozen call sites to save nothing. The
 *  first version of this lookup parsed the full models.dev snapshot — 63 MB resident, for one string —
 *  and the module that did it was imported by half the host app, so every process paid it. The manifest
 *  is exactly the slice this function needs.
 *
 *  A missing or corrupt manifest degrades to the <ID>_API_KEY fallback, never to a throw: a guessed key
 *  name is recoverable (the user sets it), a crash on the config path is not.
 *
 *  AUTH_PROVIDER_MAP vs PROVIDER_MAP (provider-map.ts): they answer different questions and diverge ON
 *  PURPOSE. The catalog's map is about pricing — provider id `gemini` prices against Google's models.dev
 *  rows. This map is about the env var a human actually sets: `gemini` reads GEMINI_API_KEY, not
 *  GOOGLE_API_KEY, and a corporate `alibaba` registration reads ALIBABA_API_KEY, not DASHSCOPE_API_KEY.
 *  Only the ids whose env name provably lives under another key (together → togetherai's TOGETHER_API_KEY)
 *  belong here. Do not "dedupe" the two maps into one; a test in this package pins the three aliases that
 *  must agree. */

/** provider id → models.dev provider key, for the ids whose ENV VAR lives under a different key.
 *  moonshot → "moonshotai" is the auth-only alias: models.dev has no bare "moonshot" key (the catalog
 *  reaches those rows via VENDOR_PREFIX_MAP on model ids, which key lookup cannot use). Identity ids
 *  (anthropic/openai/deepseek/…) need no entry: the manifest is tried under the id itself first. */
const AUTH_PROVIDER_MAP: Record<string, string> = {
  together: "togetherai",
  fireworks: "fireworks-ai",
  moonshot: "moonshotai",
};

let manifestCache: Record<string, { env?: string[] } | undefined> | null = null;
function manifestProviders(): Record<string, { env?: string[] } | undefined> {
  if (manifestCache === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require("./models-manifest.json") as { providers?: Record<string, { env?: string[] }> };
      manifestCache = m.providers ?? {};
    } catch { manifestCache = {}; }
  }
  return manifestCache;
}

/** The env var name a provider's key is read from. models.dev drives it (the snapshot's Provider.env,
 *  e.g. anthropic → ANTHROPIC_API_KEY); providers absent from models.dev fall back to <ID>_API_KEY. */
export function keyNameFor(providerId: string): string {
  const key = AUTH_PROVIDER_MAP[providerId] ?? providerId;
  const env = manifestProviders()[key]?.env;
  if (env !== undefined && env.length > 0 && env[0]) return env[0];
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}
