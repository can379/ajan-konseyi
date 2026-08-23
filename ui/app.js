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
  koordinator: { label: "Koordinatör", short: "K" },
  kullanici: { label: "Siz", short: "S" },
  sistem: { label: "Sistem", short: "•" },
};
const PROVIDERS = ["claude", "codex", "antigravity"];
const PROVIDER_LABELS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

function imageStudioMembers() {
  return PROVIDERS.map((provider) => {
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
  const roles = { claude:"Sanat yönetimi ve istem", codex:"Yüksek kaliteli görsel motoru", antigravity:"Araştırma ve sanat yönetimi" };
  options.innerHTML = members.map((m) => `<label class="image-agent-option ${m.provider}"><input type="checkbox" value="${esc(m.id)}" data-provider="${m.provider}" ${prior.size ? (prior.has(m.id) ? "checked" : "") : "checked"}><span class="image-agent-mark">${AGENT_META[m.provider].short}</span><span><b>${esc(m.label)}</b><small>${roles[m.provider]}</small></span><i>✓</i></label>`).join("");
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
    const statusLabel=s.label ? String(s.label).replace(/\.{2,}$/g,"") : "yanıt hazırlanıyor";
    return `<div class="msg live-msg live-status-only from-${esc(meta.cls)}">
      <div class="avatar bg-${esc(meta.cls)}">${esc(meta.short)}</div>
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
function bindRunContextMenu(){const menu=$("run-context-menu");let timer;const close=()=>{clearTimeout(timer);timer=setTimeout(()=>menu.hidden=true,140);};for(const row of document.querySelectorAll(".run-item[data-run]")){row.addEventListener("mouseenter",()=>{clearTimeout(timer);const rect=row.getBoundingClientRect(),run=state.runs[row.dataset.run];menu.dataset.runId=row.dataset.run;menu.querySelector('[data-run-menu="pin"]').textContent=run?.pinned?"Sabitlemeyi kaldır":"Sabitle";menu.querySelector('[data-run-menu="archive"]').textContent=run?.archived?"Arşivden çıkar":"Arşivle";menu.hidden=false;requestAnimationFrame(()=>{menu.style.left=`${Math.min(innerWidth-menu.offsetWidth-12,rect.right+8)}px`;menu.style.top=`${Math.min(innerHeight-menu.offsetHeight-12,rect.top)}px`;});});row.addEventListener("mouseleave",close);}menu.onmouseenter=()=>clearTimeout(timer);menu.onmouseleave=close;}
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
  if(run?.projectId)renderProjectArtifacts(run.projectId,run);

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

function openToolPanel(tab) {
  $("tool-panel").classList.remove("closed");
  $("tool-menu").hidden = true;
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
async function renderSecurityCenter(){
  const project=activeProject(),projectId=project?.id||"global",data=await fetch("/api/workspace").then(r=>r.json()),permissions=data.permissions?.[projectId]||{};
  $("security-permissions").innerHTML=Object.entries(securityCapabilities).map(([key,cap])=>{const value=permissions[key]||"ask";return`<label class="permission-row" data-state="${value}"><span class="permission-copy"><b>${esc(cap.label)}</b><small>${esc(cap.description)}</small></span><select data-security-permission="${key}"><option value="ask" ${value==="ask"?"selected":""}>Her seferinde sor</option><option value="allow" ${value==="allow"?"selected":""}>İzin ver</option><option value="deny" ${value==="deny"?"selected":""}>Engelle</option></select></label>`;}).join("");
  $("security-skills").innerHTML=(data.skills||[]).length?(data.skills||[]).map(skill=>`<div class="skill-row"><input type="checkbox" data-security-skill="${skill.id}" ${(skill.enabledProjects||[]).includes(projectId)?"checked":""}><div class="skill-copy"><b>${esc(skill.name)}</b><small>v${esc(skill.version||"1.0.0")} · ${esc(skill.instructions||skill.command||"Talimat yok")}</small></div><button data-delete-skill="${skill.id}" title="Yetenek paketini sil">Sil</button></div>`).join(""):'<div class="skill-empty"><div><span>⌾</span><b>Henüz yetenek paketi yok</b><small>Sık kullandığınız talimatları paketleyip projelerde tek tıkla etkinleştirin.</small></div></div>';
  $("security-audit").innerHTML=[...(data.audit||[])].reverse().slice(0,30).map(item=>`<div class="audit-row"><span class="audit-icon">${item.action.startsWith("skill")?"⌾":item.action.startsWith("permission")?"✓":"·"}</span><span class="audit-copy"><b>${esc(auditLabels[item.action]||"Çalışma alanı güncellendi")}</b><small>${esc(auditSummary(item))}</small></span><time>${esc(new Date(item.ts).toLocaleString("tr-TR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}))}</time></div>`).join("")||'<div class="audit-empty">Henüz etkinlik kaydı yok.</div>';
}
async function checkApplicationUpdate(){if(!window.desktopAPI?.updateStatus){$("update-status").textContent="Güncelleme denetimi masaüstü uygulamasında kullanılabilir.";return;}$("update-status").textContent="GitHub sürümü denetleniyor…";const result=await window.desktopAPI.updateStatus();if(result.error){$("update-status").textContent=`Denetim başarısız: ${result.error}`;$("update-download").hidden=true;return;}$("update-status").textContent=result.available?`${result.current} yüklü · ${result.latest} indirilebilir`:`${result.current} güncel · ${result.message||result.latest||""}`;$("update-download").hidden=!(result.available&&result.asset);$("update-notes").hidden=!result.notes;$("update-notes").textContent=result.notes||"";}
async function renderTaskCenter(){const data=await fetch("/api/workspace").then(r=>r.json()),tasks=data.tasks||[],leases=data.leases||[];$("resource-lease-list").innerHTML=leases.length?leases.map(lease=>`<div class="resource-lease-row"><span>${lease.type==="port"?"⇄":lease.type==="external-service"?"↗":"◇"}</span><div><b>${esc(lease.key)}</b><small>${esc(lease.owner?.label||lease.owner?.agentId||lease.owner?.runId||"Bilinmeyen sahip")}</small></div><time>${esc(new Date(lease.expiresAt).toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"}))}</time></div>`).join(""):'<div class="resource-lease-empty">Şu anda ayrılmış kaynak yok.</div>';$("task-center-list").innerHTML=tasks.length?tasks.map(t=>{const contract=t.contract||{},ready=contract.status==="ready";return`<article class="task-card"><div class="task-card-head"><b>${esc(t.title)}</b><span class="task-status">${esc(t.status)}</span></div><small>${esc(t.phase||t.kind||"")}</small><div class="task-contract-summary ${ready?"ready":"draft"}"><span>${ready?"✓":"!"}</span><div><b>Görev sözleşmesi · ${ready?"Hazır":"Taslak"}</b><small>${esc(contract.goal||"Hedef henüz tanımlanmadı")}</small></div></div><div class="task-progress"><i style="width:${Number(t.progress)||0}%"></i></div><div class="task-actions"><button data-task-contract="${t.id}">Sözleşmeyi düzenle</button>${["running","queued"].includes(t.status)?`<button data-task-action="pause" data-task-id="${t.id}">Duraklat</button>`:""}${["paused","failed","interrupted","stopped","evidence_blocked"].includes(t.status)?`<button data-task-action="resume" data-task-id="${t.id}">Sürdür</button><button data-task-action="retry" data-task-id="${t.id}">Yeniden dene</button>`:""}${!["done","cancelled"].includes(t.status)?`<button data-task-action="cancel" data-task-id="${t.id}">İptal</button>`:""}</div></article>`;}).join(""):'<div class="muted" style="padding:20px">Henüz görev yok.</div>';}
function contractLines(value){return (value||[]).join("\n");}
async function openTaskContract(taskId){const response=await fetch(`/api/workspace/tasks/${taskId}/contract`),contract=await response.json();if(!response.ok)return alert(contract.error);openModal(`<div class="contract-modal"><div class="modal-title"><div><span class="section-kicker">GÖREV SINIRLARI</span><h2>Görev sözleşmesi</h2><p>Ajanın hedefini, erişebileceği alanları ve tamamlanma ölçütlerini belirleyin.</p></div><button data-close-modal>×</button></div><form id="task-contract-form" data-task-id="${taskId}"><label class="contract-wide"><b>Hedef</b><small>Bu görev sonunda ortaya çıkması gereken sonuç.</small><textarea name="goal" required>${esc(contract.goal||"")}</textarea></label><label><b>Kapsam dışı</b><small>Her satıra yapılmaması gereken bir iş.</small><textarea name="nonGoals">${esc(contractLines(contract.nonGoals))}</textarea></label><label><b>Kabul kriterleri</b><small>Her satır doğrulanabilir bir sonuç olmalı.</small><textarea name="acceptanceCriteria" required>${esc(contractLines(contract.acceptanceCriteria))}</textarea></label><label><b>İzin verilen yollar</b><small>Projeye göre yollar; ör. src/**</small><textarea name="allowedPaths" required>${esc(contractLines(contract.allowedPaths))}</textarea></label><label><b>Yasak yollar</b><small>Ajanın değiştirmemesi gereken alanlar.</small><textarea name="forbiddenPaths">${esc(contractLines(contract.forbiddenPaths))}</textarea></label><label><b>Test komutları</b><small>Her satıra bir doğrulama komutu.</small><textarea name="testCommands">${esc(contractLines(contract.testCommands))}</textarea></label><label><b>Onay sınırları</b><small>İnsan onayı gerektiren işlemler.</small><textarea name="approvalBoundaries">${esc(contractLines(contract.approvalBoundaries))}</textarea></label><label class="contract-risk"><b>Risk seviyesi</b><select name="risk">${[["low","Düşük"],["medium","Orta"],["high","Yüksek"],["critical","Kritik"]].map(([value,label])=>`<option value="${value}" ${contract.risk===value?"selected":""}>${label}</option>`).join("")}</select></label><div class="contract-errors" ${contract.errors?.length?"":"hidden"}>${esc((contract.errors||[]).join(" · "))}</div><div class="modal-actions"><button type="button" data-close-modal>Vazgeç</button><button type="submit" class="primary-action">Sözleşmeyi kaydet</button></div></form></div>`);}
$("task-refresh").addEventListener("click",renderTaskCenter);
$("task-center-list").addEventListener("click",async e=>{const contractButton=e.target.closest("[data-task-contract]");if(contractButton)return openTaskContract(contractButton.dataset.taskContract);const b=e.target.closest("[data-task-action]");if(!b)return;const r=await fetch(`/api/workspace/tasks/${b.dataset.taskId}/${b.dataset.taskAction}`,{method:"POST"});if(!r.ok)alert((await r.json()).error);await renderTaskCenter();await fetchState();});
$("modal-card").addEventListener("submit",async e=>{if(e.target.id!=="task-contract-form")return;e.preventDefault();const form=e.target,data=Object.fromEntries(new FormData(form));for(const key of ["nonGoals","allowedPaths","forbiddenPaths","acceptanceCriteria","testCommands","approvalBoundaries"])data[key]=String(data[key]||"").split("\n");const button=form.querySelector('[type="submit"]');button.disabled=true;const response=await fetch(`/api/workspace/tasks/${form.dataset.taskId}/contract`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),result=await response.json();button.disabled=false;if(!response.ok)return alert(result.error);closeModal();await renderTaskCenter();});
$("security-refresh").addEventListener("click",renderSecurityCenter);
$("update-check").addEventListener("click",checkApplicationUpdate);
$("update-download").addEventListener("click",async()=>{if(!window.desktopAPI?.downloadUpdate)return;$("update-status").textContent="Güncelleme paketi indiriliyor…";$("update-download").disabled=true;const result=await window.desktopAPI.downloadUpdate();$("update-download").disabled=false;if(result.error){$("update-status").textContent=`İndirme başarısız: ${result.error}`;return;}$("update-status").textContent=`Paket doğrulandı ve Finder’da gösterildi · SHA-256: ${result.sha256.slice(0,12)}…`;});
$("security-new-skill").addEventListener("click",async()=>{const name=prompt("Yetenek adı","Kod kalite kontrolü");if(!name)return;const version=prompt("Sürüm","1.0.0")||"1.0.0",instructions=prompt("Ajanlara verilecek talimat","")||"",command=prompt("İsteğe bağlı güvenli komut","")||"";const response=await fetch("/api/workspace/skills",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,version,instructions,command})});if(!response.ok)return alert((await response.json()).error);await renderSecurityCenter();});
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
$("btn-tool-close").addEventListener("click",()=>$("tool-panel").classList.add("closed"));
document.querySelectorAll("[data-tool-tab]").forEach((b) => b.addEventListener("click", () => openToolPanel(b.dataset.toolTab)));
$("browser-bar").addEventListener("submit", (e) => { e.preventDefault(); navigateBrowser($("browser-url").value); });
$("browser-new-tab").addEventListener("click",()=>createBrowserTab("https://www.google.com/"));
$("browser-device").addEventListener("change",e=>{$("browser-surface").classList.remove("device-tablet","device-phone");if(e.target.value!=="desktop")$("browser-surface").classList.add(`device-${e.target.value}`);});
$("browser-debug-clear").addEventListener("click",()=>{browserDebugEntries=[];$("browser-debug-log").textContent="";$("browser-debug-count").textContent="0";});
$("browser-capture").addEventListener("click",async()=>{const view=activeBrowserView();if(!view?.capturePage)return alert("Aktif önizleme yok");const image=await view.capturePage();const a=document.createElement("a");a.href=image.toDataURL();a.download=`onizleme-${Date.now()}.png`;a.click();addBrowserDebug("info","Önizleme ekran görüntüsü kaydedildi",browserDisplayUrl(view));});
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
