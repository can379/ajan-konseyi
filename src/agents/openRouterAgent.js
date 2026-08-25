import fs from "node:fs";
import { BaseAgent } from "./base.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// stealth/ox-alpha bir AKIL YURUTME modelidir: "reasoning" tokenlari da
// max_tokens butcesinden dusulur. Dar bir butce uzun analiz isteklerinde
// tamamen dusunmeye harcanir, content bos kalir ve model finish_reason="length"
// ile biter. Butceyi modelin 1M baglamina yarasir bicimde genis tut.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const IDENTITY_MAX_OUTPUT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS_CEILING = 64_000;
// Akil yurutme + uzun uretim birlikte dakikalar surer: olculen tek bir cagri
// 24.860 token uretimi icin ~8 dakika aldi. Toplam sinir bu gercege gore genis,
// ama BaseAgent watchdog'unun (15 dk) altinda kalir. Asil koruma "durma"
// siniridir: veri akmayi birakirsa toplam siniri beklemeden hemen biter.
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
// Akil yurutme modelleri uzun sure yalniz dusunebilir. Keep-alive tespiti
// artik calistigi icin bu esik GERCEK sessizligi olcer; yine de guvenli bir
// pay birakilir.
const DEFAULT_STALL_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_HISTORY_CHARS = 24_000;
const DEFAULT_RETRY_DELAYS_MS = [1_200, 2_500, 5_000];
// 429 genelde HESAP kotasi degil, ust saglayicinin anlik yogunlugudur
// ("Provider returned error"). ~9 saniyelik kisa merdiven bunu asmaya
// yetmiyordu; 429'a ozel, daha uzun ve jitter'li bir merdiven kullanilir.
// Jitter, ayni anda calisan uyelerin ayni saniyede tekrar denemesini onler.
const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 6_000, 15_000, 30_000];
const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const OX_ALPHA_IDENTITY = `You are Ox Alpha, the model reached through OpenRouter with the public model id stealth/ox-alpha.
Your underlying developer/provider is anonymous during the OpenRouter preview. You must never claim that you are Codex, ChatGPT, an OpenAI model, Claude, Gemini, or any other named product/provider. "Ox Alpha" is not merely a UI alias for Codex.
If asked who or what you are, answer that you are Ox Alpha and that your underlying provider is not publicly verified. Clearly distinguish verified facts from inference. Continue answering in the user's language.`;

const IDENTITY_ANSWER_MAX_CHARS = 1_500;

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

function retryAfterMs(response, fallback, cap = 15_000) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(cap, Math.max(0, seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(cap, Math.max(0, date - Date.now())) : fallback;
}

// Hesap kotasinin gercekten dolmasi ile ust saglayicinin anlik mesguliyetini
// ayirt et: ilki uzun soguma gerektirir, ikincisi yalnizca beklemeyi.
function isUpstreamBusy(status, detail) {
  if (status !== 429) return false;
  return !/free-models-per-day|per-day|daily limit|credits|insufficient|quota exceeded/i.test(String(detail || ""));
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

function responseText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.type === "output_text") return String(part.text || "");
    return "";
  }).join("");
}

// Saglayici akil yurutmeyi "reasoning" (duz metin) veya "reasoning_details"
// (parcali) alaninda gonderir; ikisi ayni icerigi tasidigi icin biri secilir.
function reasoningText(delta) {
  if (typeof delta?.reasoning === "string" && delta.reasoning) return delta.reasoning;
  const details = delta?.reasoning_details;
  if (!Array.isArray(details)) return "";
  return details.map((part) => (part?.type === "reasoning.text" ? String(part.text || "") : "")).join("");
}

function emptyResponseError(truncated, budget) {
  return new Error(truncated
    ? `Ox Alpha ${budget} tokenlik bütçenin tamamını akıl yürütmeye harcadı ve yanıt üretemedi; isteği daraltın`
    : "Ox Alpha boş yanıt döndürdü");
}

