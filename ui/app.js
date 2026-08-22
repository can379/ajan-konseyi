// ========== Ajan Konseyi ön yüzü v3 ==========
let state = {
  agents: {}, approvals: [], runs: {},
  config: { agents: {}, projects: [], activeProject: null },
  roles: {}, models: {}, efforts: [], health: {}, home: "",
};
let selectedRun = null;
let refreshTimer = null;
let currentMode = "auto";
let popAgent = null;      // üst çubukta açık ajan paneli
let liveStreams = {};     // agent -> {label, text} canlı akış

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const AGENT_META = {
  claude: { label: "Claude Code", short: "C" },
  codex: { label: "Codex", short: "X" },
  antigravity: { label: "Antigravity", short: "A" },
  koordinator: { label: "Koordinatör", short: "K" },
  kullanici: { label: "Siz", short: "S" },
  sistem: { label: "Sistem", short: "•" },
};
const STATUS_TR = { idle: "hazır", busy: "çalışıyor", error: "hata", offline: "çevrimdışı" };
const PHASE_TR = {
  planning: "Planlama", dispatch: "Görev dağıtımı", review: "Çapraz inceleme",
  debate: "Tartışma", vote: "Oylama", integration: "Kod birleştirme",
  testing: "Test", synthesis: "Sentez", done: "Tamamlandı", stopped: "Durduruldu",
  running: "Çalışıyor", failed: "Hata",
};
const KIND_TR = {
  message: "mesaj", task: "görev", result: "sonuç", review: "inceleme",
  debate: "tartışma", vote: "oy", decision: "karar", error: "hata", info: "bilgi",
};

function md(s) {
  let t = esc(s);
  t = t.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => `<pre class="code">${c.replace(/\n$/, "")}</pre>`);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return t;
}

async function fetchState() {
  const r = await fetch("/api/state");
  state = await r.json();
  if (selectedRun && !state.runs[selectedRun]) selectedRun = null;
  render();
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; fetchState(); }, 350);
}
function connectSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let ev = null;
    try { ev = JSON.parse(e.data); } catch {}
    if (ev?.type === "stream") {
      // Canlı akış: tam durum yenilemeden yalnız akış bloğunu güncelle
      liveStreams[ev.agent] = { label: ev.label, text: ev.text };
      renderLive();
      return;
    }
    if (ev?.type === "agent_status" && ev.status !== "busy") {
      delete liveStreams[ev.agent];
      renderLive();
    }
    scheduleRefresh();
  };
  es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
}

// Canlı akış blokları: çalışan ajanların o anki kısmi çıktısı
function renderLive() {
  const busyAgents = Object.keys(liveStreams).filter((a) => state.agents[a]?.status === "busy");
  const ws = $("workspace");
  const stick = ws.scrollTop + ws.clientHeight >= ws.scrollHeight - 120;
  $("live").innerHTML = busyAgents.map((a) => {
    const s = liveStreams[a];
    return `<div class="live-block">
      <div class="lb-head">
        <span class="c-${a}">${AGENT_META[a]?.label || a}</span>
        <span class="muted">${esc(s.label || "")}</span>
        <span class="lb-live">CANLI</span>
      </div>${esc(s.text)}</div>`;
  }).join("");
  if (stick && busyAgents.length) ws.scrollTop = ws.scrollHeight;
}

function activeProjectId() { return state.config.activeProject; }
function activeProject() { return state.config.projects.find((p) => p.id === activeProjectId()) || null; }

// ================= RENDER =================
function render() {
  renderProjects();
  renderRunList();
  renderAgentConfig();
  renderTopbar();
  renderAgentPop();
  renderHealth();
  const run = selectedRun ? state.runs[selectedRun] : null;
  renderChat(run);
  renderLive();
  renderDetails(run);
  renderToasts();
  syncToggles();
}

function renderHealth() {
  const problems = Object.entries(state.health || {})
    .filter(([name, h]) => !h.ok && state.config.agents[name]?.enabled && name !== "antigravity");
  const banner = $("health-banner");
  banner.hidden = problems.length === 0;
  banner.innerHTML = problems
    .map(([name, h]) => `<b>${AGENT_META[name]?.label || name}:</b> ${esc(h.detail)}`)
    .join(" · ");
}

function syncToggles() {
  if (document.activeElement?.closest?.("#advanced-row")) return;
  $("f-smart").checked = !!state.config.smartModels;
  $("f-notify").checked = !!state.config.notifications;
}

