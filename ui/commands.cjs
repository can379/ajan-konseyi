// Eğik çizgi komutları: composer'da "/" yazınca açılan komut paleti.
//
// İki tür komut vardır:
//  - "onek":  mesajla birlikte gider; yönlendirme kademesini, modu veya hedef
//             üyeyi belirler. Girdi kutusunda kalır, gönderimde ayrıştırılır.
//  - "eylem": seçildiği anda çalışır (sekme açar, sohbeti yönetir); mesaj
//             gönderilmez.
//
// Bu dosya bilerek saf tutulur (DOM yok): app.js tarayıcıda yükler, testler
// Node'dan require eder. Eylemlerin gerçek uygulaması app.js'tedir; burada
// yalnız eylem ADI taşınır ki kayıt defteri tek başına doğrulanabilsin.

const SLASH_COMMANDS = [
  // ---- Yönlendirme kademeleri ----
  { cmd: "hizli",    tur: "onek", grup: "Yönlendirme", aciklama: "Tek üye, en hızlı yanıt — tören yok", approach: "quick" },
  { cmd: "ikili",    tur: "onek", grup: "Yönlendirme", aciklama: "Bir üye üretir, başka bir üye bağımsız denetler", approach: "pair" },
  { cmd: "konsey",   tur: "onek", grup: "Yönlendirme", aciklama: "Tam konsey: görev dağıtımı, tartışma, oylama, kanıt kapısı", approach: "council" },
  { cmd: "kod",      tur: "onek", grup: "Yönlendirme", aciklama: "Kod modu: ayrı çalışma kopyaları ve test kanıtıyla konsey", approach: "council", mode: "code" },
  { cmd: "tartisma", tur: "onek", grup: "Yönlendirme", aciklama: "Tartışma modu: üyeler görüş üretir ve çapraz değerlendirir", approach: "council", mode: "discussion" },
  { cmd: "bol",      tur: "onek", grup: "Yönlendirme", aciklama: "İş bölümü: görev üyeler arasında paylaştırılır", approach: "council", mode: "split" },

  // ---- Hazır istekler ----
  { cmd: "incele",   tur: "onek", grup: "İstek", aciklama: "Çok sağlayıcılı bağımsız inceleme başlatır", approach: "council", mode: "discussion",
    sablon: "Aşağıdakini her üye BAĞIMSIZ incelesin; bulgulara dosya:satır kanıtı verilsin, bulgu yoksa açıkça söylensin:\n\n" },
  { cmd: "arastir",  tur: "onek", grup: "İstek", aciklama: "Webden güncel kaynaklarla araştırma ister",
    sablon: "Webden güncel kaynaklarla araştır ve kaynak bağlantılarıyla raporla: " },
  { cmd: "ozetle",   tur: "onek", grup: "İstek", aciklama: "Bu sohbeti kısa maddelerle özetletir", approach: "quick",
    sablon: "Bu sohbeti kısa maddelerle özetle: alınan kararlar, yapılanlar ve açık işler.", metinsiz: true },
  { cmd: "yayinla",  tur: "onek", grup: "İstek", aciklama: "Seçili projeyi GitHub'a yayınlatır (deploy key ile)", approach: "quick",
    sablon: "Seçili projenin son sürümünü GitHub'a yayınla.", metinsiz: true },

  // ---- Üyeye doğrudan ----
  { cmd: "claude",      tur: "onek", grup: "Üye", aciklama: "Mesajı doğrudan Claude'a gönderir", uye: "Claude" },
  { cmd: "codex",       tur: "onek", grup: "Üye", aciklama: "Mesajı doğrudan Codex'e gönderir", uye: "Codex" },
  { cmd: "antigravity", tur: "onek", grup: "Üye", aciklama: "Mesajı doğrudan Antigravity'ye gönderir", uye: "Antigravity" },
  { cmd: "ox",          tur: "onek", grup: "Üye", aciklama: "Mesajı doğrudan Ox Alpha'ya gönderir", uye: "Ox Alpha" },

  // ---- Sohbet yönetimi ----
  { cmd: "yeni",     tur: "eylem", grup: "Sohbet", aciklama: "Yeni sohbet başlatır", eylem: "yeniSohbet" },
  { cmd: "durdur",   tur: "eylem", grup: "Sohbet", aciklama: "Süren turu durdurur", eylem: "turuDurdur" },
  { cmd: "adlandir", tur: "eylem", grup: "Sohbet", aciklama: "Sohbeti yeniden adlandırır", eylem: "yenidenAdlandir" },
  { cmd: "sabitle",  tur: "eylem", grup: "Sohbet", aciklama: "Sohbeti sabitler / sabitlemeyi kaldırır", eylem: "sabitle" },
  { cmd: "arsivle",  tur: "eylem", grup: "Sohbet", aciklama: "Sohbeti arşivler", eylem: "arsivle" },
  { cmd: "disa",     tur: "eylem", grup: "Sohbet", aciklama: "Sohbeti JSON olarak dışa aktarır", eylem: "disaAktar" },
  { cmd: "devret",   tur: "eylem", grup: "Sohbet", aciklama: "Sohbeti bağlamıyla başka ajana devreder", eylem: "devret" },

  // ---- Çalışma alanı ----
  { cmd: "proje",    tur: "eylem", grup: "Çalışma alanı", aciklama: "Proje seçiciyi açar", eylem: "projeSec" },
  { cmd: "terminal", tur: "eylem", grup: "Çalışma alanı", aciklama: "Proje terminalini açar", eylem: "sekme:terminal" },
  { cmd: "dosyalar", tur: "eylem", grup: "Çalışma alanı", aciklama: "Proje dosya editörünü açar", eylem: "sekme:editor" },
  { cmd: "tarayici", tur: "eylem", grup: "Çalışma alanı", aciklama: "Yerleşik tarayıcıyı açar", eylem: "sekme:browser" },
  { cmd: "onizle",   tur: "eylem", grup: "Çalışma alanı", aciklama: "Canlı önizlemeyi açar", eylem: "sekme:preview" },
  { cmd: "gorevler", tur: "eylem", grup: "Çalışma alanı", aciklama: "Görev merkezini açar", eylem: "sekme:tasks" },
  { cmd: "git",      tur: "eylem", grup: "Çalışma alanı", aciklama: "Git ve test panelini açar", eylem: "sekme:git" },
  { cmd: "guvenlik", tur: "eylem", grup: "Çalışma alanı", aciklama: "İzin ve güvenlik panelini açar", eylem: "sekme:security" },
  { cmd: "gerisar",  tur: "eylem", grup: "Çalışma alanı", aciklama: "Kontrol noktalarını açar; bir ana geri dönebilirsiniz", eylem: "kontrolNoktalari" },
  { cmd: "kontrol",  tur: "eylem", grup: "Çalışma alanı", aciklama: "Yeni kontrol noktası oluşturur", eylem: "kontrolNoktalari" },

  // ---- Uygulama ----
  { cmd: "ayarlar",    tur: "eylem", grup: "Uygulama", aciklama: "Uygulama ayarlarını açar", eylem: "ayar:general" },
  { cmd: "uyeler",     tur: "eylem", grup: "Uygulama", aciklama: "Üye ve model ayarlarını açar", eylem: "ayar:agents" },
  { cmd: "model",      tur: "eylem", grup: "Uygulama", aciklama: "Üye model seçimlerini açar", eylem: "ayar:agents" },
  { cmd: "yetenekler", tur: "eylem", grup: "Uygulama", aciklama: "Ajan yetenek envanterini açar", eylem: "ayar:capabilities" },
  { cmd: "guncelle",   tur: "eylem", grup: "Uygulama", aciklama: "Uygulama güncellemelerini denetler", eylem: "ayar:updates" },
  { cmd: "mcp",        tur: "eylem", grup: "Uygulama", aciklama: "MCP sunucu modunu ve kurulum komutlarını gösterir", eylem: "mcpBilgi" },
  { cmd: "yedekle",    tur: "eylem", grup: "Uygulama", aciklama: "Fotoğraf, video ve sohbetleri yedek klasörüne aynalar", eylem: "yedekle" },
];

