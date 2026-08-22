import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./src/store.js";
import { Orchestrator } from "./src/orchestrator.js";
import { Config, ROLES } from "./src/config.js";
import { MODEL_CATALOG, EFFORT_LEVELS } from "./src/models.js";
import { detectMedia, MAX_UPLOAD_BYTES, PROVIDER_CAPABILITIES } from "./src/media.js";
import { discoverCapabilities } from "./src/capabilityDiscovery.js";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(execFile);
const HOME = os.homedir();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Kaynaklar uygulama paketinde salt okunur olabilir. Kullanıcıya ait sohbet,
// ayar, yükleme ve günlükler ayrı bir yazılabilir veri dizininde tutulur.
// Geliştirici modunda env verilmezse mevcut davranış korunur.
const DATA_ROOT = path.resolve(process.env.AJAN_KONSEYI_DATA_DIR || ROOT);
const PORT = process.env.PORT || 4780;

fs.mkdirSync(DATA_ROOT, { recursive: true });
const store = new Store(DATA_ROOT);
const config = new Config(DATA_ROOT);
const orch = new Orchestrator(store, DATA_ROOT, config);

// Kalıcı proje kabukları: cwd, export'lar ve uzun çalışan süreçler komutlar
// arasında korunur. Çıktı artımlı okunur; masaüstü kapanınca temizlenir.
const terminalSessions = new Map();
function createTerminalSession(project) {
  const id = crypto.randomUUID();
  const child = spawn("/bin/zsh", ["-l"], { cwd:project.path, stdio:["pipe","pipe","pipe"], env:{ ...process.env, TERM:"xterm-256color", FORCE_COLOR:"0" } });
  const session = { id, projectId:project.id, cwd:project.path, child, output:"", alive:true };
  const append = (d) => { session.output += d.toString(); if(session.output.length>4e6) session.output=session.output.slice(-3e6); };
  child.stdout.on("data",append); child.stderr.on("data",append);
  child.on("close",(code)=>{ session.alive=false; append(`\n[kabuk kapandı: ${code ?? "?"}]\n`); });
  terminalSessions.set(id,session);
  child.stdin.write("unsetopt zle 2>/dev/null\n");
  return session;
}
function terminalView(session, from=0) {
  const start=Math.max(0,Number(from)||0);
  return { sessionId:session.id, projectId:session.projectId, cwd:session.cwd, output:session.output.slice(start), cursor:session.output.length, alive:session.alive };
}

// 30 günden eski ve hiçbir koşuda referans edilmeyen yüklemeleri temizle.
function cleanupUploads() {
  const dir = path.join(DATA_ROOT, "uploads"); if (!fs.existsSync(dir)) return;
  const referenced = new Set();
  for (const run of Object.values(store.runs)) {
    for (const a of [...(run.attachments || []), ...(run.messages || []).flatMap((m) => m.attachments || [])]) if (a.path) referenced.add(path.resolve(a.path));
  }
  const cutoff = Date.now() - 30 * 86400_000;
  for (const name of fs.readdirSync(dir)) { const file=path.join(dir,name); try { const st=fs.statSync(file); if(st.isFile()&&st.mtimeMs<cutoff&&!referenced.has(path.resolve(file))) fs.unlinkSync(file); } catch {} }
}
cleanupUploads();

