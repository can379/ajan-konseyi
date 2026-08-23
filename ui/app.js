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
let conversationSearch = "";
let showArchivedChats = false;
let activeMainView = "chat";
let studioMediaKind = "image";
let studioAttachments = [];
let activeStudioRunId = null;
let flowAccountConnected = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const AGENT_META = {
  claude: { label: "Claude Code", short: "C" },
  codex: { label: "Codex", short: "X" },
  antigravity: { label: "Antigravity", short: "A" },
  openrouter: { label: "Ox Alpha", short: "OX" },
  koordinator: { label: "Koordinatör", short: "K" },
  kullanici: { label: "Siz", short: "S" },
  sistem: { label: "Sistem", short: "•" },
};
const PROVIDERS = ["claude", "codex", "antigravity", "openrouter"];
const SUBSCRIPTION_PROVIDERS = ["claude", "codex", "antigravity"];
const PROVIDER_LABELS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", openrouter: "Ox Alpha" };

function imageStudioMembers() {
  return SUBSCRIPTION_PROVIDERS.map((provider) => {
    const member = (state.config.members || []).find((m) => m.provider === provider && m.enabled);
    return { provider, id: member?.id || provider, label: member?.name || PROVIDER_LABELS[provider] };
  });
}

function updateImageStudioSummary() {
  const amount = Math.max(1, Math.min(30, Number($("image-count-number")?.value || 1)));
  if ($("image-worker-count")) $("image-worker-count").textContent = `${amount} paralel görev`;
  const engine=$("studio-engine")?.selectedOptions[0]?.textContent || "";
  const duration=studioMediaKind==="video"&&$("studio-duration")?.value!=="auto"?` · ${$("studio-duration").value} sn`:"";
  if ($("image-start-summary")) $("image-start-summary").textContent = `${engine}${duration} · ${studioMediaKind === "video" ? "1 video" : amount+" çıktı"}`;
}

function renderImageStudio() {
  const options = $("image-agent-options"); if (!options) return;
  const prior = new Set([...options.querySelectorAll("input:checked")].map((x) => x.value));
  const members = imageStudioMembers();
  const roles = { claude:"Sanat yönetimi ve istem", codex:"Yüksek kaliteli görsel motoru", antigravity:"Araştırma ve sanat yönetimi", openrouter:"Kodlama ve uzun ajan görevleri" };
  options.innerHTML = members.map((m) => `<label class="image-agent-option ${m.provider}"><input type="checkbox" value="${esc(m.id)}" data-provider="${m.provider}" ${prior.size ? (prior.has(m.id) ? "checked" : "") : "checked"}><span class="image-agent-mark">${agentLogo(m.provider)}</span><span><b>${esc(m.label)}</b><small>${roles[m.provider]}</small></span><i>✓</i></label>`).join("");
  const coordinator = $("image-coordinator"), previous = coordinator.value;
  coordinator.innerHTML = `<option value="koordinator">Konsey Koordinatörü</option>` + members.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
  if ([...coordinator.options].some((o) => o.value === previous)) coordinator.value = previous;
  updateImageStudioSummary(); renderImageBatchStatus();
}

function renderImageBatchStatus() {
  const box = $("image-batch-status"); if (!box) return;
  const batches=Object.values(state.runs || {}).filter((r) => r.kind === "image-batch" || r.kind === "image_batch").sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  box.hidden = !batches.length; if (!batches.length) return;
  box.innerHTML=`<div class="studio-history-head"><div><span>STÜDYO GEÇMİŞİ</span><b>Tüm üretimler</b></div><small>${batches.length} üretim grubu</small></div>`+batches.map((batch)=>{
    const media=[...new Map([...(batch.tasks||[]),...(batch.messages||[])].flatMap((item)=>item.attachments||[]).filter((a)=>["image","video"].includes(a.kind)).map((a)=>[a.path||a.url||a.name,a])).values()];
    const target=Number(batch.batch?.total||batch.imageCount||batch.metadata?.imageCount||media.length||1);
    const done=Math.min(target,Number(batch.batch?.completed??batch.completedCount??media.length)); const failed=Number(batch.batch?.failed||0); const percent=Math.round(done/target*100);
    const created=batch.createdAt?new Date(batch.createdAt).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"";
    const engine=batch.imageStudio?.engine?.replace("openai-image","GPT Image").replace("gemini-flash-image","Nano Banana 2").replace("gemini-pro-image","Nano Banana Pro").replace("gemini-omni-video","Omni Flash Video").replace("veo-3.1","Veo 3.1").replace("google-flow-subscription","Google Flow · PRO")||"Medya";
    const flowWaiting=batch.imageStudio?.engine==="google-flow-subscription"&&batch.status==="running";
    return `<section class="studio-output-group ${batch.status} ${batch.id===activeStudioRunId?"active":""}"><div class="image-batch-head"><span><b>${esc(batch.title||batch.request||"Stüdyo üretimi")}</b><small>${esc(engine)} · ${created} · ${done}/${target} tamamlandı${failed?` · ${failed} hatalı`:""}</small></span><strong>${batch.status==="running"?(flowWaiting?"Flow":""+percent+"%") :"✓"}</strong></div>${batch.status==="running"&&!flowWaiting?`<div class="image-batch-progress"><i style="width:${percent}%"></i></div>`:""}${media.length?`<div class="studio-gallery">${media.map((a)=>a.kind==="video"?`<button type="button" data-media-src="${esc(a.url)}" data-media-kind="video" data-media-name="${esc(a.name)}"><video src="${esc(a.url)}" muted></video><span>▶</span></button>`:`<button type="button" data-media-src="${esc(a.url)}" data-media-kind="image" data-media-name="${esc(a.name||"Görsel")}"><img src="${esc(a.url)}" alt=""></button>`).join("")}</div>`:flowWaiting?`<div class="flow-waiting"><b>Arka planda üretiliyor</b><span>Flow görünmeden çalışıyor. Video tamamlanınca otomatik olarak burada görünecek.</span><button type="button" data-flow-import="${esc(batch.id)}">Videoyu seç</button></div>`:`<div class="studio-output-empty">Bu üretimde görüntülenebilir çıktı oluşmadı.</div>`}</section>`;
  }).join("");
  box.querySelectorAll('[data-flow-import]').forEach((button)=>button.onclick=async()=>{const result=await window.desktopAPI?.selectFlowVideo?.(button.dataset.flowImport);if(result?.error){$('image-studio-error').textContent=result.error;$('image-studio-error').hidden=false;}else if(!result?.canceled){await fetchState();renderImageBatchStatus();}});
}

function showMainView(view) {
  activeMainView = view; const studio = view === "images";
  $("image-studio").hidden = !studio; $("workspace").hidden = studio; $("composer-wrap").hidden = studio;
  $("btn-image-studio").classList.toggle("active", studio);
  if (studio) renderImageStudio();
}

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
  t = t.replace(/\[([^\]]+)\]\((\/(?:Users|private|tmp)\/[^)]+)\)/g, '<button type="button" class="artifact-link" data-artifact-path="$2">◇ $1</button>');
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
    if (ev?.type === "stream_end") {
      delete liveStreams[ev.agent];
      renderLive();
      return;
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
  // Arayüz kullanıcı metnindeki anahtar kelimelerden niyet tahmini yapmaz.
  // Görsel durumu yalnız orkestratör gerçekten üretim başlattığında gösterilir.
  const imageGeneration=Object.values(liveStreams).some((s)=>/görsel (?:üretiyor|hazırlanıyor)/i.test(s.label||""));
  const referenceImage=[...(run.messages||[])].reverse().flatMap((m)=>m.attachments||[]).find((a)=>a.kind==="image")?.url || "";
  $("live").innerHTML = busyAgents.map((a) => {
    const s = liveStreams[a];
    const meta = metaFor(a);
    if(imageGeneration) return `<div class="msg live-msg image-live from-${esc(meta.cls)}">
      <div class="avatar bg-${esc(meta.cls)}">${agentLogo(meta.cls)}</div>
      <div class="m-body"><div class="m-head"><span class="m-name c-${esc(meta.cls)}">${esc(meta.label)}</span><span class="lb-live">görsel üretiyor…</span></div>
      <div class="generation-preview" aria-label="Görsel oluşturuluyor">${referenceImage ? `<img class="generation-source" src="${esc(referenceImage)}" alt="Referans görsel işleniyor">` : `<div class="generation-clouds"></div>`}<div class="generation-noise"></div><div class="generation-scan"></div><div class="generation-mark">✦</div></div>
      <div class="generation-status"><span>Görsel katmanları oluşturuluyor</span><div><i></i></div><small>Önizleme aşamalı olarak netleşecek</small></div></div>
    </div>`;
    const statusLabel=s.label ? String(s.label).replace(/\.{2,}$/g,"") : "yanıt hazırlanıyor";
    return `<div class="msg live-msg live-status-only from-${esc(meta.cls)}">
      <div class="avatar bg-${esc(meta.cls)}">${agentLogo(meta.cls)}</div>
      <div class="m-body">
        <div class="m-head">
          <span class="m-name c-${esc(meta.cls)}">${esc(meta.label)}</span>
          <span class="lb-live">${esc(statusLabel)}…</span>
        </div>
      </div>
    </div>`;
  }).join("");
  if (stick) ws.scrollTop = ws.scrollHeight;
}

function activeProjectId() { return state.config.activeProject; }
function activeProject() { return state.config.projects.find((p) => p.id === activeProjectId()) || null; }

// ================= RENDER =================
function render() {
  renderConversations();
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
  renderNotificationCount();
  renderQuotaOverviewDetailed();
  syncToggles();
  if (activeMainView === "images") renderImageStudio();
  const toolProject = $("tool-project");
  if (toolProject) toolProject.textContent = activeProject()?.name || "Proje seçilmedi";
}

function runSearchText(run) {
  return [run.title, run.request, run.searchText, run.preview, run.lastMessage, ...(run.messages || []).map((m) => m.content)]
    .filter(Boolean).join("\n").toLocaleLowerCase("tr-TR");
}

