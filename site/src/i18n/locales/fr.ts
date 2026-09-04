import type { PartialDict } from "../en";

export const fr: PartialDict = {
  meta: {
    title: "Rovecode — un agent de code pour le terminal",
    description: "Agent de programmation open source pour le terminal : cockpit TUI à panneaux, 16 fournisseurs ou tout endpoint compatible OpenAI, politique deny-default. Bun, AGPL-3.0.",
  },
  nav: { cockpit: "Cockpit", capabilities: "Capacités", terminal: "Terminal", quickstart: "Démarrage", providers: "Fournisseurs", faq: "FAQ" },
  ui: {
    skip: "Aller au contenu",
    backToTop: "Rovecode, retour en haut",
    sections: "Sections",
    copy: "copier",
    copied: "copié",
    copyAria: "Copier la commande",
    copiedAria: "Copié",
    or: "ou",
    play: "lecture",
    pause: "pause",
    playAria: "Lancer la vidéo d'arrière-plan",
    pauseAria: "Mettre la vidéo d'arrière-plan en pause",
    language: "Langue",
    sitemap: "Plan du site",
    footerLabel: "Pied de page",
    facts: ["open source", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "Un agent de code en terminal avec un *cockpit*, pas un fil de discussion.",
    sub: "Rovecode tourne sur Bun, parle à 16 fournisseurs ou à n'importe quel point d'accès compatible OpenAI, et fait passer chaque appel d'outil par une politique qui refuse par défaut avant qu'il ne touche votre dépôt. Logiciel libre sous AGPL-3.0.",
    ctaGithub: "Voir sur GitHub",
    ctaReadme: "Lire le README",
    caption:
      "Image réelle : la carte d'autorisation pour bun test, la ligne d'édition +4 −1, le contexte à 13 % de 200k. Rendue par les peintres sextant à horloge fixe.",
    quip: "j'attends votre feu vert.",
    mood: "patient",
    frameAlt:
      "La TUI sextant en 160 par 44 cellules : arbre de fichiers avec statut git, le panneau de code affichant src/auth/callback.ts avec les lignes modifiées surlignées, le panneau de messages avec les lignes d'outil lecture et édition et une carte d'autorisation demandant à lancer bun test, le plan à l'étape 1 sur 4, 13 pour cent de contexte utilisé, et la mascotte nuage rovecode qui attend un feu vert.",
    chips: ["+4 −1 appliqué", "demander d'abord · carte d'autorisation", "contexte 13 % de 200k"],
  },
  proof: {
    eyebrow: "depuis le dépôt, au moment du build",
    ariaLabel: "Chiffres issus du dépôt",
    stats: [
      { label: "tests", note: "appels test() sous test/, comptés au build" },
      { label: "fournisseurs intégrés", note: "plus toute URL compatible OpenAI" },
      { label: "couches de politique", note: "rules · execpolicy · approval · runtime" },
      { label: "langues sur cette page", note: "choisie par le navigateur, modifiable" },
      { label: "licence", note: "logiciel libre, copyleft étendu à l'usage réseau" },
    ],
  },
  cockpit: {
    eyebrow: "le cockpit",
    title: "Six panneaux sur un écran. Le fichier qui vous intéresse ne disparaît jamais.",
    lead: "Fichiers avec statut git, code avec la bande de surlignage et le diff ±, lignes d'outil compactes, plan, usage et la mascotte. Rendu sans affichage par les peintres sextant à horloge fixe : le chemin de code exact que la TUI dessine, pas une maquette.",
    transcriptEyebrow: "panneau messages · ligne à ligne",
    transcriptTitle: "Une exécution, transcrite depuis l'image ci-dessus.",
    transcriptBody1:
      "Chaque appel d'outil tient sur une ligne : le verbe, le fichier et ce qui a changé. L'édition a donné +4 −1. La commande shell attend derrière une carte à trois réponses ; Échap refuse, et la réponse vaut pour le reste de la session.",
    transcriptBody2: "Les agents enfants ne peuvent pas poser de question. Un argv interdit n'atteint jamais la carte.",
  },
  problems: {
    eyebrow: "problèmes → solutions",
    title: "Quatre travers des agents en terminal, et ce que rovecode fait pour chacun.",
    lead: "Énoncés comme vous les diriez au clavier, résolus par un mécanisme et sa limite. Chaque bandeau est un vrai recadrage d'image ou le vrai fichier de configuration.",
    problemLabel: "problème",
    solutionLabel: "ce que fait rovecode",
    items: [
      {
        problem: "Chaque agent arrive soudé à l'API d'un seul fournisseur et à sa grille tarifaire.",
        solution:
          "Une seule couture StreamFn et un registre de fournisseurs vivant. 16 fournisseurs nommés, ou tout point d'accès compatible OpenAI ou Anthropic depuis providers.json ; un fournisseur ajouté dans un autre terminal sert l'appel suivant. Les chaînes de repli par rôle avancent sur un 429 ou un 5xx.",
      },
      {
        problem: "Un fil de discussion fait défiler hors de l'écran le fichier que l'agent est en train de modifier.",
        solution:
          "Un cockpit à panneaux : fichiers, code, messages, plan, usage et la mascotte nuage. Le panneau de messages tient chaque appel d'outil sur une ligne compacte ; le panneau de code montre le seul bloc appliqué.",
      },
      {
        problem: "Le modèle réclame rm -rf et le harnais l'exécute parce que personne n'a dit non à temps.",
        solution:
          "D'abord des règles à joker qui refusent par défaut, puis des verdicts execpolicy où l'interdit n'atteint ni l'exécution ni un humain, puis une carte d'autorisation sur les arguments corrigés. 4 couches empilées, dont aucune ne prétend être un bac à sable.",
      },
      {
        problem: "Le tour 40 dérape et le seul retour possible est une nouvelle conversation.",
        solution:
          "Un arbre de session JSONL en ajout seul avec chaîne de hachage sha256. /rewind ouvre le sélecteur de tours, dérive depuis n'importe quel tour et pré-remplit l'éditeur avec son texte complet ; les points de contrôle shadow-git restaurent selon 3 modes sans toucher à votre .git.",
      },
    ],
  },
  capabilities: {
    eyebrow: "capacités",
    title: "Dix capacités, chacune un portage avec sa trace file:line.",
    lead: "Rovecode porte des motifs éprouvés venus de pi, opencode, codex, cline, aider, gemini-cli et d'autres. Un portage n'atterrit qu'après vérification par un critique à contexte neuf, face à une barre écrite avant le début du travail.",
    surfaceLabel: "surface",
    surfaceBody:
      "6 panneaux sur un TTY truecolor d'au moins 100×30 : fichiers avec statut git, code avec bande de surlignage et diff ±, lignes d'outil compactes, plan, usage, la mascotte. 3 palettes, /theme change à chaud ; --classic garde le chat pi-tui.",
    surfaceAlt: "Recadrage de l'image sextant : arbre de fichiers et panneau de code avec la bande de surlignage d'édition",
    providersLabel: "fournisseurs",
    providersTitle: "fournisseurs rechargés à chaud",
    providersBody:
      "16 intégrés plus tout ce que vous enregistrez dans providers.json. Chaque appel résout le fournisseur sur l'instantané vivant : ajoutez-en un dans un autre terminal et le cockpit en cours l'utilise à l'appel suivant. Sans redémarrage.",
    mediumLabels: ["contexte", "sûreté", "mémoire"],
    medium: [
      { title: "Client MCP", body: "Serveurs stdio et HTTP depuis .rovecode/mcp.json. Divulgation paresseuse via 2 outils de registre : un serveur au repos coûte quasiment zéro jeton." },
      { title: "Échelle de sûreté", body: "Chaque appel d'outil gravit quatre barreaux avant de s'exécuter. Un argv interdit est refusé avant qu'un hook ne le voie ; --yolo saute les invites, jamais les règles de refus." },
      { title: "Arbre de session + points de contrôle", body: "JSONL en ajout seul avec chaîne de hachage sha256. /rewind dérive, /resume reprend, les points shadow-git restaurent selon 3 modes sans jamais toucher votre .git." },
    ],
    small: [
      { title: "ACP pour Zed + JetBrains", body: "Agent Client Protocol v1 sur stdio, SDK officiel." },
      { title: "HTTP + SSE sans interface", body: "Sessions, un flux RunEvent, OpenAPI sur /doc. Port 4100, boucle locale seulement." },
      { title: "Sous-agents en arrière-plan", body: "Sessions enfants FIFO bornées, 3 simultanées par défaut ; les notes arrivent au tour suivant du parent." },
      { title: "Hooks", body: "9 hooks typés dans .rovecode/hooks.ts, chacun borné à 5 s. pre_tool ne peut que refuser." },
      { title: "OpenTelemetry", body: "Une trace par exécution : run ⊃ turn ⊃ tool avec jetons, latence, coût. Point d'accès non défini, pas d'exportateur." },
    ],
  },
  terminal: {
    eyebrow: "depuis le terminal",
    title: "Quatre images réelles en 160×44, les endroits à lire numérotés.",
    lead: "Rendues sans affichage par les peintres sextant à horloge fixe : le chemin de code exact que la TUI dessine, pas une maquette. Survolez une image pour l'aplatir ; survolez une ligne pour allumer son repère.",
    shots: [
      {
        title: "L'édition est passée. Le panneau de code montre exactement ce bloc.",
        lead: "Capturé avant une édition approuvée, reconstruit depuis les ancres de l'édition après une édition non soumise.",
        alt: "image sextant après une édition : le panneau de code en mode diff montre un bloc, le panneau de messages liste les lignes lecture et édition",
        callouts: ["Passer en mode diff ± au moment où l'édition atterrit", "Lire +4 −1 face au fichier sur le disque", "Suivre les lignes d'outil compactes : lecture, puis édition", "Voir le contexte se remplir à 13 % de 200k"],
      },
      {
        title: "Une commande shell attend un feu vert. Une carte, trois réponses.",
        lead: "Les autorisations se résolvent sur les arguments corrigés et sont mémorisées par session ; les agents enfants ne peuvent pas demander.",
        alt: "image sextant avec la carte d'autorisation ouverte : bash bun test tests/auth.test.ts, autoriser toujours refuser",
        callouts: ["Voir l'argv exact avant l'exécution", "Choisir autoriser, toujours ou refuser ; Échap refuse", "L'en-tête passe en attente de vous", "La mascotte demande le feu vert, puis s'en souvient"],
      },
      {
        title: "Les tests ont tourné. Le panneau $ garde la sortie ; l'en-tête fige l'horloge.",
        lead: "Les pastilles PASS et FAIL lisent le code de sortie dans la ligne d'en-tête de l'outil lui-même.",
        alt: "image sextant après l'exécution : le panneau de code en mode run montre la sortie de bun test avec 18 réussis, plan 4/4 terminé",
        callouts: ["Lire la sortie en mode $, 18 réussis", "Le plan se referme à 4/4 étapes", "La ligne d'outil porte la dernière ligne de sortie", "Le coût tombe à $0.071 depuis le catalogue hors ligne"],
      },
      {
        title: "Deux tâches en arrière-plan, une voie chacune, sur le tableau d'équipage.",
        lead: "Les sessions enfants partagent l'unique boucle d'agent ; quitter la TUI annule tous les enfants vivants.",
        alt: "image sextant avec le tableau d'équipage ouvert : deux voies, écriture de tests en cours et revue terminée",
        callouts: ["Ouvrir le tableau ∷ agents avec ⌃a", "Chaque voie montre libellé, durée et statut", "Le résumé d'équipage reste dans le panneau plan", "L'exécution parente continue d'éditer pendant ce temps"],
      },
    ],
  },
  quickstart: {
    eyebrow: "démarrage",
    title: "Trois commandes du clone à l'agent qui tourne.",
    lead: "Sans fournisseur configuré, les exécutions ponctuelles utilisent un fournisseur simulé scripté — c'est aussi ainsi que fonctionne le test de fumée d'empaquetage.",
    steps: [
      { title: "Cloner et lier (Bun ≥ 1.3.14)", body: "Le point d'entrée CLI est du TypeScript exécuté par bun ; node ne peut pas le lancer. bun link met rovecode dans le PATH." },
      { title: "Connecter un modèle", body: "rovecode setup vous guide : choisir un fournisseur, coller la clé masquée, un petit appel de test, terminé. Ou stocker une clé directement avec rovecode auth set, ou pointer ROVECODE_BASE_URL vers n'importe quel point d'accès compatible OpenAI." },
      { title: "Lancer une tâche ou ouvrir le cockpit", body: "rovecode seul ouvre la surface sextant. Une invite entre guillemets est une exécution ponctuelle ; --output json renvoie exactement un objet de résultat." },
    ],
    outputAlt: "Sortie d'exécution : 18 réussis, 0 échec, 41 appels expect(), 18 tests exécutés sur 1 fichier.",
  },
  providers: {
    eyebrow: "fournisseurs",
    title: "16 fournisseurs intégrés, ou n'importe quelle URL compatible OpenAI.",
    leadA: "Les identifiants stockés l'emportent sur les variables d'environnement ",
    leadB: " ; un couple explicite ",
    leadC: " l'emporte sur les deux.",
    hosted: "apis hébergées",
    local: "runtimes locaux",
    keyNote:
      "● les runtimes locaux n'ont besoin d'aucune clé · rovecode auth set <nom> range une clé dans ~/.rovecode/credentials.json, demandée dans le terminal et jamais affichée.",
    liveLabel: "n'importe quel point d'accès · à chaud",
    liveTitle: "Ajoutez un fournisseur dans un autre terminal ; le cockpit en cours le prend à l'appel suivant. Sans redémarrage.",
  },
  faq: {
    eyebrow: "faq",
    title: "Objections, réponses précises.",
    lead: "Sept questions que l'on pose avant de confier un shell à un agent. Chaque réponse nomme le mécanisme et l'endroit où il s'arrête.",
    aside:
      "Tout ici vient des sections Modèle de sûreté, Limites connues, Observabilité et Licence & mentions du README.md. Là où le README signale une limite, cette page aussi.",
    items: [
      {
        q: "Est-ce un bac à sable ?",
        a: "Non. Quatre couches empilées tournent avant et autour de chaque appel d'outil : des règles de politique qui refusent par défaut, les verdicts execpolicy (une commande interdite n'atteint ni l'exécution ni un humain), la porte d'autorisation sur les arguments corrigés, et une liste de refus bash à l'exécution avec verrou de cwd. L'endroit où bash tourne est au choix — direct, WSL2 ou Docker — mais chaque barreau est une délégation, pas un isolement. Pour du code non fiable, utilisez un conteneur ou une micro-VM.",
      },
      {
        q: "Quels modèles puis-je utiliser ?",
        a: "Tout ce que servent les 16 fournisseurs nommés, ou n'importe quel point d'accès compatible OpenAI ou Anthropic enregistré dans ~/.rovecode/providers.json (rovecode provider add) ou passé via ROVECODE_BASE_URL. Pour les modèles sans appel d'outil natif, un intergiciel convertit le XML, Hermes ou le JSON dans le texte en appels natifs. Cinq rôles (DEFAULT, SMOL, PLAN, COMMIT, TASK) acceptent chacun une chaîne de repli séparée par des virgules.",
      },
      {
        q: "Est-ce que ça téléphone à la maison ?",
        a: "Non. Le trafic sortant va vers le fournisseur que vous avez configuré, les serveurs MCP que vous avez listés, et web_fetch quand le modèle le demande (avec invite par défaut, protégé contre le SSRF). L'export OpenTelemetry existe mais reste éteint tant que ROVECODE_OTEL_ENDPOINT n'est pas défini, et même alors il porte des identifiants, des tailles et des résultats, jamais les invites, les arguments ou la sortie. Le catalogue de prix est un instantané hors ligne. Il n'y a pas de mise à jour automatique.",
      },
      {
        q: "Windows uniquement ?",
        a: "Windows d'abord, pas Windows seulement. Le développement et la porte de publication tournent sur Windows 11 avec Git Bash. Les chemins POSIX sont exercés dans les tests, mais Linux et macOS ne sont pas encore vérifiés en CI. Bun ≥ 1.3.14 est la seule exigence stricte.",
      },
      {
        q: "Que se passe-t-il si j'appuie sur Échap en pleine exécution ?",
        a: "Le contrôleur de l'exécution abandonne : la requête fournisseur en vol meurt (≤2 ms mesurées) et l'appel bash en cours est tué. Sous Windows, le lanceur vit dans un Job Object noyau, donc tout l'arbre de processus part avec lui ; sous POSIX le shell reçoit SIGTERM mais un petit-fils forké peut finir seul. Les exécutions annulées exportent quand même leur trace.",
      },
      {
        q: "Est-ce publié sur npm ?",
        a: "Pas encore. Installez depuis les sources avec bun install et bun link, construisez un binaire unique d'environ 110 Mo avec bun run build, ou produisez un tarball avec npm pack et installez-le globalement.",
      },
      {
        q: "Qu'exige la licence ?",
        a: "AGPL-3.0. Utiliser, étudier, modifier et redistribuer ; conserver la licence et les mentions de droits d'auteur sur chaque copie et dérivé. Si vous exploitez un rovecode modifié comme service en réseau, vous devez en offrir le code source complet aux utilisateurs de ce service. Les attributions tierces sont dans THIRD_PARTY_NOTICES.md ; aucun code ne vient de crush (FSL), claw-code, nanocoder, iflow ni du Claude Agent SDK.",
      },
    ],
  },
  cta: { eyebrow: "obtenir rovecode", title: "Six panneaux. Seize fournisseurs. Zéro grille tarifaire.", button: "Mettre une étoile sur GitHub", quip: "il fait beau.", mood: "ensoleillé" },
  footer: {
    blurb: "Un agent de code pour le terminal. TypeScript sur Bun, 47 motifs portés, une politique qui refuse par défaut devant chaque outil.",
    notice: "Les sources portées sont uniquement MIT ou Apache-2.0 ; attributions dans THIRD_PARTY_NOTICES.md.",
    heads: ["Projet", "Surfaces", "Configuration", "Sûreté"],
  },
  pet: {
    alt: "Rovecode, la mascotte nuage",
    edit: "tenant un crayon",
    read: "regardant à la loupe",
    guard: "tenant un bouclier",
    rewind: "tenant une horloge à flèche inversée",
    done: "pouce levé",
  },
};