function renderProjects() {
  const list = state.config.projects;
  $("project-list").innerHTML = list.length
    ? list.map((p) => `
      <div class="project-item ${p.id === activeProjectId() ? "active" : ""}" data-proj="${p.id}">
        <span class="p-ico">📁</span>
        <span class="p-info">
          <div class="p-name">${esc(p.name)}</div>
          <div class="p-path">${esc(p.path)}</div>
        </span>
        <button class="p-del" data-del-proj="${p.id}" title="Projeyi listeden kaldır">✕</button>
      </div>`).join("")
    : `<div class="muted">Proje ekleyin; koşular projeye bağlanır ve konsey kaldığı yerden devam eder.</div>`;
}

function renderRunList() {
  const pid = activeProjectId();
  const ids = Object.keys(state.runs)
    .filter((id) => !pid || state.runs[id].projectId === pid)
    .sort((a, b) => state.runs[b].createdAt.localeCompare(state.runs[a].createdAt));
  $("run-list").innerHTML = ids.length
    ? ids.map((id) => {
        const r = state.runs[id];
        return `<div class="run-item ${id === selectedRun ? "selected" : ""}" data-run="${id}">
          <div class="r-title">${esc(r.request)}</div>
          <div class="r-meta">
            <span class="status-dot ${r.status}"></span>
            ${r.status === "running" ? esc(PHASE_TR[r.phase] || r.phase) : esc(PHASE_TR[r.status] || r.status)}
            · ${new Date(r.createdAt).toLocaleDateString("tr")} ${new Date(r.createdAt).toLocaleTimeString("tr", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>`;
      }).join("")
    : `<div class="muted">${pid ? "Bu projede henüz koşu yok." : "Henüz koşu yok."}</div>`;
}

