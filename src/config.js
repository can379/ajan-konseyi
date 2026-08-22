import fs from "node:fs";
import path from "node:path";
import { uid, now } from "./util.js";

// Kalıcı kullanıcı ayarları: ajan başına model/rol/etkinlik ve proje listesi.
// config.json proje kökünde tutulur; oturum bilgisi veya anahtar İÇERMEZ.
const DEFAULTS = {
  agents: {
    // parallel: aynı anda kaç kopya (worker) çalışabilir (1-4)
    // effort: çaba seviyesi ("" = varsayılan, sinirli/orta/yuksek/cokyuksek/ultra)
    claude:      { enabled: true, model: "", role: "auto", parallel: 1, effort: "" },
    codex:       { enabled: true, model: "", role: "auto", parallel: 1, effort: "" },
    antigravity: { enabled: true, model: "", role: "auto", parallel: 1, effort: "" },
  },
  projects: [],      // {id, name, path, createdAt}
  activeProject: null,
  smartModels: true,   // koordinatör alt görev zorluğuna göre model kademesi seçer
  notifications: true, // onay/bitiş anında macOS bildirimi
};

export const ROLES = {
  auto: "Otomatik (koordinatör karar verir)",
  mimar: "Mimar — tasarım ve kapsam analizi",
  uygulayici: "Uygulayıcı — kod yazma ve test",
  denetci: "Denetçi — inceleme, güvenlik, performans",
  arastirmaci: "Araştırmacı — alternatifler ve ikinci görüş",
};

export class Config {
  constructor(rootDir) {
    this.file = path.join(rootDir, "config.json");
    this.data = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = {
        ...structuredClone(DEFAULTS),
        ...saved,
        agents: {
          claude: { ...DEFAULTS.agents.claude, ...saved.agents?.claude },
          codex: { ...DEFAULTS.agents.codex, ...saved.agents?.codex },
          antigravity: { ...DEFAULTS.agents.antigravity, ...saved.agents?.antigravity },
        },
      };
    } catch {
      // dosya yoksa varsayılanlar geçerli
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  update(patch) {
    if (patch.agents) {
      for (const [name, a] of Object.entries(patch.agents)) {
        if (this.data.agents[name]) {
          Object.assign(this.data.agents[name], {
            enabled: !!a.enabled,
            model: String(a.model || "").slice(0, 80),
            role: ROLES[a.role] ? a.role : "auto",
            parallel: Math.min(4, Math.max(1, Number(a.parallel) || 1)),
            effort: ["", "sinirli", "orta", "yuksek", "cokyuksek", "ultra"].includes(a.effort) ? a.effort : "",
          });
        }
      }
    }
    if ("activeProject" in patch) this.data.activeProject = patch.activeProject;
    if ("smartModels" in patch) this.data.smartModels = !!patch.smartModels;
    if ("notifications" in patch) this.data.notifications = !!patch.notifications;
    this.save();
    return this.data;
  }

  addProject({ name, path: projPath }) {
    projPath = path.resolve(String(projPath || "").trim());
    if (!fs.existsSync(projPath) || !fs.statSync(projPath).isDirectory()) {
      throw new Error("Dizin bulunamadı: " + projPath);
    }
    const existing = this.data.projects.find((p) => p.path === projPath);
    if (existing) return existing;
    const proj = {
      id: uid("p-"),
      name: (name || path.basename(projPath)).slice(0, 60),
      path: projPath,
      createdAt: now(),
    };
    this.data.projects.push(proj);
    this.data.activeProject = proj.id;
    this.save();
    return proj;
  }

  removeProject(id) {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.activeProject === id) this.data.activeProject = null;
    this.save();
  }

  getProject(id) {
    return this.data.projects.find((p) => p.id === id) || null;
  }
}