// Projeye bağlı olmayan konuşmalar, proje listesinden bağımsız bir geçmiş olarak görünür.
function renderConversations() {
  const el = $("conversation-list");
  if (!el) return;
  const query = conversationSearch.trim().toLocaleLowerCase("tr-TR");
  const runs = Object.values(state.runs)
    .filter((run) => run.kind === "chat" && !run.projectId && !run.deletedAt && (showArchivedChats||!run.archived) && (!query || runSearchText(run).includes(query)))
    .sort((a, b) => (Number(b.pinned)-Number(a.pinned))||String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  el.innerHTML = runs.length ? runs.map((run) => `<div class="run-item conversation-item ${run.id === selectedRun ? "selected" : ""} ${run.pinned?"pinned":""} ${run.archived?"archived":""}" data-run="${esc(run.id)}" title="${esc(run.title || run.request)}">
    <div class="r-title">${esc(run.title || run.request || "Yeni sohbet")}</div>
    <div class="r-meta"><span class="status-dot ${run.status === "idle" ? "done" : esc(run.status)}"></span>${run.status === "running" ? esc(PHASE_TR[run.phase] || run.phase) : esc(PHASE_TR[run.status] || run.status)}</div>
  </div>`).join("") : `<div class="conversation-empty">${query ? "Eşleşen sohbet bulunamadı." : "Henüz sohbet yok."}</div>`;
  bindRunContextMenu();
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
    return `<details class="cap-provider" ${id==="claude"?"open":""}><summary><span class="cap-agent-dot bg-${id}">${agentLogo(id)}</span><span class="cap-agent-title"><b class="c-${id}">${esc(AGENT_META[id]?.label||id)}</b><small>${esc(p.version)}</small></span><span class="cap-count"><b>${ready}</b> hazır${attention?`<small>${attention} sınırlı</small>`:""}</span><span class="cap-chevron">›</span></summary><div class="cap-provider-body">${sections}<div class="cap-runtime"><span>MCP <b>${connected}</b></span><span>Eklenti <b>${plugins}</b></span></div></div></details>`;
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
  $("f-notify-done").checked = state.config.notificationEvents?.done !== false;
  $("f-notify-error").checked = state.config.notificationEvents?.error !== false;
  $("f-notify-approval").checked = state.config.notificationEvents?.approval !== false;
  document.querySelector(".notification-preferences")?.classList.toggle("disabled",!state.config.notifications);
}

function renderProjects() {
  const list = state.config.projects;
  const sortedRunIds = Object.keys(state.runs).filter((id)=>!state.runs[id].deletedAt&&(showArchivedChats||!state.runs[id].archived))
    .sort((a, b) => (Number(state.runs[b].pinned)-Number(state.runs[a].pinned))||state.runs[b].createdAt.localeCompare(state.runs[a].createdAt));
  const runHTML = (id) => {
    const r=state.runs[id];
    return `<div class="run-item ${id === selectedRun ? "selected" : ""} ${r.pinned?"pinned":""} ${r.archived?"archived":""}" data-run="${id}" title="${esc(r.title || r.request)}">
      <div class="r-title">${esc(r.title || r.request)}</div>
      <div class="r-meta"><span class="status-dot ${r.status === "idle" ? "done" : r.status}"></span>${r.status === "running" ? esc(PHASE_TR[r.phase] || r.phase) : esc(PHASE_TR[r.status] || r.status)}</div>
    </div>`;
  };
  const projectHTML = (p) => {
    const query=conversationSearch.trim().toLocaleLowerCase("tr-TR");
    const ids=sortedRunIds.filter((id)=>state.runs[id].projectId===p.id&&(!query||runSearchText(state.runs[id]).includes(query)));
    const limit=projectRunLimits.get(p.id)||5;
    const selectedBelongs=selectedRun&&state.runs[selectedRun]?.projectId===p.id;
    return `<div class="project-group ${selectedBelongs?"has-selected":""}">
      <div class="project-item ${p.id === activeProjectId() ? "active" : ""}" data-proj="${p.id}">
        <span class="p-ico" aria-hidden="true"></span>
        <span class="p-info"><div class="p-name">${esc(p.name)}</div><div class="p-path">${esc(p.path)}</div></span>
      </div>
      <div class="project-runs">${ids.slice(0,limit).map(runHTML).join("")}
        ${ids.length>limit?`<button class="project-more" data-more-project="${p.id}">Daha fazla göster <span>${ids.length-limit}</span></button>`:""}
      </div>
    </div>`;
  };
  $("project-list").innerHTML = list.length
    ? list.map(projectHTML).join("")
    : `<div class="muted">Proje ekleyin; koşular projeye bağlanır ve konsey kaldığı yerden devam eder.</div>`;
  bindProjectContextMenu();
  bindRunContextMenu();
}
let runMenuTimer=null;
function bindRunContextMenu(){
  const menu=$("run-context-menu");
  const cancelClose=()=>clearTimeout(runMenuTimer);
  const close=(delay=120)=>{cancelClose();runMenuTimer=setTimeout(()=>{menu.hidden=true;menu.dataset.runId="";},delay);};
  for(const row of document.querySelectorAll(".run-item[data-run]")){
    row.addEventListener("mouseenter",()=>{
      cancelClose();
      const rect=row.getBoundingClientRect(),run=state.runs[row.dataset.run];
      menu.dataset.runId=row.dataset.run;
      menu.querySelector('[data-run-menu="pin"]').textContent=run?.pinned?"Sabitlemeyi kaldır":"Sabitle";
      menu.querySelector('[data-run-menu="archive"]').textContent=run?.archived?"Arşivden çıkar":"Arşivle";
      menu.hidden=false;
      requestAnimationFrame(()=>{
        menu.style.left=`${Math.min(innerWidth-menu.offsetWidth-12,rect.right+2)}px`;
        menu.style.top=`${Math.min(innerHeight-menu.offsetHeight-12,rect.top)}px`;
      });
    });
    row.addEventListener("mouseleave",(event)=>{
      if(event.relatedTarget===menu||menu.contains(event.relatedTarget))return;
      close(420);
    });
  }
  menu.onmouseenter=cancelClose;
  menu.onmouseleave=(event)=>{
    const row=event.relatedTarget?.closest?.(".run-item[data-run]");
    if(row?.dataset.run===menu.dataset.runId)return;
    close();
  };
}
async function patchRun(id,patch){await fetch(`/api/runs/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)});await fetchState();}
async function startProjectPreview(id){await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({activeProject:id})});const response=await fetch(`/api/projects/${id}/dev/start`,{method:"POST"}),result=await response.json();if(!response.ok)return alert(result.error);openToolPanel("browser");$("browser-notice").hidden=false;$("browser-notice").textContent=`${result.command} başlatılıyor…`;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,500));const status=await fetch(`/api/projects/${id}/dev`).then(r=>r.json());if(status.url){createBrowserTab(status.url);$("browser-notice").hidden=true;return;}if(status.alive===false)return alert(`Sunucu kapandı.\n${status.output||""}`);}alert("Sunucu çalışıyor ancak port henüz algılanamadı.");}
function openProjectSettings(id){const p=state.config.projects.find(x=>x.id===id);if(!p)return;showModal(`<div class="m-head"><h2>${esc(p.name)} · Proje ayarları</h2><button data-modal-close>×</button></div><label class="field">Kalıcı proje talimatları<textarea id="project-instructions" rows="7">${esc(p.instructions||"")}</textarea></label><label class="field">Yeniden kullanılabilir yetenekler <small>Her satıra bir çalışma kuralı veya yetenek yazın.</small><textarea id="project-skills" rows="5">${esc((p.skills||[]).join("\n"))}</textarea></label><label class="field">Geliştirme komutu<input id="project-dev-command" value="${esc(p.devCommand||"")}" placeholder="npm run dev"></label><label class="field artifact-export-setting"><span><input type="checkbox" id="project-artifact-export" ${p.artifactExport?"checked":""}> Konsey kanıtlarını repoya aktar</span><small>Task, handoff, review ve integration sonuçlarını .ajan-konseyi/ altında saklar. Varsayılan olarak kapalıdır.</small></label><div class="m-foot"><button data-modal-close>Vazgeç</button><button class="btn-gradient" data-save-project-settings="${id}">Kaydet</button></div>`);}
async function openCheckpoints(id){const data=await fetch(`/api/projects/${id}/checkpoints`).then(r=>r.json());showModal(`<div class="m-head"><h2>Kontrol noktaları</h2><button data-modal-close>×</button></div><div class="m-list">${(data.checkpoints||[]).map(c=>`<div class="m-item"><span>${esc(c.name)}<small>${new Date(c.createdAt).toLocaleString("tr-TR")}</small></span><button data-restore-checkpoint="${c.id}" data-project-id="${id}">Geri dön</button></div>`).join("")||'<div class="muted">Henüz kontrol noktası yok.</div>'}</div><div class="m-foot"><button data-modal-close>Kapat</button><button class="btn-gradient" data-create-checkpoint="${id}">Yeni kontrol noktası</button></div>`);}
async function openProjectMemory(id){const data=await fetch(`/api/projects/${id}/memory`).then(r=>r.json());showModal(`<div class="m-head"><h2>Proje hafızası</h2><button data-modal-close>×</button></div><textarea id="project-memory-content" rows="14">${esc(data.content||"")}</textarea><h3>Önemli ve işaretli bilgiler</h3><div class="m-list">${(data.pins||[]).map(p=>`<div class="m-item"><span>${esc(p.text)}${p.flag?`<small>${esc(p.flag)}</small>`:""}</span></div>`).join("")||'<div class="muted">Sabit bilgi yok.</div>'}</div><div class="m-foot"><button data-memory-forget="${id}">Bilgi unuttur</button><button data-memory-pin="${id}">Önemli bilgi sabitle</button><button data-memory-flag="${id}">Çelişki işaretle</button><button class="btn-gradient" data-memory-save="${id}">Kaydet</button></div>`);}
function openChatManager(projectId,{trash=false}={}){const runs=Object.values(state.runs).filter(r=>r.kind==="chat"&&r.projectId===projectId&&Boolean(r.deletedAt)===trash);showModal(`<div class="m-head"><h2>${trash?"Çöp kutusu":"Sohbetleri yönet"}</h2><button data-modal-close>×</button></div><div class="m-list chat-manage-list">${runs.map(r=>`<label class="m-item"><input type="checkbox" data-manage-run="${r.id}"><span>${esc(r.title||r.request)}<small>${esc((r.tags||[]).join(", "))}</small></span></label>`).join("")||'<div class="muted">Sohbet yok.</div>'}</div><div class="m-foot"><button data-modal-close>Kapat</button>${trash?'<button data-bulk-chat="restore">Geri yükle</button>':'<button data-bulk-chat="archive">Arşivle</button><button data-bulk-chat="move">Projeye taşı</button><button data-bulk-chat="trash">Çöpe taşı</button>'}</div>`);}

let projectMenuTimer=null;
function bindProjectContextMenu(){
  const menu=$("project-context-menu");
  const close=()=>{clearTimeout(projectMenuTimer);projectMenuTimer=setTimeout(()=>menu.hidden=true,140);};
  for(const row of document.querySelectorAll(".project-item")){
    row.addEventListener("mouseenter",()=>{clearTimeout(projectMenuTimer);const rect=row.getBoundingClientRect();menu.dataset.projectId=row.dataset.proj;menu.style.left=`${Math.min(innerWidth-menu.offsetWidth-12,rect.right+8)}px`;menu.style.top=`${Math.min(innerHeight-menu.offsetHeight-12,rect.top)}px`;menu.hidden=false;requestAnimationFrame(()=>{menu.style.left=`${Math.min(innerWidth-menu.offsetWidth-12,rect.right+8)}px`;menu.style.top=`${Math.min(innerHeight-menu.offsetHeight-12,rect.top)}px`;});});
    row.addEventListener("mouseleave",close);
  }
  menu.onmouseenter=()=>clearTimeout(projectMenuTimer);menu.onmouseleave=close;
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

function configurableProviders(current = "") {
  const providers = [...SUBSCRIPTION_PROVIDERS];
  if (state.config.apiProviders?.openrouter?.configured || current === "openrouter") providers.push("openrouter");
  return providers;
}

function memberCardHTML(m) {
  const st = state.agents[m.id] || state.agents[m.provider] || { status: "idle" };
  const provSt = state.agents[m.provider] || { status: "idle" };
  const dotStatus = st.status === "busy" ? "busy" : provSt.status;
  const roleOpts = Object.entries(state.roles)
    .map(([k, v]) => `<option value="${k}" ${m.role === k ? "selected" : ""}>${esc(v.split(" — ")[0])}</option>`)
    .join("");
  const provOpts = configurableProviders(m.provider)
    .map((p) => `<option value="${p}" ${m.provider === p ? "selected" : ""}>${PROVIDER_LABELS[p]}</option>`)
    .join("");
  return `
    <div class="agent-card ${m.enabled ? "" : "disabled"}" data-member="${esc(m.id)}">
      <div class="a-head">
        <span class="agent-card-logo bg-${m.provider}">${agentLogo(m.provider)}</span>
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
        <span class="agent-card-logo bg-koordinator">${agentLogo("koordinator")}</span>
        <span class="a-dot ${st.status}"></span>
        <span class="a-name c-koordinator">Koordinatör</span>
        <span class="a-status">${STATUS_TR[st.status] || st.status}</span>
      </div>
      <div class="a-field"><label>Hangi yapay zekâ yönetsin?</label>
        <select data-cprovider>
          ${configurableProviders(c.provider).map((p) => `<option value="${p}" ${c.provider === p ? "selected" : ""}>${PROVIDER_LABELS[p]}</option>`).join("")}
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
  $("btn-open-project-app").disabled=!proj;

  const run = selectedRun ? state.runs[selectedRun] : null;
  $("tb-phase").innerHTML = run
    ? `<span class="phase ${run.status}">${run.status === "running" ? esc(PHASE_TR[run.phase] || run.phase) : esc(PHASE_TR[run.status] || run.status)}</span>`
    : "";
  $("btn-resume").hidden = !(run && run.kind !== "chat" && ["interrupted", "stopped", "failed"].includes(run.status));

  // Codex davranışı: çalışırken kutu boşsa durdur; metin varsa sıraya gönder.
  const busy = run && run.status === "running";
  $("btn-stop").hidden=!busy;
  const sendBtn = $("btn-send");
  const hasInput = !!$("f-request").value.trim() || pendingAttachments.length > 0;
  const stopMode = busy && !hasInput;
  sendBtn.textContent = stopMode ? "■" : "↑";
  sendBtn.classList.toggle("stop-mode", stopMode);
  sendBtn.classList.toggle("queue-mode", busy && hasInput);
  sendBtn.disabled = !busy && !hasInput;
  sendBtn.title = stopMode ? "Yanıtı durdur" : busy ? "Mesajı sıraya ekle" : "Gönder";
  sendBtn.setAttribute("aria-label", sendBtn.title);

  // Üye çipleri: ad değişse bile sağlayıcının gerçek görsel kimliği korunur.
  const memberChips = (state.config.members || []).filter((m) => m.enabled).map((m) => {
    const own = state.agents[m.id];
    const prov = state.agents[m.provider] || { status: "idle" };
    const status = own?.status === "busy" ? "busy" : prov.status;
    return `<span class="mini-agent bg-${m.provider} st-${status}" data-agent-pop="${esc(m.id)}"
      title="${esc(m.name)} (${PROVIDER_LABELS[m.provider]}${m.role !== "auto" ? " · " + esc(m.role) : ""}): ${STATUS_TR[status] || status} · ayarlar için tıkla">${agentLogo(m.provider)}</span>`;
  }).join("");
  const kSt = state.agents.koordinator || { status: "idle" };
  $("tb-agents").hidden = false;
  $("tb-agents").innerHTML = memberChips +
    `<span class="mini-agent bg-koordinator st-${kSt.status}" data-agent-pop="koordinator"
      title="Koordinatör (${PROVIDER_LABELS[state.config.coordinator?.provider] || "Claude"}): ${STATUS_TR[kSt.status] || kSt.status}">${agentLogo("koordinator")}</span>`;

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

function externalApps(){try{return JSON.parse(localStorage.getItem("ajan.externalApps")||"[]").filter(item=>item?.path&&item?.name);}catch{return[];}}
function renderExternalApps(){const box=$("external-app-list");if(!box)return;const builtins=["VS Code","Finder","Terminal","Android Studio"],custom=externalApps();box.innerHTML=builtins.map(name=>`<div><span><b>${esc(name)}</b><small>Yerleşik</small></span></div>`).join("")+custom.map((item,index)=>`<div><span><b>${esc(item.name)}</b><small>${esc(item.path)}</small></span><button data-remove-external-app="${index}">Kaldır</button></div>`).join("")+`<button id="btn-add-external-app" class="btn-ghost small">＋ Uygulama ekle</button>`;}
async function chooseExternalApp(){if(!window.desktopAPI?.chooseExternalApp)return alert("Uygulama ekleme masaüstü sürümünde kullanılabilir.");const result=await window.desktopAPI.chooseExternalApp();if(result?.error)return alert(result.error);if(result?.canceled)return;const items=externalApps();if(!items.some(item=>item.path===result.path))items.push({name:result.name,path:result.path});localStorage.setItem("ajan.externalApps",JSON.stringify(items.slice(-20)));renderExternalApps();return result;}
async function openProjectWith(kind,appPath){const project=activeProject();if(!project)return alert("Önce proje seçin.");if(!window.desktopAPI?.openProjectWith)return alert("Bu özellik masaüstü uygulamasında kullanılabilir.");const result=await window.desktopAPI.openProjectWith({kind,appPath,projectPath:project.path});if(result?.error)alert(`${kind} açılamadı: ${result.error}`);}

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
      <div class="pop-actions"><button class="btn-gradient small" data-pop-save>Kaydet</button><button class="btn-ghost small" data-pop-close>Kapat</button></div>`;
    return;
  }
  const mem = memberById(popAgent);
  if (!mem) { pop.hidden = true; popAgent = null; return; }
  pop.innerHTML = memberCardHTML(mem) + `
    <div class="pop-actions">
      <button class="btn-ghost small" data-dm-agent="${esc(mem.id)}">✉ Bu üyeye yaz</button>
      <button class="btn-gradient small" data-pop-save>Kaydet</button>
      <button class="btn-ghost small" data-pop-close>Kapat</button>
    </div>`;
}

async function saveAgentPop() {
  const pop = $("agent-pop");
  if (!popAgent || pop.hidden) return;
  const members = (state.config.members || []).map((member) => ({ ...member }));
  let coordinator = { ...(state.config.coordinator || {}) };
  if (popAgent === "koordinator") {
    const card = pop.querySelector("[data-coord]");
    coordinator = {
      provider: card.querySelector("[data-cprovider]").value,
      model: card.querySelector("[data-cmodel]").value,
      effort: card.querySelector("[data-ceffort]").value,
    };
  } else {
    const card = pop.querySelector("[data-member]");
    const index = members.findIndex((member) => member.id === popAgent);
    if (card && index >= 0) members[index] = {
      ...members[index],
      name: card.querySelector("[data-mname]").value.trim() || "Üye",
      provider: card.querySelector("[data-mprovider]").value,
      role: card.querySelector("[data-mrole]").value,
      model: card.querySelector("[data-mmodel]").value,
      effort: card.querySelector("[data-meffort]").value,
      enabled: card.querySelector("[data-menable]").checked,
    };
  }
  const response = await fetch("/api/config", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ members, coordinator }),
  });
  if (!response.ok) throw new Error("Ajan ayarları kaydedilemedi");
  popAgent = null;
  await fetchState();
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
    <div class="avatar bg-${esc(meta.cls)}">${agentLogo(meta.cls)}</div>
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
    const statusLabel={pending:"Bekliyor",active:"Çalışıyor",running:"Çalışıyor",review:"İncelemede",done:"Tamamlandı",failed:"Hatalı"};
    const completed=run.tasks.filter((task)=>task.status==="done").length;
    const active=run.tasks.filter((task)=>["active","running","review"].includes(task.status)).length;
    const failed=run.tasks.filter((task)=>task.status==="failed").length;
    const progress=Math.round((completed/run.tasks.length)*100);
    const t0 = Math.min(...run.tasks.filter((t) => t.startedAt).map((t) => +new Date(t.startedAt)), +new Date(run.createdAt));
    const t1 = Math.max(...run.tasks.filter((t) => t.endedAt).map((t) => +new Date(t.endedAt)), t0 + 1);
    const span = t1 - t0;
    tasksHtml = `<section class="task-plan-summary"><div><span>İlerleme</span><strong>${progress}%</strong></div><div><span>Toplam</span><strong>${run.tasks.length}</strong></div><div><span>Çalışıyor</span><strong>${active}</strong></div><div><span>Tamamlandı</span><strong>${completed}</strong></div>${failed?`<div class="failed"><span>Hatalı</span><strong>${failed}</strong></div>`:""}</section><div class="task-plan-progress"><i style="width:${progress}%"></i></div><div class="task-plan-list">` + run.tasks.map((t) => {
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
          <div class="task-title"><span class="task-status-dot"></span>${esc(t.title)}<b>${esc(statusLabel[t.status]||t.status)}</b></div>
          <div class="t-who">${esc(t.assigneeName || metaFor(t.assignee).label)}${t.dependsOn?.length ? ` · Önce: ${t.dependsOn.map(esc).join(", ")}` : " · Bağımsız"}<br><span>${esc(t.routingReason||"")}${t.workspace?` · İzole dal: ${esc(t.workspace.branch)}`:""}</span></div>
          ${bar}${dur}
        </div>`;
    }).join("") + `</div>`;
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
    const allDiff=(run.diffs||[]).map(item=>item.diff||"").join("\n");
    const additions=(allDiff.match(/^\+[^+]/gm)||[]).length,deletions=(allDiff.match(/^-[^-]/gm)||[]).length;
    filesHtml=`<div class="change-review-summary"><span><b>${(run.files||[]).length} dosya</b><small>${(run.diffs||[]).length} izole ajan dalı</small></span><strong><i>+${additions}</i> <em>−${deletions}</em></strong></div>`;
    filesHtml += (run.files || []).map((f) => `<div class="file-line"><b>[${esc(f.agent)}]</b> ${esc(f.change)} ${esc(f.path)}</div>`).join("");
    for (const d of run.diffs || []) {
      filesHtml += `<div class="diff-agent-head c-${esc(d.agent)}">${AGENT_META[d.agent]?.label || d.agent} — ${esc(d.branch)}</div>` + renderDiff(d.diff);
    }
    if (run.mode === "code" && (run.diffs || []).length) {
      filesHtml += `<div style="margin-top:10px"><button class="btn-ghost small" data-rollback="${run.id}">↩ Geri al — bu koşunun dallarını sil</button></div>`;
    }
  }
  $("tab-files").innerHTML = filesHtml;
  if(run?.projectId)renderProjectArtifacts(run.projectId,run);

  $("tab-tests").innerHTML = run?.tests?.length
    ? `${run.repairHistory?.length?`<div class="repair-history"><b>Otomatik onarma</b>${run.repairHistory.map(item=>`<span>${item.ok?"✓":"✗"} Deneme ${item.attempt} · ${esc(item.agent)}</span>`).join("")}</div>`:""}`+run.tests.map((t) => `<h3>${t.ok ? "✓" : "✗"} ${esc(t.command)}</h3><pre>${esc(t.output)}</pre>`).join("")
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
    const budget=run.budget||{enabled:false,maxCalls:24,maxTokens:250000};
    const usedCalls=names.reduce((total,key)=>total+(usage[key].calls||0),0);
    const budgetPercent=Math.min(100,Math.max(Math.round((totIn+totOut)/(budget.maxTokens||250000)*100),Math.round(usedCalls/(budget.maxCalls||24)*100)));
    $("tab-usage").innerHTML = budget.enabled?`<div class="budget-meter"><div><b>Yerel görev bütçesi</b><span>${usedCalls}/${budget.maxCalls||24} çağrı · ${(totIn+totOut).toLocaleString("tr")}/${(budget.maxTokens||250000).toLocaleString("tr")} token</span></div><i><b style="width:${budgetPercent}%"></b></i>${budget.stopped?`<strong>${esc(budget.reason||"Bütçe doldu")}</strong>`:""}</div>` + cards +
      `<div class="usage-card"><div class="usage-total"><span>Toplam</span><span>${totIn.toLocaleString("tr")} girdi · ${totOut.toLocaleString("tr")} çıktı</span></div>
       <div class="muted" style="margin-top:4px">Abonelik oturumları kullanılır; API faturası oluşmaz. Tüketim, aboneliğin mesaj/kota limitlerinden düşer.</div></div>`:`<div class="budget-meter"><div><b>Yerel görev bütçesi kapalı</b><span>Kullanım uygulama tarafından durdurulmaz</span></div></div>` + cards +
      `<div class="usage-card"><div class="usage-total"><span>Toplam</span><span>${totIn.toLocaleString("tr")} girdi · ${totOut.toLocaleString("tr")} çıktı</span></div>
       <div class="muted" style="margin-top:4px">Abonelik oturumları kullanılır; API faturası oluşmaz. Tüketim, aboneliğin mesaj/kota limitlerinden düşer.</div></div>`;
  } else {
    $("tab-usage").innerHTML = `<div class="muted">Kullanım verisi koşu sırasında birikir.</div>`;
  }

  const context=run?.contextManifest;
  $("tab-context").innerHTML=context?.sources?.length?`<div class="context-summary"><b>Modele gönderilen bağlam</b><span>Yaklaşık ${Math.ceil(context.sources.reduce((n,s)=>n+(s.chars||0),0)/4).toLocaleString("tr")} token</span></div>${context.sources.map(source=>`<div class="context-source ${source.enabled?"included":"excluded"}"><span><b>${esc(source.label)}</b><small>${source.enabled?"Dahil edildi":"Boş — gönderilmedi"}${source.count?` · ${source.count} ek`:""}</small></span><strong>${(source.chars||0).toLocaleString("tr")} karakter</strong></div>`).join("")}`:`<div class="muted">Bağlam dökümü görev planlanınca oluşur.</div>`;

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
    const body = chunk.split("\n").slice(1, 400).map((l,index) => {
      const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "";
      return `<div class="dl ${cls} diff-commentable" data-diff-file="${esc(fname)}" data-diff-line="${index+1}" title="Yorum eklemek için tıklayın">${esc(l) || " "}</div>`;
    }).join("");
    return `<details class="diff-file"><summary>${esc(fname)} <span class="muted">+${adds} −${dels}</span></summary><div class="diff-body">${body}</div></details>`;
  }).join("");
}
async function renderProjectArtifacts(projectId,run){try{const data=await fetch(`/api/projects/${projectId}/artifacts`).then(r=>r.json());const files=(data.artifacts||[]).slice(0,30);if(files.length)$("tab-files").insertAdjacentHTML("afterbegin",`<h3>Proje çıktıları</h3><div class="artifact-catalog">${files.map(f=>`<button class="artifact-link" data-artifact-path="${esc(f.path)}">${esc(f.relative)}</button>`).join("")}</div>`);if(run.diffComments?.length)$("tab-files").insertAdjacentHTML("beforeend",`<h3>Diff yorumları</h3>${run.diffComments.map(c=>`<div class="diff-comment-list"><b>${esc(c.file)}:${c.line}</b><br>${esc(c.body)}</div>`).join("")}`);}catch{} }

