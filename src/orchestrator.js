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

// Orkestratör: konsey ÜYELERİNİ (kullanıcının tanımladığı, her biri bir
// sağlayıcıya bağlı kişilikler) yönetir. Üye sayısı serbesttir: 3 Codex mimar,
// 1 Claude denetçi vb. Koordinatörün sağlayıcısını da kullanıcı seçer.
export class Orchestrator {
  constructor(store, rootDir, config) {
    this.store = store;
    this.rootDir = rootDir;
    this.config = config;
    this.projectContext = new ProjectContext(rootDir);
    this.providers = {
      claude: new ClaudeAgent(store, rootDir),
      codex: new CodexAgent(store, rootDir),
      antigravity: new AntigravityAgent(store, rootDir),
    };
    this.agents = this.providers; // geriye dönük uyumluluk
    this.coordinator = new Coordinator(store, this.providers, () => this.config.data.coordinator);
    this.providers.antigravity.onNeedsAttention = () => {
      this.notify("Ajan Konseyi 🔔", "Antigravity görev bekliyor — Antigravity'de ajana 'inbox'u kontrol et' deyin");
    };
    setInterval(() => this.providers.antigravity.updateBridgeStatus(), 30_000);
  }

  // ---- Üyeler ----
  members() {
    return this.config.data.members || [];
  }

  memberById(id) {
    return this.members().find((m) => m.id === id) || null;
  }

  providerAvailable(prov) {
    const p = this.providers[prov];
    if (!p || !p.isAvailable()) return false;
    if (prov === "antigravity") return p.isConnected();
    return true;
  }

  availableMembers() {
    return this.members().filter((m) => m.enabled && this.providerAvailable(m.provider));
  }

  // Antigravity ajanı şu anda fiilen izleme yapıyor mu? (taze kalp atışı)
  antigravitySleeping() {
    return !this.providers.antigravity.isFresh?.(2 * 60 * 1000);
  }

  memberListText(list) {
    return list.map((m) =>
      `- ${m.id} | ${m.name} | ${m.provider} | rol=${m.role}${m.model ? ` | model=${m.model}` : ""}` +
      (m.provider === "antigravity" && this.antigravitySleeping() ? " | (şu an uyuyor, yanıtı gecikebilir — zorunlu değilse seçme)" : "")
    ).join("\n");
  }

  sessionKeyFor(run, member) {
    return `${run.id}#${member.id}`;
  }

  // Üye çağrısı: durum rozetini yönetir, kullanım verisini üyeye yazar
  async callMember(run, member, prompt, opts = {}) {
    const provider = this.providers[member.provider];
    this.store.setAgentStatus(member.id, "busy", opts.label || "");
    const res = await provider.send(prompt, {
      ...opts,
      sessionKey: this.sessionKeyFor(run, member),
      memberId: member.id,
      model: member.model || opts.tierModel || undefined,
      effort: member.effort || undefined,
      onUsage: (u) => this.accumUsage(run, member.id, u),
    });
    const stopped = run.stopRequested;
    this.store.setAgentStatus(member.id, res.ok || stopped ? "idle" : "error",
      res.ok || stopped ? "" : String(res.error || "").slice(0, 80));
    return res;
  }

  memberMsg(run, member, kind, content, taskId = null) {
    this.store.addMessage(run, {
      from: member.id, fromLabel: member.name, provider: member.provider,
      kind, taskId, content,
    });
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
      const r = await exec("codex", ["login", "status"], { timeout: 15000 });
      const out = ((r.stdout || "") + (r.stderr || "")).trim();
      const ok = /logged in/i.test(out) && !/not logged in/i.test(out);
      health.codex = { ok, detail: ok ? out.split("\n")[0] : "Codex girişi yok — `codex login` çalıştırın" };
    } catch (e) {
      const out = ((e.stdout || "") + (e.stderr || "")).trim();
      health.codex = { ok: false, detail: out ? out.split("\n")[0] : "codex CLI çalışmıyor: " + String(e.message).slice(0, 120) };
    }
    health.antigravity = {
      ok: this.providers.antigravity.isConnected(),
      detail: this.providers.antigravity.isConnected() ? "köprü bağlı" : "köprü bekleniyor (isteğe bağlı)",
    };
    this.store.setHealth(health);
    return health;
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

  // ---- Oturum kalıcılığı (restart sonrası sohbet hafızası) ----
  persistSessions(run) {
    run.sessions = {};
    for (const [prov, agent] of Object.entries(this.providers)) {
      for (const [key, id] of agent.sessions) {
        if (key.startsWith(run.id + "#") || key === run.id) {
          run.sessions[key] = { provider: prov, id };
        }
      }
    }
    this.store.saveRun(run);
  }

  restoreSessions(run) {
    for (const [key, val] of Object.entries(run.sessions || {})) {
      if (val?.provider && val?.id) {
        this.providers[val.provider]?.sessions.set(key, val.id);
      }
    }
  }

