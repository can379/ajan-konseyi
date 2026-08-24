import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectContext } from "../src/projectContext.js";
import { createCheckpoint, listCheckpoints, pruneAutoCheckpoints, shouldAutoCheckpoint } from "../src/checkpoints.js";

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-ctx-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "core.js"), [
    "export class Engine {",
    "  start() { return 1; }",
    "  async stop() { return 2; }",
    "}",
    "export function boot(options) { return options; }",
    "export const helper = (x) => x + 1;",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "src", "util.py"), "class Loader:\n    def load(self):\n        return 1\n\ndef parse(text):\n    return text\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Deneme projesi\nKısa açıklama.\n");
  return dir;
}

// --- 1) Sembol/repo haritası ---
test("repo haritası sembolleri satır numarasıyla çıkarır (harici bağımlılık yok)", async () => {
  const dir = tempProject();
  const map = await new ProjectContext(fs.mkdtempSync(path.join(os.tmpdir(), "ajan-mem-"))).repoMap(dir);

  assert.match(map, /## Sembol haritası/);
  // JS: sınıf, metot, fonksiyon ve ok fonksiyonu yakalanmalı
  assert.match(map, /src\/core\.js:/);
  assert.match(map, /Engine@1/);
  assert.match(map, /boot@5/);
  assert.match(map, /helper@6/);
  // Python: sınıf ve fonksiyon
  assert.match(map, /Loader@1/);
  assert.match(map, /parse@5/);
  // Ajanı doğru satıra yönlendiren talimat
  assert.match(map, /TAMAMINI okumadan doğrudan o satıra git/);
  // Kilit dosya özeti korunur
  assert.match(map, /README\.md \(özet\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sembol haritası bütçeyi aşmaz ve kontrol sözcüklerini sembol saymaz", async () => {
  const dir = tempProject();
  fs.writeFileSync(path.join(dir, "src", "noise.js"),
    "function real(){\n  if (x) { return 1; }\n  for (;;) { break; }\n  while (y) { }\n}\n");
  const map = await new ProjectContext(fs.mkdtempSync(path.join(os.tmpdir(), "ajan-mem-"))).repoMap(dir, { budget: 400 });
  assert.ok(map.length < 12000, "harita bütçesi kontrolsüz büyüdü");
  assert.match(map, /real@1/);
  assert.doesNotMatch(map, /\bif@|\bfor@|\bwhile@/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 4) Otomatik kontrol noktası ---
test("otomatik kontrol noktası alınır, kısıtlanır ve yalnız otomatikler budanır", () => {
  const projectDir = tempProject();
  const cpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-cp-"));
  const project = { id: "p-test", path: projectDir };

  assert.equal(shouldAutoCheckpoint(cpDir, project.id), true, "ilk otomatik kopya alınabilmeli");
  const first = createCheckpoint(cpDir, project, { name: "Tur öncesi", auto: true });
  assert.equal(first.auto, true);
  // Dosyalar gerçekten kopyalanmış olmalı
  assert.ok(fs.existsSync(path.join(cpDir, project.id, first.id, "files", "src", "core.js")));
  // Kısa aralıkta ikinci otomatik kopya alınmamalı
  assert.equal(shouldAutoCheckpoint(cpDir, project.id), false, "otomatik kopya kısıtlanmadı");

  // Elle oluşturulan nokta + fazladan otomatikler
  const manual = createCheckpoint(cpDir, project, { name: "Elle", auto: false });
  for (let i = 0; i < 4; i++) createCheckpoint(cpDir, project, { name: "oto" + i, auto: true });
  pruneAutoCheckpoints(cpDir, project.id, 3);

  const remaining = listCheckpoints(cpDir, project.id);
  assert.equal(remaining.filter((c) => c.auto).length, 3, "otomatik kopyalar 3'e budanmadı");
  assert.ok(remaining.some((c) => c.id === manual.id), "elle oluşturulan kontrol noktası silinmemeli");

  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(cpDir, { recursive: true, force: true });
});

// --- 2 ve 3) Yapısal güvenceler ---
test("kod tabanı brifingi doğrudan mesaj ve hızlı yanıt yollarına da verilir", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(orch, /async codebaseBrief\(run/);
  assert.match(orch, /dosya:satır kanıtı ekle/);
  // Doğrudan mesajda ilk temasta brifing verilir (rapor hatasının kök nedeni buydu)
  assert.match(orch, /const firstContact = !this\.providers\[member\.provider\]\.sessions\.get/);
  assert.match(orch, /const brief = firstContact \? await this\.codebaseBrief\(run\) : ""/);
});

test("mesajlar gerçek sağlayıcı imzası taşır ve arayüzde rozetlenir", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  assert.match(orch, /memberSignature\(member\)/);
  // Koordinatörün hangi sağlayıcıda çalıştığı da mesajda imzalanır.
  assert.match(orch, /from: "koordinator", provider: this\.config\?\.data\?\.coordinator\?\.provider/);
  assert.match(store, /model,\s+\/\/ gerçekten çalıştırılan model/);
  assert.match(app, /function providerBadge\(msg\)/);
  // Rozet ASIL mesaj sablonunda olmali: kind ve zaman damgasiyla ayni baslikta.
  assert.match(app, /providerBadge\(m\)\}\s*\n\s*<span class="m-kind">/);
  assert.match(css, /\.provider-badge/);
});

test("L2 ikili inceleme akışı üretici + bağımsız denetçi olarak kurulur", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const coord = fs.readFileSync(new URL("../src/coordinator.js", import.meta.url), "utf8");
  assert.match(coord, /"pair" \(L2\)/);
  assert.match(coord, /quick\|pair\|council/);
  assert.match(orch, /async pairReply\(run, producer, reviewer/);
  // Denetçi engelleyici sorun bulursa üretici bir kez düzeltir
  assert.match(orch, /const needsFix = verdict\.verdict === "duzeltme"/);
  assert.match(orch, /route\.approach === "pair"/);
});
