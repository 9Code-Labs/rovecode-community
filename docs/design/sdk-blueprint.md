# Rovecode Harness SDK — Blueprint

**Tarih:** 2026-09-14 · **Durum:** tasarım önerisi (ADR adayı) · **İlişkili:** `docs/research/harness-architecture-research.md` (Araştırma A), `docs/research/claude-code-harness-ports.md` (Araştırma C), `docs/market.md`, ADR-001 (Effect yok), ADR-003 (tek loop), ADR-009 (subagent), ADR-013 (lane'ler child session'dır)

---

## 0. Vizyon

> **"Harness'ı ürün değil, platform yap."** — Rovecode'un içindeki agent çekirdeği, OpenCode'un `@opencode-ai/sdk`'sı gibi dışa açılan, üzerine başka araçlar (TUI, web panel, CI botu, IDE eklentisi, başka bir CLI) yazılabilen bir SDK olur. Subagent ve workflow orkestrasyonu birinci sınıf API'dir; çalışan her şey **tek bir gözlem yüzeyinden canlı takip edilir**; topluluk kendi plugin'lerini yazar, test eder ve market üzerinden dağıtır.

Kurucu karar: SDK **sıfırdan değil, dışa çevirerek (inside-out)** çıkar. Rovecode'un `src/core`'u zaten harness'ın kendisi; SDK, bu çekirdeğin üzerine stabilize edilmiş bir sözleşme katmanı koyar. Sıfırdan ikinci bir loop yazmak ADR-003'ün ve `tasks.ts`'in "ikinci loop nesli yok" kuralının ihlali olur — yapılmayacak.

---

## 1. Mevcut yapıtaşları (SDK'nın ücretsiz envanteri)