  startRun(run) {
    this.runPipeline(run, false)
      .catch((err) => this.failRun(run, err))
      .finally(() => this.persistSessions(run));
  }

  resumeRun(run) {
    if (!["interrupted", "stopped", "failed"].includes(run.status)) {
      throw new Error("Bu koşu devam ettirilemez (durum: " + run.status + ")");
    }
    run.stopRequested = false;
    this.store.updateRun(run, { status: "running" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kaldığı yerden devam ettiriliyor." });
    this.runPipeline(run, true)
      .catch((err) => this.failRun(run, err))
      .finally(() => this.persistSessions(run));
  }

  failRun(run, err) {
    this.store.addMessage(run, {
      from: "sistem", kind: "error",
      content: "Koşu hatayla sonlandı: " + String(err.message || err),
    });
    this.store.updateRun(run, { status: run.kind === "chat" ? "idle" : "failed", error: String(err.message || err) });
    this.notify("Ajan Konseyi", "Koşu hatayla durdu");
  }

  checkStop(run) {
    if (run.stopRequested) throw new Error("Kullanıcı durdurdu");
  }

  // Koordinatör çağrıları için koşuya özgü bağlam (durumsuz Coordinator)
  coordCtx(run) {
    return {
      runId: run.id,
      stopCheck: () => run.stopRequested,
      onUsage: (u) => this.accumUsage(run, "koordinator", u),
    };
  }

  pickTierModel(provider, tier) {
    if (!this.config?.data.smartModels) return undefined;
    return TIER_MAP[provider]?.[tier] || undefined;
  }

  // ================= SOHBET TURU =================
  async continueChat(run, text, attachments = [], mode = "auto") {
    const S = this.store;
    if (run.turnActive) throw new Error("Bu sohbette bir tur zaten çalışıyor; önce durdurun");
    run.turnActive = true;
    run.stopRequested = false;
    run.request = text;
    run.attachments = attachments;
    run.reviews = [];
    run.votes = [];
    run.verify = null;
    S.updateRun(run, { status: "running", phase: "thinking" });
    const ctx = this.coordCtx(run);
    this.restoreSessions(run);

    const attachNote = attachments.length
      ? "\n\n" + attachments.map((a) => `📎 ${a.url || a.path}`).join("\n")
      : "";
    S.addMessage(run, { from: "kullanici", kind: "message", content: text + attachNote });

    try {
      const avail = this.availableMembers();
      if (!avail.length) throw new Error("Ulaşılabilir üye yok (kenar çubuğundan üyeleri kontrol edin)");

      let route;
      if (mode !== "auto") {
        route = { approach: "council", mode };
      } else {
        route = await this.coordinator.routeTurn(run, this.memberListText(avail), ctx);
        this.checkStop(run);
      }

      if (route.approach === "quick") {
        let member = avail.find((m) => m.id === route.member_id) || avail[0];
        // Antigravity uyuyorsa sohbet bekletilmez: yanıt başka üyeden gelir
        if (member.provider === "antigravity" && this.antigravitySleeping()) {
          const alt = avail.find((m) => m.provider !== "antigravity");
          if (alt) {
            S.addMessage(run, {
              from: "sistem", kind: "info",
              content: `${member.name} (Antigravity) şu an uyuyor; yanıtı ${alt.name} veriyor. Antigravity'yi uyandırmak için uygulamasında ajana "inbox'u kontrol et" deyin.`,
            });
            member = alt;
          }
        }
        await this.quickReply(run, member, text, attachments);
      } else {
        run.mode = ["discussion", "split", "code"].includes(route.mode) ? route.mode : "discussion";
        run.tasks = [];
        await this.runPipeline(run, false, true);
      }
    } catch (err) {
      if (!run.stopRequested) {
        S.addMessage(run, { from: "sistem", kind: "error", content: "Tur hatayla bitti: " + String(err.message || err) });
      }
    } finally {
      run.turnActive = false;
      this.persistSessions(run);
      S.updateRun(run, { status: "idle", phase: "idle" });
      if (!run.stopRequested) this.notify("Ajan Konseyi ✓", "Yanıt hazır");
    }
  }

  async quickReply(run, member, text, attachments) {
    const S = this.store;
    S.setPhase(run, "answering");
    const images = attachments.map((a) => a.path).filter((p) => fs.existsSync(p));
    const imageNote = images.length
      ? `\n\nEkli görseller (dosya yolundan incele):\n${images.map((p) => `- ${p}`).join("\n")}`
      : "";
    const prefixFor = (mem) => {
      if (this.providers[mem.provider].sessions.get(this.sessionKeyFor(run, mem))) return "";
      const history = run.messages.slice(-10, -1)
        .map((m) => `[${m.fromLabel || m.from}]: ${truncate(m.content, 800)}`).join("\n");
      return `Sen "${mem.name}" adlı konsey üyesisin (${mem.provider}${mem.role !== "auto" ? ", rolün: " + mem.role : ""}); çok üyeli bir yapay zekâ konsey sohbetine katılıyorsun. ` +
        `Türkçe ve düzgün Markdown ile yanıtla.` +
        (run.projectDir ? ` Bağlı proje: ${run.projectDir}` : "") +
        (history ? `\n\nSohbet geçmişi:\n${history}` : "") + "\n\n--- KULLANICININ MESAJI ---\n";
    };
    let res = await this.callMember(run, member, prefixFor(member) + text + imageNote, {
      label: "yanıtlıyor",
      images,
      cwd: run.projectDir || undefined,
      // Sohbette Antigravity'ye uzun süre takılı kalınmaz
      timeoutMs: member.provider === "antigravity" ? 4 * 60 * 1000 : undefined,
      shouldStop: () => run.stopRequested,
    });
    // Üye yanıt veremezse (zaman aşımı/hata) sohbet takılmasın: bir kez başka üye dener
    if (!res.ok && !run.stopRequested) {
      const alt = this.availableMembers().find((m) => m.id !== member.id && m.provider !== "antigravity");
      if (alt) {
        S.addMessage(run, { from: "sistem", kind: "info", content: `${member.name} yanıt veremedi (${truncate(res.error, 100)}); ${alt.name} devralıyor.` });
        member = alt;
        res = await this.callMember(run, member, prefixFor(member) + text + imageNote, {
          label: "yanıtlıyor", images, cwd: run.projectDir || undefined,
          shouldStop: () => run.stopRequested,
        });
      }
    }
    if (res.ok) {
      this.memberMsg(run, member, "message", res.text);
    } else if (!run.stopRequested) {
      throw new Error(`${member.name} yanıt veremedi: ${res.error}`);
    }
  }

  stopTurn(run) {
    run.stopRequested = true;
    for (const p of Object.values(this.providers)) p.stop(run.id);
    this.store.cancelApprovals(run.id);
    this.store.setPhase(run, "stopping");
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "⏹ Durduruldu — düzeltmenizi veya yeni talimatınızı yazabilirsiniz." });
  }