// Ajan ayar kartı — kenar çubuğu ve üst çubuk paneli aynı bileşeni kullanır
function agentCardHTML(name) {
  const cfg = state.config.agents[name] || {};
  const st = state.agents[name] || { status: "offline" };
  const meta = AGENT_META[name];
  const catalog = state.models[name] || [];
  const inCatalog = catalog.some((m) => m.value === (cfg.model || ""));
  const modelOpts =
    catalog.map((m) => `<option value="${esc(m.value)}" ${(cfg.model || "") === m.value ? "selected" : ""}>${esc(m.label)}</option>`).join("") +
    (!inCatalog && cfg.model ? `<option value="${esc(cfg.model)}" selected>${esc(cfg.model)} (özel)</option>` : "") +
    `<option value="__custom">Özel model yaz…</option>`;
  const roleOpts = Object.entries(state.roles)
    .map(([k, v]) => `<option value="${k}" ${cfg.role === k ? "selected" : ""}>${esc(v.split(" — ")[0])}</option>`)
    .join("");
  const parallelField = name === "antigravity"
    ? ""
    : `<div class="a-field"><label>Paralel kopya</label>
         <select data-parallel="${name}">
           ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${(cfg.parallel || 1) === n ? "selected" : ""}>${n} kopya</option>`).join("")}
         </select>
       </div>`;
  return `
    <div class="agent-card ${cfg.enabled ? "" : "disabled"}" data-agent="${name}">
      <div class="a-head">
        <span class="a-dot ${st.status}" title="${esc(st.detail || "")}"></span>
        <span class="a-name c-${name}">${meta.label}</span>
        <span class="a-status">${STATUS_TR[st.status] || st.status}${st.detail ? " · " + esc(st.detail) : ""}</span>
        <label class="switch">
          <input type="checkbox" data-enable="${name}" ${cfg.enabled ? "checked" : ""}>
          <span class="track"></span>
        </label>
      </div>
      <div class="a-field"><label>Model</label>
        <select data-model="${name}">${modelOpts}</select>
      </div>
      <div class="a-field"><label>Çaba</label>
        <select data-effort="${name}">
          ${(state.efforts || []).map((ef) => `<option value="${ef.value}" ${(cfg.effort || "") === ef.value ? "selected" : ""}>${esc(ef.label)}</option>`).join("")}
        </select>
      </div>
      <div class="a-row2">
        <div class="a-field"><label>Rol</label>
          <select data-role="${name}">${roleOpts}</select>
        </div>
        ${parallelField}
      </div>
      ${name === "antigravity" ? `<div class="a-note">Köprü üzerinden çalışır; model tercihi göreve not düşülür.</div>` : ""}
    </div>`;
}

function renderAgentConfig() {
  const box = $("agent-config");
  if (box.contains(document.activeElement)) return;
  box.innerHTML = ["claude", "codex", "antigravity"].map((n) => agentCardHTML(n)).join("");
}

function renderTopbar() {
  const proj = activeProject();
  const pill = $("tb-project");
  pill.textContent = proj ? `📁 ${proj.name}` : "Proje seçilmedi";
  pill.classList.toggle("has-project", !!proj);
  pill.title = proj?.path || "";

  const run = selectedRun ? state.runs[selectedRun] : null;
  $("tb-phase").innerHTML = run
    ? `<span class="phase ${run.status}">${run.status === "running" ? esc(PHASE_TR[run.phase] || run.phase) : esc(PHASE_TR[run.status] || run.status)}</span>`
    : "";
  $("btn-resume").hidden = !(run && ["interrupted", "stopped", "failed"].includes(run.status));

  $("tb-agents").innerHTML = ["claude", "codex", "antigravity", "koordinator"].map((name) => {
    const st = state.agents[name] || { status: "offline" };
    return `<span class="mini-agent bg-${name} st-${st.status}" data-agent-pop="${name}"
      title="${AGENT_META[name].label}: ${STATUS_TR[st.status] || st.status}${st.detail ? " — " + esc(st.detail) : ""} · ayarlar için tıkla">${AGENT_META[name].short}</span>`;
  }).join("");

  const chip = $("btn-project");
  chip.textContent = proj ? `📁 ${proj.name} ▾` : "📁 Proje seç ▾";
  chip.classList.toggle("has-project", !!proj);
}

// Avatar tıklanınca açılan hızlı ayar paneli
function renderAgentPop() {
  const pop = $("agent-pop");
  if (!popAgent) { pop.hidden = true; return; }
  if (pop.contains(document.activeElement)) return;
  pop.hidden = false;
  if (popAgent === "koordinator") {
    const st = state.agents.koordinator || { status: "offline" };
    pop.innerHTML = `
      <div class="a-head" style="display:flex;align-items:center;gap:8px">
        <span class="a-dot ${st.status}"></span>
        <span class="a-name c-koordinator">Koordinatör</span>
        <span class="a-status">${STATUS_TR[st.status] || st.status}</span>
      </div>
      <div class="a-note" style="margin-top:8px;font-size:11.5px;color:var(--dim)">
        Görevleri analiz eder, böler, dağıtır; tartışmaları yönetir ve nihai raporu yazar.
        Claude Code oturumu üzerinde çalışır.
      </div>`;
    return;
  }
  pop.innerHTML = agentCardHTML(popAgent) + `
    <div class="pop-actions">
      <button class="btn-ghost small" data-dm-agent="${popAgent}">✉ Bu ajana yaz</button>
      <button class="btn-ghost small" data-pop-close>Kapat</button>
    </div>`;
}

function renderChat(run) {
  const hasMsgs = run && run.messages.length;
  $("empty-state").hidden = !!hasMsgs;
  const el = $("chat");
  const ws = $("workspace");
  const stick = ws.scrollTop + ws.clientHeight >= ws.scrollHeight - 80;

  el.innerHTML = hasMsgs
    ? run.messages.map((m) => {
        if (m.kind === "task") {
          const firstLine = m.content.split("\n")[0];
          const rest = m.content.slice(firstLine.length).trim();
          return `<details class="task-msg">
            <summary>📋 ${esc(firstLine)}</summary>
            <div class="task-prompt">${md(rest)}</div>
          </details>`;
        }
        const meta = AGENT_META[m.from] || { label: m.from, short: "?" };
        return `<div class="msg from-${esc(m.from)} kind-${esc(m.kind)}">
          <div class="avatar bg-${esc(m.from)}">${esc(meta.short)}</div>
          <div class="m-body">
            <div class="m-head">
              <span class="m-name c-${esc(m.from)}">${esc(meta.label)}</span>
              <span class="m-kind">${esc(KIND_TR[m.kind] || m.kind)}</span>
              <span class="m-time">${new Date(m.ts).toLocaleTimeString("tr", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div class="m-content">${md(m.content)}</div>
          </div>
        </div>`;
      }).join("")
    : "";

  const busy = Object.entries(state.agents)
    .filter(([, st]) => st.status === "busy")
    .map(([n, st]) => `${AGENT_META[n]?.label || n}${st.detail ? ` (${st.detail})` : ""}`);
  const typing = $("typing");
  if (run?.status === "running" && busy.length) {
    typing.hidden = false;
    typing.innerHTML = `<span class="dots">${esc(busy.join(", "))} çalışıyor</span>`;
  } else {
    typing.hidden = true;
  }
  if (stick) ws.scrollTop = ws.scrollHeight;
}

function renderDetails(run) {
  // Görevler + zaman çizelgesi
  let tasksHtml = `<div class="muted">Görev listesi koşu başlayınca oluşur.</div>`;
  if (run?.tasks?.length) {
    const t0 = Math.min(...run.tasks.filter((t) => t.startedAt).map((t) => +new Date(t.startedAt)), +new Date(run.createdAt));
    const t1 = Math.max(...run.tasks.filter((t) => t.endedAt).map((t) => +new Date(t.endedAt)), t0 + 1);
    const span = t1 - t0;
    tasksHtml = run.tasks.map((t) => {
      let bar = "", dur = "";
      if (t.startedAt) {
        const s = +new Date(t.startedAt);
        const e = t.endedAt ? +new Date(t.endedAt) : Date.now();
        const left = Math.max(0, ((s - t0) / span) * 100);
        const width = Math.max(2, ((e - s) / span) * 100);
        bar = `<div class="t-bar-wrap"><div class="t-bar" style="left:${left.toFixed(1)}%;width:${Math.min(width, 100 - left).toFixed(1)}%"></div></div>`;
        dur = `<div class="t-dur">${Math.round((e - s) / 1000)} sn${t.tier ? " · " + t.tier : ""}</div>`;
      }
      return `
        <div class="task-row ${t.status}">
          <div>${esc(t.title)}</div>
          <div class="t-who">${AGENT_META[t.assignee]?.label || t.assignee} · ${t.status}${t.dependsOn?.length ? " · bağımlı: " + t.dependsOn.join(",") : ""}</div>
          ${bar}${dur}
        </div>`;
    }).join("");
  }
  $("tab-tasks").innerHTML = tasksHtml;

  $("tab-outputs").innerHTML = run
    ? ["claude", "codex", "antigravity", "koordinator"].map((a) => {
        const msgs = run.messages.filter((m) => m.from === a && m.kind !== "task");
        if (!msgs.length) return "";
        return `<h3 class="c-${a}">${AGENT_META[a].label}</h3>` +
          msgs.slice(-5).map((m) => `<pre>${esc(m.content)}</pre>`).join("");
      }).join("") || `<div class="muted">Henüz çıktı yok.</div>`
    : `<div class="muted">—</div>`;

  // Kararlar + doğrulama + puanlı incelemeler + oylar
  const verifyBadge = run?.verify
    ? `<div><span class="verify-badge ${esc(run.verify.verdict)}">🔎 Doğrulama: ${esc(run.verify.verdict)} (${esc(run.verify.verifier)})</span></div>` +
      (run.verify.issues?.length ? `<pre>${esc(run.verify.issues.map((i) => "• " + i).join("\n"))}</pre>` : "")
    : "";
  const reviewsHtml = run?.reviews?.length
    ? `<h3>Puanlı incelemeler</h3>` + run.reviews.map((r) =>
        `<pre><b>${esc(r.reviewer)}</b> → [${esc(r.taskId)}] katılım ${r.agreement}/5 · önem: ${esc(r.severity)}\n${esc((r.points || []).slice(0, 3).map((p) => "• " + p).join("\n"))}</pre>`).join("")
    : "";
  $("tab-decisions").innerHTML = run
    ? ((verifyBadge +
        run.decisions.map((d) => `<h3>⚖ ${esc(d.title)}</h3><pre>${esc(d.rationale || d.detail || "")}</pre>`).join("") +
        reviewsHtml +
        (run.votes?.length ? `<h3>Oylar</h3>` + run.votes.map((v) =>
          `<pre><b>${esc(v.agent)}</b> → ${esc(v.choice)}${v.scores ? ` (doğruluk ${v.scores.dogruluk}, eksiksizlik ${v.scores.eksiksizlik}, risk ${v.scores.risk})` : ""}\n${esc(v.reason)}</pre>`).join("") : "")) ||
       `<div class="muted">Henüz karar yok.</div>`)
    : `<div class="muted">—</div>`;

  // Dosyalar: renkli diff görüntüleyici + geri alma
  let filesHtml = `<div class="muted">Değiştirilen dosya yok.</div>`;
  if (run?.files?.length || run?.diffs?.length) {
    filesHtml = (run.files || []).map((f) => `<div class="file-line"><b>[${esc(f.agent)}]</b> ${esc(f.change)} ${esc(f.path)}</div>`).join("");
    for (const d of run.diffs || []) {
      filesHtml += `<div class="diff-agent-head c-${esc(d.agent)}">${AGENT_META[d.agent]?.label || d.agent} — ${esc(d.branch)}</div>` + renderDiff(d.diff);
    }
    if (run.mode === "code" && (run.diffs || []).length) {
      filesHtml += `<div style="margin-top:10px"><button class="btn-ghost small" data-rollback="${run.id}">↩ Geri al — bu koşunun dallarını sil</button></div>`;
    }
  }
  $("tab-files").innerHTML = filesHtml;

  $("tab-tests").innerHTML = run?.tests?.length
    ? run.tests.map((t) => `<h3>${t.ok ? "✓" : "✗"} ${esc(t.command)}</h3><pre>${esc(t.output)}</pre>`).join("")
    : `<div class="muted">Test çalıştırılmadı.</div>`;

  // Kullanım panosu
  const usage = run?.usage || {};
  const names = Object.keys(usage);
  if (names.length) {
    let totIn = 0, totOut = 0, totCost = 0;
    const cards = names.map((n) => {
      const u = usage[n];
      totIn += u.input + u.cachedInput; totOut += u.output; totCost += u.costUsd || 0;
      return `<div class="usage-card">
        <div class="u-name c-${esc(n)}">${AGENT_META[n]?.label || n}</div>
        <div class="usage-row"><span>Çağrı</span><b>${u.calls}</b></div>
        <div class="usage-row"><span>Girdi token</span><b>${(u.input || 0).toLocaleString("tr")}</b></div>
        <div class="usage-row"><span>Önbellekten</span><b>${(u.cachedInput || 0).toLocaleString("tr")}</b></div>
        <div class="usage-row"><span>Çıktı token</span><b>${(u.output || 0).toLocaleString("tr")}</b></div>
      </div>`;
    }).join("");
    $("tab-usage").innerHTML = cards +
      `<div class="usage-card"><div class="usage-total"><span>Toplam</span><span>${totIn.toLocaleString("tr")} girdi · ${totOut.toLocaleString("tr")} çıktı</span></div>
       <div class="muted" style="margin-top:4px">Abonelik oturumları kullanılır; API faturası oluşmaz. Tüketim, aboneliğin mesaj/kota limitlerinden düşer.</div></div>`;
  } else {
    $("tab-usage").innerHTML = `<div class="muted">Kullanım verisi koşu sırasında birikir.</div>`;
  }

  $("tab-report").innerHTML = run?.report
    ? `<div class="m-content" style="white-space:pre-wrap">${md(run.report)}</div>`
    : `<div class="muted">Rapor, koşu tamamlanınca burada görünür.</div>`;
}

// Birleşik diff metnini dosya bazlı, renkli bloklara çevir
function renderDiff(diffText) {
  if (!diffText) return "";
  const files = diffText.split(/^diff --git /m).filter(Boolean);
  return files.map((chunk) => {
    const firstLine = chunk.split("\n")[0];
    const nameMatch = firstLine.match(/b\/(.+)$/);
    const fname = nameMatch ? nameMatch[1] : firstLine.slice(0, 60);
    const adds = (chunk.match(/^\+[^+]/gm) || []).length;
    const dels = (chunk.match(/^-[^-]/gm) || []).length;
    const body = chunk.split("\n").slice(1, 400).map((l) => {
      const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "";
      return `<div class="dl ${cls}">${esc(l) || " "}</div>`;
    }).join("");
    return `<details class="diff-file"><summary>${esc(fname)} <span class="muted">+${adds} −${dels}</span></summary><div class="diff-body">${body}</div></details>`;
  }).join("");
}

function renderToasts() {
  const pending = state.approvals.filter((a) => a.status === "pending");
  $("toasts").innerHTML = pending.map((a) => `
    <div class="toast">
      <div class="t-title">${esc(a.title)}</div>
      <pre>${esc(a.detail)}</pre>
      <div class="t-btns">
        <button class="approve" data-ap="${a.id}" data-d="approve">✓ Onayla</button>
        <button class="reject" data-ap="${a.id}" data-d="reject">✗ Reddet</button>
      </div>
    </div>`).join("");
}

// ================= MODALLAR =================
function openModal(html) {
  $("modal-card").innerHTML = html;
  $("modal-overlay").hidden = false;
}
function closeModal() { $("modal-overlay").hidden = true; }

function openProjectMenu() {
  const list = state.config.projects.map((p) => `
    <button class="m-item" data-pick-project="${p.id}">
      📁 <span style="flex:1;min-width:0">
        <div>${esc(p.name)} ${p.id === activeProjectId() ? "✓" : ""}</div>
        <small>${esc(p.path)}</small>
      </span>
    </button>`).join("");
  openModal(`
    <h2>Ortak geliştirilecek proje</h2>
    <div class="m-sub">Seçilen proje koşulara bağlanır; konsey önceki çalışmaları görerek kaldığı yerden devam eder.</div>
    <div class="m-list">${list || `<div class="muted">Henüz kayıtlı proje yok.</div>`}</div>
    <div class="m-foot">
      ${activeProjectId() ? `<button class="btn-ghost small" data-clear-project>Bağlantıyı kaldır</button>` : ""}
      <button class="btn-ghost small" data-open-picker>📂 Klasörden seç</button>
      <button class="btn-gradient small" data-open-create>＋ Yeni proje</button>
    </div>`);
}

function openCreateProject() {
  openModal(`
    <h2>Yeni proje oluştur</h2>
    <div class="m-sub">Klasör oluşturulur ve içinde git deposu başlatılır.</div>
    <input id="np-name" placeholder="Proje adı (örn: notlar-cli)">
    <input id="np-parent" value="${esc(state.home)}/Desktop" placeholder="Üst klasör">
    <div class="m-foot">
      <button class="btn-ghost small" data-modal-close>Vazgeç</button>
      <button class="btn-gradient small" data-create-project>Oluştur ve başlat</button>
    </div>`);
  $("np-name").focus();
}

async function openFolderPicker(startPath) {
  const r = await fetch("/api/fs?path=" + encodeURIComponent(startPath || state.home + "/Desktop"));
  const j = await r.json();
  if (j.error) return alert(j.error);
  openModal(`
    <h2>Klasör seç</h2>
    <div class="m-path">${esc(j.path)}</div>
    <div class="m-list">
      ${j.parent ? `<button class="m-item" data-fs-dir="${esc(j.parent)}">⬆️ <span>Üst klasör</span></button>` : ""}
      ${j.dirs.map((d) => `
        <button class="m-item" data-fs-dir="${esc(d.path)}">
          📁 <span style="flex:1">${esc(d.name)}</span>
          ${d.git ? `<span class="git-badge">GIT</span>` : ""}
        </button>`).join("") || `<div class="muted">Alt klasör yok.</div>`}
    </div>
    <div class="m-foot">
      <button class="btn-ghost small" data-modal-close>Vazgeç</button>
      <button class="btn-gradient small" data-fs-select="${esc(j.path)}">Bu klasörü proje yap</button>
    </div>`);
}

// ================= EYLEMLER (olay delegasyonu) =================
document.addEventListener("click", async (e) => {
  const t = e.target;
  const closest = (sel) => t.closest(sel);

  // koşu seç
  const runEl = closest("[data-run]");
  if (runEl) { selectedRun = runEl.dataset.run; autoCloseSidebar(); render(); return; }

  // proje seç / kaldır (kenar çubuğu)
  const delProj = closest("[data-del-proj]");
  if (delProj) {
    if (confirm("Proje listeden kaldırılsın mı? (Dizin silinmez)")) {
      await fetch("/api/projects/" + delProj.dataset.delProj, { method: "DELETE" });
      fetchState();
    }
    return;
  }
  const projEl = closest("[data-proj]");
  if (projEl) {
    const id = projEl.dataset.proj === activeProjectId() ? null : projEl.dataset.proj;
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeProject: id }) });
    fetchState();
    return;
  }

  // onaylar
  const ap = closest("[data-ap]");
  if (ap) {
    fetch(`/api/approvals/${ap.dataset.ap}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: ap.dataset.d }),
    });
    return;
  }

  // üst çubuk ajan paneli
  const avatar = closest("[data-agent-pop]");
  if (avatar) {
    popAgent = popAgent === avatar.dataset.agentPop ? null : avatar.dataset.agentPop;
    renderAgentPop();
    return;
  }
  if (closest("[data-pop-close]")) { popAgent = null; renderAgentPop(); return; }
  const dm = closest("[data-dm-agent]");
  if (dm) {
    $("f-target").value = dm.dataset.dmAgent;
    popAgent = null; renderAgentPop();
    $("f-request").focus();
    return;
  }
  // panel dışına tıklanınca kapat
  if (popAgent && !closest("#agent-pop") && !closest("[data-agent-pop]")) {
    popAgent = null; renderAgentPop();
  }

  // modallar
  if (closest("[data-modal-close]")) { closeModal(); return; }
  if (t.id === "modal-overlay") { closeModal(); return; }
  const pickProj = closest("[data-pick-project]");
  if (pickProj) {
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeProject: pickProj.dataset.pickProject }) });
    closeModal(); fetchState();
    return;
  }
  if (closest("[data-clear-project]")) {
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeProject: null }) });
    closeModal(); fetchState();
    return;
  }
  if (closest("[data-open-create]")) { openCreateProject(); return; }
  if (closest("[data-open-picker]")) { openFolderPicker(); return; }
  const fsDir = closest("[data-fs-dir]");
  if (fsDir) { openFolderPicker(fsDir.dataset.fsDir); return; }
  const fsSel = closest("[data-fs-select]");
  if (fsSel) {
    const r = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fsSel.dataset.fsSelect }),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    closeModal(); fetchState();
    return;
  }
  if (closest("[data-create-project]")) {
    const r = await fetch("/api/projects/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("np-name").value, parent: $("np-parent").value }),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    closeModal(); fetchState();
    return;
  }

  // öneri kartları
  const sug = closest(".suggestion");
  if (sug) { $("f-request").value = sug.dataset.fill; $("f-request").focus(); autoGrow(); return; }

  // şablon seçimi
  const tpl = closest("[data-template]");
  if (tpl) {
    const t = TEMPLATES[Number(tpl.dataset.template)];
    if (t) {
      $("f-request").value = t.text;
      if (t.mode) {
        currentMode = t.mode;
        document.querySelectorAll("#mode-seg button").forEach((x) => x.classList.toggle("active", x.dataset.mode === t.mode));
      }
      closeModal(); $("f-request").focus(); autoGrow();
    }
    return;
  }

  // geri alma
  const rb = closest("[data-rollback]");
  if (rb) {
    if (!confirm("Bu koşunun tüm ajan dalları ve integration dalı SİLİNECEK. Proje ana dalınız etkilenmez. Devam edilsin mi?")) return;
    const r = await fetch(`/api/runs/${rb.dataset.rollback}/rollback`, { method: "POST" });
    const j = await r.json();
    if (j.error) alert(j.error);
    fetchState();
    return;
  }
});

