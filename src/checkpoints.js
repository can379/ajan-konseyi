import fs from "node:fs";
import path from "node:path";

// Kontrol noktalari: proje dosyalarinin anlik kopyasi. Hem kullanicinin elle
// olusturdugu hem de kod turlarinin basinda otomatik alinan anlik goruntuler
// ayni bicimde saklanir; boylece ayni "Geri dön" akisi ikisini de geri yukler.
export function copyCheckpoint(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => !src.split(path.sep).some((part) =>
      [".git", "node_modules", "dist", "build", ".next"].includes(part)),
  });
}

export function checkpointBase(checkpointsDir, projectId) {
  const base = path.join(checkpointsDir, projectId);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function listCheckpoints(checkpointsDir, projectId) {
  const base = checkpointBase(checkpointsDir, projectId);
  return fs.readdirSync(base)
    .map((id) => {
      try { return JSON.parse(fs.readFileSync(path.join(base, id, "meta.json"), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createCheckpoint(checkpointsDir, project, { name = "Kontrol noktası", auto = false } = {}) {
  const base = checkpointBase(checkpointsDir, project.id);
  const id = Date.now().toString(36);
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  copyCheckpoint(project.path, path.join(dir, "files"));
  const meta = { id, name: String(name).slice(0, 80), auto, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

// Otomatik anlik goruntuler birikip diski doldurmasin: en yeni `keep` tanesi
// kalir. Kullanicinin ELLE olusturdugu noktalar asla silinmez.
export function pruneAutoCheckpoints(checkpointsDir, projectId, keep = 3) {
  const base = checkpointBase(checkpointsDir, projectId);
  const autos = listCheckpoints(checkpointsDir, projectId).filter((c) => c.auto);
  for (const stale of autos.slice(keep)) {
    try { fs.rmSync(path.join(base, stale.id), { recursive: true, force: true }); } catch {}
  }
}

// Ayni proje icin cok sik otomatik kopya alinmasin (varsayilan 10 dk).
export function shouldAutoCheckpoint(checkpointsDir, projectId, minGapMs = 10 * 60 * 1000) {
  const last = listCheckpoints(checkpointsDir, projectId).find((c) => c.auto);
  if (!last) return true;
  return Date.now() - new Date(last.createdAt).getTime() >= minGapMs;
}