function renderToasts() {
  const pending = state.approvals.filter((a) => a.status === "pending");
  $("toasts").innerHTML = pending.map((a) => `
    <div class="toast risk-${esc(a.risk||"düşük")}">
      <div class="t-title">${esc(a.title)}</div>
      <div class="approval-meta"><b>${esc((a.risk||"düşük").toLocaleUpperCase("tr-TR"))} RİSK</b><span>${a.reversible===false?"Geri alınamayabilir":"Geri alınabilir"}</span></div>
      <pre>${esc(a.detail)}</pre>
      <div class="t-btns">
        <button class="approve" data-ap="${a.id}" data-d="approve">✓ Onayla</button>
        <button class="reject" data-ap="${a.id}" data-d="reject">✗ Reddet</button>
      </div>
    </div>`).join("");
}

const NOTIFICATION_READ_KEY="ajan.notifications.read";
const NOTIFICATION_DISMISSED_KEY="ajan.notifications.dismissed";
function storedNotificationIds(key){try{return new Set(JSON.parse(localStorage.getItem(key)||"[]"));}catch{return new Set();}}
function saveNotificationIds(key,ids){localStorage.setItem(key,JSON.stringify([...ids].slice(-500)));}
function notificationId(item){return [item.kind,item.runId||item.approvalId||"system",item.at||"",item.title||""].join(":");}
function importantNotifications(){const runs=Object.values(state.runs||{}),dismissed=storedNotificationIds(NOTIFICATION_DISMISSED_KEY);return[
  ...state.approvals.filter(item=>item.status==="pending").map(item=>({kind:"approval",title:"Onay bekleniyor",detail:item.title,at:item.ts,approvalId:item.id})),
  ...runs.filter(run=>["failed","evidence_blocked"].includes(run.status)).slice(-20).map(run=>({kind:"error",title:run.status==="evidence_blocked"?"Kanıt kapısı engelledi":"Görev başarısız",detail:run.title||run.request,at:run.updatedAt||run.createdAt,runId:run.id})),
  ...runs.filter(run=>run.budget?.enabled&&run.budget?.stopped).slice(-20).map(run=>({kind:"budget",title:"Yerel görev sınırı",detail:run.budget.reason,at:run.updatedAt,runId:run.id})),
  ...runs.filter(run=>run.status==="done").slice(-10).map(run=>({kind:"done",title:"Görev tamamlandı",detail:run.title||run.request,at:run.updatedAt||run.createdAt,runId:run.id}))
].map(item=>({...item,id:notificationId(item)})).filter(item=>!dismissed.has(item.id)).sort((a,b)=>+new Date(b.at||0)-+new Date(a.at||0));}
function renderNotificationCount(){const read=storedNotificationIds(NOTIFICATION_READ_KEY),count=importantNotifications().filter(item=>!read.has(item.id)).length,el=$("notification-count");el.hidden=!count;el.textContent=count>99?"99+":count;}
function closeNotificationPopover(){document.querySelector("#notification-popover")?.remove();$("btn-notifications").setAttribute("aria-expanded","false");}
function dismissNotification(id){const dismissed=storedNotificationIds(NOTIFICATION_DISMISSED_KEY);dismissed.add(id);saveNotificationIds(NOTIFICATION_DISMISSED_KEY,dismissed);document.querySelector(`[data-notification-id="${CSS.escape(id)}"]`)?.remove();renderNotificationCount();const list=document.querySelector("#notification-popover .notification-list");if(list&&!list.querySelector(".notification-item"))list.innerHTML='<div class="notification-empty"><span>✓</span><b>Her şey yolunda</b><small>İlgilenmeniz gereken yeni bildirim yok.</small></div>';}
$("btn-notifications").addEventListener("click",event=>{event.stopPropagation();if(document.querySelector("#notification-popover"))return closeNotificationPopover();const items=importantNotifications(),read=storedNotificationIds(NOTIFICATION_READ_KEY);items.forEach(item=>read.add(item.id));saveNotificationIds(NOTIFICATION_READ_KEY,read);renderNotificationCount();const button=$("btn-notifications"),rect=button.getBoundingClientRect(),panel=document.createElement("section");panel.id="notification-popover";panel.innerHTML=`<header><div><b>Bildirimler</b><small>Yalnız önemli olaylar</small></div><button type="button" data-notification-close aria-label="Bildirimleri kapat">×</button></header><div class="notification-list">${items.map(item=>`<article class="notification-item" data-notification-id="${esc(item.id)}" ${item.runId?`data-notification-run="${item.runId}"`:""}><span class="n-${item.kind}"></span><div><b>${esc(item.title)}</b><small>${esc(item.detail||"")}</small></div><time>${item.at?esc(new Date(item.at).toLocaleString("tr-TR",{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"short"})):""}</time><button type="button" class="notification-delete" data-notification-delete aria-label="Bildirimi sil">×</button></article>`).join("")||'<div class="notification-empty"><span>✓</span><b>Her şey yolunda</b><small>İlgilenmeniz gereken yeni bildirim yok.</small></div>'}</div>`;document.body.append(panel);const width=Math.min(410,innerWidth-24);panel.style.width=`${width}px`;panel.style.top=`${Math.min(rect.bottom+10,innerHeight-panel.offsetHeight-12)}px`;panel.style.left=`${Math.max(12,Math.min(rect.right-width,innerWidth-width-12))}px`;button.setAttribute("aria-expanded","true");panel.querySelectorAll(".notification-item").forEach(row=>{let startX=0;row.addEventListener("pointerdown",e=>{startX=e.clientX;row.setPointerCapture?.(e.pointerId);});row.addEventListener("pointermove",e=>{if(!startX)return;const dx=e.clientX-startX;row.style.transform=`translateX(${Math.max(-110,Math.min(110,dx))}px)`;row.classList.toggle("swiping",Math.abs(dx)>12);});row.addEventListener("pointerup",e=>{const dx=e.clientX-startX;startX=0;if(Math.abs(dx)>70){row.classList.add(dx<0?"dismiss-left":"dismiss-right");setTimeout(()=>dismissNotification(row.dataset.notificationId),150);}else{row.style.transform="";setTimeout(()=>row.classList.remove("swiping"),0);}});});});
document.addEventListener("click",event=>{const panel=event.target.closest("#notification-popover");if(!panel)return closeNotificationPopover();if(event.target.closest("[data-notification-close]"))return closeNotificationPopover();const row=event.target.closest(".notification-item");if(event.target.closest("[data-notification-delete]")&&row){event.stopPropagation();return dismissNotification(row.dataset.notificationId);}if(row?.dataset.notificationRun&&!row.classList.contains("swiping")){selectRun(row.dataset.notificationRun);closeNotificationPopover();}});