// Hazır görev şablonları (playbook'lar)
const TEMPLATES = [
  { name: "🛡 Güvenlik denetimi", mode: "split", text: "Bu projede kapsamlı bir güvenlik denetimi yapın: girdi doğrulama, kimlik doğrulama/yetkilendirme, gizli bilgi sızıntıları, bağımlılık riskleri ve enjeksiyon açıklarını tarayın. Her bulguyu önem derecesi ve dosya:satır kanıtıyla raporlayın; en kritik 3 açık için düzeltme önerisi verin." },
  { name: "🔧 Refactor", mode: "code", text: "Bu projede en çok iyileştirme gerektiren modülü belirleyip refactor edin: okunabilirlik, tekrar eden kod, isimlendirme ve fonksiyon boyutları. Davranışı DEĞİŞTİRMEYİN; mevcut testler geçmeye devam etmeli. Değişiklikleri küçük ve gerekçeli tutun." },
  { name: "🐛 Hata avı", mode: "split", text: "Bu projede olası hataları avlayın: sınır durumları, null/undefined erişimleri, yarış koşulları, hata yönetimi eksikleri. Her ajan farklı bir alandan taransın. Bulguları önem sırasına göre, tetikleme senaryosuyla birlikte raporlayın." },
  { name: "⚡ Performans", mode: "split", text: "Bu projenin performans analizini yapın: gereksiz döngüler, N+1 sorgular, bellek sızıntısı riskleri, büyük paket boyutu, gereksiz yeniden hesaplama. En etkili 5 iyileştirmeyi maliyet/kazanç değerlendirmesiyle önerin." },
  { name: "📝 Kod inceleme", mode: "discussion", text: "Bu projedeki son değişiklikleri (git log ve diff'lere bakarak) kod inceleme gözüyle değerlendirin: doğruluk, tasarım, test kapsamı, kenar durumlar. Onaylanabilir mi, değişiklik mi istenmeli? Gerekçeli görüş bildirin." },
  { name: "📚 Dokümantasyon", mode: "code", text: "Bu projenin eksik dokümantasyonunu tamamlayın: README'yi güncelleyin, kurulum/kullanım adımlarını netleştirin, karmaşık fonksiyonlara açıklama ekleyin. Kod davranışını değiştirmeyin." },
];

