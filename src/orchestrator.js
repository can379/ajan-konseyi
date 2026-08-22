import path from "node:path";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeAgent } from "./agents/claudeAgent.js";
import { CodexAgent } from "./agents/codexAgent.js";
import { AntigravityAgent } from "./agents/antigravityAgent.js";
import { Coordinator } from "./coordinator.js";
import { ProjectContext } from "./projectContext.js";
import { TIER_MAP } from "./models.js";
import { extractJson, truncate } from "./util.js";
import * as gitops from "./gitops.js";

const exec = promisify(execFile);

export class Orchestrator {
  constructor(store, rootDir, config) {
    this.store = store;
    this.rootDir = rootDir;
    this.config = config;
    this.projectContext = new ProjectContext(rootDir);
    this.agents = {
      claude: new ClaudeAgent(store, rootDir),
      codex: new CodexAgent(store, rootDir),
      antigravity: new AntigravityAgent(store, rootDir),
    };
    for (const name of Object.keys(this.agents)) {
      this.agents[name].getModel = () => this.config?.data.agents[name]?.model || "";
      this.agents[name].getParallel = () => this.config?.data.agents[name]?.parallel || 1;
      this.agents[name].getEffort = () => this.config?.data.agents[name]?.effort || "";
    }
    this.coordinator = new Coordinator(store, rootDir);
    setInterval(() => this.agents.antigravity.updateBridgeStatus(), 30_000);
  }