function usageProvider(name){return (state.config.members||[]).find(member=>member.id===name)?.provider||PROVIDERS.find(provider=>String(name).toLowerCase().includes(provider))||name;}
let openQuotaProvider="";
function quotaWindowLabel(minutes){if(minutes>=10080)return"Haftalık kota";if(minutes>=1440)return`${Math.round(minutes/1440)} günlük kota`;if(minutes>=60)return minutes===300?"5 saatlik kota":`${Math.round(minutes/60)} saatlik kota`;return"Kullanım kotası";}
function providerQuotaLogo(provider){
  if(provider==="claude")return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v26M5.7 8.8l20.6 14.4M3.5 19.5l25-7M9.2 27l13.6-22M4 13.2l24 5.6M10.6 4l10.8 24"/></svg>`;
  if(provider==="codex")return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4.2a7.3 7.3 0 0 1 12.3 5.3 7.3 7.3 0 0 1-1.1 12.3A7.3 7.3 0 0 1 16 28a7.3 7.3 0 0 1-12.3-5.3A7.3 7.3 0 0 1 4.8 10.4 7.3 7.3 0 0 1 16 4.2Z"/><path d="m10.4 11.1 5.6-3.2 5.6 3.2v9.8L16 24.1l-5.6-3.2v-6.5l8.5-4.9"/></svg>`;
  if(provider==="antigravity")return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3c1.4 7.4 5.6 11.6 13 13-7.4 1.4-11.6 5.6-13 13-1.4-7.4-5.6-11.6-13-13C10.4 14.6 14.6 10.4 16 3Z"/><path d="M25 3.5c.5 2.4 2.1 4 4.5 4.5-2.4.5-4 2.1-4.5 4.5-.5-2.4-2.1-4-4.5-4.5 2.4-.5 4-2.1 4.5-4.5Z"/></svg>`;
  if(provider==="openrouter")return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 10h9c4 0 5 6 9 6h6M4 22h9c4 0 5-6 9-6"/><path d="m24 12 4 4-4 4"/></svg>`;
  if(provider==="koordinator")return `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="8" r="3.5"/><circle cx="8" cy="23" r="3.5"/><circle cx="24" cy="23" r="3.5"/><path d="m14.4 11.1-4.8 8.8m8-8.8 4.8 8.8M11.5 23h9"/></svg>`;
  if(provider==="sistem")return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m16 3 10 5.6v7.2c0 6.3-4 10.5-10 13.2-6-2.7-10-6.9-10-13.2V8.6L16 3Z"/><path d="M11 16h2.5l1.7-4 2.4 8 1.7-4H22"/></svg>`;
  if(provider==="kullanici")return `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="11" r="5"/><path d="M7 28c.8-6 4-9 9-9s8.2 3 9 9"/></svg>`;
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="10"/><path d="M16 10v6l4 3"/></svg>`;
}
function agentLogo(provider){return `<span class="agent-glyph">${providerQuotaLogo(provider)}</span>`;}
const PROVIDER_API_RATES={codex:{input:2.5,cached:.25,output:15},claude:{input:3,cached:.3,output:15},antigravity:{input:.5,cached:.05,output:3}};
function providerUsage(provider){const now=Date.now(),totals={calls:0,input:0,cachedInput:0,output:0},recorded=new Map(),rate=PROVIDER_API_RATES[provider],price=usage=>((Math.max(0,Number(usage.input||0)-Number(usage.cachedInput||0))*rate.input)+(Number(usage.cachedInput||0)*rate.cached)+(Number(usage.output||0)*rate.output))/1e6;for(const run of Object.values(state.runs||{})){const stamp=Date.parse(run.updatedAt||run.createdAt||0);if(now-stamp>30*864e5)continue;const day=new Date(stamp).toISOString().slice(0,10),daily=recorded.get(day)||{day,calls:0,tokens:0,cost:0};for(const [member,usage] of Object.entries(run.usage||{})){if(usageProvider(member)!==provider)continue;for(const key of Object.keys(totals))totals[key]+=Number(usage[key]||0);daily.calls+=Number(usage.calls||0);daily.tokens+=Number(usage.input||0)+Number(usage.output||0);daily.cost+=price(usage);}recorded.set(day,daily);}const days=Array.from({length:30},(_,index)=>{const date=new Date();date.setHours(12,0,0,0);date.setDate(date.getDate()-(29-index));const day=date.toISOString().slice(0,10);return recorded.get(day)||{day,calls:0,tokens:0,cost:0};}),monthKey=new Date().toLocaleDateString("en-CA",{timeZone:"Europe/Istanbul"}).slice(0,7),monthRows=[...recorded.values()].filter(item=>item.day.startsWith(`${monthKey}-`));return {...totals,cost:price(totals),days,month:monthKey,monthCost:monthRows.reduce((sum,item)=>sum+item.cost,0),monthTokens:monthRows.reduce((sum,item)=>sum+item.tokens,0),monthCalls:monthRows.reduce((sum,item)=>sum+item.calls,0)};}
function usageChart(usage){const source=usage.days||[],max=Math.max(.001,...source.map(item=>Number(item.cost||0))),todayCost=Number(usage.todayCost??source.at(-1)?.cost??0),monthCost=Number(usage.monthCost??0),thirtyDayCost=Number(usage.thirtyDayCost??usage.cost??0);return `<div class="quota-daily"><div><span><small>Bugün</small><b>$${todayCost.toFixed(2)}</b></span><span><small>Bu ay · API eşdeğeri</small><b>$${monthCost.toFixed(2)}</b></span><span><small>Son 30 gün</small><b>$${thirtyDayCost.toFixed(2)}</b></span></div><div class="quota-bars" aria-label="Son 30 günlük kullanım">${source.map(item=>`<i class="${item.cost>0?"used":"empty"}" style="height:${item.cost>0?Math.max(6,item.cost/max*100):3}%"><span><b>${esc(new Date(`${item.day}T12:00:00`).toLocaleDateString("tr-TR",{day:"numeric",month:"short"}))}</b><em>$${Number(item.cost||0).toFixed(2)}${item.calls==null?"":` · ${Number(item.calls).toLocaleString("tr-TR")} çağrı`}</em><small>${Number(item.tokens||0).toLocaleString("tr-TR")} token</small></span></i>`).join("")}</div>${usage.mostUsedModel?`<small class="quota-model">En çok kullanılan model: ${esc(usage.mostUsedModel)}</small>`:""}</div>`;}
function quotaWindowHtml(window){const remaining=Math.round(window.remainingPercent),reset=window.resetsAt?new Date(window.resetsAt).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):null,resetText=reset?`${reset} tarihinde sıfırlanır`:window.refreshText?`${esc(window.refreshText)} sonra tamamen yenilenir`:"Sıfırlanma zamanı paylaşılmadı",bars=(window.history||[]).slice(-16);return `<div class="quota-remaining${window.stale?" stale":""}"><span><b>${quotaWindowLabel(window.windowMinutes)}</b><em>${resetText}${window.stale?" · güncel değil":""}</em></span><strong>%${remaining}</strong><i><b style="width:${remaining}%"></b></i>${bars.length>1?`<div class="quota-history" aria-label="Son kota ölçümleri">${bars.map(point=>`<i style="height:${Math.max(8,Number(point.usedPercent))}%"></i>`).join("")}</div>`:""}</div>`;}
function renderQuotaOverview(){const host=$("quota-overview");if(!host)return;host.innerHTML=SUBSCRIPTION_PROVIDERS.map(provider=>{const members=(state.config.members||[]).filter(member=>member.provider===provider&&member.enabled),models=[...new Set(members.map(member=>member.model||"Otomatik model"))].join(", ")||"Bağlı üye yok",health=state.health?.[provider],status=health?.ok!==false?"Hazır":"Bağlantı gerekli",quota=state.providerQuotas?.[provider],remaining=quota?.available?Math.round(quota.remainingPercent):null,secondary=quota?.secondary,secondaryRemaining=secondary?Math.round(secondary.remainingPercent):null,reset=quota?.resetsAt?new Date(quota.resetsAt).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):null,secondaryReset=secondary?.resetsAt?new Date(secondary.resetsAt).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):null,quotaText=remaining===null?"Kota verisi yok":`%${remaining} kaldı`,isOpen=openQuotaProvider===provider,updated=quota?.updatedAt?new Date(quota.updatedAt).toLocaleString("tr-TR",{hour:"2-digit",minute:"2-digit"}):null;return `<article class="quota-card quota-${provider}${isOpen?" open":""}" data-provider="${provider}" tabindex="0" role="button" aria-expanded="${isOpen}" style="--remaining:${remaining??0}"><span class="quota-avatar">${providerQuotaLogo(provider)}</span><div><b>${PROVIDER_LABELS[provider]}</b><small>${quotaText}</small></div><i class="${health?.ok===false?"offline":""}"></i><section class="quota-tooltip"><button class="quota-close" type="button" aria-label="Kota ayrıntısını kapat">×</button><header><span><b>${PROVIDER_LABELS[provider]}</b><small>${esc(status)} · ${esc(models)}</small></span><strong>${remaining===null?"Kesin veri yok":`%${remaining} kaldı`}</strong></header>${remaining!==null?`<div class="quota-remaining"><span><b>${quotaWindowLabel(quota.windowMinutes)}</b><em>${reset?`${reset} tarihinde sıfırlanır`:"Sıfırlanma zamanı paylaşılmadı"}</em></span><strong>%${remaining}</strong><i><b style="width:${remaining}%"></b></i></div>${secondaryRemaining!==null?`<div class="quota-remaining"><span><b>${quotaWindowLabel(secondary.windowMinutes)}</b><em>${secondaryReset?`${secondaryReset} tarihinde sıfırlanır`:"Sıfırlanma zamanı paylaşılmadı"}</em></span><strong>%${secondaryRemaining}</strong><i><b style="width:${secondaryRemaining}%"></b></i></div>`:""}`:""}<p>${remaining===null?"Bu sağlayıcı kesin kalan kotayı yerel oturumunda paylaşmıyor; bu yüzden tahmini bir yüzde veya ücret gösterilmiyor.":`${esc(quota.limitName||"Genel abonelik kotası")} doğrudan sağlayıcının yerel oturum kaydından okundu${updated?`; son kayıt ${updated}`:""}. Model-özel kotalar genel kotaya karıştırılmaz.`}</p></section></article>`;}).join("");host.onclick=event=>{const card=event.target.closest(".quota-card");if(!card)return;const close=event.target.closest(".quota-close"),provider=card.dataset.provider,opening=openQuotaProvider!==provider&&!close;openQuotaProvider=opening?provider:"";host.querySelectorAll(".quota-card").forEach(item=>{const isOpen=item.dataset.provider===openQuotaProvider;item.classList.toggle("open",isOpen);item.setAttribute("aria-expanded",String(isOpen))});event.stopPropagation()};host.onkeydown=event=>{if(!["Enter"," "].includes(event.key)||event.target.closest(".quota-close"))return;event.preventDefault();event.target.click()};}
function renderQuotaOverviewDetailed(){const host=$("quota-overview");if(!host)return;host.innerHTML=SUBSCRIPTION_PROVIDERS.map(provider=>{const members=(state.config.members||[]).filter(member=>member.provider===provider&&member.enabled),models=[...new Set(members.map(member=>member.model||"Otomatik model"))].join(", ")||"Bağlı üye yok",health=state.health?.[provider],status=health?.ok!==false?"Hazır":"Bağlantı gerekli",quota=state.providerQuotas?.[provider]||{},windows=quota.windows?.length?quota.windows:quota.available?[quota,quota.secondary].filter(Boolean):[],remaining=windows.length?Math.round(windows[0].remainingPercent):null,quotaText=remaining===null?"Kota verisi yok":`%${remaining} kaldı`,isOpen=openQuotaProvider===provider,updated=quota.updatedAt?new Date(quota.updatedAt).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):null,localUsage=providerUsage(provider),usage=quota.accountUsage||localUsage,identity=[quota.accountEmail,quota.accountPlan||quota.plan].filter(Boolean).join(" · ")||"Hesap kimliği paylaşılmadı",usageCalls=Number(usage.calls??localUsage.calls??0),usageTokens=Number(usage.thirtyDayTokens??(localUsage.input+localUsage.output)),usageCost=Number(usage.thirtyDayCost??localUsage.cost);return `<article class="quota-card quota-${provider}${isOpen?" open":""}" data-provider="${provider}" tabindex="0" role="button" aria-expanded="${isOpen}" style="--remaining:${remaining??0}"><span class="quota-avatar">${providerQuotaLogo(provider)}</span><div><b>${PROVIDER_LABELS[provider]}</b><small>${quotaText}</small></div><i class="${health?.ok===false?"offline":""}"></i><section class="quota-tooltip"><button class="quota-close" type="button" aria-label="Kota ayrıntısını kapat">×</button><header><span><b>${PROVIDER_LABELS[provider]}</b><small>${esc(identity)}</small><small>${esc(status)} · ${esc(models)}</small></span><strong>${remaining===null?"Kesin veri yok":`%${remaining} kaldı`}</strong></header>${windows.map(quotaWindowHtml).join("")}${usageChart(usage)}<div class="quota-grid"><span><small>Son 30 gün</small><b>${usageCalls.toLocaleString("tr-TR")} çağrı</b><em>${usageTokens.toLocaleString("tr-TR")} token</em></span><span><small>Tahmini API karşılığı</small><b>$${usageCost.toFixed(2)}</b><em>Abonelik faturası değil</em></span></div><p>${esc(usage.source||quota.source||"Yerel oturum")} kaydından okundu${updated?`; son kota ölçümü ${updated}`:""}. Günlük değerler ayrı günlerden toplanır; 30 günlük değer bugünün tekrarı değildir.</p></section></article>`;}).join("");host.onclick=event=>{const card=event.target.closest(".quota-card");if(!card)return;const close=event.target.closest(".quota-close"),provider=card.dataset.provider,opening=openQuotaProvider!==provider&&!close;openQuotaProvider=opening?provider:"";host.querySelectorAll(".quota-card").forEach(item=>{const isOpen=item.dataset.provider===openQuotaProvider;item.classList.toggle("open",isOpen);item.setAttribute("aria-expanded",String(isOpen))});event.stopPropagation()};host.onkeydown=event=>{if(!["Enter"," "].includes(event.key)||event.target.closest(".quota-close"))return;event.preventDefault();event.target.click()};}
document.addEventListener("click",event=>{if(event.target.closest("#quota-overview"))return;openQuotaProvider="";document.querySelectorAll(".quota-card.open").forEach(card=>{card.classList.remove("open");card.setAttribute("aria-expanded","false")})});
document.addEventListener("keydown",event=>{if(event.key!=="Escape")return;openQuotaProvider="";document.querySelectorAll(".quota-card.open").forEach(card=>{card.classList.remove("open");card.setAttribute("aria-expanded","false")})});
$("quota-overview")?.addEventListener("mouseleave",()=>{openQuotaProvider="";document.querySelectorAll(".quota-card.open").forEach(card=>{card.classList.remove("open");card.setAttribute("aria-expanded","false")})});
window.addEventListener("blur",()=>{openQuotaProvider="";document.querySelectorAll(".quota-card.open").forEach(card=>{card.classList.remove("open");card.setAttribute("aria-expanded","false")})});

// ================= MODALLAR =================
// Eski proje araçları `showModal` adını kullanıyor. Tek modal uygulamasına
// yönlendirerek proje ayarları, hafıza ve kontrol noktalarının gerçek UI'da
// güvenle açılmasını sağla.
function showModal(html) {
  openModal(html);
}

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

  const projectMenuAction=closest("[data-project-menu]");
  if(projectMenuAction){
    const id=$("project-context-menu").dataset.projectId;$("project-context-menu").hidden=true;
    if(projectMenuAction.dataset.projectMenu==="chat")projectMenuAction.dataset.newProjectChat=id;
    if(projectMenuAction.dataset.projectMenu==="terminal")projectMenuAction.dataset.projectTerminal=id;
    if(projectMenuAction.dataset.projectMenu==="remove")projectMenuAction.dataset.delProj=id;
    if(projectMenuAction.dataset.projectMenu==="preview"){await startProjectPreview(id);return;}
    if(projectMenuAction.dataset.projectMenu==="settings"){openProjectSettings(id);return;}
    if(projectMenuAction.dataset.projectMenu==="memory"){await openProjectMemory(id);return;}
    if(projectMenuAction.dataset.projectMenu==="health"){const health=await fetch(`/api/projects/${id}/health`).then(response=>response.json());openModal(`<div class="modal-title"><div><span class="section-kicker">PROJE SAĞLIĞI</span><h2>${health.score}/100 · ${esc(health.grade)}</h2><p>Puanın hangi kontrollerden oluştuğu aşağıda açıklanır.</p></div><button data-modal-close>×</button></div><div class="health-score"><i style="--score:${health.score}%"><b>${health.score}</b></i><div>${(health.checks||[]).map(check=>`<div class="health-check ${check.ok?"ok":"missing"}"><span>${check.ok?"✓":"!"}</span><div><b>${esc(check.label)}</b><small>${check.ok?`+${check.points} puan`:esc(check.advice)}</small></div></div>`).join("")}</div></div>`);return;}
    if(projectMenuAction.dataset.projectMenu==="security"){await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({activeProject:id})});await fetchState();openToolPanel("security");return;}
    if(projectMenuAction.dataset.projectMenu==="checkpoint"){await openCheckpoints(id);return;}
    if(projectMenuAction.dataset.projectMenu==="archives"){showArchivedChats=!showArchivedChats;renderProjects();renderConversations();return;}
    if(projectMenuAction.dataset.projectMenu==="manage"){openChatManager(id);return;}
    if(projectMenuAction.dataset.projectMenu==="import"){$("chat-import-file").dataset.projectId=id;$("chat-import-file").click();return;}
    if(projectMenuAction.dataset.projectMenu==="trash"){openChatManager(id,{trash:true});return;}
  }
  const runMenuAction=closest("[data-run-menu]");
  if(runMenuAction){const menu=$("run-context-menu"),id=menu.dataset.runId,run=state.runs[id];menu.hidden=true;if(!run)return;
    if(runMenuAction.dataset.runMenu==="rename"){const title=prompt("Sohbet adı",run.title||run.request);if(title)await patchRun(id,{title});}
    if(runMenuAction.dataset.runMenu==="pin")await patchRun(id,{pinned:!run.pinned});
    if(runMenuAction.dataset.runMenu==="archive")await patchRun(id,{archived:!run.archived});
    if(runMenuAction.dataset.runMenu==="transfer"){const target=prompt("Hangi ajana veya konseye devredilsin?","konsey");if(target){const response=await fetch(`/api/runs/${id}/transfer`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({target,projectId:run.projectId})});const result=await response.json();if(result.runId){selectRun(result.runId);await fetchState();}}}
    if(runMenuAction.dataset.runMenu==="tags"){const value=prompt("Etiketler (virgülle ayırın)",(run.tags||[]).join(", "));if(value!==null)await patchRun(id,{tags:value.split(",")});}
    if(runMenuAction.dataset.runMenu==="export"){const a=document.createElement("a");a.href=`/api/runs/${id}/export`;a.download=`${id}.json`;a.click();}
    if(runMenuAction.dataset.runMenu==="replay"){const events=[...(run.messages||[]).map(message=>({at:message.ts||message.createdAt,kind:message.kind||"message",title:message.fromLabel||message.from,detail:message.content,messageId:message.from==="kullanici"?message.id:null})),...(run.tasks||[]).flatMap(task=>[{at:task.startedAt,kind:"task",title:`Başladı · ${task.title}`,detail:task.assigneeName},{at:task.endedAt,kind:task.status,title:`Bitti · ${task.title}`,detail:task.status}]).filter(event=>event.at),...(run.tests||[]).map(test=>({at:test.ts,kind:test.ok?"done":"error",title:`Test ${test.ok?"geçti":"kaldı"}`,detail:test.command}))].sort((a,b)=>+new Date(a.at||0)-+new Date(b.at||0));openModal(`<div class="modal-title"><div><span class="section-kicker">OTURUM KAYDI</span><h2>${esc(run.title||run.request)}</h2><p>${events.length} kayıt · baştan sona çalışma izi</p></div><button data-modal-close>×</button></div><div class="replay-timeline">${events.map((event,index)=>`<article class="r-${esc(event.kind)}"><i></i><time>${event.at?esc(new Date(event.at).toLocaleTimeString("tr-TR")):""}</time><div><b>${esc(event.title||event.kind)}</b><p>${esc(String(event.detail||"").slice(0,500))}</p>${event.messageId?`<button data-replay-branch="${event.messageId}" data-replay-run="${id}">Buradan yeni dal aç</button>`:""}</div></article>`).join("")}</div>`);}
    if(runMenuAction.dataset.runMenu==="trash")await patchRun(id,{deletedAt:true});
    return;
  }

  // koşu seç
  const runEl = closest("[data-run]");
  if (runEl) {
    const run=state.runs[runEl.dataset.run];
    if(run?.projectId&&run.projectId!==activeProjectId()) {
      await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({activeProject:run.projectId})});
    }
    selectRun(runEl.dataset.run); showMainView("chat"); autoCloseSidebar(); fetchState(); return;
  }

  const moreProject=closest("[data-more-project]");
  if(moreProject) {
    const id=moreProject.dataset.moreProject;
    projectRunLimits.set(id,(projectRunLimits.get(id)||5)+10);
    renderProjects();
    return;
  }
  const newProjectChat=closest("[data-new-project-chat]");
  if(newProjectChat){
    await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({activeProject:newProjectChat.dataset.newProjectChat})});
    selectRun(null);showMainView("chat");autoCloseSidebar();await fetchState();$("f-request").focus();return;
  }
  const projectTerminal=closest("[data-project-terminal]");
  if(projectTerminal){
    await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({activeProject:projectTerminal.dataset.projectTerminal})});
    await fetchState();openToolPanel("terminal");autoCloseSidebar();return;
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
  if (closest("[data-pop-save]")) { await saveAgentPop(); return; }
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
  const saveProjectSettings=closest("[data-save-project-settings]");if(saveProjectSettings){await fetch(`/api/projects/${saveProjectSettings.dataset.saveProjectSettings}/settings`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({instructions:$("project-instructions").value,skills:$("project-skills").value.split("\n"),devCommand:$("project-dev-command").value,artifactExport:$("project-artifact-export").checked})});closeModal();await fetchState();return;}
  const memorySave=closest("[data-memory-save]");if(memorySave){await fetch(`/api/projects/${memorySave.dataset.memorySave}/memory`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:$("project-memory-content").value})});closeModal();return;}
  const memoryForget=closest("[data-memory-forget]");if(memoryForget){const query=prompt("Hafızadan çıkarılacak bilgi veya ifade");if(query){await fetch(`/api/projects/${memoryForget.dataset.memoryForget}/memory/forget`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query})});await openProjectMemory(memoryForget.dataset.memoryForget);}return;}
  const memoryPin=closest("[data-memory-pin]");if(memoryPin){const text=prompt("Sabitlenecek önemli bilgi");if(text){await fetch(`/api/projects/${memoryPin.dataset.memoryPin}/memory/pin`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});await openProjectMemory(memoryPin.dataset.memoryPin);}return;}
  const memoryFlag=closest("[data-memory-flag]");if(memoryFlag){const text=prompt("Eski veya çelişkili bilgi");if(text){await fetch(`/api/projects/${memoryFlag.dataset.memoryFlag}/memory/flag`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,flag:"çelişkili veya eski"})});await openProjectMemory(memoryFlag.dataset.memoryFlag);}return;}
  const bulkChat=closest("[data-bulk-chat]");if(bulkChat){const ids=[...document.querySelectorAll("[data-manage-run]:checked")].map(x=>x.dataset.manageRun),action=bulkChat.dataset.bulkChat;if(!ids.length)return;let projectId=null;if(action==="move"){const name=prompt("Hedef proje adı");projectId=state.config.projects.find(p=>p.name===name)?.id;if(!projectId)return alert("Proje bulunamadı");}for(const id of ids)await fetch(`/api/runs/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(action==="archive"?{archived:true}:action==="trash"?{deletedAt:true}:action==="restore"?{deletedAt:false}:{projectId})});closeModal();await fetchState();return;}
  const createCheckpoint=closest("[data-create-checkpoint]");if(createCheckpoint){const name=prompt("Kontrol noktası adı","Çalışan sürüm");if(name){await fetch(`/api/projects/${createCheckpoint.dataset.createCheckpoint}/checkpoints`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});await openCheckpoints(createCheckpoint.dataset.createCheckpoint);}return;}
  const restoreCheckpoint=closest("[data-restore-checkpoint]");if(restoreCheckpoint){if(confirm("Proje dosyaları bu kontrol noktasındaki hâle döndürülsün mü?")){await fetch(`/api/projects/${restoreCheckpoint.dataset.projectId}/checkpoints/${restoreCheckpoint.dataset.restoreCheckpoint}/restore`,{method:"POST"});closeModal();}return;}
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
      if(t.testCommand)$("f-test").value=t.testCommand;
      if(t.budget){$("f-budget-enabled").checked=t.budget.enabled===true;$("f-budget-calls").value=t.budget.maxCalls||24;$("f-budget-tokens").value=t.budget.maxTokens||250000;}
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
  ...JSON.parse(localStorage.getItem("ajan.workflows")||"[]"),
];