function openTemplates() {
  openModal(`
    <h2>Görev şablonları</h2>
    <div class="m-sub">Hazır playbook seçin; metni düzenleyip gönderebilirsiniz.</div>
    <div class="m-list">
      ${TEMPLATES.map((t, i) => `<button class="m-item" data-template="${i}">${t.name.split(" ")[0]} <span style="flex:1"><div>${esc(t.name.slice(t.name.indexOf(" ") + 1))}</div><small>${esc(t.text.slice(0, 80))}…</small></span></button>`).join("")}
    </div>
    <div class="m-foot"><button class="btn-ghost small" data-modal-close>Kapat</button></div>`);
}

// Ajan ayarları değişince kaydet (kenar çubuğu + üst panel ortak)
document.addEventListener("change", async (e) => {
  const t = e.target;
  const card = t.closest(".agent-card[data-agent]");
  if (!card) return;
  const name = card.dataset.agent;

  // "Özel model yaz…" seçilirse metin iste
  if (t.matches("[data-model]") && t.value === "__custom") {
    const custom = prompt(`${AGENT_META[name].label} için model kimliği:`);
    if (custom === null) { render(); return; }
    t.value = custom.trim();
  }

  const cfg = state.config.agents[name] || {};
  const agents = {};
  agents[name] = {
    enabled: card.querySelector("[data-enable]")?.checked ?? cfg.enabled,
    model: card.querySelector("[data-model]")?.value ?? cfg.model ?? "",
    role: card.querySelector("[data-role]")?.value ?? cfg.role ?? "auto",
    parallel: Number(card.querySelector("[data-parallel]")?.value ?? cfg.parallel ?? 1),
    effort: card.querySelector("[data-effort]")?.value ?? cfg.effort ?? "",
  };
  await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agents }) });
  fetchState();
});

