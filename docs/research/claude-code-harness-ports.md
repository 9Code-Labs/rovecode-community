# Araştırma C — Claude Code Harness Envanteri ve Aday Portlar

**Tarih:** 2026-09-14 · **Kapsam:** Claude Code harness'ının rovecode'a port adayı olarak incelenmesi · **İlişkili:** `docs/research/harness-architecture-research.md` (Araştırma A, 14 boyutlu matris — Claude Code sütunu bu çalışmanın ön-taramasıdır)

---

## 0. Kanıt disiplini ve lisans sınırı

Claude Code **proprietary**'dir; kaynak kodu yayınlanmamıştır. Bu yüzden:

- **Hiçbir kod port edilemez ve edilmeyecektir.** THIRD_PARTY_NOTICES.md'deki "No code originates from … the Claude Agent SDK" cümlesi bu çalışmayla da korunur; Claude Code'un kendisi için de aynı duruş geçerlidir (notices'a eklendi).
- Kanıt seviyesi en fazla **B** = resmi doküman (code.claude.com/docs). Docs'ta olmayan davranış tahmin edilmedi, reverse-engineering çıktıları (blog sızıntıları, decompile yazıları) kanıt olarak kullanılmadı.
- Port adaylarının tamamı **PATTERN LEVEL**'dir: davranış spec'i docs'tan, uygulama rovecode'un kendi kodu. Bu, codex port #10/#21/#27 ile aynı yöntem.
- rovecode tarafındaki "mevcut durum" iddiaları repo kaynağından okundu (**A**, dosya:satır).

Numaralandırma: mevcut son port #44 olduğundan adaylar **#45+** ile işaretlendi. Bir numara, uygulanana kadar "aday"dır; uygulananlar notices'a taşınır.

---

## 1. Envanter → rovecode karşılığı

Lejant: ✅ rovecode'da karşılığı var · ◐ kısmi · ❌ gap.

| # | Claude Code özelliği (docs · B) | rovecode karşılığı (A) | Durum |
|---|---|---|---|
| 1 | CLAUDE.md hafıza hiyerarşisi: managed (IT politikası) > user `~/.claude/CLAUDE.md` > project `./CLAUDE.md` > local | `src/core/config.ts` (port #8): cwd-yukarı AGENTS.md/CLAUDE.md/GEMINI.md hasadı, yakın-kazanır gölgeleme; user-tier ve managed-tier yok | ◐ |
| 2 | `@path` import'ları (maks 4 derinlik, kod blokları hariç tutulur, dışa import ilk seferde onay ister) | config.ts'de import yok; dosyalar düz okunur | ❌ |
| 3 | `.claude/rules/` yol-kapsamlı kurallar | config.ts `.cursor/rules/*.mdc`'yi düz metin hasat eder (frontmatter strip, eylem yok); yol-kapsamı yok | ◐ |
| 4 | Auto memory (modelin kendi yazdığı MEMORY.md, ilk 200 satır/25KB yüklenir) | `src/memory/blocks.ts` + memory_edit/recall tool'ları — daha zengin bir mekanizma, farklı felsefe | ✅ |
| 5 | İzin kuralları: allow/ask/deny, öncelik **deny > ask > allow** (sabit), 6 izin modu, managed settings ile kilitlenebilir | `src/core/settings.ts` + execpolicy: deny-default + **last-match** (kural sırası belirler); 3 seviye (ask/accept-edits/auto) | ◐ |
| 6 | Hook'lar: settings.json'da **shell komutu** olarak tanımlanır (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop…); prompt/agent tipi hook'lar | `src/core/hooks.ts`: TS plugin hook'ları (pre_run/post_run/pre_tool/post_tool/approval/compaction/session_open/session_close/on_event), izole + timeout'lu. Shell-komut hook'u yok | ◐ |
| 7 | Auto-compact: **faz 1** eski tool çıktılarını temizler, **faz 2** özet; thrash koruması (birkaç denemede hemen doluyorsa hata verip durur); `/compact <odak>` ile yönlendirme; CLAUDE.md "Compact Instructions" bölümü | `src/core/compaction.ts`: 3 strateji (head-summarize/keep-window/provider-native seam) + speculative/emergency çift tetik. Tool-çıktısı temizleme fazı yok (Araştırma A P0 gap #2, OpenCode `prune`); thrash koruması yok; odak talimatı yok | ◐ |
| 8 | Plan modu + Plan subagent (read-only araştırma, ana bağlamı kirletmez) | Plan/Act (port #20, cline) + plan reminder + verify gate. Read-only plan subagent yok — runChild senkron ve genel amaçlı | ◐ |
| 9 | Subagent'ler: `.claude/agents/*.md` + frontmatter, Agent tool, context fork seçeneği | `src/core/orchestrator.ts`: senkron runChild + FIFO task queue (depth≤3, worktree izolasyonu). Dosya-tanımlı agent yok | ◐ |
| 10 | MCP tool'ları varsayılan **deferred**; tool search ile gerektiğinde yüklenir | MCP lazy-disclosure var (Araştırma A boyut 13, ✅) | ✅ |
| 11 | Headless: `-p` + `--output-format json/stream-json`, script'lenebilir | `rovecode run --output text|json|ndjson` + stdout guard (port #35) + `serve` (HTTP/SSE). Daha geniş | ✅ |
| 12 | Session resume/continue/fork + file-snapshot checkpoint, `/rewind` | JSONL DAG + hash chain + leaf rewind + shadow-git (port #11, cline) | ✅ |
| 13 | Slash komutları: `.claude/commands/*.md` kullanıcı tanımlı | `src/tui/commands.ts` builtin set + expandSlashPrompt; kullanıcı tanımlı komut dosyası yok | ◐ |
| 14 | OTel telemetri (monitoring-usage) | OTel span'ları (port #39) + usage/cost muhasebesi | ✅ |

**Özet:** 14 boyutun 5'i tam karşılıklı (rovecode bazılarında daha ileri: headless, checkpoint, telemetri). Gap'ler dört kümeye toplanıyor: **context dosyası zenginliği** (1-3), **compaction faz-1 + thrash** (7), **kural önceliği semantiği** (5), **dosya-tanımlı kullanıcı genişletilebilirliği** (9, 13).

---

## 2. Aday portlar (öncelik sıralı)

### Port #45 (aday) — Auto-compact faz 1: eski tool çıktılarını özet öncesi temizle + thrash koruması
**Docs davranışı (B):** Context dolarken auto-compact önce eski tool çıktılarını temizler; yetmezse konuşma özetlenir. Birkaç compaction denemesi sonrası context hemen yeniden doluyorsa döngü "thrashing" hatasıyla durur — sonsuz compact döngüsü yoktur.
**Neden bu, OpenCode `prune` portundan önce:** Araştırma A P0 gap #2'yi OpenCode üzerinden işaretledi ama Claude Code docs'u aynı davranışı **strateji-bağımsız bir faz** olarak tarif ediyor (önce temizle, sonra özetle). rovecode'un mevcut 3 stratejisinin (`compaction.ts`) hepsinin önüne tek bir faz olarak oturur; OpenCode portu gelirse de bu faza kovuşur, çakışmaz.
**Rovecode'a oturuş:** `compaction.ts`'de plan hesaplanmadan önce "tool-output temizliği tek başına bütçeyi kurtarıyor mu?" kontrolü; kurtarıyorsa LLM çağrısı yapılmaz (ücretsiz compaction). Thrash sayacı: N=3 ardışık acil compaction'da pencere hâlâ doluysa run `stopReason` ile biter, istisna yok (loop.ts hata modeliyle uyumlu).
**Sınır:** Yerinde silme yok (OpenCode `prune`'un yaptığı); rovecode'da bu ilk faz serileştirme anında placeholder'a çevirme olmalı — session DAG'ı (hash chain) bozulmaz.

### Port #46 (aday) — İzin kuralı önceliği: deny > ask > allow (sabit sıra)
**Docs davranışı (B):** Çakışan kurallarda deny her zaman kazanır; sonra ask; allow en sondur. Kullanıcı "allow yazdım ama deny vardı" sürprizi yaşamaz.
**Mevcut (A):** rovecode'da last-match kazanır (`src/core/tools.ts` policy adımı; hooks.ts:29 "deny-default, last-match"). Last-match, execpolicy'nin (port #9, codex) strictest-wins'iyle zaten birlikte çalışıyor ama settings.ts tarafındaki kullanıcı kuralları için sabit öncelik yok.
**Karar noktası:** Codex-port'u execpolicy tarafında bilinçli olarak strictest-wins zaten; settings kurallarında last-match'ten sabit-sıraya geçiş **davranış değişikliği**dir — mevcut kullanıcı kurallarının anlamını değiştirir. Öneri: deny her zaman kazanır (güvenlik, tartışmasız); ask/allow arasında last-match korunur (geri uyum). Yani "yarım port": **deny > (last-match ask/allow)**.

### Port #47 (aday) — `@path` import + Compact Instructions
**Docs davranışı (B):** CLAUDE.md içinde `@docs/kurallar.md` satırı dosyayı import eder; maks 4 derinlik; kod bloklarındaki `@` tetiklenmez; proje dışına import ilk seferde onay ister. CLAUDE.md'deki "Compact Instructions" bölümü auto-compact özetini yönlendirir.
**Rovecode'a oturuş:** `src/core/config.ts` hasadında dosya okunduktan sonra tek geçişlik import çözümleme; derinlik ve fence koruması docs'a sadık. Onay diyaloğu yerine rovecode'un mevcut dili: proje dışı import **sessizce atlanır ve `skippedFiles`'a neden yazılır** (config.ts zaten drop'ları sayıyor) — CLI'de interaktif onay yoktur, voice.ts ile tutarlı. Compact Instructions, #45'in faz-2 özet çağrısına ek sistem satırı olarak girer.

### Port #48 (aday) — Shell-komut hook'ları (settings.json)
**Docs davranışı (B):** Hook'lar TypeScript değil, herhangi bir dilde shell komutudur; event JSON'u stdin'e verilir, exit code + stdout ile karar döner.
**Mevcut (A):** hooks.ts yalnızca TS plugin set'i kabul eder — rovecode'u genişletmek isteyen bir kullanıcı TS yazmak zorunda.
**Rovecode'a oturuş:** `.rovecode/hooks.json` (project) — event adı → komut satırı. HookRunner'a "process hook" sarmalayıcısı: mevcut izolasyon + timeout (`hooks.ts` bunu zaten uyguluyor) aynen geçerli; execpolicy'nin onay merdivenine **girmez** (hook zaten kullanıcının kendi config'i, codex-port'u mantığı) ama `pre_tool`'un deny yetkisiyle sınırlı kalır — hook "un-deny" edemez kuralı (hooks.ts:29) korunur.
**Risk:** Orta. Hook'ların çalıştırılması spawn demek; sandbox merdiveniyle (port #10/#27) etkileşimi tasarlanmalı — hook her zaman `direct` rung'da koşar, sandbox'a sokulmaz.

### Port #49 (aday) — Dosya-tanımlı slash komutları (`.rovecode/commands/*.md`)
**Docs davranışı (B):** `.claude/commands/review.md` → `/review`; dosya gövdesi prompt şablonudur, `$ARGUMENTS` yer tutucusu doldurulur.
**Rovecode'a oturuş:** `expandSlashPrompt` (tui/commands.ts) zaten builtin komutları prompt'a çeviriyor — aynı yere dosya-tanımlı komutlar için bir lookup eklenir; builtin ile çakışmada **builtin kazanır** (kullanıcı komutu `/review.md` değil `/user:review` gibi ad alanına gerek kalmadan, gölgeleme yerine reddedilir ve stderr'e not düşer — plugin tool çakışmasındaki "refused" diliyle aynı, main.ts cmdTools).
**Öncelik gerekçesi:** Düşük maliyet, yüksek hissedilir değer; ama #45/#46'dan sonra.

### Port #50 (aday) — Plan subagent (read-only araştırma, context-fork)
**Docs davranışı (B):** Plan modunda araştırma ayrı bir subagent'a devredilir; ana konuşma bağlamı keşif okumalarıyla kirlenmez.
**Mevcut (A):** runChild senkron ve genel amaçlı (orchestrator.ts); plan modu (port #20) ana bağlamda çalışır, plan reminder enjekte edilir ama okuma yükü ana history'ye yazılır.
**Karar:** **Şimdilik port edilme** — beklemede. Gerekçe: rovecode'un plan reminder + verify gate ikilisi rakiplerde olmayan bir fark (Araştırma A §4.7) ve plan bağlam kirliliği sorunu #45 (faz-1 temizlik) ile kısmen çözülüyor. Gerçek bir "plan bağlamı şişmesi" vakası ölçülmeden subagent ayrımı erken optimizasyon. Araştırma A'nın P2 sınıfına.

---

## 3. Bilinçli olarak alınmayanlar

- **6 izin modu:** rovecode'un 3 seviyesi (ask/accept-edits/auto) + plan modu, Claude Code'un 6 modunun kapsadığı alanın pratikte tamamını veriyor; mod sayısı çoğaldıkça voice.ts'in "iki izin modunu ekran adıyla an" kuralı zorlanır.
- **Managed/IT policy katmanı:** rovecode tek-geliştirici aracı; managed settings kurumsal dağıtım senaryosu. İhtiyaç doğana kadar YAGNI — ama #46'nın deny-önceliği bu katman gelirse hazır zemin olur.
- **Output styles / status line:** kozmetik; sextant TUI'nin (port #38+) kendi tasarım dili var.
- **Auto-memory MEMORY.md:** rovecode'un BlockStore'u daha yetenekli; Claude Code'un 200-satır/25KB kesme kuralı geriye gidiş olur.

---

## 4. Uygulama sırası önerisi

1. **#45** — P0 gap'i kapatıyor, maliyet/etki oranı en iyi
2. **#46** — küçük diff, güvenlik semantiği netleşiyor
3. **#47** — #45'in yönlendirme yarısıyla birlikte
4. **#49** — bağımsız, hızlı kazanç
5. **#48** — sandbox etkileşimi tasarımı istiyor
6. **#50** — ölçüm sonrası karar