function isWithin(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

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
    req.on("data", (c) => { data += c; if (data.length > 140e6) req.destroy(); });
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
        ...store.snapshot(url.searchParams.get("run")),
        config: config.data,
        roles: ROLES,
        models: MODEL_CATALOG,
        efforts: EFFORT_LEVELS,
        home: HOME,
        capabilities: PROVIDER_CAPABILITIES,
      });
    }
    if (req.method === "GET" && p === "/api/capabilities") {
      return json(res,200,await discoverCapabilities(url.searchParams.get("refresh")==="1"));
    }

    // ---- Kalıcı proje terminali ----
    if (req.method === "POST" && p === "/api/terminal/sessions") {
      const body = await readBody(req);
      const project = config.getProject(body.projectId || config.data.activeProject);
      if (!project || !fs.existsSync(project.path)) return json(res,400,{error:"Önce geçerli bir proje seçin"});
      const existing=[...terminalSessions.values()].find((s)=>s.projectId===project.id&&s.alive);
      return json(res,200,terminalView(existing||createTerminalSession(project)));
    }
    const terminalMatch=p.match(/^\/api\/terminal\/sessions\/([\w-]+)(?:\/(write|interrupt|close))?$/);
    if (terminalMatch) {
      const session=terminalSessions.get(terminalMatch[1]);
      if (!session) return json(res,404,{error:"Terminal oturumu bulunamadı"});
      const action=terminalMatch[2];
      if(req.method==="GET"&&!action) return json(res,200,terminalView(session,url.searchParams.get("from")));
      if(req.method==="POST"&&action==="write") {
        const body=await readBody(req); const input=String(body.input||"");
        if(input.length>8000) return json(res,400,{error:"Komut çok uzun"});
        if(!session.alive) return json(res,409,{error:"Terminal kapalı"});
        session.child.stdin.write(input.endsWith("\n")?input:input+"\n");
        return json(res,200,terminalView(session,body.from));
      }
      if(req.method==="POST"&&action==="interrupt") { if(session.alive) session.child.kill("SIGINT"); return json(res,200,{ok:true}); }
      if(req.method==="POST"&&action==="close") { if(session.alive) session.child.kill("SIGTERM"); terminalSessions.delete(session.id); return json(res,200,{ok:true}); }
    }

    // Geriye dönük tek-komut uç noktası.
    if (req.method === "POST" && p === "/api/terminal") {
      const body = await readBody(req);
      const command = String(body.command || "").trim();
      if (!command) return json(res, 400, { error: "Komut boş olamaz" });
      if (command.length > 8000) return json(res, 400, { error: "Komut çok uzun" });
      const project = config.getProject(body.projectId || config.data.activeProject);
      if (!project || !fs.existsSync(project.path)) {
        return json(res, 400, { error: "Önce geçerli bir proje seçin" });
      }
      try {
        const result = await execP("/bin/zsh", ["-lc", command], {
          cwd: project.path,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "0" },
        });
        return json(res, 200, { cwd: project.path, stdout: result.stdout, stderr: result.stderr, code: 0 });
      } catch (e) {
        return json(res, 200, {
          cwd: project.path,
          stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message || e),
          code: Number.isInteger(e.code) ? e.code : 1,
        });
      }
    }


    const runDetail = p.match(/^\/api\/runs\/([\w-]+)$/);
    if (req.method === "GET" && runDetail) {
      const run = store.getRun(runDetail[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      return json(res, 200, run);
    }

    const feedbackMatch = p.match(/^\/api\/runs\/([\w-]+)\/messages\/([\w-]+)\/feedback$/);
    if (req.method === "POST" && feedbackMatch) {
      const run = store.getRun(feedbackMatch[1]); const body = await readBody(req);
      const msg = run?.messages.find((m) => m.id === feedbackMatch[2]);
      if (!msg) return json(res, 404, { error: "Mesaj bulunamadı" });
      msg.feedback = ["up","down"].includes(body.value) ? body.value : null; store.updateRun(run);
      return json(res, 200, { ok: true });
    }
    const branchMatch = p.match(/^\/api\/runs\/([\w-]+)\/branch$/);
    if (req.method === "POST" && branchMatch) {
      const source = store.getRun(branchMatch[1]); const body = await readBody(req);
      if (!source) return json(res, 404, { error: "Sohbet bulunamadı" });
      const at = source.messages.findIndex((m) => m.id === body.messageId);
      const run = store.createRun({ kind:"chat", request:source.request, mode:source.mode, agents:source.agents, projectId:source.projectId, projectDir:source.projectDir, attachments:[], maxDebateRounds:source.maxDebateRounds });
      run.status="idle"; run.phase="idle"; run.title=(source.title || source.request).slice(0,65)+" · dal";
      run.messages = source.messages.slice(0, at >= 0 ? at + 1 : source.messages.length).map((m) => ({...m})); store.updateRun(run);
      return json(res, 200, { runId:run.id });
    }

    // ---- Çoklu ortam yükleme ----
    if (req.method === "POST" && p === "/api/upload") {
      const body = await readBody(req);
      const name = String(body.name || "dosya").replace(/[^\p{L}\p{N}_.\- ]/gu, "_").slice(0, 120);
      const m = String(body.data || "").match(/^data:([^;,]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "Geçerli bir dosya verisi gerekli" });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return json(res, 400, { error: "Dosya boş veya 100 MB sınırını aşıyor" });
      const media = detectMedia(buf, name, m[1]);
      const upDir = path.join(DATA_ROOT, "uploads");
      fs.mkdirSync(upDir, { recursive: true });
      const fname = Date.now().toString(36) + "-" + name;
      const fpath = path.join(upDir, fname);
      fs.writeFileSync(fpath, buf);
      return json(res, 200, { path: fpath, url: "/uploads/" + encodeURIComponent(fname), name, ...media });
    }

    // ---- Yüklenen görselleri servis et ----
    if (req.method === "GET" && p.startsWith("/uploads/")) {
      let uploadName = "";
      try { uploadName = decodeURIComponent(p.slice("/uploads/".length)); } catch {}
      const uploadDir = path.join(DATA_ROOT, "uploads");
      const file = path.join(uploadDir, uploadName);
      if (!uploadName || path.basename(uploadName) !== uploadName || !isWithin(uploadDir, file)) {
        res.writeHead(404); return res.end();
      }
      try {
        const data = fs.readFileSync(file);
        const mime = detectMedia(data, file).mime;
        const headers = { "Content-Type": mime, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(uploadName)}`, "Cache-Control": "max-age=86400", "X-Content-Type-Options":"nosniff" };
        if (mime === "image/svg+xml" || mime === "text/html") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";
        res.writeHead(200, headers);
        return res.end(data);
      } catch {
        res.writeHead(404); return res.end();
      }
    }

    if (req.method === "POST" && p === "/api/media/reveal") {
      const body = await readBody(req);
      const name = path.basename(String(body.url || body.name || ""));
      const file = path.join(DATA_ROOT, "uploads", name);
      if (!isWithin(path.join(DATA_ROOT, "uploads"), file) || !fs.existsSync(file)) return json(res, 404, { error:"Dosya bulunamadı" });
      await execP("open", ["-R", file]);
      return json(res, 200, { ok:true });
    }

    // ---- Klasör gezgini (yalnızca ev dizini altı, yalnızca dizinler) ----
    if (req.method === "GET" && p === "/api/fs") {
      let dir = path.resolve(url.searchParams.get("path") || path.join(HOME, "Desktop"));
      if (!isWithin(HOME, dir)) dir = HOME;
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
      if (!name || name === "." || name === "..") return json(res, 400, { error: "Geçerli bir proje adı gerekli" });
      let parent = path.resolve(String(body.parent || path.join(HOME, "Desktop")));
      if (!isWithin(HOME, parent)) return json(res, 400, { error: "Proje yalnızca ev dizini altında oluşturulabilir" });
      const target = path.resolve(parent, name);
      if (!isWithin(parent, target) || target === parent) return json(res, 400, { error: "Geçersiz proje yolu" });
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
      const requestedMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
      const run = store.createRun({
        request: body.request.trim(),
        mode: requestedMode,
        agents,
        projectId: project?.id || null,
        projectDir: project?.path || null,
        testCommand: body.testCommand?.trim() || null,
        maxDebateRounds: Math.max(1, Math.min(Number(body.maxDebateRounds) || 2, 4)),
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
      if (run?.turnActive || run?.directActive) {
        const chatMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
        const queued = orch.enqueueMessage(run, {
          target: "konsey", text, mode: chatMode,
          attachments: sanitizeAttachments(body.attachments),
        });
        return json(res, 202, { runId: run.id, queued: true, queueId: queued.id });
      }

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
          maxDebateRounds: Math.max(1, Math.min(Number(body.maxDebateRounds) || 2, 4)),
          attachments: [],
        });
        run.status = "idle";
        run.title = text.slice(0, 80);
      }
      if (body.testCommand?.trim()) run.testCommand = body.testCommand.trim();
      run.testFirst = !!body.testFirst;
      const chatMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
      orch.continueChat(run, text, sanitizeAttachments(body.attachments), chatMode)
        .catch(() => {});
      return json(res, 200, { runId: run.id });
    }

    // ---- Boş ekrandan tek üyeyle doğrudan sohbet başlatma ----
    if (req.method === "POST" && p === "/api/direct-chat") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "Mesaj boş olamaz" });
      const member = config.data.members.find((m) => m.id === body.to && m.enabled);
      if (!member) return json(res, 400, { error: "Etkin hedef üye bulunamadı" });
      const project = body.projectId ? config.getProject(body.projectId) : null;
      const run = store.createRun({
        kind: "chat",
        request: text,
        mode: "auto",
        agents: [member.id],
        projectId: project?.id || null,
        projectDir: project?.path || null,
        testCommand: null,
        maxDebateRounds: 1,
        attachments: [],
      });
      run.status = "idle";
      run.phase = "idle";
      run.title = `@${member.name}: ${text.slice(0, 60)}`;
      store.updateRun(run);
      orch.directMessage(run, member.id, text, sanitizeAttachments(body.attachments)).catch((err) => {
        store.addMessage(run, { from: "sistem", kind: "error", content: "Doğrudan sohbet hatası: " + String(err.message || err) });
      });
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
      const attachments = sanitizeAttachments(body.attachments);
      if (run.turnActive || run.directActive) {
        const queued = orch.enqueueMessage(run, { target: body.to, text: body.content.trim(), attachments });
        return json(res, 202, { ok: true, queued: true, queueId: queued.id });
      }
      orch.directMessage(run, body.to, body.content.trim(), attachments).catch(() => {});
      return json(res, 200, { ok: true, queued: false });
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

    if (req.method === "POST" && p === "/api/bridge/open") {
      const bridgeDir = path.join(ROOT, "bridge", "antigravity");
      await execP("open", ["-a", "Antigravity", bridgeDir]);
      await execP("open", ["-a", "Antigravity", path.join(bridgeDir, "INSTRUCTIONS.md")]);
      return json(res, 200, { ok: true, path: bridgeDir });
    }

    if (req.method === "POST" && p === "/api/bridge/test") {
      try {
        return json(res, 200, await orch.testAntigravityBridge());
      } catch (e) {
        return json(res, 504, { error: String(e.message || e) });
      }
    }

    json(res, 404, { error: "Bulunamadı" });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

// Yalnızca bizim uploads/ klasörümüzdeki dosyalar ek olarak kabul edilir
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const upDir = path.join(DATA_ROOT, "uploads") + path.sep;
  return list
    .filter((a) => a && typeof a.path === "string" && isWithin(upDir, path.resolve(a.path)) && fs.existsSync(a.path))
    .map((a) => ({ path: path.resolve(a.path), url: String(a.url || ""), name: String(a.name || ""), mime: String(a.mime || "application/octet-stream"), kind: String(a.kind || "file"), size: Number(a.size || 0), sha256: String(a.sha256 || "") }))
    .slice(0, 16);
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
