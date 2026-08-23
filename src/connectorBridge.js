// Harici hesap bağlayıcıları için güvenli delegasyon katmanı.
// OAuth belirteçlerini sağlayıcılar arasında kopyalamaz. Bir sağlayıcının yerel
// bağlayıcısı yoksa görev, mevcut Codex oturumundaki resmi eklentiye devredilir.

export const CONNECTORS = {
  github: { label: "GitHub", pattern: /\bgithub\b|pull request|\bpr\b|issue|repository|repo\b/i },
  gmail: { label: "Gmail", pattern: /\bgmail\b|e-?posta|email|mail kutu/i },
  "google-drive": { label: "Google Drive", pattern: /google drive|\bdrive\b|google docs?|google sheets?|google slides?/i },
  figma: { label: "Figma", pattern: /\bfigma\b|figjam/i },
  canva: { label: "Canva", pattern: /\bcanva\b/i },
  slack: { label: "Slack", pattern: /\bslack\b/i },
  vercel: { label: "Vercel", pattern: /\bvercel\b/i },
};

// Canlı OAuth denetimiyle doğrulanmış doğrudan yollar. Codex yedi resmi
// eklentiyi taşır. Claude'da Figma/Slack/Vercel çalışıyor; Canva OAuth şu an
// upstream istemci hatası nedeniyle köprüden geçer. Antigravity ortak köprüyü
// kullanır.
export const DIRECT_CONNECTORS = {
  codex: new Set(Object.keys(CONNECTORS)),
  claude: new Set(["figma", "slack", "vercel"]),
  antigravity: new Set(),
};

export function requestedConnector(text) {
  const value = String(text || "");
  // "git config user.email", e-posta alanı veya kod içindeki `email` gibi
  // ifadeler bir Gmail görevi değildir. Gmail yalnız servis adı açıkça
  // söylendiğinde ya da e-posta nesnesi üzerinde gerçek bir kullanıcı eylemi
  // istendiğinde seçilir.
  const gmailMention=/\bgmail\b|mail kutu(?:su|sunu|sunda)?/iu.test(value);
  const configurationOnly=/\buser\.email\b|\bgit\s+(?:-c\s+[^\s]+\s+)*config\b/iu.test(value);
  const mailObject=/\be-?posta[^\s,.;:!?)]*|\b(?:mail|email)(?:i|leri|lerimi)?\b/iu.test(value);
  const mailAction=/(?:ara|bul|oku|listele|kontrol et|incele|özetle|göster|gönder|yolla|yanıtla|cevapla|sil|arşivle|taslak|oluştur|yaz)/iu.test(value);
  if(gmailMention||(!configurationOnly&&mailObject&&mailAction))return "gmail";
  return Object.entries(CONNECTORS)
    .filter(([id])=>id!=="gmail")
    .find(([, item]) => item.pattern.test(value))?.[0] || null;
}

export function connectorAccessMode(connector,text){
  if(!connector)return null;
  const value=String(text||"");
  const mutation=/(?:gönder|yolla|yanıtla|cevapla|sil|arşivle|taşı|yükle|oluştur|yarat|değiştir|düzenle|güncelle|yayınla|paylaş|birleştir|merge|push|deploy)/iu.test(value);
  return mutation?"write":"read";
}

export function connectorRoute(provider, text) {
  const connector = requestedConnector(text);
  if (!connector) return null;
  if (DIRECT_CONNECTORS[provider]?.has(connector)) {
    return { connector, mode: "direct", provider };
  }
  return { connector, mode: "shared", provider: "codex", requestedProvider: provider };
}

export function bridgePrompt(route, prompt) {
  if (!route || route.mode !== "shared") return prompt;
  const label = CONNECTORS[route.connector]?.label || route.connector;
  return `--- AJAN KONSEYİ ORTAK BAĞLAYICI KÖPRÜSÜ ---
Bu görev ${route.requestedProvider} üyesinden, çalışan Codex ${label} bağlayıcısına güvenli biçimde devredildi. Resmi ${label} eklentisini/aracını gerçekten kullan; erişmediğin veriyi erişmiş gibi yazma. Kullanıcı yalnız okuma/arama istediyse veri değiştirme. Yazma, gönderme, yayınlama, dağıtım, silme veya hesap etkili işlem isteniyorsa aracın normal güvenlik/onay kurallarını koru. OAuth anahtarı ya da gizli bilgi isteme, gösterme veya başka sağlayıcıya aktarma. Sonucu ayrı bir sohbet açmadan, asıl ajanın kullanıcıya aktarabileceği tamamlanmış yanıt olarak döndür.
--- KÖPRÜ SONU ---

${prompt}`;
}

export function connectorCatalog() {
  return Object.fromEntries(Object.entries(CONNECTORS).map(([id, item]) => [id, {
    id,
    label: item.label,
    providers: {
      codex: { mode: "direct", status: "connected" },
      claude: DIRECT_CONNECTORS.claude.has(id)
        ? { mode: "direct", status: "connected" }
        : { mode: "shared", status: "via-codex" },
      antigravity: { mode: "shared", status: "via-codex" },
    },
  }]));
}
