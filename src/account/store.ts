/** The linked rovecode account (device-flow login): what `rovecode login` writes and `rovecode account`
 *  reads. Kept apart from providers/credentials.json on purpose — that file is the provider API keys the
 *  router resolves, and an account token is neither a provider nor a model key. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";

export interface LinkedAccount {
  /** the rc_live_… access token the site's device API issued */
  token: string;
  userId: string;
  email: string;
  name: string;
  /** the API base that issued it — a token is only valid there */
  apiBase: string;
  /** ISO 8601 */
  linkedAt: string;
}

export function accountPath(): string {
  return join(rovecodeHome(), "account.json");
}

export function loadAccount(): LinkedAccount | null {
  try {
    const parsed = JSON.parse(readFileSync(accountPath(), "utf8")) as Partial<LinkedAccount>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return {
      token: parsed.token,
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
      apiBase: typeof parsed.apiBase === "string" ? parsed.apiBase : "",
      linkedAt: typeof parsed.linkedAt === "string" ? parsed.linkedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveAccount(account: LinkedAccount): void {
  mkdirSync(rovecodeHome(), { recursive: true, mode: 0o700 });
  const path = accountPath();
  writeFileSync(path, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort, same Windows caveat as providers/auth.ts */
  }
}

/** returns false when there was nothing to remove */
export function clearAccount(): boolean {
  const path = accountPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
