/** The CLI's proof-of-possession key (Ed25519, node:crypto only — no dependencies).
 *
 *  `rovecode login` generates one keypair per machine and sends only the PUBLIC JWK with the device/code
 *  request; the server binds the issued `rc_live_…` token to that key's thumbprint. Every authed call then
 *  carries a compact-JWS proof (DPoP-style) in the `dpop` header, so a stolen token alone answers 401.
 *
 *  The private key lives in ~/.rovecode/account-key.json (mode 0600) and never crosses the wire. */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";

export interface PopJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface AccountKey {
  privateKey: KeyObject;
  publicJwk: PopJwk;
  /** RFC 7638 thumbprint of publicJwk — what the server binds the token to */
  jkt: string;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

export function keyPath(): string {
  return join(rovecodeHome(), "account-key.json");
}

export function thumbprint(publicJwk: PopJwk): string {
  return b64url(createHash("sha256").update(`{"crv":"${publicJwk.crv}","kty":"${publicJwk.kty}","x":"${publicJwk.x}"}`).digest());
}

export function createAccountKey(): AccountKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const publicJwk: PopJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x! };
  return { privateKey, publicJwk, jkt: thumbprint(publicJwk) };
}

/** load the machine's key, generating and persisting it on first use (or after a corrupt file) */
export function loadOrCreateAccountKey(path: string = keyPath()): AccountKey {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { privateJwk?: unknown; publicJwk?: unknown };
    const privateKey = createPrivateKey({ key: parsed.privateJwk as never, format: "jwk" });
    const publicKey = createPublicKey({ key: parsed.publicJwk as never, format: "jwk" });
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) throw new Error("not an Ed25519 key");
    const publicJwk: PopJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
    return { privateKey, publicJwk, jkt: thumbprint(publicJwk) };
  } catch {
    const key = createAccountKey();
    saveAccountKey(key, path);
    return key;
  }
}

function saveAccountKey(key: AccountKey, path: string): void {
  mkdirSync(rovecodeHome(), { recursive: true, mode: 0o700 });
  const privateJwk = key.privateKey.export({ format: "jwk" });
  writeFileSync(path, JSON.stringify({ privateJwk, publicJwk: key.publicJwk }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort, same Windows caveat as account/store.ts */
  }
}

export interface ProofClaims {
  htm: string;
  htu: string;
  /** seconds since epoch */
  iat: number;
  jti?: string;
  /** the access token the request carries — its sha256 goes in as ath */
  accessToken?: string;
}

/** sign a compact JWS (`dpop+jwt`) for one request. jti defaults to 128 random bits. */
export function signProof(key: AccountKey, claims: ProofClaims): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "EdDSA", jwk: key.publicJwk })));
  const payload: Record<string, unknown> = {
    jti: claims.jti ?? b64url(randomBytes(16)),
    htm: claims.htm,
    htu: claims.htu,
    iat: claims.iat,
  };
  if (claims.accessToken !== undefined) {
    payload.ath = b64url(createHash("sha256").update(claims.accessToken).digest());
  }
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(edSign(null, Buffer.from(`${header}.${body}`), key.privateKey));
  return `${header}.${body}.${sig}`;
}