function openTemplates() {
  openModal(`
    <h2>Görev şablonları</h2>
    <div class="m-sub">Hazır playbook seçin; metni düzenleyip gönderebilirsiniz.</div>
    <div class="m-list">
      ${TEMPLATES.map((t, i) => `<button class="m-item" data-template="${i}">${t.name.split(" ")[0]} <span style="flex:1"><div>${esc(t.name.slice(t.name.indexOf(" ") + 1))}</div><small>${esc(t.text.slice(0, 80))}…</small></span></button>`).join("")}
    </div>
    <div class="m-foot"><button class="btn-ghost small" data-modal-close>Kapat</button><button class="btn-gradient small" id="save-workflow">Mevcut ayarları iş akışı olarak kaydet</button></div>`);
}

document.addEventListener("click",event=>{if(event.target.id!=="save-workflow")return;const name=prompt("İş akışının adı");if(!name)return;const item={name:`◇ ${name.trim()}`,mode:currentMode,text:$("f-request").value,testCommand:$("f-test").value,budget:{enabled:$("f-budget-enabled").checked,maxCalls:Number($("f-budget-calls").value),maxTokens:Number($("f-budget-tokens").value)},custom:true};const saved=JSON.parse(localStorage.getItem("ajan.workflows")||"[]");saved.push(item);localStorage.setItem("ajan.workflows",JSON.stringify(saved.slice(-30)));TEMPLATES.push(item);openTemplates();});

