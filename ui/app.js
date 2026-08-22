// ========== Ajan Konseyi ön yüzü v3 ==========
let state = {
  agents: {}, approvals: [], runs: {},
  config: { agents: {}, projects: [], activeProject: null },
  roles: {}, models: {}, efforts: [], health: {}, home: "", capabilities: {},
};
let selectedRun = null;
let refreshTimer = null;
let currentMode = "auto";
let popAgent = null;      // üst çubukta açık ajan paneli
let liveStreams = {};     // agent -> {label, text} canlı akış
let fullCapabilities = null;
const projectRunLimits = new Map();

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
const PROVIDERS = ["claude", "codex", "antigravity"];
const PROVIDER_LABELS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

function memberById(id) {
  return (state.config.members || []).find((m) => m.id === id) || null;
}

// Mesaj/akış sahibini çözümle: üye, sağlayıcı veya sabit kimlik
function metaFor(fromId, msg = null) {
  if (AGENT_META[fromId]) return { label: AGENT_META[fromId].label, short: AGENT_META[fromId].short, cls: fromId };
  const mem = memberById(fromId);
  const provider = msg?.provider || mem?.provider || "sistem";
  const label = msg?.fromLabel || mem?.name || fromId;
  return { label, short: (label[0] || "?").toUpperCase(), cls: provider };
}
const STATUS_TR = { idle: "hazır", busy: "çalışıyor", error: "hata", offline: "çevrimdışı" };
const PHASE_TR = {
  planning: "Planlama", dispatch: "Görev dağıtımı", review: "Çapraz inceleme",
  debate: "Tartışma", vote: "Oylama", integration: "Kod birleştirme",
  testing: "Test", synthesis: "Sentez", done: "Tamamlandı", stopped: "Durduruldu",
  running: "Çalışıyor", failed: "Hata", interrupted: "Kesildi",
  thinking: "Düşünüyor", answering: "Yanıtlıyor", verify: "Doğrulama", idle: "Hazır",
  stopping: "Durduruluyor",
};
const KIND_TR = {
  message: "mesaj", task: "görev", result: "sonuç", review: "inceleme",
  debate: "tartışma", vote: "oy", decision: "karar", error: "hata", info: "bilgi",
};

// Zengin Markdown motoru — Claude/ChatGPT uygulamalarındaki görünüme yakın:
// başlıklar, listeler, alıntılar, tablolar, bağlantılar, kopyalanabilir kod blokları.
function md(src) {
  const blocks = [];
  let t = String(src ?? "");
  // 1) Kod bloklarını ayır (içerikleri işlenmesin)
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, "") });
    return "AJAN_CODE_BLOCK_" + (blocks.length - 1) + "_PLACEHOLDER";
  });
  t = esc(t);
  // 2) Satır içi öğeler
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/gm, "$1<i>$2</i>");
  t = t.replace(/!\[([^\]]*)\]\((\/uploads\/[^)\s]+)\)/g, '<img class="chat-img" src="$2" alt="$1" data-media-src="$2">');
  t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img class="chat-img" src="$2" alt="$1" data-media-src="$2">');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/📎 (\/uploads\/\S+)/g, '<img class="chat-img" src="$1" alt="görsel" data-media-src="$1" data-media-name="görsel">');
  // 3) Blok düzeyi: satır satır işle
  const lines = t.split("\n");
  let html = "", para = [], list = null, quote = [], i = 0;
  const flushPara = () => { if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((x) => `<li>${x}</li>`).join("")}</${list.tag}>`; list = null; } };
  const flushQuote = () => { if (quote.length) { html += `<blockquote>${quote.join("<br>")}</blockquote>`; quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    let m;
    if (!trimmed) { flushAll(); i++; continue; }
    if ((m = trimmed.match(/^(#{1,4})\s+(.+)$/))) {
      flushAll();
      const lvl = Math.min(m[1].length + 2, 5);
      html += `<h${lvl}>${m[2]}</h${lvl}>`;
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); html += "<hr>"; i++; continue; }
    if ((m = trimmed.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); i++; continue; }
    if ((m = trimmed.match(/^([-•*])\s+(.+)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
      list.items.push(m[2]); i++; continue;
    }
    if ((m = trimmed.match(/^(\d+)[.)]\s+(.+)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
      list.items.push(m[2]); i++; continue;
    }
    // Tablo: | a | b | ve ikinci satır |---|---|
    if (trimmed.startsWith("|") && lines[i + 1] && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      flushAll();
      const rows = [];
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headCells = parseRow(trimmed);
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(parseRow(lines[i])); i++; }
      html += `<div class="tbl-wrap"><table><thead><tr>${headCells.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      continue;
    }
    if (/^AJAN_CODE_BLOCK_\d+_PLACEHOLDER$/.test(trimmed)) { flushAll(); html += trimmed; i++; continue; }
    para.push(trimmed); i++;
  }
  flushAll();
  // 4) Kod bloklarını geri koy (başlık çubuğu + kopyala düğmesi ile)
  html = html.replace(/AJAN_CODE_BLOCK_(\d+)_PLACEHOLDER/g, (_, n) => {
    const b = blocks[Number(n)];
    if (!b) return _;
    return `<div class="codeblock"><div class="cb-head"><span>${esc(b.lang || "kod")}</span><button class="cb-copy" title="Kopyala">⧉ Kopyala</button></div><pre>${esc(b.code)}</pre></div>`;
  });
  return html;
}

// Seçili sohbeti kalıcı tut: sayfa yenilense bile aynı sohbete dönülür,
// sunucudaki çalışma zaten hiç durmaz — kaldığı yerden izlemeye devam edilir.
function selectRun(id) {
  selectedRun = id;
  try {
    if (id) localStorage.setItem("ajan.selectedRun", id);
    else localStorage.removeItem("ajan.selectedRun");
  } catch {}
}