  // ================= KONSEY BORU HATTI =================
  async runPipeline(run, resume = false, chatTurn = false) {
    const S = this.store;
    const ctx = this.coordCtx(run);
    this.restoreSessions(run);

    if (!resume && !chatTurn) {
      const attachNote = run.attachments?.length
        ? "\n\n" + run.attachments.map((a) => `📎 ${a.url || a.path}`).join("\n")
        : "";
      S.addMessage(run, { from: "kullanici", kind: "message", content: run.request + attachNote });
    }

    const avail = this.availableMembers();
    if (!avail.length) throw new Error("Ulaşılabilir üye yok");
    if (this.members().some((m) => m.enabled && m.provider === "antigravity") &&
        !avail.some((m) => m.provider === "antigravity") && !resume && !chatTurn) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Antigravity köprüsü kapalı; görevler diğer üyelere dağıtılacak." });
    }

    // Üyeleri aynı kod sürümüne sabitle (konsey meta-bulgusu)
    if (run.projectDir && !run.commitHash) {
      run.commitHash = await gitops.currentCommit(run.projectDir);
    }

    // ---- 1. PLANLAMA ----
    if (!resume || run.tasks.length === 0) {
      S.setPhase(run, "planning");
      const plan = await this.coordinator.plan(run, this.memberListText(avail), {
        historyText: this.projectHistory(run),
        memoryText: this.projectContext.readMemory(run.projectId),
        repoMap: run.projectDir ? await this.projectContext.repoMap(run.projectDir) : "",
        testFirst: run.testFirst,
        attachmentsText: run.attachments?.length
          ? "Kullanıcı şu görselleri ekledi (görevlerde bu dosya yollarını ilgili üyelere ilet):\n" +
            run.attachments.map((a) => `- ${a.path}`).join("\n")
          : "",
      }, ctx);
      this.checkStop(run);
      if (run.mode === "auto") run.mode = plan.mode || "discussion";
      run.tasks = (plan.subtasks || []).map((t) => {
        const m = this.memberById(t.member_id) || avail[0];
        return {
          id: t.id, title: t.title, assignee: m.id, assigneeName: m.name,
          prompt: t.prompt, status: "pending", result: null,
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on : [],
          tier: ["fast", "balanced", "strong"].includes(t.model_tier) ? t.model_tier : "balanced",
        };
      });
      run.reviewRounds = Math.min(plan.review_rounds ?? 1, 2);
      S.addMessage(run, {
        from: "koordinator", kind: "message",
        content: `Analiz: ${plan.analysis}\n\nMod: ${run.mode}\nGörev dağılımı:\n` +
          run.tasks.map((t) => `- [${t.id}] ${t.title} → ${t.assigneeName} (${t.tier}${t.dependsOn.length ? ", bağımlı: " + t.dependsOn.join(",") : ""})`).join("\n"),
      });
      S.updateRun(run);
    }

