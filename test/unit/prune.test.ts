/** P0-2: view-only prune of old tool outputs (src/core/compaction.ts pruneToolOutputs).
 *  OpenCode prune deseni (session/compaction.ts:271-294): sondan geriye son kullanıcı turu +
 *  protectTokens kadar araç trafiği korunur, daha eski tool_result çıktıları YERİNDE stub'lanır.
 *  Fark: store hiç dokunulmaz — dönen view yeni mesaj nesneleri taşır, girdi değişmez.
 *  Pinlenenler: son-user-turu muafiyeti, hata sonuçları muafiyeti, protectedTools muafiyeti,
 *  minimum kazanç eşiği, çağrı/sonuç bütünlüğü (stub yerinde kalır), idempotans. */

import { test, expect } from "bun:test";
import { pruneToolOutputs, DEFAULT_PRUNE_CONFIG, PRUNE_STUB_MARK, type PruneConfig } from "../../src/core/compaction.ts";
import { partsTokenText } from "../../src/core/loop.ts";
import { estimateTokens } from "../../src/core/context.ts";
import type { Message } from "../../src/core/types.ts";

let seq = 0;
function msg(role: Message["role"], parts: Message["parts"], id = `m${++seq}`): Message {
  return { id, role, parts, parentId: null, createdAt: 0 };
}
const user = (text: string) => msg("user", [{ kind: "text", text }]);
const asst = (text: string) => msg("assistant", [{ kind: "text", text }]);
const call = (callId: string, tool: string) =>
  msg("assistant", [{ kind: "tool_call", id: callId, tool, args: {} }]);
const result = (callId: string, output: string, ok = true) =>
  msg("tool", [{ kind: "tool_result", callId, ok, output }]);

const tokenText = (m: Message) => partsTokenText(m.parts);
const big = (n: number) => "x".repeat(n);

/** cfg: 400-token protect, 50-token min gain — test ölçeğinde */
const cfg: PruneConfig = { protectTokens: 400, minGainTokens: 50, protectedTools: ["skill_view"], headChars: 40 };

function pairsIntact(view: readonly Message[]): boolean {
  const calls = new Set(view.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : []))));
  const results = new Set(view.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_result" ? [p.callId] : []))));
  return [...results].every((c) => calls.has(c)) && [...calls].every((c) => results.has(c));
}

test("old big tool outputs are stubbed in place; the view frees the tokens; the INPUT is never mutated", () => {
  // current turn: user + small traffic. Old turns: two big results (4000 chars ≈ 1000 tokens each).
  const history = [
    user("eski iş"), call("c1", "bash"), result("c1", big(4_000)),
    asst("tamam"), user("ikinci iş"), call("c2", "bash"), result("c2", big(4_000)),
    asst("oldu"), user("şimdi yeni iş"), call("c3", "read"), result("c3", "küçük"),
  ];
  const snapshot = JSON.parse(JSON.stringify(history));
  const r = pruneToolOutputs(history, cfg, tokenText);
  expect(r).not.toBeNull();
  expect(r!.pruned).toBe(2);
  expect(r!.tokensFreed).toBeGreaterThan(1_800);                    // ~2000 token düştü
  expect(r!.tokensAfter).toBeLessThan(r!.tokensBefore);
  expect(history).toEqual(snapshot);                                // girdi aynen duruyor
  expect(pairsIntact(r!.view)).toBe(true);                          // çağrı/sonuç asla ayrılmaz
  // stub'lanan sonuçlar yeni nesneler; korunan sonuçlar aynı referans
  const v1 = r!.view[2]!, v2 = r!.view[6]!, v3 = r!.view.at(-1)!;
  expect(v1).not.toBe(history[2]);
  expect(v2).not.toBe(history[6]);
  expect(v3).toBe(history.at(-1)!);                                  // son tur dokunulmaz
  const stub1 = (v1.parts[0] as { output: string }).output;
  expect(stub1).toContain(PRUNE_STUB_MARK);
  expect(stub1).toContain(`${4_000}`);                              // orijinal boyut söylenir
  expect(stub1.startsWith(big(40))).toBe(true);                     // headChars kadar baş korunur
  expect(stub1.length).toBeLessThan(400);
  expect(stub1).toMatch(/transcript|re-run|re-read/i);              // devam ipucu
});

test("the last user turn is untouchable however big its tool outputs are", () => {
  const history = [
    user("eski"), call("c1", "bash"), result("c1", big(8_000)),
    user("yeni"), call("c2", "bash"), result("c2", big(8_000)),
  ];
  const r = pruneToolOutputs(history, cfg, tokenText)!;
  expect(r.pruned).toBe(1);                                          // sadece c1
  const last = (r.view.at(-1)!.parts[0] as { output: string }).output;
  expect(last).toBe(big(8_000));                                     // aynen duruyor
});