  // ---- macOS bildirimi ----
  notify(title, body) {
    if (!this.config?.data.notifications) return;
    try {
      const escq = (s) => String(s).replace(/"/g, '\\"').slice(0, 120);
      spawn("osascript", ["-e", `display notification "${escq(body)}" with title "${escq(title)}" sound name "Glass"`], { stdio: "ignore" }).on("error", () => {});
    } catch {}
  }

  // ---- Sağlık kontrolü ----
  async checkHealth() {
    const health = {};
    try {
      const { stdout } = await exec("claude", ["--version"], { timeout: 15000 });
      health.claude = { ok: true, detail: stdout.trim() };
    } catch (e) {
      health.claude = { ok: false, detail: "claude CLI çalışmıyor: " + String(e.message).slice(0, 120) };
    }
    try {
      // codex login status çıktıyı stderr'e yazar; ikisini birlikte değerlendir
      const r = await exec("codex", ["login", "status"], { timeout: 15000 });
      const out = ((r.stdout || "") + (r.stderr || "")).trim();
      const ok = /logged in/i.test(out) && !/not logged in/i.test(out);
      health.codex = { ok, detail: ok ? out.split("\n")[0] : "Codex girişi yok — `codex login` çalıştırın" };
    } catch (e) {
      const out = ((e.stdout || "") + (e.stderr || "")).trim();
      health.codex = { ok: false, detail: out ? out.split("\n")[0] : "codex CLI çalışmıyor: " + String(e.message).slice(0, 120) };
    }
    health.antigravity = {
      ok: this.agents.antigravity.isConnected(),
      detail: this.agents.antigravity.isConnected() ? "köprü bağlı" : "köprü bekleniyor (isteğe bağlı)",
    };
    this.store.setHealth(health);
    return health;
  }

  availableAgents(run) {
    return run.agents.filter((name) => {
      const a = this.agents[name];
      if (!a || !a.isAvailable()) return false;
      if (name === "antigravity") return a.isConnected();
      return true;
    });
  }

  // ---- Kullanım (token) takibi ----
  accumUsage(run, name, u) {
    if (!u) return;
    const cur = run.usage[name] || { input: 0, cachedInput: 0, output: 0, calls: 0, costUsd: 0 };
    cur.input += u.input || 0;
    cur.cachedInput += u.cachedInput || 0;
    cur.output += u.output || 0;
    cur.costUsd += u.costUsd || 0;
    cur.calls += 1;
    run.usage[name] = cur;
    this.store.saveRun(run);
  }

  bindUsage(run) {
    for (const [name, agent] of Object.entries(this.agents)) {
      agent.onUsage = (u) => this.accumUsage(run, name, u);
    }
    this.coordinator.agent.onUsage = (u) => this.accumUsage(run, "koordinator", u);
  }

  startRun(run) {
    this.runPipeline(run, false).catch((err) => this.failRun(run, err));
  }

  resumeRun(run) {
    if (!["interrupted", "stopped", "failed"].includes(run.status)) {
      throw new Error("Bu koşu devam ettirilemez (durum: " + run.status + ")");
    }
    run.stopRequested = false;
    this.store.updateRun(run, { status: "running" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kaldığı yerden devam ettiriliyor." });
    this.runPipeline(run, true).catch((err) => this.failRun(run, err));
  }

  failRun(run, err) {
    this.store.addMessage(run, {
      from: "sistem", kind: "error",
      content: "Koşu hatayla sonlandı: " + String(err.message || err),
    });
    this.store.updateRun(run, { status: "failed", error: String(err.message || err) });
    this.notify("Ajan Konseyi", "Koşu hatayla durdu");
  }

  checkStop(run) {
    if (run.stopRequested) throw new Error("Kullanıcı koşuyu durdurdu");
  }

  // Akıllı model eşleme: kullanıcı "Otomatik" seçtiyse görev kademesine göre model
  pickModel(agentName, tier) {
    const cfg = this.config?.data;
    if (!cfg?.smartModels) return undefined;
    if (cfg.agents[agentName]?.model) return undefined; // kullanıcının seçimi önce gelir
    return TIER_MAP[agentName]?.[tier] || undefined;
  }

  // ================= ANA BORU HATTI =================
  async runPipeline(run, resume = false) {
    const S = this.store;
    this.bindUsage(run);

    if (!resume) {
      S.addMessage(run, { from: "kullanici", kind: "message", content: run.request });
      this.coordinator.resetSession();
      for (const a of Object.values(this.agents)) a.resetSession();
    }

    let available = this.availableAgents(run);
    if (run.agents.includes("antigravity") && !available.includes("antigravity")) {
      if (!resume) S.addMessage(run, {
        from: "sistem", kind: "info",
        content: "Antigravity köprüsü bağlı değil; görevler Claude ve Codex arasında dağıtılacak.",
      });
      available = available.filter((a) => a !== "antigravity");
    }
    if (available.length === 0) throw new Error("Ulaşılabilir ajan yok (kota soğutması veya çevrimdışı)");

    // ---- 1. PLANLAMA (devamda görevler zaten varsa atlanır) ----
    if (!resume || run.tasks.length === 0) {
      S.setPhase(run, "planning");
      const roles = this.config?.data.agents || {};
      const rolesText = available
        .map((a) =>
          `- ${a}: rol=${roles[a]?.role || "auto"}` +
          (roles[a]?.model ? `, model=${roles[a].model}` : "") +
          `, paralel kopya sınırı=${roles[a]?.parallel || 1}`)
        .join("\n") +
        "\nBir üyeye, paralel kopya sınırına kadar AYNI ANDA çalışacak birden çok bağımsız alt görev atayabilirsin. Kopyalar birbirinin çıktısını görmez; bağımlı işler için depends_on kullan.";

      const plan = await this.coordinator.plan(run, available, {
        rolesText,
        historyText: this.projectHistory(run),
        memoryText: this.projectContext.readMemory(run.projectId),
        repoMap: run.projectDir ? await this.projectContext.repoMap(run.projectDir) : "",
        testFirst: run.testFirst,
      });
      this.checkStop(run);
      if (run.mode === "auto") run.mode = plan.mode || "discussion";
      run.tasks = (plan.subtasks || []).map((t) => ({
        id: t.id, title: t.title, assignee: t.assignee,
        prompt: t.prompt, status: "pending", result: null,
        dependsOn: Array.isArray(t.depends_on) ? t.depends_on : [],
        tier: ["fast", "balanced", "strong"].includes(t.model_tier) ? t.model_tier : "balanced",
      }));
      run.reviewRounds = Math.min(plan.review_rounds ?? 1, 2);
      S.addMessage(run, {
        from: "koordinator", kind: "message",
        content: `Analiz: ${plan.analysis}\n\nMod: ${run.mode}\nGörev dağılımı:\n` +
          run.tasks.map((t) => `- [${t.id}] ${t.title} → ${t.assignee} (${t.tier}${t.dependsOn.length ? ", bağımlı: " + t.dependsOn.join(",") : ""})`).join("\n"),
      });
      S.updateRun(run);
    }

    // ---- Kod modu: worktree hazırlığı (devamda mevcutlar yeniden kullanılır) ----
    const worktrees = {};
    if (run.mode === "code") {
      if (!run.projectDir) throw new Error("Kod modu için proje dizini gerekli");
      if (!(await gitops.isGitRepo(run.projectDir))) {
        throw new Error(`${run.projectDir} bir git deposu değil. Kod modu, güvenli paralel çalışma için git gerektirir.`);
      }
      const involved = [...new Set(run.tasks.map((t) => t.assignee))].filter((a) => a !== "antigravity");
      for (const agentName of involved) {
        worktrees[agentName] = await gitops.createWorktree(run.projectDir, S.runsDir, run.id, agentName);
      }
      if (!resume) S.addMessage(run, {
        from: "sistem", kind: "info",
        content: "Ayrı çalışma kopyaları hazır: " + involved.map((a) => `${a} → ajan/${run.id}/${a}`).join(", "),
      });
    }

    // ---- 2. DAĞITIM + BORU HATTI İNCELEMESİ ----
    // Görev biter bitmez incelemesi başlar; diğer görevlerin bitmesi beklenmez.
    S.setPhase(run, "dispatch");
    run.tasks.forEach((t) => { if (t.status === "active" || t.status === "failed") t.status = "pending"; });
    const reviewPromises = [];
    while (run.tasks.some((t) => t.status === "pending")) {
      this.checkStop(run);
      const settled = (id) => {
        const t = run.tasks.find((x) => x.id === id);
        return !t || t.status === "done" || t.status === "failed";
      };
      const ready = run.tasks.filter(
        (t) => t.status === "pending" && (t.dependsOn || []).every(settled)
      );
      if (ready.length === 0) {
        run.tasks.filter((t) => t.status === "pending").forEach((t) => (t.dependsOn = []));
        continue;
      }
      await Promise.all(ready.map(async (task) => {
        await this.runTask(run, task, available, worktrees);
        // Boru hattı: görev bitti → incelemeleri hemen başlat
        if (task.status === "done" && available.length > 1 && (run.reviewRounds ?? 1) > 0) {
          const already = run.reviews.some((r) => r.taskId === task.id);
          if (!already) reviewPromises.push(this.reviewTask(run, task, available, worktrees));
        }
      }));
    }
    this.checkStop(run);
    const doneTasks = run.tasks.filter((t) => t.status === "done");
    if (doneTasks.length === 0) throw new Error("Hiçbir alt görev tamamlanamadı");

    if (reviewPromises.length) {
      S.setPhase(run, "review");
      await Promise.all(reviewPromises);
    }

    // ---- 3. ÇELİŞKİ TESPİTİ (önce sayısal, gerekirse koordinatör) ----
    let voteInfo = null;
    if (available.length > 1) {
      let round = 0;
      while (round < run.maxDebateRounds) {
        this.checkStop(run);
        const assess = await this.assessConflict(run, round + 1);
        S.addMessage(run, {
          from: "koordinator", kind: "message",
          content: (assess.conflict ? "Görüş ayrılığı tespit edildi: " : "Uzlaşma durumu: ") + assess.summary,
        });
        if (!assess.conflict) break;
        round++;
        if (round >= run.maxDebateRounds) {
          S.setPhase(run, "vote");
          voteInfo = await this.holdVote(run, available, assess);
          break;
        }
        S.setPhase(run, "debate");
        await this.debateRound(run, available, assess.debate_prompt, round);
        // Tartışma sonrası yeniden puanlı inceleme yerine koordinatör değerlendirmesi kullanılır
        run.reviews = run.reviews.filter((r) => !r.postDebate);
      }
    }

    // ---- 4. DOĞRULAYICI TURU (çürütme denemesi) ----
    if (available.length > 1 && !run.stopRequested) {
      await this.verifyRound(run, available, worktrees);
    }

    // ---- 5. KOD MODU: diff, birleştirme, test, kırmızı-yeşil ----
    if (run.mode === "code") {
      await this.codeIntegration(run, worktrees);
    }

    // ---- 6. SENTEZ, RAPOR, PROJE HAFIZASI ----
    this.checkStop(run);
    S.setPhase(run, "synthesis");
    const fin = await this.coordinator.finalize(run, voteInfo);
    S.addDecision(run, { title: fin.decision, detail: "Nihai karar", rationale: fin.rationale });
    run.report = fin.report_markdown || fin.decision;
    fs.writeFileSync(path.join(S.runsDir, run.id, "report.md"), run.report);
    S.addMessage(run, { from: "koordinator", kind: "decision", content: `KARAR: ${fin.decision}\n\nGerekçe: ${fin.rationale}` });
    this.projectContext.appendMemory(run.projectId, run, fin.decision);
    S.updateRun(run, { status: "done", phase: "done" });
    this.notify("Ajan Konseyi ✓", "Koşu tamamlandı: " + truncate(run.request, 60));
  }

  // ---- Tek alt görev ----
  async runTask(run, task, available, worktrees) {
    const S = this.store;
    if (!available.includes(task.assignee)) {
      const fb = this.coordinator.pickFallback(task.assignee, available);
      if (!fb) { task.status = "failed"; return; }
      S.addMessage(run, { from: "sistem", kind: "info", taskId: task.id, content: `${task.assignee} ulaşılamaz; görev ${fb} üyesine devredildi.` });
      task.assignee = fb;
    }
    task.status = "active";
    task.startedAt = new Date().toISOString();
    S.updateRun(run);
    S.addMessage(run, { from: "koordinator", kind: "task", taskId: task.id, content: `[${task.assignee}] için görev: ${task.title}\n\n${task.prompt}` });

    const opts = {
      label: task.title,
      codeMode: run.mode === "code",
      cwd: worktrees[task.assignee]?.wtDir,
      model: this.pickModel(task.assignee, task.tier),
      shouldStop: () => run.stopRequested,
    };
    let depContext = "";
    for (const depId of task.dependsOn || []) {
      const dep = run.tasks.find((t) => t.id === depId);
      if (dep?.status === "done" && dep.result) {
        depContext += `\n--- ÖNCEKİ GÖREVİN ÇIKTISI [${dep.id}: ${dep.title} / ${dep.assignee}] ---\n${truncate(dep.result, 6000)}\n`;
      }
    }
    const header = this.roleHeader(task.assignee, run) + depContext;
    let res = await this.agents[task.assignee].sendParallel(header + task.prompt, opts);

    if (!res.ok && !run.stopRequested) {
      S.addMessage(run, { from: "sistem", kind: "error", taskId: task.id, content: `${task.assignee} görevi tamamlayamadı: ${res.error}` });
      const fb = this.coordinator.pickFallback(task.assignee, this.availableAgents(run));
      if (fb) {
        S.addMessage(run, { from: "koordinator", kind: "info", taskId: task.id, content: `Görev ${fb} üyesine yeniden atandı.` });
        task.assignee = fb;
        res = await this.agents[fb].sendParallel(header + task.prompt, { ...opts, cwd: worktrees[fb]?.wtDir, model: this.pickModel(fb, task.tier) });
      }
    }

    task.endedAt = new Date().toISOString();
    if (res.ok) {
      task.status = "done";
      task.result = res.text;
      S.addMessage(run, { from: task.assignee, kind: "result", taskId: task.id, content: res.text });
    } else {
      task.status = "failed";
      task.result = res.error;
      if (!run.stopRequested) {
        S.addMessage(run, { from: "sistem", kind: "error", taskId: task.id, content: `Görev başarısız: ${res.error}` });
      }
    }
    S.updateRun(run);
  }

  roleHeader(agentName, run) {
    const role = this.config?.data.agents[agentName]?.role;
    const rolePart = role && role !== "auto" ? ` Konsey içindeki rolün: ${role}.` : "";
    return `Sen "${agentName}" adlı üye olarak üç yapay zekâdan oluşan bir konseyde çalışıyorsun (üyeler: claude, codex, antigravity; koordinatör görevleri dağıtır).${rolePart} Yanıtlarını Türkçe yaz ve gereksiz uzatma.\n\nKullanıcının ana isteği: "${truncate(run.request, 1200)}"\n\n--- SANA VERİLEN GÖREV ---\n`;
  }

  // ---- Puanlı çapraz inceleme (görev başına, boru hattında) ----
  async reviewTask(run, task, available, worktrees) {
    const S = this.store;
    const reviewers = available.filter((a) => a !== task.assignee);
    await Promise.all(reviewers.map(async (reviewer) => {
      const prompt = this.roleHeader(reviewer, run) +
        `"${task.assignee}" üyesinin şu çıktısını eleştirel incele:\n\n### ${task.title}\n${truncate(task.result, 6000)}\n\n` +
        `Değerlendirmeni YALNIZCA şu şemada tek bir JSON nesnesi olarak ver:\n` +
        `{"agreement": 1-5 arası tam sayı (5=tamamen katılıyorum), "severity": "dusuk|orta|yuksek" (bulduğun sorunların önemi), ` +
        `"points": ["somut eleştiri/iyileştirme maddeleri"], "evidence": ["varsa dosya:satır veya somut kanıt"], "suggestion": "tek cümlelik öneri"}`;
      const res = await this.agents[reviewer].send(prompt, {
        label: `inceleme: ${task.id}`,
        cwd: worktrees?.[reviewer]?.wtDir,
        shouldStop: () => run.stopRequested,
      });
      if (!res.ok) {
        if (!run.stopRequested) S.addMessage(run, { from: "sistem", kind: "error", content: `${reviewer} incelemesi başarısız: ${res.error}` });
        return;
      }
      const j = extractJson(res.text) || { agreement: 3, severity: "orta", points: [res.text], suggestion: "" };
      run.reviews.push({
        taskId: task.id, reviewer,
        agreement: Math.min(5, Math.max(1, Number(j.agreement) || 3)),
        severity: j.severity || "orta",
        points: j.points || [],
      });
      S.addMessage(run, {
        from: reviewer, kind: "review", taskId: task.id,
        content: `İnceleme [${task.id}] — katılım: ${j.agreement}/5, önem: ${j.severity}\n` +
          (j.points || []).map((p) => `• ${p}`).join("\n") +
          (j.evidence?.length ? `\nKanıt: ${j.evidence.join("; ")}` : "") +
          (j.suggestion ? `\nÖneri: ${j.suggestion}` : ""),
      });
      S.updateRun(run);
    }));
  }

  // ---- Çelişki: önce sayısal eşik, belirsizse koordinatör ----
  async assessConflict(run, round) {
    const scores = run.reviews.map((r) => r.agreement);
    if (scores.length) {
      const min = Math.min(...scores);
      if (min <= 2) {
        const worst = run.reviews.filter((r) => r.agreement <= 2);
        return {
          conflict: true,
          summary: `Puanlı incelemelerde ciddi itiraz var (en düşük katılım: ${min}/5). ` +
            worst.map((r) => `${r.reviewer}→[${r.taskId}]`).join(", "),
          debate_prompt: "Şu itirazlar çözülmeli: " + worst.flatMap((r) => r.points).slice(0, 6).join(" | "),
        };
      }
      if (scores.every((s) => s >= 4)) {
        return { conflict: false, summary: `Tüm incelemeler olumlu (katılım ${Math.min(...scores)}-${Math.max(...scores)}/5); uzlaşma var.`, debate_prompt: "" };
      }
    }
    return this.coordinator.assessConflict(run, round);
  }

  async debateRound(run, available, debatePrompt, round) {
    const S = this.store;
    await Promise.all(available.map(async (agentName) => {
      const recent = run.messages
        .filter((m) => ["review", "debate", "result"].includes(m.kind) && m.from !== agentName)
        .slice(-4)
        .map((m) => `[${m.from}]: ${truncate(m.content, 3000)}`)
        .join("\n\n");
      const prompt = this.roleHeader(agentName, run) +
        `TARTIŞMA TURU ${round}. Koordinatörün sorusu: ${debatePrompt}\n\n` +
        `Diğer üyelerin son görüşleri:\n${recent}\n\n` +
        `Kendi görüşünü savun veya ikna olduysan güncelle. Uzlaşıya katkı sağlayacak somut bir öneriyle bitir.`;
      const res = await this.agents[agentName].send(prompt, {
        label: `tartışma (tur ${round})`,
        shouldStop: () => run.stopRequested,
      });
      if (res.ok) {
        S.addMessage(run, { from: agentName, kind: "debate", content: `Tartışma (tur ${round}):\n${res.text}` });
      }
    }));
  }

  // ---- Rubrikli hakemli oylama ----
  async holdVote(run, available, assess) {
    const S = this.store;
    S.addMessage(run, { from: "koordinator", kind: "info", content: "Tartışma tur sınırına ulaşıldı; rubrikli oylamaya geçiliyor." });
    const positions = run.tasks.filter((t) => t.status === "done")
      .map((t) => `- "${t.assignee}" yaklaşımı: ${truncate(t.result, 2000)}`).join("\n");
    const votes = [];
    await Promise.all(available.map(async (agentName) => {
      const prompt = this.roleHeader(agentName, run) +
        `OYLAMA. Anlaşmazlık: ${assess.summary}\n\nYaklaşımlar:\n${positions}\n\n` +
        `Her yaklaşımı değerlendirip birine (veya karmaya) oy ver. YALNIZCA şu şemada tek bir JSON nesnesi döndür:\n` +
        `{"choice": "claude|codex|antigravity|karma", "scores": {"dogruluk": 1-5, "eksiksizlik": 1-5, "risk": 1-5 (5=en az riskli)}, "reason": "teknik gerekçe (Türkçe)"}`;
      const res = await this.agents[agentName].send(prompt, { label: "oylama", shouldStop: () => run.stopRequested });
      if (res.ok) {
        const v = extractJson(res.text) || { choice: "?", reason: res.text };
        votes.push({ agent: agentName, choice: v.choice, scores: v.scores || null, reason: v.reason });
        S.addMessage(run, {
          from: agentName, kind: "vote",
          content: `OY: ${v.choice}` +
            (v.scores ? ` (doğruluk ${v.scores.dogruluk}/5, eksiksizlik ${v.scores.eksiksizlik}/5, risk ${v.scores.risk}/5)` : "") +
            `\nGerekçe: ${v.reason}`,
        });
      }
    }));
    run.votes = votes;
    this.store.updateRun(run);
    const tally = {};
    for (const v of votes) tally[v.choice] = (tally[v.choice] || 0) + 1;
    return { votes, tally };
  }

  // ---- Doğrulayıcı turu: çözümü çürütmeye çalış ----
  async verifyRound(run, available, worktrees) {
    const S = this.store;
    this.checkStop(run);
    S.setPhase(run, "verify");
    // Denetçi rolü atanmışsa onu, yoksa en az görev üretmiş üyeyi seç
    const roles = this.config?.data.agents || {};
    let verifier = available.find((a) => roles[a]?.role === "denetci");
    if (!verifier) {
      const counts = Object.fromEntries(available.map((a) => [a, run.tasks.filter((t) => t.assignee === a).length]));
      verifier = available.sort((a, b) => counts[a] - counts[b])[0];
    }
    const solution = run.tasks.filter((t) => t.status === "done")
      .map((t) => `### [${t.id}] ${t.title} (${t.assignee})\n${truncate(t.result, 4000)}`).join("\n\n");
    const prompt = this.roleHeader(verifier, run) +
      `DOĞRULAYICI TURU. Konseyin ürettiği çözüm aşağıda. Görevin bu çözümü ÇÜRÜTMEYE çalışmak: ` +
      `hatalar, kenar durumlar, güvenlik açıkları, yanlış varsayımlar, eksikler ara.\n\n${solution}\n\n` +
      `YALNIZCA şu şemada tek bir JSON nesnesi döndür:\n` +
      `{"verdict": "saglam|riskli|curutuldu", "issues": ["bulunan somut sorunlar"], "summary": "tek cümlelik özet"}`;
    const res = await this.agents[verifier].send(prompt, {
      label: "doğrulama", cwd: worktrees?.[verifier]?.wtDir, shouldStop: () => run.stopRequested,
    });
    if (!res.ok) return;
    const v = extractJson(res.text) || { verdict: "riskli", issues: [res.text], summary: "" };
    run.verify = { verifier, verdict: v.verdict, issues: v.issues || [], summary: v.summary || "" };
    S.addMessage(run, {
      from: verifier, kind: "review",
      content: `🔎 DOĞRULAMA: ${v.verdict === "saglam" ? "✓ sağlam" : v.verdict}\n${v.summary}\n` +
        (v.issues || []).map((i) => `• ${i}`).join("\n"),
    });
    S.updateRun(run);

    // Çürütüldüyse bir düzeltme turu: ana yazar sorunları giderir
    if (v.verdict !== "saglam" && v.issues?.length && !run.stopRequested) {
      const counts = {};
      for (const t of run.tasks) counts[t.assignee] = (counts[t.assignee] || 0) + 1;
      const author = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (author && available.includes(author)) {
        const fixPrompt = this.roleHeader(author, run) +
          `Doğrulayıcı (${verifier}) çözümde şu sorunları buldu:\n` +
          v.issues.map((i) => `• ${i}`).join("\n") +
          `\n\nBu sorunları gider: düzeltilmiş/iyileştirilmiş halini üret.` +
          (run.mode === "code" ? " Kod değişikliği gerekiyorsa kendi çalışma kopyanda uygula ve ne değiştirdiğini özetle." : "");
        const fix = await this.agents[author].send(fixPrompt, {
          label: "düzeltme", codeMode: run.mode === "code",
          cwd: worktrees?.[author]?.wtDir, shouldStop: () => run.stopRequested,
        });
        if (fix.ok) {
          S.addMessage(run, { from: author, kind: "result", content: `Düzeltme (doğrulama sonrası):\n${fix.text}` });
          const mainTask = run.tasks.filter((t) => t.assignee === author && t.status === "done").pop();
          if (mainTask) mainTask.result += `\n\n--- DÜZELTME ---\n${truncate(fix.text, 4000)}`;
          S.updateRun(run);
        }
      }
    }
  }

  // ---- Kod bütünleştirme: diff, onaylı merge, test, kırmızı-yeşil ----
  async codeIntegration(run, worktrees) {
    const S = this.store;
    S.setPhase(run, "integration");
    const diffs = [];
    for (const [agentName, wt] of Object.entries(worktrees)) {
      const { status, diff } = await gitops.collectDiff(wt.wtDir);
      if (!status) continue;
      diffs.push({ agent: agentName, branch: wt.branch, diff });
      for (const line of status.split("\n")) {
        const m = line.trim().match(/^(\S+)\s+(.+)$/);
        if (m) run.files.push({ agent: agentName, path: m[2], change: m[1] });
      }
      await gitops.commitAll(wt.wtDir, `ajan(${agentName}): ${truncate(run.request, 60)}`);
    }
    run.diffs = diffs.map((d) => ({ agent: d.agent, branch: d.branch, diff: truncate(d.diff, 60000) }));
    S.updateRun(run);
    if (diffs.length === 0) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Hiçbir ajan dosya değişikliği yapmadı; birleştirme adımı atlandı." });
      return;
    }

    const plan = await this.coordinator.mergePlan(run, diffs);
    S.addMessage(run, {
      from: "koordinator", kind: "message",
      content: `Birleştirme planı: ${plan.summary}\nSıra: ${(plan.merge_order || []).join(" → ")}` +
        (plan.conflicts?.length ? `\n\n⚠ Çakışmalar (elle inceleme gerekli):\n- ${plan.conflicts.join("\n- ")}` : "") +
        (plan.risks?.length ? `\nRiskler:\n- ${plan.risks.join("\n- ")}` : ""),
    });

    this.notify("Ajan Konseyi ⚠", "Birleştirme onayı bekleniyor");
    const approved = await S.requestApproval(run, {
      kind: "merge",
      title: "Dalları birleştirme onayı",
      detail: `Şu dallar "ajan/${run.id}/integration" dalında birleştirilecek:\n` +
        diffs.map((d) => `- ${d.branch} (${d.agent})`).join("\n") +
        (plan.conflicts?.length ? "\n\n⚠ Koordinatör olası çakışmalar bildirdi; çakışan birleştirmeler otomatik yapılmaz." : ""),
    });
    this.checkStop(run);
    let merged = false;
    if (!approved) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Birleştirme reddedildi. Değişiklikler kendi dallarında duruyor; diff'ler Dosyalar sekmesinde." });
    } else {
      const order = (plan.merge_order || []).filter((a) => diffs.some((d) => d.agent === a));
      const finalOrder = order.length ? order : diffs.map((d) => d.agent);
      for (const agentName of finalOrder) {
        const d = diffs.find((x) => x.agent === agentName);
        const result = await gitops.mergeBranch(run.projectDir, S.runsDir, run.id, d.branch);
        if (result.ok) {
          merged = true;
          S.addMessage(run, { from: "sistem", kind: "info", content: `✓ ${d.branch} birleştirildi.` });
        } else {
          S.addMessage(run, {
            from: "sistem", kind: "error",
            content: `✗ ${d.branch} birleştirilemedi (çakışma): ${result.conflicts.join(", ") || result.error}. Elle inceleme gerekli; otomatik birleştirme yapılmadı.`,
          });
        }
      }
    }

    // Testler (onaylı) + kırmızı-yeşil döngüsü
    if (run.testCommand) {
      const testDir = merged
        ? path.join(S.runsDir, run.id, "worktrees", "_integration")
        : Object.values(worktrees)[0]?.wtDir || run.projectDir;
      this.notify("Ajan Konseyi ⚠", "Test onayı bekleniyor");
      const ok = await S.requestApproval(run, {
        kind: "test",
        title: "Test komutu çalıştırma onayı",
        detail: `Komut: ${run.testCommand}\nDizin: ${testDir}`,
      });
      this.checkStop(run);
      if (ok) {
        S.setPhase(run, "testing");
        let testResult = await this.runTests(run, testDir);
        // Kırmızı-yeşil: test kırıldıysa bir otomatik düzeltme turu
        if (!testResult.ok && merged && !run.stopRequested) {
          S.addMessage(run, { from: "koordinator", kind: "info", content: "Testler kırıldı; otomatik düzeltme turu başlatılıyor (kırmızı-yeşil)." });
          const fixer = run.diffs.sort((a, b) => b.diff.length - a.diff.length)[0]?.agent;
          if (fixer && this.agents[fixer]?.isAvailable()) {
            const fixPrompt = this.roleHeader(fixer, run) +
              `Birleştirme sonrası testler KIRILDI. Test çıktısı:\n\n${truncate(testResult.output, 6000)}\n\n` +
              `Bu dizinde çalışıyorsun: ${testDir}\nTestleri geçirecek asgari düzeltmeyi uygula ve ne değiştirdiğini özetle.`;
            const fix = await this.agents[fixer].send(fixPrompt, {
              label: "test düzeltme", codeMode: true, cwd: testDir, shouldStop: () => run.stopRequested,
            });
            if (fix.ok) {
              S.addMessage(run, { from: fixer, kind: "result", content: `Test düzeltmesi:\n${fix.text}` });
              await gitops.commitAll(testDir, `ajan(${fixer}): test düzeltmesi`).catch(() => {});
              await this.runTests(run, testDir); // aynı onaylı komut yeniden koşulur
            }
          }
        }
      }
    }
  }

  async runTests(run, testDir) {
    const S = this.store;
    try {
      const { stdout, stderr } = await exec("/bin/zsh", ["-lc", run.testCommand], {
        cwd: testDir, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
      });
      const output = truncate(stdout + "\n" + stderr, 12000);
      run.tests.push({ ts: new Date().toISOString(), command: run.testCommand, ok: true, output });
      S.addMessage(run, { from: "sistem", kind: "info", content: "✓ Testler başarılı.\n" + truncate(stdout, 3000) });
      S.updateRun(run);
      return { ok: true, output };
    } catch (err) {
      const output = truncate((err.stdout || "") + "\n" + (err.stderr || err.message), 12000);
      run.tests.push({ ts: new Date().toISOString(), command: run.testCommand, ok: false, output });
      S.addMessage(run, { from: "sistem", kind: "error", content: "✗ Testler BAŞARISIZ:\n" + truncate(output, 3000) });
      S.updateRun(run);
      return { ok: false, output };
    }
  }

  projectHistory(run) {
    if (!run.projectDir) return "";
    const prev = Object.values(this.store.runs)
      .filter((r) => r.projectDir === run.projectDir && r.id !== run.id && r.report)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 2);
    if (!prev.length) return "";
    return prev
      .map((r) => `### Önceki çalışma (${r.createdAt.slice(0, 10)}): ${truncate(r.request, 150)}\n${truncate(r.report, 1500)}`)
      .join("\n\n");
  }