async function fetchState() {
  const requestedRun = selectedRun;
  const r = await fetch("/api/state" + (requestedRun ? `?run=${encodeURIComponent(requestedRun)}` : ""));
  state = await r.json();
  if (selectedRun && !state.runs[selectedRun]) selectedRun = null;
  if (!selectedRun) {
    // Önce kayıtlı seçim, yoksa ÇALIŞAN en yeni koşu (aktif iş asla kaybolmasın)
    let saved = null;
    try { saved = localStorage.getItem("ajan.selectedRun"); } catch {}
    if (saved && state.runs[saved]) {
      selectedRun = saved;
    } else {
      const running = Object.values(state.runs)
        .filter((r2) => r2.status === "running")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (running) selectRun(running.id);
    }
  }
  if (selectedRun && requestedRun !== selectedRun) return fetchState();
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
      liveStreams[ev.agent] = { label: ev.label, text: ev.text, startedAt:liveStreams[ev.agent]?.startedAt || Date.now() };
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

// Canlı yazım: ajanın yanıtı, sohbetin sonunda büyüyen bir mesaj balonu olarak akar
function renderLive() {
  const run = selectedRun ? state.runs[selectedRun] : null;
  if (!run || run.status !== "running") { $("live").innerHTML = ""; return; }
  const busyAgents = Object.keys(liveStreams).filter((a) => state.agents[a]?.status === "busy");
  const ws = $("workspace");
  const stick = ws.scrollTop + ws.clientHeight >= ws.scrollHeight - 150;
  const recentUserMessages=(run.messages||[]).filter((m)=>m.from==="kullanici").slice(-4);
  const lastUser=recentUserMessages.at(-1)?.content || run.request || "";
  const recentUserText=recentUserMessages.map((m)=>m.content||"").join("\n");
  const previousGeneratedImage=(run.messages||[]).some((m)=>(m.attachments||[]).some((a)=>a.kind==="image"&&a.generated));
  const imageGeneration=Object.values(liveStreams).some((s)=>/görsel (?:üretiyor|hazırlanıyor)/i.test(s.label||"")) ||
    /(?:görsel|fotoğraf|resim|image|illustration|poster|logo|ikon).{0,100}(?:oluştur|üret|çiz|tasarla|generate|create)|(?:oluştur|üret|çiz|tasarla).{0,100}(?:görsel|fotoğraf|resim|image)/i.test(recentUserText) ||
    (previousGeneratedImage&&/(?:gerçekçi|fotogerçekçi|fotoğraf gibi|daha doğal|yeniden|tekrar|düzelt|değiştir|benzer|bunun neresi|antigravit)/i.test(lastUser));
  const referenceImage=[...(run.messages||[])].reverse().flatMap((m)=>m.attachments||[]).find((a)=>a.kind==="image")?.url || "";
  $("live").innerHTML = busyAgents.map((a) => {
    const s = liveStreams[a];
    const meta = metaFor(a);
    if(imageGeneration) return `<div class="msg live-msg image-live from-${esc(meta.cls)}">
      <div class="avatar bg-${esc(meta.cls)}">${esc(meta.short)}</div>
      <div class="m-body"><div class="m-head"><span class="m-name c-${esc(meta.cls)}">${esc(meta.label)}</span><span class="lb-live">görsel üretiyor…</span></div>
      <div class="generation-preview" aria-label="Görsel oluşturuluyor">${referenceImage ? `<img class="generation-source" src="${esc(referenceImage)}" alt="Referans görsel işleniyor">` : `<div class="generation-clouds"></div>`}<div class="generation-noise"></div><div class="generation-scan"></div><div class="generation-mark">✦</div></div>
      <div class="generation-status"><span>Görsel katmanları oluşturuluyor</span><div><i></i></div><small>Önizleme aşamalı olarak netleşecek</small></div></div>
    </div>`;
    return `<div class="msg live-msg from-${esc(meta.cls)}">
      <div class="avatar bg-${esc(meta.cls)}">${esc(meta.short)}</div>
      <div class="m-body">
        <div class="m-head">
          <span class="m-name c-${esc(meta.cls)}">${esc(meta.label)}</span>
          <span class="lb-live">yazıyor${s.label ? " · " + esc(s.label) : ""}…</span>
        </div>
        <div class="m-content live-content">${esc(s.text)}<span class="caret">▌</span></div>
      </div>
    </div>`;
  }).join("");
  if (stick) ws.scrollTop = ws.scrollHeight;
}

function activeProjectId() { return state.config.activeProject; }
function activeProject() { return state.config.projects.find((p) => p.id === activeProjectId()) || null; }

// ================= RENDER =================
function render() {
  renderProjects();
  renderAgentConfig();
  renderTopbar();
  renderAgentPop();
  renderHealth();
  renderCapabilities();
  const run = selectedRun ? state.runs[selectedRun] : null;
  renderChat(run);
  renderMessageQueue(run);
  renderLive();
  renderDetails(run);
  renderToasts();
  syncToggles();
  const toolProject = $("tool-project");
  if (toolProject) toolProject.textContent = activeProject()?.name || "Proje seçilmedi";
}

function renderCapabilities() {
  const el=$("capability-summary"); if(!el) return;
  if(!fullCapabilities) { el.textContent="Yetenekler taranıyor…"; return; }
  const labels={
    text:"Metin",context:"Sohbet bağlamı",files:"Dosyalar",resume:"Kaldığı yerden devam",
    terminal:"Terminal",web:"Web araştırması",browser:"Tarayıcı",git:"Git",github:"GitHub",computerControl:"Bilgisayar kontrolü",
    imageRead:"Görsel okuma",imageGenerate:"Görsel üretme",imageEdit:"Görsel düzenleme",pdf:"PDF",document:"Belgeler",spreadsheet:"Tablolar",presentation:"Sunumlar",audioTranscription:"Ses yazıya çevirme",videoAnalysis:"Video analizi",videoGenerate:"Video üretme",
    mcp:"MCP araçları",skills:"Yetenek paketleri",plugins:"Eklentiler",subagents:"Alt ajanlar",automation:"Otomasyonlar"
  };
  const statusLabel={working:"Hazır",shared:"Ortak motor",partial:"Kısmi",missing:"Yok",disabled:"Kapalı","needs-session":"Oturum gerekli","account-required":"Hesap gerekli","configured-none":"Kurulmamış"};
  const groups=[
    ["Temel",["text","context","files","resume"]],
    ["Çalışma araçları",["terminal","web","browser","git","computerControl"]],
    ["Görsel ve belgeler",["imageRead","imageGenerate","imageEdit","pdf","document","spreadsheet","presentation","audioTranscription","videoAnalysis","videoGenerate"]],
    ["Genişletmeler",["mcp","skills","plugins","subagents","automation","github"]],
  ];
  const providers=Object.entries(fullCapabilities.providers||{}).map(([id,p])=>{
    const active=Object.entries(p.native||{});
    const connected=(p.mcp||[]).filter((x)=>!/no mcp|none configured/i.test(x)).length;
    const plugins=(p.plugins||[]).filter((x)=>!/no imported|no plugins/i.test(x)).length;
    const ready=active.filter(([,s])=>s==="working"||s==="shared").length;
    const attention=active.length-ready;
    const sections=groups.map(([title,names])=>{
      const items=names.map((name)=>[name,p.native?.[name]]).filter(([,status])=>status);
      if(!items.length) return "";
      return `<section class="cap-group"><h5>${title}</h5><div>${items.map(([name,status])=>`<span class="cap-item cap-${esc(status)}"><i></i><b>${esc(labels[name]||name)}</b><small>${esc(statusLabel[status]||status)}</small></span>`).join("")}</div></section>`;
    }).join("");
    return `<details class="cap-provider" ${id==="claude"?"open":""}><summary><span class="cap-agent-dot bg-${id}">${esc(AGENT_META[id]?.short||id[0])}</span><span class="cap-agent-title"><b class="c-${id}">${esc(AGENT_META[id]?.label||id)}</b><small>${esc(p.version)}</small></span><span class="cap-count"><b>${ready}</b> hazır${attention?`<small>${attention} sınırlı</small>`:""}</span><span class="cap-chevron">›</span></summary><div class="cap-provider-body">${sections}<div class="cap-runtime"><span>MCP <b>${connected}</b></span><span>Eklenti <b>${plugins}</b></span></div></div></details>`;
  }).join("");
  const connectors=Object.values(fullCapabilities.connectors||{}).map((item)=>{
    const states=Object.entries(item.providers||{}).map(([provider,value])=>
      `<span class="connector-${esc(value.status)}" title="${esc(PROVIDER_LABELS[provider]||provider)} · ${esc(value.mode)}"><i class="bg-${provider}"></i>${esc(PROVIDER_LABELS[provider]||provider)}<small>${value.status==="connected"?"Doğrudan":"Köprü"}</small></span>`
    ).join("");
    return `<div class="connector-row"><b>${esc(item.label)}</b><div>${states}</div></div>`;
  }).join("");
  el.innerHTML=`<div class="cap-intro"><b>Ajan yetenekleri</b><span>Bir ajana tıklayarak ayrıntıları açın.</span></div>${providers}`+(connectors?`<div class="connector-catalog"><div class="connector-head"><b>Bağlı hesaplar</b><span>Doğrudan veya güvenli Codex köprüsü üzerinden</span></div>${connectors}</div>`:"");
}

async function fetchCapabilities() {
  try { const r=await fetch("/api/capabilities"); fullCapabilities=await r.json(); renderCapabilities(); } catch {}
}

function renderHealth() {
  const usedProviders = new Set((state.config.members || []).filter((m) => m.enabled).map((m) => m.provider));
  const problems = Object.entries(state.health || {})
    .filter(([name, h]) => !h.ok && usedProviders.has(name));
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
  const sortedRunIds = Object.keys(state.runs)
    .sort((a, b) => state.runs[b].createdAt.localeCompare(state.runs[a].createdAt));
  const runHTML = (id) => {
    const r=state.runs[id];
    return `<div class="run-item ${id === selectedRun ? "selected" : ""}" data-run="${id}" title="${esc(r.title || r.request)}">
      <div class="r-title">${esc(r.title || r.request)}</div>
      <div class="r-meta"><span class="status-dot ${r.status === "idle" ? "done" : r.status}"></span>${r.status === "running" ? esc(PHASE_TR[r.phase] || r.phase) : esc(PHASE_TR[r.status] || r.status)}</div>
    </div>`;
  };
  const projectHTML = (p) => {
    const ids=sortedRunIds.filter((id)=>state.runs[id].projectId===p.id);
    const limit=projectRunLimits.get(p.id)||5;
    const selectedBelongs=selectedRun&&state.runs[selectedRun]?.projectId===p.id;
    return `<div class="project-group ${selectedBelongs?"has-selected":""}">
      <div class="project-item ${p.id === activeProjectId() ? "active" : ""}" data-proj="${p.id}">
        <span class="p-ico">▱</span>
        <span class="p-info"><div class="p-name">${esc(p.name)}</div><div class="p-path">${esc(p.path)}</div></span>
        <button class="p-del" data-del-proj="${p.id}" title="Projeyi listeden kaldır">✕</button>
      </div>
      <div class="project-runs">${ids.slice(0,limit).map(runHTML).join("")}
        ${ids.length>limit?`<button class="project-more" data-more-project="${p.id}">Daha fazla göster <span>${ids.length-limit}</span></button>`:""}
      </div>
    </div>`;
  };
  const unassigned=sortedRunIds.filter((id)=>!state.runs[id].projectId);
  $("project-list").innerHTML = list.length
    ? list.map(projectHTML).join("")+(unassigned.length?`<div class="project-group unassigned"><div class="project-label">Diğer sohbetler</div><div class="project-runs">${unassigned.slice(0,projectRunLimits.get("unassigned")||5).map(runHTML).join("")}${unassigned.length>(projectRunLimits.get("unassigned")||5)?`<button class="project-more" data-more-project="unassigned">Daha fazla göster <span>${unassigned.length-(projectRunLimits.get("unassigned")||5)}</span></button>`:""}</div></div>`:"")
    : `<div class="muted">Proje ekleyin; koşular projeye bağlanır ve konsey kaldığı yerden devam eder.</div>`;
}

// ---- Üye kartları: kullanıcı istediği kadar üye ekler (3 Codex mimar vb.) ----
function modelOptsFor(provider, current) {
  const catalog = state.models[provider] || [];
  const inCatalog = catalog.some((m) => m.value === (current || ""));
  return catalog.map((m) => `<option value="${esc(m.value)}" ${(current || "") === m.value ? "selected" : ""}>${esc(m.label)}</option>`).join("") +
    (!inCatalog && current ? `<option value="${esc(current)}" selected>${esc(current)} (özel)</option>` : "") +
    `<option value="__custom">Özel model yaz…</option>`;
}

function effortOptsFor(current) {
  return (state.efforts || []).map((ef) => `<option value="${ef.value}" ${(current || "") === ef.value ? "selected" : ""}>${esc(ef.label)}</option>`).join("");
}

function memberCardHTML(m) {
  const st = state.agents[m.id] || state.agents[m.provider] || { status: "idle" };
  const provSt = state.agents[m.provider] || { status: "idle" };
  const dotStatus = st.status === "busy" ? "busy" : provSt.status;
  const roleOpts = Object.entries(state.roles)
    .map(([k, v]) => `<option value="${k}" ${m.role === k ? "selected" : ""}>${esc(v.split(" — ")[0])}</option>`)
    .join("");
  const provOpts = PROVIDERS
    .map((p) => `<option value="${p}" ${m.provider === p ? "selected" : ""}>${PROVIDER_LABELS[p]}</option>`)
    .join("");
  return `
    <div class="agent-card ${m.enabled ? "" : "disabled"}" data-member="${esc(m.id)}">
      <div class="a-head">
        <span class="a-dot ${dotStatus}" title="${esc(provSt.detail || "")}"></span>
        <input type="text" class="a-name-input c-${m.provider}" data-mname value="${esc(m.name)}" title="Üye adı">
        <label class="switch">
          <input type="checkbox" data-menable ${m.enabled ? "checked" : ""}>
          <span class="track"></span>
        </label>
        <button class="p-del" data-mdel title="Üyeyi sil">✕</button>
      </div>
      <div class="a-row2">
        <div class="a-field"><label>Sağlayıcı</label>
          <select data-mprovider>${provOpts}</select>
        </div>
        <div class="a-field"><label>Rol</label>
          <select data-mrole>${roleOpts}</select>
        </div>
      </div>
      <div class="a-field"><label>Model</label>
        <select data-mmodel>${modelOptsFor(m.provider, m.model)}</select>
      </div>
      <div class="a-field"><label>Çaba</label>
        <select data-meffort>${effortOptsFor(m.effort)}</select>
      </div>
    </div>`;
}

function coordinatorCardHTML() {
  const c = state.config.coordinator || { provider: "claude" };
  const st = state.agents.koordinator || { status: "idle" };
  return `
    <div class="agent-card coord-card" data-coord>
      <div class="a-head">
        <span class="a-dot ${st.status}"></span>
        <span class="a-name c-koordinator">👑 Koordinatör</span>
        <span class="a-status">${STATUS_TR[st.status] || st.status}</span>
      </div>
      <div class="a-field"><label>Hangi yapay zekâ yönetsin?</label>
        <select data-cprovider>
          ${PROVIDERS.map((p) => `<option value="${p}" ${c.provider === p ? "selected" : ""}>${PROVIDER_LABELS[p]}</option>`).join("")}
        </select>
      </div>
      <div class="a-row2">
        <div class="a-field"><label>Model</label>
          <select data-cmodel>${modelOptsFor(c.provider, c.model)}</select>
        </div>
        <div class="a-field"><label>Çaba</label>
          <select data-ceffort>${effortOptsFor(c.effort)}</select>
        </div>
      </div>
    </div>`;
}

function renderAgentConfig() {
  const box = $("agent-config");
  if (box.contains(document.activeElement)) return;
  box.innerHTML =
    coordinatorCardHTML() +
    (state.config.members || []).map(memberCardHTML).join("") +
    `<button id="btn-add-member" class="btn-ghost small" style="width:100%">＋ Üye Ekle</button>`;
}

// Kartlardan yapılandırmayı topla ve kaydet
async function saveMembers(mutate) {
  const members = [];
  document.querySelectorAll("#agent-config [data-member]").forEach((card) => {
    members.push({
      id: card.dataset.member,
      name: card.querySelector("[data-mname]").value.trim() || "Üye",
      provider: card.querySelector("[data-mprovider]").value,
      role: card.querySelector("[data-mrole]").value,
      model: card.querySelector("[data-mmodel]").value,
      effort: card.querySelector("[data-meffort]").value,
      enabled: card.querySelector("[data-menable]").checked,
    });
  });
  const coordCard = document.querySelector("#agent-config [data-coord]");
  const coordinator = coordCard ? {
    provider: coordCard.querySelector("[data-cprovider]").value,
    model: coordCard.querySelector("[data-cmodel]").value,
    effort: coordCard.querySelector("[data-ceffort]").value,
  } : state.config.coordinator;
  if (mutate) mutate(members);
  await fetch("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ members, coordinator }),
  });
  fetchState();
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
  $("btn-resume").hidden = !(run && run.kind !== "chat" && ["interrupted", "stopped", "failed"].includes(run.status));

  // Codex davranışı: çalışırken kutu boşsa durdur; metin varsa sıraya gönder.
  const busy = run && run.status === "running";
  const sendBtn = $("btn-send");
  const hasInput = !!$("f-request").value.trim() || pendingAttachments.length > 0;
  const stopMode = busy && !hasInput;
  sendBtn.textContent = stopMode ? "■" : "↑";
  sendBtn.classList.toggle("stop-mode", stopMode);
  sendBtn.classList.toggle("queue-mode", busy && hasInput);
  sendBtn.disabled = !busy && !hasInput;
  sendBtn.title = stopMode ? "Yanıtı durdur" : busy ? "Mesajı sıraya ekle" : "Gönder";
  sendBtn.setAttribute("aria-label", sendBtn.title);

  // Üye çipleri: her üye kendi rengi (sağlayıcı) ve baş harfiyle + Koordinatör
  const memberChips = (state.config.members || []).filter((m) => m.enabled).map((m) => {
    const own = state.agents[m.id];
    const prov = state.agents[m.provider] || { status: "idle" };
    const status = own?.status === "busy" ? "busy" : prov.status;
    return `<span class="mini-agent bg-${m.provider} st-${status}" data-agent-pop="${esc(m.id)}"
      title="${esc(m.name)} (${PROVIDER_LABELS[m.provider]}${m.role !== "auto" ? " · " + esc(m.role) : ""}): ${STATUS_TR[status] || status} · ayarlar için tıkla">${esc((m.name[0] || "?").toUpperCase())}</span>`;
  }).join("");
  const kSt = state.agents.koordinator || { status: "idle" };
  $("tb-agents").innerHTML = memberChips +
    `<span class="mini-agent bg-koordinator st-${kSt.status}" data-agent-pop="koordinator"
      title="Koordinatör (${PROVIDER_LABELS[state.config.coordinator?.provider] || "Claude"}): ${STATUS_TR[kSt.status] || kSt.status}">K</span>`;

  // Hedef seçici: üyeler dinamik
  const targetSel = $("f-target");
  if (!targetSel.contains(document.activeElement)) {
    const cur = targetSel.value;
    targetSel.innerHTML = `<option value="konsey">Konsey</option>` +
      (state.config.members || []).filter((m) => m.enabled)
        .map((m) => `<option value="${esc(m.id)}">@ ${esc(m.name)}</option>`).join("");
    if ([...targetSel.options].some((o) => o.value === cur)) targetSel.value = cur;
  }

  const chip = $("btn-project");
  chip.textContent = proj ? `📁 ${proj.name} ▾` : "📁 Proje seç ▾";
  chip.classList.toggle("has-project", !!proj);
}

