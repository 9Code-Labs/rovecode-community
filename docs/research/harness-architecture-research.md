# Araştırma A — Coding-Agent Harness Mimarisi ve Ajan Döngüsü

**Tarih:** 2026-09-14 · **Kapsam:** Nimbus/rovecode'u mükemmel seviyede bir coding-agent harness'e dönüştürmek için kanıta dayalı karşılaştırmalı araştırma · **Yazar:** Araştırma-A (Orca dispatch `task_9b3f629fd00b`) · **Eş araştırma:** Araştırma-B (eval/güvenilirlik/güvenlik) — `docs/research/harness-evals-safety-research.md`

## Kanıt disiplini

Her önemli iddia şu üçlüyle işaretlenir: **(URL · erişim 2026-09-14 · güven seviyesi)**.
Güven seviyeleri: **A** = birincil kaynak kod okundu (dosya:satır), **B** = resmi doküman okundu, **C** = ikincil kaynak (blog/paper/issue), **D** = çıkarım/tahmin. Claude Code proprietary olduğundan iç detaylarında yalnızca resmi docs kullanıldı; docs'ta olmayan hiçbir şey tahmin edilmedi. Nimbus/rovecode iddiaları doğrudan bu repo'nun kaynağından okundu (**A**, dosya:satır).

---

## 1. Yönetici özeti

10 açık/belgeli harness (OpenCode, Codex CLI, Claude Code, aider, Cline, Roo Code, Continue, SWE-agent/mini-swe-agent, OpenHands, goose) ve pi/oh-my-pi incelendi; rovecode'un mevcut mimarisi 14 boyutta bunlarla karşılaştırıldı. Rovecode şaşırtıcı derecede ileride: tek-generator agent loop, üç stratejili adaptif compaction, hash-zincirli session DAG, execpolicy + deny-default izinler, shadow-git checkpoint, OTel telemetri — bunların çoğu rakiplerde ya yok ya da daha yeni geldi. Buna karşılık dört **P0** gap var: (1) token estimatoru Anthropic tarafında ~%36 düşük okuyor ve compaction tetigi buna bağlı (repo'nun kendi `docs/context.md`'si itiraf ediyor); (2) OpenCode'un `prune` mekanizması (eski tool çıktılarını model çağırmadan yerinde silme) rovecode'da yok; (3) tool-result truncation araç-bazlı sabitler, birleşik bütçe politikası yok; (4) provider-native compaction seam'i (Codex `RemoteCompactionSupport::V2`, Anthropic context-editing) boşta. 30/60/90 günlük yol haritası §9'da.

---

## 2. Yöntem

