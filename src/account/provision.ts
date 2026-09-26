/** After a device login the CLI holds a rove_live_… inference key the site minted for it. This turns
 *  that key into a ready-to-use "rovecode" provider — registered, key stored, made the default when
 *  nothing else is — so `rovecode login` alone takes a fresh install to a working model. */

import { saveCredential } from "../providers/auth.ts";
import { ProviderRegistry } from "../providers/registry.ts";

export const ROVECODE_BASE_URL = "https://api.rovecode.dev/v1";
export const ROVECODE_KEY_ENV = "ROVECODE_API_KEY";
export const ROVECODE_DEFAULT_MODEL = "grok-4.7";

export interface ProvisionResult {
  /** the provider entry was created now (false = it already existed) */
  added: boolean;
  keyStored: boolean;
  /** it became the default model (false = the user already had a default — left untouched) */
  defaulted: boolean;
  error?: string;
}

export function ensureRovecodeProvider(apiKey: string, cwd: string = process.cwd()): ProvisionResult {
  const reg = new ProviderRegistry(cwd);
  let added = false;
  if (reg.get("rovecode") === undefined) {
    const r = reg.add(
      {
        id: "rovecode",
        baseUrl: ROVECODE_BASE_URL,
        protocol: "openai",
        keyEnv: ROVECODE_KEY_ENV,
        defaultModel: ROVECODE_DEFAULT_MODEL,
      },
      "user",
    );
    if ("error" in r) return { added: false, keyStored: false, defaulted: false, error: r.error };
    added = true;
  }
  saveCredential("rovecode", apiKey, ROVECODE_KEY_ENV);
  reg.refresh();

  let defaulted = false;
  if (reg.defaultRef() === null) {
    const d = reg.setDefault(`rovecode/${ROVECODE_DEFAULT_MODEL}`, "user");
    if (!("error" in d)) defaulted = true;
  }
  return { added, keyStored: true, defaulted };
}