function renderMessageQueue(run) {
  const box = $("message-queue");
  const queue = run?.queuedMessages || [];
  box.hidden = queue.length === 0;
  box.innerHTML = queue.map((item, index) => {
    const target = item.target === "konsey" ? "Konsey" : (memberById(item.target)?.name || item.target);
    return `<div class="queued-message"><span class="queue-index">${index + 1}</span><div><b>${esc(target)}</b><span>${esc(item.text)}</span></div><em>Sırada</em></div>`;
  }).join("");
}

// Avatar tıklanınca açılan hızlı ayar paneli
function renderAgentPop() {
  const pop = $("agent-pop");
  if (!popAgent) { pop.hidden = true; return; }
  if (pop.contains(document.activeElement)) return;
  pop.hidden = false;
  if (popAgent === "koordinator") {
    pop.innerHTML = coordinatorCardHTML() + `
      <div class="a-note" style="margin-top:6px;font-size:11.5px;color:var(--dim)">
        Görevleri analiz eder, üyelere dağıtır, tartışmayı yönetir ve raporu yazar.
      </div>
      <div class="pop-actions"><button class="btn-ghost small" data-pop-close>Kapat</button></div>`;
    return;
  }
  const mem = memberById(popAgent);
  if (!mem) { pop.hidden = true; popAgent = null; return; }
  pop.innerHTML = memberCardHTML(mem) + `
    <div class="pop-actions">
      <button class="btn-ghost small" data-dm-agent="${esc(mem.id)}">✉ Bu üyeye yaz</button>
      <button class="btn-ghost small" data-pop-close>Kapat</button>
    </div>`;
}