// sabit düğmeler
$("btn-sidebar").addEventListener("click", () => $("sidebar").classList.toggle("hidden"));
$("btn-side-close").addEventListener("click", () => $("sidebar").classList.add("hidden"));
function autoCloseSidebar() { if (window.innerWidth < 1100) $("sidebar").classList.add("hidden"); }
$("btn-new").addEventListener("click", () => { selectedRun = null; autoCloseSidebar(); render(); $("f-request").focus(); });
$("btn-details").addEventListener("click", () => $("details").classList.toggle("closed"));
$("btn-project").addEventListener("click", openProjectMenu);
$("btn-create-project").addEventListener("click", openCreateProject);
$("btn-pick-folder").addEventListener("click", () => openFolderPicker());
$("btn-templates").addEventListener("click", openTemplates);
$("btn-resume").addEventListener("click", async () => {
  if (!selectedRun) return;
  const r = await fetch(`/api/runs/${selectedRun}/resume`, { method: "POST" });
  const j = await r.json();
  if (j.error) alert(j.error);
  fetchState();
});
$("f-smart").addEventListener("change", () =>
  fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ smartModels: $("f-smart").checked }) })
);
$("f-notify").addEventListener("change", () =>
  fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notifications: $("f-notify").checked }) })
);

document.querySelectorAll("#mode-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    currentMode = b.dataset.mode;
    document.querySelectorAll("#mode-seg button").forEach((x) => x.classList.toggle("active", x === b));
  })
);
$("btn-advanced").addEventListener("click", () => {
  const row = $("advanced-row");
  row.hidden = !row.hidden;
  $("btn-advanced").textContent = row.hidden ? "Gelişmiş ▾" : "Gelişmiş ▴";
});