    // ---- Kod modu: üye başına worktree ----
    const worktrees = {};
    if (run.mode === "code") {
      if (!run.projectDir) throw new Error("Kod modu için proje dizini gerekli. '📁 Proje seç' ile bir klasör bağlayın.");
      if (!(await gitops.isGitRepo(run.projectDir))) {
        this.notify("Ajan Konseyi ⚠", "Git deposu başlatma onayı bekleniyor");
        const ok = await S.requestApproval(run, {
          kind: "gitinit",
          title: "Git deposu başlatma onayı",
          detail: `${run.projectDir} bir git deposu değil. Onaylarsanız "git init" yapılıp mevcut dosyalar başlangıç commit'ine alınacak (dosyalarınız değişmez).`,
        });
        this.checkStop(run);
        if (!ok) throw new Error("Kod modu için git deposu gerekli; başlatma onayı verilmedi.");
        await gitops.initRepo(run.projectDir);
        S.addMessage(run, { from: "sistem", kind: "info", content: `✓ ${run.projectDir} içinde git deposu başlatıldı.` });
      }
      const involved = [...new Set(run.tasks.map((t) => t.assignee))]
        .map((id) => this.memberById(id)).filter((m) => m && m.provider !== "antigravity");
      for (const m of involved) {
        worktrees[m.id] = await gitops.createWorktree(run.projectDir, S.runsDir, run.id, m.id);
      }
      if (!resume && involved.length) S.addMessage(run, {
        from: "sistem", kind: "info",
        content: "Ayrı çalışma kopyaları hazır: " + involved.map((m) => `${m.name} → ajan/${run.id}/${m.id}`).join(", "),
      });
    }

    // ---- 2. DAĞITIM + boru hattı incelemesi ----
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
        await this.runTask(run, task, worktrees);
        if (task.status === "done" && this.availableMembers().length > 1 && (run.reviewRounds ?? 1) > 0) {
          const already = run.reviews.some((r) => r.taskId === task.id);
          if (!already) reviewPromises.push(this.reviewTask(run, task, worktrees));
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

    // ---- 3. ÇELİŞKİ / TARTIŞMA / OYLAMA ----
    let voteInfo = null;
    const activeMembers = [...new Set(doneTasks.map((t) => t.assignee))]
      .map((id) => this.memberById(id)).filter(Boolean);
    if (this.availableMembers().length > 1) {
      let round = 0;
      while (round < run.maxDebateRounds) {
        this.checkStop(run);
        const assess = await this.assessConflict(run, round + 1, ctx);
        S.addMessage(run, {
          from: "koordinator", kind: "message",
          content: (assess.conflict ? "Görüş ayrılığı tespit edildi: " : "Uzlaşma durumu: ") + assess.summary,
        });
        if (!assess.conflict) break;
        round++;
        if (round >= run.maxDebateRounds) {
          S.setPhase(run, "vote");
          voteInfo = await this.holdVote(run, assess);
          break;
        }
        S.setPhase(run, "debate");
        await this.debateRound(run, assess.debate_prompt, round);
      }
    }

    // ---- 4. DOĞRULAYICI TURU ----
    if (this.availableMembers().length > 1 && !run.stopRequested) {
      await this.verifyRound(run, worktrees);
    }

    // ---- 5. KOD BÜTÜNLEŞTİRME ----
    if (run.mode === "code") {
      await this.codeIntegration(run, worktrees);
    }

    // ---- 6. SENTEZ ----
    this.checkStop(run);
    S.setPhase(run, "synthesis");
    const fin = await this.coordinator.finalize(run, voteInfo, this.coordCtx(run));
    S.addDecision(run, { title: fin.decision, detail: "Nihai karar", rationale: fin.rationale });
    run.report = fin.report_markdown || fin.decision;
    fs.writeFileSync(path.join(S.runsDir, run.id, "report.md"), run.report);
    S.addMessage(run, { from: "koordinator", kind: "decision", content: `KARAR: ${fin.decision}\n\nGerekçe: ${fin.rationale}` });
    this.projectContext.appendMemory(run.projectId, run, fin.decision);
    if (!chatTurn) {
      S.updateRun(run, { status: "done", phase: "done" });
      this.notify("Ajan Konseyi ✓", "Koşu tamamlandı: " + truncate(run.request, 60));
    }
  }

