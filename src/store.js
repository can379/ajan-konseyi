import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { uid, now, truncate, conversationTitle } from "./util.js";

// Ortak hafıza: çalışma kayıtları, mesajlar, görevler, kararlar, onaylar.
// Her koşu (run) diske runs/<id>/ altında JSONL + JSON olarak yazılır.
export class Store extends EventEmitter {
  constructor(rootDir) {
    super();
    this.rootDir = rootDir;
    this.runsDir = path.join(rootDir, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.runs = {};          // runId -> run
    this.approvals = {};     // approvalId -> approval
    this.agentStatus = {};   // agentName -> { status, detail, since }
    this.loadRuns();
  }

  // Önceki oturumların koşularını diskten geri yükle
  loadRuns() {
    for (const dir of fs.readdirSync(this.runsDir)) {
      const file = path.join(this.runsDir, dir, "state.json");
      try {
        const run = JSON.parse(fs.readFileSync(file, "utf8"));
        let recovered = false;
        if (run.status === "running") {
          if (run.kind === "chat") {
            // Sohbetler kesintiden etkilenmez; yarım kalan tur düşer, sohbet sürer
            run.status = "idle";
            run.phase = "idle";
          } else {
            // Sunucu yeniden başladı; koşu kesildi ama kaldığı yerden devam ettirilebilir
            run.status = "interrupted";
            run.phase = "interrupted";
          }
          run.stopRequested = false;
          run.turnActive = false;
          run.directActive = false;
          recovered = true;
        }
        // Masaüstü/sunucu kapanınca canlı alt işlem artık yoktur. Eski bazı
        // sohbetler status=idle iken directActive=true kaydedilebildiği için
        // arayüz sonsuza kadar "üretiyor" kartı gösteriyordu.
        if (run.kind === "chat") {
          recovered ||= Boolean(run.stopRequested || run.turnActive || run.directActive);
          run.stopRequested = false;
          run.turnActive = false;
          run.directActive = false;
        }
        // Eski kayıtlarda olmayan alanları tamamla
        run.reviews ??= []; run.diffs ??= []; run.usage ??= {}; run.usageDaily ??= {}; run.verify ??= null; run.evidenceGate ??= null;
        run.pinned ??= false; run.archived ??= false; run.tags ??= []; run.deletedAt ??= null; run.diffComments ??= []; run.autoResume ??= run.kind!=="chat";
        run.budget ??= {enabled:false,maxCalls:24,maxTokens:250000,stopped:false};
        // Eski sürümlerde varsayılan 250 bin token sınırı abonelik kotası gibi
        // sunuluyordu. Açıkça etkinleştirilmemiş eski sınırları devre dışı bırak.
        if(run.budget.enabled!==true){run.budget.enabled=false;run.budget.stopped=false;run.budget.reason=null;}
        if (run.kind === "chat" && (!run.title || run.title.startsWith("@") || run.title === String(run.request || "").slice(0, 80))) {
          const firstUser = (run.messages || []).find((message) => message.from === "kullanici")?.content || run.request;
          run.title = conversationTitle(firstUser);
          const temp = file + ".tmp";
          fs.writeFileSync(temp, JSON.stringify(run, null, 2));
          fs.renameSync(temp, file);
          recovered = false;
        }
        if (recovered) {
          const temp = file + ".tmp";
          fs.writeFileSync(temp, JSON.stringify(run, null, 2));
          fs.renameSync(temp, file);
        }
        this.runs[run.id] = run;
      } catch {
        // state.json yoksa veya bozuksa atla
      }
    }
  }

  // ---- Ajan durumu ----
  setAgentStatus(name, status, detail = "") {
    this.agentStatus[name] = { status, detail, since: now() };
    this.emit("event", { type: "agent_status", agent: name, status, detail });
  }

  // ---- Canlı akış: ajanın o anki kısmi çıktısı (kalıcı değil, yalnız SSE) ----
  streamProgress(agent, label, text) {
    this.emit("event", { type: "stream", agent, label, text: String(text).slice(-2000) });
  }

  clearStream(agent) {
    this.emit("event", { type:"stream_end", agent });
  }

  // ---- Sağlık durumu ----
  setHealth(health) {
    this.health = health;
    this.emit("event", { type: "health" });
  }

  // ---- Koşular ----
  createRun({ request, mode, agents, projectId, projectDir, testCommand, maxDebateRounds, attachments, kind }) {
    const id = uid("run-");
    const run = {
      id,
      kind: kind || "task",   // "chat": kalıcı sohbet, "task": tek seferlik koşu
      request,
      mode: mode || "auto",
      agents,
      projectId: projectId || null,
      projectDir: projectDir || null,
      testCommand: testCommand || null,
      maxDebateRounds: maxDebateRounds ?? 2,
      attachments: attachments || [],   // {path, url, name} — kullanıcının eklediği görseller
      status: "running",       // running | done | stopped | failed
      phase: "planning",
      tasks: [],               // {id,title,assignee,prompt,status,result,dependsOn,startedAt,endedAt}
      messages: [],            // ortak konuşma alanı
      decisions: [],           // {id,ts,title,detail,rationale}
      votes: [],               // {round, agent, choice, scores, reason}
      reviews: [],             // {taskId, reviewer, agreement, severity, points}
      files: [],               // {agent, path, change}
      tests: [],               // {ts, command, ok, output}
      diffs: [],               // {agent, branch, diff}
      usage: {},               // agent -> {input, cachedInput, output, calls, costUsd}
      usageDaily: {},          // "YYYY-MM-DD" -> agent -> {input,cachedInput,output,calls,costUsd}
      verify: null,            // doğrulayıcı turu sonucu
      evidenceGate: null,      // son merge/publish/done kanıt kapısı sonucu
      report: null,
      error: null,
      stopRequested: false,
      pinned:false, archived:false, tags:[], deletedAt:null, diffComments:[], autoResume:kind!=="chat",
      createdAt: now(),
    };
    this.runs[id] = run;
    fs.mkdirSync(path.join(this.runsDir, id), { recursive: true });
    this.saveRun(run);
    this.emit("event", { type: "run_created", runId: id });
    return run;
  }

  getRun(id) {
    return this.runs[id] || null;
  }

  saveRun(run) {
    const file = path.join(this.runsDir, run.id, "state.json");
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(run, null, 2));
    fs.renameSync(temp, file);
  }

