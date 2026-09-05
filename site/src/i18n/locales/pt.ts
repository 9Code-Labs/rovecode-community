import type { PartialDict } from "../en";

export const pt: PartialDict = {
  meta: {
    title: "Rovecode — um agente de código para o terminal",
    description: "Agente de programação open source para o terminal: cockpit TUI, 16 provedores ou qualquer endpoint OpenAI, política deny-default. Bun, AGPL-3.0.",
  },
  nav: { cockpit: "Cabine", capabilities: "Recursos", terminal: "Terminal", quickstart: "Início rápido", providers: "Provedores", faq: "Perguntas", market: "Mercado" },
  market: {
    kinds: { mcp: "Servidor MCP", skill: "Habilidade", plugin: "Plugin" },
    title: "Um mercado só: servidores MCP, habilidades e plugins",
    lead: "Tudo o que o rovecode pode instalar num só lugar — lido do repositório, cada um com o único comando que o instala. A mesma lista está no terminal em /market.",
    searchPlaceholder: "Pesquisar no mercado",
    searchLabel: "Pesquisar no mercado",
    all: "Tudo",
    empty: "Nada corresponde a essa busca.",
    docsTitle: "Documentação",
    docsBy: "por",
    docsSource: "fonte",
    docsOnThisPage: "Nesta página",
    docsTruncated: "Este é o começo de um documento mais longo:",
    docsReadFull: "ler o resto na fonte",
    installCta: "Instalar",
    licenseLabel: "licença",
    installLabel: "instalação",
    runsLabel: "o que executa",
    alsoLabel: "também:",
    envLabel: "ambiente",
    envNone: "nada — não precisa de chave.",
    required: "obrigatório",
    optional: "opcional",
    secret: "secreto",
    pendingLabel: "você fornece",
    targetLabel: "onde vai parar",
    targetBody: "O escopo de usuário grava em ~/.rovecode e vale para todo projeto; o escopo de projeto grava neste repositório e passa pelo portão de confiança. O rovecode mostra o arquivo exato no plano de instalação antes de gravar qualquer coisa.",
    fromLabel: "neste repositório",
    backToAll: "o mercado inteiro",
    registryNote: "Esta página lista o que vem com o rovecode: a prateleira MCP curada e os catálogos publicados de habilidades e plugins. O registro MCP ao vivo não está embutido — ele é consultado quando você pesquisa pela CLI ou pelo terminal, então o que está aqui funciona offline.",
  },
  ui: {
    skip: "Ir para o conteúdo",
    backToTop: "Rovecode, voltar ao topo",
    sections: "Seções",
    copy: "copiar",
    copied: "copiado",
    copyAria: "Copiar o comando",
    copiedAria: "Copiado",
    or: "ou",
    play: "reproduzir",
    pause: "pausar",
    playAria: "Reproduzir o vídeo de fundo",
    pauseAria: "Pausar o vídeo de fundo",
    language: "Idioma",
    sitemap: "Mapa do site",
    footerLabel: "Rodapé",
    facts: ["código aberto", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "Um agente de código no terminal com *cabine*, não com histórico de chat.",
    sub: "O Rovecode roda sobre Bun, fala com 16 provedores ou com qualquer endpoint compatível com OpenAI e passa cada chamada de ferramenta por uma política que nega por padrão antes de tocar no seu repositório. Software livre sob AGPL-3.0.",
    ctaGithub: "Ver no GitHub",
    ctaReadme: "Ler o README",
    caption:
      "Quadro real: o cartão de aprovação do bun test, a linha de edição +4 −1, contexto em 13 % de 200k. Renderizado pelos pintores do sextant com relógio fixo.",
    quip: "preciso do seu aval.",
    mood: "paciente",
    frameAlt:
      "A TUI sextant em 160 por 44 células: árvore de arquivos com status do git, o painel de código mostrando src/auth/callback.ts com as linhas editadas destacadas, o painel de mensagens com linhas de ferramenta de leitura e edição e um cartão de aprovação pedindo para rodar bun test, o plano no passo 1 de 4, 13 por cento de contexto usado e o mascote nuvem rovecode pedindo o aval.",
    chips: ["+4 −1 aplicado", "perguntar antes · cartão de aprovação", "contexto 13 % de 200k"],
  },
  proof: {
    eyebrow: "do repositório, no momento do build",
    ariaLabel: "Números do repositório",
    stats: [
      { label: "testes", note: "chamadas test() em test/, contadas no build" },
      { label: "provedores integrados", note: "mais qualquer URL compatível com OpenAI" },
      { label: "camadas de política", note: "rules · execpolicy · approval · runtime" },
      { label: "idiomas nesta página", note: "escolhido pelo navegador, alternável" },
      { label: "licença", note: "software livre, copyleft também no uso em rede" },
    ],
  },
  cockpit: {
    eyebrow: "a cabine",
    title: "Seis painéis numa tela. O arquivo que te importa nunca some na rolagem.",
    lead: "Arquivos com status do git, código com a faixa de destaque e diff ±, linhas de ferramenta compactas, plano, uso e o mascote. Renderizado sem tela pelos pintores do sextant com relógio fixo: o mesmo caminho de código que a TUI desenha, não uma maquete.",
    transcriptEyebrow: "painel de mensagens · linha a linha",
    transcriptTitle: "Uma execução, transcrita do quadro acima.",
    transcriptBody1:
      "Cada chamada de ferramenta é uma linha: o verbo, o arquivo e o que mudou. A edição entrou como +4 −1. O comando de shell espera atrás de um cartão com três respostas; Esc nega, e a resposta vale pelo resto da sessão.",
    transcriptBody2: "Agentes filhos não podem perguntar. Um argv proibido nunca chega ao cartão.",
  },
  problems: {
    eyebrow: "problemas → soluções",
    title: "Quatro coisas que dão errado com agentes de terminal, e o que o rovecode faz em cada uma.",
    lead: "Ditas como você diria no teclado, respondidas com o mecanismo e o seu limite. Cada faixa é um recorte de quadro real ou o arquivo de configuração real.",
    problemLabel: "problema",
    solutionLabel: "o que o rovecode faz",
    items: [
      {
        problem: "Todo agente chega soldado à API de um único fornecedor e à sua página de preços.",
        solution:
          "Uma única costura StreamFn e um registro de provedores vivo. 16 provedores nomeados, ou qualquer endpoint compatível com OpenAI ou Anthropic vindo do providers.json; um provedor adicionado em outro terminal já atende a chamada seguinte. Cadeias de fallback por papel avançam num 429 ou 5xx.",
      },
      {
        problem: "Um histórico de chat empurra para fora da tela o arquivo que o agente está editando.",
        solution:
          "Uma cabine com painéis: arquivos, código, mensagens, plano, uso e o mascote nuvem. O painel de mensagens mantém cada chamada de ferramenta numa linha compacta; o painel de código mostra o único trecho que entrou.",
      },
      {
        problem: "O modelo pede rm -rf e o arcabouço executa porque ninguém disse não a tempo.",
        solution:
          "Primeiro regras curinga que negam por padrão, depois vereditos do execpolicy em que o proibido não chega nem à execução nem a uma pessoa, depois um cartão de aprovação sobre os argumentos corrigidos. 4 camadas empilhadas, e nenhuma finge ser um sandbox.",
      },
      {
        problem: "O turno 40 dá errado e o único caminho de volta é uma conversa nova.",
        solution:
          "Uma árvore de sessão JSONL somente-anexar com cadeia de hash sha256. /rewind abre o seletor de turnos, ramifica de qualquer um e preenche o editor com o texto completo daquele turno; checkpoints shadow-git restauram em 3 modos sem tocar no seu .git.",
      },
    ],
  },
  capabilities: {
    eyebrow: "recursos",
    title: "Dez recursos, cada um um porte com trilha file:line.",
    lead: "O Rovecode porta padrões com evidência de pi, opencode, codex, cline, aider, gemini-cli e outros. Um porte só entra depois que um crítico de contexto limpo o verifica contra uma régua escrita antes do trabalho começar.",
    surfaceLabel: "superfície",
    surfaceBody:
      "6 painéis num TTY truecolor de pelo menos 100×30: arquivos com status do git, código com faixa de destaque e diff ±, linhas de ferramenta compactas, plano, uso, o mascote. 3 paletas, /theme troca a quente; --classic mantém o chat pi-tui.",
    surfaceAlt: "Recorte do quadro sextant: árvore de arquivos e o painel de código com a faixa de destaque da edição",
    providersLabel: "provedores",
    providersTitle: "provedores recarregados a quente",
    providersBody:
      "16 integrados mais tudo o que você registrar no providers.json. Cada chamada resolve o provedor contra o instantâneo vivo: adicione um em outro terminal e a cabine em execução usa na chamada seguinte. Sem reiniciar.",
    mediumLabels: ["contexto", "segurança", "memória"],
    medium: [
      { title: "Cliente MCP", body: "Servidores stdio e HTTP do .rovecode/mcp.json. Revelação preguiçosa por 2 ferramentas de registro, então um servidor ocioso custa quase zero tokens." },
      { title: "Escada de segurança", body: "Cada chamada de ferramenta sobe quatro degraus antes de rodar. Um argv proibido é negado antes de qualquer hook ver; --yolo pula as perguntas, nunca as regras de negação." },
      { title: "Árvore de sessão + checkpoints", body: "JSONL somente-anexar com cadeia de hash sha256. /rewind ramifica, /resume retoma, checkpoints shadow-git restauram em 3 modos e nunca tocam no seu .git." },
    ],
    small: [
      { title: "ACP para Zed + JetBrains", body: "Agent Client Protocol v1 sobre stdio, SDK oficial." },
      { title: "HTTP + SSE sem interface", body: "Sessões, um fluxo RunEvent, OpenAPI em /doc. Porta 4100, apenas loopback." },
      { title: "Subagentes em segundo plano", body: "Sessões filhas FIFO limitadas, 3 simultâneas por padrão; as notas chegam no turno seguinte do pai." },
      { title: "Hooks", body: "9 hooks tipados em .rovecode/hooks.ts, cada um limitado a 5 s. pre_tool só pode negar." },
      { title: "OpenTelemetry", body: "Um trace por execução: run ⊃ turn ⊃ tool com tokens, latência e custo. Sem endpoint definido, sem exportador." },
    ],
  },
  terminal: {
    eyebrow: "do terminal",
    title: "Quatro quadros reais em 160×44, com as partes que valem leitura numeradas.",
    lead: "Renderizados sem tela pelos pintores do sextant com relógio fixo: o mesmo caminho de código que a TUI desenha, não uma maquete. Passe o cursor num quadro para achatá-lo; numa linha para acender o marcador dela.",
    shots: [
      {
        title: "A edição entrou. O painel de código mostra exatamente aquele trecho.",
        lead: "Capturado antes de uma edição aprovada, reconstruído pelas âncoras da própria edição depois de uma sem aprovação.",
        alt: "quadro sextant depois de uma edição: o painel de código em modo diff mostra um trecho, o painel de mensagens lista linhas de leitura e edição",
        callouts: ["Mude para o modo diff ± quando a edição entrar", "Leia +4 −1 contra o arquivo em disco", "Siga as linhas compactas: leitura e depois edição", "Veja o contexto encher até 13 % de 200k"],
      },
      {
        title: "Um comando de shell espera um aval. Um cartão, três respostas.",
        lead: "Aprovações resolvem sobre os argumentos corrigidos e ficam guardadas por sessão; agentes filhos não podem perguntar.",
        alt: "quadro sextant com o cartão de aprovação aberto: bash bun test tests/auth.test.ts, permitir sempre negar",
        callouts: ["Veja o argv exato antes de rodar", "Escolha permitir, sempre ou negar; Esc nega", "O cabeçalho muda para esperando você", "O mascote pede o aval e depois lembra dele"],
      },
      {
        title: "Os testes rodaram. O painel $ guarda a saída; o cabeçalho congela o relógio.",
        lead: "As etiquetas PASS e FAIL leem o código de saída da própria linha de cabeçalho da ferramenta.",
        alt: "quadro sextant depois da execução: o painel de código em modo run mostra a saída do bun test com 18 aprovados, plano 4/4 concluído",
        callouts: ["Leia a saída em modo $, 18 aprovados", "O plano fecha em 4/4 passos", "A linha de ferramenta carrega a última linha da saída", "O custo fica em $0.071 pelo catálogo offline"],
      },
      {
        title: "Duas tarefas em segundo plano, uma pista cada, no quadro da tripulação.",
        lead: "As sessões filhas compartilham o único laço de agente; sair da TUI cancela todos os filhos vivos.",
        alt: "quadro sextant com o quadro da tripulação aberto: duas pistas, escrever testes em andamento e revisão concluída",
        callouts: ["Abra o quadro ∷ agents com ⌃a", "Cada pista mostra rótulo, tempo e status", "O resumo da tripulação fica no painel de plano", "Enquanto isso a execução pai continua editando"],
      },
    ],
  },
  quickstart: {
    eyebrow: "início rápido",
    title: "Três comandos do clone até um agente rodando.",
    lead: "Sem provedor configurado, execuções avulsas usam um provedor simulado por script — é assim que o teste de fumaça do empacotamento também funciona.",
    steps: [
      { title: "Clonar e linkar (Bun ≥ 1.3.14)", body: "A entrada da CLI é TypeScript executado pelo bun; o node não consegue rodá-la. bun link coloca o rovecode no PATH." },
      { title: "Conectar um modelo", body: "rovecode setup conduz: escolha um provedor, cole a chave oculta, uma chamada de teste pequena, pronto. Ou guarde uma chave direto com rovecode auth set, ou aponte ROVECODE_BASE_URL para qualquer endpoint compatível com OpenAI." },
      { title: "Rodar uma tarefa ou abrir a cabine", body: "rovecode sozinho abre a superfície sextant. Um prompt entre aspas é uma execução avulsa; --output json devolve exatamente um objeto de resultado." },
    ],
    outputAlt: "Saída da execução: 18 aprovados, 0 falhas, 41 chamadas expect(), 18 testes em 1 arquivo.",
  },
  providers: {
    eyebrow: "provedores",
    title: "16 provedores integrados, ou qualquer URL compatível com OpenAI.",
    leadA: "Credenciais salvas vencem as variáveis de ambiente ",
    leadB: "; um par explícito ",
    leadC: " vence as duas.",
    hosted: "apis hospedadas",
    local: "runtimes locais",
    keyNote:
      "● runtimes locais não precisam de chave · rovecode auth set <nome> guarda uma chave em ~/.rovecode/credentials.json, pedida no terminal e nunca exibida.",
    liveLabel: "qualquer endpoint · ao vivo",
    liveTitle: "Adicione um provedor em outro terminal; a cabine em execução pega na chamada seguinte. Sem reiniciar.",
  },
  faq: {
    eyebrow: "perguntas",
    title: "Objeções, respondidas com especificidade.",
    lead: "Sete perguntas que as pessoas fazem antes de confiar um shell a um agente. Cada resposta nomeia o mecanismo e onde ele para.",
    aside:
      "Tudo aqui vem das seções Modelo de segurança, Limitações conhecidas, Observabilidade e Licença e avisos do README.md. Onde o README diz que existe um limite, esta página também diz.",
    items: [
      {
        q: "É um sandbox?",
        a: "Não. Antes e ao redor de cada chamada de ferramenta rodam quatro camadas empilhadas: regras de política que negam por padrão, vereditos do execpolicy (um comando proibido não chega nem à execução nem a uma pessoa), o portão de aprovação sobre os argumentos corrigidos e uma lista de negação do bash em tempo de execução com trava de cwd. Onde o bash roda é escolhível — direto, WSL2 ou Docker —, mas cada degrau é delegação, não isolamento. Para trabalho não confiável use um contêiner ou microVM.",
      },
      {
        q: "Quais modelos posso usar?",
        a: "Tudo o que os 16 provedores nomeados servem, ou qualquer endpoint compatível com OpenAI ou Anthropic registrado em ~/.rovecode/providers.json (rovecode provider add) ou passado como ROVECODE_BASE_URL. Em modelos sem chamada de ferramenta nativa, o middleware converte XML, Hermes ou JSON dentro do texto em chamadas nativas. Cinco papéis (DEFAULT, SMOL, PLAN, COMMIT, TASK) aceitam cada um uma cadeia de fallback separada por vírgulas.",
      },
      {
        q: "Ele liga para casa?",
        a: "Não. O tráfego de saída vai para o provedor que você configurou, os servidores MCP que você listou e o web_fetch quando o modelo pede (com pergunta por padrão e proteção contra SSRF). A exportação OpenTelemetry existe, mas fica desligada até ROVECODE_OTEL_ENDPOINT ser definido, e mesmo então carrega ids, tamanhos e resultados, nunca prompts, argumentos ou saída. O catálogo de preços é um instantâneo offline. Não há autoatualização.",
      },
      {
        q: "Só Windows?",
        a: "Windows primeiro, não só Windows. O desenvolvimento e o portão de release rodam no Windows 11 com Git Bash. Caminhos POSIX são exercitados em testes, mas Linux e macOS ainda não têm verificação em CI. Bun ≥ 1.3.14 é o único requisito rígido.",
      },
      {
        q: "O que acontece se eu apertar Esc no meio da execução?",
        a: "O controlador da execução aborta: a requisição em voo ao provedor morre (≤2 ms medidos) e a chamada bash em curso é encerrada. No Windows o lançador fica dentro de um Job Object do kernel, então toda a árvore de processos vai junto; no POSIX o shell recebe SIGTERM, mas um neto bifurcado pode terminar sozinho. Execuções canceladas ainda exportam o trace.",
      },
      {
        q: "Está no npm?",
        a: "Ainda não. Instale a partir do código com bun install e bun link, gere um único binário de ~110 MB com bun run build, ou produza um tarball com npm pack e instale globalmente.",
      },
      {
        q: "O que a licença exige?",
        a: "AGPL-3.0. Usar, estudar, modificar e redistribuir; manter a licença e os avisos de copyright em cada cópia e derivado. Se você rodar um rovecode modificado como serviço de rede, precisa oferecer o código-fonte completo aos usuários desse serviço. As atribuições de terceiros estão em THIRD_PARTY_NOTICES.md; nenhum código vem de crush (FSL), claw-code, nanocoder, iflow ou do Claude Agent SDK.",
      },
    ],
  },
  cta: { eyebrow: "obter o rovecode", title: "Seis painéis. Dezesseis provedores. Zero página de preços.", button: "Dar estrela no GitHub", quip: "o sol apareceu.", mood: "ensolarado" },
  footer: {
    blurb: "Um agente de código para o terminal. TypeScript sobre Bun, 47 padrões portados, uma política que nega por padrão na frente de cada ferramenta.",
    notice: "As fontes portadas são apenas MIT ou Apache-2.0; atribuições em THIRD_PARTY_NOTICES.md.",
    heads: ["Projeto", "Superfícies", "Configuração", "Segurança"],
  },
  pet: {
    alt: "Rovecode, o mascote nuvem",
    edit: "segurando um lápis",
    read: "olhando por uma lupa",
    guard: "segurando um escudo",
    rewind: "segurando um relógio com seta para trás",
    done: "com o polegar para cima",
  },
};
