const KNOWN = new Set(["claude", "codex", "antigravity", "openrouter"]);

export function normalizeExcludedProviders(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => KNOWN.has(item)))];
}

export function excludedProvidersFromText(value) {
  const text = String(value || "");
  return [...KNOWN].filter((provider) => {
    const name = provider === "openrouter" ? "(?:openrouter|ox alpha)" : provider;
    return new RegExp(`(?:${name}).{0,32}(?:çalışmasın|kullanılmasın|kullanma|olmasın|dışla|hariç)|(?:${name})\\s+(?:değil|yok)`, "iu").test(text);
  });
}

export function providerAllowed(run, provider) {
  return !normalizeExcludedProviders(run?.excludedProviders).includes(String(provider || "").toLowerCase());
}

export function assertProviderAllowed(run, provider) {
  if (!providerAllowed(run, provider)) {
    const error = new Error(`${provider} sağlayıcısı bu koşuda kullanıcı tarafından dışlandı`);
    error.code = "PROVIDER_EXCLUDED";
    throw error;
  }
}
