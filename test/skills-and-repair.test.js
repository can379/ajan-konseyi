import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkills, writeSkillFiles, skillCatalog, slugify } from "../src/skills.js";
import { errorSignature, similarity, recordRepair, findSimilarRepairs, loadRepairs, repairHint } from "../src/repairMemory.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ajan-sk-"));

// --- 3) Yeteneklerde aşamalı açılım ---
test("yetenekler başlık + gövde olarak ayrıştırılır, kimlikler çakışmaz", () => {
  const parsed = parseSkills([
    "Kısa kural",
    "Dağıtım akışı\nÖnce testleri çalıştır.\nSonra staging'e gönder.",
    "Kısa kural",      // aynı başlık: kimlik çakışmamalı
    "   ",             // boş: atlanmalı
  ]);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].title, "Kısa kural");
  assert.equal(parsed[0].body, "");
  assert.equal(parsed[1].title, "Dağıtım akışı");
  assert.match(parsed[1].body, /staging/);
  assert.notEqual(parsed[0].id, parsed[2].id, "aynı başlıklı yetenekler ayrı kimlik almalı");
  assert.equal(slugify("Ölçüm & Şablon"), "olcum-sablon");
});

test("gövdeler diske yazılır; isteme yalnız katalog girer (bağlam maliyeti sabit)", () => {
  const dir = tmp();
  const uzunGovde = "AYRINTI ".repeat(400); // ~3200 karakter
  const entries = writeSkillFiles(dir, "p-1", [`Büyük yetenek\n${uzunGovde}`, "Küçük kural"]);
  const catalog = skillCatalog(entries);

  // Gövde dosyada
  const file = entries[0].path;
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, "utf8"), /AYRINTI/);
  // Katalogda gövdenin TAMAMI yok — asıl kazanç bu
  assert.ok(catalog.length < 700, "katalog gövdeyi taşıyor: " + catalog.length);
  assert.ok(!catalog.includes(uzunGovde.trim()), "katalog tam gövdeyi içeriyor");
  assert.match(catalog, /Büyük yetenek/);
  assert.match(catalog, /ayrıntı: /);
  assert.match(catalog, /uymuyorsa açma/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("silinen yetenek diskten de kalkar, katalog ile disk eşit kalır", () => {
  const dir = tmp();
  writeSkillFiles(dir, "p-1", ["Bir", "Iki"]);
  const after = writeSkillFiles(dir, "p-1", ["Bir"]);
  const files = fs.readdirSync(path.join(dir, "skills", "p-1")).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  assert.equal(after.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("yetenek katalogu orkestratörde toptan enjeksiyonun yerini aldı", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(orch, /skillCatalogFor\(run\)/);
  assert.doesNotMatch(orch, /yeniden kullanılabilir çalışma yetenekleri:\\n- \$\{/);
  // UI çok satırlı yeteneği --- ile ayırabiliyor
  assert.match(app, /function skillsFromText\(text\)/);
  assert.match(app, /\\n-\{3,\}\\s\*\\n/);
});

// --- 4) Hata -> çözüm belleği ---
test("hata imzası yol/satır/sayı farklarına rağmen aynı kalır", () => {
  const a = errorSignature("FAIL x\n AssertionError: expected 3 to equal 4\n at /Users/a/p/test/x.js:12:9");
  const b = errorSignature("FAIL x\n AssertionError: expected 7 to equal 9\n at /home/b/q/test/x.js:88:3");
  assert.equal(similarity(a, b), 1, "aynı hata farklı yol/satırda eşleşmedi");
  assert.equal(similarity(a, errorSignature("ECONNREFUSED 5432 database down")), 0);
  assert.match(a, /<yol>|AssertionError/);
});

test("onarım kaydedilir, benzeri bulunur, alakasız olan bulunmaz", () => {
  const dir = tmp();
  const failure = "FAIL test/api.test.js\n  TypeError: fetchUser is not a function\n    at /Users/x/src/api.js:41:7";
  const saved = recordRepair(dir, "p-9", { output: failure, solution: "api.js içinde fetchUser export edilmemişti; named export eklendi.", agent: "Codex", command: "npm test" });
  assert.ok(saved);
  assert.equal(loadRepairs(dir, "p-9").length, 1);

  const benzer = findSimilarRepairs(dir, "p-9", "FAIL test/api.test.js\n  TypeError: fetchUser is not a function\n    at /other/src/api.js:9:1");
  assert.equal(benzer.length, 1);
  assert.ok(benzer[0].score >= 0.9);
  assert.match(repairHint(benzer), /named export/);

  const alakasiz = findSimilarRepairs(dir, "p-9", "ECONNREFUSED redis 6379 baglanti reddedildi");
  assert.equal(alakasiz.length, 0, "alakasız hata için çözüm önerilmemeli");
  assert.equal(repairHint([]), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("aynı hata tekrar çözülürse kopya birikmez, isabet sayacı artar", () => {
  const dir = tmp();
  // Aynı dosyadaki aynı hata, farklı makine yolu ve satır numarasıyla.
  recordRepair(dir, "p-9", { output: "AssertionError: expected true to be false at /Users/selim/proj/src/api.js:3:1", solution: "ilk çözüm" });
  recordRepair(dir, "p-9", { output: "AssertionError: expected true to be false at /home/ci/build/src/api.js:41:9", solution: "güncel çözüm" });
  const list = loadRepairs(dir, "p-9");
  assert.equal(list.length, 1, "aynı imza için kopya kayıt oluştu");
  assert.equal(list[0].solution, "güncel çözüm");
  assert.equal(list[0].hits, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("aynı hata FARKLI dosyada ise ayrı onarım sayılır (yanlış çözüm önerilmez)", () => {
  const dir = tmp();
  recordRepair(dir, "p-9", { output: "AssertionError: expected true to be false at /Users/x/src/api.js:3:1", solution: "api düzeltmesi" });
  recordRepair(dir, "p-9", { output: "AssertionError: expected true to be false at /Users/x/src/db.js:3:1", solution: "db düzeltmesi" });
  assert.equal(loadRepairs(dir, "p-9").length, 2, "farklı dosyadaki hata aynı kayda birleştirildi");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("onarım hafızası kırmızı-yeşil döngüsüne bağlı", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  // Düzeltme isteminden ÖNCE geçmiş çözümler aranır
  assert.match(orch, /findSimilarRepairs\(this\.rootDir, run\.projectId, firstFailure\)/);
  assert.match(orch, /repairHint\(priorRepairs\)/);
  // Testler yeşile dönünce kaydedilir
  assert.match(orch, /if \(testResult\.ok\) \{[\s\S]{0,400}recordRepair\(this\.rootDir, run\.projectId/);
});
