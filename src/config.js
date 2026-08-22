import fs from "node:fs";
import path from "node:path";
import { uid, now } from "./util.js";

// Kalıcı kullanıcı ayarları: ajan başına model/rol/etkinlik ve proje listesi.
// config.json proje kökünde tutulur; oturum bilgisi veya anahtar İÇERMEZ.
export const PROVIDERS = ["claude", "codex", "antigravity"];

const LEGACY_ANTIGRAVITY_MODELS = {
  "Gemini 3.7 Flash (Medium)": "gemini-3.7-flash-medium",
  "Gemini 3.1 Pro (Low)": "gemini-3.1-pro-low",
  "Gemini 3.5 Flash (Medium)": "gemini-3.5-flash-medium",
};

const DEFAULTS = {
  // Konsey üyeleri: her üye bir sağlayıcı (CLI) üzerinde ayrı bir kişiliktir.
  // İstenildiği kadar üye eklenebilir: örn. 3 Codex mimar + 1 Claude denetçi.
  members: [
    { id: "m-claude", name: "Claude", provider: "claude", role: "auto", model: "", effort: "", enabled: true },
    { id: "m-codex", name: "Codex", provider: "codex", role: "auto", model: "", effort: "", enabled: true },
    { id: "m-antigravity", name: "Antigravity", provider: "antigravity", role: "arastirmaci", model: "", effort: "", enabled: true },
  ],
  // Koordinatörün hangi yapay zekâ olacağına kullanıcı karar verir
  coordinator: { provider: "claude", model: "", effort: "" },
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
      this.data = { ...structuredClone(DEFAULTS), ...saved };
      // Eski sürümden geçiş: agents nesnesi vardı, members listesi yoktu
      if (!Array.isArray(saved.members) && saved.agents) {
        this.data.members = PROVIDERS.map((prov) => {
          const old = saved.agents[prov] || {};
          return {
            id: "m-" + prov,
            name: prov === "claude" ? "Claude" : prov === "codex" ? "Codex" : "Antigravity",
            provider: prov,
            role: old.role || "auto",
            model: old.model || "",
            effort: old.effort || "",
            enabled: old.enabled !== false,
          };
        });
      }
      this.data.members = this.sanitizeMembers(this.data.members);
      this.data.coordinator = this.sanitizeCoordinator(this.data.coordinator);
      delete this.data.agents; // eski alan artık kullanılmıyor
    } catch {
      // dosya yoksa varsayılanlar geçerli
    }
  }

  sanitizeMembers(list) {
    if (!Array.isArray(list) || !list.length) return structuredClone(DEFAULTS.members);
    return list.slice(0, 12).map((m, i) => ({
      id: String(m.id || uid("m-")).slice(0, 24),
      name: String(m.name || "Üye " + (i + 1)).slice(0, 40),
      provider: PROVIDERS.includes(m.provider) ? m.provider : "claude",
      role: ROLES[m.role] ? m.role : "auto",
      model: String(m.provider === "antigravity"
        ? (LEGACY_ANTIGRAVITY_MODELS[m.model] || m.model || "")
        : (m.model || "")).slice(0, 80),
      effort: ["", "sinirli", "orta", "yuksek", "cokyuksek", "ultra"].includes(m.effort) ? m.effort : "",
      enabled: m.enabled !== false,
    }));
  }

  sanitizeCoordinator(c) {
    return {
      provider: PROVIDERS.includes(c?.provider) ? c.provider : "claude",
      model: String(c?.model || "").slice(0, 80),
      effort: ["", "sinirli", "orta", "yuksek", "cokyuksek", "ultra"].includes(c?.effort) ? c.effort : "",
    };
  }

  save() {
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
    fs.renameSync(temp, this.file);
  }

  update(patch) {
    if (Array.isArray(patch.members)) {
      this.data.members = this.sanitizeMembers(patch.members);
    }
    if (patch.coordinator) {
      this.data.coordinator = this.sanitizeCoordinator(patch.coordinator);
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
