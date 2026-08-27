// Kesinti dayanikliligi — canli vaka run-33935cd3:
// 03:15:17 Codex gorevini bitirdi, 03:15:18 sunucu COKTU (52 MB git diff
// maxBuffer asti, istisna yakalanmadi). Yeniden baslayinca sohbet kosusu
// "idle"a dustu; t2/t3 "active" asili kaldi, paketleme (t4) hic kosmadi.
// Kullanici "yapamadi" gordu ve kimse haber vermedi.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const oku = (yol) => fs.readFileSync(new URL(`../${yol}`, import.meta.url), "utf8");

test("dev diff sureci oldurmez — tasarsa --stat ozetine duser", async () => {
  const { createImmutableSnapshot } = await import("../src/gitops.js");
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-devdiff-"));
  execFileSync("git", ["-C", dizin, "init", "-q"]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  fs.writeFileSync(path.join(dizin, "a.txt"), "ilk");
  execFileSync("git", ["-C", dizin, "add", "-A"], { env });
  execFileSync("git", ["-C", dizin, "commit", "-qm", "ilk"], { env });
  // Normal boyutta calisir; asil koruma kod duzeyinde de sabitlenir:
  fs.writeFileSync(path.join(dizin, "b.txt"), "yeni icerik\n".repeat(100));
  const sonuc = await createImmutableSnapshot(dizin, "test");
  assert.ok(sonuc.diff.includes("b.txt"));
  const kaynak = oku("src/gitops.js");
  const blok = kaynak.slice(kaynak.indexOf("createImmutableSnapshot"));
  assert.match(blok, /catch \(hata\)/, "diff hatası yakalanmalı — süreci öldürüyordu");
  assert.match(blok, /"--stat"/, "taşınca --stat özetine düşülmeli");
});

test("gorev ortasinda kesilen sohbet kosusu kendiliginden surer", async () => {
  const { Store } = await import("../src/store.js");
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-kesinti-"));
  const s1 = new Store(kok);
  const run = s1.createRun({ kind: "chat", request: "uygulamayı baştan aşağı düzelt",
    mode: "code", agents: ["m-claude"], projectId: null, projectDir: null, attachments: [] });
  run.status = "running";
  run.turnActive = true;
  run.tasks = [
    { id: "t1", status: "done" },
    { id: "t2", status: "active" },
    { id: "t3", status: "pending" },
  ];
  s1.updateRun(run);

  // Uygulama yeniden basladi:
  const s2 = new Store(kok);
  const geri = s2.runs[run.id];
  assert.equal(geri.status, "interrupted", "görevli koşu idle'a düşmemeli");
  assert.equal(geri.autoResume, true, "yeniden başlatma döngüsü bu koşuyu almalı");
});

test("gorevsiz sohbet eskisi gibi idle olur, yonlendirme notu birakir", async () => {
  const { Store } = await import("../src/store.js");
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-kesinti2-"));
  const s1 = new Store(kok);
  const run = s1.createRun({ kind: "chat", request: "kısa bir soru",
    mode: "auto", agents: ["m-claude"], projectId: null, projectDir: null, attachments: [] });
  run.status = "running"; run.turnActive = true; run.tasks = [];
  s1.updateRun(run);
  const geri = new Store(kok).runs[run.id];
  assert.equal(geri.status, "idle");
  assert.ok((geri.steeringNotes || []).some((n) => /YARIDA KESİLDİ/.test(n)));
});

test("sunucuda emniyet agi var — yakalanmamis hata gunluge yazilir, surec olmez", () => {
  const kaynak = oku("server.js");
  assert.match(kaynak, /process\.on\("uncaughtException"/);
  assert.match(kaynak, /process\.on\("unhandledRejection"/);
  assert.match(kaynak, /run\.status==="interrupted"&&run\.autoResume\)/,
    "devam döngüsü autoResume ile kapılanmalı, tür kısıtı kalkmalı");
});
