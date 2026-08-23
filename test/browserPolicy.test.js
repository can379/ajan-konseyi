import test from "node:test";
import assert from "node:assert/strict";
import { browserSnapshotScript, isSensitiveFieldSignature, redactBrowserSnapshot, SENSITIVE_FIELD_SNIPPET, validateBrowserUrl } from "../src/browserPolicy.js";

test("URL policy permits HTTPS and local HTTP only",()=>{assert.equal(validateBrowserUrl("https://example.com").ok,true);assert.equal(validateBrowserUrl("http://localhost:4780").ok,true);for(const url of ["http://example.com","file:///etc/passwd","javascript:alert(1)"])assert.equal(validateBrowserUrl(url).ok,false);});
test("redaction covers identity, payment and access secrets",()=>{const result=redactBrowserSnapshot({text:"me@example.com +90 555 111 2233 4111 1111 1111 1111 csrf=abcdef 123456"});assert.doesNotMatch(result.text,/me@example|555 111|4111 1111|abcdef|123456/);});
// Kalıbın harfi harfine metnini değil DAVRANIŞINI sınıyoruz: kalıp metnine bağlı
// eski sürüm, tek kaynağa taşınan kalıp genişleyince (e-?mail|e-?posta) kırılmıştı.
test("snapshot excludes sensitive identity and authentication fields",()=>{
  const script=browserSnapshotScript();
  for(const signature of ["email email E-posta","password current-password Parola","text one-time-code OTP","text cc-number Kart numarası","text cvv"])
    assert.equal(isSensitiveFieldSignature(signature),true,`hassas sayılmalıydı: ${signature}`);
  assert.ok(script.includes(SENSITIVE_FIELD_SNIPPET),"betik ortak hassas alan tanımını gömmeli");
  assert.doesNotMatch(script,/\.value/);
});