// Üye/koordinatör ayarları değişince kaydet
document.addEventListener("change", async (e) => {
  const t = e.target;
  const inConfig = t.closest("#agent-config, #agent-pop");
  if (!inConfig) return;

  // Sağlayıcı değiştiğinde eski sağlayıcının model değerini kaydetme. Model
  // kataloğunu aynı anda yenileyerek Codex seçiliyken Claude modellerinin
  // görünmesi sorununu gider.
  if (t.matches("[data-cprovider]")) {
    const model = t.closest("[data-coord]")?.querySelector("[data-cmodel]");
    if (model) model.innerHTML = modelOptsFor(t.value, "");
  }
  if (t.matches("[data-mprovider]")) {
    const model = t.closest("[data-member]")?.querySelector("[data-mmodel]");
    if (model) model.innerHTML = modelOptsFor(t.value, "");
  }

  // "Özel model yaz…" seçilirse metin iste
  if ((t.matches("[data-mmodel]") || t.matches("[data-cmodel]")) && t.value === "__custom") {
    const custom = prompt("Model kimliği:");
    if (custom === null) { render(); return; }
    t.value = custom.trim();
  }
  // Yan panel değişiklikleri anında kalıcıdır. Üst bar hızlı paneli ise
  // kullanıcının açıkça Kaydet demesini bekler.
  if (!t.closest("#agent-pop")) await saveMembers();
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
$("btn-new").addEventListener("click", async () => {
  // Yeni sohbet proje dışıdır; proje sohbetleri kendi gruplarında kalmaya devam eder.
  if (activeProjectId()) {
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeProject: null }) });
    state.config.activeProject = null;
  }
  selectRun(null); showMainView("chat"); autoCloseSidebar(); render(); $("f-request").focus();
});
$('btn-image-studio').addEventListener('click', () => { showMainView('images'); autoCloseSidebar(); });
$('image-prompt').addEventListener('input', (e) => { $('image-prompt-count').textContent = `${e.target.value.length} karakter`; });
$('image-agent-options').addEventListener('change', updateImageStudioSummary);
function configureStudioEngine(){
  const video=studioMediaKind==='video', veo=$('studio-engine').value==='veo-3.1', flow=$('studio-engine').value==='google-flow-subscription';
  const forcedEight=veo&&(studioAttachments.length>0||['high','4k'].includes($('studio-quality').value));
  $('studio-duration-wrap').hidden=!video; $('studio-duration').innerHTML=flow?'<option value="4">4 saniye</option><option value="6">6 saniye</option><option value="8" selected>8 saniye</option><option value="10">10 saniye · Omni</option>':veo?(forcedEight?'<option value="8">8 saniye · bu ayarda zorunlu</option>':'<option value="4">4 saniye</option><option value="6">6 saniye</option><option value="8" selected>8 saniye</option>'):'<option value="auto">Otomatik · Omni belirler</option>';
  if(video){ const aspect=$('studio-aspect'); aspect.innerHTML='<option>16:9</option><option>9:16</option>'; }
  $('flow-account-card').hidden=!flow;
  if(flow){refreshFlowAccountStatus();setTimeout(refreshFlowAccountStatus,2500);}
  updateImageStudioSummary();
}
async function refreshFlowAccountStatus(){if(!window.desktopAPI?.flowAccountStatus)return;const text=$('flow-account-text');const button=$('btn-flow-connect');text.textContent='Hesap durumu kontrol ediliyor…';try{const result=await window.desktopAPI.flowAccountStatus();flowAccountConnected=Boolean(result?.connected);$('flow-account-card').classList.toggle('connected',flowAccountConnected);text.textContent=flowAccountConnected?'Bağlı · üretimler görünmeden arka planda çalışır':'Bağlı değil · yalnız ilk seferde giriş penceresi açılır';button.textContent=flowAccountConnected?'Bağlı':'Hesabı bağla';button.dataset.verifying='0';}catch(error){flowAccountConnected=false;text.textContent=error.message||'Flow durumu alınamadı';}}
$('btn-flow-connect').addEventListener('click',async()=>{const button=$('btn-flow-connect');button.disabled=true;const verifying=button.dataset.verifying==='1';$('flow-account-text').textContent=verifying?'Flow oturumu doğrulanıyor…':'Google Chrome giriş penceresi açılıyor…';try{const result=await window.desktopAPI?.connectFlowAccount?.(verifying);if(result?.error)throw new Error(result.error);if(result?.connected){flowAccountConnected=true;$('flow-account-card').classList.add('connected');$('flow-account-text').textContent='Bağlı · üretimler görünmeden arka planda çalışır';button.dataset.verifying='0';button.textContent='Bağlı';}else{button.dataset.verifying='1';button.textContent='Bağlantıyı doğrula';$('flow-account-text').textContent='Chrome’da giriş yapın; Flow açılınca buraya dönüp “Bağlantıyı doğrula”ya basın.';}}catch(error){$('flow-account-text').textContent=error.message;}finally{button.disabled=false;}});
window.desktopAPI?.onFlowVideoStatus?.((detail)=>{if(detail?.type==='account-check'){setTimeout(refreshFlowAccountStatus,800);return;}if(detail?.type==='account'){flowAccountConnected=true;$('flow-account-card').classList.add('connected');$('flow-account-text').textContent='Bağlı · üretimler görünmeden arka planda çalışır';return;}if(detail?.runId){const error=$('image-studio-error');if(detail.type==='error'){error.textContent=detail.error;error.hidden=false;}else{error.hidden=true;}fetchState().then(renderImageBatchStatus);}});
$('studio-engine').addEventListener('change', configureStudioEngine);
$('studio-quality').addEventListener('change',configureStudioEngine); $('studio-duration').addEventListener('change',updateImageStudioSummary);
document.querySelectorAll('[data-media-kind]').forEach((button)=>button.addEventListener('click',()=>{
  studioMediaKind=button.dataset.mediaKind;
  document.querySelectorAll('.media-kind-tabs [data-media-kind]').forEach((b)=>b.classList.toggle('active',b===button));
  const engine=$('studio-engine');
  engine.innerHTML=studioMediaKind==='video'
    ? '<option value="google-flow-subscription">Google Flow · PRO aboneliği</option>'
    : '<option value="openai-image">OpenAI · GPT Image</option><option value="gemini-flash-image">Gemini · Nano Banana 2</option><option value="gemini-pro-image">Gemini · Nano Banana Pro</option>';
  $('studio-count-wrap').hidden=studioMediaKind==='video'; $('image-count-number').value=studioMediaKind==='video'?1:$('image-count-number').value;
  $('studio-submit-label').textContent=studioMediaKind==='video'?'Video oluştur':'Görsel oluştur';
  $('studio-prompt-help').textContent=studioMediaKind==='video'?'Sahneyi, kamera hareketini, süreyi ve sesi tarif edin.':'Üretmek veya düzenlemek istediğinizi doğal dille yazın.';
  configureStudioEngine();
}));
document.querySelectorAll('[data-studio-prompt]').forEach((b)=>b.addEventListener('click',()=>{ $('image-prompt').value=b.dataset.studioPrompt; $('image-prompt').dispatchEvent(new Event('input')); $('image-prompt').focus(); }));
function renderStudioReferences(){ const box=$('studio-reference-list'); box.hidden=!studioAttachments.length; box.innerHTML=studioAttachments.map((a,i)=>`<span><img src="${esc(a.previewUrl||a.url)}" alt=""><button type="button" data-studio-rm="${i}">×</button></span>`).join(''); box.querySelectorAll('[data-studio-rm]').forEach((b)=>b.onclick=()=>{studioAttachments.splice(Number(b.dataset.studioRm),1);renderStudioReferences();}); if(studioMediaKind==='video')configureStudioEngine(); }
async function uploadStudioReference(file){
  const previewUrl=URL.createObjectURL(file), data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
  const response=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name||'referans.png',data})}); const item=await response.json(); if(!response.ok||item.error){URL.revokeObjectURL(previewUrl);throw new Error(item.error||'Referans yüklenemedi');} studioAttachments.push({...item,previewUrl}); renderStudioReferences();
}
$('btn-studio-reference').addEventListener('click',()=>$('studio-reference-file').click());
$('studio-reference-file').addEventListener('change',async(e)=>{try{for(const file of e.target.files)await uploadStudioReference(file);}catch(err){$('image-studio-error').textContent=err.message;$('image-studio-error').hidden=false;}e.target.value='';});
document.addEventListener('paste',async(e)=>{
  if(activeMainView!=="images")return;
  const files=[...(e.clipboardData?.items||[])].filter((item)=>item.kind==="file"&&item.type.startsWith("image/")).map((item)=>item.getAsFile()).filter(Boolean);
  if(!files.length)return;
  e.preventDefault(); const drop=$('btn-studio-reference'); drop.classList.add('receiving');
  try{for(const file of files)await uploadStudioReference(file);$('image-studio-error').hidden=true;}
  catch(err){$('image-studio-error').textContent=err.message;$('image-studio-error').hidden=false;}
  finally{drop.classList.remove('receiving');}
});
$('btn-studio-reference').addEventListener('dragover',(e)=>{e.preventDefault();e.currentTarget.classList.add('receiving');});
$('btn-studio-reference').addEventListener('dragleave',(e)=>e.currentTarget.classList.remove('receiving'));
$('btn-studio-reference').addEventListener('drop',async(e)=>{e.preventDefault();e.currentTarget.classList.remove('receiving');try{for(const file of [...(e.dataTransfer?.files||[])].filter((f)=>f.type.startsWith('image/')))await uploadStudioReference(file);}catch(err){$('image-studio-error').textContent=err.message;$('image-studio-error').hidden=false;}});
$('btn-enhance-prompt').addEventListener('click',async()=>{
  const text=$('image-prompt').value.trim(), button=$('btn-enhance-prompt'), error=$('image-studio-error');
  if(!text){error.textContent='Önce kısa fikrinizi yazın.';error.hidden=false;$('image-prompt').focus();return;}
  error.hidden=true; button.disabled=true; button.classList.add('busy');
  try{const response=await fetch('/api/studio/enhance-prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,mediaKind:studioMediaKind,engine:$('studio-engine').value,aspect:$('studio-aspect').value,quality:$('studio-quality').value,duration:$('studio-duration').value,attachments:studioAttachments})});const result=await response.json();if(!response.ok||result.error)throw new Error(result.error||'Prompt güçlendirilemedi');$('image-prompt').value=result.prompt;$('image-prompt').dispatchEvent(new Event('input'));}
  catch(err){error.textContent=err.message;error.hidden=false;}finally{button.disabled=false;button.classList.remove('busy');}
});
function syncImageCount(value) {
  const n = Math.max(1, Math.min(30, Number(value) || 1));
  $('image-count').value = n; $('image-count-number').value = n; updateImageStudioSummary();
}
$('image-count').addEventListener('input', (e) => syncImageCount(e.target.value));
$('image-count-number').addEventListener('input', (e) => syncImageCount(e.target.value));
$('image-studio-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('image-prompt').value.trim();
  const flowSubscription=studioMediaKind==='video'&&$('studio-engine').value==='google-flow-subscription';
  const provider=$('studio-engine').value==='openai-image'?'codex':'antigravity';
  const agent=imageStudioMembers().find((m)=>m.provider===provider)?.id;
  const agents = flowSubscription ? [] : (agent ? [agent] : []);
  const error = $('image-studio-error');
  if (!prompt || (!flowSubscription&&!agents.length)) { error.textContent = !prompt ? 'Üretim talimatını yazın.' : `${provider==='codex'?'Codex':'Antigravity'} etkin değil.`; error.hidden = false; return; }
  error.hidden = true;
  const button = $('btn-start-image-batch'); button.disabled = true; button.classList.add('busy');
  try {
    const payload={ prompt, agents, mediaKind:studioMediaKind, engine:$('studio-engine').value, aspect:$('studio-aspect').value, quality:$('studio-quality').value, duration:$('studio-duration').value, count:studioMediaKind==='video'?1:Number($('image-count-number').value), attachments:studioAttachments };
    const response = await fetch(flowSubscription?'/api/flow-video-runs':'/api/image-batches', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Görsel grubu başlatılamadı.');
    if (result.runId) activeStudioRunId=result.runId;
    if(flowSubscription&&result.runId){const started=await window.desktopAPI?.runFlowVideo?.({runId:result.runId,prompt:result.prompt||prompt,aspect:payload.aspect,quality:payload.quality,duration:payload.duration,attachments:studioAttachments});if(started?.error)throw new Error(started.error);}
    await fetchState(); renderImageBatchStatus();
  } catch (err) { error.textContent = err.message; error.hidden = false; }
  finally { button.disabled = false; button.classList.remove('busy'); }
});
$("conversation-search").addEventListener("input", (e) => {
  conversationSearch = e.target.value;
  renderConversations();
  renderProjects();
});
$("chat-import-file").addEventListener("change",async e=>{const file=e.target.files[0];if(!file)return;try{const body=JSON.parse(await file.text());body.projectId=e.target.dataset.projectId;const response=await fetch("/api/runs/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),result=await response.json();if(!response.ok)throw new Error(result.error);selectRun(result.runId);await fetchState();}catch(error){alert(error.message);}e.target.value="";});
$("btn-details").addEventListener("click", () => $("details").classList.toggle("closed"));
$("open-output-center").addEventListener("click",async()=>{const project=activeProject();if(!project)return alert("Önce proje seçin");const data=await fetch(`/api/projects/${project.id}/artifacts`).then(response=>response.json());const groups={};for(const file of data.artifacts||[]){const ext=(file.name.split(".").pop()||"dosya").toUpperCase();(groups[ext]??=[]).push(file);}openModal(`<div class="modal-title"><div><span class="section-kicker">ÇIKTI MERKEZİ</span><h2>${esc(project.name)} çıktıları</h2><p>${(data.artifacts||[]).length} üretim ve proje dosyası</p></div><button data-modal-close>×</button></div><div class="output-center">${Object.entries(groups).map(([type,files])=>`<section><h3>${esc(type)} <span>${files.length}</span></h3>${files.map(file=>`<button class="artifact-link" data-artifact-path="${esc(file.path)}"><b>${esc(file.relative)}</b><small>${(file.size/1024).toFixed(1)} KB · ${esc(new Date(file.mtimeMs).toLocaleString("tr-TR"))}</small></button>`).join("")}</section>`).join("")||'<div class="muted">Henüz çıktı yok.</div>'}</div>`);$("tool-menu").hidden=true;});

const toolBodyIds=["tool-terminal","tool-browser","tool-preview","tool-editor","tool-tasks","tool-security","tool-git"];
const toolIconIds={terminal:"i-terminal",browser:"i-browser",preview:"i-inspect",editor:"i-files",tasks:"i-tasks",security:"i-sliders",git:"i-git",menu:"i-apps"};
function setToolCurrentIcon(kind){$("tool-current-icon").innerHTML=`<svg class="ui-icon" aria-hidden="true"><use href="#${toolIconIds[kind]||toolIconIds.menu}"></use></svg>`;}
function closeToolPanel(){
  $("tool-panel").classList.add("closed");
  $("btn-tools").setAttribute("aria-expanded","false");
}
function showToolPicker(){
  $("tool-panel").classList.remove("closed");
  toolBodyIds.forEach(id=>$(id).hidden=true);
  $("tool-menu").hidden=false;
  setToolCurrentIcon("menu");
  $("tool-current-title").textContent="Araçlar";
  $("btn-tools").setAttribute("aria-expanded","true");
}
function openToolPanel(tab) {
  $("tool-panel").classList.remove("closed");
  $("tool-menu").hidden = true;
  $("btn-tools").setAttribute("aria-expanded", "true");
  const toolMeta={terminal:"Terminal",browser:"Tarayıcı",preview:"İncele",editor:"Dosyalar",tasks:"Görevler",security:"Proje ayarları",git:"Git ve test"}[tab]||"Araç";
  setToolCurrentIcon(tab);
  $("tool-current-title").textContent=toolMeta;
  document.querySelectorAll("[data-tool-tab]").forEach((b) => b.classList.toggle("active", b.dataset.toolTab === tab));
  $("tool-terminal").hidden = tab !== "terminal";
  $("tool-browser").hidden = tab !== "browser";
  $("tool-preview").hidden = tab !== "preview";
  $("tool-editor").hidden = tab !== "editor";
  $("tool-tasks").hidden = tab !== "tasks";
  $("tool-security").hidden = tab !== "security";
  $("tool-git").hidden = tab !== "git";
  if (tab === "terminal") $("terminal-command").focus();
  if (tab === "browser" && !activeBrowserView()) createBrowserTab($("browser-url").value);
  if(tab==="editor")loadEditorTree();
  if(tab==="tasks")renderTaskCenter();
  if(tab==="security")renderSecurityCenter();
  if(tab==="git")renderGitCenter();
}
let gitDiffMode="working";
async function renderGitCenter(){const project=activeProject(),actions=[$("git-run-test"),$("git-commit")];$("git-empty").hidden=!!project;$("git-content").hidden=!project;actions.forEach(button=>button.disabled=!project);if(!project){$("git-summary").textContent="Başlamak için bir proje seçin.";return;}$("git-summary").textContent="Git durumu okunuyor…";try{const [status,log,diff]=await Promise.all([fetch(`/api/projects/${project.id}/git/status`).then(r=>r.json()),fetch(`/api/projects/${project.id}/git/log`).then(r=>r.json()),fetch(`/api/projects/${project.id}/git/diff?staged=${gitDiffMode==="staged"?1:0}`).then(r=>r.json())]);if(status.error)throw new Error(status.error);$("git-summary").textContent=`${project.name} · ${status.branch} · ${status.ahead} ileri · ${status.behind} geri · ${(status.files||[]).length} değişiklik`;$("git-files").innerHTML=(status.files||[]).map(file=>`<div class="git-file"><code>${esc(file.code)}</code><span>${esc(file.path)}</span></div>`).join("")||'<div class="skill-empty"><div><span>✓</span><b>Çalışma ağacı temiz</b><small>Commit edilmemiş değişiklik bulunmuyor.</small></div></div>';$("git-log").innerHTML=(log.commits||[]).map(commit=>`<div class="git-commit"><b>${esc(commit.subject)}</b><small>${esc(commit.short)} · ${esc(new Date(commit.date).toLocaleString("tr-TR"))}</small></div>`).join("")||'<div class="muted">Henüz commit yok.</div>';$("git-diff").textContent=diff.diff||"Bu bölümde değişiklik yok.";}catch(error){$("git-summary").textContent=`${project.name} · Git kullanılamıyor`;$("git-files").innerHTML=`<div class="skill-empty"><div><span>!</span><b>Git bilgisi okunamadı</b><small>${esc(error.message)}</small></div></div>`;$("git-log").innerHTML="";$("git-diff").textContent="Proje bir Git deposu olmayabilir.";}}
const securityCapabilities={files:{label:"Proje dosyaları",description:"Dosyaları okuma, oluşturma ve düzenleme"},terminal:{label:"Terminal",description:"Proje klasöründe komut çalıştırma"},browser:{label:"Tarayıcı",description:"Sayfalarda gezinme, tıklama ve yazma"},publish:{label:"GitHub yayını",description:"Commitleri uzak depoya gönderme"},externalServices:{label:"Harici servisler",description:"Bağlı servis ve hesapları kullanma"}};
const auditLabels={"permissions.update":"Proje izinleri güncellendi","skill.save":"Yetenek paketi kaydedildi","skill.toggle":"Yetenek durumu değiştirildi","skill.delete":"Yetenek paketi silindi","file.write":"Dosya kaydedildi","test.run":"Test çalıştırıldı","git.commit":"Commit oluşturuldu","chat.update":"Sohbet güncellendi"};
function auditSummary(item){const detail=item.detail||{};if(item.action==="permissions.update"){const [key,value]=Object.entries(detail)[0]||[];return `${securityCapabilities[key]?.label||key}: ${value==="allow"?"İzin verildi":value==="deny"?"Engellendi":"Her seferinde sor"}`;}if(detail.name)return detail.name;if(detail.message)return detail.message;if(detail.command)return detail.command;if(detail.path)return detail.path;return "İşlem başarıyla uygulandı";}
function openSkillModal(){openModal(`<div class="skill-modal"><div class="modal-title"><div><span class="section-kicker">YENİ YETENEK</span><h2>Yetenek paketi oluştur</h2><p>Ajanların tekrar kullanabileceği talimatı ve isteğe bağlı komutu tanımlayın.</p></div><button type="button" data-modal-close>×</button></div><form id="skill-form"><label><b>Yetenek adı</b><input name="name" required autofocus placeholder="Örn. Kod kalite kontrolü"></label><label><b>Sürüm</b><input name="version" value="1.0.0" required></label><label class="skill-modal-wide"><b>Ajan talimatları</b><small>Bu yetenek etkin olduğunda ajanların izleyeceği açık kurallar.</small><textarea name="instructions" placeholder="Değişiklikleri incele, testleri çalıştır ve bulguları önem sırasına göre raporla."></textarea></label><label class="skill-modal-wide"><b>Güvenli komut <small>(isteğe bağlı)</small></b><input name="command" placeholder="npm test"></label><div class="form-error skill-modal-wide" hidden></div><div class="modal-actions skill-modal-wide"><button type="button" data-modal-close>Vazgeç</button><button type="submit" class="primary-action">Yeteneği kaydet</button></div></form></div>`);requestAnimationFrame(()=>$('skill-form')?.elements.name.focus());}
const skillCatalog=[
  {id:"quality",name:"Kod kalite denetimi",version:"1.0.0",permissions:["Dosya okuma","Terminal"],instructions:"Değişiklikleri doğruluk, güvenlik, performans ve test kapsamı açısından incele. Bulguları önem sırasıyla dosya:satır kanıtıyla raporla.",command:"npm test"},
  {id:"ui-audit",name:"Görsel arayüz denetimi",version:"1.0.0",permissions:["Tarayıcı","Ekran görüntüsü"],instructions:"Masaüstü, tablet ve telefon görünümlerini denetle; taşma, örtüşme, okunabilirlik ve etkileşim hatalarını kanıtlarıyla raporla."},
  {id:"release",name:"Güvenli sürüm hazırlama",version:"1.0.0",permissions:["Git","Terminal","Yayın için onay"],instructions:"Testleri çalıştır, değişiklikleri özetle, sürüm notu hazırla ve yalnız açık kullanıcı onayından sonra yayınla."},
  {id:"research",name:"Kaynaklı araştırma",version:"1.0.0",permissions:["Tarayıcı"],instructions:"Güncel iddiaları birincil kaynaklardan doğrula, bağlantıları ekle ve gerçeklerle çıkarımları ayır."},
  {id:"bug-repair",name:"Otomatik hata onarma",version:"1.0.0",permissions:["Dosya okuma","Terminal"],instructions:"Hatayı yeniden üret, kök nedeni bul, en küçük güvenli düzeltmeyi uygula ve regresyon testiyle doğrula."},
  {id:"performance",name:"Performans denetimi",version:"1.0.0",permissions:["Tarayıcı","Terminal"],instructions:"Yavaş açılışları, ağır sorguları ve gereksiz kaynak kullanımını ölç; ölçüm öncesi ve sonrası kanıtlarla iyileştir."},
  {id:"accessibility",name:"Erişilebilirlik kontrolü",version:"1.0.0",permissions:["Tarayıcı"],instructions:"Klavye kullanımı, odak sırası, kontrast, etiketler ve ekran okuyucu uyumluluğunu denetle."},
  {id:"dependency",name:"Bağımlılık sağlığı",version:"1.0.0",permissions:["Dosya okuma","Terminal"],instructions:"Eski, çakışan veya riskli bağımlılıkları saptayıp güvenli yükseltme planı ve doğrulama komutları hazırla."},
  {id:"handoff",name:"Belge ve devir paketi",version:"1.0.0",permissions:["Dosya okuma"],instructions:"Yapılan değişiklikleri, kararları, test kanıtlarını ve sonraki adımları kısa ve yeniden kullanılabilir bir devir belgesinde topla."},
  {id:"data-safety",name:"Veri güvenliği kontrolü",version:"1.0.0",permissions:["Dosya okuma"],instructions:"Gizli bilgiler, kişisel veriler, günlük sızıntıları ve güvensiz saklama kalıplarını inceleyip güvenli düzeltmeler öner."}
];
async function openSkillMarket(){const data=await fetch("/api/workspace").then(r=>r.json()),installed=new Set((data.skills||[]).flatMap(skill=>[skill.id,String(skill.name||"").trim().toLocaleLowerCase("tr-TR")]));openModal(`<div class="skill-modal skill-market-modal"><div class="modal-title"><div><span class="section-kicker">YETENEK MAĞAZASI</span><h2>Hazır yetenekler</h2><p>İş akışınıza uygun, güvenli ve tekrar kullanılabilir paketler.</p></div><button data-modal-close>×</button></div><div class="skill-market-list">${skillCatalog.map((skill,index)=>{const ready=installed.has(skill.id)||installed.has(skill.name.toLocaleLowerCase("tr-TR"));return`<article class="${ready?"installed":""}"><span class="skill-market-icon c${index%6}">${esc(skill.name.slice(0,1))}</span><div><b>${esc(skill.name)}</b><small>v${skill.version} · ${esc(skill.permissions.join(" · "))}</small><p>${esc(skill.instructions)}</p></div><button data-install-skill="${skill.id}" ${ready?"disabled":""}>${ready?"Kurulu ✓":"Kur"}</button></article>`;}).join("")}</div></div>`);}
async function renderSecurityCenter(){
  const project=activeProject(),projectId=project?.id||"global",data=await fetch("/api/workspace").then(r=>r.json()),permissions=data.permissions?.[projectId]||{};
  $("security-permissions").innerHTML=Object.entries(securityCapabilities).map(([key,cap])=>{const value=permissions[key]||"ask";return`<label class="permission-row" data-state="${value}"><span class="permission-copy"><b>${esc(cap.label)}</b><small>${esc(cap.description)}</small></span><select data-security-permission="${key}"><option value="ask" ${value==="ask"?"selected":""}>Her seferinde sor</option><option value="allow" ${value==="allow"?"selected":""}>İzin ver</option><option value="deny" ${value==="deny"?"selected":""}>Engelle</option></select></label>`;}).join("");
  $("security-skills").innerHTML=(data.skills||[]).length?(data.skills||[]).map((skill,index)=>{const enabled=(skill.enabledProjects||[]).includes(projectId);return`<article class="skill-row ${enabled?"enabled":""}"><span class="skill-card-icon c${index%6}">${esc(String(skill.name||"Y").slice(0,1))}</span><div class="skill-copy"><b>${esc(skill.name)}</b><small>v${esc(skill.version||"1.0.0")}</small><p>${esc(skill.instructions||skill.command||"Talimat yok")}</p></div><label class="skill-switch" title="Bu projede etkinleştir"><input type="checkbox" data-security-skill="${skill.id}" ${enabled?"checked":""}><i></i></label><button class="skill-delete" data-delete-skill="${skill.id}" title="Yetenek paketini sil">×</button></article>`;}).join(""):'<div class="skill-empty"><div><span>⌾</span><b>Henüz yetenek paketi yok</b><small>Sık kullandığınız talimatları paketleyip projelerde tek tıkla etkinleştirin.</small></div></div>';
  $("security-audit").innerHTML=[...(data.audit||[])].reverse().slice(0,30).map(item=>`<div class="audit-row"><span class="audit-icon">${item.action.startsWith("skill")?"⌾":item.action.startsWith("permission")?"✓":"·"}</span><span class="audit-copy"><b>${esc(auditLabels[item.action]||"Çalışma alanı güncellendi")}</b><small>${esc(auditSummary(item))}</small></span><time>${esc(new Date(item.ts).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}))}</time></div>`).join("")||'<div class="audit-empty">Henüz etkinlik kaydı yok.</div>';
}
async function checkApplicationUpdate(){if(!window.desktopAPI?.updateStatus){$("update-status").textContent="Güncelleme denetimi masaüstü uygulamasında kullanılabilir.";return;}$("update-status").textContent="GitHub sürümü denetleniyor…";const result=await window.desktopAPI.updateStatus();if(result.error){$("update-status").textContent=`Denetim başarısız: ${result.error}`;$("update-download").hidden=true;return;}$("update-status").textContent=result.available?`${result.current} yüklü · ${result.latest} indirilebilir`:`${result.current} güncel · ${result.message||result.latest||""}`;$("update-download").hidden=!(result.available&&result.asset);$("update-notes").hidden=!result.notes;$("update-notes").textContent=result.notes||"";}
async function renderTaskCenter(){const data=await fetch("/api/workspace").then(r=>r.json()),tasks=data.tasks||[],leases=data.leases||[];$("resource-lease-list").innerHTML=leases.length?leases.map(lease=>`<div class="resource-lease-row"><span>${lease.type==="port"?"⇄":lease.type==="external-service"?"↗":"◇"}</span><div><b>${esc(lease.key)}</b><small>${esc(lease.owner?.label||lease.owner?.agentId||lease.owner?.runId||"Bilinmeyen sahip")}</small></div><time>${esc(new Date(lease.expiresAt).toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"}))}</time></div>`).join(""):'<div class="resource-lease-empty">Şu anda ayrılmış kaynak yok.</div>';$("task-center-list").innerHTML=tasks.length?tasks.map(t=>{const contract=t.contract||{},ready=contract.status==="ready";return`<article class="task-card"><div class="task-card-head"><b>${esc(t.title)}</b><span class="task-status">${esc(t.status)}</span></div><small>${esc(t.phase||t.kind||"")}</small><div class="task-contract-summary ${ready?"ready":"draft"}"><span>${ready?"✓":"!"}</span><div><b>Görev sözleşmesi · ${ready?"Hazır":"Taslak"}</b><small>${esc(contract.goal||"Hedef henüz tanımlanmadı")}</small></div></div><div class="task-progress"><i style="width:${Number(t.progress)||0}%"></i></div><div class="task-actions"><button data-task-contract="${t.id}">Sözleşmeyi düzenle</button>${["running","queued"].includes(t.status)?`<button data-task-action="pause" data-task-id="${t.id}">Duraklat</button>`:""}${["paused","failed","interrupted","stopped","evidence_blocked"].includes(t.status)?`<button data-task-action="resume" data-task-id="${t.id}">Sürdür</button><button data-task-action="retry" data-task-id="${t.id}">Yeniden dene</button>`:""}${!["done","cancelled"].includes(t.status)?`<button data-task-action="cancel" data-task-id="${t.id}">İptal</button>`:""}</div></article>`;}).join(""):'<div class="muted" style="padding:20px">Henüz görev yok.</div>';}
function contractLines(value){return (value||[]).join("\n");}
async function openTaskContract(taskId){const response=await fetch(`/api/workspace/tasks/${taskId}/contract`),contract=await response.json();if(!response.ok)return alert(contract.error);openModal(`<div class="contract-modal"><div class="modal-title"><div><span class="section-kicker">GÖREV SINIRLARI</span><h2>Görev sözleşmesi</h2><p>Ajanın hedefini, erişebileceği alanları ve tamamlanma ölçütlerini belirleyin.</p></div><button data-close-modal>×</button></div><form id="task-contract-form" data-task-id="${taskId}"><label class="contract-wide"><b>Hedef</b><small>Bu görev sonunda ortaya çıkması gereken sonuç.</small><textarea name="goal" required>${esc(contract.goal||"")}</textarea></label><label><b>Kapsam dışı</b><small>Her satıra yapılmaması gereken bir iş.</small><textarea name="nonGoals">${esc(contractLines(contract.nonGoals))}</textarea></label><label><b>Kabul kriterleri</b><small>Her satır doğrulanabilir bir sonuç olmalı.</small><textarea name="acceptanceCriteria" required>${esc(contractLines(contract.acceptanceCriteria))}</textarea></label><label><b>İzin verilen yollar</b><small>Projeye göre yollar; ör. src/**</small><textarea name="allowedPaths" required>${esc(contractLines(contract.allowedPaths))}</textarea></label><label><b>Yasak yollar</b><small>Ajanın değiştirmemesi gereken alanlar.</small><textarea name="forbiddenPaths">${esc(contractLines(contract.forbiddenPaths))}</textarea></label><label><b>Test komutları</b><small>Her satıra bir doğrulama komutu.</small><textarea name="testCommands">${esc(contractLines(contract.testCommands))}</textarea></label><label><b>Onay sınırları</b><small>İnsan onayı gerektiren işlemler.</small><textarea name="approvalBoundaries">${esc(contractLines(contract.approvalBoundaries))}</textarea></label><label class="contract-risk"><b>Risk seviyesi</b><select name="risk">${[["low","Düşük"],["medium","Orta"],["high","Yüksek"],["critical","Kritik"]].map(([value,label])=>`<option value="${value}" ${contract.risk===value?"selected":""}>${label}</option>`).join("")}</select></label><div class="contract-errors" ${contract.errors?.length?"":"hidden"}>${esc((contract.errors||[]).join(" · "))}</div><div class="modal-actions"><button type="button" data-close-modal>Vazgeç</button><button type="submit" class="primary-action">Sözleşmeyi kaydet</button></div></form></div>`);}
$("task-refresh").addEventListener("click",renderTaskCenter);
$("task-schedule").addEventListener("click",async()=>{const request=prompt("Zamanlanacak görev");if(!request)return;const at=prompt("Başlangıç zamanı (YYYY-MM-DD HH:mm)",new Date(Date.now()+3600000).toISOString().slice(0,16).replace("T"," "));if(!at)return;const response=await fetch("/api/workspace/schedules",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request,at,projectId:activeProject()?.id||null})}),result=await response.json();if(!response.ok)return alert(result.error);alert(`Görev zamanlandı: ${new Date(result.at).toLocaleString("tr-TR")}`);await renderTaskCenter();});
$("task-center-list").addEventListener("click",async e=>{const contractButton=e.target.closest("[data-task-contract]");if(contractButton)return openTaskContract(contractButton.dataset.taskContract);const b=e.target.closest("[data-task-action]");if(!b)return;const r=await fetch(`/api/workspace/tasks/${b.dataset.taskId}/${b.dataset.taskAction}`,{method:"POST"});if(!r.ok)alert((await r.json()).error);await renderTaskCenter();await fetchState();});
$("modal-card").addEventListener("submit",async e=>{
  if(e.target.id==="skill-form"){
    e.preventDefault();
    const form=e.target,button=form.querySelector('[type="submit"]'),error=form.querySelector(".form-error"),data=Object.fromEntries(new FormData(form));
    button.disabled=true;error.hidden=true;
    try{
      const response=await fetch("/api/workspace/skills",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),result=await response.json();
      if(!response.ok)throw new Error(result.error||"Yetenek kaydedilemedi.");
      closeModal();await renderSecurityCenter();
    }catch(reason){error.textContent=reason.message;error.hidden=false;}finally{button.disabled=false;}
    return;
  }
  if(e.target.id!=="task-contract-form")return;
  e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form));for(const key of ["nonGoals","allowedPaths","forbiddenPaths","acceptanceCriteria","testCommands","approvalBoundaries"])data[key]=String(data[key]||"").split("\n");const button=form.querySelector('[type="submit"]');button.disabled=true;const response=await fetch(`/api/workspace/tasks/${form.dataset.taskId}/contract`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),result=await response.json();button.disabled=false;if(!response.ok)return alert(result.error);closeModal();await renderTaskCenter();
});
$("security-refresh").addEventListener("click",renderSecurityCenter);
$("update-check").addEventListener("click",checkApplicationUpdate);
$("update-download").addEventListener("click",async()=>{if(!window.desktopAPI?.downloadUpdate)return;$("update-status").textContent="Güncelleme paketi indiriliyor…";$("update-download").disabled=true;const result=await window.desktopAPI.downloadUpdate();$("update-download").disabled=false;if(result.error){$("update-status").textContent=`İndirme başarısız: ${result.error}`;return;}$("update-status").textContent=`Paket doğrulandı ve Finder’da gösterildi · SHA-256: ${result.sha256.slice(0,12)}…`;});
$("security-new-skill").addEventListener("click",openSkillModal);
$("security-market").addEventListener("click",openSkillMarket);
$("modal-card").addEventListener("click",async event=>{const button=event.target.closest("[data-install-skill]");if(!button)return;const skill=skillCatalog.find(item=>item.id===button.dataset.installSkill);if(!skill)return;button.disabled=true;const response=await fetch("/api/workspace/skills",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(skill)});if(!response.ok){button.disabled=false;return alert((await response.json()).error||"Yetenek kurulamadı");}button.textContent="Kuruldu";await renderSecurityCenter();});
$("modal-card").addEventListener("click",async event=>{const button=event.target.closest("[data-replay-branch]");if(!button)return;const response=await fetch(`/api/runs/${button.dataset.replayRun}/branch`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messageId:button.dataset.replayBranch})}),result=await response.json();if(!response.ok)return alert(result.error);closeModal();selectRun(result.runId);await fetchState();});
$("security-permissions").addEventListener("change",async e=>{const input=e.target.closest("[data-security-permission]");if(!input)return;const projectId=activeProject()?.id||"global";input.disabled=true;try{const response=await fetch("/api/workspace/permissions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId,permissions:{[input.dataset.securityPermission]:input.value}})});if(!response.ok)throw new Error((await response.json()).error||"İzin kaydedilemedi");await renderSecurityCenter();}catch(error){alert(error.message);await renderSecurityCenter();}finally{input.disabled=false;}});
$("security-skills").addEventListener("change",async e=>{const input=e.target.closest("[data-security-skill]");if(!input)return;await fetch(`/api/workspace/skills/${input.dataset.securitySkill}/enable`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:activeProject()?.id||"global",enabled:input.checked})});await renderSecurityCenter();});
$("security-skills").addEventListener("click",async e=>{const button=e.target.closest("[data-delete-skill]");if(!button||!confirm("Yetenek paketi silinsin mi?"))return;await fetch(`/api/workspace/skills/${button.dataset.deleteSkill}`,{method:"DELETE"});await renderSecurityCenter();});
$("git-refresh").addEventListener("click",renderGitCenter);
document.querySelectorAll("[data-git-diff]").forEach(button=>button.addEventListener("click",()=>{gitDiffMode=button.dataset.gitDiff;document.querySelectorAll("[data-git-diff]").forEach(x=>x.classList.toggle("active",x===button));renderGitCenter();}));
$("git-run-test").addEventListener("click",async()=>{const project=activeProject();if(!project)return;const command=prompt("Test komutu",project.testCommand||"npm test");if(!command)return;$("git-test-output").textContent=`$ ${command}\n\nÇalışıyor…`;const response=await fetch(`/api/projects/${project.id}/git/test`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command})}),result=await response.json();$("git-test-output").textContent=`$ ${command}\n\n${result.output||result.error||"Çıktı yok"}`;await renderTaskCenter();});
$("git-commit").addEventListener("click",async()=>{const project=activeProject();if(!project)return;const message=prompt("Commit mesajı");if(!message)return;const response=await fetch(`/api/projects/${project.id}/git/commit`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message})}),result=await response.json();if(!response.ok)return alert(result.error);await renderGitCenter();});
let editorFile="";
function editorProject(){return activeProject();}
function renderEditorTree(items,depth=0){return(items||[]).map(x=>x.kind==="dir"?`<div class="editor-dir" style="padding-left:${depth*9}px"><small>${esc(x.name)}</small>${renderEditorTree(x.children,depth+1)}</div>`:`<button class="editor-file" style="padding-left:${7+depth*9}px" data-editor-file="${esc(x.path)}">${esc(x.name)}</button>`).join("");}
async function loadEditorTree(){const p=editorProject();$("editor-new").disabled=!p;$("editor-save").disabled=!p||!editorFile;$("editor-search").disabled=!p;if(!p){$("editor-tree").innerHTML='<div class="skill-empty"><div><span>⌘</span><b>Proje seçin</b><small>Dosya ağacı burada görünecek.</small></div></div>';$("editor-path").textContent="Proje seçilmedi";$("editor-content").value="";$("editor-content").disabled=true;return;}$("editor-content").disabled=false;const data=await fetch(`/api/projects/${p.id}/files/tree`).then(r=>r.json());$("editor-tree").innerHTML=renderEditorTree(data.tree);}
async function openEditorFile(file){const p=editorProject(),data=await fetch(`/api/projects/${p.id}/files/read?path=${encodeURIComponent(file)}`).then(r=>r.json());if(data.error)return alert(data.error);editorFile=data.path;$("editor-path").textContent=data.path;$("editor-content").value=data.content;$("editor-save").disabled=false;}
$("editor-tree").addEventListener("click",e=>{const b=e.target.closest("[data-editor-file]");if(b)openEditorFile(b.dataset.editorFile);});
$("editor-save").addEventListener("click",async()=>{const p=editorProject();if(!p||!editorFile)return;const r=await fetch(`/api/projects/${p.id}/files/write`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:editorFile,content:$("editor-content").value})});if(!r.ok)alert((await r.json()).error);});
$("editor-new").addEventListener("click",async()=>{const p=editorProject(),name=prompt("Yeni dosya yolu","src/yeni-dosya.js");if(!p||!name)return;const r=await fetch(`/api/projects/${p.id}/files/create`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:name,kind:"file"})});if(!r.ok)return alert((await r.json()).error);await loadEditorTree();openEditorFile(name);});
$("editor-search").addEventListener("input",async e=>{const p=editorProject(),q=e.target.value.trim();if(!p)return;if(q.length<2)return loadEditorTree();const data=await fetch(`/api/projects/${p.id}/files/search?q=${encodeURIComponent(q)}`).then(r=>r.json());$("editor-tree").innerHTML=(data.results||[]).map(x=>`<button class="editor-file" data-editor-file="${esc(x.path)}">${esc(x.path)}</button>`).join("");});
function openArtifact(filePath){const project=activeProject();if(!project)return alert("Önce dosyanın bağlı olduğu projeyi seçin.");const src=`/api/project-file?projectId=${encodeURIComponent(project.id)}&path=${encodeURIComponent(filePath)}`;$("preview-title").textContent=filePath.split("/").pop();$("preview-frame").src=src;$("preview-external").href=src;$("preview-empty").hidden=true;openToolPanel("preview");}
$("preview-refresh").addEventListener("click",()=>{const frame=$("preview-frame");if(frame.src)frame.src=frame.src;});
function normalizeBrowserUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "http://localhost:4780";
  const candidate=/^[a-z][a-z\d+.-]*:/i.test(raw)?raw:`https://${raw}`;
  const url=new URL(candidate);
  if(url.protocol==="https:"||(url.protocol==="http:"&&["localhost","127.0.0.1","::1"].includes(url.hostname)))return url.href;
  throw new Error("Yalnız HTTPS ve yerel HTTP adreslerine izin verilir");
}
const browserTabs=[];
let activeBrowserTabId=null;
let browserDebugEntries=[];
function addBrowserDebug(kind,text,url=""){browserDebugEntries.push({ts:new Date().toLocaleTimeString("tr-TR"),kind,text:String(text||"").slice(0,2000),url});browserDebugEntries=browserDebugEntries.slice(-300);$("browser-debug-count").textContent=browserDebugEntries.length;$("browser-debug-log").textContent=browserDebugEntries.map(x=>`[${x.ts}] ${x.kind.toUpperCase()} ${x.text}${x.url?`\n  ${x.url}`:""}`).join("\n");}
const chromeUserAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
function activeBrowserTab(){return browserTabs.find((tab)=>tab.id===activeBrowserTabId)||null;}
function activeBrowserView(){return activeBrowserTab()?.view||null;}
function browserDisplayUrl(view){try{return view?.getURL?.()||view?.src||"about:blank";}catch{return view?.src||"about:blank";}}
function updateBrowserControls(){const view=activeBrowserView();const url=browserDisplayUrl(view);if(url&&url!=="about:blank")$("browser-url").value=url;try{$("browser-back").disabled=!view?.canGoBack?.();$("browser-forward").disabled=!view?.canGoForward?.();}catch{$("browser-back").disabled=true;$("browser-forward").disabled=true;}}
function renderBrowserTabs(){const bar=$("browser-tabs");bar.querySelectorAll(".browser-tab").forEach((node)=>node.remove());for(const tab of browserTabs){const button=document.createElement("button");button.type="button";button.className=`browser-tab${tab.id===activeBrowserTabId?" active":""}`;button.dataset.browserTab=tab.id;const title=document.createElement("span");title.className="browser-tab-title";title.textContent=tab.title||"Yeni sekme";const close=document.createElement("span");close.className="browser-tab-close";close.textContent="×";close.title="Sekmeyi kapat";button.append(title,close);bar.insertBefore(button,$("browser-new-tab"));}bar.querySelectorAll("[data-browser-tab]").forEach((button)=>button.addEventListener("click",(event)=>{const id=button.dataset.browserTab;if(event.target.closest(".browser-tab-close"))closeBrowserTab(id);else activateBrowserTab(id);}));}
function activateBrowserTab(id){const tab=browserTabs.find((item)=>item.id===id);if(!tab)return;activeBrowserTabId=id;for(const item of browserTabs)item.view.hidden=item.id!==id;renderBrowserTabs();updateBrowserControls();try{window.desktopAPI?.setActiveBrowserGuest?.(tab.view.getWebContentsId());}catch{}}
function closeBrowserTab(id){const index=browserTabs.findIndex((item)=>item.id===id);if(index<0)return;const [tab]=browserTabs.splice(index,1);tab.view.remove();if(activeBrowserTabId===id){const next=browserTabs[Math.min(index,browserTabs.length-1)];activeBrowserTabId=next?.id||null;if(next)activateBrowserTab(next.id);else createBrowserTab("https://www.google.com/");}else renderBrowserTabs();}
function createBrowserTab(value="https://www.google.com/",{activate=true}={}){const url=normalizeBrowserUrl(value);if(!window.desktopAPI?.isDesktop){navigateBrowser(url);return null;}const id=`tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;const view=document.createElement("webview");view.setAttribute("partition","persist:ajan-browser");view.setAttribute("allowpopups","");view.setAttribute("useragent",chromeUserAgent);view.src=url;view.hidden=true;const tab={id,title:"Yükleniyor…",url,view};browserTabs.push(tab);$("browser-surface").append(view);const sync=(nextUrl)=>{tab.url=nextUrl||browserDisplayUrl(view);if(tab.id===activeBrowserTabId)updateBrowserControls();};view.addEventListener("dom-ready",()=>{try{if(tab.id===activeBrowserTabId)window.desktopAPI?.setActiveBrowserGuest?.(view.getWebContentsId());}catch{}});view.addEventListener("console-message",e=>addBrowserDebug(e.level>=2?"error":"console",e.message,e.sourceId));view.addEventListener("render-process-gone",e=>addBrowserDebug("error",`Sayfa işlemi kapandı: ${e.reason}`,tab.url));view.addEventListener("did-start-loading",()=>{if(tab.id===activeBrowserTabId)$("browser-reload").textContent="×";});view.addEventListener("did-stop-loading",()=>{if(tab.id===activeBrowserTabId)$("browser-reload").textContent="↻";sync();});view.addEventListener("did-navigate",(event)=>sync(event.url));view.addEventListener("did-navigate-in-page",(event)=>sync(event.url));view.addEventListener("page-title-updated",(event)=>{tab.title=event.title||new URL(tab.url).hostname;renderBrowserTabs();});view.addEventListener("did-fail-load",(event)=>{if(event.errorCode===-3)return;addBrowserDebug("network",`${event.errorCode} ${event.errorDescription}`,event.validatedURL);$("browser-notice").hidden=false;$("browser-notice").textContent=`Sayfa yüklenemedi: ${event.errorDescription}`;});if(activate)activateBrowserTab(id);else renderBrowserTabs();return tab;}
function openFlowBrowser(){openToolPanel('browser');const existing=browserTabs.find((tab)=>/labs\.google\/(?:fx\/[^/]+\/)?tools\/flow/i.test(tab.url||browserDisplayUrl(tab.view)));if(existing){activateBrowserTab(existing.id);return existing;}return createBrowserTab('https://labs.google/fx/tr/tools/flow');}
function navigateBrowser(value) {
  const url = normalizeBrowserUrl(value);
  $("browser-url").value = url;
  const desktopView = activeBrowserView();
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

if(window.desktopAPI?.isDesktop){$("browser-surface").replaceChildren();createBrowserTab("https://www.google.com/");}
$("btn-tools").addEventListener("click", (e) => { e.stopPropagation(); if($("tool-panel").classList.contains("closed"))showToolPicker();else closeToolPanel(); });
const settingsMeta={
  general:["Genel","Konseyin temel çalışma biçimini yönetin."],
  notifications:["Bildirimler","Hangi önemli sonuçlarda macOS bildirimi alacağınızı seçin."],
  agents:["Ajanlar ve modeller","Konsey üyelerini, modelleri ve çalışma çabasını yönetin."],
  capabilities:["Yetenekler ve bağlantılar","Ajanların kullanabildiği yerel araçları ve hizmetleri inceleyin."],
  applications:["Harici uygulamalar","Projelerin hangi masaüstü uygulamalarında açılacağını yönetin."],
  api:["Yapay zeka API","Harici modelleri güvenli API anahtarlarıyla konseye bağlayın."],
  updates:["Güncellemeler","Sürümü denetleyin; eski indirme paketleri otomatik temizlensin."]
};
function selectSettingsPage(page){
  if(!settingsMeta[page])page="general";
  document.querySelectorAll("[data-settings-page]").forEach(button=>button.classList.toggle("active",button.dataset.settingsPage===page));
  document.querySelectorAll("[data-settings-content]").forEach(content=>{const active=content.dataset.settingsContent===page;content.hidden=!active;content.classList.toggle("active",active);});
  $("settings-title").textContent=settingsMeta[page][0];$("settings-description").textContent=settingsMeta[page][1];
  if(page==="agents")renderAgentConfig();
  if(page==="api")refreshOpenRouterSettings();
  if(page==="capabilities")renderCapabilities();
  if(page==="applications")renderExternalApps();
  if(page==="updates"&&window.desktopAPI?.updateStatus)checkApplicationUpdate();
}
async function refreshOpenRouterSettings(){
  const status=await fetch("/api/api-providers/openrouter").then(response=>response.json()).catch(()=>({configured:false}));
  const stateEl=$("openrouter-state"),remove=$("openrouter-remove"),save=$("openrouter-save");
  const logo=document.querySelector("#openrouter-card .api-provider-logo");if(logo)logo.innerHTML=agentLogo("openrouter");
  stateEl.textContent=status.configured?"Bağlı · kullanıma hazır":"Bağlı değil";
  stateEl.classList.toggle("connected",!!status.configured);remove.hidden=!status.configured;
  save.textContent=status.configured?"Anahtarı yenile":"Bağla ve doğrula";
}
async function saveOpenRouterSettings(){
  const key=$("openrouter-key").value.trim(),error=$("openrouter-error"),button=$("openrouter-save");
  error.hidden=true;if(!key){error.textContent="OpenRouter API anahtarını girin.";error.hidden=false;return;}
  button.disabled=true;button.textContent="Doğrulanıyor…";
  const response=await fetch("/api/api-providers/openrouter",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({apiKey:key})});
  const result=await response.json().catch(()=>({}));button.disabled=false;
  if(!response.ok){error.textContent=result.error||"Bağlantı kurulamadı";error.hidden=false;button.textContent="Tekrar dene";return;}
  $("openrouter-key").value="";await fetchState();await refreshOpenRouterSettings();
}
async function removeOpenRouterSettings(){if(!confirm("Ox Alpha bağlantısı ve güvenli anahtarı kaldırılsın mı?"))return;await fetch("/api/api-providers/openrouter",{method:"DELETE"});await fetchState();await refreshOpenRouterSettings();}
function openSettingsScreen(page="general"){$("settings-screen").hidden=false;document.body.classList.add("settings-open");selectSettingsPage(page);requestAnimationFrame(()=>$('settings-search')?.focus());}
function closeSettingsScreen(){$("settings-screen").hidden=true;document.body.classList.remove("settings-open");}
$("btn-settings").addEventListener("click",()=>openSettingsScreen());
$("settings-back").addEventListener("click",closeSettingsScreen);$("settings-close").addEventListener("click",closeSettingsScreen);
document.querySelectorAll("[data-settings-page]").forEach(button=>button.addEventListener("click",()=>selectSettingsPage(button.dataset.settingsPage)));
$("settings-search").addEventListener("input",event=>{const query=event.target.value.trim().toLocaleLowerCase("tr-TR");document.querySelectorAll("[data-settings-page]").forEach(button=>button.hidden=!!query&&!button.textContent.toLocaleLowerCase("tr-TR").includes(query));});
$("openrouter-save")?.addEventListener("click",saveOpenRouterSettings);
$("openrouter-remove")?.addEventListener("click",removeOpenRouterSettings);
$("btn-open-project-app").addEventListener("click",event=>{event.stopPropagation();const menu=$("project-app-menu"),open=menu.hidden;menu.hidden=!open;$("btn-open-project-app").setAttribute("aria-expanded",String(open));});
$("project-app-menu").addEventListener("click",async event=>{const button=event.target.closest("[data-project-app]");if(!button)return;$("project-app-menu").hidden=true;$("btn-open-project-app").setAttribute("aria-expanded","false");if(button.dataset.projectApp==="custom"){const selected=await chooseExternalApp();if(selected)await openProjectWith("custom",selected.path);return;}await openProjectWith(button.dataset.projectApp);});
document.addEventListener("click",event=>{if(!event.target.closest(".project-app-wrap")){$("project-app-menu").hidden=true;$("btn-open-project-app").setAttribute("aria-expanded","false");}});
document.addEventListener("click",async event=>{const remove=event.target.closest("[data-remove-external-app]");if(remove){const items=externalApps();items.splice(Number(remove.dataset.removeExternalApp),1);localStorage.setItem("ajan.externalApps",JSON.stringify(items));renderExternalApps();return;}if(event.target.closest("#btn-add-external-app"))await chooseExternalApp();});
document.querySelectorAll("[data-open-tool]").forEach((b) => b.addEventListener("click", () => openToolPanel(b.dataset.openTool)));
document.querySelectorAll("[data-open-details]").forEach((b) => b.addEventListener("click", () => {
  $("tool-menu").hidden = true;
  $("details").classList.remove("closed");
  document.querySelector(`#tabs button[data-tab="${b.dataset.openDetails}"]`)?.click();
}));
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!$("tool-panel").classList.contains("closed")){closeToolPanel();$("btn-tools").focus();}});
$("btn-tool-close").addEventListener("click",closeToolPanel);
document.querySelectorAll("[data-tool-tab]").forEach((b) => b.addEventListener("click", () => openToolPanel(b.dataset.toolTab)));
$("browser-bar").addEventListener("submit", (e) => { e.preventDefault(); navigateBrowser($("browser-url").value); });
$("browser-new-tab").addEventListener("click",()=>createBrowserTab("https://www.google.com/"));
$("browser-device").addEventListener("change",e=>{$("browser-surface").classList.remove("device-tablet","device-phone");if(e.target.value!=="desktop")$("browser-surface").classList.add(`device-${e.target.value}`);});
$("browser-debug-clear").addEventListener("click",()=>{browserDebugEntries=[];$("browser-debug-log").textContent="";$("browser-debug-count").textContent="0";});
$("browser-capture").addEventListener("click",async()=>{const view=activeBrowserView();if(!view?.capturePage)return alert("Aktif önizleme yok");const image=await view.capturePage();const a=document.createElement("a");a.href=image.toDataURL();a.download=`onizleme-${Date.now()}.png`;a.click();addBrowserDebug("info","Önizleme ekran görüntüsü kaydedildi",browserDisplayUrl(view));});
$("browser-visual-test").addEventListener("click",async()=>{const view=activeBrowserView();if(!view)return alert("Aktif önizleme yok");const select=$("browser-device"),original=select.value,results=[];for(const device of ["desktop","tablet","phone"]){select.value=device;select.dispatchEvent(new Event("change"));await new Promise(resolve=>setTimeout(resolve,450));let overflow=false;try{overflow=await view.executeJavaScript("document.documentElement.scrollWidth>document.documentElement.clientWidth");}catch{}const image=await view.capturePage?.();results.push({device,overflow,image});addBrowserDebug(overflow?"error":"info",`${device}: ${overflow?"yatay taşma bulundu":"yerleşim temiz"}`,browserDisplayUrl(view));}select.value=original;select.dispatchEvent(new Event("change"));const failed=results.filter(item=>item.overflow).length;alert(`Görsel arayüz testi tamamlandı: ${results.length-failed}/3 görünüm temiz${failed?`, ${failed} görünümde yatay taşma var`:""}. Ayrıntılar Hata ayıklama bölümünde.`);});
$("browser-server-restart").addEventListener("click",async()=>{const p=activeProject();if(!p)return alert("Proje seçin");await fetch(`/api/projects/${p.id}/dev/stop`,{method:"POST"});await new Promise(r=>setTimeout(r,500));const response=await fetch(`/api/projects/${p.id}/dev/start`,{method:"POST"}),result=await response.json();if(!response.ok)return alert(result.error);addBrowserDebug("info",`${result.command} yeniden başlatıldı`);setTimeout(()=>activeBrowserView()?.reload?.(),1200);});
$("browser-back").addEventListener("click",()=>{try{activeBrowserView()?.goBack();}catch{}});
$("browser-forward").addEventListener("click",()=>{try{activeBrowserView()?.goForward();}catch{}});
$("browser-reload").addEventListener("click",()=>{const view=activeBrowserView();if(!view)return;try{view.isLoading()?view.stop():view.reload();}catch{}});
$("browser-home").addEventListener("click", () => navigateBrowser("http://localhost:4780"));
$("browser-external").addEventListener("click", () => window.open(normalizeBrowserUrl($("browser-url").value), "_blank", "noopener"));
// "hazır" yanıtı YALNIZ requestAnimationFrame'e bağlanmamalı: pencere arka planda
// veya örtülüyken macOS kare üretmediği için rAF hiç tetiklenmeyebiliyor ve açılış
// "Tarayıcı paneli hazır olmadı" ile zaman aşımına uğruyordu. Panel kurulumunda bir
// hata olsa bile yanıt gitmeli; aksi hâlde ajan sonsuza kadar bekler.
window.desktopAPI?.onBrowserOpen?.((detail)=>{let sent=false;const ready=()=>{if(sent)return;sent=true;try{window.desktopAPI.browserReady(detail.requestId);}catch{}};try{openToolPanel("browser");$("browser-url").value=detail.url;const display=$("browser-share-status");display.hidden=false;display.textContent=`${detail.actor||detail.provider} · ${detail.origin} açılıyor`;}finally{requestAnimationFrame(ready);setTimeout(ready,50);}});
window.desktopAPI?.onBrowserNewTab?.((detail)=>{try{openToolPanel("browser");createBrowserTab(detail.url);}catch(error){$("browser-notice").hidden=false;$("browser-notice").textContent=error.message;}});
document.addEventListener("keydown",(event)=>{if(!window.desktopAPI?.isDesktop)return;const mod=event.metaKey||event.ctrlKey;if(mod&&event.key.toLowerCase()==="t"){event.preventDefault();openToolPanel("browser");createBrowserTab("https://www.google.com/");}else if(mod&&event.key.toLowerCase()==="w"&&!$("tool-browser").hidden){event.preventDefault();if(activeBrowserTabId)closeBrowserTab(activeBrowserTabId);}else if(mod&&event.key.toLowerCase()==="l"){event.preventDefault();openToolPanel("browser");$("browser-url").focus();$("browser-url").select();}else if(mod&&event.key.toLowerCase()==="r"&&!$("tool-browser").hidden){event.preventDefault();activeBrowserView()?.reload();}else if(mod&&event.key==="["){event.preventDefault();activeBrowserView()?.goBack();}else if(mod&&event.key==="]"){event.preventDefault();activeBrowserView()?.goForward();}});
setInterval(async()=>{if(!window.desktopAPI?.isDesktop)return;try{const status=await(await fetch("/api/browser/status")).json();const display=$("browser-share-status");display.replaceChildren();const active=status.active;display.hidden=!active;if(active){const text=document.createElement("span");text.textContent=`${active.actor||active.provider||"Ajan"} · ${active.action||"tarayıcı kullanılıyor"}`;display.append(text);}}catch{}},500);
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
[$("f-notify-done"),$("f-notify-error"),$("f-notify-approval")].forEach(input=>input.addEventListener("change",()=>fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({notificationEvents:{done:$("f-notify-done").checked,error:$("f-notify-error").checked,approval:$("f-notify-approval").checked}})})));

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
  // Ek satırı kapanınca kompozörün aynı karede doğal yüksekliğine dönmesini sağla.
  if (box.hidden) requestAnimationFrame(autoGrow);
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
  const diffLine=e.target.closest("[data-diff-file]");if(diffLine&&selectedRun){const body=prompt(`${diffLine.dataset.diffFile}:${diffLine.dataset.diffLine} için yorum`);if(body){await fetch(`/api/runs/${selectedRun}/diff-comments`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file:diffLine.dataset.diffFile,line:Number(diffLine.dataset.diffLine),body})});await fetchState();}return;}
  const artifact=e.target.closest("[data-artifact-path]");if(artifact){e.preventDefault();openArtifact(artifact.dataset.artifactPath);return;}
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
      budget: {enabled:$("f-budget-enabled").checked,maxCalls:Number($("f-budget-calls").value)||24,maxTokens:Number($("f-budget-tokens").value)||250000},
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

