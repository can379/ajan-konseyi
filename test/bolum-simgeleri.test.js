// Bolum simgeleri: dordu de var, tutarli ve GERCEKTEN hareketli.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");

const BOLUMLER = ["chat", "kod", "images", "ops"];

test("her bolumun kendi simgesi ve kendi rengi var", () => {
  for (const b of BOLUMLER) {
    assert.match(html, new RegExp(`class="bl-ikon" data-bl="${b}"`), `${b} simgesi olmalı`);
    assert.match(css, new RegExp(`\\.bl-ikon\\[data-bl="${b}"\\]\\s*\\{[^}]*linear-gradient`),
      `${b} kendi rengine sahip olmalı`);
  }
});

test("simgeler SATIR ICI — <use> animasyonlari oldururdu", () => {
  // CSS, <use> ogesinin golge agacina giremez: .bl-oyna .bl-tente gibi
  // seciciler hic eslesmez ve animasyonlar yazili ama olu kalir.
  // Bu test o hatanin geri gelmesini engeller.
  const anahtarBolgesi = html.slice(html.indexOf('class="bolum-secici"'), html.indexOf("</aside>"));
  assert.ok(!/<use\s+[^>]*href="#i-bl-/.test(anahtarBolgesi),
    "bölüm simgeleri <use> ile bağlanmamalı — animasyonlar çalışmaz");
  assert.ok(anahtarBolgesi.includes("<svg viewBox=\"0 0 24 24\""), "satır içi svg olmalı");
});

test("her simgenin hareketli parcasi ve o parcaya ait animasyonu var", () => {
  const parcalar = {
    chat: ["bl-p1", "bl-p2", "bl-p3"],
    kod: ["bl-sol", "bl-sag", "bl-egik"],
    images: ["bl-gunes", "bl-dag"],
    ops: ["bl-tente", "bl-kapi"],
  };
  for (const [bolum, liste] of Object.entries(parcalar)) {
    for (const p of liste) {
      assert.match(html, new RegExp(`class="${p}"`), `${bolum}: ${p} çizimde olmalı`);
      // Secici gruplanmis olabilir: ".bl-oyna .bl-p1,.bl-oyna .bl-p2{...}"
      const kural = new RegExp(`\\.bl-oyna \\.${p}\\b[^{]*\\{[^}]*animation:`);
      assert.match(css, kural, `${bolum}: ${p} için animasyon tanımlı olmalı`);
    }
  }
});

test("hareket yalniz secili ve uzerine gelinen simgede calisir", () => {
  // Dordu birden oynarsa raf huzursuz gorunuyor.
  assert.match(app, /classList\.toggle\("bl-oyna", b\.dataset\.bolum === aktifBolum\)/,
    "yalnız seçili bölümün simgesi oynamalı");
  assert.match(css, /\.bolum-menu button:hover \.bl-/, "üzerine gelince de oynamalı");
});

test("secim aninda bir kez canlanma var ve tekrar secimde yeniden oynar", () => {
  assert.match(css, /@keyframes blSecildi/);
  assert.match(app, /classList\.remove\("degisti"\);\s*\n\s*void kutu\.offsetWidth;/,
    "sınıf sıfırlanmazsa aynı animasyon ikinci kez oynamaz");
});

test("hareketi kapatan kullaniciya hic oynatilmaz", () => {
  assert.match(css, /prefers-reduced-motion:reduce/);
});
