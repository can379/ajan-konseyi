import fs from "node:fs";
import path from "node:path";
import { uid, now } from "./util.js";

// Kalıcı kullanıcı ayarları: ajan başına model/rol/etkinlik ve proje listesi.
// config.json proje kökünde tutulur; oturum bilgisi veya anahtar İÇERMEZ.
export const PROVIDERS = ["claude", "codex", "antigravity", "openrouter"];

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
  notifications: true, // seçili önemli olaylarda macOS bildirimi
  notificationEvents: { done: true, error: true, approval: true },
  apiProviders: { openrouter: { configured: false, model: "stealth/ox-alpha" } },
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
        this.data.members = ["claude", "codex", "antigravity"].map((prov) => {
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
      this.data.apiProviders = {
        openrouter: {
          configured: saved.apiProviders?.openrouter?.configured === true,
          model: "stealth/ox-alpha",
        },
      };
      this.data.projects=(this.data.projects||[]).map((p)=>({...p,instructions:String(p.instructions||""),skills:Array.isArray(p.skills)?p.skills:[],devCommand:String(p.devCommand||""),artifactExport:p.artifactExport===true}));
      delete this.data.agents; // eski alan artık kullanılmıyor
    } catch {
      // dosya yoksa varsayılanlar geçerli
    }
  }

  sanitizeMembers(list) {
    if (!Array.isArray(list) || !list.length) return structuredClone(DEFAULTS.members);
    // Üye sayısını sessizce kırpma. Aynı sağlayıcı üzerinde farklı rol/model
    // kullanan her kayıt bağımsız bir konsey ajanıdır.
    return list.map((m, i) => ({
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
    // Kenar cubugu surukle-birakla proje sirasi: bilinen kimlikler verilen
    // sirayla one alinir, listede olmayanlar mevcut sirasiyla sona kalir.
    if (Array.isArray(patch.projectOrder)) {
      const sira = patch.projectOrder.map(String);
      this.data.projects = [...this.data.projects].sort((a, b) => {
        const ia = sira.indexOf(a.id), ib = sira.indexOf(b.id);
        return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      });
    }
    if ("smartModels" in patch) this.data.smartModels = !!patch.smartModels;
    if ("notifications" in patch) this.data.notifications = !!patch.notifications;
    if (patch.notificationEvents && typeof patch.notificationEvents === "object") {
      this.data.notificationEvents = {
        done: patch.notificationEvents.done !== false,
        error: patch.notificationEvents.error !== false,
        approval: patch.notificationEvents.approval !== false,
      };
    }
    if (patch.apiProviders && typeof patch.apiProviders === "object") {
      this.data.apiProviders = { openrouter: { configured: patch.apiProviders.openrouter?.configured === true, model: "stealth/ox-alpha" } };
    }
    this.save();
    return this.data;
  }

  updateProject(id, patch) {
    const project=this.getProject(id); if(!project) throw new Error("Proje bulunamadı");
    if("instructions" in patch) project.instructions=String(patch.instructions||"").slice(0,12000);
    if(Array.isArray(patch.skills)) project.skills=patch.skills.map((v)=>String(v||"").trim()).filter(Boolean).slice(0,30);
    if("devCommand" in patch) project.devCommand=String(patch.devCommand||"").trim().slice(0,300);
    if("artifactExport" in patch) project.artifactExport=patch.artifactExport===true;
    this.save(); return project;
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
      instructions:"", skills:[], devCommand:"", artifactExport:false,
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
