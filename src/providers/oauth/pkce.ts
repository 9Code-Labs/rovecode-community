/** PKCE (RFC 7636) verifier/challenge + the CSRF `state` nonce — VENDORED from pi.
 *
 *  Source: earendil-works/pi, packages/ai/src/auth/oauth/pkce.ts (snapshot under
 *  research/source_snapshots/earendil-works-pi, @earendil-works/ai 0.84.4). License: MIT —
 *
 *    Copyright (c) 2025 Mario Zechner
 *
 *    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *    associated documentation files (the "Software"), to deal in the Software without restriction,
 *    including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *    sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *    furnished to do so, subject to the following conditions: The above copyright notice and this
 *    permission notice shall be included in all copies or substantial portions of the Software.
 *    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *    NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 *  Local additions (port #66): `randomState()` (32 random bytes, base64url — pi's openai-codex flow
 *  uses 16 hex bytes from node:crypto; Web Crypto keeps this module dependency-free) and the exported
 *  `base64url` helper (the tests recompute S256(verifier) with it). */

/** Encode bytes as a base64url string (no padding). */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Generate a PKCE code verifier (32 random bytes, base64url) and its S256 challenge. */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(hash)) };
}

/** The per-login CSRF nonce: 32 random bytes, base64url (43 chars, URL-path safe). */
export function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
