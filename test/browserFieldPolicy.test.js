import test from "node:test";
import assert from "node:assert/strict";
import { isSensitiveFieldSignature, browserSnapshotScript, SENSITIVE_FIELD_SNIPPET } from "../src/browserPolicy.js";

// Alan imzası = [type, autocomplete, name, id, aria-label, placeholder].join(" ")
// Bu saf bir dize fonksiyonu olduğu için GUI/Electron olmadan koşulabilir.

test("kimlik ve doğrulama alanlarına ajan yazması reddedilir", () => {
  for (const imza of [
    "password current-password sifre Parola",
    "text one-time-code otp Doğrulama kodu",
    "email email E-posta",
    "text username Kullanıcı adı",
    "text  user  ",
    "text new-password Yeni parola",
    "text sms-code SMS kodu",
  ]) assert.equal(isSensitiveFieldSignature(imza), true, `reddedilmeliydi: ${imza}`);
});

test("ödeme alanları standart cc-* autocomplete değerleriyle de reddedilir", () => {
  // Regresyon: eski kalıp yalnız card|payment|cvv|cvc içeriyordu; adında 'card'
  // geçmeyen bir kart alanı (autocomplete="cc-number") filtreden KAÇIYORDU.
  for (const imza of [
    "text cc-number Kart numarası",
    "text cc-exp Son kullanma",
    "text cc-csc Güvenlik kodu",
    "text cc-name Kart üzerindeki isim",
    "text cardnumber",
    "text cvv",
  ]) assert.equal(isSensitiveFieldSignature(imza), true, `reddedilmeliydi: ${imza}`);
});

test("zararsız alanlar yanlışlıkla engellenmez", () => {
  // Regresyon: yalın `code` kalıbı posta kodu ve kupon kodunu hassas sayıyordu.
  for (const imza of [
    "search q Sitede ara: kod örnekleri",
    "text postal-code Posta kodu",
    "text Kupon kodu",
    "text organization Kurum adı",
    "text Kullanıcı yorumu metni",
    "text discard Vazgeç",
    "text address-line1 Adres",
  ]) assert.equal(isSensitiveFieldSignature(imza), false, `engellenmemeliydi: ${imza}`);
});

test("hassas alan tanımı tek kaynaktan gelir ve üretilen betiğe gömülür", () => {
  // Kopyalanmış kalıp ayrışması bu turun asıl kusuruydu: üç ayrı yerde
  // tanımlıydı ve hiçbiri cc-* değerlerini yakalamıyordu.
  assert.ok(SENSITIVE_FIELD_SNIPPET.includes("cc-[a-z]+"));
  assert.ok(browserSnapshotScript().includes(SENSITIVE_FIELD_SNIPPET));
  assert.doesNotMatch(browserSnapshotScript(), /one-time\|token\|code\|card/);
});