// onAlive: baglantinin YASADIGINI bildirir. OpenRouter uzun akil yurutme
// bekleyislerinde ": OPENROUTER PROCESSING" gibi SSE YORUM satirlari gonderir;
// bunlar "data:" ile baslamadigi icin eskiden tamamen atlanip stall sayacini
// sifirlamiyordu ve saglikli baglanti 120 sn'de olduruluyordu.
async function readStream(response, onDelta, onAlive) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason = null;
  let id = null;
  let usage = null;
  let streamError = null;
  while (true) {
    const { done, value } = await reader.read();
    // Bayt geldiyse baglanti canli: icerik olsun olmasin sayaci sifirla.
    if (value?.length) onAlive?.();
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
      if (event?.error) {
        streamError = new Error(event.error.message || "OpenRouter akış hatası");
        streamError.status = Number(event.error.code || event.error.status) || 0;
        continue;
      }
      const choice = event?.choices?.[0];
      finishReason = choice?.finish_reason || finishReason;
      const delta = responseText(choice?.delta?.content);
      const completed = responseText(choice?.message?.content);
      const addition = delta || (!text ? completed : "");
      const thinking = reasoningText(choice?.delta);
      if (thinking) reasoning += thinking;
      if (addition) text += addition;
      if (addition || thinking) onDelta(text, reasoning);
    }
    if (done) break;
  }
  if (streamError && !text.trim()) throw streamError;
  return { id, text, reasoning, finishReason, usage:usage || {} };
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
    // Dedektore tam istem verilirse ortak sohbet gecmisindeki eski kimlik
    // tartismalari eslesir ve sira disi bir istek kimlik sorusu sanilir.
    // Karari kullanicinin bu turdaki gercek mesajindan uret; orkestrator
    // zaten hesapladiginda onun kararini kullan.
    const identityQuestion = typeof opts.identityQuestion === "boolean"
      ? opts.identityQuestion
      : isIdentityQuestion(opts.routeText ?? prompt);
    // Kimlik tartışmalarındaki eski, hatalı asistan cevaplarını yeni isteğe taşımayın.
    const prior = opts.fresh || identityQuestion ? [] : boundedHistory(this.histories.get(sessionKey) || [], opts.historyChars);
    const conversation = [...prior, { role:"user", content:userContent(prompt, opts.images || []) }];
    const messages = [{ role:"system", content:OX_ALPHA_IDENTITY }, ...conversation];
    const controller = new AbortController();
    const totalMs = Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const stallMs = Math.max(1, Number(opts.stallTimeoutMs) || DEFAULT_STALL_TIMEOUT_MS);
    const deadline = Date.now() + totalMs;
    const totalTimer = setTimeout(
      () => controller.abort(new Error(`OpenRouter zaman aşımı (${Math.round(totalMs / 60_000)} dk)`)), totalMs);
    // Model dusunurken de token akar. Akis surdugu surece cagriyi kesme;
    // yalnizca gercekten susarsa (baglanti dustu, saglayici takildi) bitir.
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      // Kalan toplam sure duraklama sinirindan kisaysa once toplam sinir
      // devreye girer. Duraklama sayacini o ana kadar kisaltmak iki sayaci
      // yaristirir ve "N saniyedir veri yok" mesajini yanlis sureyle dondurur.
      const remaining = deadline - Date.now();
      if (remaining <= stallMs) return;
      stallTimer = setTimeout(
        () => controller.abort(new Error(`OpenRouter akışı ${Math.round(stallMs / 1_000)} saniyedir veri göndermiyor`)),
        stallMs);
    };
    armStall();
    // BaseAgent.stop(runId) bu iptal tutamacını da çocuk süreç gibi sonlandırır.
    // Böylece HTTP/SSE isteği görsel veya metin bitene kadar arka planda kalmaz.
    const cancellation = { _sessionKey:sessionKey, _noForceKill:true, kill:() => controller.abort(new Error("Durduruldu")) };
    this.children.add(cancellation);
    try {
      const retryDelays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
      const ceiling = Math.max(1, Number(opts.maxTokensCeiling) || MAX_OUTPUT_TOKENS_CEILING);
      let maxTokens = Math.max(1, Number(opts.maxTokens) || (identityQuestion ? IDENTITY_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS));
      let truncated = false;
      let payload;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        const response = await this.fetchImpl(ENDPOINT, {
          method:"POST",
          headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json", "X-OpenRouter-Title":"Ajan Konseyi" },
          body:JSON.stringify({
            model:opts.model || "stealth/ox-alpha",
            messages,
            stream:true,
            stream_options:{ include_usage:true },
            max_tokens:maxTokens,
          }),
          signal:controller.signal,
        });
        if (!response.ok) {
          const errorPayload = await response.json().catch(() => ({}));
          const detail = errorPayload?.error?.message || response.statusText;
          // Ust saglayici mesgulse daha uzun ve jitter'li merdivene gec.
          const busy = isUpstreamBusy(response.status, detail);
          const ladder = busy ? RATE_LIMIT_RETRY_DELAYS_MS : retryDelays;
          const canRetry = RETRYABLE_STATUS.has(response.status) && attempt < ladder.length;
          if (!canRetry) {
            throw new Error(busy
              ? `OpenRouter ${response.status}: sağlayıcı şu an yoğun (${detail}). Birkaç dakika sonra tekrar deneyin; hesap kotanızla ilgili değildir.`
              : `OpenRouter ${response.status}: ${detail}`);
          }
          const wait = busy ? jitter(ladder[attempt]) : ladder[attempt];
          await waitWithSignal(retryAfterMs(response, wait, busy ? 60_000 : 15_000), controller.signal);
          continue;
        }

        try {
          payload = await readStream(response, (partial, thinking) => {
            armStall();
            // Ox Alpha arac kullanamaz; adim gunlugu iki evreyle sinirlidir:
            // akil yurutme ve yanit yazimi. Durust sinir.
            if (thinking && !partial) opts.steps?.open("dusunme", "dusundu", "Akıl yürütüyor");
            if (partial) { opts.steps?.close("dusunme", { title: "Akıl yürüttü" }); opts.steps?.open("yazim", "islem", "Yanıtı yazıyor"); }
            if (opts.silent) return;
            // Model dakikalarca yalnız akıl yürütebilir. Kartı boş bırakmak
            // yerine durumu bildir; ham akıl yürütme metnini kullanıcıya dökme.
            if (partial) this.progress(opts.label || "", partial, opts.memberId);
            else if (thinking) this.progress(`${opts.label || "yanıtlıyor"} · akıl yürütüyor`, "", opts.memberId);
          }, armStall);
          // Test doubles and older fetch implementations may not expose a readable stream.
          if (!payload) payload = await response.json().catch(() => ({}));
          const choice = payload?.choices?.[0];
          const candidate = responseText(payload?.text ?? choice?.message?.content);
          if (candidate.trim()) {
            payload.text = candidate;
            break;
          }
          // finish_reason="length" + boş content: yanıt hatalı değil, bütçe dar.
          // Bu geçici bir sunucu hatası olmadığı için beklemeden, daha geniş
          // bütçeyle hemen yeniden dene.
          truncated = (payload?.finishReason ?? choice?.finish_reason) === "length";
          // Yeniden deneme ilk cagri kadar surer. Pencerenin buyuk kismi
          // tukendiyse buyutup denemek kullaniciyi bosuna bekletir; net hata ver.
          const roomToRetry = deadline - Date.now() > totalMs * 0.4;
          if (truncated && maxTokens < ceiling && attempt < retryDelays.length && roomToRetry) {
            maxTokens = Math.min(ceiling, maxTokens * 4);
            this.log(`ox-alpha akıl yürütmede tükendi; token bütçesi ${maxTokens} yapıldı`);
            payload = null;
            continue;
          }
          if (attempt >= retryDelays.length) throw emptyResponseError(truncated, maxTokens);
        } catch (error) {
          if (controller.signal.aborted || attempt >= retryDelays.length) throw error;
          const status = Number(error?.status) || 0;
          if (status && !RETRYABLE_STATUS.has(status)) throw error;
        }
        payload = null;
        await waitWithSignal(retryDelays[attempt], controller.signal);
      }
      let text = responseText(payload?.text ?? payload?.choices?.[0]?.message?.content);
      if (!text.trim()) throw emptyResponseError(truncated, maxTokens);
      // Stealth modeller öz-kimlik sorularında eğitim verilerinden yanlış ürün adı
      // üretebilir. Kullanıcıya yalnız doğrulanabilen sağlayıcı kimliğini gösterin.
      // Kimlik yaniti kisadir. Uzun ve icerikli bir cevabin icinde saglayici
      // adi gecmesi kimlik iddiasi degil konu geregidir; onu silme.
      if (identityQuestion && text.length <= IDENTITY_ANSWER_MAX_CHARS
          && /\b(?:codex|chatgpt|openai|claude|gemini)\b/iu.test(text)) text = verifiedIdentityAnswer(opts.routeText ?? prompt);
      if (!opts.fresh) this.histories.set(sessionKey, [...conversation, { role:"assistant", content:text }].slice(-20));
      const usage = { input:payload.usage?.prompt_tokens || 0, cachedInput:0, output:payload.usage?.completion_tokens || 0, costUsd:payload.usage?.cost || 0 };
      (opts.onUsage || this.onUsage)?.(usage);
      if (!opts.silent) this.progress(opts.label || "", text, opts.memberId);
      return { ok:true, text, raw:{ id:payload.id, usage } };
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(stallTimer);
      this.children.delete(cancellation);
    }
  }
}
