import fs from "node:fs";
import path from "node:path";

// Yetenekler icin ASAMALI ACILIM (progressive disclosure).
// Onceki davranis: butun yetenek metinleri her ilk temas isteminde toptan
// enjekte ediliyordu -> yetenek sayisi arttikca baglam maliyeti dogrusal
// buyuyordu. Yeni davranis: isteme yalniz KATALOG girer (baslik + kisa
// aciklama + dosya yolu); ajan ilgili yetenegin GOVDESINI ancak ihtiyac
// duydugunda dosyadan okur. Ajanlarimiz dosya okuyabilen CLI'lar oldugu icin
// bu, harici bir arac katmani gerektirmez.

const MAX_SKILLS = 60;

export function slugify(text, fallback = "yetenek") {
  const base = String(text || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i")
    .replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || fallback;
}

// Her yetenek bloğu: ilk satır baslik/aciklama, kalani govde.
export function parseSkills(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const lines = text.split("\n");
    const title = lines[0].trim().replace(/^[-*]\s*/, "");
    if (!title) continue;
    const body = lines.slice(1).join("\n").trim();
    let id = slugify(title);
    let n = 2;
    while (seen.has(id)) id = `${slugify(title)}-${n++}`;
    seen.add(id);
    out.push({ id, title, body, raw: text });
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

export function skillsDir(baseDir, projectId) {
  return path.join(baseDir, "skills", String(projectId || "genel"));
}

// Yetenekleri diske yazar ve katalog girdilerini dondurur. Silinen yetenekler
// icin eski dosyalar temizlenir; boylece katalog ile disk her zaman esittir.
export function writeSkillFiles(baseDir, projectId, skills) {
  const entries = parseSkills(skills);
  const dir = skillsDir(baseDir, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();
  for (const skill of entries) {
    const file = path.join(dir, `${skill.id}.md`);
    const content = `# ${skill.title}\n\n${skill.body || "_Bu yetenek için ek ayrıntı verilmedi._"}\n`;
    let previous = null;
    try { previous = fs.readFileSync(file, "utf8"); } catch {}
    if (previous !== content) fs.writeFileSync(file, content);
    keep.add(`${skill.id}.md`);
    skill.path = file;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".md") && !keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {}
  return entries;
}

// Isteme giren kompakt katalog. Govde YOK; yalniz baslik, kisa aciklama ve yol.
export function skillCatalog(entries, { descriptionChars = 140 } = {}) {
  if (!entries.length) return "";
  const lines = entries.map((skill) => {
    const description = skill.body
      ? " — " + skill.body.replace(/\s+/g, " ").slice(0, descriptionChars) + (skill.body.length > descriptionChars ? "…" : "")
      : "";
    return `- ${skill.title}${description}${skill.path ? `\n  ayrıntı: ${skill.path}` : ""}`;
  });
  return `\n\nBu projede yeniden kullanılabilir çalışma yetenekleri (KATALOG).\n` +
    `Başlık ve kısa açıklamalar aşağıda; bir yetenek göreve uyuyorsa AYRINTI dosyasını oku, uymuyorsa açma:\n` +
    lines.join("\n");
}