| Parça | Dosya | SDK'daki rolü |
|---|---|---|
| Tek-generator agent loop | `src/core/loop.ts` | `client.session.prompt()` arkasındaki motor |
| Subagent orkestrasyonu | `src/core/orchestrator.ts` (depth≤3, worktree izolasyonu, patch merge-back) | `client.agent.spawn()` |
| Background job'lar | `src/core/tasks.ts` (port #26, FIFO + slot-lending) | `client.task.*` |
| Headless HTTP + SSE | `src/server/http.ts` (port #19, OpenAPI `/doc`) | SDK'nın taşıma katmanı |
| ACP | `src/acp/server.ts` (port #15) | IDE entegrasyon kanalı |
| Plugin paketi | `src/plugins/*` (plugin.json: tools+hooks+commands+skills+MCP, trust digest) | Plugin SDK v1'in temeli |
| Market | `rovecode market` (git/npm install, verify, --json) | Topluluk dağıtım kanalı |
| OTel telemetri | `src/telemetry/*` (port #39) | Gözlem yüzeyinin veri kaynağı |
| Session DAG | `src/core/session.ts` (JSONL + hash chain + rewind) | Zaman yolculuğu / audit API'si |
| İzin/execpolicy/sandbox | `src/core/{tools,execpolicy,executor}.ts` | SDK'nın güvenlik sözleşmesi |

**Dürüst gap listesi** (SDK için eksik olanlar): kalıcı/durable workflow motoru yok (task'lar process-local, tasks.ts bunu bilinçli seçmiş); subagent ağacının canlı görünümü yok (task list var, tree yok); plugin API'si semver'lanmış bir sözleşme değil (PLUGIN_API_VERSION var ama DX katmanı — scaffold, test harness, docs — yok); web tabanlı gözlem yüzeyi yok.

---

## 2. Mimari: üç katman, tek gerçek

```
┌─────────────────────────────────────────────────────┐
│  Yüzeyler: TUI (sextant) · CLI · Web Mission Control │
│  IDE (ACP) · CI botu · topluluk araçları            │
├─────────────────────────────────────────────────────┤
│  @rovecode/sdk (TS client)                          │
│  - yerel mod: core'u doğrudan import eder (in-proc) │
│  - uzak mod: HTTP/SSE konuşur (opencode modeli)     │
│  AYNI interface, iki taşıma — port #19 bunu hazırladı│
├─────────────────────────────────────────────────────┤
│  Çekirdek (src/core): loop · orchestrator · tasks   │
│  · workflow · session · tools · permissions         │
└─────────────────────────────────────────────────────┘
```

- **Tek gerçek:** tüm yüzeyler aynı `RunEvent` akışını tüketir. Yeni bir event tipi eklemek = bütün yüzeylerde görünür. Bu, OpenCode'un "TUI = SDK client" kararının (port #19'da zaten port edilmiş) SDK'ya genellenmesi.
- **İki taşıma, bir sözleşme:** `createClient({ mode: "local", cwd })` ve `createClient({ url: "http://…" })` aynı tipleri döndürür. Testler yerel modda, üretim dağıtımları uzak modda koşar.
- **Sözleşme dosyası:** `src/server/openapi.ts` zaten el-yazması OpenAPI üretiyor; SDK client'ı bu spec'ten **üretilir** (opencode'un yaptığı gibi), elle senkron tutulmaz. Tek kaynak = spec.

---

## 3. SDK API yüzeyi (taslak)

```ts
import { createClient } from "@rovecode/sdk";

const rc = await createClient({ cwd: process.cwd() }); // local; { url } = remote

// — Session: bugünkü serve yüzeyinin SDK hali —
const s = await rc.session.create({ title: "auth refactor" });
for await (const ev of rc.session.prompt(s.id, "refresh token rotation ekle")) { … }

// — Subagent: orchestrator.ts'in dışa açılan hali —
const child = await rc.agent.spawn(s.id, {
  agent: "explore",                 // .rovecode/agents/*.md veya builtin
  goal: "token kullanımını haritala",
  isolation: "worktree",            // none | copy | worktree (ADR-009)
});
const tree = await rc.agent.tree(s.id);   // ← canlı subagent ağacı (yeni)

// — Workflow: yeni motor (§4) —
const wf = await rc.workflow.run(deployFlow, { env: "staging" });
await rc.workflow.wait(wf.id, { timeout: "10m" });

// — Task (background job): tasks.ts'in hali —
const t = await rc.task.start(s.id, { label: "testleri düzelt", goal: "…" });

// — İzinler: insan onayını SDK'ya taşımak (bugün serve policy-only) —
rc.onApproval(async (req) => await askMyUi(req));  // approval callback kanalı
```

**Yeni kanallar (SDK için gereken çekirdek ekleri):**
1. **`rc.agent.tree`** — spawn eden parent id'lerinden bir ağaç; her düğüm `{ id, agent, goal, status, depth, usage, currentTool }`. Veri zaten var (orchestrator SpawnContext + tasks TaskInfo), eksik olan tek şey **birleşik canlı görünüm event'i**: `RunEvent`'e `agent_tree_update` eklenir.
2. **Approval callback kanalı** — `serve`'in "v1 approvals are policy-only" notu SDK için yeterli değil; SSE üzerinden `approval_request` event'i + `POST /session/:id/approval` yanıtı. Mevcut `ApprovalFn` zaten bu şekil; eksik olan HTTP tarafı.

---

## 4. Workflow motoru (yeni — en büyük yapı)

**İlham matrisi:** OpenCode (yok) · Claude Agent SDK (subagent zincirleri, docs · B) · Temporal/Restate (durability felsefesi, uzak ilham) · rovecode tasks.ts (slot-lending FIFO) · goose recipes (B) · Codex `SessionTask` modeli (A — "her iş bir task").

**Tasarım kararları:**
- **Workflow = yeni bir loop DEĞİL.** Bir workflow step'i, `agentLoop`'u `runChild` üzerinden çağıran bir düğümdür (ADR-003/ADR-013 korunur). Motor sadece graf yürütür: bağımlılık çözümü, fan-out/fan-in, retry, insan kapısı.
- **Tanım TS'dir, JSON değil** (plugin SDK ile aynı dil; typecheck bedava). JSON serileştirme durum kaydı için kullanılır:

```ts
// .rovecode/workflows/release.ts
import { defineWorkflow } from "@rovecode/sdk/workflow";

export default defineWorkflow({
  name: "release",
  steps: {
    test:    agentStep({ agent: "tester", goal: "testleri koştur, kırıkları düzelt" }),
    review:  agentStep({ agent: "reviewer", goal: "diff'i gözden geçir", after: ["test"] }),
    approve: humanGate({ prompt: "merge onayı", after: ["review"] }),   // SDK approval kanalı
    deploy:  parallel([agentStep({…}), agentStep({…})], { after: ["approve"], failFast: true }),
  },
  retry: { maxAttempts: 2, backoff: "exponential" },   // step başına override edilebilir
  budget: { maxCostUsd: 2.0 },                          // run-limits.ts dilini workflow'a taşır
});
```

- **Durability seviyesi bilinçli olarak "crash-safe, DB'siz":** her step geçişi `.rovecode/workflows/<run-id>.jsonl`'e append edilir (session.ts'in hash-chain fikrinin küçük kardeşi); process ölürse `rc.workflow.resume(runId)` son tamamlanmış step'ten devam eder. Tam Temporal-style event-sourcing değil — tek geliştirici aracı için checkpoint-resume yeterli; tasks.ts'in "deliberately non-durable" kararı workflow'da gevşer çünkü workflow'nun varoluş sebebi uzun iş.
- **İptal semantiği:** port #21'in mid-turn cancellation'ı step'e taşınır — bir step'i iptal etmek child session'ı iptal eder; workflow iptali açık step'leri iptal edip tamamlanmışları korur (resume edilebilir kalır).
- **Event'ler:** `workflow_started · step_started · step_done{summary,usage,cost} · step_failed · gate_waiting · workflow_done` — hepsi `RunEvent` ailesine, yani her yüzeyde bedava görünür.

---

## 5. Gözlem yüzeyi — "Mission Control" (görsel takip)

Kullanıcı isteğinin kalbi: çalışan işler **bir yerde, canlı, gözle görülür** olacak. Üç katman, hepsi aynı event akışından beslenir:

### 5a. TUI paneli (sextant'a yeni yüzey)
- Sextant cell-buffer mimarisine (port #38+) bir **"agents" cell'i**: subagent ağacı + task kuyruğu + workflow step'leri tek ağaçta. Her satır: `▸ reviewer (worktree, depth 1) — grep çalışıyor · 12k tok · $0.03`. Renk = durum (queued gri / running mavi / done yeşil / failed kırmızı / gate sarı yanıp söner).
- `Ctrl+A` (veya `/agents`) ile odak; bir düğüme Enter = o child session'ın transcript'ine inmek (session DAG zaten saklıyor).

### 5b. Web dashboard (`serve`'e statik rota)
- `GET /ui` — tek dosyalık, bağımsız HTML+JS (build adımı yok; `serve`'in el-yazması OpenAPI geleneğine uygun). SSE stream'ine bağlanır; ağaç görünümü + workflow timeline (Gantt-benzeri yatay bar) + cost sayacı.
- Loopback-only default (port #19 kararı korunur); token'lı açma `ROVECODE_SERVE_TOKEN` ile.

### 5c. Makine akışı
- `rc.events.subscribe()` (SDK) ve mevcut `--output ndjson` — CI'da workflow ilerlemesini izleyen script'ler için. OTel span'ları (port #39) workflow step'lerini de kapsar: `workflow.step` span'i, parent = `workflow.run`.

**Kural:** Üç yüzey de render-only'dir. Durum tek yerde (çekirdek) tutulur; panel kapanıp açılınca hiçbir şey kaybolmaz. Bu, TUI'yı da bir SDK client'ı yapan port #19 disiplininin devamı.

---

## 6. Plugin SDK — topluluk yazabilirliği

Mevcut: `plugin.json` manifesti, tools+hooks+commands+skills+MCP katkısı, trust digest, `rovecode market`. Eksik: **geliştirici deneyimi**.

1. **`rovecode plugin init <ad>`** — scaffold: manifest + örnek tool + örnek hook + test dosyası + README şablonu, tek komutta.
2. **Tipleme paketi `@rovecode/plugin-api`** — `PluginCtx`'in (load.ts) stabilize edilmiş alt kümesi; `PLUGIN_API_VERSION` semver vaadiyle. Plugin yazarı çekirdek içini import edemez, sadece bu paketi görür — kırılma yüzeyi daralır.
3. **Test harness'ı `rovecode plugin test`** — plugin'i sahte runtime'da (mockStream + tmpdir cwd) koşturur; plugin yazarının kendi loop'unu bilmesine gerek kalmaz. Gauntlet'in mini hali, plugin'lere özel.
4. **Hot reload (dev modu):** `rovecode --dev .` plugin'i her dosya değişiminde yeniden yükler; trust digest dev modunda gevşer (sadece localhost, açık uyarı).
5. **Güvenlik:** trust modeli korunur (digest değişince yeniden onay). Yeni: **izin beyanı** — manifest'e `permissions: ["shell.exec", "net.fetch"]` alanı; plugin'in tool'ları bu beyanın dışına çıkarsa policy adımında reddedilir (evaluatePermissions'a plugin-scope prefix'i olarak oturur). Beyan `rovecode market info`'da görünür — kullanıcı kurmadan önce neye yetki verdiğini okur.
6. **Market keşfi:** `market verify` zaten var; üzerine **imza/rozeti** (opsiyonel, fasıl 4) — doğrulanmış plugin'ler listede rozetlenir.

---

## 7. Faz planı — DURUM (2026-05 güncellemesi)

| Faz | Durum | Ne çıktı |
|-----|-------|----------|
| **F1 — Sözleşme** | ✅ tamam | `src/sdk/client.ts` (`createClient`: session/prompt events/task/agent tree, `stream:null` → error run_end), `src/sdk/index.ts`, `agentTree` mapper; `TaskInfo.parent` (`opts.caller`'dan). 5 test yeşil. RunEvent'e dokunulmadı — SDK kendi `SdkEvent` union'ında `agent_tree_update`'i sentezler |
| **F2 — Gözlem** | ✅ web tamam; sextant hücresi açık | `GET /events` (global SSE bus: run_event + agent_tree_update + session_created), `GET /ui` tek-dosya dark dashboard (`src/server/dashboard.ts`), prompt event'leri bus'a tap'lenir. 23 server testi yeşil. sextant "agents" cell'i hâlâ yapılacak (stretch) |
| **F3 — Workflow** | ✅ engine + CLI tamam; SDK `rc.workflow` açık | `src/workflow/engine.ts` (`defineWorkflow` validasyonu: cycle/unknown-dep tanım anında; DAG scheduler, retry, gate, token budget, maxConcurrency; JSONL checkpoint + `resumeWorkflow`), `rovecode workflow run/list`. Step'ler `TaskManager.start` üzerinden → Mission Control ağacında otomatik görünür. 8 test yeşil |
| **F4 — Topluluk** | ✅ çekirdek tamam; paket + hot-reload açık | `rovecode plugin init` (manifest+entry+test+README scaffold), `rovecode plugin test` (manifest doğrulama + kuru aktivasyon + plugin.test.ts koşusu), manifest `permissions` alanı: parse + `plugin show` görünümü + `load.ts`'te execute-öncesi enforcement (beyan dışı kind-aksiyonu reddedilir). 2 test yeşil. `@rovecode/plugin-api` paketi ve hot-reload hâlâ açık |

Her faz bağımsız shippable; F2, F3'ten önce değer üretir (subagent görünürlüğü workflow'suz da istenen şey).

## 8. Bilinçli dışlananlar

- **Effect/RxJS akış kütüphaneleri** — ADR-001; event akışı `AsyncGenerator<RunEvent>` kalır.
- **Tam durable execution (Temporal sınıfı)** — F3'ün checkpoint-resume'u üstüne ancak gerçek ihtiyaç kanıtlanırsa.
- **Uzaktan plugin kodu çalıştırma (server-side plugins)** — trust modelini kırar; plugin'ler her zaman client tarafında.
- **Çok-kullanıcılı serve** — loopback + tek kullanıcı; multi-tenant başka bir ürünün problemi.
