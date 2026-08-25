import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- Yarida kesilen tur hatirlanir ----

test("uygulama kapaninca yarida kalan sohbet turu yonlendirme notu birakir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veri-"));
  const runDir = path.join(dir, "runs", "run-kesik");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    id: "run-kesik", kind: "chat", status: "running", turnActive: true,
    request: "Uygulamaya karanlık tema ekle", createdAt: "2026-08-25T10:00:00Z", messages: [],
  }));
  const store = new Store(dir);
  const run = store.getRun("run-kesik");
  assert.equal(run.status, "idle", "sohbet bostaya donmeli");
  assert.equal(run.steeringNotes?.length, 1, "kesinti notu birakilmali");
  assert.match(run.steeringNotes[0], /YARIDA KESİLDİ/);
  assert.match(run.steeringNotes[0], /karanlık tema/, "yarim kalan istek notta olmali");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("turu aktif olmayan sohbet not birakmaz", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veri-"));
  const runDir = path.join(dir, "runs", "run-sakin");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    id: "run-sakin", kind: "chat", status: "idle", request: "x", createdAt: "2026-08-25T10:00:00Z", messages: [],
  }));
  const store = new Store(dir);
  assert.equal(store.getRun("run-sakin").steeringNotes, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Ara yonlendirme sozlesmeleri ----

test("calisan tura gelen mesaj kuyruk yerine yonlendirme notu olur", () => {
  const srv = oku("server.js");
  assert.match(srv, /run\.steeringNotes = \[\.\.\.\(run\.steeringNotes \|\| \[\]\), text\]/, "turnActive mesaji nota donmeli");
  assert.match(srv, /steered: true/, "istemciye yonlendirildigi soylenmeli");
  assert.match(srv, /Mesaj çalışan tura iletildi/, "kullaniciya gorunur onay dusmeli");
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /KULLANICIDAN ARA YÖNLENDİRME/, "not bir sonraki uye cagrisina islenmeli");
  assert.match(orch, /run\.steeringNotes\.splice\(0\)/, "notlar tuketilmeli (tekrar tekrar gitmemeli)");
  assert.match(orch, /this\.enqueueMessage\(run, \{ target: "konsey", text: not, mode \}\)/, "tur biterken artakalan not kuyruga inmeli");
});
