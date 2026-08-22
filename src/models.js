// Ajan başına model kataloğu.
// value: CLI'ya --model / -m ile geçen kimlik; label: arayüzde görünen ad.
// Kimlik CLI tarafından tanınmazsa adaptörler otomatik olarak varsayılan
// modelle yeniden dener (abonelik dışı bir model asla zorlanmaz).
// Çaba (reasoning effort) seviyeleri — ajan başına seçilir.
// Claude: düşünme bütçesine (MAX_THINKING_TOKENS), Codex: model_reasoning_effort'a eşlenir.
export const EFFORT_LEVELS = [
  { value: "", label: "Varsayılan çaba" },
  { value: "sinirli", label: "Sınırlı — en hızlı, en az tüketim" },
  { value: "orta", label: "Orta — dengeli" },
  { value: "yuksek", label: "Yüksek — derin düşünme" },
  { value: "cokyuksek", label: "Çok Yüksek — zor problemler" },
  { value: "ultra", label: "Ultra — limitleri daha hızlı tüketir" },
];

export const CLAUDE_EFFORT_TOKENS = { sinirli: 1024, orta: 8192, yuksek: 16384, cokyuksek: 32000, ultra: 63999 };
export const CODEX_EFFORT = { sinirli: "low", orta: "medium", yuksek: "high", cokyuksek: "xhigh", ultra: "xhigh" };

// Akıllı model eşleme: koordinatör alt görevin zorluğuna göre kademe seçer.
// Yalnızca kullanıcı o ajan için "Otomatik" model seçtiyse uygulanır.
export const TIER_MAP = {
  claude: { fast: "haiku", balanced: "sonnet", strong: "opus" },
  codex: { fast: "gpt-5.6-luna", balanced: "gpt-5.6-terra", strong: "gpt-5.6-sol" },
  antigravity: {},
};

export const MODEL_CATALOG = {
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
    { value: "gpt-5.4", label: "GPT-5.4 — 31 Ağustos'ta kalkıyor" },
    { value: "gpt-5.5", label: "GPT-5.5 — yüksek tüketim" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol — en güçlü · yüksek tüketim" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark — araştırma" },
  ],
  antigravity: [
    { value: "", label: "Otomatik · Antigravity hesabının varsayılan modeli" },
    { value: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium) — yeni ve hızlı" },
    { value: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low) — güçlü" },
    { value: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium) — hızlı" },
  ],
};
