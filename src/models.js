// Ajan başına model kataloğu.
// value: CLI'ya --model / -m ile geçen kimlik; label: arayüzde görünen ad.
// Kimlik CLI tarafından tanınmazsa adaptörler otomatik olarak varsayılan
// modelle yeniden dener (abonelik dışı bir model asla zorlanmaz).
// Çaba (reasoning effort) seviyeleri — ajan başına seçilir.
// Sağlayıcıların CLI çaba seviyelerine eşlenir; Claude için eski düşünme bütçesi
// ortam değişkeni de geriye dönük uyumluluk amacıyla korunur.
export const EFFORT_LEVELS = [
  { value: "", label: "Varsayılan çaba" },
  { value: "sinirli", label: "Sınırlı — en hızlı, en az tüketim" },
  { value: "orta", label: "Orta — dengeli" },
  { value: "yuksek", label: "Yüksek — derin düşünme" },
  { value: "cokyuksek", label: "Çok Yüksek — zor problemler" },
  { value: "ultra", label: "Ultra — limitleri daha hızlı tüketir" },
];

export const CLAUDE_EFFORT_TOKENS = { sinirli: 1024, orta: 8192, yuksek: 16384, cokyuksek: 32000, ultra: 63999 };
// Yerel CLI yardımında doğrulanabilen modern seviyeler. Daha yüksek iki UI
// seviyesi, desteklenmeyen bir --effort değeri uydurmak yerine token fallback'ini kullanır.
export const CLAUDE_EFFORT = { sinirli: "low", orta: "medium", yuksek: "high" };
export const CODEX_EFFORT = { sinirli: "low", orta: "medium", yuksek: "high", cokyuksek: "xhigh", ultra: "xhigh" };
export const ANTIGRAVITY_EFFORT = { sinirli: "low", orta: "medium", yuksek: "high", cokyuksek: "high", ultra: "high" };

// Akıllı model eşleme: koordinatör alt görevin zorluğuna göre kademe seçer.
// Yalnızca kullanıcı o ajan için "Otomatik" model seçtiyse uygulanır.
export const TIER_MAP = {
  claude: { fast: "haiku", balanced: "sonnet", strong: "opus" },
  codex: { fast: "gpt-5.6-luna", balanced: "gpt-5.6-terra", strong: "gpt-5.6-sol" },
  antigravity: { fast: "gemini-3.7-flash-low", balanced: "gemini-3.7-flash-medium", strong: "gemini-3.1-pro-high" },
  openrouter: { fast: "stealth/ox-alpha", balanced: "stealth/ox-alpha", strong: "stealth/ox-alpha" },
};

export const MODEL_CATALOG = {
  openrouter: [
    { value: "stealth/ox-alpha", label: "Ox Alpha · 1M bağlam · OpenRouter" },
  ],
  claude: [
    { value: "", label: "Otomatik · Aboneliğin varsayılan modeli" },
    { value: "claude-fable-5", label: "Fable 5 — en güçlü · yüksek tüketim" },
    { value: "opus", label: "Opus — güçlü · yüksek tüketim" },
    { value: "sonnet", label: "Sonnet — dengeli" },
    { value: "haiku", label: "Haiku — hızlı · en az tüketim" },
  ],
  codex: [
    { value: "", label: "Otomatik · Aboneliğin varsayılan modeli" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna — en az tüketim" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 mini — düşük tüketim" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra — dengeli" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.5", label: "GPT-5.5 — yüksek tüketim" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol — en güçlü · yüksek tüketim" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark — araştırma" },
  ],
  antigravity: [
    { value: "", label: "Otomatik · Antigravity hesabının varsayılan modeli" },
    { value: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { value: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium) — yeni ve hızlı" },
    { value: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
    { value: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { value: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { value: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { value: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" },
    { value: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium) — hızlı" },
    { value: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Low)" },
    { value: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { value: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low) — güçlü" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 Thinking" },
    { value: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};

// Baglam penceresi TAHMINLERI. CLI'lar pencere boyutunu raporlamadigi icin
// bunlar muhafazakar varsayimlardir; arayuzde "tahmini" olarak sunulur.
// Doluluk olcumu: son cagrinin (input + cachedInput) degeri, o oturumda
// yeniden gonderilen tum konusmayi temsil eder — pratikte iyi bir vekildir.
export const CONTEXT_WINDOWS = {
  claude: { default: 200_000, byModel: [[/fable/i, 1_000_000], [/opus|sonnet|haiku/i, 200_000]] },
  codex: { default: 256_000, byModel: [[/gpt-5\.6|gpt-5\.5/i, 256_000], [/mini|luna/i, 128_000]] },
  openrouter: { default: 1_000_000, byModel: [] },
  antigravity: { default: 0, byModel: [] }, // kopru; kullanim verisi gelmez
};

export function contextWindowFor(provider, model = "") {
  const entry = CONTEXT_WINDOWS[provider];
  if (!entry) return 0;
  for (const [pattern, size] of entry.byModel) if (pattern.test(String(model || ""))) return size;
  return entry.default;
}
