/** Eval persistence redaction (eval P0-5): API keys, Bearer tokens, JWTs and private keys
 *  never survive a trajectory write. Also pins the OTel contract the research critique
 *  leaned on: telemetry spans carry ids/sizes/outcomes, never raw args/output — if
 *  otel.ts ever grows an args/output attribute, the gate here turns red. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, redactionReport, redactDeep, REDACTION_PATTERNS } from "../../src/eval/redact.ts";

describe("redactSecrets — provider key shapes", () => {
  const cases: readonly [string, string, string, string?][] = [
    ["anthropic", "connect with sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQrStU and go", "sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQrStU", " and go"],
    ["openai project", "key sk-proj-abcdefghij0123456789ABCDE stored", "sk-proj-abcdefghij0123456789ABCDE", "key "],
    ["openai legacy", "key sk-abcdefghij0123456789 stored", "sk-abcdefghij0123456789", "key "],
    ["aws access key", "id AKIAIOSFODNN7EXAMPLE in args", "AKIAIOSFODNN7EXAMPLE", "id "],
    ["github token", "pushing as ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", "pushing as "],
    ["github fine-grained", "token github_pat_11AAAAAAA0abcdefghij0123456789 revoked", "github_pat_11AAAAAAA0abcdefghij0123456789", "token "],
    ["google api key", "AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz set", "AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz", " set"],
    ["slack token", "xoxb-FIXTURE-REDACTED rotated", "xoxb-FIXTURE-REDACTED", " rotated"],
  ];
  for (const [name, input, secret, survives] of cases) {
    test(`${name} key is replaced`, () => {
      const out = redactSecrets(input);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(secret.slice(0, 20)); // no partial prefix survives either
      expect(out).toContain("[REDACTED:");
      if (survives !== undefined) expect(out).toContain(survives);
    });
  }

  test("Bearer token loses its value, keeps the scheme", () => {
    const out = redactSecrets("Authorization: Bearer abc123def456._~+/=-sig");
    expect(out).not.toContain("abc123def456");
    expect(out).toContain("Bearer [REDACTED");
  });

  test("Basic auth credentials are replaced", () => {
    const out = redactSecrets("Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(out).toContain("Basic [REDACTED");
  });

  test("JWT triplets are replaced", () => {
    const out = redactSecrets("tok=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("[REDACTED:jwt]");
  });

  test("PEM private key blocks are replaced whole", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7x\nmore lines\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`have:\n${pem}\nthanks`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA7x");
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).toContain("have:");
  });

  test("key=value assignments keep the key, lose the value", () => {
    const out = redactSecrets('api_key = "supersecretvalue";');
    expect(out).not.toContain("supersecretvalue");
    expect(out).toContain("api_key = ");
    expect(out).toContain("[REDACTED");
  });

  test("idempotent: redacting twice changes nothing", () => {
    const once = redactSecrets("Bearer abc123def456 and sk-abcdefghij0123456789");
    expect(redactSecrets(once)).toBe(once);
  });

  test("innocent text is untouched (no false positives)", () => {
    const keep = "output_bytes=42 skate token-bucket model gpt-5 read note.txt line 6767";
    expect(redactSecrets(keep)).toBe(keep);
  });
});

describe("redactionReport", () => {
  test("names each pattern kind and counts hits", () => {
    const report = redactionReport("a sk-abcdefghij0123456789 b sk-abcdefghij0123456789 c Bearer abc123def456");
    const kinds = Object.fromEntries(report.matches.map((m) => [m.kind, m.count]));
    expect(kinds["openai"]).toBe(2);
    expect(kinds["bearer"]).toBe(1);
    expect(report.matches.length).toBeGreaterThan(0);
  });

  test("patterns are exported and uniquely named", () => {
    const names = REDACTION_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("private-key");
  });
});

describe("redactDeep", () => {
  test("string values are pattern-redacted, structure preserved", () => {
    const args = { path: "note.txt", content: "call with sk-abcdefghij0123456789" };
    const out = redactDeep(args) as typeof args;
    expect(out.path).toBe("note.txt");
    expect(out.content).not.toContain("sk-abcdefghij0123456789");
    expect(out.content).toContain("[REDACTED:");
  });

  test("sensitive KEY names are redacted regardless of value shape", () => {
    const out = redactDeep({
      authorization: "Bearer whatever",
      api_key: "short1",
      nested: { password: "hunter2", apiKey: "x".repeat(40) },
      list: [{ secret: "top" }],
    }) as Record<string, unknown>;
    expect(out.authorization).toContain("[REDACTED");
    expect(out.api_key).toContain("[REDACTED");
    const nested = out.nested as Record<string, string>;
    expect(nested.password).toContain("[REDACTED");
    expect(nested.apiKey).toContain("[REDACTED");
    expect((out.list as Record<string, string>[])[0]!.secret).toContain("[REDACTED");
  });

  test("non-string leaves are left alone", () => {
    const out = redactDeep({ n: 42, b: false, nil: null, arr: [1, "x"] }) as Record<string, unknown>;
    expect(out.n).toBe(42);
    expect(out.b).toBe(false);
    expect(out.nil).toBe(null);
    expect(out.arr).toEqual([1, "x"]);
  });

  test("handles cycles without hanging", () => {
    const a: Record<string, unknown> = { name: "Bearer abc123def456" };
    a.self = a;
    const out = redactDeep(a) as Record<string, unknown>;
    expect(out.name).toContain("[REDACTED");
  });
});

describe("OTel contract pin (the redaction critique's premise)", () => {
  test("otel spans carry no raw args/output attribute — sizes and outcomes only", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/telemetry/otel.ts"), "utf8");
    const names = new Set(src.match(/rovecode\.[a-z_]+/g) ?? []);
    expect(names.size).toBeGreaterThan(3);
    for (const name of names) {
      if (name === "rovecode.output_bytes") continue; // a SIZE, not content
      expect(name).not.toMatch(/output/);
      expect(name).not.toMatch(/args/);
    }
    expect(names.has("rovecode.output_bytes")).toBe(true);
  });
});