1. **Birincil kaynak taraması:** GitHub kaynak kodu (OpenCode `dev` dalı, Codex `main` dalı) + resmi doküman siteleri (docs.claude.com/code.claude.com, developers.openai.com/codex, aider.chat, docs.cline.bot, docs.roocode.com, swe-agent.com, docs.openhands.dev, goose-docs.ai, pi.dev/pi-mono README).
2. **Nimbus/rovecode salt-okunur inceleme:** `src/core/{loop,compaction,context,tools,session,orchestrator,guardrails,execpolicy,hooks,reflection,tasks,verify*}.ts`, `src/providers/*`, `src/coding/*`, `src/mcp/*`, `src/telemetry/*`, `src/cli/runtime.ts`, README.md, docs/*.
3. **Eş-araştırmacı protokolü:** Orca orchestration üzerinden Araştırma-B ile status/kritik alışverişi (§10).

---

## 3. Karşılaştırma matrisi (14 boyut)

Lejant: ✅ tam/olgun · ◐ kısmi · ❌ yok · ? = doğrulanamadı. Ayrıntılar §4'te, kanıtlar §11'de.

| Boyut | rovecode | OpenCode | Codex CLI | Claude Code | aider | Cline | Roo Code | OpenHands | goose | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. Agent loop / state machine | ✅ tek generator, event stream | ✅ session processor + Event/V2 (Effect'e göçte) | ✅ Task tabanlı (Regular/Compact/Review/UserShell) | ✅ "gather→act→verify" döngüsü (docs) | ◐ imperative loop (base_coder) | ✅ task loop (webview) | ✅ Cline tabanı + modlar | ✅ stateless step(), event-driven | ✅ Rust loop | ✅ minimal loop |
| 2. Context compaction | ✅ 3 strateji + speculative/emergency | ✅ prune + summarize + dedicated compaction agent | ✅ local summary + **remote (provider-native) V2** + token-budget deneysel | ✅ auto-compact: önce tool-output temizliği, sonra özet; thrash koruması | ◐ history.py head/tail özet | ◐ sliding window + manuel | ✅ intelligent condensing (eşik slider, custom prompt) | ✅ Condenser ailesi (NoOp/LLM/Rolling/Pipeline) | ◐ (doğrulanmadı detay) | ✅ eşik+rezerv token, split-turn, branch summary |
| 3. Prompt layering | ✅ system + profil + design + skills/bellek index + ADR-007 chunk önceliği | ✅ AGENTS.md + rules + per-agent prompt | ✅ AGENTS.md + instructions | ✅ CLAUDE.md hiyerarşisi (managed/user/project/local) + @import + .claude/rules + auto-memory | ◐ conventions dosyaları | ✅ .clinerules + memory bank | ✅ custom instructions + .roo rules | ✅ microagents + skills (AgentContext) | ✅ .goosehints/AGENT.md | ✅ context files + prompt templates |
| 4. Tool protocol | ✅ registry, schema validate, batch paralel | ✅ tool registry + per-agent izin | ✅ native tool calls + unified exec | ✅ zengin builtin set + Agent/AskUserQuestion | ◐ edit-format metin protokolü | ✅ XML tool çağrıları | ✅ Cline XML + mode-bazlı tool kısıtı | ✅ typed Action→Observation | ✅ MCP-native (extension=tool) | ✅ read/write/edit/bash minimal |
| 5. Tool-result truncation | ◐ araç-bazlı sabitler (bash 10k, MCP cap, webfetch cap) | ✅ prune (40k koruma/20k min) + serileştirmede 2k | ◐ fixed caps (kaynak: output truncation util'leri) | ✅ "önce eski tool çıktılarını temizle" (auto-compact faz 1) | ◐ repomap token bütçesi | ◐ bilinen limitler (doğrulanmadı) | ◐ condensing öncesi | ✅ observation truncation | ? | ◐ (detay doğrulanmadı) |
| 6. Repo discovery / indexing | ✅ repomap (tree-sitter + PageRank) + LSP tanıları | ◐ LSP + file tools | ◐ exec + search | ◐ Explore subagent + code-intel pluginleri | ✅ repomap (orijinal) | ◐ workspace tracking | ✅ **codebase indexing (embeddings)** | ◐ yok (runtime'a bırakılmış) | ❌ | ❌ (bilinçli minimalizm) |
| 7. Planning vs execution | ✅ Plan/Act modları + plan reminder + verify gate | ✅ plan agent (izin-kısıtlı primary) | ◐ plan onay akışı (approvals) | ✅ plan modu + Plan subagent | ✅ architect mode | ✅ Plan/Act | ✅ modlar (code/architect/ask/debug/custom) | ◐ goal completion loop (deneysel) | ◐ recipe'ler | ❌ (bilinçli: paketle eklenebilir) |
| 8. Subagents | ◐ senkron runChild + FIFO task queue (depth≤3, worktree izolasyonu) | ✅ task tool + primary/subagent ayrımı + gizli sistem ajanları | ✅ varsayılan açık, paralel, `/agent` thread'leri, custom agent | ✅ .claude/agents MD+frontmatter, fork seçeneği, Agent tool, background agents | ❌ | ✅ subagents + agent teams (CLI) | ✅ Boomerang Tasks (new_task) | ✅ task tool set + file-based agents | ◐ lead/worker (doğrulanmadı) | ❌ (bilinçli yok) |
| 9. Checkpoints / resume | ✅ JSONL DAG + hash chain + leaf rewind + shadow-git checkpoint | ✅ session storage + revert | ✅ rollout + resume | ✅ JSONL transcript + file snapshot checkpoint + fork/branch | ◐ git auto-commit + /undo | ✅ shadow-git checkpoint (3 restore modu) | ✅ checkpoints | ✅ conversation persistence | ◐ session resume | ✅ JSONL tree + /tree branch |
| 10. Permissions / sandbox | ✅ deny-default kurallar + execpolicy + 3 seviye + sandbox merdiveni (direct/WSL2/Docker) | ✅ allow/ask/deny + per-agent + `--auto` | ✅ OS-sandbox (read-only/workspace-write/full) + approval policy + execpolicy + ağ proxy kuralları | ✅ allow/ask/deny (deny>ask>allow) + 6 mod + auto-mode sınıflandırıcı + managed settings | ◐ --yes, auto-commit | ✅ auto-approve matrisi + YOLO | ✅ auto-approval ayarları | ✅ confirmation policy + security analyzer + Docker runtime | ◐ tool confirmation (detay doğrulanmadı) | ◐ komut onayı (detay doğrulanmadı) |
| 11. Streaming / TUI | ✅ sextant cell-buffer TUI + klasik REPL + HTTP/SSE + ACP | ✅ client/server (TUI = SDK client), SSE | ✅ ratatui TUI + app-server | ✅ terminal + IDE + desktop + web + SDK | ◐ CLI | ✅ VS Code webview + CLI/TUI/Kanban | ✅ VS Code webview | ✅ web SPA + CLI + ACP | ✅ desktop + CLI + API | ✅ TUI + RPC + SDK + print/JSON |
| 12. Model/provider abstraction | ✅ 2 protokol adaptörü + role router + fallback chain + models.dev katalog | ✅ provider registry + models.dev | ✅ model provider config + wire API | ◐ Anthropic + Bedrock/Vertex/Foundry | ✅ litellm-benzeri geniş destek | ✅ 30+ provider | ✅ çok provider | ✅ litellm | ✅ 15+ provider | ✅ geniş provider + subscription login |
| 13. MCP / skills / hooks | ✅ MCP lazy-disclosure + SKILL.md + hooks v2 (izole, timeout'lu) + plugin manifest | ✅ MCP + skills + plugin (JS) + custom tools | ✅ MCP + skills + AGENTS.md; hook'lar sınırlı | ✅ MCP (tool search ile lazy) + skills + hooks (shell/prompt/agent) + plugin marketplace | ❌/◐ | ✅ MCP marketplace + skills + SDK plugin hook'ları | ✅ MCP + skills | ✅ MCP + skills + lifecycle hooks | ✅ MCP-native extensions + recipes | ✅ extensions (TS) + skills + prompt templates |
| 14. Telemetry | ✅ OTel span'ları (run/turn/tool) + usage/cost muhasebesi | ◐ (istatistikler) | ✅ codex_otel metrikleri (TURN_E2E, tool call, memory) | ✅ OTel (monitoring-usage) | ◐ analytics (opt-in) | ✅ OTel (enterprise) | ◐ | ✅ OTel tracing + metrics | ◐ diagnostics | ◐ (session paylaşımı HF) |

---

## 4. Boyut-boyut bulgular (kanıtlı)

### 4.1 Agent loop / state machine

- **Codex CLI**: döngü "session task"ları olarak modellenmiş: `RegularTask`, `CompactTask`, `ReviewTask`, `UserShellCommandTask`; her biri `SessionTask` trait'ini uygular; iptal `CancellationToken` + `abort_turn_if_active`, 100 ms graceful-interrupt zaman aşımı (`GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100`). Çok-ajanlı protokol versiyonlanmış (`MultiAgentVersion::V2` interrupt marker'ı developer-role mesajı üretir). (raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tasks/mod.rs · 2026-09-14 · **A**)
- **OpenHands (V1 SDK)**: agent **stateless**; her `step()` bir akıl yürütme döngüsü: bekleyen aksiyonlar → condenser → LLM sorgusu → (context aşımıysa `CondensationRequest` eventi yayınla) → tool çağrıları `ActionEvent` → icra → `ObservationEvent`. Onay gerekiyorsa durum `WAITING_FOR_CONFIRMATION`. (docs.openhands.dev/sdk/arch/agent.md · 2026-09-14 · **B**)
- **Claude Code**: docs döngüyü üç faz olarak tanımlar — gather context / take action / verify results; kullanıcı her an kesip yönlendirebilir. (code.claude.com/docs/en/how-claude-code-works.md · 2026-09-14 · **B**)
- **rovecode**: tek `async function* agentLoop` (`src/core/loop.ts:84`); steering drain model-öncesi, follow-up drain turn-sonu; hatalar istisna değil `stopReason`; run başına tek `AbortController` hem provider fetch'e hem `ToolContext.signal`'e hem child process'lere identity ile ulaşır (`loop.ts:71-119`). **Fark:** rovecode'un generator modeli backpressure'ı doğal veriyor; Codex'in task modeli ise "compact"i de bir task olarak izole ediyor — rovecode'da compaction loop içinde bir blok, ayrı task değil.

### 4.2 Context compaction

- **OpenCode (dev, Effect'e göçmüş)**: iki kademeli: (a) `prune` — sondan geriye yürüyüp son user turn'ü ve `PRUNE_PROTECT = 40_000` token değerinde tool çağrısını koruyarak daha eski tool çıktılarını **yerinde** siler (serileştirmede `"[Old tool result content cleared]"`; `skill` tool çıktıları muaf; en az `PRUNE_MINIMUM = 20_000` kazanç yoksa hiç dokunmaz; `cfg.compaction.prune` ile opt-in); (b) LLM özetlemesi — gizli bir **compaction agent**'ı çalıştırır; yakın geçmişten korunan bütçe `min(15_000, max(2_000, usableWindow × 0.25))`; overflow sonrası compaction + retry var. (raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/compaction.ts :28-33, :271-294 · opencode.ai/docs/agents/ "Use compaction" · 2026-09-14 · **A+B**)
- **Codex**: üç yol — `Feature::TokenBudget` açıksa deneysel token-budget compaction; provider `RemoteCompactionSupport::V2` ilan ediyorsa **sunucu-taraflı remote compaction**; değilse lokal `SUMMARIZATION_PROMPT` ile özet task'ı. (raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tasks/compact.rs · 2026-09-14 · **A**)
- **Claude Code**: auto-compact önce **eski tool çıktılarını temizler**, yetmezse konuşmayı özetler; birkaç deneme sonrası context hemen doluyorsa "thrashing" hatasıyla durur (sonsuz compact döngüsü yok); `/compact <odak>` ve CLAUDE.md'de "Compact Instructions" bölümü ile yönlendirme; Sonnet 5'te 1M pencerede ~967K'da otomatik compact (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`). (code.claude.com/docs/en/how-claude-code-works.md §When-context-fills-up · code.claude.com/docs/en/model-config.md · code.claude.com/docs/en/troubleshooting.md · 2026-09-14 · **B**)
- **pi**: tetik `contextTokens > contextWindow − reserveTokens` (varsayılan rezerv 16384); araç batch'i bittikten sonra/yanıt öncesi kontrol; kesim noktası sadece user/assistant/bash/custom mesajlarda (tool result'ta kesim yok — çağrı/sonuç bütünlüğü); tek tur bütçeyi aşarsa "split turn": geçmiş özeti + tur-öneki özeti ayrı üretilip birleştirilir; compaction çağrıları taze routing-session ID'si ve prompt-cache yazımı kapalı gönderilir (tek seferlik prompt cache'i kirletmez); `/tree` dal geçişinde ayrıca branch-summarization. (raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/compaction.md · 2026-09-14 · **B**)
- **Roo Code**: "Intelligent Context Condensing" varsayılan açık; eşik slider'ı (varsayılan %100), manuel "Condense Context" butonu, özel prompt desteği; ilk mesajdaki slash komutları özetlemeler arasında korunur. (docs.roocode.com/features/intelligent-context-condensing · 2026-09-14 · **B**)
- **OpenHands**: `CondenserBase` soyutlaması altında `NoOpCondenser`, `LLMSummarizingCondenser`, `RollingCondenser` (eşik-tetikli), `PipelineCondenser` (zincirleme); sonuç bir `Condensation` eventi olarak history'e yazılır ve sonraki `View` ondan türetilir. (docs.openhands.dev/sdk/arch/condenser.md · 2026-09-14 · **B**)
- **aider**: `history.py` head/tail — eski başlık özetlenir, kuyruk korunur (rovecode portunun kaynağı). (github.com/Aider-AI/aider `aider/history.py` · rovecode `src/core/context.ts:45-58` · 2026-09-14 · **A**)
- **rovecode**: üç strateji (`head-summarize` / `keep-window` / `provider-native` seam) + çift tetik (`speculative` = tahmin > bütçe×eşik; `emergency` = provider overflow reddi, tek re-drive); `keep-window` çağrı/sonuç çiftlerini atomik keser (`alignCut`); emergency'de plan **gözlenen** boyutun yarısına göre yapılır. (src/core/compaction.ts :1-34, :101-149, :184-220 · **A**)

### 4.3 Prompt layering

- **Claude Code** en katmanlı model: managed policy (IT) > user `~/.claude/CLAUDE.md` > project `./CLAUDE.md` | `./.claude/CLAUDE.md` > local `CLAUDE.local.md`; `@path` import'ları (maks 4 derinlik, kod blokları hariç); `.claude/rules/` ile yol-kapsamlı kurallar; **auto memory** (Claude'un kendi yazdığı MEMORY.md, ilk 200 satır/25KB yüklenir); dışa import ilk seferde onay diyaloğu ister. (code.claude.com/docs/en/memory.md · 2026-09-14 · **B**)
- **Codex**: AGENTS.md ("custom instructions") + `rules` (sandbox dışı komut kontrolü) + skills. (learn.chatgpt.com/docs/agent-configuration/agents-md.md · 2026-09-14 · **B**)
- **rovecode**: system prompt = base + skills index + memory index + model-profil bölümü + design protokolü (+native-olmayan modeller için tool-calling bloğu); üzerine ADR-007 `ContextChunk` öncelik sırası (system 100 > repo-map 80 > config 70 > history 50); bütçe baskısında düşük öncelikli chunk kovulur, system en son. Bellek blokları threat-scan ile nötralize edilir (prompt-injection satırları `[BLOCKED]`). (src/cli/runtime.ts:553-600 · src/core/context.ts:24-43 · src/memory/blocks.ts · **A**)
- **goose**: `.goosehints` ve/veya `AGENT.md`. (goose-docs.ai/llms.txt · 2026-09-14 · **B**)

### 4.4 Tool protocol

- **OpenHands**: her şey typed `Action` → `Observation` eventi; paralel tool execution resmi rehberi var; tool'lar SDK'da sınıf olarak tanımlanır. (docs.openhands.dev/sdk/arch/tool-system.md, /sdk/guides/parallel-tool-execution.md · 2026-09-14 · **B**)
- **SWE-agent**'ın kalıcı dersi (ACI): araç arayüzü tasarımı sonucu değiştirir — edit komutunda linter kapısı (sözdizimi bozuksa edit reddedilir), özel dosya görüntüleyici (tur başına 100 satır), özet arama sonucu (sadece eşleşen dosya listesi), boş çıktıda açık mesaj. SWE-agent artık mini-swe-agent'ı öneriyor (aynı performans, daha basit). (swe-agent.com/latest/background/aci/ · 2026-09-14 · **B**)
- **rovecode**: `validate → revise(hook) → policy(deny-default, last-match) → pre_tool hook → approve(execpolicy→hook→human) → abort re-check → execute → guard dedup → post_tool hook` merdiveni (`src/core/tools.ts:63-188`); batch dispatch paralel/sequential karışık (`tools.ts:191-216`). SWE-agent'ın linter kapısının karşılığı: hashline anchor + LSP diagnostics gate + reflection nudge (port #28). **A**

### 4.5 Tool-result truncation

- **OpenCode**: compaction serileştirmesinde tool çıktısı 2.000 karaktere kırpılır (`TOOL_OUTPUT_MAX_CHARS`); asıl yenilik, yukarıdaki `prune`'un bunu **konuşma geçmişinde** yapması. (**A**)
- **Claude Code**: auto-compact'in ilk fazı eski tool çıktılarını temizler; "MCP tool definitions are deferred by default and loaded on demand via tool search" — tanım seviyesinde de tasarruf. (code.claude.com/docs/en/how-claude-code-works.md · 2026-09-14 · **B**)
- **rovecode**: araç-bazlı sabitler — bash çıktısı ~10k karakter (`src/coding/hashline.ts:272`), MCP çıktısı `OUTPUT_MAX` (`src/mcp/client.ts:418`), webfetch byte-cap (`src/tools/webfetch.ts:171-303`), evalcell 64 KiB üst sınır (`src/tools/evalcell.ts:72`), `@file` eki 400 satır/8 dosya/60k karakter (README). Guardrails yinelenen-sonuç stub'ı (≥512 char) ek tasarruf sağlar. **Birleşik, bağlam-muhasebesine bağlı bir bütçe yok** — gap G3. (**A**)

### 4.6 Repo discovery / indexing

- **aider** repomap'i icat eden: tree-sitter etiketleri + def/ref grafiği + PageRank + token bütçesine ikili arama (rovecode portu `src/coding/repomap.ts`, sembol çıkarımı için @ast-grep). (aider.chat/docs/repomap.html · 2026-09-14 · **B**; port **A**)
- **Roo Code**: ayrıca **Codebase Indexing** özelliği var (embedding tabanlı semantik indeks, özellik listesinde). (docs.roocode.com/features/codebase-indexing · 2026-09-14 · **B**)
- **Claude Code**: Explore subagent + isteğe bağlı code-intelligence pluginleri (LSP). (**B**)
- **rovecode**: repomap + LSP tanı kapısı + glob/grep/ls araçları; semantik/embedding indeks yok — gap (P2). (**A**)

### 4.7 Planning vs execution

- **Claude Code**: `plan` permission modu + Plan subagent (read-only araştırma, ana bağlamı kirletmez); `opusplan` alias'ı plan'da Opus, icrada Sonnet kullanır. (code.claude.com/docs/en/permission-modes.md, model-config.md · 2026-09-14 · **B**)
- **OpenCode**: `plan` primary agent — dosya editleri ve bash varsayılan olarak `ask`. (opencode.ai/docs/agents/ · 2026-09-14 · **B**)
- **Cline**: Plan/Act ikilisi (docs.cline.bot/core-workflows/plan-and-act.md · **B**); **aider**: architect mode (aider.chat/docs/usage/modes.html · **B**).
- **rovecode**: Plan/Act modları + per-mode model config (port #20); plan reminder istek-başına, history'e yazılmadan enjekte edilir (`src/core/loop.ts:257-260`); verify gate "done"dan önce projenin kendi kontrolünü koşturur — **bu ikisi rakiplerde görmediğim farklar**. (**A**)

### 4.8 Subagents

- **Claude Code**: `.claude/agents/*.md` (YAML frontmatter: name/description/tools/model/permissionMode/hooks/skills); built-in Explore (read-only, model miraslı, API'de Opus'a kilitli) + Plan + general-purpose; tüm subagent tanımı 15.000 token'ı aşarsa başlangıç uyarısı; subagent'lar kendi context penceresinde çalışır, sadece özet döner; **fork** seçeneği mevcut konuşmanın kopyasıyla başlatır; background agents / agent teams ayrı mekanizmalar. (code.claude.com/docs/en/sub-agents.md · 2026-09-14 · **B**)
- **Codex**: subagent workflow'lar güncel sürümlerde varsayılan açık; `/agent` ile thread'ler arası geçiş; ana thread sonuçları toplar; özel agent tanımları (farklı model/config) desteklenir; "context pollution / context rot" gerekçesi docs'ta açıkça yazıyor. (learn.chatgpt.com/docs/agent-configuration/subagents.md · 2026-09-14 · **B**)
- **OpenCode**: primary vs subagent ayrımı; built-in `general`, `explore` (read-only), `scout` (dış doküman/bağımlılık araştırması, managed cache'e clone), gizli sistem ajanları (`compaction`, `title`, `summary`). (opencode.ai/docs/agents/ · 2026-09-14 · **B**)
- **OpenHands**: task tool set ile senkron sub-agent delegasyonu + Markdown+frontmatter ile "file-based agents". (docs.openhands.dev/sdk/guides/task-tool-set.md, agent-file-based.md · 2026-09-14 · **B**)
- **pi**: bilinçli olarak **yok** — "pi skips features like sub agents and plan mode"; üçüncü-parti paketle eklenebilir. (raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md · 2026-09-14 · **B**)
- **rovecode**: `runChild` — child kendi session'ında, depth cap 3, isteğe bağlı git-worktree/copy izolasyonu + patch merge-back (sadece ok ise), parent izinleri child'a "prompt→deny" ile daraltılarak devredilir; background `task` tool ile FIFO kuyruk (varsayılan 3, slot-lending deadlock önlemi), tamamlanma notları parent'ın steering kuyruğuna düşer. (src/core/orchestrator.ts, src/core/tasks.ts · **A**). **Gap:** senkron toplama; inceleme/thread geçişi (Codex `/agent`) yok; fork-with-context yok; spawn anında model override yok (child parent'ın modelini alır, `runtime.ts` "children run the model of the run that started them").

### 4.9 Checkpoints / resume

- **Claude Code**: konuşma JSONL `~/.claude/projects/` altında; **dosya değişikliklerinden önce snapshot** alınır (checkpoint ile geri alma); `--continue`/`--resume`/`--fork-session`, `/branch`. (code.claude.com/docs/en/how-claude-code-works.md, sessions.md · 2026-09-14 · **B**)
- **Cline**: shadow-git — her tool kullanımından sonra proje dosyalarının snapshot'ı ayrı bir shadow repoya commitlenir; kullanıcının .git'ine dokunulmaz; üç restore modu (Files / Task Only / Files & Task); mesaj düzenleme + "Restore All" entegrasyonu. (docs.cline.bot/core-workflows/checkpoints.md · 2026-09-14 · **B**)
- **Codex**: rollout kaydı + resume (docs'ta `codex resume`); ayrıca cloud izole container'lar. (learn.chatgpt.com/docs/codex/cli.md · 2026-09-14 · **B**)
- **pi**: JSONL ağaç; `/tree` ile yerinde dallanma; `--fork`; compaction kayıplı ama tam geçmiş dosyada kalır. (pi README §Sessions · **B**)
- **rovecode**: append-only JSONL DAG + sha256 hash zinciri (tamper-evident) + dayanıklı leaf pointer (meta.json) + `/rewind` branch + shadow-git checkpoint (cline v3.89.2 portu; bilinen maliyet: session başına ilk snapshot ~3.5 sn, repo-bazlı paylaşımlı tasarım header'da dokümante). (src/core/session.ts, src/coding/checkpoints.ts · **A**)

### 4.10 Permissions / sandbox

- **Codex**: iki katman — sandbox modu (teknik olarak ne mümkün: read-only / workspace-write / danger-full-access) × approval policy (ne zaman sorulur; `untrusted` **kaldırılmış**, yerine `on-request` + proje `trust_level`); ağ varsayılan kapalı; `network_proxy` feature ile domain allow/deny kuralları; cloud iki fazlı (setup ağlı → agent çevrimdışı; secret'lar agent fazında silinir); yıkıcı MCP tool annotation'ları her zaman onay ister; GPT-6 Astra ile asenkron güvenlik izleme (task'ı duraklatabilir). (learn.chatgpt.com/docs/agent-approvals-security.md · 2026-09-14 · **B**)
- **Claude Code**: `allow/ask/deny` — **değerlendirme sırası deny → ask → allow, ilk eşleşen kazanır; specificity sırayı değiştirmez**; `Tool(specifier)` sözdizimi (`Bash(npm run build)`, `WebFetch(domain:…)`, `Tool(param:value)`); "don't ask again" kuralları repo kökünde `.claude/settings.local.json`'a kalıcı yazılır (worktree'lerden ana checkout'a çözümlenir); modlar: default/manual, acceptEdits, plan, auto (sınıflandırıcı onayı), dontAsk, bypassPermissions; bare-tool deny aracı modelin context'inden tamamen kaldırır. (code.claude.com/docs/en/permissions.md · 2026-09-14 · **B**)
- **rovecode**: `PermissionRule{action, resource, effect}` deny-default + last-match-wins (`src/core/tools.ts:37-47`); codex portu execpolicy (argv sınıflandırma, strictest-wins, forbidden asla çalışmaz); üç seviye (ask / accept-edits / auto) + `--save` ile kalıcı seviye; approval "always" önbelleği **süreç-içi** (`ToolRegistry.approvalCache`) — Claude Code'un kural-dosyasına yazan kalıcılığı yok → gap; sandbox merdiveni direct/WSL2/Docker probe'lu (`src/core/sandbox-config.ts`, README #10/#27). (**A**)
- **OpenHands**: confirmation policy + LLM tabanlı security analyzer + Docker/Apptainer/remote runtime. (docs.openhands.dev/sdk/guides/security.md, arch/security.md · 2026-09-14 · **B**)

### 4.11 Streaming / TUI

- **OpenCode**: client/server ayrımı — TUI, HTTP+SSE konuşan bir SDK istemcisi; OpenAPI `/doc`; loopback varsayılan. (rovecode port #19'un kaynağı; opencode.ai/docs/server/ · **B**)
- **Codex**: ratatui TUI + app-server protokolü (ürünlere gömme). (learn.chatgpt.com/docs/app-server.md · **B**)
- **pi**: dört mod — interactive, print/JSON, **RPC** (süreç entegrasyonu), SDK. (pi README · **B**)
- **Cline**: VS Code webview + bağımsız CLI/TUI + Kanban (paralel ajanlar, izole worktree'ler); SDK'da **hub-spoke**: yerel daemon oturumları koordine eder, spoke worker'lar yürütür. (docs.cline.bot/llms.txt → sdk/architecture/hub-spoke.md · 2026-09-14 · **B**)
- **rovecode**: sextant (kendi cell-buffer motoru) varsayılan TUI + klasik REPL + HTTP/SSE server + ACP (Zed/JetBrains) — hepsi tek loop üstünde (ADR-003). (**A**)

### 4.12 Model/provider abstraction

- **rovecode**: OpenAI + Anthropic iki wire adaptörü; role router (OMP portu) + sıralı fallback chain (gemini-cli portu: 429/5xx ilerletir, 400 asla, abort asla); models.dev kataloğu (fiyat/context/maxOutput/reasoning); tek "effort" kadranı iki lehçeye çevrilir; non-native modellere XML/Hermes middleware. (src/providers/router.ts header · **A**)
- **Codex**: model provider config + subscription (ChatGPT) veya API key; **LLM subscriptions** OpenHands'da da var. (**B**)
- **Claude Code**: alias sistemi (default/best/fable/sonnet/opus/haiku/`opusplan`, `[1m]` pencere soneki); güvenlik sınıflandırıcısı bayraklarsa **otomatik model fallback**; ağ geçitleri (Bedrock/Vertex/Foundry). (code.claude.com/docs/en/model-config.md · **B**)
- **pi**: geniş provider listesi + subscription login (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot); `pi update --models` ile katalog tazeleme. (**B**)

### 4.13 MCP / skills / hooks

- **Claude Code hooks**: `settings.json`'da `hooks` bloğu; event'ler PreToolUse/PostToolUse/Notification/SessionStart…; `matcher` regex'i; **komut hook'u (shell), prompt-based hook ve agent-based hook** üç tür; `/hooks` tarayıcısı read-only; hook'lar deterministik kontrol içindir, yargı gerekiyorsa prompt/agent hook. (code.claude.com/docs/en/hooks-guide.md · 2026-09-14 · **B**)
- **Claude Code MCP**: tool tanımları **deferred** — tool search ile isteğe bağlı yüklenir; rovecode'un lazy-disclosure'ı (2 house tool: `mcp_list`/`mcp_call`, ~0 idle token) aynı problemin farklı çözümü. (code.claude.com/docs/en/mcp.md · **B**; src/mcp/client.ts header · **A**)
- **rovecode hooks v2**: in-process TS fonksiyonları; timeout-bounded (5 sn), izole (atan hook çalışmayı durduramaz), sonuç-bounded (deny reason ≤ cap, post_tool büyüme ≤ cap); politika hook'tan önce çalışır (hook deny'ı geri alamaz); güven notu: `.rovecode/hooks.ts` kullanıcı ayrıcalığıyla çalışır, **project-trust prompt'u bilinçli olarak kapsam dışı bırakılmış** (pi `project_trust` event'ine atıf) → gap G8. (src/core/hooks.ts header · **A**)
- **goose**: extensions = MCP sunucuları; recipes (paylaşılabilir görev şablonları); 70+ kayıtlı extension. (goose-docs.ai/llms.txt · **B**)

### 4.14 Telemetry

- **Codex**: `codex_otel` — TURN_E2E_DURATION, TURN_TOOL_CALL, TURN_MEMORY, TURN_NETWORK_PROXY, ACTIVE_TURNS gauge; analytics crate ile turn profil/token-usage fact'leri. (codex-rs/core/src/tasks/mod.rs import'ları · **A**)
- **Claude Code**: OTel yapılandırması (monitoring-usage) + kurumsal gateway'de OTLP. (code.claude.com/docs/en/monitoring-usage.md · **B**)
- **Cline**: enterprise OTel (log events referansı bile var). (docs.cline.bot/llms.txt · **B**)
- **OpenHands**: OTel tracing rehberi (Laminar/MLflow/Honeycomb). (docs.openhands.dev/sdk/guides/observability.md · **B**)
- **rovecode**: port #39 — hooks seam'i üstünden OTel; run⊃turn⊃tool span ağacı; attribute politikası "ids, sizes, outcomes only — asla goal/args/output" (pi'nin politikası); OTLP/HTTP JSON el-kodlaması, post_run'da tek POST, fire-and-forget. (src/telemetry/otel.ts header · **A**)

---

## 5. Nimbus/rovecode mevcut-durum haritası (kaynak-doğrulamalı)

| Katman | Dosya | Durum |
|---|---|---|
| Agent loop | `src/core/loop.ts` (567 satır) | Tek generator; steering/follow-up drain; finish-check (tek nudge); verify gate; emergency compaction re-drive (1×); abort = tek AbortController; wire-well-formedness her çıkışta garanti |
| Compaction | `src/core/compaction.ts` (259) | 3 strateji + 2 tetik; provider-native seam **boşta** (hiçbir adaptör ilan etmiyor) |
| Context assembly | `src/core/context.ts` (60) | ADR-007 chunk önceliği; `estimateTokens` = len/4 |
| Token gerçeği | `src/core/count-remote.ts`, `docs/context.md` | `--exact` ile Anthropic count_tokens karşılaştırması var; **loop tetigi hâlâ kalibrasyonsuz tahmine bağlı** |
| Tools | `src/core/tools.ts` (288) + `src/tools/*` + `src/coding/hashline.ts` | validate→revise→policy→hook→approve→execute; batch paralellik; approvalCache süreç-içi |
| Guardrails | `src/core/guardrails.ts` (400) | hermes portu: ardışık aynı-imza warn→stub; yinelenen-sonuç dedup (≥512c); poller muafiyeti |
| Exec policy | `src/core/execpolicy.ts` (385) | codex portu: prefix kuralları + heuristics + strictest-wins; forbidden asla çalışmaz |
| Sandbox | `src/core/sandbox-config.ts`, `src/core/executor.ts` | direct/WSL2/Docker merdiveni, probe'lu; proje-bazlı seçim |
| Session | `src/core/session.ts` (398) | JSONL DAG + sha256 chain + leaf persist + corruption sınıflandırma (6 tür) + image sidecar |
| Checkpoints | `src/coding/checkpoints.ts` (270) | cline v3.89.2 shadow-git portu; 3 restore modu; bilinen ilk-snapshot maliyeti (~3.5 sn) |
| Subagents | `src/core/orchestrator.ts` (207) + `src/core/tasks.ts` | depth≤3; worktree/copy izolasyonu + patch merge-back; FIFO kuyruk (3) + slot-lending; izin daraltma |
| Providers | `src/providers/*` | 2 wire adaptörü; router+chain; retry (429/5xx); cache breakpoint; models.dev katalog; effort kadranı; profil sistemi |
| Repo index | `src/coding/repomap*.ts` | aider portu PageRank repomap + kalıcı cache; LSP tanı kapısı |
| MCP | `src/mcp/*` | lazy disclosure (2 house tool); market + trust gate |
| Hooks/Plugins/Skills | `src/core/hooks.ts`, `src/plugins/*`, `src/skills/*` | hooks v2 (izole/timeout); plugin.json manifest; SKILL.md + versioned edits |
| Memory | `src/memory/*` | MEMORY/USER blokları (cap'li, threat-scan); cross-session FTS recall |
| Telemetry | `src/telemetry/*` | OTel run/turn/tool span'ları; OTLP JSON |
| Eval | `src/eval/*` | gauntlet (10 görev, deterministic) + bench |
| Surfaces | `src/sextant/*`, `src/tui/*`, `src/server/*`, `src/acp/*` | sextant TUI + klasik REPL + HTTP/SSE + ACP — tek loop |

---

## 6. Gap haritası (kimlikli)

| ID | Gap | Kanıt (rakip) | Şiddet |
|---|---|---|---|
| G1 | Token estimatoru Anthropic'te ~%36 düşük; compaction speculative tetigi buna güveniyor | repo `docs/context.md` (kendi ölçümü: 12.283 gerçek vs 7.790 tahmin); Claude Code pencereyi provider'ın bildiği değerden yönetiyor (model-config.md) | **P0** |
| G2 | Eski tool çıktılarının yerinde budaması (prune) yok — ucuz, modelsüz ilk kademe eksik | OpenCode `prune` (compaction.ts:271-294); Claude Code auto-compact faz 1 | **P0** |
| G3 | Tool-result truncation araç-bazlı sabitlerde dağınık; bağlam bütçesiyle konuşan birleşik politika yok; tek-dev-çıktı için head+tail stratejisi yok | OpenCode 2k serileştirme cap'i; pi keepRecentTokens; rovecode `hashline.ts:272` sabit 10k | **P0/P1** |
| G4 | Provider-native compaction seam'i boşta: Codex `RemoteCompactionSupport::V2` ve Anthropic context-editing (tool-uses clearing) bağlanmamış | codex `tasks/compact.rs`; docs Anthropic context editing | **P1** |
| G5 | Subagent'lar senkron; inceleme/thread modeli (Codex `/agent`), fork-with-context (Claude), spawn-anında model override yok | Codex subagents.md; Claude sub-agents.md fork | **P1** |
| G6 | "Always" onayları süreç-içi; Claude Code'un `.claude/settings.local.json`'a yazdığı kalıcı kural yok | Claude permissions.md | **P1** |
| G7 | Prompt-based / agent-based hook yok (sadece deterministik TS hook'ları); UserPromptSubmit benzeri giriş hook'u yok | Claude hooks-guide.md | **P2** |
| G8 | Proje-trust onayı yok: `.rovecode/hooks.ts` / plugins / mcp.json checkout açılışında çalışıyor (kod header'ında "documented follow-up" olarak itiraf edilmiş) | pi `project_trust` event; Codex `trust_level` | **P1** (güvenlik) |
| G9 | Semantik repo indeksi yok (repomap yapısal; Roo'nun embedding indeksi sınıfında bir şey yok) | Roo codebase-indexing | **P2** |
| G10 | Compaction thrash koruması: tek emergency re-drive var ama "compact ettim, hemen doldu" döngüsü için Claude'un açık thrash-durdurucusu tarzında sayaç/durum yok | Claude troubleshooting.md | **P2** |
| G11 | Yönetilen (managed/enterprise) settings katmanı yok | Claude managed-settings.md; Codex managed `allowed_approval_policies` | **P2** |
| G12 | Stuck detection hermes guard ile sınırlı (aynı-imza serisi); OpenHands'in 5 desenli dedektörü (tekrar action-obs 4+, action-error 3+, monolog 3+, ping-pong 6+, context-window hataları) kapsamıyor — **Araştırma-B'nin alanıyla kesişiyor, onaylandı** | docs.openhands.dev/sdk/guides/agent-stuck-detector.md | **P1** (B ile paylaşımlı) |
| G13 | Ağ erişim politikası tool-seviyesinde (`net.fetch` host kuralı); Codex'in sandbox-içi `network_proxy` domain kuralları gibi exec katmanında ağ kilidi yok | Codex approvals-security.md | **P2** |

---

## 7. Öneriler (P0/P1/P2) + TypeScript arayüz taslakları

### P0-1 — Kalibre token estimatoru (G1)

Tetik tahmini, provider'ın raporladığı gerçek `input` ile sürekli kalibre edilir. EMA yeterli; perşembe gecesi yazılan bir Bayesian makineleri değil.

```ts
// src/core/token-scale.ts (mevcut dosya genişletilir)
export interface TokenScale {
  /** loop'un tahminini provider gerçeğiyle düzeltir; model+provider başına EMA oran */
  observe(model: ModelRef, estimatedInput: number, reportedInput: number): void;
  /** tetik öncesi çarpan: tahmin × factor(model) — bilinmeyen modelde protokol varsayılanı */
  factor(model: ModelRef): number;
}
// loop.ts: const histTokens = raw * scale.factor(model)  // tek satırlık değişim
```

Doğrulama: `rovecode context --exact`'in bugün ölçtüğü drift satırıyla aynı veri; gauntlet'e "compaction eşiği doğru zamanda ateşleniyor" senaryosu. Risk: aşırı düzeltme erken compaction → kabul edilebilir (özet kayıplı ama overflow'dan ucuz).

### P0-2 — Yerinde tool-output budaması (G2)

OpenCode prune'unun rovecode uyarlaması. Özetlemeden ÖNCE ve modelsüz çalışır; `keep-window`'un kaba mesaj-silmesinin yerine değil, önüne geçer.

```ts
// src/core/compaction.ts'e dördüncü strateji değil — ÖN AŞAMA:
export interface PrunePlan {
  /** korunan son user-turn + son `protectTokens` değerinde tool trafiği */
  drops: Map<string, string>; // toolResult messageId → kısa stub
  tokensFreed: number;
}
export function planPrune(history: readonly Message[], opts: {
  protectTokens: number;   // OpenCode PRUNE_PROTECT=40k analoğu
  minGainTokens: number;   // PRUNE_MINIMUM=20k analoğu — altındaysa null dön
  keepTools?: string[];    // OpenCode'un ["skill"] muafiyeti analoğu: ["memory_write", "skill_view"]
  tokenOf: (p: MessagePart) => number;
}): PrunePlan | null;
// apply: eski tool_result part'larının output'unu stub ile DEĞİŞTİRİR (yeni mesaj eklemez →
// history zinciri ve hash zinciri bozulmaz; stub: "[tool output pruned — ilk 200 karakter]: …")
```

Kritik kural: çağrı/sonuç çifti asla ayrılmaz (sonuç **içeriği** stub'lanır, part kalır) — wire well-formedness dokunulmaz. Persistence: session store'a `compaction` event'i zaten yazılıyor; prune için yeni event varyantı `prune` eklenir (replay'de stub'lar idempotent).

### P0-3 — Birleşik çıktı-bütçesi politikası (G3)

```ts
// src/core/output-budget.ts (yeni, küçük)
export interface OutputBudget {
  /** araç başına üst sınır; ctx'te kalan bağlam bütçesinin payıyla daralır */
  capFor(tool: string, ctx: { remainingBudgetTokens: number }): number;
  /** head+tail kırpma: ilk %70 + son %30, ortada marker; byte-değil satır-hizalı */
  truncate(text: string, cap: number): { text: string; truncated: boolean };
}
// tools.ts dispatch'te execute sonrası tek noktadan geçer → araç sabitleri default olur, politika üst yazar
```

### P1-4 — Provider-native compaction'ı kablolamak (G4)

`LoopDeps.compactNative` seam'i hazır; iki gerçek adaptör:

1. **Anthropic context-editing**: istekte `context_management` ile eski tool_uses'ları sunucunun temizlemesi — P0-2'nin sunucu-taraflı ikizi; Claude modellerinde prune'u tamamen devralabilir. (docs.claude.com context editing · **B**)
2. **Codex tarzı remote**: provider `RemoteCompactionSupport` ilan ediyorsa delege (Codex bunu kendi Responses altyapısı için yapıyor). (codex compact.rs · **A**)

```ts
// providers/stream.ts adaptöründe capability ilanı:
export interface AdapterCaps { nativeCompaction?: "clears-tool-uses" | "summarize-remote"; }
// compaction.ts resolveStrategy: "provider-native" artık gerçekten seçilebilir (bugün hepimiz biliyoruz ki hep düşüyor)
```

### P1-5 — Asenkron, incelenebilir subagent handle'ları (G5)

```ts
// src/core/orchestrator.ts genişlemesi
export interface SubagentHandle {
  readonly id: string; readonly agent: string; readonly depth: number;
  events(): AsyncIterable<RunEvent>;          // canlı şerit (Codex /agent thread görünümü)
  steer(text: string): void;                  // child'in kendi SteeringQueue'suna
  collect(): Promise<SpawnResult>;            // mevcut senkron davranış = collect()'i await etmek
  cancel(): void;
}
// TaskManager bunları tutar; TUI crew board zaten var — events() ona bağlanır.
// SpawnRequest'e opsiyonel `model?: ModelRef` (child parent'ınkini miras alır — mevcut davranış default kalır)
// ve `forkFromHistory?: Message[]` (Claude fork analoğu: child ana konuşmanın kopyasıyla başlar) eklenir.
```

### P1-6 — Kalıcı "always" kuralları (G6)

`ToolRegistry.approvalCache` → `.rovecode/settings.json` (proje) / `~/.rovecode/settings.json` (kullanıcı) altında `permissions.allow: [{action, resource}]` olarak yaz; açılışta kurallara kat (mevcut `evaluatePermissions` zincirine ek satır; Claude Code'un settings.local.json davranışının aynısı). "Always" kartı artık süreç değil repo ömürlü.

### P1-7 — Proje-trust kapısı (G8)

İlk açılışta checkout başına tek onay: `.rovecode/hooks.ts`, `plugins/`, `mcp.json` bulunursa → "Bu proje kod çalıştıran yapılandırma içeriyor: güven / bir kez izin ver / reddet". Karar `~/.rovecode/trust.json`'da (path hash'i ile). Codex `trust_level` + pi `project_trust` event'inin birleşimi. Reddedilirse hook/plugin/MCP yüklenmez, gerisi çalışır.

### P1-8 — 5 desenli stuck dedektörü (G12, Araştırma-B ile ortak)

`ToolGuard`'ın yanına salt-okunur bir `StuckDetector` (OpenHands'in 5 deseni; eşikler docs'ta: 4/3/3/6). Dedektör **temsil** eder (run_end.outstanding'a `stuck: {pattern, since}` eklenir), zorunlu kill B'nin alanı. Guard'dan farkı: aynı-imza değil **semantik** tekrar + monolog + ping-pong.

### P2'ler

- **G7**: prompt-based hook (hook event'ine mini LLM çağrısı bağlama) — hooks v2 runner'ına `type: "prompt"` varyantı.
- **G9**: repomap'e isteğe bağlı embedding katmanı (9router embeddings seam'i) — Roo deneyimi izlenir; kapalı varsayılan.
- **G10**: compaction-thrash sayacı: ardışık 2 compaction sonrası histTokens hâlâ > eşik×0.9 ise emergency'yi durdur, `run_end status:"error"` + açıklayıcı özet (Claude thrash hatasının açık versiyonu).
- **G11**: managed settings katmanı (kurumsal): `/etc/rovecode/settings.json` > proje > kullanıcı önceliği; `disableAutoMode` benzeri kilitler.
- **G13**: executor rung'larına ağ-kapalı seçenek (Docker rung'ında `--network none`; WSL2'de doğrulanabilir eşdeğer), `net.fetch` kuralından bağımsız exec-katmanı kilidi.

---

## 8. Riskler

1. **Estimator kalibrasyonu yanlış yöne giderse** erken compaction bilgi kaybını artırır. Azaltım: EMA yavaş (α≈0.3), sadece yukarı düzeltmede agresif; `rovecode context` drift satırı gözlemlenebilirlik sağlıyor.
2. **Prune'ın stub'ı** modelin "az önce gördüğüm çıktı niye yok" diye tekrar okuma yapmasına yol açabilir (maliyet geri döner). Azaltım: stub ilk 200 karakteri tutar; OpenCode'un 40k koruma penceresi bu yüzden var — aynı değerle başla.
3. **Provider-native compaction opaklığı**: sunucunun ne sildiği görünmez; replay/export (rovecode'un hash-zincirli güçlü yanı) bulanıklaşır. Azaltım: native sonuç `CompactionOutcome` olarak store'a işlenir, export'ta "provider-native, içerik doğrulanamaz" işaretlenir.
4. **Subagent fork**'u bağlam kirliliğini child'a taşıyabilir; dokümantasyonu "fork = son çare" diye yazar.
5. **Project-trust UX yorgunluğu**: her checkout'ta soru = kimse okumaz. Azaltım: repo hash + ilk-görülme; sessiz default = hooks kapalı/araçlar açık değil, **soru** — Codex'in untrusted→on-request göçü bu dengenin hassas olduğunu gösteriyor.
6. **Persistent allow kuralları** birikir; eski `rm -rf build/*` izni yıllarca durur. Azaltım: `rovecode permissions` listeleme/silme komutu şart; kurala `grantedAt` yazılır.
7. **Thrash sayacı yanlış-pozitifi**: gerçekten büyük tek-tur işlerde erken pes. Azaltım: sadece ardışık 2 **sonuçsuz** compaction'da ateşlenir.

---

## 9. 30/60/90 günlük yol haritası

**30 gün (P0 — ölçüm ve ucuz kazançlar):**
- P0-1 kalibre estimator (EMA + per-model çarpan) + `rovecode context`'e "kalibre edilmiş tahmin" satırı.
- P0-2 prune ön-aşaması (compaction öncesi, modelsüz) + `prune` event'i.
- P0-3 birleşik output-budget (head+tail kırpma) tek noktadan.
- Gauntlet'e: "eşik doğruluğu", "prune sonrası wire-well-formedness", "uzun oturumda bütçe sadakati" senaryoları (Araştırma-B'nin eval önerileriyle eşle).

**60 gün (P1 — yapısal):**
- P1-4 Anthropic context-editing adaptörü + provider-native seçiminin gerçekten çalışması; Codex-remote için capability el sıkışması taslağı.
- P1-5 SubagentHandle (events/steer/collect/cancel) + spawn-time model override + crew board entegrasyonu; fork deneysel bayrak arkasında.
- P1-6 kalıcı allow kuralları + `rovecode permissions` yönetim komutu.
- P1-7 project-trust kapısı (hooks/plugins/MCP için).
- P1-8 stuck dedektörü (B ile ortak; temsil B'de, dedektör çekirdeği burada).

**90 gün (P2 — derinlik):**
- P2/G7 prompt-hook varyantı; G9 deneysel semantik indeks; G10 thrash sayacı; G11 managed settings; G13 exec-katmanı ağ kilidi.
- Her P2 için ölçüm: gauntlet skorları + OTel span'larıyla öncesi/sonrası (Araştırma-B'nin "compaction kalitesi ölçülmüyor" bulgusu burada kapanır).

---

## 10. Eş-araştırmacı (Araştırma-B) etkileşim kaydı

**Gönderilen (07:0x):** İlk tarama özeti + 4 gap hipotezi (estimator kalibrasyonu, truncation politikası, senkron subagent, semantik indeks).
**Alınan (07:03):** B kapsamını bildirdi (eval/replay/patch-grading/routing-bütçe/stuck-loop/secrets/injection…). Hipotez (1)'i doğruladı ve genişletti ("compaction kalitesi de ölçülmüyor"); (2)'yi doğruladı, OpenHands 5-desenli stuck detector karşılaştırmasını verdi (bu raporda G12 olarak işlendi ve kaynak doğrulandı). Kendi gap'leri: gauntlet string-contains doğrulama (gerçek patch grading yok), run geçmişi persistansı yok, CI eval yok, replay harness yok, secrets redaction yok, circuit breaker yok, injection corpus yok.
**B'ye gönderilen somut adversarial kritikler (07:44, thread `msg_22b0bbb7c29d`):**
1. **"Gauntlet string-contains, gerçek patch grading yok" iddiasına itiraz:** gauntlet bilinçli olarak scripted-provider/deterministic tasarlanmış (`src/eval/gauntlet.ts`); string-contains bir zayıflık değil determinizm bedeli olabilir — ayrıca `evalcell` ve LSP gate zaten davranışsal doğrulama yapıyor. B'den bu araçları hesaba katıp katmadığını savunması istendi.
2. **"Circuit breaker yok" iddiasına itiraz:** `src/providers/router.ts` chain advance zaten 429/5xx'te sonraki adaya geçiyor ve oturum-boyu sticky; B'den per-provider breaker'ın ekleyeceği somut senaryo istendi.
3. **"Secrets redaction yok, OTel'e ham çıktılar gidiyor" iddiasına itiraz:** `src/telemetry/otel.ts` header'ı "ids, sizes, outcomes only — never args/output" politikasını açıkça yazıyor; B'den otel.ts'i mi okumadığını yoksa başka bir sızıntı yolunu (session JSONL) mı kastettiğini netleştirmesi istendi.

**B'den gelen yanıt:** Bu raporun kapatıldığı anda henüz ulaşmadı. Koordinatör notu (07:43, `msg_0fc5f777ef51`): B terminali kesintiye uğramış, doğrudan devam ettirildi ve ara bulgularını göndermesi istendi; yanıt geldiğinde çapraz değerlendirme tamamlanacak. Kritiklerim kayıtlı ve B'nin adresinde (`dispatch:ctx_25be630c7dc5`) duruyor; yanıt geldiğinde işlenecek yer burasıdır. B'nin ilk mesajındaki doğrulanabilir iki iddia bu rapora zaten işlendi: OpenHands 5-desenli stuck detector (G12 — kaynakça'da doğrulandı: docs.openhands.dev/sdk/guides/agent-stuck-detector.md) ve "compaction kalitesi ölçülmüyor" genişletmesi (§9 90-gün maddesi ve G1'in doğrulama notu).

---

## 11. Kaynakça (URL · erişim 2026-09-14 · seviye)

**Birincil kaynak kod (A):**
- OpenCode compaction: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/compaction.ts (:28-33 sabitler, :271-294 prune)
- Codex task modeli: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tasks/mod.rs
- Codex compact task (remote V2 / token-budget / lokal üçlüsü): https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tasks/compact.rs
- rovecode: `src/core/{loop,compaction,context,tools,session,orchestrator,guardrails,execpolicy,hooks,reflection,tasks}.ts`, `src/providers/*`, `src/coding/*`, `src/mcp/client.ts`, `src/telemetry/otel.ts`, `src/cli/runtime.ts` (bu repo, 2026-09-14 okundu)

**Resmi dokümanlar (B):**
- OpenCode agents: https://opencode.ai/docs/agents/ · permissions: https://opencode.ai/docs/permissions/
- pi README: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md · compaction internals: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/compaction.md
- Claude Code: how-works https://code.claude.com/docs/en/how-claude-code-works.md · memory https://code.claude.com/docs/en/memory.md · sub-agents https://code.claude.com/docs/en/sub-agents.md · permissions https://code.claude.com/docs/en/permissions.md · model-config https://code.claude.com/docs/en/model-config.md · hooks https://code.claude.com/docs/en/hooks-guide.md · sessions https://code.claude.com/docs/en/sessions.md (index üzerinden) · monitoring https://code.claude.com/docs/en/monitoring-usage.md (index) · index https://code.claude.com/docs/llms.txt
- Codex docs: approvals & security https://learn.chatgpt.com/docs/agent-approvals-security.md · subagents https://learn.chatgpt.com/docs/agent-configuration/subagents.md · index https://developers.openai.com/codex/llms.txt
- aider repomap: https://aider.chat/docs/repomap.html
- Cline index: https://docs.cline.bot/llms.txt · checkpoints: https://docs.cline.bot/core-workflows/checkpoints.md
- Roo Code condensing: https://docs.roocode.com/features/intelligent-context-condensing (+ özellik listesi: codebase-indexing, boomerang-tasks, checkpoints)
- SWE-agent ACI: https://swe-agent.com/latest/background/aci/ (+ mini-swe-agent önerisi) · paper: https://arxiv.org/abs/2405.15793
- OpenHands: backend arch https://docs.openhands.dev/openhands/usage/architecture/backend · SDK agent https://docs.openhands.dev/sdk/arch/agent.md · condenser https://docs.openhands.dev/sdk/arch/condenser.md · stuck detector https://docs.openhands.dev/sdk/guides/agent-stuck-detector.md · index https://docs.openhands.dev/llms.txt · paper: https://arxiv.org/abs/2407.16741
- goose: https://goose-docs.ai/llms.txt · README https://raw.githubusercontent.com/block/goose/main/README.md (org artık aaif-goose)

**İkincil (C):** Chroma context-rot (Codex subagents sayfasının atfı): https://research.trychroma.com/context-rot

**Erişilemedi / doğrulanamadı (dürüstlük notu):** goose'un izin modu ayrıntıları (goose-docs.ai sayfa yolları 404 döndü; yalnızca llms.txt özeti kullanıldı → goose izin/satırları ◐/? işaretli); Cline'ın tool-result truncation sabitleri (docs'ta bulunamadı); pi'nin per-tool truncation detayları; OpenCode'un Effect göçü sonrası processor.ts'in tamamı (compaction.ts doğrulandı, processor doğrulanmadı); Claude Code iç implementasyonu (proprietary — yalnızca docs).