const KOMUT_RE = /^\/([a-zçğıöşü-]+)(?:\s+([\s\S]*))?$/i;

function trLower(value) {
  return String(value || "").toLocaleLowerCase("tr-TR");
}

// "/kons" gibi yarım girdiyi palet için eşler. Boş sorgu tüm listeyi verir.
function filterSlashCommands(query) {
  const q = trLower(query).replace(/^\//, "");
  if (!q) return SLASH_COMMANDS;
  const bastan = SLASH_COMMANDS.filter((c) => trLower(c.cmd).startsWith(q));
  const iceren = SLASH_COMMANDS.filter((c) => !trLower(c.cmd).startsWith(q)
    && (trLower(c.cmd).includes(q) || trLower(c.aciklama).includes(q)));
  return [...bastan, ...iceren];
}

// Gönderilen metnin başındaki komutu ayrıştırır. Komut değilse null döner;
// bilinmeyen komut da null'dur ki normal mesaj olarak gitsin ("/ kesir" gibi
// sıradan kullanım engellenmez).
function parseSlashInput(text) {
  const match = String(text || "").trim().match(KOMUT_RE);
  if (!match) return null;
  const command = SLASH_COMMANDS.find((c) => trLower(c.cmd) === trLower(match[1]));
  if (!command) return null;
  return { command, rest: (match[2] || "").trim() };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SLASH_COMMANDS, filterSlashCommands, parseSlashInput };
}