function msgHTML(m) {
  if (m.kind === "task") {
    const firstLine = m.content.split("\n")[0];
    const rest = m.content.slice(firstLine.length).trim();
    return `<details class="task-msg">
      <summary>📋 ${esc(firstLine)}</summary>
      <div class="task-prompt">${md(rest)}</div>
    </details>`;
  }
  const meta = metaFor(m.from, m);
  const align = m.from === "kullanici" ? "kullanici" : meta.cls;
  const media = (m.attachments || []).map((a) => {
    const size = a.size ? `${(a.size / 1024 / 1024).toFixed(a.size > 1048576 ? 1 : 2)} MB` : "";
    if (a.kind === "image") return `<button class="media-thumb ${a.generated ? "generated-media" : ""}" data-media-src="${esc(a.url)}" data-media-name="${esc(a.name)}" data-media-kind="image"><img src="${esc(a.url)}" alt="${esc(a.name)}" onerror="this.closest('button').classList.add('broken')"><span>${esc(a.name)} · ${size}</span></button>`;
    if (a.kind === "video") return `<figure class="native-media"><video src="${esc(a.url)}" controls preload="metadata"></video><figcaption>${esc(a.name)} · ${size}</figcaption></figure>`;
    if (a.kind === "audio") return `<figure class="native-media audio"><audio src="${esc(a.url)}" controls preload="metadata"></audio><figcaption>${esc(a.name)} · ${size}</figcaption></figure>`;
    if (a.kind === "pdf" || a.mime === "text/html") return `<button class="file-card" data-media-src="${esc(a.url)}" data-media-name="${esc(a.name)}" data-media-kind="document"><span>${a.kind === "pdf" ? "PDF" : "HTML"}</span><b>${esc(a.name)}</b><small>${esc(a.mime || a.kind)} · ${size}</small></button>`;
    return `<a class="file-card" href="${esc(a.url)}" target="_blank"><span>${a.kind === "archive" ? "ZIP" : "DOC"}</span><b>${esc(a.name)}</b><small>${esc(a.mime || a.kind)} · ${size}</small></a>`;
  }).join("");
  const delivery = m.attachments?.length && m.from === "kullanici" ? `<div class="attachment-delivery">İletildi: ${(state.config.members||[]).filter(x=>x.enabled && (m.attachments||[]).every(a=>state.capabilities?.[x.provider]?.[a.kind])).map(x=>`<span class="c-${x.provider}">${esc(x.name)}</span>`).join(" · ") || "uyumlu ajan yok"}</div>` : "";
  return `<div class="msg from-${esc(align)} kind-${esc(m.kind)}">
    <div class="avatar bg-${esc(meta.cls)}">${esc(meta.short)}</div>
    <div class="m-body">
      <div class="m-head">
        <span class="m-name c-${esc(meta.cls)}">${esc(meta.label)}</span>
        <span class="m-kind">${esc(KIND_TR[m.kind] || m.kind)}</span>
        <span class="m-time">${new Date(m.ts).toLocaleTimeString("tr", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div class="m-content">${md(m.content)}${media ? `<div class="media-grid">${media}</div>${delivery}` : ""}</div>
      <div class="msg-actions" data-message-id="${esc(m.id)}">
        <button data-msg-copy title="Yanıtı kopyala">⧉</button>
        <button data-msg-retry title="Yeniden dene">↻</button>
        <button data-msg-continue title="Bu noktadan devam et">↳</button>
        <button data-msg-edit title="Düzenle">✎</button>
        <button data-msg-save title="Dosyaya kaydet">⇩</button>
        <button data-msg-feedback="up" class="${m.feedback === "up" ? "active" : ""}" title="Yararlı">♡</button>
        <button data-msg-feedback="down" class="${m.feedback === "down" ? "active" : ""}" title="Yararsız">⌁</button>
      </div>
    </div>
  </div>`;
}

