import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { truncate, now } from "./util.js";

const exec = promisify(execFile);

// Proje bağlamı: repo haritası (dosya ağacı + kilit dosya özetleri) ve
// koşudan koşuya taşınan kalıcı proje hafızası.
// Hafıza dosyaları kullanıcının projesine DEĞİL, sistemin kendi
// memory/ klasörüne yazılır.

// Sembol cikarma: harici bagimlilik (tree-sitter/ctags) YOK. Diller icin
// hafif desenlerle ust duzey tanimlar bulunur; amac tam ayristirma degil,
// ajanin dogru dosyaya/satira gitmesini saglayacak kompakt bir harita.
const SYMBOL_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".swift", ".rb", ".php", ".c", ".h", ".cpp", ".cs", ".kt"]);

const SYMBOL_PATTERNS = [
  // JS/TS aileleri
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  // Sinif metotlari (girintili, kontrol sozcugu olmayan)
  /^\s{2,}(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
  // Python / Go / Rust / Java / Swift / Ruby / PHP / C ailesi
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
  /^\s*class\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?(?:struct|trait|impl|enum)\s+([A-Za-z_][\w]*)/,
  /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|record)\s+([A-Za-z_][\w]*)/,
  /^\s*(?:public|private|internal|open)?\s*(?:final\s+)?(?:func|class|struct|protocol|extension)\s+([A-Za-z_][\w]*)/,
];
// Kontrol sozcukleri metot sanilmasin.
const NOT_SYMBOL = new Set(["if", "for", "while", "switch", "catch", "return", "constructor", "function", "else", "do", "try", "await", "typeof", "new", "delete"]);

function extractSymbols(content, ext) {
  const out = [];
  const seen = new Set();
  const lines = content.split("\n");
  const limit = Math.min(lines.length, 4000);
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!line || line.length > 400) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match[1];
      if (!name || NOT_SYMBOL.has(name) || seen.has(name)) break;
      seen.add(name);
      out.push(`${name}@${i + 1}`);
      break;
    }
    if (out.length >= 60) break;
  }
  return out;
}

export class ProjectContext {
  constructor(rootDir) {
    this.memDir = path.join(rootDir, "memory");
    fs.mkdirSync(this.memDir, { recursive: true });
    this.mapCache = {}; // projectDir -> { builtAt, map }
  }

  // ---- Repo haritası (sembol indeksli) ----
  // Duz dosya listesi ajana bir sembolun NEREDE oldugunu soylemez; ajan da
  // dosyalari tek tek okur ve kota asil orada tukenir. Bu yuzden dosya
  // agacinin yani sira bagimsiz (harici kutuphane olmadan) cikarilmis bir
  // sembol haritasi uretilir: sinif/fonksiyon/export adlari + satir numarasi.
  async repoMap(projectDir, { budget = 9000 } = {}) {
    if (!projectDir || !fs.existsSync(projectDir)) return "";
    const cached = this.mapCache[projectDir];
    if (cached && Date.now() - cached.builtAt < 10 * 60 * 1000) return cached.map;

    let files = [];
    try {
      const { stdout } = await exec("git", ["-C", projectDir, "ls-files"], { maxBuffer: 10 * 1024 * 1024 });
      files = stdout.trim().split("\n").filter(Boolean);
    } catch {
      files = this.walk(projectDir, projectDir, 0);
    }

    const symbolFiles = files.filter((f) => SYMBOL_EXT.has(path.extname(f).toLowerCase()));
    const index = [];
    let used = 0;
    for (const rel of symbolFiles) {
      if (used >= budget) break;
      const full = path.join(projectDir, rel);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile() || stat.size > 400_000) continue;
      let symbols;
      try { symbols = extractSymbols(fs.readFileSync(full, "utf8"), path.extname(rel).toLowerCase()); }
      catch { continue; }
      if (!symbols.length) continue;
      const line = `${rel}: ${symbols.slice(0, 14).join(", ")}${symbols.length > 14 ? ` … +${symbols.length - 14}` : ""}`;
      used += line.length + 1;
      index.push(line);
    }