  async directMessage(run, agentName, content) {
    const S = this.store;
    const agent = this.agents[agentName];
    if (!agent) throw new Error("Bilinmeyen ajan: " + agentName);
    this.bindUsage(run);
    S.addMessage(run, { from: "kullanici", kind: "message", content: `@${agentName}: ${content}` });
    const res = await agent.send(
      `Kullanıcıdan sana doğrudan bir mesaj geldi (konsey bağlamında, Türkçe yanıtla):\n\n${content}`,
      { label: "doğrudan mesaj" }
    );
    if (res.ok) {
      S.addMessage(run, { from: agentName, kind: "message", content: res.text });
    } else {
      S.addMessage(run, { from: "sistem", kind: "error", content: `${agentName} yanıt veremedi: ${res.error}` });
    }
    return res;
  }

  async rollback(run) {
    if (!run.projectDir) throw new Error("Bu koşunun proje dizini yok");
    const deleted = await gitops.rollbackRun(run.projectDir, this.store.runsDir, run.id);
    this.store.addMessage(run, {
      from: "sistem", kind: "info",
      content: deleted.length
        ? "↩ Geri alındı. Silinen dallar: " + deleted.join(", ")
        : "Silinecek dal bulunamadı (zaten temiz).",
    });
    return deleted;
  }

  stopRun(run) {
    run.stopRequested = true;
    for (const a of Object.values(this.agents)) a.stop();
    this.coordinator.stop();
    this.store.cancelApprovals(run.id);
    this.store.updateRun(run, { status: "stopped", phase: "stopped" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kullanıcı tarafından durduruldu." });
  }
}
