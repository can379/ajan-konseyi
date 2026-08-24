import fs from "node:fs";
import path from "node:path";

// Hata -> cozum bellegi (epizodik onarim hafizasi).
// Testler kirmizidan yesile dondugunde "hata imzasi + cozum" cifti saklanir;
// sonraki turlarda BENZER bir hata cikarsa gecmis cozum onarim istemine
// eklenir. Vektor veritabani YOK: imzalar normalize edilip belirtec
// ortusmesiyle (Jaccard) puanlanir — bagimlliksiz ve seffaf.

const MAX_ENTRIES = 40;
const STOP = new Set(["error","hata","test","tests","failed","fail","expected","received","at","in","the","and","for","with","null","undefined","true","false"]);

// Test ciktisindan ayirt edici satirlari cikarir; mutlak yollari, satir/sutun
// numaralarini ve zaman damgalarini normalize eder ki ayni hata farkli
// kosularda ayni imzayi uretsin.
export function errorSignature(output, { maxLines = 6 } = {}) {
  const lines = String(output || "").split("\n");
  const interesting = lines.filter((line) =>
    /(error|fail|assert|exception|throw|expected|reject|cannot|not a function|undefined is|refused)/i.test(line));
  const picked = (interesting.length ? interesting : lines.filter(Boolean)).slice(0, maxLines);
  return picked
    .map((line) => line
      // Mutlak yol makineye ozgu gurultudur; dizin kismi atilir ama AYIRT EDICI
      // dosya adi korunur (ayni hata farkli dosyada = farkli onarim).
      .replace(/(?:\/[\w.@-]+)+\/([\w.-]+\.\w+)/g, "<yol>/$1")
      .replace(/:\d+(:\d+)?/g, ":<n>")
      .replace(/\b\d{2,}\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
}

export function tokenize(text) {
  return new Set(String(text || "")
    .toLocaleLowerCase("tr-TR")
    .split(/[^a-z0-9_çğıöşü<>./-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP.has(t)));
}

export function similarity(a, b) {
  const left = tokenize(a), right = tokenize(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

function file(baseDir, projectId) {
  const dir = path.join(baseDir, "memory");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${projectId}.repairs.json`);
}

export function loadRepairs(baseDir, projectId) {
  if (!projectId) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file(baseDir, projectId), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordRepair(baseDir, projectId, { output, solution, agent = "", command = "" }) {
  if (!projectId) return null;
  const signature = errorSignature(output);
  if (!signature || !solution) return null;
  const entries = loadRepairs(baseDir, projectId);
  // Ayni hata tekrar cozulduyse eskisini guncelle, kopya biriktirme.
  const existing = entries.findIndex((entry) => similarity(entry.signature, signature) >= 0.75);
  const record = {
    signature,
    solution: String(solution).replace(/\s+/g, " ").trim().slice(0, 900),
    agent, command,
    at: new Date().toISOString(),
    hits: existing >= 0 ? (entries[existing].hits || 1) + 1 : 1,
  };
  if (existing >= 0) entries[existing] = record; else entries.unshift(record);
  fs.writeFileSync(file(baseDir, projectId), JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
  return record;
}

// Benzer gecmis onarimlari bulur. Esik altindakiler dondurulmez ki alakasiz
// "cozum" onerisi ajani yanlis yone surumesin.
export function findSimilarRepairs(baseDir, projectId, output, { limit = 2, threshold = 0.28 } = {}) {
  const signature = errorSignature(output);
  if (!signature) return [];
  return loadRepairs(baseDir, projectId)
    .map((entry) => ({ ...entry, score: similarity(entry.signature, signature) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function repairHint(matches) {
  if (!matches.length) return "";
  return `\n\nBU PROJEDE DAHA ÖNCE ÇÖZÜLMÜŞ BENZER HATALAR (yalnız fikir olarak kullan, körü körüne uygulama):\n` +
    matches.map((m, i) =>
      `${i + 1}. (benzerlik %${Math.round(m.score * 100)}${m.agent ? `, çözen: ${m.agent}` : ""})\n` +
      `   Hata: ${m.signature.split("\n")[0].slice(0, 200)}\n` +
      `   Çözüm: ${m.solution.slice(0, 400)}`).join("\n");
}