// Titreme düzeltmesi: sohbet sıfırdan KURULMAZ; yalnızca yeni mesajlar eklenir.
// Böylece açık <details> öğeleri kapanmaz, metin yanıp sönmez.
let chatRunId = null, chatCount = 0;
function renderChat(run) {
  const hasMsgs = run && run.messages.length;
  $("empty-state").hidden = !!hasMsgs;
  const el = $("chat");
  const ws = $("workspace");
  const stick = ws.scrollTop + ws.clientHeight >= ws.scrollHeight - 80;

  if (!run) {
    if (chatRunId !== null) { el.innerHTML = ""; chatRunId = null; chatCount = 0; }
  } else {
    if (chatRunId !== run.id || run.messages.length < chatCount) {
      el.innerHTML = "";
      chatRunId = run.id;
      chatCount = 0;
    }
    if (run.messages.length > chatCount) {
      el.insertAdjacentHTML("beforeend", run.messages.slice(chatCount).map(msgHTML).join(""));
      chatCount = run.messages.length;
    }
  }

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

// Detay paneli yalnızca içerik gerçekten değişince yeniden kurulur
// (açık diff/details öğeleri kapanmasın, panel titremesin diye)
let detailsSig = "";
function renderDetails(run) {
  const sig = run
    ? [run.id, run.phase, run.status, run.messages.length,
       run.tasks.map((t) => t.status).join(""), run.reviews?.length, run.files?.length,
       run.tests?.length, run.votes?.length, run.decisions?.length,
       (run.report || "").length, run.diffs?.length, JSON.stringify(run.usage || {}).length].join("|")
    : "none";
  if (sig === detailsSig) return;
  detailsSig = sig;
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
          <div class="t-who">${esc(t.assigneeName || metaFor(t.assignee).label)} · ${t.status}${t.dependsOn?.length ? " · bağımlı: " + t.dependsOn.join(",") : ""}</div>
          ${bar}${dur}
        </div>`;
    }).join("");
  }
  $("tab-tasks").innerHTML = tasksHtml;

  $("tab-outputs").innerHTML = run
    ? [...new Set(run.messages.filter((m) => !["kullanici", "sistem"].includes(m.from) && m.kind !== "task").map((m) => m.from))]
        .map((a) => {
          const msgs = run.messages.filter((m) => m.from === a && m.kind !== "task");
          const meta = metaFor(a, msgs[0]);
          return `<h3 class="c-${meta.cls}">${esc(meta.label)}</h3>` +
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
      const meta = metaFor(n);
      return `<div class="usage-card">
        <div class="u-name c-${esc(meta.cls)}">${esc(meta.label)}</div>
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
  if (runEl) {
    const run=state.runs[runEl.dataset.run];
    if(run?.projectId&&run.projectId!==activeProjectId()) {
      await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({activeProject:run.projectId})});
    }
    selectRun(runEl.dataset.run); autoCloseSidebar(); fetchState(); return;
  }

  const moreProject=closest("[data-more-project]");
  if(moreProject) {
    const id=moreProject.dataset.moreProject;
    projectRunLimits.set(id,(projectRunLimits.get(id)||5)+10);
    renderProjects();
    return;
  }

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

