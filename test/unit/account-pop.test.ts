/** The CLI's proof-of-possession half: keypair storage, compact-JWS signing, and the two places a proof
 *  or public key crosses the wire (`runDeviceLogin`'s code request, `linkWithToken`'s /me call). Proofs are
 *  checked with node:crypto primitives — the same contract the server verifies, without importing it. */

import { beforeEach, expect, test } from "bun:test";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountKey, loadOrCreateAccountKey, signProof, thumbprint, type AccountKey } from "../../src/account/keys.ts";
import { linkWithToken, runDeviceLogin } from "../../src/account/login.ts";
import { clearAccount } from "../../src/account/store.ts";

const TOKEN = `rc_live_${"a".repeat(32)}`;
let keys: AccountKey;
let dir: string;

beforeEach(() => {
  keys = createAccountKey();
  dir = mkdtempSync(join(tmpdir(), "rovecode-pop-"));
  clearAccount();
});

/** decode a compact JWS into header/payload and verify its signature against the header's own jwk */
function decodeProof(jws: string): { header: Record<string, unknown>; payload: Record<string, unknown>; valid: boolean } {
  const [h, p, s] = jws.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, unknown>;
  const key = createPublicKey({ key: header.jwk as never, format: "jwk" });
  const valid = cryptoVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s!, "base64url"));
  return { header, payload, valid };
}

test("a fresh key is an Ed25519 OKP JWK with a stable RFC 7638 thumbprint", () => {
  expect(keys.publicJwk.kty).toBe("OKP");
  expect(keys.publicJwk.crv).toBe("Ed25519");
  expect(keys.publicJwk.x.length).toBeGreaterThan(40);
  expect(thumbprint(keys.publicJwk)).toBe(keys.jkt);
  expect(thumbprint(keys.publicJwk)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("the key persists and reloads to the same identity", () => {
  const path = join(dir, "account-key.json");
  const first = loadOrCreateAccountKey(path);
  expect(existsSync(path)).toBe(true);
  const second = loadOrCreateAccountKey(path);
  expect(second.jkt).toBe(first.jkt);
  // a corrupt file regenerates instead of crashing
  rmSync(path);
  const third = loadOrCreateAccountKey(path);
  expect(third.jkt).not.toBe(first.jkt);
  rmSync(dir, { recursive: true, force: true });
});

test("signProof makes a verifiable compact JWS with the DPoP claims", () => {
  const jws = signProof(keys, { htm: "GET", htu: "http://api.test/api/auth/me", iat: 1_700_000_000, accessToken: TOKEN });
  const { header, payload, valid } = decodeProof(jws);
  expect(valid).toBe(true);
  expect(header.typ).toBe("dpop+jwt");
  expect(header.alg).toBe("EdDSA");
  expect(header.jwk).toEqual(keys.publicJwk);
  expect(payload.htm).toBe("GET");
  expect(payload.htu).toBe("http://api.test/api/auth/me");
  expect(payload.iat).toBe(1_700_000_000);
  expect(typeof payload.jti).toBe("string");
  expect(payload.ath).toBe(createHash("sha256").update(TOKEN).digest().toString("base64url"));
});

test("runDeviceLogin sends the public JWK — and never the private key — with the code request", async () => {
  let seenBody = "";
  const fetchImpl = (async (_input: unknown, init?: { body?: string }) => {
    seenBody = init?.body ?? "";
    return new Response(JSON.stringify({ error: "access_denied" }), { status: 400 });
  }) as unknown as typeof fetch;
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async () => {}, now: () => 0, keys });
  expect(result.ok).toBe(false);
  const parsed = JSON.parse(seenBody) as { public_jwk?: unknown };
  expect(parsed.public_jwk).toEqual(keys.publicJwk);
  expect(seenBody).not.toContain("privateJwk");
});

test("linkWithToken carries Bearer + a proof naming the method, URL and token hash", async () => {
  let seen: { url: string; auth: string | null; dpop: string | null } | null = null;
  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    seen = { url: String(input), auth: init?.headers?.authorization ?? null, dpop: init?.headers?.dpop ?? null };
    return new Response(JSON.stringify({ user: { id: "u1", email: "x@y.z", name: "X" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const account = await linkWithToken("http://api.test", TOKEN, fetchImpl, keys, () => 1_700_000_000_000);
  expect(account?.email).toBe("x@y.z");
  expect(seen!.url).toBe("http://api.test/api/auth/me");
  expect(seen!.auth).toBe(`Bearer ${TOKEN}`);
  const { payload, valid } = decodeProof(seen!.dpop!);
  expect(valid).toBe(true);
  expect(payload.htm).toBe("GET");
  expect(payload.htu).toBe("http://api.test/api/auth/me");
  expect(payload.iat).toBe(1_700_000_000);
  expect(payload.ath).toBe(createHash("sha256").update(TOKEN).digest().toString("base64url"));
});

test("linkWithToken still rejects a dead token, proof or not", async () => {
  const bad = (async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;
  expect(await linkWithToken("http://api.test", "nope", bad, keys)).toBeNull();
});