  // ---- Tek alt görev ----
  async runTask(run, task, worktrees) {
    const S = this.store;
    let member = this.memberById(task.assignee);
    const avail = this.availableMembers();
    if (!member || !avail.some((m) => m.id === member.id)) {
      const fb = avail.find((m) => m.id !== task.assignee);
      if (!fb) { task.status = "failed"; return; }
      S.addMessage(run, { from: "sistem", kind: "info", taskId: task.id, content: `${task.assigneeName || task.assignee} ulaşılamaz; görev ${fb.name} üyesine devredildi.` });
      member = fb;
      task.assignee = fb.id;
      task.assigneeName = fb.name;
    }
    task.status = "active";
    task.startedAt = new Date().toISOString();
    S.updateRun(run);
    S.addMessage(run, { from: "koordinator", kind: "task", taskId: task.id, content: `[${member.name}] için görev: ${task.title}\n\n${task.prompt}` });

    const images = (run.attachments || []).map((a) => a.path).filter((p) => fs.existsSync(p));
    const agSleeping = member.provider === "antigravity" && this.antigravitySleeping();
    if (agSleeping) {
      this.notify("Ajan Konseyi 🔔", `${member.name} görev bekliyor — Antigravity'de ajana 'inbox'u kontrol et' deyin`);
    }
    const opts = {
      label: task.title,
      timeoutMs: agSleeping ? 5 * 60 * 1000 : undefined,
      codeMode: run.mode === "code",
      cwd: worktrees[member.id]?.wtDir || (run.mode !== "code" ? run.projectDir || undefined : undefined),
      tierModel: this.pickTierModel(member.provider, task.tier),
      images,
      shouldStop: () => run.stopRequested,
    };
    const imageNote = images.length
      ? `\n\nEkli görseller (dosya yolundan incele):\n${images.map((p) => `- ${p}`).join("\n")}\n`
      : "";
    let depContext = "";
    for (const depId of task.dependsOn || []) {
      const dep = run.tasks.find((t) => t.id === depId);
      if (dep?.status === "done" && dep.result) {
        depContext += `\n--- ÖNCEKİ GÖREVİN ÇIKTISI [${dep.id}: ${dep.title} / ${dep.assigneeName}] ---\n${truncate(dep.result, 6000)}\n`;
      }
    }
    const header = this.roleHeader(member, run) + depContext + imageNote;
    let res = await this.callMember(run, member, header + task.prompt, opts);

    if (!res.ok && !run.stopRequested) {
      S.addMessage(run, { from: "sistem", kind: "error", taskId: task.id, content: `${member.name} görevi tamamlayamadı: ${res.error}` });
      if (member.provider === "antigravity") {
        S.addMessage(run, {
          from: "koordinator", kind: "info", taskId: task.id,
          content: `⚠ ${member.name} (Antigravity) görüşü alınamadı — sentez bu görüş EKSİK olarak yapılacak. Köprüyü uyandırmak için Antigravity'de ajana "inbox'u kontrol et" deyin.`,
        });
      }
      const fb = this.availableMembers().find((m) => m.id !== member.id);
      if (fb) {
        S.addMessage(run, { from: "koordinator", kind: "info", taskId: task.id, content: `Görev ${fb.name} üyesine yeniden atandı.` });
        member = fb; task.assignee = fb.id; task.assigneeName = fb.name;
        res = await this.callMember(run, member, header + task.prompt, {
          ...opts, cwd: worktrees[fb.id]?.wtDir, tierModel: this.pickTierModel(fb.provider, task.tier),
        });
      }
    }

    task.endedAt = new Date().toISOString();
    if (res.ok) {
      task.status = "done";
      task.result = res.text;
      this.memberMsg(run, member, "result", res.text, task.id);
    } else {
      task.status = "failed";
      task.result = res.error;
      if (!run.stopRequested) {
        S.addMessage(run, { from: "sistem", kind: "error", taskId: task.id, content: `Görev başarısız: ${res.error}` });
      }
    }
    S.updateRun(run);
  }

  roleHeader(member, run) {
    const rolePart = member.role !== "auto" ? ` Konsey içindeki rolün: ${member.role}.` : "";
    const commitPart = run.commitHash
      ? ` Kod tabanı sürümü: commit ${run.commitHash} — kod hakkında iddia üretmeden önce dosyanın GÜNCEL halini oku ve iddialarına dosya:satır kanıtı ekle.`
      : "";
    return `Sen "${member.name}" adlı konsey üyesisin (sağlayıcı: ${member.provider}). Konseyde başka üyeler de var; koordinatör görevleri dağıtır.${rolePart}${commitPart} Yanıtlarını Türkçe ve düzgün Markdown biçiminde yaz (başlıklar, listeler, kod için \`\`\` blokları); gereksiz uzatma.\n\nKullanıcının ana isteği: "${truncate(run.request, 1200)}"\n\n--- SANA VERİLEN GÖREV ---\n`;
  }

