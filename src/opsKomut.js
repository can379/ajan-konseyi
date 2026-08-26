// Serbest metin komutlarini operasyon isine cevirir.
//
// Kullanici istegi: "operasyon kisminda yazarak istekte bulunabileyim —
// 'Codex'e WOOY magazasina gir oradan gecilmeyen siparisleri gec' gibi,
// ya da 'iadeleri al', ya da 'su musteriye mantikli bir cevap ver'."
//
// Tasarim: komut ONCE koda cozulur (hangi uye, hangi magaza, hangi is), sonra
// oyun kitabindaki prosedure baglanir. Modelin serbest yorumuna birakilmaz —
// "WOOY'a gir" derken yanlis magazaya baglanmak bu projede en pahali hata.
// Cozulemeyen parca UYDURULMAZ: eksik olan kullaniciya sorulur.

import { OYUN_KITABI, RISK } from "./opsPlaybook.js";

// Uye adi -> uye. Kullanici "Codex'e" veya "Claude" diye yazabilir.
export function uyeCoz(metin, uyeler = []) {
  const sade = String(metin || "").toLocaleLowerCase("tr-TR");
  for (const uye of uyeler) {
    const ad = String(uye.name || "").toLocaleLowerCase("tr-TR");
    if (!ad) continue;
    // Ek almis hallerini de yakala: "codex'e", "claude'a", "antigravity ile"
    const desen = new RegExp(`(?<![\\p{L}\\p{N}])${ad.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:['’][a-zçğıöşü]{1,3})?(?![\\p{L}\\p{N}])`, "iu");
    if (desen.test(sade)) return uye;
  }
  return null;
}

// Magaza adi -> kayitli cihaz. BIREBIR eslesme sart; benzer ad kabul edilmez.
//
// Turkce ek sorunu: kullanici "WOOY'a gir" degil, cogu zaman "wooya gir",
// "anneye bak", "lutufa gir" yaziyor — kesme isareti koymuyor. Ilk surum
// yalniz kesmeli hali taniyordu ve "wooya gir" komutu "hangi magaza
// yazilmamis" diye reddediliyordu. Artik ad, dogrudan yapisik gelen en
// fazla 4 harflik bir ekle de eslesir.
//
// Yanlis eslesmeyi onleyen sinir: ekten SONRA harf/rakam gelmemeli, yani
// "anne" -> "anneye" (ek) eslesir ama daha uzun bir kelimenin ORTASINA
// denk gelen ad eslesmez. Ad 3 harften kisaysa ek aranmaz; iki harflik bir
// ad her kelimeye uyar.
export function magazaCoz(metin, cihazlar = []) {
  const sade = String(metin || "").toLocaleLowerCase("tr-TR");
  const bulunanlar = cihazlar.filter((c) => {
    const ad = String(c.name || "").toLocaleLowerCase("tr-TR");
    if (!ad) return false;
    const kacis = ad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ek = ad.length >= 3 ? "(?:['’]?[a-zçğıöşü]{1,4})?" : "(?:['’][a-zçğıöşü]{1,4})?";
    const desen = new RegExp(`(?<![\\p{L}\\p{N}])${kacis}${ek}(?![\\p{L}\\p{N}])`, "iu");
    return desen.test(sade);
  });
  if (bulunanlar.length === 1) return { ok: true, magaza: bulunanlar[0].name };
  if (bulunanlar.length > 1) return { ok: false, sebep: "belirsiz",
    mesaj: `Birden fazla mağaza adı geçiyor (${bulunanlar.map((c) => c.name).join(", ")}); hangisi olduğunu tek tek yazın.` };
  return { ok: false, sebep: "yok", mesaj: "Hangi mağaza olduğu yazılmamış." };
}

// Niyet -> is turu. Anahtar kelimeler CanSellerAI'nin kendi dilinden.
const NIYETLER = [
  { isTuru: "amazon_siparis", desen: /geçil?me(?:yen|miş)|geçemedi|sipariş\w*\s*(?:geç|ver|aç)|order\s*ver|satın\s*al/iu },
  { isTuru: "amazon_iade", desen: /iade\w*\s*(?:al|başlat|işle|yap|hallet)|return\s*(?:al|başlat)|etiket\s*al|iade\s*etiketi/iu },
  { isTuru: "ebay_dava", desen: /dava|case\b|anlaşmazlık|itiraz|savunma|kanıt\s*(?:paketi|hazırla)/iu },
  { isTuru: "ebay_mesaj", desen: /mesaj|yanıt\s*ver|cevap\s*ver|müşteriye\s*yaz|alıcıya\s*yaz|okunmamış/iu },
  { isTuru: "stok_yok_mesaji", desen: /stok(?:ta)?\s*yok|iptal\s*mesaj|tedarik\s*edilemiyor/iu },
  { isTuru: "oturum", desen: /oturum|giriş\s*(?:düşmüş|kontrol)|captcha|doğrulama\s*ekranı/iu },
];

export function niyetCoz(metin) {
  const m = String(metin || "");
  for (const n of NIYETLER) if (n.desen.test(m)) return n.isTuru;
  return null;
}