function initializeSplitLayout(){
  const root=document.documentElement,sidebar=$("sidebar"),tool=$("tool-panel");
  const savedSidebar=Number(localStorage.getItem("ajan.sidebar.width"));
  const savedTool=Number(localStorage.getItem("ajan.tool.width"));
  if(savedSidebar)root.style.setProperty("--sidebar-width",`${Math.min(430,Math.max(220,savedSidebar))}px`);
  if(savedTool)root.style.setProperty("--tool-width",`${Math.min(980,Math.max(380,savedTool))}px`);
  const bind=(handle,type)=>{
    let startX=0,startWidth=0;
    const apply=(value,persist=true)=>{
      if(type==="sidebar"){
        const width=Math.min(430,Math.max(220,value));root.style.setProperty("--sidebar-width",`${width}px`);handle.setAttribute("aria-valuenow",String(Math.round(width)));if(persist)localStorage.setItem("ajan.sidebar.width",String(width));
      }else{
        const sidebarWidth=sidebar.classList.contains("hidden")?0:sidebar.getBoundingClientRect().width;
        const maximum=Math.max(380,window.innerWidth-sidebarWidth-360),width=Math.min(Math.min(980,maximum),Math.max(380,value));root.style.setProperty("--tool-width",`${width}px`);handle.setAttribute("aria-valuenow",String(Math.round(width)));if(persist)localStorage.setItem("ajan.tool.width",String(width));
      }
    };
    handle.addEventListener("pointerdown",event=>{startX=event.clientX;startWidth=(type==="sidebar"?sidebar:tool).getBoundingClientRect().width;handle.setPointerCapture(event.pointerId);document.body.classList.add("split-resizing");event.preventDefault();});
    handle.addEventListener("pointermove",event=>{if(!handle.hasPointerCapture(event.pointerId))return;apply(startWidth+(type==="sidebar"?event.clientX-startX:startX-event.clientX),false);});
    const finish=event=>{if(!handle.hasPointerCapture(event.pointerId))return;handle.releasePointerCapture(event.pointerId);document.body.classList.remove("split-resizing");apply((type==="sidebar"?sidebar:tool).getBoundingClientRect().width,true);};
    handle.addEventListener("pointerup",finish);handle.addEventListener("pointercancel",finish);
    handle.addEventListener("dblclick",()=>apply(type==="sidebar"?276:620,true));
    handle.addEventListener("keydown",event=>{if(!["ArrowLeft","ArrowRight"].includes(event.key))return;const current=(type==="sidebar"?sidebar:tool).getBoundingClientRect().width,direction=event.key==="ArrowRight"?1:-1;apply(current+(type==="sidebar"?direction:-direction)*16,true);event.preventDefault();});
  };
  bind($("sidebar-resizer"),"sidebar");bind($("tool-resizer"),"tool");
}
initializeSplitLayout();

// Dar ekranda kenar çubuğu varsayılan gizli: çalışma alanı ferah kalsın
if (window.innerWidth < 1100) $("sidebar").classList.add("hidden");

connectSSE();
fetchState();
fetchCapabilities();
if(window.desktopAPI?.updateStatus)setTimeout(checkApplicationUpdate,2500);
setInterval(fetchState, 15000);
