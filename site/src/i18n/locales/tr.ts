import type { PartialDict } from "../en";

export const tr: PartialDict = {
  meta: {
    title: "Rovecode — terminal için bir kodlama ajanı",
    description: "Terminal için açık kaynak kodlama ajanı: panelli TUI kokpit, 16 sağlayıcı ya da OpenAI uyumlu uç nokta, varsayılanı reddet araç politikası. Bun, AGPL-3.0.",
  },
  nav: { cockpit: "Kokpit", capabilities: "Yetenekler", terminal: "Terminal", quickstart: "Hızlı başlangıç", providers: "Sağlayıcılar", security: "Güvenlik", faq: "SSS", market: "Market" },
  market: {
    kinds: { mcp: "MCP sunucusu", skill: "Beceri", plugin: "Eklenti" },
    title: "Tek market: MCP sunucuları, beceriler ve eklentiler",
    lead: "Rovecode'un kurabildiği her şey tek yerde — depodan okunur, her birinin yanında onu kuran tek komut. Aynı liste terminalde /market altında.",
    searchPlaceholder: "Markette ara",
    searchLabel: "Markette ara",
    all: "Hepsi",
    empty: "Bu aramaya uyan bir şey yok.",
    docsTitle: "Dokümantasyon",
    docsBy: "yazan",
    docsSource: "kaynak",
    docsOnThisPage: "Bu sayfada",
    docsTruncated: "Bu, daha uzun bir dokümanın başlangıcı:",
    docsReadFull: "tamamını kaynakta oku",
    installCta: "Kur",
    licenseLabel: "lisans",
    installLabel: "kurulum",
    runsLabel: "ne çalıştırır",
    alsoLabel: "ayrıca:",
    envLabel: "ortam",
    envNone: "hiçbir şey — anahtar istemez.",
    required: "zorunlu",
    optional: "isteğe bağlı",
    secret: "gizli",
    pendingLabel: "siz verirsiniz",
    targetLabel: "nereye iner",
    targetBody: "Kullanıcı kapsamı ~/.rovecode içine yazar ve her proje görür; proje kapsamı bu depoya yazar ve güven kapısından geçer. Rovecode hiçbir şey yazmadan önce kurulum planında tam dosyayı gösterir.",
    fromLabel: "bu depoda",
    backToAll: "marketin tamamı",
    registryNote: "Bu sayfa rovecode ile gelenleri listeler: seçilmiş MCP rafı ve yayımlanmış beceri ile eklenti katalogları. Canlı MCP kayıt defteri sayfaya gömülü değildir — CLI'dan ya da terminalden aradığınızda getirilir, yani burada gördüğünüz çevrimdışı da çalışır.",
  },
  ui: {
    skip: "İçeriğe geç",
    backToTop: "Rovecode, başa dön",
    sections: "Bölümler",
    copy: "kopyala",
    copied: "kopyalandı",
    copyAria: "Komutu kopyala",
    copiedAria: "Kopyalandı",
    or: "ya da",
    play: "oynat",
    pause: "duraklat",
    playAria: "Arka plan videosunu oynat",
    pauseAria: "Arka plan videosunu duraklat",
    language: "Dil",
    sitemap: "Site haritası",
    footerLabel: "Alt bilgi",
    facts: ["açık kaynak", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"],
  },
  hero: {
    title: "Sohbet günlüğü değil, *kokpiti* olan bir terminal kodlama ajanı.",
    sub: "Rovecode Bun üzerinde çalışır, 16 sağlayıcıyla ya da OpenAI uyumlu herhangi bir uç noktayla konuşur ve her araç çağrısını deponuza dokunmadan önce varsayılanı reddet olan bir politikadan geçirir. AGPL-3.0 altında özgür yazılım.",
    ctaGithub: "GitHub'da gör",
    ctaReadme: "README'yi oku",
    caption:
      "Gerçek kare: bun test için onay kartı, +4 −1 düzenleme satırı, bağlam 200k'nın %13'ünde. Sabit bir saatle sextant çizicilerinden geçirildi.",
    quip: "senden bir onay bekliyorum.",
    mood: "sabırlı",
    frameAlt:
      "160'a 44 hücrelik sextant TUI: git durumlarıyla dosya ağacı, düzenlenen satırları vurgulanmış src/auth/callback.ts'yi gösteren kod paneli, okuma ve düzenleme araç satırlarıyla mesaj paneli ve bun test çalıştırmak için izin isteyen onay kartı, 4 adımın 1'inde plan, %13 bağlam kullanımı ve onay bekleyen rovecode bulut maskotu.",
    chips: ["+4 −1 uygulandı", "önce sor · onay kartı", "bağlam 200k'nın %13'ü"],
  },
  proof: {
    eyebrow: "depodan, derleme anında",
    ariaLabel: "Depodan gelen sayılar",
    stats: [
      { label: "test", note: "test/ altındaki test() çağrıları, derlemede sayılır" },
      { label: "hazır sağlayıcı", note: "artı OpenAI uyumlu her URL" },
      { label: "politika katmanı", note: "rules · execpolicy · approval · runtime" },
      { label: "bu sayfadaki dil", note: "tarayıcıdan seçilir, değiştirilebilir" },
      { label: "lisans", note: "özgür yazılım, ağ kullanımına da uzanan copyleft" },
    ],
  },
  cockpit: {
    eyebrow: "kokpit",
    title: "Tek ekranda altı panel. Önemsediğin dosya asla kayıp gitmez.",
    lead: "Git durumuyla dosyalar, vurgu bandı ve ± fark ile kod, tek satırlık araç çağrıları, plan, kullanım ve maskot. Sabit bir saatle, başsız biçimde sextant çizicilerinden geçirilir: TUI'nin çizdiği kod yolunun aynısı, maket değil.",
    transcriptEyebrow: "mesajlar paneli · satır satır",
    transcriptTitle: "Yukarıdaki kareden çözülmüş tek bir koşu.",
    transcriptBody1:
      "Her araç çağrısı tek satır: fiil, dosya ve neyin değiştiği. Düzenleme +4 −1 olarak indi. Kabuk komutu üç yanıtlı tek bir kartın arkasında bekler; Esc reddeder ve yanıt oturumun geri kalanı için hatırlanır.",
    transcriptBody2: "Alt ajanlar soru soramaz. Yasaklı bir argv karta hiç ulaşmaz.",
  },
  problems: {
    eyebrow: "sorunlar → çözümler",
    title: "Terminal ajanlarında ters giden dört şey ve rovecode'un her birine yanıtı.",
    lead: "Klavye başında kuracağın cümlelerle söylenmiş, mekanizması ve sınırıyla yanıtlanmış. Her şerit gerçek bir kare kırpması ya da gerçek yapılandırma dosyası.",
    problemLabel: "sorun",
    solutionLabel: "rovecode ne yapıyor",
    items: [
      {
        problem: "Her ajan tek bir satıcının API'sine ve tek bir fiyat sayfasına kaynaklanmış geliyor.",
        solution:
          "Tek bir StreamFn dikişi ve canlı bir sağlayıcı kaydı. 16 adlandırılmış sağlayıcı ya da providers.json'daki OpenAI/Anthropic uyumlu herhangi bir uç nokta; başka bir terminalde eklenen sağlayıcı bir sonraki çağrıya hizmet eder. Rol yedek zincirleri 429 veya 5xx'te ilerler.",
      },
      {
        problem: "Ajan dosyayı düzenlerken sohbet günlüğü o dosyayı ekrandan kaydırıp götürüyor.",
        solution:
          "Panelli bir kokpit: dosyalar, kod, mesajlar, plan, kullanım ve bulut maskotu. Mesaj paneli her araç çağrısını tek satırda tutar; kod paneli inen tek parçayı gösterir.",
      },
      {
        problem: "Model rm -rf istiyor ve kimse zamanında hayır demediği için koşum onu çalıştırıyor.",
        solution:
          "Önce varsayılanı reddet olan joker kurallar, sonra yasaklının ne çalışmaya ne de bir insana ulaştığı execpolicy kararları, sonra düzeltilmiş argümanlar üstünde bir onay kartı. Üst üste 4 katman; hiçbiri kum havuzu taklidi yapmıyor.",
      },
      {
        problem: "40. tur ters gidiyor ve geri dönmenin tek yolu yeni bir konuşma.",
        solution:
          "sha256 karma zincirli, yalnızca eklemeli bir JSONL oturum ağacı. /rewind tur seçiciyi açar, herhangi bir turdan dallanır ve düzenleyiciyi o turun tam metniyle doldurur; gölge-git kontrol noktaları .git'ine dokunmadan 3 kipte geri yükler.",
      },
    ],
  },
  capabilities: {
    eyebrow: "yetenekler",
    title: "On yetenek; her biri file:line iziyle bir aktarım.",
    lead: "Rovecode; pi, opencode, codex, cline, aider, gemini-cli ve diğerlerinden kanıta dayalı desenler aktarır. Bir aktarım ancak temiz bağlamlı bir eleştirmen onu işe başlamadan yazılmış bir çıtaya karşı doğruladıktan sonra iner.",
    surfaceLabel: "yüzey",
    surfaceBody:
      "En az 100×30 truecolor bir TTY'de 6 panel: git durumuyla dosyalar, vurgu bandı ve ± fark ile kod, tek satırlık araç çağrıları, plan, kullanım, maskot. 3 palet, /theme canlı değiştirir; --classic pi-tui sohbetini korur.",
    surfaceAlt: "Sextant karesinden kırpma: dosya ağacı ve düzenleme vurgu bantlı kod paneli",
    providersLabel: "sağlayıcılar",
    providersTitle: "sağlayıcılar, anında yeniden yüklenir",
    providersBody:
      "16 hazır sağlayıcı ve providers.json'a kaydettiğin her şey. Her çağrı sağlayıcıyı canlı anlık görüntüye karşı çözer: başka bir terminalde ekle, çalışan kokpit bir sonraki çağrıda kullansın. Yeniden başlatma yok.",
    mediumLabels: ["bağlam", "güvenlik", "bellek"],
    medium: [
      { title: "MCP istemcisi", body: ".rovecode/mcp.json'dan stdio ve HTTP sunucuları. 2 kayıt aracıyla tembel açığa çıkarma sayesinde boştaki bir sunucu neredeyse sıfır token harcar." },
      { title: "Güvenlik merdiveni", body: "Her araç çağrısı çalışmadan önce dört basamak çıkar. Yasaklı bir argv hiçbir kanca görmeden reddedilir; --yolo istemleri atlar, reddetme kurallarını asla." },
      { title: "Oturum ağacı + kontrol noktaları", body: "sha256 karma zincirli, yalnızca eklemeli JSONL. /rewind dallanır, /resume kaldığı yerden alır, gölge-git kontrol noktaları 3 kipte geri yükler ve .git'ine hiç dokunmaz." },
    ],
    small: [
      { title: "Zed + JetBrains için ACP", body: "stdio üzerinden Agent Client Protocol v1, resmî SDK." },
      { title: "Başsız HTTP + SSE", body: "Oturumlar, tek bir RunEvent akışı, /doc'ta OpenAPI. 4100 portu, yalnız geri döngü." },
      { title: "Arka plan alt ajanları", body: "Sınırlı FIFO alt oturumlar, öntanımlı 3 eşzamanlı; notlar üst oturumun bir sonraki turunda düşer." },
      { title: "Kancalar", body: ".rovecode/hooks.ts içinde 9 tipli kanca, her biri 5 sn zaman aşımıyla sınırlı. pre_tool yalnızca reddedebilir." },
      { title: "OpenTelemetry", body: "Koşu başına tek iz: token, gecikme ve maliyetle run ⊃ turn ⊃ tool. Uç nokta boşsa dışa aktarıcı yok." },
    ],
  },
  terminal: {
    eyebrow: "terminalden",
    title: "160×44'te dört gerçek kare, okumaya değer yerleri numaralanmış.",
    lead: "Sabit bir saatle, başsız biçimde sextant çizicilerinden geçirildi: TUI'nin çizdiği kod yolunun aynısı, maket değil. Bir satırın üstüne gel ya da dokun; kare o noktaya 2× yakınlaşır.",
    shots: [
      {
        title: "Düzenleme indi. Kod paneli tam olarak o parçayı gösteriyor.",
        lead: "Onaylı bir düzenlemeden önce yakalandı, onaysız olanın ardından düzenlemenin kendi çıpalarından yeniden kuruldu.",
        alt: "düzenlemeden sonraki sextant karesi: fark kipindeki kod paneli tek bir parça gösteriyor, mesaj paneli okuma ve düzenleme satırlarını listeliyor",
        callouts: ["Düzenleme inerken ± fark kipine geç", "Diskteki dosyaya karşı +4 −1 oku", "Sıkışık araç satırlarını izle: önce okuma, sonra düzenleme", "Bağlamın 200k'nın %13'üne dolmasını izle"],
      },
      {
        title: "Bir kabuk komutu onay bekliyor. Tek kart, üç yanıt.",
        lead: "Onaylar düzeltilmiş argümanlar üzerinde çözülür ve oturum başına hatırlanır; alt ajanlar soru soramaz.",
        alt: "onay kartı açık sextant karesi: bash bun test tests/auth.test.ts, izin ver her zaman reddet",
        callouts: ["Çalışmadan önce tam argv'yi gör", "İzin ver, her zaman ya da reddet'i seç; Esc reddeder", "Başlık seni bekliyor durumuna geçer", "Maskot onayı ister, sonra hatırlar"],
      },
      {
        title: "Testler koştu. $ paneli çıktıyı tutar; başlık saati dondurur.",
        lead: "PASS ve FAIL rozetleri çıkış kodunu aracın kendi başlık satırından okur.",
        alt: "koşu bittikten sonraki sextant karesi: çalıştırma kipindeki kod paneli 18 geçen testle bun test çıktısını gösteriyor, plan 4/4 tamam",
        callouts: ["Koşu çıktısını $ kipinde oku, 18 geçti", "Plan 4/4 adımda kapanır", "Araç satırı çıktının son satırını taşır", "Maliyet çevrimdışı katalogdan $0.071 çıkar"],
      },
      {
        title: "İki arka plan görevi, her birine bir şerit, ekip panosunda.",
        lead: "Alt oturumlar tek ajan döngüsünü paylaşır; TUI'den çıkmak yaşayan her alt oturumu iptal eder.",
        alt: "ekip panosu açık sextant karesi: iki şerit, test yazma çalışıyor ve inceleme bitti",
        callouts: ["∷ ajanlar panosunu ⌃a ile aç", "Her şerit etiketi, geçen süreyi ve durumu gösterir", "Ekip özeti plan panelinde kalır", "Bu sırada ana koşu düzenlemeyi sürdürür"],
      },
    ],
  },
  quickstart: {
    eyebrow: "hızlı başlangıç",
    title: "Klonlamadan çalışan bir ajana üç komut.",
    lead: "Yapılandırılmış bir sağlayıcı yokken tek seferlik koşular senaryolu bir sahte sağlayıcı kullanır; paketleme dumanı da böyle çalışır.",
    steps: [
      { title: "Klonla ve bağla (Bun ≥ 1.3.14)", body: "CLI girişi bun tarafından çalıştırılan TypeScript'tir; node onu çalıştıramaz. bun link rovecode'u PATH'e koyar." },
      { title: "Bir model bağla", body: "rovecode setup adım adım yürütür: sağlayıcıyı seç, anahtarı gizli yapıştır, küçük bir test çağrısı, bitti. Ya da anahtarı doğrudan rovecode auth set ile sakla, ya da ROVECODE_BASE_URL'yi OpenAI uyumlu herhangi bir uç noktaya çevir." },
      { title: "Bir görev koştur ya da kokpiti aç", body: "Düz rovecode sextant yüzeyini açar. Tırnaklı bir istem tek seferlik koşudur; --output json tam olarak tek bir sonuç nesnesi döndürür." },
    ],
    outputAlt: "Koşu çıktısı: 18 geçti, 0 kaldı, 41 expect() çağrısı, 1 dosyada 18 test koştu.",
  },
  providers: {
    eyebrow: "sağlayıcılar",
    title: "16 hazır sağlayıcı ya da OpenAI uyumlu herhangi bir URL.",
    leadA: "Saklanan kimlik bilgileri ",
    leadB: " ortam değişkenlerini yener; açıkça verilen bir ",
    leadC: " çifti ikisini birden yener.",
    hosted: "barındırılan api'ler",
    local: "yerel çalışma zamanları",
    keyNote:
      "● yerel çalışma zamanları anahtar istemez · rovecode auth set <ad> anahtarı ~/.rovecode/credentials.json'a yazar; terminalde sorulur ve asla ekrana basılmaz.",
    liveLabel: "her uç nokta · canlı",
    liveTitle: "Başka bir terminalde sağlayıcı ekle; çalışan kokpit bir sonraki çağrıda onu alır. Yeniden başlatma yok.",
  },
  faq: {
    eyebrow: "sss",
    title: "İtirazlar, ayrıntılarıyla yanıtlandı.",
    lead: "İnsanların bir ajana kabuk emanet etmeden önce sorduğu yedi soru. Her yanıt mekanizmayı ve nerede durduğunu söyler.",
    aside:
      "Buradaki her şey README.md'nin Güvenlik modeli, Bilinen sınırlar, Gözlemlenebilirlik ve Lisans & bildirimler bölümlerinden alındı. README bir sınır olduğunu söylüyorsa bu sayfa da söyler.",
    items: [
      {
        q: "Bu bir kum havuzu mu?",
        a: "Hayır. Her araç çağrısının öncesinde ve çevresinde üst üste dört katman çalışır: varsayılanı reddet olan politika kuralları, execpolicy kararları (yasaklı bir komut ne çalışmaya ne de bir insana ulaşır), düzeltilmiş argümanlar üstündeki onay kapısı ve cwd kilidi olan çalışma zamanı bash reddetme listesi. Bash'in nerede koşacağı seçilebilir — doğrudan, WSL2 ya da Docker — ama her basamak yetki devri, yalıtım değil. Güvenilmeyen işler için konteyner ya da mikroVM kullan.",
      },
      {
        q: "Hangi modelleri kullanabilirim?",
        a: "16 adlandırılmış sağlayıcının sunduğu her şeyi ya da ~/.rovecode/providers.json'a kayıtlı (rovecode provider add) veya ROVECODE_BASE_URL ile verilen OpenAI/Anthropic uyumlu herhangi bir uç noktayı. Yerel araç çağrısı olmayan modellerde XML, Hermes ya da metin içi JSON ara katman tarafından yerel çağrılara çevrilir. Beş rolün (DEFAULT, SMOL, PLAN, COMMIT, TASK) her biri virgülle ayrılmış bir yedek zinciri alır.",
      },
      {
        q: "Eve telefon açıyor mu?",
        a: "Hayır. Dışarı giden trafik yapılandırdığın sağlayıcıya, listelediğin MCP sunucularına ve model istediğinde web_fetch'e gider (öntanımlı olarak sorulur, SSRF korumalı). OpenTelemetry dışa aktarımı vardır ama ROVECODE_OTEL_ENDPOINT ayarlanana kadar kapalıdır; o zaman bile kimlikleri, boyutları ve sonuçları taşır — istemleri, argümanları ya da çıktıyı asla. Fiyat kataloğu çevrimdışı bir anlık görüntüdür. Kendi kendini güncelleme yoktur.",
      },
      {
        q: "Yalnız Windows mu?",
        a: "Windows önce, yalnız Windows değil. Geliştirme ve sürüm kapısı Git Bash ile Windows 11'de koşar. POSIX yolları testlerde denenir ama Linux ve macOS henüz CI ile doğrulanmadı. Tek katı gereksinim Bun ≥ 1.3.14.",
      },
      {
        q: "Koşu ortasında Esc'e basınca ne olur?",
        a: "Koşunun denetleyicisi iptal eder: uçuştaki sağlayıcı isteği ölür (ölçülen ≤2 ms) ve çalışan bash çağrısı öldürülür. Windows'ta başlatıcı bir çekirdek Job Object içinde oturur, böylece tüm süreç ağacı onunla gider; POSIX'te kabuk SIGTERM alır ama çatallanmış bir torun kendi başına bitirebilir. İptal edilen koşular yine de izlerini dışa aktarır.",
      },
      {
        q: "npm'de var mı?",
        a: "Henüz yok. Kaynaktan bun install ve bun link ile kur, bun run build ile ~110 MB'lık tek bir ikili derle ya da npm pack ile tarball üretip onu global kur.",
      },
      {
        q: "Lisans ne gerektiriyor?",
        a: "AGPL-3.0. Kullan, incele, değiştir ve yeniden dağıt; her kopya ve türevde lisans ile telif bildirimlerini koru. Değiştirilmiş bir rovecode'u ağ hizmeti olarak çalıştırırsan tam kaynağını o hizmetin kullanıcılarına sunmalısın. Üçüncü taraf atıfları THIRD_PARTY_NOTICES.md'de; crush (FSL), claw-code, nanocoder, iflow ya da Claude Agent SDK'dan kod alınmadı.",
      },
    ],
  },
  security: {
    eyebrow: "güvenlik ve dağıtım",
    title: "Her araç çağrısının önünde dört katman. Yapılandırmadığınız hiçbir yere veri çıkmaz.",
    lead: "Güvenlik modeli, README'nin söylediği gibi, sınırlarıyla birlikte. Her katman neye karar verdiğini ve nerede durduğunu söyler; hiçbiri kum havuzu değildir.",
    cols: ["katman", "karar verir", "sınır"],
    layers: [
      { name: "rules", decides: "Araç ve argv üzerinde varsayılanı reddet joker kuralları. Yasaklı bir desen hiçbir şey çalışmadan reddedilir.", limit: "Desen eşleşmesi, niyet değil: tehlikeli bir komutun yeni bir yazımı bir sonraki katmana geçer." },
      { name: "execpolicy", decides: "Ayrıştırılmış argv üzerinde karar: izin, sor, yasak. Yasak, ne çalışmaya ne de bir insana ulaşır.", limit: "Komutu okur, çalışacağı kabuğu değil; bir alias ya da betik gövdesi ona opaktır." },
      { name: "approval", decides: "Düzeltilmiş argümanlar üstünde tek kart: izin ver, her zaman, reddet. Yanıtlar oturum başına hatırlanır; alt ajanlar soru soramaz.", limit: "İnsan kararı: --yolo bu basamağı atlar, üstündeki reddetme kurallarını asla." },
      { name: "runtime", decides: "Çalıştırma anında bash reddetme listesi ve cwd kilidi; Esc çalışan çağrıyı, Windows'ta tüm süreç ağacıyla birlikte öldürür.", limit: "Yetki devri, yalıtım değil. Güvenilmeyen iş konteyner ya da mikroVM'e ait." },
    ],
    deployLabel: "dağıtım ve veri",
    deploy: [
      { title: "Tanımı gereği kendi sunucunuzda", body: "Kaynaktan, kendi makinenizde ya da CI'nizde çalışır; barındırılan bir hizmet ya da hesap yok. Tek gereksinim Bun ≥ 1.3.14." },
      { title: "Eve telefon yok", body: "Dışa trafik yalnız yapılandırdığınız sağlayıcıya, listelediğiniz MCP sunucularına ve model istediğinde web_fetch'e gider. Fiyat kataloğu çevrimdışı bir anlık görüntü; kendini güncelleme yok." },
      { title: "Telemetri isteğe bağlı", body: "OpenTelemetry dışa aktarımı ROVECODE_OTEL_ENDPOINT ayarlanana dek kapalı; ayarlansa da yalnız kimlik, boyut ve sonuç taşır — istem, argüman ya da çıktı asla." },
      { title: "Yapısal denetim izi", body: "Oturumlar sha256 karma zincirli, yalnızca eklemeli JSONL; her koşu, iptal edilenler dahil, tek bir iz (run ⊃ turn ⊃ tool) dışa aktarır." },
      { title: "Platform durumu", body: "Windows öncelikli: geliştirme ve sürüm kapısı Windows 11'de. POSIX yolları test edilir; Linux ve macOS henüz CI ile doğrulanmadı." },
      { title: "Lisans", body: "AGPL-3.0-only. Serbestçe değiştirin ve dağıtın; değiştirilmiş bir yapıyı ağ hizmeti olarak çalıştırmak kaynağını o kullanıcılara sunmayı gerektirir." },
    ],
  },
  cta: { eyebrow: "rovecode'u al", title: "Altı panel. On altı sağlayıcı. Sıfır fiyat sayfası.", button: "GitHub'da yıldızla", quip: "güneş açtı.", mood: "güneşli" },
  footer: {
    blurb: "Terminal için bir kodlama ajanı. Bun üzerinde TypeScript, 47 aktarılmış desen, her aracın önünde varsayılanı reddet olan tek bir politika.",
    notice: "Aktarılan kaynaklar yalnızca MIT ya da Apache-2.0; atıflar THIRD_PARTY_NOTICES.md'de.",
    heads: ["Proje", "Yüzeyler", "Yapılandırma", "Güvenlik"],
  },
  pet: {
    alt: "Rovecode, bulut maskot",
    edit: "elinde kalem",
    read: "büyüteçle bakarken",
    guard: "elinde kalkan",
    rewind: "geri oklu bir saat tutarken",
    done: "başparmak kaldırırken",
  },
};
