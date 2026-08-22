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
export class ProjectContext {
  constructor(rootDir) {
    this.memDir = path.join(rootDir, "memory");
    fs.mkdirSync(this.memDir, { recursive: true });
    this.mapCache = {}; // projectDir -> { builtAt, map }
  }

  // ---- Repo haritası ----
  async repoMap(projectDir) {
    if (!projectDir || !fs.existsSync(projectDir)) return "";
    const cached = this.mapCache[projectDir];
    if (cached && Date.now() - cached.builtAt < 10 * 60 * 1000) return cached.map;

    let files = [];
    try {
      const { stdout } = await exec("git", ["-C", projectDir, "ls-files"], { maxBuffer: 10 * 1024 * 1024 });
      files = stdout.trim().split("\n").filter(Boolean);
    } catch {
      files = this.walk(projectDir, projectDir, 0).slice(0, 500);
    }
    if (files.length > 500) {
      files = files.slice(0, 500);
    }

    // Dizin ağacını sıkıştırılmış biçimde yaz
    const tree = files.slice(0, 400).join("\n");

    // Kilit dosyaların kısa özetleri
    const keyFiles = ["README.md", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Makefile"];
    let summaries = "";
    for (const kf of keyFiles) {
      const fp = path.join(projectDir, kf);
      if (fs.existsSync(fp)) {
        try {
          summaries += `\n--- ${kf} (özet) ---\n${truncate(fs.readFileSync(fp, "utf8"), 800)}\n`;
        } catch {}
      }
    }

    const map = `# Repo haritası: ${projectDir}\nToplam dosya (ilk 400): ${files.length}\n\n${tree}\n${summaries}`;
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

  // Koşu bitince programatik olarak hafızaya özet eklenir (ekstra LLM maliyeti yok)
  appendMemory(projectId, run, decision) {
    if (!projectId) return;
    const files = (run.files || []).slice(0, 20).map((f) => `${f.change} ${f.path}`).join(", ");
    const entry = [
      `\n## ${now().slice(0, 16)} — ${truncate(run.request, 120)}`,
      `- Mod: ${run.mode} · Koşu: ${run.id}`,
      `- Karar: ${truncate(decision || "-", 400)}`,
      files ? `- Değişen dosyalar: ${truncate(files, 400)}` : null,
      run.tests?.length ? `- Test: ${run.tests.map((t) => (t.ok ? "✓" : "✗") + " " + t.command).join("; ")}` : null,
    ].filter(Boolean).join("\n") + "\n";
    const file = this.memFile(projectId);
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
