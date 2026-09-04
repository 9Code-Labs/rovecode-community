import type { PartialDict } from "../en";

export const it: PartialDict = {
  meta: {
    title: "Rovecode — un agente di codice per il terminale",
    description: "Agente di programmazione open source per il terminale: cockpit TUI a pannelli, 16 provider o qualsiasi endpoint compatibile OpenAI, policy deny-default. Bun, AGPL-3.0.",
  },
  nav: { cockpit: "Cabina", capabilities: "Capacità", terminal: "Terminale", quickstart: "Avvio rapido", providers: "Provider", faq: "FAQ" },
  ui: {
    skip: "Vai al contenuto",
    backToTop: "Rovecode, torna su",
    sections: "Sezioni",
    copy: "copia",
    copied: "copiato",
    copyAria: "Copia il comando",
    copiedAria: "Copiato",
    or: "oppure",
    play: "riproduci",
    pause: "pausa",
    playAria: "Riproduci il video di sfondo",
    pauseAria: "Metti in pausa il video di sfondo",
    language: "Lingua",
    sitemap: "Mappa del sito",
    footerLabel: "Piè di pagina",
    facts: ["open source", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "Un agente di codice da terminale con una *cabina*, non un registro di chat.",
    sub: "Rovecode gira su Bun, parla con 16 provider o con qualsiasi endpoint compatibile con OpenAI e fa passare ogni chiamata di strumento attraverso una politica che nega per impostazione predefinita prima che tocchi il tuo repository. Software libero sotto AGPL-3.0.",
    ctaGithub: "Guarda su GitHub",
    ctaReadme: "Leggi il README",
    caption:
      "Fotogramma reale: la scheda di approvazione per bun test, la riga di modifica +4 −1, contesto al 13 % di 200k. Reso dai pittori di sextant con orologio fisso.",
    quip: "mi serve il tuo assenso.",
    mood: "paziente",
    frameAlt:
      "La TUI sextant a 160 per 44 celle: albero dei file con stato git, il pannello del codice che mostra src/auth/callback.ts con le righe modificate evidenziate, il pannello dei messaggi con righe di strumento lettura e modifica e una scheda di approvazione che chiede di eseguire bun test, il piano al passo 1 di 4, il 13 per cento di contesto usato e la mascotte nuvola rovecode che chiede l'assenso.",
    chips: ["+4 −1 applicato", "prima chiedi · scheda di approvazione", "contesto 13 % di 200k"],
  },
  proof: {
    eyebrow: "dal repository, al momento della build",
    ariaLabel: "Numeri dal repository",
    stats: [
      { label: "test", note: "chiamate test() in test/, contate alla build" },
      { label: "provider integrati", note: "più qualsiasi URL compatibile con OpenAI" },
      { label: "livelli di policy", note: "rules · execpolicy · approval · runtime" },
      { label: "lingue in questa pagina", note: "scelta dal browser, modificabile" },
      { label: "licenza", note: "software libero, copyleft anche per l'uso in rete" },
    ],
  },
  cockpit: {
    eyebrow: "la cabina",
    title: "Sei pannelli su uno schermo. Il file che ti interessa non scorre mai via.",
    lead: "File con stato git, codice con la fascia di evidenziazione e diff ±, righe di strumento compatte, piano, uso e la mascotte. Reso senza schermo dai pittori di sextant con orologio fisso: lo stesso percorso di codice con cui disegna la TUI, non un mockup.",
    transcriptEyebrow: "pannello messaggi · riga per riga",
    transcriptTitle: "Un'esecuzione, trascritta dal fotogramma qui sopra.",
    transcriptBody1:
      "Ogni chiamata di strumento è una riga: il verbo, il file e cosa è cambiato. La modifica è atterrata come +4 −1. Il comando di shell attende dietro una scheda con tre risposte; Esc nega, e la risposta vale per il resto della sessione.",
    transcriptBody2: "Gli agenti figli non possono chiedere. Un argv proibito non arriva mai alla scheda.",
  },
  problems: {
    eyebrow: "problemi → soluzioni",
    title: "Quattro cose che vanno storte con gli agenti da terminale, e cosa fa rovecode per ciascuna.",
    lead: "Dette come le diresti alla tastiera, risolte con il meccanismo e il suo limite. Ogni striscia è un vero ritaglio di fotogramma o il vero file di configurazione.",
    problemLabel: "problema",
    solutionLabel: "cosa fa rovecode",
    items: [
      {
        problem: "Ogni agente arriva saldato all'API di un solo fornitore e al suo listino prezzi.",
        solution:
          "Una sola giunzione StreamFn e un registro provider vivo. 16 provider con nome, o qualsiasi endpoint compatibile con OpenAI o Anthropic da providers.json; un provider aggiunto in un altro terminale serve già la chiamata successiva. Le catene di ripiego per ruolo avanzano su un 429 o un 5xx.",
      },
      {
        problem: "Un registro di chat spinge fuori schermo il file che ti interessa mentre l'agente lo modifica.",
        solution:
          "Una cabina a pannelli: file, codice, messaggi, piano, uso e la mascotte nuvola. Il pannello dei messaggi tiene ogni chiamata di strumento su una riga compatta; il pannello del codice mostra l'unico blocco atterrato.",
      },
      {
        problem: "Il modello chiede rm -rf e l'impalcatura lo esegue perché nessuno ha detto no in tempo.",
        solution:
          "Prima regole jolly che negano per impostazione predefinita, poi verdetti execpolicy dove il proibito non arriva né all'esecuzione né a una persona, poi una scheda di approvazione sugli argomenti corretti. 4 strati sovrapposti, e nessuno finge di essere una sandbox.",
      },
      {
        problem: "Il turno 40 va storto e l'unico modo di tornare indietro è una nuova conversazione.",
        solution:
          "Un albero di sessione JSONL a sola aggiunta con catena di hash sha256. /rewind apre il selettore dei turni, dirama da qualsiasi turno e precompila l'editor con il suo testo completo; i checkpoint shadow-git ripristinano in 3 modalità senza toccare il tuo .git.",
      },
    ],
  },
  capabilities: {
    eyebrow: "capacità",
    title: "Dieci capacità, ognuna un port con la sua traccia file:line.",
    lead: "Rovecode porta pattern documentati da pi, opencode, codex, cline, aider, gemini-cli e altri. Un port atterra solo dopo che un critico a contesto nuovo lo verifica contro un'asticella scritta prima di iniziare.",
    surfaceLabel: "superficie",
    surfaceBody:
      "6 pannelli su un TTY truecolor di almeno 100×30: file con stato git, codice con fascia di evidenziazione e diff ±, righe di strumento compatte, piano, uso, la mascotte. 3 palette, /theme cambia a caldo; --classic mantiene la chat pi-tui.",
    surfaceAlt: "Ritaglio del fotogramma sextant: albero dei file e pannello del codice con la fascia di evidenziazione della modifica",
    providersLabel: "provider",
    providersTitle: "provider ricaricati a caldo",
    providersBody:
      "16 integrati più tutto ciò che registri in providers.json. Ogni chiamata risolve il provider sull'istantanea viva: aggiungine uno in un altro terminale e la cabina in esecuzione lo usa alla chiamata successiva. Nessun riavvio.",
    mediumLabels: ["contesto", "sicurezza", "memoria"],
    medium: [
      { title: "Client MCP", body: "Server stdio e HTTP da .rovecode/mcp.json. Rivelazione pigra tramite 2 strumenti di registro, così un server inattivo costa quasi zero token." },
      { title: "Scala di sicurezza", body: "Ogni chiamata di strumento sale quattro pioli prima di eseguire. Un argv proibito è negato prima che un hook lo veda; --yolo salta le richieste, mai le regole di rifiuto." },
      { title: "Albero di sessione + checkpoint", body: "JSONL a sola aggiunta con catena di hash sha256. /rewind dirama, /resume riprende, i checkpoint shadow-git ripristinano in 3 modalità e non toccano mai il tuo .git." },
    ],
    small: [
      { title: "ACP per Zed + JetBrains", body: "Agent Client Protocol v1 su stdio, SDK ufficiale." },
      { title: "HTTP + SSE senza interfaccia", body: "Sessioni, un flusso RunEvent, OpenAPI su /doc. Porta 4100, solo loopback." },
      { title: "Subagenti in background", body: "Sessioni figlie FIFO limitate, 3 in parallelo di default; le note arrivano al turno successivo del genitore." },
      { title: "Hook", body: "9 hook tipizzati in .rovecode/hooks.ts, ciascuno limitato a 5 s. pre_tool può solo negare." },
      { title: "OpenTelemetry", body: "Una traccia per esecuzione: run ⊃ turn ⊃ tool con token, latenza, costo. Endpoint non impostato, nessun exporter." },
    ],
  },
  terminal: {
    eyebrow: "dal terminale",
    title: "Quattro fotogrammi reali a 160×44, con le parti da leggere numerate.",
    lead: "Resi senza schermo dai pittori di sextant con orologio fisso: lo stesso percorso di codice con cui disegna la TUI, non un mockup. Passa sul fotogramma per appiattirlo; su una riga per accendere il suo segno.",
    shots: [
      {
        title: "La modifica è atterrata. Il pannello del codice mostra esattamente quel blocco.",
        lead: "Catturato prima di una modifica approvata, ricostruito dalle ancore della modifica stessa dopo una non approvata.",
        alt: "fotogramma sextant dopo una modifica: il pannello del codice in modalità diff mostra un blocco, il pannello dei messaggi elenca righe di lettura e modifica",
        callouts: ["Passa alla modalità diff ± quando la modifica atterra", "Leggi +4 −1 rispetto al file su disco", "Segui le righe compatte: lettura, poi modifica", "Guarda il contesto riempirsi al 13 % di 200k"],
      },
      {
        title: "Un comando di shell attende un assenso. Una scheda, tre risposte.",
        lead: "Le approvazioni si risolvono sugli argomenti corretti e restano in memoria per sessione; gli agenti figli non possono chiedere.",
        alt: "fotogramma sextant con la scheda di approvazione aperta: bash bun test tests/auth.test.ts, consenti sempre nega",
        callouts: ["Vedi l'argv esatto prima che parta", "Scegli consenti, sempre o nega; Esc nega", "L'intestazione passa a in attesa di te", "La mascotte chiede l'assenso, poi lo ricorda"],
      },
      {
        title: "I test sono girati. Il pannello $ tiene l'output; l'intestazione congela l'orologio.",
        lead: "Le etichette PASS e FAIL leggono il codice di uscita dalla riga di intestazione dello strumento stesso.",
        alt: "fotogramma sextant dopo l'esecuzione: il pannello del codice in modalità run mostra l'output di bun test con 18 superati, piano 4/4 completo",
        callouts: ["Leggi l'output in modalità $, 18 superati", "Il piano chiude a 4/4 passi", "La riga di strumento porta l'ultima riga di output", "Il costo si ferma a $0.071 dal catalogo offline"],
      },
      {
        title: "Due attività in background, una corsia ciascuna, sulla lavagna dell'equipaggio.",
        lead: "Le sessioni figlie condividono l'unico ciclo dell'agente; uscire dalla TUI annulla ogni figlio vivo.",
        alt: "fotogramma sextant con la lavagna dell'equipaggio aperta: due corsie, scrittura test in corso e revisione conclusa",
        callouts: ["Apri la lavagna ∷ agents con ⌃a", "Ogni corsia mostra etichetta, tempo e stato", "Il riepilogo dell'equipaggio resta nel pannello del piano", "Intanto l'esecuzione madre continua a modificare"],
      },
    ],
  },
  quickstart: {
    eyebrow: "avvio rapido",
    title: "Tre comandi dal clone a un agente in esecuzione.",
    lead: "Senza un provider configurato, le esecuzioni singole usano un provider finto scriptato: è così che funziona anche lo smoke test del pacchetto.",
    steps: [
      { title: "Clona e collega (Bun ≥ 1.3.14)", body: "Il punto di ingresso della CLI è TypeScript eseguito da bun; node non può avviarlo. bun link mette rovecode nel PATH." },
      { title: "Collega un modello", body: "rovecode setup ti guida: scegli un provider, incolla la chiave nascosta, una piccola chiamata di prova, fatto. Oppure salva una chiave direttamente con rovecode auth set, o punta ROVECODE_BASE_URL a qualsiasi endpoint compatibile con OpenAI." },
      { title: "Avvia un'attività o apri la cabina", body: "rovecode da solo apre la superficie sextant. Un prompt tra virgolette è un'esecuzione singola; --output json restituisce esattamente un oggetto risultato." },
    ],
    outputAlt: "Output dell'esecuzione: 18 superati, 0 falliti, 41 chiamate expect(), 18 test in 1 file.",
  },
  providers: {
    eyebrow: "provider",
    title: "16 provider integrati, o qualsiasi URL compatibile con OpenAI.",
    leadA: "Le credenziali salvate battono le variabili d'ambiente ",
    leadB: "; una coppia esplicita ",
    leadC: " batte entrambe.",
    hosted: "api ospitate",
    local: "runtime locali",
    keyNote:
      "● i runtime locali non richiedono chiave · rovecode auth set <nome> salva una chiave in ~/.rovecode/credentials.json, chiesta nel terminale e mai stampata.",
    liveLabel: "qualsiasi endpoint · a caldo",
    liveTitle: "Aggiungi un provider in un altro terminale; la cabina in esecuzione lo prende alla chiamata successiva. Nessun riavvio.",
  },
  faq: {
    eyebrow: "faq",
    title: "Obiezioni, con risposte precise.",
    lead: "Sette domande che si fanno prima di affidare una shell a un agente. Ogni risposta nomina il meccanismo e dove si ferma.",
    aside:
      "Tutto qui è preso dalle sezioni Modello di sicurezza, Limiti noti, Osservabilità e Licenza e note del README.md. Dove il README dice che c'è un limite, lo dice anche questa pagina.",
    items: [
      {
        q: "È una sandbox?",
        a: "No. Prima e attorno a ogni chiamata di strumento girano quattro strati sovrapposti: regole di politica che negano per impostazione predefinita, verdetti execpolicy (un comando proibito non arriva né all'esecuzione né a una persona), il cancello di approvazione sugli argomenti corretti e una lista di rifiuto per bash a runtime con blocco della cwd. Dove gira bash è selezionabile — diretto, WSL2 o Docker — ma ogni piolo è delega, non isolamento. Per lavoro non fidato usa un container o una microVM.",
      },
      {
        q: "Quali modelli posso usare?",
        a: "Tutto ciò che servono i 16 provider con nome, o qualsiasi endpoint compatibile con OpenAI o Anthropic registrato in ~/.rovecode/providers.json (rovecode provider add) o passato come ROVECODE_BASE_URL. Per i modelli senza tool calling nativo, il middleware converte XML, Hermes o JSON nel testo in chiamate native. Cinque ruoli (DEFAULT, SMOL, PLAN, COMMIT, TASK) accettano ciascuno una catena di ripiego separata da virgole.",
      },
      {
        q: "Telefona a casa?",
        a: "No. Il traffico in uscita va al provider che hai configurato, ai server MCP che hai elencato e a web_fetch quando il modello lo chiede (con richiesta per impostazione predefinita, protetto da SSRF). L'export OpenTelemetry esiste ma è spento finché non imposti ROVECODE_OTEL_ENDPOINT, e anche allora porta id, dimensioni ed esiti, mai prompt, argomenti o output. Il catalogo prezzi è un'istantanea offline. Non c'è autoaggiornamento.",
      },
      {
        q: "Solo Windows?",
        a: "Windows per primo, non solo Windows. Sviluppo e cancello di rilascio girano su Windows 11 con Git Bash. I percorsi POSIX sono esercitati nei test, ma Linux e macOS non sono ancora verificati in CI. Bun ≥ 1.3.14 è l'unico requisito rigido.",
      },
      {
        q: "Cosa succede se premo Esc a metà esecuzione?",
        a: "Il controller dell'esecuzione annulla: la richiesta al provider in volo muore (≤2 ms misurati) e la chiamata bash in corso viene uccisa. Su Windows il lanciatore sta in un Job Object del kernel, quindi se ne va l'intero albero di processi; su POSIX la shell riceve SIGTERM ma un nipote forkato può finire da solo. Le esecuzioni annullate esportano comunque la loro traccia.",
      },
      {
        q: "È su npm?",
        a: "Non ancora. Installa dai sorgenti con bun install e bun link, costruisci un singolo binario da ~110 MB con bun run build, oppure genera un tarball con npm pack e installalo globalmente.",
      },
      {
        q: "Cosa richiede la licenza?",
        a: "AGPL-3.0. Usare, studiare, modificare e ridistribuire; mantenere licenza e note di copyright su ogni copia e derivato. Se esegui un rovecode modificato come servizio di rete devi offrirne il sorgente completo agli utenti di quel servizio. Le attribuzioni di terze parti stanno in THIRD_PARTY_NOTICES.md; nessun codice viene da crush (FSL), claw-code, nanocoder, iflow o dal Claude Agent SDK.",
      },
    ],
  },
  cta: { eyebrow: "prendi rovecode", title: "Sei pannelli. Sedici provider. Zero listino prezzi.", button: "Metti una stella su GitHub", quip: "è uscito il sole.", mood: "soleggiato" },
  footer: {
    blurb: "Un agente di codice per il terminale. TypeScript su Bun, 47 pattern portati, una politica che nega per impostazione predefinita davanti a ogni strumento.",
    notice: "Le fonti portate sono solo MIT o Apache-2.0; attribuzioni in THIRD_PARTY_NOTICES.md.",
    heads: ["Progetto", "Superfici", "Configurazione", "Sicurezza"],
  },
  pet: {
    alt: "Rovecode, la mascotte nuvola",
    edit: "con una matita",
    read: "che guarda con una lente",
    guard: "con uno scudo",
    rewind: "con un orologio dalla freccia all'indietro",
    done: "con il pollice in su",
  },
};
