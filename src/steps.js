// Ortak adim gunlugu: her uyenin CALISIRKEN yaptiklari (okudu/yazdi/
// calistirdi/aradi/dusundu) ortak bir dille toplanir, arayuze canli akar ve
// bitince mesajla birlikte kalici olur.
//
// Ilham Codex'in ChatGPT icindeki isleyisidir (canli gozlemlendi): anlati
// paragraflarinin arasina ikonlu, katlanmis eylem satirlari girer; is bitince
// hepsi tek "Xsn calisti ›" satirina iner ve yalniz kisa ozet kalir.
//
// Her saglayici kendi olay bicimini konusur: Codex "item.completed", Claude
// "tool_use", Antigravity "step_update", OpenRouter yalniz akil yurutme.
// Hepsi buradaki tek sozluge cevrilir. TANINMAYAN OLAY DUSURULMEZ: "islem"
// turune iner; bir CLI guncellenip alan adi degistirse satir kaybolmaz,
// yalniz daha az ayrintili gorunur.

import { uid } from "./util.js";

export const STEP_KINDS = Object.freeze([
  "dusundu", "okudu", "yazdi", "calistirdi", "aradi",
  "tarayici", "gorsel", "devretti", "islem",
]);

export const STEP_META = Object.freeze({
  dusundu:    { ikon: "✳", etiket: "Düşündü" },
  okudu:      { ikon: "🔍", etiket: "Okudu" },
  yazdi:      { ikon: "✏️", etiket: "Yazdı" },
  calistirdi: { ikon: "⌘", etiket: "Çalıştırdı" },
  aradi:      { ikon: "🔎", etiket: "Aradı" },
  tarayici:   { ikon: "🌐", etiket: "Tarayıcı" },
  gorsel:     { ikon: "🎨", etiket: "Görsel" },
  devretti:   { ikon: "↳", etiket: "Devretti" },
  islem:      { ikon: "•", etiket: "İşlem" },
});

const MAX_STEPS = 300;
const MAX_TITLE = 220;
const MAX_DETAIL = 6000;
const EMIT_THROTTLE_MS = 400;

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function normalizeKind(kind) {
  return STEP_KINDS.includes(kind) ? kind : "islem";
}

// Arac adindan ortak sozluge esleme. Saglayicilar ayni isi farkli adlandirir
// (Read/read_file/view, Bash/shell/command_execution...); hepsi tek kaba iner.
const TOOL_PATTERNS = [
  [/^(?:read|view|open_file|cat|glob|ls|list_dir|read_file|readfile|fetch_file|notebookread)/i, "okudu"],
  [/^(?:write|edit|multiedit|create_file|apply_patch|patch|str_replace|notebookedit|file_change|write_file|save)/i, "yazdi"],
  [/^(?:bash|shell|exec|run_command|run_terminal|terminal|command|process|command_execution)/i, "calistirdi"],
  [/^(?:grep|search|find|ripgrep|codebase_search|web_?search|websearch)/i, "aradi"],
  [/^(?:webfetch|web_?fetch|browser|playwright|puppeteer|navigate|screenshot_page)/i, "tarayici"],
  [/^(?:image|imagen|generate_image|dalle|render|figma)/i, "gorsel"],
  [/^(?:task|agent|subagent|dispatch|delegate)/i, "devretti"],
];

export function kindForTool(name) {
  const value = String(name || "");
  for (const [pattern, kind] of TOOL_PATTERNS) if (pattern.test(value)) return kind;
  return "islem";
}

// Tek cagrinin adim gunlugu. Ajan adaptorleri olay geldikce add/open/close
// cagirir; onChange kisilarak arayuze akar (her token'da degil).
export class StepLog {
  constructor({ onChange = null } = {}) {
    this.steps = [];
    this.onChange = onChange;
    this.startedAt = Date.now();
    this._openKeys = new Map(); // key -> step
    this._emitTimer = null;
  }

  list() { return this.steps; }

  _emit() {
    if (!this.onChange) return;
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      try { this.onChange(this.steps); } catch { /* arayuz akisi isi bozmaz */ }
    }, EMIT_THROTTLE_MS);
  }

  add(kind, title, detail = "", { status = "ok" } = {}) {
    if (this.steps.length >= MAX_STEPS) return null;
    const step = {
      id: uid("adim-"),
      kind: normalizeKind(kind),
      title: clean(title, MAX_TITLE) || STEP_META[normalizeKind(kind)].etiket,
      detail: String(detail ?? "").slice(0, MAX_DETAIL),
      status: ["ok", "failed", "running"].includes(status) ? status : "ok",
      at: Date.now() - this.startedAt,
    };
    this.steps.push(step);
    this._emit();
    return step;
  }

  // Suren adim (or. "dusunuyor"): ayni anahtar acikken yeniden acilmaz.
  open(key, kind, title) {
    if (this._openKeys.has(key)) return this._openKeys.get(key);
    const step = this.add(kind, title, "", { status: "running" });
    if (step) this._openKeys.set(key, step);
    return step;
  }

  close(key, { title = null, detail = null, status = "ok" } = {}) {
    const step = this._openKeys.get(key);
    if (!step) return;
    this._openKeys.delete(key);
    step.status = status;
    if (title) step.title = clean(title, MAX_TITLE);
    if (detail != null) step.detail = String(detail).slice(0, MAX_DETAIL);
    step.durationMs = Date.now() - this.startedAt - step.at;
    this._emit();
  }

  // Bitis: acik kalan adimlar kapanir, kalici ozet nesnesi doner.
  finish() {
    for (const key of [...this._openKeys.keys()]) this.close(key);
    clearTimeout(this._emitTimer); this._emitTimer = null;
    if (!this.steps.length) return null;
    return {
      steps: this.steps,
      durationMs: Date.now() - this.startedAt,
      counts: this.steps.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
    };
  }
}
