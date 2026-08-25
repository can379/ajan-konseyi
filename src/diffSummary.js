// Codex tarzi diff karti icin veri: "N dosya degistirildi +X −Y".
//
// ChatGPT icindeki Codex her turda degisen dosyalari satir sayilariyla
// kart olarak gosterir (canli gozlemlendi: "1 dosya değiştirildi +17 −5",
// bitiste "2 dosya düzenlendi +331 −0" + dosya satirlari + Geri Al/İncele).
//
// Turun KENDI degisikligini olcmek icin tur basinda numstat anlik goruntusu
// alinir; tur sonunda fark hesaplanir. Boylece onceki turlardan kalan
// commit'lenmemis degisiklikler karta karismaz.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

// git diff --numstat ciktisini {dosya: {add, del}} haritasina cevirir.
export function parseNumstat(output) {
  const map = {};
  for (const line of String(output || "").split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    map[m[3]] = { add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) };
  }
  return map;
}

// Tur basi/sonu anlik goruntulerinden BU TURUN katkisini cikarir.
// Negatif farklar sifira kirpilir (onceki degisiklik geri alinmis olabilir).
export function diffDelta(before = {}, after = {}) {
  const files = [];
  for (const [path, sonra] of Object.entries(after)) {
    const once = before[path] || { add: 0, del: 0 };
    const add = Math.max(0, sonra.add - once.add);
    const del = Math.max(0, sonra.del - once.del);
    if (add || del) files.push({ path, add, del });
  }
  const total = files.reduce((acc, f) => ({ add: acc.add + f.add, del: acc.del + f.del }), { add: 0, del: 0 });
  return files.length ? { files: files.slice(0, 12), totalAdd: total.add, totalDel: total.del, fileCount: files.length } : null;
}

export async function numstatSnapshot(projectDir) {
  if (!projectDir) return {};
  try {
    const { stdout } = await run("git", ["-C", projectDir, "diff", "--numstat"], { maxBuffer: 4 * 1024 * 1024 });
    const map = parseNumstat(stdout);
    // Izlenmeyen yeni dosyalar da sayilsin: satir sayisi eklenen sayilir.
    const { stdout: st } = await run("git", ["-C", projectDir, "status", "--porcelain"], { maxBuffer: 1024 * 1024 });
    for (const line of st.split("\n")) {
      const m = line.match(/^\?\?\s+(.+)$/);
      // Klasorler dosya degildir: '?? cikti/' gibi girdiler karta girmesin.
      if (m && !m[1].endsWith("/") && !map[m[1]]) {
        try {
          const { stdout: wc } = await run("wc", ["-l", `${projectDir}/${m[1]}`]);
          map[m[1]] = { add: Number(wc.trim().split(/\s+/)[0]) || 0, del: 0 };
        } catch { map[m[1]] = { add: 0, del: 0 }; }
      }
    }
    return map;
  } catch { return {}; }
}