  // ---- Puanlı çapraz inceleme ----
  async reviewTask(run, task, worktrees) {
    const S = this.store;
    const reviewers = this.availableMembers().filter((m) => m.id !== task.assignee);
    await Promise.all(reviewers.map(async (reviewer) => {
      const prompt = this.roleHeader(reviewer, run) +
        `"${task.assigneeName}" üyesinin şu çıktısını eleştirel incele:\n\n### ${task.title}\n${truncate(task.result, 6000)}\n\n` +
        `Değerlendirmeni YALNIZCA şu şemada tek bir JSON nesnesi olarak ver:\n` +
        `{"agreement": 1-5 arası tam sayı (5=tamamen katılıyorum), "severity": "dusuk|orta|yuksek", ` +
        `"points": ["somut eleştiri/iyileştirme maddeleri"], "evidence": ["varsa dosya:satır"], "suggestion": "tek cümlelik öneri"}`;
      const res = await this.callMember(run, reviewer, prompt, {
        label: `inceleme: ${task.id}`,
        cwd: worktrees?.[reviewer.id]?.wtDir,
        shouldStop: () => run.stopRequested,
      });
      if (!res.ok) {
        if (!run.stopRequested) S.addMessage(run, { from: "sistem", kind: "error", content: `${reviewer.name} incelemesi başarısız: ${res.error}` });
        return;
      }
      const j = extractJson(res.text) || { agreement: 3, severity: "orta", points: [res.text], suggestion: "" };
      run.reviews.push({
        taskId: task.id, reviewer: reviewer.id, reviewerName: reviewer.name,
        agreement: Math.min(5, Math.max(1, Number(j.agreement) || 3)),
        severity: j.severity || "orta",
        points: j.points || [],
      });
      this.memberMsg(run, reviewer, "review",
        `İnceleme [${task.id}] — katılım: ${j.agreement}/5, önem: ${j.severity}\n` +
        (j.points || []).map((p) => `• ${p}`).join("\n") +
        (j.evidence?.length ? `\nKanıt: ${j.evidence.join("; ")}` : "") +
        (j.suggestion ? `\nÖneri: ${j.suggestion}` : ""), task.id);
      S.updateRun(run);
    }));
  }

  async assessConflict(run, round, ctx) {
    const scores = run.reviews.map((r) => r.agreement);
    if (scores.length) {
      const min = Math.min(...scores);
      if (min <= 2) {
        const worst = run.reviews.filter((r) => r.agreement <= 2);
        return {
          conflict: true,
          summary: `Puanlı incelemelerde ciddi itiraz var (en düşük katılım: ${min}/5). ` +
            worst.map((r) => `${r.reviewerName}→[${r.taskId}]`).join(", "),
          debate_prompt: "Şu itirazlar çözülmeli: " + worst.flatMap((r) => r.points).slice(0, 6).join(" | "),
        };
      }
      if (scores.every((s) => s >= 4)) {
        return { conflict: false, summary: `Tüm incelemeler olumlu (katılım ${Math.min(...scores)}-${Math.max(...scores)}/5); uzlaşma var.`, debate_prompt: "" };
      }
    }
    return this.coordinator.assessConflict(run, round, ctx);
  }

  async debateRound(run, debatePrompt, round) {
    const S = this.store;
    await Promise.all(this.availableMembers().map(async (member) => {
      const recent = run.messages
        .filter((m) => ["review", "debate", "result"].includes(m.kind) && m.from !== member.id)
        .slice(-4)
        .map((m) => `[${m.fromLabel || m.from}]: ${truncate(m.content, 3000)}`)
        .join("\n\n");
      const prompt = this.roleHeader(member, run) +
        `TARTIŞMA TURU ${round}. Koordinatörün sorusu: ${debatePrompt}\n\n` +
        `Diğer üyelerin son görüşleri:\n${recent}\n\n` +
        `Kendi görüşünü savun veya ikna olduysan güncelle. Uzlaşıya katkı sağlayacak somut bir öneriyle bitir.`;
      const res = await this.callMember(run, member, prompt, {
        label: `tartışma (tur ${round})`,
        shouldStop: () => run.stopRequested,
      });
      if (res.ok) {
        this.memberMsg(run, member, "debate", `Tartışma (tur ${round}):\n${res.text}`);
      }
    }));
  }

  async holdVote(run, assess) {
    const S = this.store;
    S.addMessage(run, { from: "koordinator", kind: "info", content: "Tartışma tur sınırına ulaşıldı; rubrikli oylamaya geçiliyor." });
    const positions = run.tasks.filter((t) => t.status === "done")
      .map((t) => `- "${t.assigneeName}" (${t.assignee}) yaklaşımı: ${truncate(t.result, 2000)}`).join("\n");
    const votes = [];
    await Promise.all(this.availableMembers().map(async (member) => {
      const prompt = this.roleHeader(member, run) +
        `OYLAMA. Anlaşmazlık: ${assess.summary}\n\nYaklaşımlar:\n${positions}\n\n` +
        `Bir üyeye (id ile) veya "karma"ya oy ver. YALNIZCA şu şemada tek bir JSON nesnesi döndür:\n` +
        `{"choice": "üye id'si veya karma", "scores": {"dogruluk": 1-5, "eksiksizlik": 1-5, "risk": 1-5}, "reason": "teknik gerekçe (Türkçe)"}`;
      const res = await this.callMember(run, member, prompt, { label: "oylama", shouldStop: () => run.stopRequested });
      if (res.ok) {
        const v = extractJson(res.text) || { choice: "?", reason: res.text };
        const choiceName = this.memberById(v.choice)?.name || v.choice;
        votes.push({ agent: member.name, choice: choiceName, scores: v.scores || null, reason: v.reason });
        this.memberMsg(run, member, "vote",
          `OY: ${choiceName}` +
          (v.scores ? ` (doğruluk ${v.scores.dogruluk}/5, eksiksizlik ${v.scores.eksiksizlik}/5, risk ${v.scores.risk}/5)` : "") +
          `\nGerekçe: ${v.reason}`);
      }
    }));
    run.votes = votes;
    this.store.updateRun(run);
    const tally = {};
    for (const v of votes) tally[v.choice] = (tally[v.choice] || 0) + 1;
    return { votes, tally };
  }

