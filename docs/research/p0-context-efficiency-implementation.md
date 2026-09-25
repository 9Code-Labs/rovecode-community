# UYGULAMA-A — Context/Tool-Output Verimlilik P0: Uygulama Raporu

**Tarih:** 2026-09-14 · **Dispatch:** task_763524467f87 / ctx_df04695625d2 · **Kapsam:** docs/research/harness-architecture-research.md'deki G2/G3/G10 ve P0-2/P0-3 (+P0-4); G1 (EMA) bilinçli olarak ertelendi — gerekçe aşağıda.

## Ne yapıldı

### 1. Merkezi ToolOutputBudgetPolicy — `src/core/tool-output-budget.ts` (yeni)

- `createOutputBudget(opts)` → `{ capFor, apply }`; saf çekirdek `applyBudget(output, cap, headShare=0.7)`.
- **≤ cap: byte-verbatim** (değişen hiçbir şey yok — reflection, guardrails, transcript aynı metni görür).
- **> cap: head+tail** (varsayılan %70/%30), arada sayıları ve devam ipucunu taşıyan marker:
  `[…output budget: removed N of M chars (~T tokens) from the middle — re-run the tool with a narrower range/query (read: offset/limit)…]`.
- **UTF-8/grapheme güvenli:** kesim code-point tabanlı; sınır asla surrogate çifti, birleşen im (combining mark) dizisi, ZWJ zinciri veya bayrak çifti (Regional Indicator) ortasına düşmez — düşerse son bütün grafeme geri çekilir.
- `estTokensCut` = loop'un kendi birimi (estimateTokens, chars/4) — raporlanan sayı tetikleyiciyle aynı birimde.
- **Entegrasyon:** `core/loop.ts` batch settle sonrası, store'a yazmadan önce TEK noktadan. `tool_execution_end` event'i ham çıktıyı taşımaya devam eder (yüzey sadakati — belgelenmiş, bilinçli ayrışma). Araç-taraflı daha sıkı cap'ler (bash 10k vb.) aynen kalır — onların çıktısı tavana hiç ulaşmaz.
- `RunConfig.outputBudget?: OutputBudgetOptions | false` (false = kapalı).

### 2. Modelsüz prune ön-aşaması — `src/core/compaction.ts` (`pruneToolOutputs`)

OpenCode `prune` (dev `session/compaction.ts:271-294`, erişim 2026-09-14) + Claude Code auto-compact faz-1 deseni:

- Sondan geriye: **son user turu dokunulmaz** + `protectTokens` (40k, OpenCode PRUNE_PROTECT) kadar araç trafiği korunur; daha eskiler stub'lanır.
- **Muafiyetler:** `ok:false` sonuçlar (hata metni kalır), `protectedTools` (varsayılan `skill_view` — modelin o an izlediği skill gövdesi), zaten-stub olanlar (idempotans), stub'dan kısa çıktılar.
- **Minimum kazanç eşiği:** `minGainTokens` (20k, OpenCode PRUNE_MINIMUM) altında hiçbir şey yapılmaz (null).
- **Stub:** `headChars` (160) kadar baş + `[pruned from context: N chars (~T tokens) removed — the full output is in the session transcript; re-read the file or re-run the tool if you need it]`.
- **Yalnız görünüm:** store asla yeniden yazılmaz (replay/export/trace doğruluğu korunur); stub yerinde durur → çağrı/sonuç çifti asla ayrılmaz (wire well-formedness). Korunan mesajlar referans-eşitliğini korur (`===`).
- **Loop akışı:** prune tetikten ÖNCE koşar; tetik **budanmış görünümü** ölçer → iyi bir prune LLM compaction'ını tamamen önleyebilir (entegrasyon testi: 3×90k seed'li history'de summarizer 0 çağrı). Compaction koşarsa görünüm taze hesaplanır.
- **Event:** mevcut `compaction` RunEvent'i `strategy: "prune"` ile yayınlanır; **`appendEvent` ile kalıcı YAZILMAZ** (kayıt değişmedi — "context-drop" precedenti). OTel bunu span-event olarak otomatik görür.

### 3. Compaction thrash/cooldown — `src/core/compaction.ts` (CompactionPace)

