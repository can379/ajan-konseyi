import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./src/store.js";
import { Orchestrator } from "./src/orchestrator.js";
import { Config, ROLES } from "./src/config.js";
import { MODEL_CATALOG, EFFORT_LEVELS } from "./src/models.js";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(execFile);
const HOME = os.homedir();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4780;

const store = new Store(ROOT);
const config = new Config(ROOT);
const orch = new Orchestrator(store, ROOT, config);

// ---- SSE aboneleri ----
const sseClients = new Set();
store.on("event", (ev) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(data);
});

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 30e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---- Statik UI ----
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveFile(res, path.join(ROOT, "ui", "index.html"));
    }
    if (req.method === "GET" && (p === "/app.js" || p === "/style.css")) {
      return serveFile(res, path.join(ROOT, "ui", p));
    }

    // ---- SSE olay akışı ----
    if (req.method === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ---- Durum ----
    if (req.method === "GET" && p === "/api/state") {
      return json(res, 200, {
        ...store.snapshot(),
        config: config.data,
        roles: ROLES,
        models: MODEL_CATALOG,
        efforts: EFFORT_LEVELS,
        home: HOME,
      });
    }

    // ---- Görsel yükleme: kompozerden eklenen dosyalar uploads/ altına yazılır ----
    if (req.method === "POST" && p === "/api/upload") {
      const body = await readBody(req);
      const name = String(body.name || "gorsel.png").replace(/[^\w.\-]/g, "_").slice(0, 80);
      const m = String(body.data || "").match(/^data:(image\/\w+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "Yalnızca görsel dosyaları (data URL) kabul edilir" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 20e6) return json(res, 400, { error: "Görsel 20MB'dan büyük olamaz" });
      const upDir = path.join(ROOT, "uploads");
      fs.mkdirSync(upDir, { recursive: true });
      const fname = Date.now().toString(36) + "-" + name;
      const fpath = path.join(upDir, fname);
      fs.writeFileSync(fpath, buf);
      return json(res, 200, { path: fpath, url: "/uploads/" + fname, name });
    }

    // ---- Yüklenen görselleri servis et ----
    const upMatch = p.match(/^\/uploads\/([\w.\-]+)$/);
    if (req.method === "GET" && upMatch) {
      const file = path.join(ROOT, "uploads", upMatch[1]);
      try {
        const data = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "max-age=86400" });
        return res.end(data);
      } catch {
        res.writeHead(404); return res.end();
      }
    }

    // ---- Klasör gezgini (yalnızca ev dizini altı, yalnızca dizinler) ----
    if (req.method === "GET" && p === "/api/fs") {
      let dir = path.resolve(url.searchParams.get("path") || path.join(HOME, "Desktop"));
      if (!dir.startsWith(HOME)) dir = HOME;
      let dirs = [];
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => {
            const full = path.join(dir, e.name);
            return { name: e.name, path: full, git: fs.existsSync(path.join(full, ".git")) };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "tr"));
      } catch (e) {
        return json(res, 400, { error: "Dizin okunamadı: " + String(e.message || e) });
      }
      const parent = dir === HOME ? null : path.dirname(dir);
      return json(res, 200, { path: dir, parent, dirs });
    }

    // ---- Yeni proje oluştur (dizin + git init) ----
    if (req.method === "POST" && p === "/api/projects/create") {
      const body = await readBody(req);
      const name = String(body.name || "").trim().replace(/[/\\:]/g, "-");
      if (!name) return json(res, 400, { error: "Proje adı gerekli" });
      let parent = path.resolve(String(body.parent || path.join(HOME, "Desktop")));
      if (!parent.startsWith(HOME)) return json(res, 400, { error: "Proje yalnızca ev dizini altında oluşturulabilir" });
      const target = path.join(parent, name);
      if (fs.existsSync(target)) return json(res, 400, { error: "Bu isimde bir klasör zaten var: " + target });
      try {
        fs.mkdirSync(target, { recursive: true });
        await execP("git", ["init"], { cwd: target });
        const proj = config.addProject({ name, path: target });
        store.emit("event", { type: "config" });
        return json(res, 200, proj);
      } catch (e) {
        return json(res, 500, { error: "Proje oluşturulamadı: " + String(e.message || e) });
      }
    }

    // ---- Ayarlar (ajan modeli/rolü, aktif proje) ----
    if (req.method === "POST" && p === "/api/config") {
      const body = await readBody(req);
      config.update(body);
      store.emit("event", { type: "config" });
      return json(res, 200, config.data);
    }

    // ---- Projeler ----
    if (req.method === "POST" && p === "/api/projects") {
      const body = await readBody(req);
      try {
        const proj = config.addProject(body);
        store.emit("event", { type: "config" });
        return json(res, 200, proj);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    const projDel = p.match(/^\/api\/projects\/([\w-]+)$/);
    if (req.method === "DELETE" && projDel) {
      config.removeProject(projDel[1]);
      store.emit("event", { type: "config" });
      return json(res, 200, { ok: true });
    }

    // ---- Yeni koşu ----
    if (req.method === "POST" && p === "/api/runs") {
      const body = await readBody(req);
      if (!body.request?.trim()) return json(res, 400, { error: "Görev metni boş olamaz" });
      // Etkin ajanlar ayarlardan gelir; istek gövdesi isterse daraltabilir
      const enabled = config.data.members.filter((m) => m.enabled).map((m) => m.id);
      const agents = enabled;
      if (!agents.length) return json(res, 400, { error: "Etkin üye yok — kenar çubuğundan üye ekleyin" });
      const project = body.projectId ? config.getProject(body.projectId) : null;
      const run = store.createRun({
        request: body.request.trim(),
        mode: body.mode || "auto",
        agents,
        projectId: project?.id || null,
        projectDir: project?.path || body.projectDir?.trim() || null,
        testCommand: body.testCommand?.trim() || null,
        maxDebateRounds: Math.min(Number(body.maxDebateRounds) || 2, 4),
        attachments: sanitizeAttachments(body.attachments),
      });
      run.testFirst = !!body.testFirst;
      orch.startRun(run);
      return json(res, 200, { runId: run.id });
    }

    // ---- Sohbet: yeni sohbet veya mevcut sohbete mesaj ----
    if (req.method === "POST" && p === "/api/chat") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "Mesaj boş olamaz" });
      const enabled = config.data.members.filter((m) => m.enabled).map((m) => m.id);
      if (!enabled.length) return json(res, 400, { error: "Etkin üye yok — kenar çubuğundan üye ekleyin" });

      let run = body.conversationId ? store.getRun(body.conversationId) : null;
      if (run && run.kind !== "chat") run = null;
      if (run?.turnActive) return json(res, 409, { error: "Bu sohbette bir tur zaten çalışıyor; önce durdurun" });

      if (!run) {
        const project = body.projectId ? config.getProject(body.projectId) : null;
        run = store.createRun({
          kind: "chat",
          request: text,
          mode: "auto",
          agents: enabled,
          projectId: project?.id || null,
          projectDir: project?.path || null,
          testCommand: body.testCommand?.trim() || null,
          maxDebateRounds: Math.min(Number(body.maxDebateRounds) || 2, 4),
          attachments: [],
        });
        run.status = "idle";
        run.title = text.slice(0, 80);
      }
      if (body.testCommand?.trim()) run.testCommand = body.testCommand.trim();
      run.testFirst = !!body.testFirst;
      orch.continueChat(run, text, sanitizeAttachments(body.attachments), body.mode || "auto")
        .catch(() => {});
      return json(res, 200, { runId: run.id });
    }

    // ---- Koşu/tur durdurma ----
    const stopMatch = p.match(/^\/api\/runs\/([\w-]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      const run = store.getRun(stopMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      if (run.kind === "chat") orch.stopTurn(run);
      else orch.stopRun(run);
      return json(res, 200, { ok: true });
    }

    // ---- Kesinti sonrası devam ----
    const resumeMatch = p.match(/^\/api\/runs\/([\w-]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      const run = store.getRun(resumeMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      try {
        orch.resumeRun(run);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    // ---- Geri alma: koşunun dallarını ve worktree'lerini sil ----
    const rbMatch = p.match(/^\/api\/runs\/([\w-]+)\/rollback$/);
    if (req.method === "POST" && rbMatch) {
      const run = store.getRun(rbMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      try {
        const deleted = await orch.rollback(run);
        return json(res, 200, { ok: true, deleted });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    // ---- Sağlık kontrolü (yeniden tetikleme) ----
    if (req.method === "POST" && p === "/api/health") {
      const health = await orch.checkHealth();
      return json(res, 200, health);
    }

    // ---- Doğrudan ajan mesajı ----
    const msgMatch = p.match(/^\/api\/runs\/([\w-]+)\/message$/);
    if (req.method === "POST" && msgMatch) {
      const run = store.getRun(msgMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      const body = await readBody(req);
      if (!body.to || !body.content?.trim()) return json(res, 400, { error: "to ve content gerekli" });
      orch.directMessage(run, body.to, body.content.trim(), sanitizeAttachments(body.attachments)).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // ---- Görev yeniden atama (görev henüz başlamadıysa) ----
    const reMatch = p.match(/^\/api\/runs\/([\w-]+)\/tasks\/([\w-]+)\/reassign$/);
    if (req.method === "POST" && reMatch) {
      const run = store.getRun(reMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      const task = run.tasks.find((t) => t.id === reMatch[2]);
      if (!task) return json(res, 404, { error: "Görev bulunamadı" });
      if (task.status !== "pending") return json(res, 409, { error: "Görev zaten başladı; yeniden atanamaz" });
      const body = await readBody(req);
      if (!config.data.members.some((m) => m.id === body.assignee)) return json(res, 400, { error: "Geçersiz üye" });
      task.assignee = body.assignee;
      store.updateRun(run);
      store.addMessage(run, { from: "kullanici", kind: "info", taskId: task.id, content: `Görev kullanıcı tarafından ${body.assignee} üyesine atandı.` });
      return json(res, 200, { ok: true });
    }

    // ---- Onay kararı ----
    const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (req.method === "POST" && apMatch) {
      const body = await readBody(req);
      const decision = body.decision === "approve" ? "approved" : "rejected";
      const ap = store.resolveApproval(apMatch[1], decision);
      if (!ap) return json(res, 404, { error: "Onay bulunamadı veya zaten sonuçlandı" });
      return json(res, 200, { ok: true });
    }

    // ---- Rapor ----
    const repMatch = p.match(/^\/api\/runs\/([\w-]+)\/report$/);
    if (req.method === "GET" && repMatch) {
      const run = store.getRun(repMatch[1]);
      if (!run?.report) return json(res, 404, { error: "Rapor henüz yok" });
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      return res.end(run.report);
    }

    // ---- Antigravity köprü talimatı ----
    if (req.method === "GET" && p === "/api/bridge/instructions") {
      return serveFile(res, path.join(ROOT, "bridge", "antigravity", "INSTRUCTIONS.md"));
    }

    json(res, 404, { error: "Bulunamadı" });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

// Yalnızca bizim uploads/ klasörümüzdeki dosyalar ek olarak kabul edilir
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const upDir = path.join(ROOT, "uploads") + path.sep;
  return list
    .filter((a) => a && typeof a.path === "string" && path.resolve(a.path).startsWith(upDir) && fs.existsSync(a.path))
    .map((a) => ({ path: path.resolve(a.path), url: String(a.url || ""), name: String(a.name || "") }))
    .slice(0, 8);
}

function serveFile(res, file) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": (MIME[path.extname(file)] || "text/plain") + "; charset=utf-8" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("bulunamadı");
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Ajan Konseyi hazır → http://localhost:${PORT}`);
  console.log(`Antigravity köprü talimatı: bridge/antigravity/INSTRUCTIONS.md`);
  // Açılışta ve her 10 dakikada bir CLI sağlık kontrolü
  orch.checkHealth().catch(() => {});
  setInterval(() => orch.checkHealth().catch(() => {}), 10 * 60 * 1000);
});