test("recent tool traffic within protectTokens is kept even though it is old", () => {
  // c2/c3 (toplam ≤ 400 token) koruma bütçesinde; c1 dışarıda kalır
  const history = [
    user("eski"), call("c1", "bash"), result("c1", big(4_000)),
    user("orta"), call("c2", "bash"), result("c2", big(600)),       // 150 token
    user("yeni"), call("c3", "read"), result("c3", big(200)),       // 50 token
  ];
  const r = pruneToolOutputs(history, cfg, tokenText)!;
  expect(r.pruned).toBe(1);
  expect((r.view[5]!.parts[0] as { output: string }).output).toBe(big(600));  // c2 korundu
  expect((r.view[2]!.parts[0] as { output: string }).output).toContain(PRUNE_STUB_MARK);
});

test("failed results are NEVER pruned — the error text is what the model must keep seeing", () => {
  const history = [
    user("eski"), call("c1", "bash"), result("c1", big(4_000), false),   // hata
    user("orta"), call("c2", "bash"), result("c2", big(4_000)),          // normal
    user("yeni"), asst("…"),
  ];
  const r = pruneToolOutputs(history, cfg, tokenText)!;
  expect(r.pruned).toBe(1);
  expect((r.view[2]!.parts[0] as { output: string }).output).toBe(big(4_000));          // hata aynen
  expect((r.view[5]!.parts[0] as { output: string }).output).toContain(PRUNE_STUB_MARK);
});

test("protectedTools are NEVER pruned (skill_view: the body of the skill the model is following)", () => {
  const history = [
    user("eski"), call("c1", "skill_view"), result("c1", big(4_000)),
    user("orta"), call("c2", "bash"), result("c2", big(4_000)),
    user("yeni"), asst("…"),
  ];
  const r = pruneToolOutputs(history, cfg, tokenText)!;
  expect(r.pruned).toBe(1);
  expect((r.view[2]!.parts[0] as { output: string }).output).toBe(big(4_000));          // skill aynen
  expect((r.view[5]!.parts[0] as { output: string }).output).toContain(PRUNE_STUB_MARK);
});

test("below the minimum gain nothing happens (null) — small histories are never touched", () => {
  const tiny = [user("u"), call("c1", "bash"), result("c1", big(300)), user("u2"), asst("a")];
  expect(pruneToolOutputs(tiny, cfg, tokenText)).toBeNull();         // ~75 token kazanç < 50? sınırda
  const smaller = [user("u"), call("c1", "bash"), result("c1", "kısa"), user("u2")];
  expect(pruneToolOutputs(smaller, cfg, tokenText)).toBeNull();
});

test("min-gain boundary: a real win prunes, an impossible threshold does not", () => {
  // protectTokens: 0 → son tur öncesi her şey eligible; 800 char ≈ 200 token çıktı, stub ~43 token,
  // kazanç ~157 token. Eşik 1 → prune olur; eşik 10_000 → olmaz.
  const mk = (n: number) => [user("eski"), call("c1", "bash"), result("c1", big(n)), user("yeni"), asst("a")];
  const loose: PruneConfig = { ...cfg, protectTokens: 0, minGainTokens: 1 };
  const hit = pruneToolOutputs(mk(800), loose, tokenText);
  expect(hit).not.toBeNull();
  expect(hit!.pruned).toBe(1);
  expect(hit!.tokensFreed).toBeGreaterThan(100);
  const strict: PruneConfig = { ...cfg, protectTokens: 0, minGainTokens: 10_000 };
  expect(pruneToolOutputs(mk(800), strict, tokenText)).toBeNull();
});

test("idempotent: pruning a pruned view finds nothing (stubs are recognized, not re-stubbed)", () => {
  const history = [
    user("eski"), call("c1", "bash"), result("c1", big(4_000)),
    user("orta"), call("c2", "bash"), result("c2", big(4_000)),
    user("yeni"), asst("…"),
  ];
  const once = pruneToolOutputs(history, cfg, tokenText)!;
  const twice = pruneToolOutputs(once.view, cfg, tokenText);
  expect(twice).toBeNull();                                          // stub'lar yeniden stub'lanmaz
});

test("no user message at all (foreign history): the protect walk still applies from the end", () => {
  const history = [
    call("c1", "bash"), result("c1", big(4_000)),
    call("c2", "bash"), result("c2", big(100)),
  ];
  const r = pruneToolOutputs(history, cfg, tokenText);
  expect(r).not.toBeNull();
  expect(r!.pruned).toBe(1);                                         // c1 stub, c2 (küçük, yakın) korunur
  expect(pairsIntact(r!.view)).toBe(true);
});

test("a result that is already small is never stubbed (stub would not pay for its marker)", () => {
  const history = [
    user("eski"), call("c1", "bash"), result("c1", big(4_000)), call("c2", "bash"), result("c2", "küçük çıktı"),
    user("yeni"), asst("…"),
  ];
  const r = pruneToolOutputs(history, cfg, tokenText)!;
  const small = (r.view[4]!.parts[0] as { output: string }).output;   // view[4] = result c2
  expect(small).toBe("küçük çıktı");
});

test("DEFAULT_PRUNE_CONFIG pins the OpenCode-derived defaults", () => {
  expect(DEFAULT_PRUNE_CONFIG.protectTokens).toBe(40_000);           // PRUNE_PROTECT
  expect(DEFAULT_PRUNE_CONFIG.minGainTokens).toBe(20_000);           // PRUNE_MINIMUM
  expect(DEFAULT_PRUNE_CONFIG.protectedTools).toContain("skill_view");
});