// Üye/koordinatör ayarları değişince kaydet
document.addEventListener("change", async (e) => {
  const t = e.target;
  const inConfig = t.closest("#agent-config, #agent-pop");
  if (!inConfig) return;

  // "Özel model yaz…" seçilirse metin iste
  if ((t.matches("[data-mmodel]") || t.matches("[data-cmodel]")) && t.value === "__custom") {
    const custom = prompt("Model kimliği:");
    if (custom === null) { render(); return; }
    t.value = custom.trim();
  }
  await saveMembers();
});

// Üye ekle / sil
document.addEventListener("click", async (e) => {
  if (e.target.closest("#btn-add-member")) {
    await saveMembers((members) => {
      const n = members.length + 1;
      members.push({
        id: "m-" + Math.random().toString(36).slice(2, 8),
        name: "Üye " + n, provider: "claude", role: "auto",
        model: "", effort: "", enabled: true,
      });
    });
    return;
  }
  const del = e.target.closest("[data-mdel]");
  if (del) {
    const card = del.closest("[data-member]");
    const mem = memberById(card.dataset.member);
    if (!confirm(`"${mem?.name || "Üye"}" konseyden çıkarılsın mı?`)) return;
    await saveMembers((members) => {
      const i = members.findIndex((m) => m.id === card.dataset.member);
      if (i >= 0) members.splice(i, 1);
    });
  }
});

// sabit düğmeler
$("btn-sidebar").addEventListener("click", () => $("sidebar").classList.toggle("hidden"));
$("btn-side-close").addEventListener("click", () => $("sidebar").classList.add("hidden"));
function autoCloseSidebar() { if (window.innerWidth < 1100) $("sidebar").classList.add("hidden"); }
$("btn-new").addEventListener("click", () => { selectRun(null); autoCloseSidebar(); render(); $("f-request").focus(); });
$("btn-details").addEventListener("click", () => $("details").classList.toggle("closed"));

function openToolPanel(tab) {
  $("tool-panel").classList.remove("closed");
  $("tool-menu").hidden = true;
  document.querySelectorAll("[data-tool-tab]").forEach((b) => b.classList.toggle("active", b.dataset.toolTab === tab));
  $("tool-terminal").hidden = tab !== "terminal";
  $("tool-browser").hidden = tab !== "browser";
  if (tab === "terminal") $("terminal-command").focus();
  if (tab === "browser" && $("browser-frame").src === "about:blank") navigateBrowser($("browser-url").value);
}
function normalizeBrowserUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "http://localhost:4780";
  return /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `http://${raw}`;
}
function navigateBrowser(value) {
  const url = normalizeBrowserUrl(value);
  $("browser-url").value = url;
  const desktopView = $("desktop-browser-view");
  const external = /^https?:\/\//i.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url);
  if (desktopView) {
    desktopView.src = url;
    $("browser-notice").hidden = true;
  } else if (external) {
    $("browser-notice").hidden = false;
    $("browser-notice").textContent = "Bu site iframe kullanımını engelliyor. Tam tarayıcı için Ajan Konseyi masaüstü uygulamasını açın; site yeni sekmede açıldı.";
    window.open(url, "_blank", "noopener");
  } else {
    $("browser-frame").src = url;
    $("browser-notice").hidden = true;
  }
}

