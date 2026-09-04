import type { PartialDict } from "../en";

export const nl: PartialDict = {
  meta: {
    title: "Rovecode — een codeeragent voor de terminal",
    description: "Open-source codeeragent voor de terminal: TUI-cockpit met panelen, 16 providers of elk OpenAI-compatibel endpoint, deny-default toolbeleid. Bun, AGPL-3.0.",
  },
  nav: { cockpit: "Cockpit", capabilities: "Mogelijkheden", terminal: "Terminal", quickstart: "Snelstart", providers: "Providers", faq: "FAQ" },
  ui: {
    skip: "Naar de inhoud",
    backToTop: "Rovecode, terug naar boven",
    sections: "Secties",
    copy: "kopiëren",
    copied: "gekopieerd",
    copyAria: "Commando kopiëren",
    copiedAria: "Gekopieerd",
    or: "of",
    play: "afspelen",
    pause: "pauzeren",
    playAria: "Achtergrondvideo afspelen",
    pauseAria: "Achtergrondvideo pauzeren",
    language: "Taal",
    sitemap: "Sitemap",
    footerLabel: "Voettekst",
    facts: ["opensource", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "Een codeeragent in de terminal met een *cockpit*, geen chatlog.",
    sub: "Rovecode draait op Bun, praat met 16 providers of met elk OpenAI-compatibel endpoint, en haalt elke gereedschapsaanroep door een beleid dat standaard weigert voordat het je repository raakt. Vrije software onder AGPL-3.0.",
    ctaGithub: "Bekijk op GitHub",
    ctaReadme: "Lees de README",
    caption:
      "Echt beeld: de goedkeuringskaart voor bun test, de bewerkingsregel +4 −1, context op 13 % van 200k. Gerenderd door de sextant-schilders met een vaste klok.",
    quip: "ik wacht op jouw knikje.",
    mood: "geduldig",
    frameAlt:
      "De sextant-TUI op 160 bij 44 cellen: bestandsboom met git-status, het codepaneel met src/auth/callback.ts en de gewijzigde regels gemarkeerd, het berichtenpaneel met lees- en bewerkregels en een goedkeuringskaart die vraagt om bun test uit te voeren, het plan bij stap 1 van 4, 13 procent context gebruikt, en de rovecode-wolkmascotte die om een knikje vraagt.",
    chips: ["+4 −1 geland", "eerst vragen · goedkeuringskaart", "context 13 % van 200k"],
  },
  proof: {
    eyebrow: "uit de repository, bij de build",
    ariaLabel: "Cijfers uit de repository",
    stats: [
      { label: "tests", note: "test()-aanroepen onder test/, geteld bij de build" },
      { label: "ingebouwde providers", note: "plus elke OpenAI-compatibele URL" },
      { label: "beleidslagen", note: "rules · execpolicy · approval · runtime" },
      { label: "talen op deze pagina", note: "gekozen door de browser, te wisselen" },
      { label: "licentie", note: "vrije software, copyleft ook bij netwerkgebruik" },
    ],
  },
  cockpit: {
    eyebrow: "de cockpit",
    title: "Zes panelen op één scherm. Het bestand dat jou aangaat scrollt nooit weg.",
    lead: "Bestanden met git-status, code met de markeerband en ±-diff, compacte gereedschapsregels, plan, verbruik en de mascotte. Zonder scherm gerenderd door de sextant-schilders met een vaste klok: precies het codepad waarmee de TUI tekent, geen mockup.",
    transcriptEyebrow: "berichtenpaneel · regel voor regel",
    transcriptTitle: "Eén run, overgeschreven van het beeld hierboven.",
    transcriptBody1:
      "Elke gereedschapsaanroep is één regel: het werkwoord, het bestand en wat er veranderde. De bewerking landde als +4 −1. Het shell-commando wacht achter één kaart met drie antwoorden; Esc weigert, en het antwoord geldt de rest van de sessie.",
    transcriptBody2: "Kindagenten kunnen niets vragen. Een verboden argv bereikt de kaart helemaal niet.",
  },
  problems: {
    eyebrow: "problemen → oplossingen",
    title: "Vier dingen die misgaan bij terminalagenten, en wat rovecode daaraan doet.",
    lead: "Gezegd zoals je het achter het toetsenbord zou zeggen, beantwoord met het mechanisme en zijn grens. Elke strook is een echte beelduitsnede of het echte configuratiebestand.",
    problemLabel: "probleem",
    solutionLabel: "wat rovecode doet",
    items: [
      {
        problem: "Elke agent komt vastgelast aan de API en de prijspagina van één leverancier.",
        solution:
          "Eén StreamFn-naad en een levend providerregister. 16 benoemde providers, of elk OpenAI- of Anthropic-compatibel endpoint uit providers.json; een provider die je in een andere terminal toevoegt bedient meteen de volgende aanroep. Fallbackketens per rol schuiven door bij een 429 of 5xx.",
      },
      {
        problem: "Een chatlog schuift het bestand dat jou aangaat van het scherm terwijl de agent het bewerkt.",
        solution:
          "Een cockpit met panelen: bestanden, code, berichten, plan, verbruik en de weerwolkmascotte. Het berichtenpaneel houdt elke gereedschapsaanroep op één compacte regel; het codepaneel toont de ene hunk die geland is.",
      },
      {
        problem: "Het model vraagt om rm -rf en het harnas voert het uit omdat niemand op tijd nee zei.",
        solution:
          "Eerst jokerregels die standaard weigeren, dan execpolicy-oordelen waarbij het verbodene noch uitvoering noch een mens bereikt, dan een goedkeuringskaart op de gecorrigeerde argumenten. 4 gestapelde lagen, en geen enkele doet alsof ze een sandbox is.",
      },
      {
        problem: "Beurt 40 loopt mis en de enige weg terug is een nieuw gesprek.",
        solution:
          "Een alleen-toevoegen JSONL-sessieboom met sha256-hashketen. /rewind opent de beurtkiezer, vertakt vanaf elke beurt en vult de editor met de volledige tekst van die beurt; shadow-git-checkpoints herstellen in 3 modi zonder je .git aan te raken.",
      },
    ],
  },
  capabilities: {
    eyebrow: "mogelijkheden",
    title: "Tien mogelijkheden, elk een port met een file:line-spoor.",
    lead: "Rovecode port onderbouwde patronen uit pi, opencode, codex, cline, aider, gemini-cli en andere. Een port landt pas nadat een criticus met verse context hem toetst aan een lat die vóór het werk is geschreven.",
    surfaceLabel: "oppervlak",
    surfaceBody:
      "6 panelen op een truecolor-TTY van minstens 100×30: bestanden met git-status, code met markeerband en ±-diff, compacte gereedschapsregels, plan, verbruik, de mascotte. 3 paletten, /theme wisselt live; --classic behoudt de pi-tui-chat.",
    surfaceAlt: "Uitsnede van het sextant-beeld: bestandsboom en het codepaneel met de markeerband van de bewerking",
    providersLabel: "providers",
    providersTitle: "providers, warm herladen",
    providersBody:
      "16 ingebouwd plus alles wat je in providers.json registreert. Elke aanroep zoekt de provider op in de levende momentopname: voeg er een toe in een andere terminal en de draaiende cockpit gebruikt hem bij de volgende aanroep. Geen herstart.",
    mediumLabels: ["context", "veiligheid", "geheugen"],
    medium: [
      { title: "MCP-client", body: "stdio- en HTTP-servers uit .rovecode/mcp.json. Late onthulling via 2 registergereedschappen, dus een inactieve server kost bijna nul tokens." },
      { title: "Veiligheidsladder", body: "Elke gereedschapsaanroep klimt vier sporten voor hij draait. Een verboden argv wordt geweigerd voordat een hook hem ziet; --yolo slaat vragen over, nooit weigerregels." },
      { title: "Sessieboom + checkpoints", body: "Alleen-toevoegen JSONL met sha256-hashketen. /rewind vertakt, /resume pakt op, shadow-git-checkpoints herstellen in 3 modi en raken je .git nooit aan." },
    ],
    small: [
      { title: "ACP voor Zed + JetBrains", body: "Agent Client Protocol v1 over stdio, officiële SDK." },
      { title: "Headless HTTP + SSE", body: "Sessies, één RunEvent-stroom, OpenAPI op /doc. Poort 4100, alleen loopback." },
      { title: "Subagenten op de achtergrond", body: "Begrensde FIFO-kindsessies, standaard 3 tegelijk; notities landen in de volgende beurt van de ouder." },
      { title: "Hooks", body: "9 getypte hooks in .rovecode/hooks.ts, elk begrensd op 5 s. pre_tool kan alleen weigeren." },
      { title: "OpenTelemetry", body: "Eén trace per run: run ⊃ turn ⊃ tool met tokens, latentie, kosten. Geen endpoint ingesteld, geen exporter." },
    ],
  },
  terminal: {
    eyebrow: "uit de terminal",
    title: "Vier echte beelden op 160×44, met de leeswaardige plekken genummerd.",
    lead: "Zonder scherm gerenderd door de sextant-schilders met een vaste klok: precies het codepad waarmee de TUI tekent, geen mockup. Ga over een beeld om het plat te maken; over een regel om zijn markering te laten oplichten.",
    shots: [
      {
        title: "De bewerking is geland. Het codepaneel toont precies die hunk.",
        lead: "Vastgelegd vóór een goedgekeurde bewerking, na een ongekeurde herbouwd uit de ankers van de bewerking zelf.",
        alt: "sextant-beeld na een bewerking: het codepaneel in diff-modus toont één hunk, het berichtenpaneel toont lees- en bewerkregels",
        callouts: ["Schakel naar ±-diff-modus zodra de bewerking landt", "Lees +4 −1 tegen het bestand op schijf", "Volg de compacte gereedschapsregels: lezen, dan bewerken", "Zie de context vollopen tot 13 % van 200k"],
      },
      {
        title: "Een shell-commando wacht op een knikje. Eén kaart, drie antwoorden.",
        lead: "Goedkeuringen worden op de gecorrigeerde argumenten opgelost en per sessie onthouden; kindagenten kunnen niets vragen.",
        alt: "sextant-beeld met de goedkeuringskaart open: bash bun test tests/auth.test.ts, toestaan altijd weigeren",
        callouts: ["Zie de exacte argv voordat hij draait", "Kies toestaan, altijd of weigeren; Esc weigert", "De kopregel schakelt naar wacht op jou", "De mascotte vraagt om het knikje en onthoudt het"],
      },
      {
        title: "Tests draaiden. Het $-paneel bewaart de uitvoer; de kopregel bevriest de klok.",
        lead: "PASS- en FAIL-labels lezen de exitcode uit de eigen kopregel van het gereedschap.",
        alt: "sextant-beeld na de run: het codepaneel in run-modus toont de bun-test-uitvoer met 18 geslaagd, plan 4/4 klaar",
        callouts: ["Lees de uitvoer in $-modus, 18 geslaagd", "Het plan sluit bij 4/4 stappen", "De gereedschapsregel draagt de laatste uitvoerregel", "De kosten komen op $0.071 uit de offline catalogus"],
      },
      {
        title: "Twee achtergrondtaken, elk een baan, op het bemanningsbord.",
        lead: "Kindsessies delen de ene agentlus; de TUI verlaten annuleert elk levend kind.",
        alt: "sextant-beeld met het bemanningsbord open: twee banen, tests schrijven loopt en review klaar",
        callouts: ["Open het ∷ agents-bord met ⌃a", "Elke baan toont label, verstreken tijd en status", "Het bemanningsoverzicht blijft in het planpaneel", "Ondertussen bewerkt de ouderrun door"],
      },
    ],
  },
  quickstart: {
    eyebrow: "snelstart",
    title: "Drie commando's van kloon tot draaiende agent.",
    lead: "Zonder ingestelde provider gebruiken eenmalige runs een gescripte mock-provider; zo werkt de verpakkingsrooktest ook.",
    steps: [
      { title: "Klonen en linken (Bun ≥ 1.3.14)", body: "Het CLI-startpunt is TypeScript dat bun uitvoert; node kan het niet draaien. bun link zet rovecode op het PATH." },
      { title: "Een model koppelen", body: "rovecode setup leidt je erdoor: kies een provider, plak de sleutel verborgen, één klein testaanroepje, klaar. Of sla een sleutel direct op met rovecode auth set, of richt ROVECODE_BASE_URL op elk OpenAI-compatibel endpoint." },
      { title: "Een taak draaien of de cockpit openen", body: "Kaal rovecode opent het sextant-oppervlak. Een prompt tussen aanhalingstekens is een eenmalige run; --output json geeft precies één resultaatobject terug." },
    ],
    outputAlt: "Uitvoer van de run: 18 geslaagd, 0 mislukt, 41 expect()-aanroepen, 18 tests in 1 bestand.",
  },
  providers: {
    eyebrow: "providers",
    title: "16 ingebouwde providers, of elke OpenAI-compatibele URL.",
    leadA: "Opgeslagen inloggegevens winnen van ",
    leadB: "-omgevingsvariabelen; een expliciet paar ",
    leadC: " wint van beide.",
    hosted: "gehoste api's",
    local: "lokale runtimes",
    keyNote:
      "● lokale runtimes hebben geen sleutel nodig · rovecode auth set <naam> legt een sleutel in ~/.rovecode/credentials.json, gevraagd in de terminal en nooit getoond.",
    liveLabel: "elk endpoint · live",
    liveTitle: "Voeg een provider toe in een andere terminal; de draaiende cockpit pakt hem bij de volgende aanroep. Geen herstart.",
  },
  faq: {
    eyebrow: "faq",
    title: "Bezwaren, met specifieke antwoorden.",
    lead: "Zeven vragen die mensen stellen voordat ze een agent een shell toevertrouwen. Elk antwoord noemt het mechanisme en waar het ophoudt.",
    aside:
      "Alles hier komt uit de README.md-secties Veiligheidsmodel, Bekende beperkingen, Observeerbaarheid en Licentie & vermeldingen. Waar de README een grens noemt, noemt deze pagina hem ook.",
    items: [
      {
        q: "Is het een sandbox?",
        a: "Nee. Vóór en rond elke gereedschapsaanroep draaien vier gestapelde lagen: beleidsregels die standaard weigeren, execpolicy-oordelen (een verboden commando bereikt noch uitvoering noch een mens), de goedkeuringspoort op de gecorrigeerde argumenten, en een runtime-weigerlijst voor bash met een cwd-slot. Waar bash draait is te kiezen — direct, WSL2 of Docker — maar elke sport is delegatie, geen isolatie. Gebruik voor onvertrouwd werk een container of microVM.",
      },
      {
        q: "Welke modellen kan ik gebruiken?",
        a: "Alles wat de 16 benoemde providers leveren, of elk OpenAI- of Anthropic-compatibel endpoint dat in ~/.rovecode/providers.json staat (rovecode provider add) of als ROVECODE_BASE_URL wordt meegegeven. Bij modellen zonder native tool calling zet middleware XML, Hermes of JSON-in-tekst om naar native aanroepen. Vijf rollen (DEFAULT, SMOL, PLAN, COMMIT, TASK) nemen elk een door komma's gescheiden fallbackketen.",
      },
      {
        q: "Belt het naar huis?",
        a: "Nee. Uitgaand verkeer gaat naar de provider die je hebt ingesteld, de MCP-servers die je hebt opgesomd, en naar web_fetch als het model erom vraagt (standaard met vraag, SSRF-beveiligd). OpenTelemetry-export bestaat maar staat uit tot ROVECODE_OTEL_ENDPOINT is gezet, en draagt zelfs dan id's, groottes en uitkomsten, nooit prompts, argumenten of uitvoer. De prijscatalogus is een offline momentopname. Er is geen zelfupdate.",
      },
      {
        q: "Alleen Windows?",
        a: "Windows eerst, niet Windows alleen. Ontwikkeling en de releasepoort draaien op Windows 11 met Git Bash. POSIX-paden worden in tests doorlopen, maar Linux en macOS zijn nog niet in CI geverifieerd. Bun ≥ 1.3.14 is de enige harde eis.",
      },
      {
        q: "Wat gebeurt er als ik midden in een run op Esc druk?",
        a: "De controller van de run breekt af: de lopende provideraanvraag sterft (gemeten ≤2 ms) en de draaiende bash-aanroep wordt gedood. Op Windows zit de starter in een kernel-Job Object, dus de hele processenboom gaat mee; op POSIX krijgt de shell SIGTERM, maar een geforkt kleinkind kan zelfstandig aflopen. Afgebroken runs exporteren hun trace alsnog.",
      },
      {
        q: "Staat het op npm?",
        a: "Nog niet. Installeer vanuit de bron met bun install en bun link, bouw één binary van ~110 MB met bun run build, of maak een tarball met npm pack en installeer die globaal.",
      },
      {
        q: "Wat eist de licentie?",
        a: "AGPL-3.0. Gebruiken, bestuderen, wijzigen en verspreiden; licentie- en auteursrechtvermeldingen op elke kopie en afgeleide behouden. Draai je een gewijzigde rovecode als netwerkdienst, dan moet je de volledige broncode aanbieden aan de gebruikers van die dienst. Vermeldingen van derden staan in THIRD_PARTY_NOTICES.md; geen code komt uit crush (FSL), claw-code, nanocoder, iflow of de Claude Agent SDK.",
      },
    ],
  },
  cta: { eyebrow: "haal rovecode", title: "Zes panelen. Zestien providers. Nul prijspagina.", button: "Ster op GitHub", quip: "de zon is er.", mood: "zonnig" },
  footer: {
    blurb: "Een codeeragent voor de terminal. TypeScript op Bun, 47 overgezette patronen, één beleid dat standaard weigert vóór elk gereedschap.",
    notice: "Overgezette bronnen zijn uitsluitend MIT of Apache-2.0; vermeldingen in THIRD_PARTY_NOTICES.md.",
    heads: ["Project", "Oppervlakken", "Configuratie", "Veiligheid"],
  },
  pet: {
    alt: "Rovecode, de wolkmascotte",
    edit: "met een potlood",
    read: "kijkend door een vergrootglas",
    guard: "met een schild",
    rewind: "met een klok met terugpijl",
    done: "met de duim omhoog",
  },
};
