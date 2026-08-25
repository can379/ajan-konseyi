import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBackup, mirrorTree, detectGoogleDrive } from "../src/backup.js";
import { collectGeneratedAssets } from "../src/media.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
// collectGeneratedAssets yalniz Users|private|tmp yollarini tarar (uretimde
// ajanlar oralara yazar); macOS os.tmpdir() /var/folders oldugu icin varlik
// testleri desene uyan /private/tmp altinda calisir.
const ptmp = (name) => fs.mkdtempSync(path.join("/private/tmp", name));

// ---- Yedekleme motoru ----

test("yedek tum veri kumelerini aynalar ve durum dosyasi yazar", () => {
  const data = tmp("veri-"), hedef = tmp("hedef-");
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(data, "runs", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(data, "uploads", "foto.png"), "resim");
  fs.writeFileSync(path.join(data, "runs", "run-1", "messages.jsonl"), "{}\n");
  fs.writeFileSync(path.join(data, "config.json"), "{}");
  const result = runBackup(data, hedef);
  assert.equal(result.copied, 3);
  assert.equal(result.errors.length, 0);
  const kok = path.join(hedef, "AjanKonseyi-Yedek");
  assert.ok(fs.existsSync(path.join(kok, "uploads", "foto.png")));
  assert.ok(fs.existsSync(path.join(kok, "runs", "run-1", "messages.jsonl")));
  assert.ok(fs.existsSync(path.join(kok, "config.json")));
  assert.ok(fs.existsSync(path.join(kok, "yedek-durum.json")));
  fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(hedef, { recursive: true, force: true });
});

test("degismeyen dosya ikinci turda kopyalanmaz, degisen kopyalanir", () => {
  const data = tmp("veri-"), hedef = tmp("hedef-");
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(data, "uploads", "a.txt"), "bir");
  runBackup(data, hedef);
  const ikinci = runBackup(data, hedef);
  assert.equal(ikinci.copied, 0, "degismeyen dosya yeniden kopyalanmamali");
  assert.ok(ikinci.skipped >= 1);
  fs.writeFileSync(path.join(data, "uploads", "a.txt"), "iki degisti");
  const ucuncu = runBackup(data, hedef);
  assert.equal(ucuncu.copied, 1);
  fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(hedef, { recursive: true, force: true });
});

// Yedegin amaci veri KAYBINI onlemek: kaynakta silinen dosya hedefte kalir.
test("ayna hedefte asla silme yapmaz", () => {
  const data = tmp("veri-"), hedef = tmp("hedef-");
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(data, "uploads", "silinecek.png"), "x");
  runBackup(data, hedef);
  fs.unlinkSync(path.join(data, "uploads", "silinecek.png"));
  runBackup(data, hedef);
  assert.ok(fs.existsSync(path.join(hedef, "AjanKonseyi-Yedek", "uploads", "silinecek.png")),
    "kaynakta silinen dosya yedekte korunmali");
  fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(hedef, { recursive: true, force: true });
});

test("gecici dosyalar aynalanmaz ve drive tespiti guvenli", () => {
  const data = tmp("veri-"), hedef = tmp("hedef-");
  fs.writeFileSync(path.join(data, "a.tmp"), "x");
  fs.writeFileSync(path.join(data, ".DS_Store"), "x");
  const stats = { copied: 0, skipped: 0, bytes: 0, errors: [] };
  mirrorTree(data, hedef, stats);
  assert.equal(stats.copied, 0);
  assert.equal(detectGoogleDrive(tmp("bos-")), null, "drive yoksa null donmeli");
  fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(hedef, { recursive: true, force: true });
});

// ---- Uretilen dosyanin kanonik yeri ----

// Kullanicinin sikayeti: YaSel guncellemesi Ajan Konseyi'nin uploads
// deposuna dusuyordu. Proje bagliysa cikti PROJENIN icinde yasamalidir.
test("proje bagliysa uretilen dosya projenin cikti klasorune tasinir", () => {
  const root = tmp("root-"), proje = ptmp("proje-"), kaynak = ptmp("kaynak-");
  const zip = path.join(kaynak, "Uygulama-1.1.zip");
  fs.writeFileSync(zip, "PKsahte");
  const [asset] = collectGeneratedAssets(`Paket hazır: ${zip}`, root, proje);
  assert.ok(asset, "varlik toplanmali");
  assert.equal(asset.path, path.join(proje, "cikti", "Uygulama-1.1.zip"), "kanonik yer projenin icinde olmali");
  assert.ok(fs.existsSync(asset.path), "proje kopyasi diske yazilmali");
  assert.match(asset.url, /^\/uploads\//, "sunum kopyasi uploads'ta kalmali");
  for (const d of [root, proje, kaynak]) fs.rmSync(d, { recursive: true, force: true });
});

test("dosya zaten projedeyse kopyalanmaz, projesiz sohbette eski davranis korunur", () => {
  const root = tmp("root-"), proje = ptmp("proje-");
  const icDosya = path.join(proje, "rapor.pdf");
  fs.writeFileSync(icDosya, "%PDF-sahte");
  const [icAsset] = collectGeneratedAssets(`Rapor: ${icDosya}`, root, proje);
  assert.equal(icAsset.path, icDosya, "projedeki dosya yerinde kalmali");
  assert.ok(!fs.existsSync(path.join(proje, "cikti", "rapor.pdf")), "gereksiz kopya olusmamali");
  const [serbest] = collectGeneratedAssets(`Rapor: ${icDosya}`, root, null);
  assert.match(serbest.path, /uploads/, "projesiz sohbette uploads kanonik kalir");
  for (const d of [root, proje]) fs.rmSync(d, { recursive: true, force: true });
});

// ---- HTTP ucu: izole veri diziniyle uctan uca ----
test("backup uclari: yapilandir, calistir, durumdan sonucu oku", async () => {
  const { spawn } = await import("node:child_process");
  const data = tmp("veri-"), hedef = tmp("hedef-");
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(data, "uploads", "foto.png"), "resim");
  const PORT = 4896;
  const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname);
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), AJAN_KONSEYI_DATA_DIR: data }, stdio: "ignore",
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/mcp/info`)).ok; } catch { await wait(400); } }
    assert.ok(up, "sunucu ayaga kalkmadi");
    const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/backup/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: hedef }) })).json();
    assert.equal(cfg.ok, true);
    const run = await fetch(`http://127.0.0.1:${PORT}/api/backup/run`, { method: "POST" });
    assert.equal(run.status, 202, "is arka planda baslamali");
    let last = null;
    for (let i = 0; i < 20 && !last; i++) {
      await wait(300);
      const st = await (await fetch(`http://127.0.0.1:${PORT}/api/backup/status`)).json();
      if (!st.running && st.last) last = st.last;
    }
    assert.ok(last, "yedek sonucu gelmedi");
    assert.ok(last.copied >= 1, JSON.stringify(last));
    assert.ok(fs.existsSync(path.join(hedef, "AjanKonseyi-Yedek", "uploads", "foto.png")));
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(hedef, { recursive: true, force: true });
  }
});