if (window.desktopAPI?.isDesktop) {
  const webview = document.createElement("webview");
  webview.id = "desktop-browser-view";
  webview.setAttribute("partition", "persist:ajan-browser");
  webview.setAttribute("allowpopups", "true");
  $("browser-surface").replaceChildren(webview);
}
$("btn-tools").addEventListener("click", (e) => { e.stopPropagation(); $("tool-menu").hidden = !$("tool-menu").hidden; });
document.querySelectorAll("[data-open-tool]").forEach((b) => b.addEventListener("click", () => openToolPanel(b.dataset.openTool)));
document.querySelectorAll("[data-open-details]").forEach((b) => b.addEventListener("click", () => {
  $("tool-menu").hidden = true;
  $("details").classList.remove("closed");
  document.querySelector(`#tabs button[data-tab="${b.dataset.openDetails}"]`)?.click();
}));
document.addEventListener("click", (e) => { if (!e.target.closest(".tool-menu-wrap")) $("tool-menu").hidden = true; });
$("btn-open-terminal").addEventListener("click", () => { openToolPanel("terminal"); autoCloseSidebar(); });
$("btn-open-browser").addEventListener("click", () => { openToolPanel("browser"); autoCloseSidebar(); });
$("btn-tool-close").addEventListener("click", () => $("tool-panel").classList.add("closed"));
document.querySelectorAll("[data-tool-tab]").forEach((b) => b.addEventListener("click", () => openToolPanel(b.dataset.toolTab)));
$("browser-bar").addEventListener("submit", (e) => { e.preventDefault(); navigateBrowser($("browser-url").value); });
$("browser-home").addEventListener("click", () => navigateBrowser("http://localhost:4780"));
$("browser-external").addEventListener("click", () => window.open(normalizeBrowserUrl($("browser-url").value), "_blank", "noopener"));
let terminalSessionId = null, terminalCursor = 0, terminalPoll = null;
async function ensureTerminalSession() {
  const r=await fetch("/api/terminal/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:activeProjectId()})});
  const j=await r.json(); if(j.error) throw new Error(j.error);
  if(terminalSessionId!==j.sessionId) { terminalSessionId=j.sessionId; terminalCursor=0; $("terminal-output").textContent=""; }
  if(j.output) { $("terminal-output").textContent+=j.output; terminalCursor=j.cursor; }
  if(!terminalPoll) terminalPoll=setInterval(pollTerminal,500);
  return j;
}
async function pollTerminal() {
  if(!terminalSessionId) return;
  try { const r=await fetch(`/api/terminal/sessions/${terminalSessionId}?from=${terminalCursor}`); const j=await r.json(); if(j.output){$("terminal-output").textContent+=j.output; terminalCursor=j.cursor; $("terminal-output").scrollTop=$("terminal-output").scrollHeight;} } catch {}
}
$("terminal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("terminal-command");
  const command = input.value.trim();
  if (!command) return;
  const output = $("terminal-output");
  const project = activeProject();
  output.textContent += `\n❯ ${command}\n`;
  input.value = "";
  output.scrollTop = output.scrollHeight;
  try {
    await ensureTerminalSession();
    const r = await fetch(`/api/terminal/sessions/${terminalSessionId}/write`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input:command, from:terminalCursor }),
    });
    const j = await r.json();
    output.textContent += (j.output||"")+(j.error?`Hata: ${j.error}\n`:""); terminalCursor=j.cursor??terminalCursor;
  } catch (err) {
    output.textContent += `Bağlantı hatası: ${err.message}`;
  } finally {
    input.focus(); output.scrollTop = output.scrollHeight;
  }
});
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
ta.addEventListener("input", () => { autoGrow(); renderTopbar(); });
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
$("btn-send").addEventListener("click", send);

// ---- Görsel ekleri: dosya seç, panodan yapıştır, sürükle-bırak ----
let pendingAttachments = []; // {path, url, name}

function renderAttachChips() {
  const box = $("attach-chips");
  box.hidden = pendingAttachments.length === 0;
  box.innerHTML = pendingAttachments.map((a, i) => {
    const src = a.previewUrl || (a.kind === "image" ? a.url : "");
    if (src) return `<span class="attach-chip attach-image ${a.uploading ? "uploading" : a.error ? "upload-error" : ""}" title="${esc(a.name)}"><img src="${esc(src)}" alt="${esc(a.name)}"><button data-rm-attach="${i}" title="Görseli kaldır" aria-label="Görseli kaldır">×</button>${a.uploading ? `<em>${a.progress || 0}%</em>` : a.error ? `<button class="attach-retry" data-retry-attach="${i}">Tekrar</button>` : ""}</span>`;
    return `<span class="attach-chip ${a.uploading ? "uploading" : a.error ? "upload-error" : ""}"><b>${a.uploading ? "…" : a.error ? "!" : "📄"}</b> ${esc(a.name)} ${a.uploading ? `<em>${a.progress || 0}%</em>` : a.error ? `<button data-retry-attach="${i}">Tekrar</button>` : ""}<button data-rm-attach="${i}" title="Kaldır">✕</button></span>`;
  }).join("");
  box.querySelectorAll("[data-rm-attach]").forEach((b) =>
    b.addEventListener("click", () => { const i=Number(b.dataset.rmAttach); const a=pendingAttachments[i]; a?.controller?.abort(); if(a?.previewUrl) URL.revokeObjectURL(a.previewUrl); pendingAttachments.splice(i, 1); renderAttachChips(); renderTopbar(); })
  );
  box.querySelectorAll("[data-retry-attach]").forEach((b) => b.addEventListener("click", () => uploadFile(pendingAttachments[Number(b.dataset.retryAttach)].file, Number(b.dataset.retryAttach))));
  renderTopbar();
  renderAttachmentWarning();
}

function renderAttachmentWarning() {
  const el=$("attachment-warning"); if(!el) return;
  const target=$("f-target").value;
  const providers=target==="konsey" ? [...new Set((state.config.members||[]).filter(m=>m.enabled).map(m=>m.provider))] : [memberById(target)?.provider].filter(Boolean);
  const unsupported=pendingAttachments.filter(a=>!a.uploading&&!a.error && providers.length && providers.every(p=>!state.capabilities?.[p]?.[a.kind]));
  el.hidden=!unsupported.length; el.textContent=unsupported.length ? `⚠ Etkin hedefler bu dosyaları doğrudan okuyamıyor: ${unsupported.map(a=>a.name).join(", ")}. Uygun ajan seçin.` : "";
}
$("f-target").addEventListener("change", renderAttachmentWarning);

async function uploadFile(file, replaceIndex = null) {
  if (file.size > 100 * 1024 * 1024) return alert(`${file.name}: 100 MB sınırını aşıyor.`);
  const slot = { name: file.name || "dosya", file, uploading: true, progress: 10,
    previewUrl: file.type?.startsWith("image/") ? URL.createObjectURL(file) : null };
  slot.controller = new AbortController();
  const index = replaceIndex == null ? pendingAttachments.push(slot) - 1 : replaceIndex;
  pendingAttachments[index] = slot; renderAttachChips();
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  slot.progress = 55; renderAttachChips();
  let resp;
  try { resp = await fetch("/api/upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name || "gorsel.png", data: dataUrl }),
    signal: slot.controller.signal,
  }); } catch (err) { if (err.name !== "AbortError") { pendingAttachments[index]={...slot,uploading:false,error:err.message}; renderAttachChips(); } return; }
  const j = await resp.json();
  if (j.error) { pendingAttachments[index] = { ...slot, uploading: false, error: j.error }; renderAttachChips(); return; }
  pendingAttachments[index] = { ...j, file, previewUrl: slot.previewUrl };
  renderAttachChips();
}

