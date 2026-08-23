import fs from "node:fs";
import { BaseAgent } from "./base.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_HISTORY_CHARS = 24_000;
const DEFAULT_RETRY_DELAYS_MS = [1_200, 2_500, 5_000];
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const OX_ALPHA_IDENTITY = `You are Ox Alpha, the model reached through OpenRouter with the public model id stealth/ox-alpha.
Your underlying developer/provider is anonymous during the OpenRouter preview. You must never claim that you are Codex, ChatGPT, an OpenAI model, Claude, Gemini, or any other named product/provider. "Ox Alpha" is not merely a UI alias for Codex.
If asked who or what you are, answer that you are Ox Alpha and that your underlying provider is not publicly verified. Clearly distinguish verified facts from inference. Continue answering in the user's language.`;

function isIdentityQuestion(prompt) {
  return /(?:kimsin|kimliğin|codex\s*mi|codex\s*değil|who are you|are you codex|what model)/iu.test(String(prompt));
}

function verifiedIdentityAnswer(prompt) {
  const turkish = /[çğıöşü]|\b(?:kimsin|sen|değil|misin|model|kimliğin)\b/iu.test(String(prompt));
  return turkish
    ? "Ben OpenRouter üzerinden `stealth/ox-alpha` kimliğiyle sunulan Ox Alpha modeliyim. Codex değilim. Altta çalışan geliştirici/sağlayıcı önizleme süresince anonim tutulduğu için onun kimliği doğrulanmış değildir."
    : "I am Ox Alpha, served through OpenRouter as `stealth/ox-alpha`. I am not Codex. My underlying developer/provider is anonymous during the preview and is therefore not publicly verified.";
}

function userContent(prompt, images = []) {
  const parts = [{ type:"text", text:String(prompt) }];
  for (const file of images.slice(0, 5)) {
    try {
      const ext = String(file).toLowerCase().split(".").pop();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      parts.push({ type:"image_url", image_url:{ url:`data:${mime};base64,${fs.readFileSync(file).toString("base64")}` } });
    } catch {}
  }
  return parts.length === 1 ? parts[0].text : parts;
}

function contentChars(content) {
  if (typeof content === "string") return content.length;
  return Array.isArray(content)
    ? content.reduce((sum, part) => sum + (part?.type === "text" ? String(part.text || "").length : 0), 0)
    : 0;
}

// Son mesajları korurken eski bağlamın her çağrıda sınırsız büyümesini engeller.
// Görseller base64 olduğu için karakter hesabına katılmaz; yine de mesaj sayısı sınırı vardır.
function boundedHistory(history, maxChars = DEFAULT_HISTORY_CHARS) {
  const picked = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && picked.length < 12; i--) {
    const message = history[i];
    const size = contentChars(message?.content);
    if (picked.length && chars + size > maxChars) break;
    picked.unshift(message);
    chars += size;
  }
  return picked;
}

function retryAfterMs(response, fallback) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(15_000, Math.max(0, seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(15_000, Math.max(0, date - Date.now())) : fallback;
}

function waitWithSignal(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Durduruldu"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once:true });
  });
}

async function readStream(response, onDelta) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let id = null;
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() || "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let event;
      try { event = JSON.parse(raw); } catch { continue; }
      id ||= event.id || null;
      usage = event.usage || usage;
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        onDelta(text);
      }
    }
    if (done) break;
  }
  return { id, text, usage:usage || {} };
}

export class OpenRouterAgent extends BaseAgent {
  constructor(store, rootDir, { keyProvider, fetchImpl = globalThis.fetch } = {}) {
    super("openrouter", store, rootDir);
    this.keyProvider = keyProvider;
    this.fetchImpl = fetchImpl;
    this.histories = new Map();
  }

  async isConfigured() { return !!(await this.keyProvider?.()); }
  isAvailable() { return super.isAvailable(); }
  resetSession(prefix) {
    super.resetSession(prefix);
    for (const key of [...this.histories.keys()]) if (!prefix || key === prefix || key.startsWith(prefix + "#")) this.histories.delete(key);
  }

  async invoke(prompt, opts = {}) {
    const apiKey = await this.keyProvider?.();
    if (!apiKey) throw new Error("OpenRouter API anahtarı ayarlanmamış");
    const sessionKey = opts.sessionKey || "global";
    const identityQuestion = isIdentityQuestion(prompt);
    // Kimlik tartışmalarındaki eski, hatalı asistan cevaplarını yeni isteğe taşımayın.
    const prior = opts.fresh || identityQuestion ? [] : boundedHistory(this.histories.get(sessionKey) || [], opts.historyChars);
    const conversation = [...prior, { role:"user", content:userContent(prompt, opts.images || []) }];
    const messages = [{ role:"system", content:OX_ALPHA_IDENTITY }, ...conversation];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OpenRouter zaman aşımı")), opts.timeoutMs || 3 * 60_000);
    // BaseAgent.stop(runId) bu iptal tutamacını da çocuk süreç gibi sonlandırır.
    // Böylece HTTP/SSE isteği görsel veya metin bitene kadar arka planda kalmaz.
    const cancellation = { _sessionKey:sessionKey, _noForceKill:true, kill:() => controller.abort(new Error("Durduruldu")) };
    this.children.add(cancellation);
    try {
      const retryDelays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
      let response;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        response = await this.fetchImpl(ENDPOINT, {
          method:"POST",
          headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json", "X-OpenRouter-Title":"Ajan Konseyi" },
          body:JSON.stringify({
            model:opts.model || "stealth/ox-alpha",
            messages,
            stream:true,
            stream_options:{ include_usage:true },
            max_tokens:opts.maxTokens || (identityQuestion ? 500 : DEFAULT_MAX_OUTPUT_TOKENS),
          }),
          signal:controller.signal,
        });
        if (response.ok) break;
        const payload = await response.json().catch(() => ({}));
        const detail = payload?.error?.message || response.statusText;
        const canRetry = RETRYABLE_STATUS.has(response.status) && attempt < retryDelays.length;
        if (!canRetry) throw new Error(`OpenRouter ${response.status}: ${detail}`);
        await waitWithSignal(retryAfterMs(response, retryDelays[attempt]), controller.signal);
      }
      let payload = await readStream(response, (partial) => { if (!opts.silent) this.progress(opts.label || "", partial, opts.memberId); });
      // Test doubles and older fetch implementations may not expose a readable stream.
      if (!payload) payload = await response.json().catch(() => ({}));
      let text = payload?.text ?? payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("Ox Alpha metin yanıtı döndürmedi");
      // Stealth modeller öz-kimlik sorularında eğitim verilerinden yanlış ürün adı
      // üretebilir. Kullanıcıya yalnız doğrulanabilen sağlayıcı kimliğini gösterin.
      if (identityQuestion && /\b(?:codex|chatgpt|openai|claude|gemini)\b/iu.test(text)) text = verifiedIdentityAnswer(prompt);
      if (!opts.fresh) this.histories.set(sessionKey, [...conversation, { role:"assistant", content:text }].slice(-20));
      const usage = { input:payload.usage?.prompt_tokens || 0, cachedInput:0, output:payload.usage?.completion_tokens || 0, costUsd:payload.usage?.cost || 0 };
      (opts.onUsage || this.onUsage)?.(usage);
      if (!opts.silent) this.progress(opts.label || "", text, opts.memberId);
      return { ok:true, text, raw:{ id:payload.id, usage } };
    } finally {
      clearTimeout(timeout);
      this.children.delete(cancellation);
    }
  }
}
