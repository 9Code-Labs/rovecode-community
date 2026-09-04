import type { PartialDict } from "../en";

export const ko: PartialDict = {
  meta: {
    title: "Rovecode — 터미널을 위한 코딩 에이전트",
    description: "터미널용 오픈소스 코딩 에이전트. 패널형 TUI 콕핏, 16개 프로바이더 또는 OpenAI 호환 엔드포인트, 기본 거부 도구 정책. Bun, AGPL-3.0.",
  },
  nav: { cockpit: "콕핏", capabilities: "기능", terminal: "터미널", quickstart: "빠른 시작", providers: "제공자", faq: "자주 묻는 질문" },
  ui: {
    skip: "본문으로 건너뛰기",
    backToTop: "Rovecode, 맨 위로",
    sections: "섹션",
    copy: "복사",
    copied: "복사됨",
    copyAria: "명령 복사",
    copiedAria: "복사했습니다",
    or: "또는",
    play: "재생",
    pause: "일시정지",
    playAria: "배경 영상 재생",
    pauseAria: "배경 영상 일시정지",
    language: "언어",
    sitemap: "사이트맵",
    footerLabel: "바닥글",
    facts: ["오픈 소스", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "대화 기록이 아니라 *콕핏*을 갖춘 터미널 코딩 에이전트.",
    sub: "Rovecode는 Bun 위에서 돌아가고, 16개 제공자나 OpenAI 호환 엔드포인트와 이야기하며, 모든 도구 호출을 저장소에 닿기 전에 기본이 거부인 정책에 통과시킵니다. AGPL-3.0의 자유 소프트웨어입니다.",
    ctaGithub: "GitHub에서 보기",
    ctaReadme: "README 읽기",
    caption:
      "실제 프레임: bun test 승인 카드, +4 −1 편집 행, 컨텍스트는 200k의 13 %. 고정된 시계로 sextant 페인터를 통해 그렸습니다.",
    quip: "당신의 끄덕임이 필요해요.",
    mood: "참을성 있는",
    frameAlt:
      "160×44 셀의 sextant TUI: git 상태가 붙은 파일 트리, 수정된 줄이 강조된 src/auth/callback.ts를 보여 주는 코드 패널, 읽기와 편집 도구 행 그리고 bun test 실행 허가를 구하는 승인 카드가 있는 메시지 패널, 4단계 중 1단계의 계획, 13퍼센트의 컨텍스트 사용량, 그리고 끄덕임을 기다리는 rovecode 구름 마스코트.",
    chips: ["+4 −1 반영됨", "먼저 묻기 · 승인 카드", "컨텍스트 200k의 13 %"],
  },
  proof: {
    eyebrow: "저장소에서, 빌드 시점에",
    ariaLabel: "저장소에서 가져온 수치",
    stats: [
      { label: "테스트", note: "test/ 아래 test() 호출, 빌드 시 집계" },
      { label: "내장 프로바이더", note: "OpenAI 호환 URL은 무엇이든 추가" },
      { label: "정책 계층", note: "rules · execpolicy · approval · runtime" },
      { label: "이 페이지의 언어", note: "브라우저에서 선택, 전환 가능" },
      { label: "라이선스", note: "자유 소프트웨어, 네트워크 사용에도 미치는 카피레프트" },
    ],
  },
  cockpit: {
    eyebrow: "콕핏",
    title: "한 화면에 여섯 패널. 신경 쓰는 파일이 위로 밀려 사라지지 않습니다.",
    lead: "git 상태가 붙은 파일, 강조 띠와 ± 차이가 있는 코드, 간결한 도구 행, 계획, 사용량 그리고 마스코트. 고정된 시계로 sextant 페인터를 통해 화면 없이 그립니다. TUI가 그리는 것과 같은 코드 경로이지 목업이 아닙니다.",
    transcriptEyebrow: "메시지 패널 · 한 행씩",
    transcriptTitle: "위 프레임에서 받아 적은 한 번의 실행.",
    transcriptBody1:
      "모든 도구 호출은 한 행입니다. 동사, 파일, 그리고 무엇이 바뀌었는지. 편집은 +4 −1로 반영되었습니다. 셸 명령은 답이 셋인 카드 한 장 뒤에서 기다립니다. Esc는 거부이고, 답은 세션이 끝날 때까지 기억됩니다.",
    transcriptBody2: "자식 에이전트는 물을 수 없습니다. 금지된 argv는 카드에 아예 닿지 않습니다.",
  },
  problems: {
    eyebrow: "문제 → 해법",
    title: "터미널 에이전트에서 어긋나는 네 가지, 그리고 rovecode가 각각에 하는 일.",
    lead: "키보드 앞에서 쓸 법한 말로 적고, 방법과 그 한계로 답합니다. 모든 띠는 실제 프레임 조각이거나 실제 설정 파일입니다.",
    problemLabel: "문제",
    solutionLabel: "rovecode가 하는 일",
    items: [
      {
        problem: "모든 에이전트가 한 공급사의 API와 한 장의 가격표에 용접된 채 나온다.",
        solution:
          "하나의 StreamFn 이음매와 살아 있는 제공자 레지스트리. 16개의 이름 있는 제공자, 또는 providers.json에 적힌 OpenAI·Anthropic 호환 엔드포인트라면 무엇이든. 다른 터미널에서 추가한 제공자가 바로 다음 호출을 처리합니다. 역할별 대체 사슬은 429나 5xx에서 다음으로 넘어갑니다.",
      },
      {
        problem: "에이전트가 파일을 고치는 동안 대화 기록이 그 파일을 화면 밖으로 밀어낸다.",
        solution:
          "패널로 나뉜 콕핏: 파일, 코드, 메시지, 계획, 사용량 그리고 구름 마스코트. 메시지 패널은 도구 호출마다 한 줄만 쓰고, 코드 패널은 반영된 그 조각 하나를 보여 줍니다.",
      },
      {
        problem: "모델이 rm -rf를 요구하고, 제때 아니라고 한 사람이 없어 하네스가 그대로 실행한다.",
        solution:
          "먼저 기본이 거부인 와일드카드 규칙, 다음으로 금지된 것이 실행에도 사람에게도 닿지 않는 execpolicy 판정, 그다음 고쳐진 인자에 대한 승인 카드. 네 겹을 쌓지만 어느 것도 샌드박스인 척하지 않습니다.",
      },
      {
        problem: "40번째 턴이 어긋나는데 돌아갈 길이 새 대화뿐이다.",
        solution:
          "sha256 해시 사슬을 가진 덧붙이기 전용 JSONL 세션 트리. /rewind는 턴 선택기를 열고 어느 턴에서든 갈라지며 그 턴의 전체 문장을 편집기에 채웁니다. shadow-git 체크포인트는 당신의 .git을 건드리지 않고 3가지 모드로 되돌립니다.",
      },
    ],
  },
  capabilities: {
    eyebrow: "기능",
    title: "열 가지 기능, 각각 file:line 자취가 있는 이식.",
    lead: "Rovecode는 pi, opencode, codex, cline, aider, gemini-cli 등에서 근거 있는 패턴을 옮겨 옵니다. 이식은 작업 전에 적어 둔 기준에 맞춰 새 문맥의 비평자가 검증한 뒤에야 반영됩니다.",
    surfaceLabel: "표면",
    surfaceBody:
      "최소 100×30의 트루컬러 TTY에 6개 패널: git 상태가 붙은 파일, 강조 띠와 ± 차이가 있는 코드, 간결한 도구 행, 계획, 사용량, 마스코트. 팔레트 3개, /theme는 실행 중에 바꾸고, --classic은 pi-tui 대화를 유지합니다.",
    surfaceAlt: "sextant 프레임 조각: 파일 트리와 편집 강조 띠가 있는 코드 패널",
    providersLabel: "제공자",
    providersTitle: "실시간으로 다시 읽는 제공자",
    providersBody:
      "기본 16개에 providers.json에 등록한 모든 것. 호출마다 살아 있는 스냅숏에서 제공자를 찾습니다. 다른 터미널에서 하나 추가하면 실행 중인 콕핏이 다음 호출에 씁니다. 재시작은 없습니다.",
    mediumLabels: ["문맥", "안전", "기억"],
    medium: [
      { title: "MCP 클라이언트", body: ".rovecode/mcp.json의 stdio와 HTTP 서버. 레지스트리 도구 2개를 통한 지연 공개라, 놀고 있는 서버는 토큰을 거의 쓰지 않습니다." },
      { title: "안전 사다리", body: "모든 도구 호출은 실행 전에 네 단을 오릅니다. 금지된 argv는 어떤 훅이 보기도 전에 거부됩니다. --yolo는 확인을 건너뛰지만 거부 규칙은 결코 건너뛰지 않습니다." },
      { title: "세션 트리 + 체크포인트", body: "sha256 해시 사슬을 가진 덧붙이기 전용 JSONL. /rewind로 갈라지고 /resume으로 이어가며, shadow-git 체크포인트는 3가지 모드로 되돌리고 당신의 .git은 절대 건드리지 않습니다." },
    ],
    small: [
      { title: "Zed + JetBrains용 ACP", body: "stdio 위의 Agent Client Protocol v1, 공식 SDK." },
      { title: "헤드리스 HTTP + SSE", body: "세션, 하나의 RunEvent 스트림, /doc의 OpenAPI. 포트 4100, 루프백만." },
      { title: "배경 하위 에이전트", body: "상한이 있는 FIFO 자식 세션, 기본 동시 3개. 메모는 부모의 다음 턴에 도착합니다." },
      { title: "훅", body: ".rovecode/hooks.ts에 타입이 붙은 훅 9개, 각각 5초 제한. pre_tool은 거부만 할 수 있습니다." },
      { title: "OpenTelemetry", body: "실행마다 하나의 추적: run ⊃ turn ⊃ tool에 토큰, 지연, 비용. 엔드포인트를 두지 않으면 익스포터도 없습니다." },
    ],
  },
  terminal: {
    eyebrow: "터미널에서",
    title: "160×44의 실제 프레임 넷, 읽을 만한 곳에 번호를 붙여.",
    lead: "고정된 시계로 sextant 페인터를 통해 화면 없이 그렸습니다. TUI가 그리는 것과 같은 코드 경로이지 목업이 아닙니다. 프레임에 올리면 평평해지고, 행에 올리면 그 표시가 켜집니다.",
    shots: [
      {
        title: "편집이 반영됐다. 코드 패널이 바로 그 조각을 보여 준다.",
        lead: "승인된 편집 전에는 그대로 담고, 승인을 거치지 않은 편집 뒤에는 편집 자신의 기준점에서 되살립니다.",
        alt: "편집 후 sextant 프레임: 차이 모드의 코드 패널이 조각 하나를 보이고, 메시지 패널이 읽기와 편집 행을 늘어놓는다",
        callouts: ["편집이 반영될 때 ± 차이 모드로 바꾸기", "디스크의 파일에 대한 +4 −1 읽기", "간결한 도구 행을 따라가기: 읽기, 그다음 편집", "컨텍스트가 200k의 13 %까지 차는 것 보기"],
      },
      {
        title: "셸 명령이 끄덕임을 기다린다. 카드 하나, 답 셋.",
        lead: "승인은 고쳐진 인자에 대해 결정되고 세션 단위로 기억됩니다. 자식 에이전트는 물을 수 없습니다.",
        alt: "승인 카드가 열린 sextant 프레임: bash bun test tests/auth.test.ts, 허용 항상 거부",
        callouts: ["실행 전에 정확한 argv 보기", "허용·항상·거부 중 고르기, Esc는 거부", "머리글이 당신을 기다리는 중으로 바뀜", "마스코트가 끄덕임을 청하고 그 답을 기억함"],
      },
      {
        title: "테스트가 돌았다. $ 패널이 출력을 남기고, 머리글이 시계를 멈춘다.",
        lead: "PASS와 FAIL 칩은 도구 자신의 머리글 줄에서 종료 코드를 읽습니다.",
        alt: "실행 후 sextant 프레임: run 모드의 코드 패널이 18개 통과한 bun test 출력을 보이고, 계획은 4/4 완료",
        callouts: ["$ 모드에서 실행 출력 읽기, 18개 통과", "계획이 4/4 단계에서 닫힘", "도구 행이 출력의 마지막 줄을 실어 나름", "비용은 오프라인 카탈로그 기준 $0.071"],
      },
      {
        title: "배경 작업 둘, 각각 한 레인씩, 크루 보드에.",
        lead: "자식 세션은 하나뿐인 에이전트 루프를 함께 씁니다. TUI를 나가면 살아 있는 자식이 모두 취소됩니다.",
        alt: "크루 보드가 열린 sextant 프레임: 레인 둘, 테스트 작성 진행 중이고 리뷰는 완료",
        callouts: ["⌃a로 ∷ agents 보드 열기", "레인마다 이름표, 경과 시간, 상태를 보여 줌", "크루 요약은 계획 패널에 남음", "그동안 부모 실행은 계속 편집함"],
      },
    ],
  },
  quickstart: {
    eyebrow: "빠른 시작",
    title: "클론에서 도는 에이전트까지 명령 셋.",
    lead: "제공자를 설정하지 않으면 일회성 실행은 대본이 있는 가짜 제공자를 씁니다. 패키징 스모크 테스트도 같은 방식입니다.",
    steps: [
      { title: "클론하고 링크하기 (Bun ≥ 1.3.14)", body: "CLI 진입점은 bun이 실행하는 TypeScript라 node로는 돌지 않습니다. bun link가 rovecode를 PATH에 올립니다." },
      { title: "모델 연결하기", body: "rovecode setup이 안내합니다. 제공자를 고르고, 키를 가린 채 붙여 넣고, 작은 테스트 호출 한 번이면 끝입니다. 또는 rovecode auth set으로 키를 바로 저장하거나, ROVECODE_BASE_URL을 OpenAI 호환 엔드포인트로 향하게 하세요." },
      { title: "작업 실행하거나 콕핏 열기", body: "그냥 rovecode면 sextant 화면이 열립니다. 따옴표로 감싼 프롬프트는 일회성 실행이고, --output json은 결과 객체를 정확히 하나 돌려줍니다." },
    ],
    outputAlt: "실행 출력: 18개 통과, 0개 실패, expect() 호출 41회, 파일 1개에서 테스트 18개 실행.",
  },
  providers: {
    eyebrow: "제공자",
    title: "기본 제공자 16개, 또는 OpenAI 호환 URL이라면 무엇이든.",
    leadA: "저장된 자격 증명이 ",
    leadB: " 환경 변수를 이기고, 명시한 ",
    leadC: " 짝이 둘 다를 이깁니다.",
    hosted: "호스팅 api",
    local: "로컬 런타임",
    keyNote:
      "● 로컬 런타임에는 키가 필요 없습니다 · rovecode auth set <이름>은 키를 ~/.rovecode/credentials.json에 저장합니다. 터미널에서 묻고 결코 화면에 찍지 않습니다.",
    liveLabel: "어떤 엔드포인트든 · 실행 중",
    liveTitle: "다른 터미널에서 제공자를 추가하면 실행 중인 콕핏이 다음 호출에 집어 옵니다. 재시작은 없습니다.",
  },
  faq: {
    eyebrow: "자주 묻는 질문",
    title: "반론에, 구체로 답하기.",
    lead: "셸을 에이전트에 맡기기 전에 사람들이 묻는 일곱 가지. 모든 답은 방법과 그것이 멈추는 지점을 말합니다.",
    aside:
      "여기 있는 모든 것은 README.md의 안전 모델, 알려진 한계, 관측 가능성, 라이선스와 고지 절에서 가져왔습니다. README가 한계를 말하는 곳에서는 이 페이지도 말합니다.",
    items: [
      {
        q: "샌드박스인가요?",
        a: "아닙니다. 모든 도구 호출 앞과 둘레에서 네 겹이 함께 돕니다. 기본이 거부인 정책 규칙, execpolicy 판정(금지된 명령은 실행에도 사람에게도 닿지 않습니다), 고쳐진 인자에 대한 승인 관문, 그리고 cwd 잠금이 있는 실행 시 bash 거부 목록입니다. bash가 어디서 도는지는 고를 수 있지만(직접, WSL2, Docker) 모든 단은 위임이지 격리가 아닙니다. 믿을 수 없는 작업에는 컨테이너나 마이크로 VM을 쓰세요.",
      },
      {
        q: "어떤 모델을 쓸 수 있나요?",
        a: "이름 있는 16개 제공자가 제공하는 것, 또는 ~/.rovecode/providers.json에 등록(rovecode provider add)하거나 ROVECODE_BASE_URL로 넘긴 OpenAI·Anthropic 호환 엔드포인트라면 무엇이든 씁니다. 네이티브 도구 호출이 없는 모델에서는 미들웨어가 XML, Hermes, 본문 속 JSON을 네이티브 호출로 바꿉니다. 다섯 역할(DEFAULT, SMOL, PLAN, COMMIT, TASK)은 각각 쉼표로 나눈 대체 사슬을 받습니다.",
      },
      {
        q: "몰래 서버로 보내나요?",
        a: "아닙니다. 나가는 통신은 당신이 설정한 제공자, 당신이 적어 둔 MCP 서버, 그리고 모델이 요청할 때의 web_fetch(기본은 확인을 묻고 SSRF를 막습니다)로 갑니다. OpenTelemetry 내보내기는 있지만 ROVECODE_OTEL_ENDPOINT를 두기 전에는 꺼져 있고, 두더라도 프롬프트·인자·출력이 아니라 식별자, 크기, 결과만 실어 나릅니다. 가격 카탈로그는 오프라인 스냅숏입니다. 자동 업데이트는 없습니다.",
      },
      {
        q: "Windows 전용인가요?",
        a: "Windows가 먼저일 뿐, Windows만은 아닙니다. 개발과 릴리스 관문은 Git Bash를 쓰는 Windows 11에서 돕니다. POSIX 경로는 테스트에서 다루지만 Linux와 macOS는 아직 CI로 검증하지 않았습니다. 단 하나의 굳은 요구는 Bun ≥ 1.3.14입니다.",
      },
      {
        q: "실행 도중 Esc를 누르면 어떻게 되나요?",
        a: "실행의 컨트롤러가 중단합니다. 날아가던 제공자 요청이 죽고(측정 ≤2 ms) 돌던 bash 호출이 종료됩니다. Windows에서는 실행기가 커널 Job Object 안에 있어 프로세스 트리 전체가 함께 사라집니다. POSIX에서는 셸이 SIGTERM을 받지만 fork된 손자는 혼자 끝날 수 있습니다. 취소된 실행도 추적은 그대로 내보냅니다.",
      },
      {
        q: "npm에 있나요?",
        a: "아직 없습니다. bun install과 bun link로 소스에서 설치하거나, bun run build로 약 110 MB짜리 단일 바이너리를 만들거나, npm pack으로 tarball을 만들어 전역 설치하세요.",
      },
      {
        q: "라이선스는 무엇을 요구하나요?",
        a: "AGPL-3.0입니다. 쓰고, 살피고, 고치고, 다시 나눌 수 있습니다. 모든 사본과 파생물에 라이선스와 저작권 고지를 남기세요. 고친 rovecode를 네트워크 서비스로 돌린다면 그 서비스 이용자에게 완전한 소스를 제공해야 합니다. 제삼자 고지는 THIRD_PARTY_NOTICES.md에 있습니다. crush(FSL), claw-code, nanocoder, iflow, Claude Agent SDK에서 가져온 코드는 없습니다.",
      },
    ],
  },
  cta: { eyebrow: "rovecode 받기", title: "패널 여섯. 제공자 열여섯. 가격표는 없음.", button: "GitHub에서 별 주기", quip: "해가 났어요.", mood: "맑음" },
  footer: {
    blurb: "터미널을 위한 코딩 에이전트. Bun 위의 TypeScript, 이식한 패턴 47개, 모든 도구 앞에 기본이 거부인 정책 하나.",
    notice: "이식한 출처는 MIT나 Apache-2.0뿐이며, 고지는 THIRD_PARTY_NOTICES.md에 있습니다.",
    heads: ["프로젝트", "표면", "설정", "안전"],
  },
  pet: {
    alt: "구름 마스코트 Rovecode",
    edit: "연필을 들고",
    read: "돋보기로 들여다보며",
    guard: "방패를 들고",
    rewind: "되감기 화살표 시계를 들고",
    done: "엄지를 치켜들고",
  },
};