  async verifyRound(run, worktrees) {
    const S = this.store;
    this.checkStop(run);
    S.setPhase(run, "verify");
    const avail = this.availableMembers();
    let verifier = avail.find((m) => m.role === "denetci");
    if (!verifier) {
      const counts = Object.fromEntries(avail.map((m) => [m.id, run.tasks.filter((t) => t.assignee === m.id).length]));
      verifier = [...avail].sort((a, b) => counts[a.id] - counts[b.id])[0];
    }
    if (!verifier) return;
    const solution = run.tasks.filter((t) => t.status === "done")
      .map((t) => `### [${t.id}] ${t.title} (${t.assigneeName})\n${truncate(t.result, 4000)}`).join("\n\n");
    const prompt = this.roleHeader(verifier, run) +
      `DOĞRULAYICI TURU. Konseyin ürettiği çözüm aşağıda. Görevin bu çözümü ÇÜRÜTMEYE çalışmak: ` +
      `hatalar, kenar durumlar, güvenlik açıkları, yanlış varsayımlar, eksikler ara.\n\n${solution}\n\n` +
      `YALNIZCA şu şemada tek bir JSON nesnesi döndür:\n` +
      `{"verdict": "saglam|riskli|curutuldu", "issues": ["bulunan somut sorunlar"], "summary": "tek cümlelik özet"}`;
    const res = await this.callMember(run, verifier, prompt, {
      label: "doğrulama", cwd: worktrees?.[verifier.id]?.wtDir, shouldStop: () => run.stopRequested,
    });
    if (!res.ok) return;
    const v = extractJson(res.text) || { verdict: "riskli", issues: [res.text], summary: "" };
    run.verify = { verifier: verifier.name, verdict: v.verdict, issues: v.issues || [], summary: v.summary || "" };
    this.memberMsg(run, verifier, "review",
      `🔎 DOĞRULAMA: ${v.verdict === "saglam" ? "✓ sağlam" : v.verdict}\n${v.summary}\n` +
      (v.issues || []).map((i) => `• ${i}`).join("\n"));
    S.updateRun(run);

    if (v.verdict !== "saglam" && v.issues?.length && !run.stopRequested) {
      const counts = {};
      for (const t of run.tasks) counts[t.assignee] = (counts[t.assignee] || 0) + 1;
      const authorId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      const author = this.availableMembers().find((m) => m.id === authorId);
      if (author) {
        const fixPrompt = this.roleHeader(author, run) +
          `Doğrulayıcı (${verifier.name}) çözümde şu sorunları buldu:\n` +
          v.issues.map((i) => `• ${i}`).join("\n") +
          `\n\nBu sorunları gider: düzeltilmiş/iyileştirilmiş halini üret.` +
          (run.mode === "code" ? " Kod değişikliği gerekiyorsa kendi çalışma kopyanda uygula ve ne değiştirdiğini özetle." : "");
        const fix = await this.callMember(run, author, fixPrompt, {
          label: "düzeltme", codeMode: run.mode === "code",
          cwd: worktrees?.[author.id]?.wtDir, shouldStop: () => run.stopRequested,
        });
        if (fix.ok) {
          this.memberMsg(run, author, "result", `Düzeltme (doğrulama sonrası):\n${fix.text}`);
          const mainTask = run.tasks.filter((t) => t.assignee === author.id && t.status === "done").pop();
          if (mainTask) mainTask.result += `\n\n--- DÜZELTME ---\n${truncate(fix.text, 4000)}`;
          S.updateRun(run);
        }
      }
    }
  }

  // ---- Kod bütünleştirme ----
  async codeIntegration(run, worktrees) {
    const S = this.store;
    S.setPhase(run, "integration");
    const diffs = [];
    for (const [memberId, wt] of Object.entries(worktrees)) {
      const member = this.memberById(memberId);
      const { status, diff } = await gitops.collectDiff(wt.wtDir);
      if (!status) continue;
      diffs.push({ memberId, memberName: member?.name || memberId, branch: wt.branch, diff });
      for (const line of status.split("\n")) {
        const m = line.trim().match(/^(\S+)\s+(.+)$/);
        if (m) run.files.push({ agent: member?.name || memberId, path: m[2], change: m[1] });
      }
      await gitops.commitAll(wt.wtDir, `ajan(${member?.name || memberId}): ${truncate(run.request, 60)}`);
    }
    run.diffs = diffs.map((d) => ({ agent: d.memberName, branch: d.branch, diff: truncate(d.diff, 60000) }));
    S.updateRun(run);
    if (diffs.length === 0) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Hiçbir üye dosya değişikliği yapmadı; birleştirme adımı atlandı." });
      return;
    }