$("btn-attach").addEventListener("click", () => $("f-file").click());
$("f-file").addEventListener("change", async () => {
  for (const f of $("f-file").files) await uploadFile(f);
  $("f-file").value = "";
});
ta.addEventListener("paste", async (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file");
  if (!items.length) return;
  e.preventDefault();
  for (const it of items) {
    const f = it.getAsFile();
    if (f) await uploadFile(f);
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer?.files || []) await uploadFile(f);
});

// Kod bloklarındaki "Kopyala" düğmesi
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".cb-copy");
  if (!btn) return;
  const pre = btn.closest(".codeblock")?.querySelector("pre");
  if (pre) {
    navigator.clipboard.writeText(pre.textContent).then(() => {
      btn.textContent = "✓ Kopyalandı";
      setTimeout(() => (btn.textContent = "⧉ Kopyala"), 1500);
    });
  }
});

function messageById(id) {
  return selectedRun ? state.runs[selectedRun]?.messages?.find((m) => m.id === id) : null;
}
let viewerScale = 1;
function openMedia(src, name = "Görsel", kind = "image") {
  viewerScale = 1;
  const image=$("viewer-image"), video=$("viewer-video"), audio=$("viewer-audio"), doc=$("viewer-document");
  image.hidden=kind!=="image"; video.hidden=kind!=="video"; audio.hidden=kind!=="audio"; doc.hidden=kind!=="document";
  if(kind==="image") image.src=src; else if(kind==="video") video.src=src; else if(kind==="audio") audio.src=src; else doc.src=src;
  $("viewer-minus").hidden=kind!=="image"; $("viewer-plus").hidden=kind!=="image"; $("viewer-zoom").hidden=kind!=="image"; $("viewer-title").textContent = name;
  $("viewer-download").href = src; $("viewer-download").download = name; $("viewer-open").href = src;
  $("viewer-zoom").textContent = "100%"; $("viewer-image").style.transform = "scale(1)"; $("media-viewer").hidden = false;
}
function setViewerScale(next) { viewerScale = Math.max(.25, Math.min(4, next)); $("viewer-image").style.transform = `scale(${viewerScale})`; $("viewer-zoom").textContent = `${Math.round(viewerScale * 100)}%`; }
function closeMedia() { $("media-viewer").hidden = true; $("viewer-video").pause(); $("viewer-audio").pause(); $("viewer-document").src="about:blank"; }
$("viewer-close").addEventListener("click", closeMedia);
$("viewer-plus").addEventListener("click", () => setViewerScale(viewerScale + .25));
$("viewer-minus").addEventListener("click", () => setViewerScale(viewerScale - .25));
$("media-viewer").addEventListener("click", (e) => { if (e.target.id === "media-viewer" || e.target.id === "viewer-stage") closeMedia(); });

document.addEventListener("click", async (e) => {
  const media = e.target.closest("[data-media-src]");
  if (media) { e.preventDefault(); openMedia(media.dataset.mediaSrc || media.src, media.dataset.mediaName || media.alt, media.dataset.mediaKind || "image"); return; }
  const actions = e.target.closest(".msg-actions");
  if (!actions) return;
  const msg = messageById(actions.dataset.messageId); if (!msg) return;
  if (e.target.closest("[data-msg-copy]")) await navigator.clipboard.writeText(msg.content);
  if (e.target.closest("[data-msg-retry]")) { ta.value = msg.from === "kullanici" ? msg.content : `Bu yanıtı yeniden değerlendir ve daha iyi yanıtla:\n\n${msg.content}`; autoGrow(); ta.focus(); }
  if (e.target.closest("[data-msg-continue]")) { const r=await fetch(`/api/runs/${selectedRun}/branch`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messageId:msg.id})}); const j=await r.json(); if(j.runId){selectRun(j.runId); await fetchState(); ta.focus();} }
  if (e.target.closest("[data-msg-edit]")) { ta.value = msg.content; autoGrow(); ta.focus(); }
  if (e.target.closest("[data-msg-save]")) { const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([msg.content],{type:"text/markdown"})); a.download=`ajan-yaniti-${msg.id}.md`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
  const fb = e.target.closest("[data-msg-feedback]");
  if (fb) { await fetch(`/api/runs/${selectedRun}/messages/${msg.id}/feedback`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({value:fb.dataset.msgFeedback})}); fb.classList.add("active"); }
});

async function send() {
  const selRun = selectedRun ? state.runs[selectedRun] : null;
  const text = ta.value.trim();
  // Çalışırken boş düğme durdurur; metin varsa mevcut yanıtı kesmeden sıraya alır.
  if (selRun?.status === "running" && !text && pendingAttachments.length === 0) {
    await fetch(`/api/runs/${selectedRun}/stop`, { method: "POST" });
    fetchState();
    return;
  }

  if (!text && pendingAttachments.length === 0) return;
  if (pendingAttachments.some((a) => a.uploading)) return alert("Dosyaların yüklenmesi henüz tamamlanmadı.");
  if (pendingAttachments.some((a) => a.error)) return alert("Başarısız dosyayı kaldırın veya yeniden deneyin.");
  const messageText = text || "Ek dosyaları incele.";
  const target = $("f-target").value;

  if (target === "konsey") {
    if (currentMode === "code" && !activeProjectId())
      return alert("Kod modu için önce bir proje seçin (📁 Proje seç).");
    // Sohbet akışı: seçili sohbet varsa DEVAM eder, yoksa yeni sohbet açılır
    const body = {
      conversationId: selRun?.kind === "chat" ? selectedRun : null,
      text: messageText,
      mode: currentMode,
      projectId: activeProjectId(),
      testCommand: $("f-test").value,
      maxDebateRounds: $("f-rounds").value,
      testFirst: $("f-testfirst").checked,
      attachments: pendingAttachments,
    };
    const r = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) return alert(j.error);
    selectRun(j.runId);
  } else {
    if (!selectedRun) {
      const r = await fetch("/api/direct-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: target, text: messageText, projectId: activeProjectId(), attachments: pendingAttachments }),
      });
      const j = await r.json();
      if (j.error) return alert(j.error);
      selectRun(j.runId);
    } else {
      const r = await fetch(`/api/runs/${selectedRun}/message`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: target, content: messageText, attachments: pendingAttachments }),
      });
      const j = await r.json();
      if (j.error) return alert(j.error);
    }
  }
  ta.value = ""; autoGrow();
  for (const a of pendingAttachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  pendingAttachments = []; renderAttachChips();
  renderTopbar();
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
fetchCapabilities();
setInterval(fetchState, 15000);