// Metinden varlik kimligi (siparis/iade/dava numarasi) cikar — varsa is
// dogrudan o kayda baglanir.
export function kimlikCoz(metin) {
  const m = String(metin || "");
  return m.match(/\b\d{2}-\d{5}-\d{5}\b/)?.[0]          // eBay siparis
    || m.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0]            // Amazon siparis
    || m.match(/\b\d{9,}\b/)?.[0]                        // iade/dava numarasi
    || null;
}

// Komutu coz: ne anlasildi, ne eksik?
export function komutCoz(metin, { uyeler = [], cihazlar = [] } = {}) {
  const uye = uyeCoz(metin, uyeler);
  const magaza = magazaCoz(metin, cihazlar);
  const isTuru = niyetCoz(metin);
  const kimlik = kimlikCoz(metin);
  const eksik = [];
  if (!magaza.ok) eksik.push(magaza.mesaj);
  if (!isTuru) eksik.push("Ne yapılacağı anlaşılmadı (iade / sipariş / dava / mesaj).");
  return {
    ok: Boolean(magaza.ok && isTuru),
    uye: uye ? { id: uye.id, name: uye.name } : null,
    magaza: magaza.ok ? magaza.magaza : null,
    isTuru,
    isAdi: isTuru ? OYUN_KITABI[isTuru]?.ad || isTuru : null,
    risk: isTuru ? (OYUN_KITABI[isTuru]?.risk ?? RISK.ONAY) : null,
    kimlik,
    eksik,
    ozet: isTuru && magaza.ok
      ? `${magaza.magaza} · ${OYUN_KITABI[isTuru]?.ad || isTuru}${kimlik ? ` · ${kimlik}` : ""}${uye ? ` · ${uye.name}` : ""}`
      : null,
    ham: String(metin || "").slice(0, 500),
  };
}

// ---- YAPAY ZEKA YORUMU ------------------------------------------------
//
// Kullanici: "bunu yapay zeka bakmalı; hangi yapay zekanın bakacağına karar
// veren ben olmalıyım."
//
// Sira: ONCE kural. Kural cozerse uyeye hic gidilmez — hizli, ucuz, ve her
// seferinde ayni sonucu verir. Kural cozemezse SECILEN uye yorumlar.
//
// Uyenin yorumu SERBEST DEGIL: yalniz verilen magaza ve is turu listesinden
// secebilir. Liste disi bir sey donerse yorum REDDEDILIR. Sebep: "WOOY'a
// gir" derken yanlis magazaya baglanmak bu projedeki en pahali hata; modele
// magaza adi UYDURMA yetkisi verilemez.
export function yorumIstemi(metin, { cihazlar = [], isTurleri = {} } = {}) {
  const magazalar = cihazlar.map((c) => c.name).filter(Boolean);
  const turler = Object.entries(isTurleri).map(([k, v]) => `  ${k} = ${v}`).join("\n");
  return `Bir mağaza operatörünün serbest yazdığı komutu anlamaya çalışıyorsun.

KOMUT: "${String(metin || "").slice(0, 500)}"

Yalnız aşağıdaki listelerden seçebilirsin. Listede olmayan bir şey YAZMA.

MAĞAZALAR:
${magazalar.map((m) => `  ${m}`).join("\n")}

İŞ TÜRLERİ:
${turler}

Türkçe ekleri hesaba kat: "wooya gir" = WOOY, "anneye bak" = ANNE.

Yalnız şu JSON'u döndür, başka hiçbir şey yazma:
{"magaza":"<listeden bir ad ya da null>","isTuru":"<listeden bir anahtar ya da null>","guven":"yuksek|dusuk","neden":"<tek cümle>"}

Emin değilsen null yaz ve guven "dusuk" olsun. Tahmin yürütme —
yanlış mağazaya bağlanmak geri alınamaz işlem yapılmasına yol açar.`;
}

// Uyenin dondugu yorumu DOGRULA. Liste disi deger, uydurulmus ad ya da
// dusuk guven -> kabul edilmez.
export function yorumDogrula(ham, { cihazlar = [], isTurleri = {} } = {}) {
  if (!ham || typeof ham !== "object") return { ok: false, mesaj: "Yorum okunamadı." };
  const adlar = cihazlar.map((c) => String(c.name));
  const magaza = ham.magaza == null ? null : String(ham.magaza);
  const isTuru = ham.isTuru == null ? null : String(ham.isTuru);

  if (magaza && !adlar.includes(magaza)) {
    return { ok: false, mesaj: `Kayıtlı olmayan mağaza önerildi: "${magaza}"` };
  }
  if (isTuru && !Object.keys(isTurleri).includes(isTuru)) {
    return { ok: false, mesaj: `Tanımsız iş türü önerildi: "${isTuru}"` };
  }
  if (!magaza || !isTuru) return { ok: false, mesaj: "Yorumlanamadı: eksik kaldı." };
  if (String(ham.guven || "").toLocaleLowerCase("tr-TR") !== "yuksek") {
    return { ok: false, mesaj: `Emin olunamadı${ham.neden ? `: ${String(ham.neden).slice(0, 160)}` : ""}` };
  }
  return { ok: true, magaza, isTuru, neden: String(ham.neden || "").slice(0, 200) };
}