    const plan = await this.coordinator.mergePlan(run, diffs, this.coordCtx(run));
    S.addMessage(run, {
      from: "koordinator", kind: "message",
      content: `Birleştirme planı: ${plan.summary}\nSıra: ${(plan.merge_order || []).map((id) => this.memberById(id)?.name || id).join(" → ")}` +
        (plan.conflicts?.length ? `\n\n⚠ Çakışmalar (elle inceleme gerekli):\n- ${plan.conflicts.join("\n- ")}` : "") +
        (plan.risks?.length ? `\nRiskler:\n- ${plan.risks.join("\n- ")}` : ""),
    });

    this.notify("Ajan Konseyi ⚠", "Birleştirme onayı bekleniyor");
    const approved = await S.requestApproval(run, {
      kind: "merge",
      title: "Dalları birleştirme onayı",
      detail: `Şu dallar "ajan/${run.id}/integration" dalında birleştirilecek:\n` +
        diffs.map((d) => `- ${d.branch} (${d.memberName})`).join("\n") +
        (plan.conflicts?.length ? "\n\n⚠ Koordinatör olası çakışmalar bildirdi; çakışan birleştirmeler otomatik yapılmaz." : ""),
    });
    this.checkStop(run);
    let merged = false;
    if (!approved) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Birleştirme reddedildi. Değişiklikler kendi dallarında duruyor; diff'ler Dosyalar sekmesinde." });
    } else {
      const order = (plan.merge_order || []).filter((id) => diffs.some((d) => d.memberId === id));
      const finalOrder = order.length ? order : diffs.map((d) => d.memberId);
      for (const memberId of finalOrder) {
        const d = diffs.find((x) => x.memberId === memberId);
        const result = await gitops.mergeBranch(run.projectDir, S.runsDir, run.id, d.branch);
        if (result.ok) {
          merged = true;
          S.addMessage(run, { from: "sistem", kind: "info", content: `✓ ${d.branch} birleştirildi.` });
        } else {
          S.addMessage(run, {
            from: "sistem", kind: "error",
            content: `✗ ${d.branch} birleştirilemedi (çakışma): ${result.conflicts.join(", ") || result.error}. Elle inceleme gerekli.`,
          });
        }
      }
    }

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
        if (!testResult.ok && merged && !run.stopRequested) {
          S.addMessage(run, { from: "koordinator", kind: "info", content: "Testler kırıldı; otomatik düzeltme turu (kırmızı-yeşil)." });
          const fixerId = diffs.sort((a, b) => b.diff.length - a.diff.length)[0]?.memberId;
          const fixer = this.availableMembers().find((m) => m.id === fixerId);
          if (fixer) {
            const fixPrompt = this.roleHeader(fixer, run) +
              `Birleştirme sonrası testler KIRILDI. Test çıktısı:\n\n${truncate(testResult.output, 6000)}\n\n` +
              `Bu dizinde çalışıyorsun: ${testDir}\nTestleri geçirecek asgari düzeltmeyi uygula ve ne değiştirdiğini özetle.`;
            const fix = await this.callMember(run, fixer, fixPrompt, {
              label: "test düzeltme", codeMode: true, cwd: testDir, shouldStop: () => run.stopRequested,
            });
            if (fix.ok) {
              this.memberMsg(run, fixer, "result", `Test düzeltmesi:\n${fix.text}`);
              await gitops.commitAll(testDir, `ajan(${fixer.name}): test düzeltmesi`).catch(() => {});
              await this.runTests(run, testDir);
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

  async directMessage(run, memberId, content, attachments = []) {
    const S = this.store;
    const member = this.memberById(memberId);
    if (!member) throw new Error("Bilinmeyen üye: " + memberId);
    this.restoreSessions(run);
    const images = attachments.map((a) => a.path).filter((p) => fs.existsSync(p));
    const attachNote = attachments.length ? "\n" + attachments.map((a) => `📎 ${a.url || a.path}`).join("\n") : "";
    S.addMessage(run, { from: "kullanici", kind: "message", content: `@${member.name}: ${content}${attachNote}` });
    const imageNote = images.length ? `\n\nEkli görseller (dosya yolundan incele):\n${images.map((p) => `- ${p}`).join("\n")}` : "";
    const res = await this.callMember(run, member,
      `Kullanıcıdan sana doğrudan bir mesaj geldi (konsey sohbeti bağlamında, Türkçe ve Markdown ile yanıtla):\n\n${content}${imageNote}`,
      { label: "doğrudan mesaj", images });
    if (res.ok) {
      this.memberMsg(run, member, "message", res.text);
    } else {
      S.addMessage(run, { from: "sistem", kind: "error", content: `${member.name} yanıt veremedi: ${res.error}` });
    }
    this.persistSessions(run);
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
    for (const p of Object.values(this.providers)) p.stop(run.id);
    this.store.cancelApprovals(run.id);
    this.store.updateRun(run, { status: "stopped", phase: "stopped" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kullanıcı tarafından durduruldu." });
  }
}
