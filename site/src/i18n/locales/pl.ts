import type { PartialDict } from "../en";

export const pl: PartialDict = {
  meta: {
    title: "Rovecode — agent kodujący do terminala",
    description:
      "Rovecode to otwartoźródłowy agent kodujący do terminala: kokpit TUI z panelami, 16 wbudowanych dostawców albo dowolny endpoint zgodny z OpenAI, polityka narzędzi odmawiająca domyślnie i drzewo sesji z cofaniem. TypeScript na Bun, AGPL-3.0.",
  },
  nav: { cockpit: "Kokpit", capabilities: "Możliwości", terminal: "Terminal", quickstart: "Szybki start", providers: "Dostawcy", faq: "FAQ" },
  ui: {
    skip: "Przejdź do treści",
    backToTop: "Rovecode, powrót na górę",
    sections: "Sekcje",
    copy: "kopiuj",
    copied: "skopiowano",
    copyAria: "Kopiuj polecenie",
    copiedAria: "Skopiowano",
    or: "albo",
    play: "odtwórz",
    pause: "pauza",
    playAria: "Odtwórz wideo w tle",
    pauseAria: "Wstrzymaj wideo w tle",
    language: "Język",
    sitemap: "Mapa strony",
    footerLabel: "Stopka",
    facts: ["otwarte źródła", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "Agent kodujący w terminalu z *kokpitem*, a nie z zapisem czatu.",
    sub: "Rovecode działa na Bun, rozmawia z 16 dostawcami albo z dowolnym endpointem zgodnym z OpenAI i przepuszcza każde wywołanie narzędzia przez politykę odmawiającą domyślnie, zanim dotknie twojego repozytorium. Wolne oprogramowanie na licencji AGPL-3.0.",
    ctaGithub: "Zobacz na GitHubie",
    ctaReadme: "Przeczytaj README",
    caption:
      "Prawdziwa klatka: karta zgody dla bun test, wiersz edycji +4 −1, kontekst na 13 % z 200k. Wyrenderowane przez malarzy sextant przy ustalonym zegarze.",
    quip: "czekam na twoje kiwnięcie.",
    mood: "cierpliwy",
    frameAlt:
      "TUI sextant o rozmiarze 160 na 44 komórki: drzewo plików ze statusem gita, panel kodu pokazujący src/auth/callback.ts z podświetlonymi zmienionymi wierszami, panel wiadomości z wierszami narzędzi czytania i edycji oraz karta zgody prosząca o uruchomienie bun test, plan na kroku 1 z 4, 13 procent zużytego kontekstu i chmurkowa maskotka rovecode prosząca o kiwnięcie.",
    chips: ["+4 −1 weszło", "najpierw pytaj · karta zgody", "kontekst 13 % z 200k"],
  },
  proof: {
    eyebrow: "z repozytorium, 2026-09-02",
    ariaLabel: "Liczby z repozytorium",
    stats: [
      { label: "testy", note: "jednostkowe + integracyjne, bun test" },
      { label: "przeniesione wzorce", note: "każdy prowadzi do file:line w zamrożonym źródle" },
      { label: "panele", note: "pliki · kod · wiadomości · plan · zużycie · rovecode" },
      { label: "wbudowani dostawcy", note: "plus dowolny URL zgodny z OpenAI" },
      { label: "licencja", note: "wolne oprogramowanie, copyleft także przy użyciu sieciowym" },
    ],
  },
  cockpit: {
    eyebrow: "kokpit",
    title: "Sześć paneli na jednym ekranie. Plik, który cię interesuje, nigdy nie ucieka w górę.",
    lead: "Pliki ze statusem gita, kod z pasem podświetlenia i różnicą ±, zwarte wiersze narzędzi, plan, zużycie i maskotka. Renderowane bez ekranu przez malarzy sextant przy ustalonym zegarze: dokładnie ta sama ścieżka kodu, którą rysuje TUI, a nie makieta.",
    transcriptEyebrow: "panel wiadomości · wiersz po wierszu",
    transcriptTitle: "Jedno uruchomienie, przepisane z klatki powyżej.",
    transcriptBody1:
      "Każde wywołanie narzędzia to jeden wiersz: czasownik, plik i to, co się zmieniło. Edycja weszła jako +4 −1. Polecenie powłoki czeka za jedną kartą z trzema odpowiedziami; Esc odmawia, a odpowiedź obowiązuje do końca sesji.",
    transcriptBody2: "Agenci potomni nie mogą pytać. Zabronione argv nigdy nie dociera do karty.",
  },
  problems: {
    eyebrow: "problemy → rozwiązania",
    title: "Cztery rzeczy, które psują się w agentach terminalowych, i co rovecode robi z każdą.",
    lead: "Powiedziane tak, jak powiedziałbyś przy klawiaturze, rozwiązane mechanizmem i jego granicą. Każdy pasek to prawdziwy wycinek klatki albo prawdziwy plik konfiguracyjny.",
    problemLabel: "problem",
    solutionLabel: "co robi rovecode",
    items: [
      {
        problem: "Każdy agent przychodzi zespawany z API jednego dostawcy i jego cennikiem.",
        solution:
          "Jeden szew StreamFn i żywy rejestr dostawców. 16 nazwanych dostawców albo dowolny endpoint zgodny z OpenAI lub Anthropic z providers.json; dostawca dodany w innym terminalu obsłuży już następne wywołanie. Łańcuchy zapasowe dla roli przesuwają się przy 429 lub 5xx.",
      },
      {
        problem: "Zapis czatu wypycha z ekranu plik, który agent właśnie edytuje.",
        solution:
          "Kokpit z panelami: pliki, kod, wiadomości, plan, zużycie i chmurkowa maskotka. Panel wiadomości trzyma każde wywołanie narzędzia w jednym zwartym wierszu; panel kodu pokazuje jedyny fragment, który wszedł.",
      },
      {
        problem: "Model prosi o rm -rf, a szkielet to wykonuje, bo nikt nie powiedział nie na czas.",
        solution:
          "Najpierw reguły z wieloznacznikami odmawiające domyślnie, potem wyroki execpolicy, gdzie zabronione nie dociera ani do wykonania, ani do człowieka, a potem karta zgody na poprawionych argumentach. 4 nałożone warstwy i żadna nie udaje piaskownicy.",
      },
      {
        problem: "Tura 40 idzie źle, a jedyna droga powrotu to nowa rozmowa.",
        solution:
          "Drzewo sesji JSONL tylko do dopisywania, z łańcuchem skrótów sha256. /rewind otwiera wybór tur, rozgałęzia się z dowolnej i wypełnia edytor pełnym tekstem tej tury; punkty kontrolne shadow-git przywracają w 3 trybach, nie tykając twojego .git.",
      },
    ],
  },
  capabilities: {
    eyebrow: "możliwości",
    title: "Dziesięć możliwości, każda to port ze śladem file:line.",
    lead: "Rovecode przenosi udokumentowane wzorce z pi, opencode, codex, cline, aider, gemini-cli i innych. Port wchodzi dopiero wtedy, gdy krytyk ze świeżym kontekstem sprawdzi go wobec poprzeczki zapisanej przed rozpoczęciem pracy.",
    surfaceLabel: "powierzchnia",
    surfaceBody:
      "6 paneli na TTY truecolor o co najmniej 100×30: pliki ze statusem gita, kod z pasem podświetlenia i różnicą ±, zwarte wiersze narzędzi, plan, zużycie, maskotka. 3 palety, /theme przełącza na gorąco; --classic zachowuje czat pi-tui.",
    surfaceAlt: "Wycinek klatki sextant: drzewo plików i panel kodu z pasem podświetlenia edycji",
    providersLabel: "dostawcy",
    providersTitle: "dostawcy przeładowywani na gorąco",
    providersBody:
      "16 wbudowanych plus wszystko, co zarejestrujesz w providers.json. Każde wywołanie rozwiązuje dostawcę wobec żywej migawki: dodaj jednego w innym terminalu, a działający kokpit użyje go przy następnym wywołaniu. Bez restartu.",
    mediumLabels: ["kontekst", "bezpieczeństwo", "pamięć"],
    medium: [
      { title: "Klient MCP", body: "Serwery stdio i HTTP z .rovecode/mcp.json. Leniwe ujawnianie przez 2 narzędzia rejestru, więc bezczynny serwer kosztuje prawie zero tokenów." },
      { title: "Drabina bezpieczeństwa", body: "Każde wywołanie narzędzia wchodzi na cztery szczeble, zanim się wykona. Zabronione argv zostaje odrzucone, zanim zobaczy je jakikolwiek hook; --yolo pomija pytania, nigdy reguł odmowy." },
      { title: "Drzewo sesji + punkty kontrolne", body: "JSONL tylko do dopisywania z łańcuchem skrótów sha256. /rewind rozgałęzia, /resume podejmuje, punkty shadow-git przywracają w 3 trybach i nigdy nie tykają twojego .git." },
    ],
    small: [
      { title: "ACP dla Zed + JetBrains", body: "Agent Client Protocol v1 po stdio, oficjalny SDK." },
      { title: "Bezgłowe HTTP + SSE", body: "Sesje, jeden strumień RunEvent, OpenAPI pod /doc. Port 4100, tylko pętla lokalna." },
      { title: "Podagenci w tle", body: "Ograniczone sesje potomne FIFO, domyślnie 3 równolegle; notatki trafiają w następnej turze rodzica." },
      { title: "Hooki", body: "9 typowanych hooków w .rovecode/hooks.ts, każdy z limitem 5 s. pre_tool może tylko odmówić." },
      { title: "OpenTelemetry", body: "Jeden ślad na uruchomienie: run ⊃ turn ⊃ tool z tokenami, opóźnieniem i kosztem. Brak endpointu, brak eksportera." },
    ],
  },
  terminal: {
    eyebrow: "z terminala",
    title: "Cztery prawdziwe klatki w 160×44, z ponumerowanymi miejscami wartymi przeczytania.",
    lead: "Renderowane bez ekranu przez malarzy sextant przy ustalonym zegarze: dokładnie ta sama ścieżka kodu, którą rysuje TUI, a nie makieta. Najedź na klatkę, by ją spłaszczyć; na wiersz, by zaświecić jego znacznik.",
    shots: [
      {
        title: "Edycja weszła. Panel kodu pokazuje dokładnie ten fragment.",
        lead: "Uchwycone przed zatwierdzoną edycją, odtworzone z własnych zakotwiczeń edycji po takiej bez zgody.",
        alt: "klatka sextant po edycji: panel kodu w trybie różnicy pokazuje jeden fragment, panel wiadomości wymienia wiersze czytania i edycji",
        callouts: ["Przełącz na tryb różnicy ±, gdy edycja wchodzi", "Przeczytaj +4 −1 wobec pliku na dysku", "Idź za zwartymi wierszami: czytanie, potem edycja", "Patrz, jak kontekst rośnie do 13 % z 200k"],
      },
      {
        title: "Polecenie powłoki czeka na kiwnięcie. Jedna karta, trzy odpowiedzi.",
        lead: "Zgody rozstrzygają się na poprawionych argumentach i są pamiętane w sesji; agenci potomni nie mogą pytać.",
        alt: "klatka sextant z otwartą kartą zgody: bash bun test tests/auth.test.ts, pozwól zawsze odmów",
        callouts: ["Zobacz dokładne argv, zanim się wykona", "Wybierz pozwól, zawsze albo odmów; Esc odmawia", "Nagłówek przechodzi w czeka na ciebie", "Maskotka prosi o kiwnięcie, a potem je pamięta"],
      },
      {
        title: "Testy przeszły. Panel $ trzyma wyjście; nagłówek zatrzymuje zegar.",
        lead: "Plakietki PASS i FAIL czytają kod wyjścia z własnego wiersza nagłówka narzędzia.",
        alt: "klatka sextant po zakończeniu: panel kodu w trybie run pokazuje wyjście bun test z 18 zaliczonymi, plan 4/4 gotowy",
        callouts: ["Przeczytaj wyjście w trybie $, 18 zaliczonych", "Plan zamyka się na 4/4 krokach", "Wiersz narzędzia nosi ostatni wiersz wyjścia", "Koszt wypada na $0.071 z katalogu offline"],
      },
      {
        title: "Dwa zadania w tle, po jednym torze, na tablicy załogi.",
        lead: "Sesje potomne dzielą jedną pętlę agenta; wyjście z TUI anuluje każde żywe dziecko.",
        alt: "klatka sextant z otwartą tablicą załogi: dwa tory, pisanie testów w toku i recenzja gotowa",
        callouts: ["Otwórz tablicę ∷ agents przez ⌃a", "Każdy tor pokazuje etykietę, czas i status", "Podsumowanie załogi zostaje w panelu planu", "W tym czasie uruchomienie nadrzędne dalej edytuje"],
      },
    ],
  },
  quickstart: {
    eyebrow: "szybki start",
    title: "Trzy polecenia od klonowania do działającego agenta.",
    lead: "Bez skonfigurowanego dostawcy pojedyncze uruchomienia używają skryptowanego dostawcy pozornego — tak działa też dymny test pakowania.",
    steps: [
      { title: "Sklonuj i zlinkuj (Bun ≥ 1.3.14)", body: "Wejście CLI to TypeScript uruchamiany przez bun; node go nie odpali. bun link umieszcza rovecode w PATH." },
      { title: "Podłącz model", body: "rovecode setup przeprowadza krok po kroku: wybierz dostawcę, wklej klucz ukryty, jedno małe wywołanie testowe, gotowe. Albo zapisz klucz wprost przez rovecode auth set, albo skieruj ROVECODE_BASE_URL na dowolny endpoint zgodny z OpenAI." },
      { title: "Uruchom zadanie albo otwórz kokpit", body: "Samo rovecode otwiera powierzchnię sextant. Zapytanie w cudzysłowach to jednorazowe uruchomienie; --output json zwraca dokładnie jeden obiekt wyniku." },
    ],
    outputAlt: "Wyjście uruchomienia: 18 zaliczonych, 0 błędów, 41 wywołań expect(), 18 testów w 1 pliku.",
  },
  providers: {
    eyebrow: "dostawcy",
    title: "16 wbudowanych dostawców albo dowolny URL zgodny z OpenAI.",
    leadA: "Zapisane dane uwierzytelniające biją zmienne środowiskowe ",
    leadB: "; jawna para ",
    leadC: " bije oba.",
    hosted: "api hostowane",
    local: "lokalne runtime'y",
    keyNote:
      "● lokalne runtime'y nie potrzebują klucza · rovecode auth set <nazwa> zapisuje klucz w ~/.rovecode/credentials.json, pytany w terminalu i nigdy nie wypisywany.",
    liveLabel: "dowolny endpoint · na żywo",
    liveTitle: "Dodaj dostawcę w innym terminalu; działający kokpit weźmie go przy następnym wywołaniu. Bez restartu.",
  },
  faq: {
    eyebrow: "faq",
    title: "Zarzuty, odpowiedzi z konkretami.",
    lead: "Siedem pytań, które ludzie zadają, zanim powierzą agentowi powłokę. Każda odpowiedź nazywa mechanizm i miejsce, gdzie się kończy.",
    aside:
      "Wszystko tutaj pochodzi z sekcji README.md: Model bezpieczeństwa, Znane ograniczenia, Obserwowalność oraz Licencja i noty. Gdzie README mówi o granicy, mówi o niej też ta strona.",
    items: [
      {
        q: "Czy to piaskownica?",
        a: "Nie. Przed każdym wywołaniem narzędzia i wokół niego działają cztery nałożone warstwy: reguły polityki odmawiające domyślnie, wyroki execpolicy (zabronione polecenie nie dociera ani do wykonania, ani do człowieka), brama zgody na poprawionych argumentach oraz lista odmów bash w czasie działania z blokadą cwd. Miejsce, gdzie działa bash, jest wybieralne — bezpośrednio, WSL2 albo Docker — ale każdy szczebel to delegacja, nie izolacja. Do niezaufanej pracy użyj kontenera albo mikroVM.",
      },
      {
        q: "Jakich modeli mogę używać?",
        a: "Wszystkiego, co podają 16 nazwanych dostawców, albo dowolnego endpointu zgodnego z OpenAI lub Anthropic zarejestrowanego w ~/.rovecode/providers.json (rovecode provider add) lub podanego jako ROVECODE_BASE_URL. W modelach bez rodzimego wywoływania narzędzi warstwa pośrednia zamienia XML, Hermes albo JSON w tekście na wywołania rodzime. Pięć roli (DEFAULT, SMOL, PLAN, COMMIT, TASK) przyjmuje po jednym łańcuchu zapasowym rozdzielonym przecinkami.",
      },
      {
        q: "Czy dzwoni do domu?",
        a: "Nie. Ruch wychodzący idzie do dostawcy, którego skonfigurowałeś, do serwerów MCP, które wymieniłeś, i do web_fetch, gdy model o to poprosi (domyślnie z pytaniem, z ochroną przed SSRF). Eksport OpenTelemetry istnieje, ale jest wyłączony, dopóki nie ustawisz ROVECODE_OTEL_ENDPOINT, a i wtedy niesie identyfikatory, rozmiary i wyniki, nigdy zapytań, argumentów ani wyjścia. Katalog cen to migawka offline. Nie ma samoaktualizacji.",
      },
      {
        q: "Tylko Windows?",
        a: "Windows w pierwszej kolejności, ale nie tylko Windows. Rozwój i brama wydania działają na Windows 11 z Git Bashem. Ścieżki POSIX są sprawdzane w testach, ale Linux i macOS nie są jeszcze weryfikowane w CI. Bun ≥ 1.3.14 to jedyny twardy wymóg.",
      },
      {
        q: "Co się stanie, gdy naciśnę Esc w środku uruchomienia?",
        a: "Kontroler uruchomienia przerywa: trwające zapytanie do dostawcy umiera (zmierzone ≤2 ms), a działające wywołanie bash zostaje zabite. Na Windowsie launcher siedzi w jądrowym Job Object, więc odchodzi całe drzewo procesów; na POSIX powłoka dostaje SIGTERM, ale rozwidlony wnuk może dokończyć sam. Anulowane uruchomienia i tak eksportują swój ślad.",
      },
      {
        q: "Czy jest na npm?",
        a: "Jeszcze nie. Zainstaluj ze źródeł przez bun install i bun link, zbuduj jeden plik binarny ~110 MB przez bun run build albo zrób tarball przez npm pack i zainstaluj go globalnie.",
      },
      {
        q: "Czego wymaga licencja?",
        a: "AGPL-3.0. Używaj, badaj, zmieniaj i rozpowszechniaj; zachowaj licencję i noty o prawach autorskich na każdej kopii i pochodnej. Jeśli uruchamiasz zmodyfikowany rovecode jako usługę sieciową, musisz udostępnić jego pełne źródło użytkownikom tej usługi. Atrybucje osób trzecich są w THIRD_PARTY_NOTICES.md; żaden kod nie pochodzi z crush (FSL), claw-code, nanocoder, iflow ani z Claude Agent SDK.",
      },
    ],
  },
  cta: { eyebrow: "weź rovecodea", title: "Sześć paneli. Szesnastu dostawców. Zero cennika.", button: "Zostaw gwiazdkę na GitHubie", quip: "wyszło słońce.", mood: "słonecznie" },
  footer: {
    blurb: "Agent kodujący do terminala. TypeScript na Bun, 47 przeniesionych wzorców, jedna polityka odmawiająca domyślnie przed każdym narzędziem.",
    notice: "Przeniesione źródła są wyłącznie na MIT albo Apache-2.0; atrybucje w THIRD_PARTY_NOTICES.md.",
    heads: ["Projekt", "Powierzchnie", "Konfiguracja", "Bezpieczeństwo"],
  },
  pet: {
    alt: "Rovecode, chmurkowa maskotka",
    edit: "z ołówkiem",
    read: "patrzący przez lupę",
    guard: "z tarczą",
    rewind: "z zegarem ze strzałką w tył",
    done: "z podniesionym kciukiem",
  },
};