$("btn-stop").addEventListener("click", () => {
  const run = selectedRun ? state.runs[selectedRun] : null;
  if (!run || run.status !== "running") return alert("Çalışan bir koşu seçili değil.");
  if (confirm("Aktif koşu durdurulsun mu?")) fetch(`/api/runs/${selectedRun}/stop`, { method: "POST" });
});

const ta = $("f-request");
function autoGrow() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 180) + "px"; }
ta.addEventListener("input", autoGrow);
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
$("btn-send").addEventListener("click", send);

async function send() {
  const text = ta.value.trim();
  if (!text) return;
  const target = $("f-target").value;

  if (target === "konsey") {
    if (currentMode === "code" && !activeProjectId())
      return alert("Kod modu için önce bir proje seçin (📁 Proje seç).");
    const body = {
      request: text,
      mode: currentMode,
      projectId: activeProjectId(),
      testCommand: $("f-test").value,
      maxDebateRounds: $("f-rounds").value,
      testFirst: $("f-testfirst").checked,
    };
    const r = await fetch("/api/runs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    selectedRun = j.runId;
  } else {
    if (!selectedRun) return alert("Doğrudan mesaj için önce bir koşu seçin.");
    fetch(`/api/runs/${selectedRun}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: target, content: text }),
    });
  }
  ta.value = ""; autoGrow();
  fetchState();
}

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab-body").forEach((body) => (body.hidden = body.id !== "tab-" + b.dataset.tab));
  })
);

// Dar ekranda kenar çubuğu varsayılan gizli: çalışma alanı ferah kalsın
if (window.innerWidth < 1100) $("sidebar").classList.add("hidden");

connectSSE();
fetchState();
setInterval(fetchState, 15000);
