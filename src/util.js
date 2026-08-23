import { randomUUID } from "node:crypto";

export function uid(prefix = "") {
  return prefix + randomUUID().slice(0, 8);
}

export function now() {
  return new Date().toISOString();
}

export function truncate(text, max = 4000) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [${text.length - max} karakter kırpıldı]`;
}

export function conversationTitle(text, max = 58) {
  let value = String(text || "")
    .replace(/^\s*@[^:]{1,40}:\s*/u, "")
    .replace(/^\s*(?:lütfen|şimdi|bana|bir|şunu|bunu)\s+/i, "")
    .replace(/\s+/g, " ").trim();
  value = value.replace(/[.!?]+$/g, "");
  if (!value) return "Yeni sohbet";
  if (value.length > max) {
    value = value.slice(0, max + 1);
    const cut = value.lastIndexOf(" ");
    value = (cut > max * .6 ? value.slice(0, cut) : value.slice(0, max)).trim() + "…";
  }
  return value.charAt(0).toLocaleUpperCase("tr-TR") + value.slice(1);
}

// LLM çıktısından ilk geçerli JSON nesnesini çıkarır.
// Modeller bazen JSON'u ```json blokları veya açıklama metniyle sarar.
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const cand of candidates) {
    const start = cand.indexOf("{");
    if (start === -1) continue;
    // Dengeli süslü parantez taraması
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cand.length; i++) {
      const ch = cand[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cand.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

// Alt süreçlere geçen ortamdan API anahtarlarını temizler.
// Sistemin temel kuralı: ücretli API kullanılmaz, yalnızca abonelik oturumları.
export function cleanEnv() {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
  ]) {
    delete env[key];
  }
  return env;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const USAGE_TIME_ZONE = "Europe/Istanbul";

export function usageDayKey(stamp, timeZone = USAGE_TIME_ZONE) {
  const date = stamp instanceof Date ? stamp : new Date(stamp ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Kayan 30 günlük pencere ile takvim ayını birbirine karıştırma.
export function summarizeCalendarMonth(records = [], stamp = Date.now(), timeZone = USAGE_TIME_ZONE) {
  const key = usageDayKey(stamp, timeZone);
  if (!key) return { month: null, cost: 0, tokens: 0, calls: 0 };
  const month = key.slice(0, 7);
  return records.filter((item) => String(item?.day || "").startsWith(`${month}-`)).reduce(
    (sum, item) => ({ month, cost: sum.cost + Number(item.cost || 0), tokens: sum.tokens + Number(item.tokens || 0), calls: sum.calls + Number(item.calls || 0) }),
    { month, cost: 0, tokens: 0, calls: 0 },
  );
}

// Bir koşunun kullanımını günlere dağıtır.
// `exact`: usageDaily'den gelen kesin günlük kayıtlar (düzeltme sonrası çağrılar).
// `fallbackDays`: kesin kaydı olmayan tarihsel bakiyenin yayılacağı mesaj günleri.
// Kesin kayıtlarla kümülatif toplam arasındaki FARK dağıtılır; böylece bir koşu
// hem eski (kayıtsız) hem yeni (kayıtlı) kullanım içerdiğinde tarihsel bakiye
// grafikten düşmez.
export function distributeRunUsage(total = {}, exact = [], fallbackDays = []) {
  const fields = ["input", "cachedInput", "output", "calls"];
  const residual = {};
  let residualSum = 0;
  for (const field of fields) {
    const covered = exact.reduce((sum, item) => sum + Number(item.usage?.[field] || 0), 0);
    residual[field] = Math.max(0, Number(total[field] || 0) - covered);
    residualSum += residual[field];
  }
  if (residualSum <= 0 || !fallbackDays.length) return [...exact];
  const share = fallbackDays.map((day) => ({
    day,
    usage: Object.fromEntries(fields.map((f) => [f, residual[f] / fallbackDays.length])),
  }));
  return [...exact, ...share];
}