- Saf ledger: `updateCompactionPace(pace, turn, shrankWell, rapidWindow)` — hızlı (≤2 tur arayla) compaction +1 strike, %5'ten az küçülen +1 daha; `COOLDOWN_STRIKES = 3` → run için compaction durur.
- **Tasarım notu:** ilk sürüm "küçülmeyen = +2" idi ve mevcut regresyon testini (tool-result-heavy history) yakaladı: 1-token'lık başın özeti ondan büyük olabiliyor (toy ölçekte %5 gürültü). Strike çifti kuralı bunu düzeltti — gerçek thrash (arka arkaya hızlı + nafile) yakalanır, tek seferlik nafilelik yakalanmaz.
- Cooldown'da emergency → re-drive yerine açık `run_end` error (sağlayıcı metni + thrash notu). Speculative'de ilk seferde bir `strategy: "cooldown"` marker event'i.
- `RunConfig.compactionRapidTurns?: number` (0 = kapalı).

### 4. EMA kalibrasyonu — BİLİNÇLİ olarak dahil EDİLMEDİ (takip maddesi)

G1'in sandığım boşluk zaten kapalıymış: `core/token-scale.ts` ölçülmüş per-nesil faktörler (Claude 5: charScale 1.82, 4.5: 1.46) ve `cli/runtime.ts:659` bütçeyi `charScale`'e **bölerek** düzeltiyor (`contextBudgetFor`, context-report.ts:43). Loop üzerinde çevrimiçi EMA bu statik, max-temelli düzeltmeyle çift-düzeltme riski taşır (aşırı düzeltme → erken compaction → boşa pencere). Güvenli artış şu olur (takip maddesi): tur başına `usage.input+cacheRead+cacheWrite` ile o andaki tahminin oranını OTel attribute'u olarak **yalnızca ölçmek** (davranış değişikliği yok), toplanan veriyle `scripts/measure-tokenizer.ts`'i beslemek. Tahmin uydurulmadı.

## Ölçüm (fixture: 12 tur × 60k-char log çıktısı, ~180k token ham history)

| Senaryo | Token (tahmini, chars/4) | Küçülme |
|---|---|---|
| ÖNCE (ham) | 180.048 | — |
| Yalnız prune (P0-2) | 30.997 (10 stub) | **%83** |
| Yalnız output budget (P0-3) | 98.529 | %45 |
| Budget + prune (gerçek akış) | 33.633 | **%81** |

Ölçüm script'i: geçici dizinde (`measure-p0.ts`) çalıştırıldı; fixture deterministik (sabit uzunluklar).

## Testler

- Yeni: `test/unit/tool-output-budget.test.ts` (11), `test/unit/prune.test.ts` (11), `test/integration/context-efficiency.test.ts` (7).
- İlgili mevcut suite'ler: `compaction.test.ts`, `context.test.ts`, `loop.test.ts`, `loop-gap.test.ts`, `abort.test.ts` — tamamı yeşil (74 test toplu koşuda).
- `tsc --noEmit` temiz.
- Tam suite (`test/unit` + `test/integration`, 2660 test): 2655 pass, 1 skip, **4 fail — hiçbiri bu değişiklikle ilgili değil**: `tui-attach` ×2 (canlı update-check ağı test ortamına sızmış: "update available: 0.3.1 → 0.3.2" notu), `cli-json` "model list --json" (izolasyonda 8.9s sürüyor, 5s timeout'a takılıyor; `bun src/cli/main.ts model list --json` elle çalışıyor ve geçerli JSON üretiyor; dosya şu an B ajanının aktif edit bölgesinde — main.ts/dispatch.ts WIP), `tui-sextant` "gated edit" (izolasyonda geçiyor — yük flake'i).

## Sahipliğe uyum

Dokunulan: `src/core/compaction.ts`, `src/core/tool-output-budget.ts` (yeni), `src/core/types.ts`, `src/core/loop.ts` + yeni test dosyaları. `src/eval/**`, `.github/**`, `src/cli/{help,dispatch,main}.ts`, `test/unit/{help,dispatch}.test.ts` el değmedi. B'nin paralel çalıştığı dosyalarla (eval/*, stuck-detector.ts) çakışma yok. Çalışma ağacındaki yabancı değişiklikler korundu; git mutation yapılmadı.

## Bilinen sınırlar / takip maddeleri

1. EMA kalibrasyonu yok (gerekçe yukarıda) — ölçüm-only telemetri artışı önerilir.
2. Env/CLI yüzeyi (ROVECODE_PRUNE=0 gibi) bağlanmadı — `cli/runtime.ts` bu görevin sahipliğinde değil; RunConfig alanları hazır, wiring tek satır.
3. `tool_execution_end` event'i ham çıktı taşır; store bütçeli taşır. Yüzeylerin ham/bütçeli ayrımını göstermesi isterseniz ayrı iş.
