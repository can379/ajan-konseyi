// Hassas alan sınıflandırması — TEK KAYNAK.
// desktop/main.cjs CommonJS, src/browserPolicy.js ESM olduğu için kalıp daha önce
// üç ayrı yerde kopyalanmıştı (main.cjs snapshot betiği, main.cjs eylem betiği,
// browserPolicy.js). Kopyalar ayrıştığı için `cc-number` gibi standart ödeme
// autocomplete değerleri hiçbirinde yakalanmıyordu. Bu dosya .cjs olduğundan hem
// `require` hem `import` ile okunabilir; kalıp artık yalnız burada tanımlıdır.
//
// Tasarım kuralı: yalın `code` KULLANILMAZ — `postal-code`, "kupon kodu" ve kod
// arama alanlarını yanlışlıkla engelliyordu. Kod içeren adlar yalnız bağlamıyla
// (one-time-code, security-code, verification-code ...) hassas sayılır.
const SENSITIVE_FIELD_PATTERN =
  "\\b(?:e-?mail|e-?posta|mail|user(?:name)?|kullanici(?:adi)?|login|pass(?:word|code)|sifre|parola|" +
  "otp|one-?time(?:-?code)?|verification-?code|security-?code|auth-?code|sms-?code|token|" +
  "cc-[a-z]+|csc|cvv|cvc|card(?:-?number|-?no)?|kart(?:-?no)?|credit-?card|payment|odeme|iban|ssn)\\b";

const SENSITIVE_FIELD_RE = new RegExp(SENSITIVE_FIELD_PATTERN, "i");

// Bir alanın imzası: type, autocomplete, name, id, aria-label ve placeholder'ın
// boşlukla birleştirilmiş hali. Saf fonksiyon olduğu için GUI'siz test edilebilir.
function isSensitiveFieldSignature(signature) {
  return SENSITIVE_FIELD_RE.test(String(signature || ""));
}

// Gömülü betiklere enjekte edilen ortak tanım; üç betik de bunu kullanır.
const SENSITIVE_FIELD_SNIPPET =
  "const __sig=(node)=>[node.type,node.autocomplete,node.name,node.id," +
  "node.getAttribute('aria-label'),node.getAttribute('placeholder')].filter(Boolean).join(' ');" +
  "const sensitive=(node)=>new RegExp(" + JSON.stringify(SENSITIVE_FIELD_PATTERN) + ",'i').test(__sig(node));";

module.exports = { SENSITIVE_FIELD_PATTERN, SENSITIVE_FIELD_SNIPPET, isSensitiveFieldSignature };
