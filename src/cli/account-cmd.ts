/** `rovecode login` / `rovecode account` / `rovecode logout` — the CLI half of the site account link.
 *  `login` runs the RFC 8628 device flow (src/account/login.ts) or takes a pasted token; `account` prints
 *  what is linked; `logout` removes it. */

import { accountPath, clearAccount, loadAccount } from "../account/store.ts";

const DEFAULT_API = "https://www.rovecode.dev";

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  const value = i !== -1 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith("-") ? value : undefined;
}

export async function cmdLogin(): Promise<number> {
  const { linkWithToken, runDeviceLogin } = await import("../account/login.ts");
  const apiBase = readFlag("--api") ?? process.env.ROVECODE_AUTH_API ?? DEFAULT_API;
  const json = process.argv.includes("--json");
  const manual = readFlag("--token");

  if (manual) {
    const account = await linkWithToken(apiBase, manual);
    if (!account) {
      console.error(`error: ${apiBase}/api/auth/me rejected the token`);
      return 1;
    }
    if (json) console.log(JSON.stringify({ ok: true, email: account.email, apiBase: account.apiBase }, null, 2));
    else console.log(`linked ${account.email || "an account"} (${account.apiBase}) — stored in ${accountPath()}`);
    return 0;
  }

  const result = await runDeviceLogin({
    apiBase,
    onCode: ({ userCode, verificationUri, expiresIn }) => {
      // a script still needs the code to show its human — stdout stays clean for the final result
      if (json) {
        console.error(JSON.stringify({ user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn }));
        return;
      }
      console.log("");
      console.log(`  your code:  ${userCode}`);
      console.log(`  open:       ${verificationUri}`);
      console.log(`  expires in about ${Math.max(1, Math.round(expiresIn / 60))} min — waiting for approval…`);
      console.log("");
    },
  });

  if (!result.ok) {
    const reasons = {
      denied: "the request was denied on the site",
      expired: "the code expired before it was approved",
      invalid: "the device code was rejected — run rovecode login again",
      network: `could not reach ${apiBase}`,
    };
    console.error(`error: ${reasons[result.reason]}`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ ok: true, email: result.account.email, apiBase: result.account.apiBase }, null, 2));
  else console.log(`linked ${result.account.email || "your account"} — stored in ${accountPath()}`);
  return 0;
}

export async function cmdAccount(): Promise<number> {
  const account = loadAccount();
  const json = process.argv.includes("--json");
  if (!account) {
    if (json) console.log(JSON.stringify({ linked: false }, null, 2));
    else console.log(`not linked — run: rovecode login   (looked in ${accountPath()})`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ linked: true, email: account.email, name: account.name, userId: account.userId, apiBase: account.apiBase, linkedAt: account.linkedAt }, null, 2));
    return 0;
  }
  console.log(`linked account: ${account.email || account.userId || "(unknown)"}`);
  console.log(`api:            ${account.apiBase}`);
  console.log(`since:          ${account.linkedAt || "(unknown)"}`);
  console.log(`file:           ${accountPath()}`);
  return 0;
}

export async function cmdLogout(): Promise<number> {
  const account = loadAccount();
  if (account) {
    // best effort: tell the API to revoke the token (proof-of-possession signed with this machine's key);
    // a dead server or an unbound legacy token must not stop the local unlink
    try {
      const { loadOrCreateAccountKey, signProof } = await import("../account/keys.ts");
      const keys = loadOrCreateAccountKey();
      const url = `${account.apiBase}/api/auth/token/revoke`;
      await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${account.token}`,
          dpop: signProof(keys, { htm: "POST", htu: url, iat: Math.floor(Date.now() / 1000), accessToken: account.token }),
        },
      });
    } catch {
      /* offline unlink is still an unlink */
    }
  }
  const removed = clearAccount();
  console.log(removed ? `unlinked — removed ${accountPath()}` : "nothing to unlink (no account stored)");
  return removed ? 0 : 1;
}
