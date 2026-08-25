import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- 1) Paralel calisma alanlari (mevcut davranisin sozlesmesi) ----
test("kod modunda konsey uyeleri ayri worktree+dalda calisir ve birlestirilir", () => {
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /gitops\.createWorktree\(run\.projectDir/, "uye basina worktree acilmali");
  assert.match(orch, /codeIntegration/, "birlestirme asamasi olmali");
  assert.match(orch, /gitops\.mergeBranch/, "dallar plana gore birlesmeli");
});

// ---- 2) Ajanlar arasi dogrudan soru ----
test("uye baska uyeye soru sorabilir; jeton ekrana sizmadan islenir", async () => {
  const { parseAgentAsk, stripActionTokens } = await import("../src/orchestrator.js");
  assert.deepEqual(parseAgentAsk('<<<AJAN_SORU>>>{"to":"m-codex","question":"Bu modülün arayüzü ne?"}<<<END>>>'),
    { action: "ask", to: "m-codex", question: "Bu modülün arayüzü ne?" });
  assert.equal(parseAgentAsk("normal yanıt"), null);
  assert.equal(parseAgentAsk('<<<AJAN_SORU>>>{"to":"","question":"x"}<<<END>>>'), null, "hedefsiz soru gecersiz");
  assert.equal(stripActionTokens('önce.\n<<<AJAN_SORU>>>{"to":"a","question":"b"}<<<END>>>'), "önce.");
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /_askDepth/, "soru zinciri tek seviyede kalmali (sonsuz dongu olmasin)");
  assert.match(orch, /üyesine soruldu/, "soru adim gunlugune dusmeli");
});

// ---- 3) Zamanlanmis gorevler ----
test("config zamanlanmis gorevleri dogrular ve saklar", async () => {
  const { Config } = await import("../src/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  const cfg = new Config(dir);
  cfg.update({ schedules: [
    { name: "Sabah testi", time: "09:30", prompt: "npm test kos, kirmizilari raporla" },
    { name: "Bozuk saat", time: "9:3", prompt: "x" },
    { name: "Istemsiz", time: "10:00", prompt: "" },
  ]});
  assert.equal(cfg.data.schedules.length, 2, "istemsiz gorev atilmali");
  assert.equal(cfg.data.schedules[0].time, "09:30");
  assert.equal(cfg.data.schedules[1].time, "09:00", "bozuk saat varsayilana inmeli");
  assert.ok(cfg.data.schedules[0].id, "kimlik atanmali");
  fs.rmSync(dir, { recursive: true, force: true });
});
test("sunucu dakikalik zamanlayici calistirir", () => {
  const srv = oku("server.js");
  assert.match(srv, /function runSchedules/, "zamanlayici olmali");
  assert.match(srv, /setInterval\(runSchedules, 60 \* 1000\)/, "dakikada bir bakilmali");
  assert.match(srv, /sch\.lastRunDay === gun/, "ayni gun iki kez kosulmamali");
});

// ---- 4) Dosya izlenebilirligi ----
test("tur sonunda dosya haritasi mesaji duser, arayuz cizer", () => {
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /run\.turnFileMap/, "adimlardan harita toplanmali");
  assert.match(orch, /kind: "filemap"/, "harita mesaji dusmeli");
  const app = oku("ui/app.js");
  assert.match(app, /function fileMapHTML/, "arayuz haritayi cizmeli");
  assert.match(app, /m\.fileMap \? fileMapHTML/, "mesajda gosterilmeli");
  const store = oku("src/store.js");
  assert.match(store, /fileMap = null/, "addMessage fileMap alanini korumali");
});

// ---- 5) Mesaj duzenle & yeniden calistir ----
test("rewind: kullanici mesaji duzenlenince sonrasi silinir, oturumlar tazelenir", () => {
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /rewindChat\(run, messageId, newText/, "rewind metodu olmali");
  assert.match(orch, /run\.messages\.slice\(0, index\)/, "mesajdan itibaren kesilmeli");
  assert.match(orch, /agent\.resetSession\(run\.id\)/, "eski CLI baglami sifirlanmali");
  const srv = oku("server.js");
  assert.match(srv, /\\\/rewind\$/, "rewind ucu olmali");
  const app = oku("ui/app.js");
  assert.match(app, /editingMessageId = msg\.id/, "kullanici mesajinda duzenleme modu acilmali");
  assert.match(app, /\/rewind`/, "gonderim rewind ucuna gitmeli");
});

// ---- 6) Sesli giris ----
test("mikrofon yerel kayit yapip sunucuda cozumletir (Google ucnoktasina bagli degil)", () => {
  const app = oku("ui/app.js");
  assert.match(app, /function pcmToWav/, "ham PCM WAV'a cevrilmeli");
  assert.match(app, /fetch\("\/api\/speech"/, "cozumleme sunucuda yapilmali");
  assert.match(app, /getUserMedia/, "mikrofon akisi alinmali");
  assert.match(oku("ui/index.html"), /btn-mic/, "dugme composer'da olmali");
  const srv = oku("server.js");
  assert.match(srv, /p === "\/api\/speech"/, "sunucu ucu olmali");
  const sp = oku("src/speech.js");
  assert.match(sp, /SFSpeechRecognizer/, "macOS yerel tanima kullanilmali");
  assert.match(sp, /"open", \["-W", "-a", this\.appDir/, "TCC icin LaunchServices ile baslatilmali");
  assert.match(oku("package.json"), /extend-info\.plist/, "izin aciklamalari uygulama plistine girmeli");
  assert.match(sp, /tr-TR/, "varsayilan dil Turkce olmali");
});

test("WAV baslıgı dogru uretilir (44 bayt + 16-bit mono PCM)", () => {
  const app = oku("ui/app.js");
  const fn = new Function("Blob", `${app.match(/function pcmToWav[\s\S]*?\n\}/)[0]}; return pcmToWav;`)(
    class { constructor(parts) { this.parts = parts; } });
  const blob = fn([new Float32Array([0, 0.5, -0.5])], 48000);
  const view = new DataView(blob.parts[0]);
  const oku4 = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  assert.equal(oku4(0), "RIFF");
  assert.equal(oku4(8), "WAVE");
  assert.equal(view.getUint16(22, true), 1, "mono olmali");
  assert.equal(view.getUint32(24, true), 48000, "ornek hizi korunmali");
  assert.equal(view.getUint16(34, true), 16, "16-bit olmali");
  assert.equal(view.getUint32(40, true), 6, "3 ornek = 6 bayt veri");
  assert.equal(view.getInt16(44 + 2, true), Math.trunc(0.5 * 0x7fff), "ornek degeri dogru olcelenmeli");
});

// ---- 7) Kota/kullanim gostergesi ----
test("gunluk kullanim ucu toplanir ve kota kartinda gosterilir", () => {
  const srv = oku("server.js");
  assert.match(srv, /\/api\/usage\/today/, "gunluk kullanim ucu olmali");
  assert.match(srv, /usageDaily\?\.\[gun\]/, "runlardan gunluk toplanmali");
  const app = oku("ui/app.js");
  assert.match(app, /fetchUsageToday/, "arayuz periyodik cekmeli");
  assert.match(app, /Bugün<\/small>/, "kota kartinda Bugun hucresi olmali");
});

test("dosya haritasinin yazan sutunu diff'ten tamamlanir (dolayli yazimlar kacmaz)", () => {
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /Yazari diff kaydindan tamamla/, "diff dosyalari haritaya yazar olarak islenmali");
  assert.match(orch, /kayit\.yazan\.push\(yazarAd\)/, "yazar adi eklenmali");
});