  updateRun(run, patch = {}) {
    Object.assign(run, patch);
    this.saveRun(run);
    this.emit("event", { type: "run_updated", runId: run.id });
  }

  setPhase(run, phase) {
    run.phase = phase;
    this.saveRun(run);
    this.emit("event", { type: "phase", runId: run.id, phase });
  }

  // ---- Mesajlar (ortak konuşma alanı) ----
  addMessage(run, { from, fromLabel = null, provider = null, model = null, kind = "message", taskId = null, content, attachments = [] }) {
    const msg = {
      id: uid("msg-"),
      ts: now(),
      from,               // üye id'si | kullanici | koordinator | sistem
      fromLabel,          // üyenin görünen adı (örn. "Codex Mimar 2")
      provider,           // üyenin sağlayıcısı (renk için): claude | codex | antigravity
      model,              // gerçekten çalıştırılan model (kimlik rozeti için)
      kind,               // message | task | result | review | debate | vote | decision | error | info
      taskId,
      content: truncate(String(content ?? ""), 16000),
      attachments: Array.isArray(attachments) ? attachments.map((a) => ({ name:a.name, url:a.url, path:a.path, mime:a.mime, kind:a.kind, size:a.size })) : [],
      feedback: null,
    };
    run.messages.push(msg);
    const line = JSON.stringify({ runId: run.id, ...msg }) + "\n";
    fs.appendFileSync(path.join(this.runsDir, run.id, "messages.jsonl"), line);
    this.saveRun(run);
    this.emit("event", { type: "message", runId: run.id, message: msg });
    return msg;
  }

  addDecision(run, { title, detail, rationale }) {
    const d = { id: uid("d-"), ts: now(), title, detail, rationale };
    run.decisions.push(d);
    this.saveRun(run);
    this.emit("event", { type: "decision", runId: run.id, decision: d });
    return d;
  }

  // ---- Onay kuyruğu ----
  // Riskli işlemler (test komutu çalıştırma, merge, silme vb.) kullanıcı onayı bekler.
  requestApproval(run, { kind, title, detail }) {
    const id = uid("ap-");
    const approval = {
      id,
      runId: run.id,
      kind,
      risk:["publish","delete","remove","gitinit"].includes(kind)?"yüksek":["testfix","merge","restore"].includes(kind)?"orta":"düşük",
      reversible:!["publish","delete","remove"].includes(kind),
      title,
      detail: truncate(detail || "", 12000),
      status: "pending", // pending | approved | rejected | cancelled
      ts: now(),
    };
    this.approvals[id] = approval;
    this.emit("event", { type: "approval", approval });
    return new Promise((resolve) => {
      approval._resolve = resolve;
    });
  }

  resolveApproval(id, decision) {
    const ap = this.approvals[id];
    if (!ap || ap.status !== "pending") return null;
    ap.status = decision; // approved | rejected
    ap.resolvedAt = now();
    this.emit("event", { type: "approval", approval: this.publicApproval(ap) });
    ap._resolve?.(decision === "approved");
    return ap;
  }

  cancelApprovals(runId) {
    for (const ap of Object.values(this.approvals)) {
      if (ap.runId === runId && ap.status === "pending") {
        ap.status = "cancelled";
        ap._resolve?.(false);
        this.emit("event", { type: "approval", approval: this.publicApproval(ap) });
      }
    }
  }

  publicApproval(ap) {
    const { _resolve, ...rest } = ap;
    return rest;
  }

  // ---- UI'ya giden tam durum ----
  snapshot(focusRunId = null) {
    const effectiveFocus = focusRunId || Object.values(this.runs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id || null;
    return {
      health: this.health || {},
      agents: this.agentStatus,
      approvals: Object.values(this.approvals).map((a) => this.publicApproval(a)),
      runs: Object.fromEntries(Object.entries(this.runs).map(([id, r]) => {
        if (id === effectiveFocus) return [id, r];
        const { messages, diffs, report, ...summary } = r;
        return [id, { ...summary, messages: [], diffs: [], report: report ? "" : null, hasReport: !!report }];
      })),
    };
  }
}