    const tree = files.slice(0, 260).join("\n");
    const keyFiles = ["README.md", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Makefile"];
    let summaries = "";
    for (const kf of keyFiles) {
      const fp = path.join(projectDir, kf);
      if (fs.existsSync(fp)) {
        try { summaries += `\n--- ${kf} (özet) ---\n${truncate(fs.readFileSync(fp, "utf8"), 700)}\n`; } catch {}
      }
    }

    const map = `# Repo haritası: ${projectDir}\n` +
      `Toplam dosya: ${files.length} · sembol çıkarılan dosya: ${index.length}\n\n` +
      (index.length
        ? `## Sembol haritası (dosya: tanımlar@satır)\n` +
          `Aradığın tanım burada görünüyorsa dosyanın TAMAMINI okumadan doğrudan o satıra git.\n` +
          index.join("\n") + "\n\n"
        : "") +
      `## Dosya ağacı (ilk 260)\n${tree}\n${summaries}`;
    this.mapCache[projectDir] = { builtAt: Date.now(), map };
    return map;
  }

  walk(dir, root, depth) {
    if (depth > 4) return [];
    let out = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...this.walk(full, root, depth + 1));
        else out.push(path.relative(root, full));
        if (out.length > 600) break;
      }
    } catch {}
    return out;
  }

  // ---- Kalıcı proje hafızası ----
  memFile(projectId) {
    return path.join(this.memDir, `${projectId}.md`);
  }

  readMemory(projectId) {
    if (!projectId) return "";
    try {
      return fs.readFileSync(this.memFile(projectId), "utf8");
    } catch {
      return "";
    }
  }
  writeMemory(projectId,content){if(!projectId)throw new Error("Proje gerekli");const text=String(content||"").slice(0,50000);fs.writeFileSync(this.memFile(projectId),text||"# Proje hafızası\n");return this.readMemory(projectId);}
  forget(projectId,query){const q=String(query||"").trim().toLocaleLowerCase("tr-TR");if(!q)return this.readMemory(projectId);const blocks=this.readMemory(projectId).split(/(?=\n## )/);return this.writeMemory(projectId,blocks.filter(block=>!block.toLocaleLowerCase("tr-TR").includes(q)).join(""));}

  // Koşu bitince programatik olarak hafızaya özet eklenir (ekstra LLM maliyeti yok)
  appendMemory(projectId, run, decision) {
    if (!projectId) return;
    const file = this.memFile(projectId);
    const previous=this.readMemory(projectId);
    if(previous.includes(`Koşu: ${run.id}`))return;
    const files = (run.files || []).slice(0, 20).map((f) => `${f.change} ${f.path}`).join(", ");
    const entry = [
      `\n## ${now().slice(0, 16)} — ${truncate(run.request, 120)}`,
      `- Mod: ${run.mode} · Koşu: ${run.id}`,
      `- Karar: ${truncate(decision || "-", 400)}`,
      `- Doğrulama: ${run.verify?.verdict||"tamamlandı"}${run.evidenceGate?.passed?" · EvidenceGate geçti":""}`,
      files ? `- Değişen dosyalar: ${truncate(files, 400)}` : null,
      run.tests?.length ? `- Test: ${run.tests.map((t) => (t.ok ? "✓" : "✗") + " " + t.command).join("; ")}` : null,
    ].filter(Boolean).join("\n") + "\n";
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# Proje hafızası\nBu dosya, konseyin bu projedeki geçmiş kararlarını taşır.\n`);
    }
    fs.appendFileSync(file, entry);
    // Hafıza şişmesin: 20KB'ı aşarsa en eski kayıtları kırp
    try {
      const content = fs.readFileSync(file, "utf8");
      if (content.length > 20000) {
        const parts = content.split("\n## ");
        const head = parts[0];
        const kept = parts.slice(-12);
        fs.writeFileSync(file, head + "\n## " + kept.join("\n## "));
      }
    } catch {}
  }
}
