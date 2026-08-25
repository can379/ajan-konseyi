import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeAgent } from "./agents/claudeAgent.js";
import { CodexAgent } from "./agents/codexAgent.js";
import { AntigravityAgent } from "./agents/antigravityAgent.js";
import { OpenRouterAgent } from "./agents/openRouterAgent.js";
import { readOpenRouterKey } from "./credentialStore.js";
import { Coordinator } from "./coordinator.js";
import { ProjectContext } from "./projectContext.js";
import { TIER_MAP, contextWindowFor } from "./models.js";
import { extractJson, now, truncate, uid, usageDayKey, extractSummary, stripSummaryBlock, summaryContract } from "./util.js";
import * as gitops from "./gitops.js";
import { ComputerBridge, COMPUTER_ACTIONS, describeComputerAction } from "./computerBridge.js";
import { createCheckpoint, pruneAutoCheckpoints, shouldAutoCheckpoint } from "./checkpoints.js";
import { writeSkillFiles, skillCatalog } from "./skills.js";
import { findSimilarRepairs, recordRepair, repairHint } from "./repairMemory.js";
import { completeMergeOrder, normalizePlan, normalizeRoute } from "./validation.js";
import { enrichAttachments, attachmentPrompt, unsupportedAttachments, collectGeneratedAssets } from "./media.js";
import { analyzeImagesLocally } from "./localVision.js";
import { bridgePrompt, connectorAccessMode, connectorRoute, CONNECTORS } from "./connectorBridge.js";
import { canAuthorCode, enforceTaskAssignments, preferredCoder, requiresCodeAuthoring } from "./taskPolicy.js";
import { StepLog } from "./steps.js";
import { numstatSnapshot, diffDelta } from "./diffSummary.js";
import { normalizeTaskContract } from "./taskContract.js";
import { createReviewPacket, isolatedReviewPrompt, invalidateStaleReviews } from "./reviewIsolation.js";
import { assertEvidenceGate, EvidenceGateError } from "./evidenceGate.js";
import { appendRunEvent, recordTestExecution, testEvidenceFromEvents } from "./runEvents.js";
import { assertProviderAllowed, providerAllowed } from "./providerPolicy.js";

const exec = promisify(execFile);
const BROWSER_ACTION_RE=/<<<AJAN_BROWSER_ACTION>>>\s*([\s\S]*?)\s*<<<END>>>/;
const HOST_ACTION_RE=/<<<AJAN_HOST_ACTION>>>\s*([\s\S]*?)\s*<<<END>>>/;
export function parseBrowserAction(text){const match=String(text||"").match(BROWSER_ACTION_RE);if(!match)return null;try{const value=JSON.parse(match[1]);if(!["open","snapshot","navigate","click","type"].includes(value.action))return null;return{action:value.action,payload:value.payload&&typeof value.payload==="object"?value.payload:{}};}catch{return null;}}
// Makine sozlesmesi jetonlari KULLANICIYA ASLA gosterilmez: Codex'te "Ran
// page script ›" nasil katlanmis bir satirsa, bizde de eylem adim gunlugune
// iner; yanit metninden jeton bloklari ayiklanir.
export function stripActionTokens(text){
  return String(text||"")
    .replace(/<<<AJAN_(?:BROWSER_ACTION|HOST_ACTION|SORU|BILGISAYAR)>>>[\s\S]*?<<<END>>>/g,"")
    .replace(/<<<AJAN_(?:BROWSER_ACTION|HOST_ACTION|SORU|BILGISAYAR)>>>[\s\S]*$/,"")
    .trim();
}

// Bilgisayar kullanimi jetonu: uye ekrani gorup fare/klavye kullanmak
// istediginde bunu dondurur. Tur basina BIR KEZ kullanici onayi alinir.
const COMPUTER_ACTION_RE=/<<<AJAN_BILGISAYAR>>>\s*([\s\S]*?)\s*<<<END>>>/;
export function parseComputerAction(text){const match=String(text||"").match(COMPUTER_ACTION_RE);if(!match)return null;try{const value=JSON.parse(match[1]);if(!COMPUTER_ACTIONS.includes(value.action))return null;return{action:value.action,payload:value.payload&&typeof value.payload==="object"?value.payload:{}};}catch{return null;}}

// Eylemi Turkce insan cumlesine cevir (adim satirinin basligi).
export function describeAgentAction(action){
  const p=action?.payload||{};
  const kisa=(u)=>{try{const x=new URL(String(u));return x.protocol==="file:"?decodeURIComponent(x.pathname).split("/").pop():x.hostname+(x.pathname!=="/"?x.pathname:"");}catch{return String(u||"").slice(0,60);}};
  switch(action?.action){
    case "open": return {kind:"tarayici",title:`${kisa(p.url)} tarayıcıda açıldı`};
    case "navigate": return {kind:"tarayici",title:`${kisa(p.url)} sayfasına gidildi`};
    case "snapshot": return {kind:"tarayici",title:"Sayfa incelendi"};
    case "click": return {kind:"tarayici",title:"Sayfada tıklandı"};
    case "type": return {kind:"tarayici",title:"Sayfaya metin yazıldı"};
    case "publish": return {kind:"islem",title:"GitHub'a yayınlandı"};
    default: return {kind:"islem",title:"Uygulama aracı çalıştı"};
  }
}

// Uyeden uyeye dogrudan soru: yanit "<<<AJAN_SORU>>>{...}<<<END>>>" ise
// orkestrator hedef uyeyi dar baglamla cagirir, yaniti soran uyeye geri verir.
const AGENT_ASK_RE=/<<<AJAN_SORU>>>\s*([\s\S]*?)\s*<<<END>>>/;
export function parseAgentAsk(text){const match=String(text||"").match(AGENT_ASK_RE);if(!match)return null;try{const value=JSON.parse(match[1]);const to=String(value.to||"").trim(),question=String(value.question||"").trim();if(!to||!question)return null;return{action:"ask",to,question:question.slice(0,2000)};}catch{return null;}}

export function parseHostAction(text){const match=String(text||"").match(HOST_ACTION_RE);if(!match)return null;try{const value=JSON.parse(match[1]);if(value.action!=="publish")return null;return{action:"publish",payload:value.payload&&typeof value.payload==="object"?value.payload:{}};}catch{return null;}}
export function isExplicitPublishRequest(text){return/(?:github|git\b).{0,100}(?:yay[ıi](?:n|mla)\w*|push|gönder)|(?:yay[ıi]mla\w*|push et|gönder).{0,100}(?:github|repo|proje|sürüm)/i.test(String(text||""));}
export function reportsBlockedResult(text){return /^\s*(?:#{1,3}\s*)?(?:durum\s*:\s*)?(?:bloke|blocked)\b|hiçbir değişiklik uygulanmadı|değişiklik uygulayamadım/i.test(String(text||""));}

export function isIdentityQuestion(text) {
  return /(?:^|\s)(?:sen\s+)?kim(?:sin|dir)?(?:\s|[?.!,]|$)|kendini\s+tan[ıi]t|hangi\s+(?:yapay\s+zek[âa]|model|sağlayıcı)/i.test(String(text || ""));
}

// Uye cagrisinin calisma dizini. Cagri noktalarinin cogu (dogrudan mesaj,
// ikili inceleme, tartisma, oylama) cwd gecirmiyordu; bu durumda ajan
// sunucunun kendi dizininde calisiyor, projeyi goremiyor ve ona yazamiyordu.
// Iki istisna korunur: izole incelemeler yalniz kanit paketiyle calisir ve
// kod modunda ayri calisma kopyasi olmayan gorevler ana agaca yazmamalidir.
// Tur yonlendirmesinin saf karari. Uc girdi yarisir:
//  - forced: kullanicinin "/" komutuyla actikca sectigi kademe (her seyi ezer)
//  - requestedMemberId: metindeki "@Uye" cagrisi (yalniz auto modda gecerli)
//  - routed: koordinatorun onerisi
// Kullanici modu acikca sectiyse ve sonuc konseyse, koordinator baska mod
// onerse bile KULLANICININ modu korunur; kucuk isler ise quick/pair'e inerek
// tam turun maliyetinden kacinir (kademeli acilim).
// Yogunluk kademeleri: kullanicinin "kac yapay zeka, ne kadar toren"
// sorusuna tek gorunur ayarla verdigi cevap. Ekonomik kademe tartisma ve
// dogrulayici maliyetini kisar; Titiz kademe supheli islerde teker teker
// denetimi artirir. Dengeli mevcut varsayilan davranistir.
export const INTENSITY_PROFILES = {
  ekonomik: { debateCap: 1, reviewRounds: 1, verify: false },
  dengeli:  {},
  titiz:    { debateFloor: 3, reviewRounds: 2, verify: true },
};

export function applyIntensity(run) {
  const profile = INTENSITY_PROFILES[run?.intensity] || INTENSITY_PROFILES.dengeli;
  let debate = Number(run?.maxDebateRounds) || 2;
  if (profile.debateCap) debate = Math.min(debate, profile.debateCap);
  if (profile.debateFloor) debate = Math.max(debate, profile.debateFloor);
  return {
    maxDebateRounds: debate,
    reviewRounds: profile.reviewRounds ?? (Number(run?.reviewRounds) || 1),
    verify: profile.verify !== false,
  };
}

// Ikili inceleme konseye tirmanmali mi? Denetci "buyut" bayragini yalniz is
// ikili incelemenin tasiyabileceginden genis/riskli oldugunda doner.
export function shouldEscalatePair(verdict) {
  return verdict?.buyut === true;
}

// Codex tarzi yanit sozlesmesi (ChatGPT icindeki Codex canli gozlemlenerek
// cikarildi): kod isinin nihai yaniti kisa ve taranabilir olur — dosya
// baglantili tek cumlelik baslik, 3-6 madde, sonda dogrulama maddesi.
// Serbest sohbet yanitlarina uygulanmaz.
export const CODEX_STYLE_CONTRACT = `\n\n--- YANIT BİÇİMİ ---\nNihai yanıtını şu biçimde ver:\n1) İlk satır tek cümle: hangi dosya(lar) güncellendi — örn. "index.html güncellendi."\n2) Ardından 3-6 kısa madde; her madde TEK özellik/karar, kullanıcı diliyle (komut adı, sed/grep gibi teknik ayrıntı YOK). Önemli sayı ve durumları **kalın** yaz.\n3) Son madde doğrulamayı belirtsin (çalıştırılan test/sözdizimi kontrolü ve sonucu).\nUzun paragraf yazma; başlık (#) kullanma.\n--- BİÇİM SONU ---`;

export function resolveTurnRoute({ mode = "auto", forced = null, requestedMemberId = null, routed = null } = {}) {
  const explicitMode = ["discussion", "split", "code"].includes(mode) ? mode : null;
  if (forced === "quick") return { approach: "quick", member_id: requestedMemberId || routed?.member_id || null, explicit: true };
  if (forced === "pair") return { approach: "pair", member_id: routed?.member_id || null, reviewer_id: routed?.reviewer_id || null, explicit: true };
  if (forced === "council") return { approach: "council", mode: explicitMode || routed?.mode || "discussion", explicit: true };
  if (requestedMemberId) return { approach: "quick", member_id: requestedMemberId, explicit: true };
  if (!routed) return { approach: "council", mode: explicitMode || "discussion" };
  if (explicitMode && routed.approach === "council") return { ...routed, mode: explicitMode };
  return routed;
}

export function resolveMemberCwd(run, opts = {}) {
  if (opts.cwd !== undefined) return opts.cwd;
  if (opts.isolated || opts.noProjectCwd) return undefined;
  return run?.projectDir || undefined;
}

export function verifiedMemberIdentity(member) {
  const provider = String(member?.provider || "").toLowerCase();
  if (provider === "claude") return "Ben **Claude**'um. Anthropic'in Claude sağlayıcısı üzerinden çalışan Ajan Konseyi üyesiyim; Codex değilim.";
  if (provider === "antigravity") return "Ben **Antigravity**'yim. Ajan Konseyi'nde Google Antigravity sağlayıcısı üzerinden çalışan yapay zekâ üyesiyim; Codex değilim.";
  if (provider === "openrouter") return "Ben **Ox Alpha**'yım. OpenRouter üzerindeki `stealth/ox-alpha` modeli olarak çalışan ayrı bir Ajan Konseyi üyesiyim; Codex değilim.";
  if (provider === "codex") return "Ben **Codex**'im. OpenAI'ın Codex sağlayıcısı üzerinden çalışan Ajan Konseyi üyesiyim.";
  return `Ben **${member?.name || "Ajan Konseyi üyesi"}** olarak çalışan ayrı bir yapay zekâ üyesiyim.`;
}

export function identityResponseMatchesProvider(member, text) {
  const value = String(text || "").toLowerCase();
  const provider = String(member?.provider || "").toLowerCase();
  if (provider === "codex") return /\bcodex\b/.test(value);
  if (provider === "claude") return /\bclaude\b/.test(value) && !/(?:ben|i am)\s+(?:\*\*)?codex\b/i.test(value);
  if (provider === "antigravity") return /\bantigravity\b/.test(value) && !/(?:ben|i am)\s+(?:\*\*)?codex\b/i.test(value);
  if (provider === "openrouter") return /\box alpha\b|stealth\/ox-alpha/.test(value) && !/(?:ben|i am)\s+(?:\*\*)?codex\b/i.test(value);
  return true;
}

export function normalizeGeneratedConversationTitle(value, max = 58) {
  let title=String(value||"")
    .replace(/^```(?:text|markdown)?\s*/i,"").replace(/```$/i,"")
    .split(/\r?\n/)[0]
    .replace(/^\s*(?:başlık|title)\s*:\s*/i,"")
    .replace(/^[\s"'“”‘’`*_#-]+|[\s"'“”‘’`*_.!?#-]+$/g,"")
    .replace(/\s+/g," ").trim();
  if(!title||/^(?:yeni sohbet|sohbet başlığı|başlık)$/i.test(title))return "";
  if(title.length>max){const cut=title.slice(0,max+1),space=cut.lastIndexOf(" ");title=(space>20?cut.slice(0,space):cut.slice(0,max)).trim()+"…";}
  return title.charAt(0).toLocaleUpperCase("tr-TR")+title.slice(1);
}

// Her çıktıyı bütün üyelere tekrar okutmak çağrı sayısını görev×üye biçiminde
// büyütür. Kalite kapısını korurken yalnız en uygun, mümkünse farklı sağlayıcıdan
// inceleyicileri seç: normal görevde bir, güçlü/yüksek riskli görevde en çok iki.
export function selectTaskReviewers(task, author, candidates, reviewRounds = 1) {
  const wanted = task?.tier === "strong" && reviewRounds > 1 ? 2 : 1;
  return [...candidates]
    .filter((member) => member?.id && member.id !== task?.assignee)
    .sort((a, b) => {
      const score = (member) =>
        (member.role === "denetci" ? 4 : 0) +
        (author && member.provider !== author.provider ? 2 : 0) +
        (member.role && member.role !== "auto" ? 1 : 0);
      return score(b) - score(a) || String(a.id).localeCompare(String(b.id));
    })
    .slice(0, wanted);
}

export function studioEnhancementPrompt({ text, mediaKind="image", engine="openai-image", aspect="1:1", quality="standard", duration="auto", hasReferences=false }={}) {
  const medium=mediaKind==="video"?"video":"görsel";
  const timing=mediaKind==="video" ? ` Hedef süre: ${duration==="auto"?"modelin doğal kısa video süresi":duration+" saniye"}.` : "";
  return `Kullanıcının kısa fikrini seçili üretim motoruna doğrudan verilebilecek profesyonel bir ${medium} promptuna dönüştür. Yalnız nihai promptu yaz; açıklama, başlık, Markdown veya tırnak kullanma. Kullanıcının niyetini değiştirme ve yeni ana konu uydurma. ${mediaKind==="video"?"Sahne akışı, özne hareketi, kamera hareketi, lens/kadraj, ışık, atmosfer, fiziksel tutarlılık, zamanlama ve ses tasarımını belirt.":"Kompozisyon, özne ayrıntıları, kamera/lens, ışık, renk, doku, mekân ve kalite ayrıntılarını belirt."} Motor: ${engine}. Oran: ${aspect}. Kalite: ${quality}.${timing}${hasReferences?" Ekli referansı doğrudan düzenleme girdisi kabul et; korunacak unsurları ve değişecek kısımları kesin biçimde ayır.":""}\n\nKISA FİKİR:\n${String(text||"").trim()}`;
}

// Orkestratör: konsey ÜYELERİNİ (kullanıcının tanımladığı, her biri bir
// sağlayıcıya bağlı kişilikler) yönetir. Üye sayısı serbesttir: 3 Codex mimar,
// 1 Claude denetçi vb. Koordinatörün sağlayıcısını da kullanıcı seçer.
export class Orchestrator {
  constructor(store, rootDir, config) {
    this.store = store;
    this.rootDir = rootDir;
    this.config = config;
    this.projectContext = new ProjectContext(rootDir);
    this.computerBridge = new ComputerBridge(this.rootDir);
    this.providers = {
      claude: new ClaudeAgent(store, rootDir),
      codex: new CodexAgent(store, rootDir),
      antigravity: new AntigravityAgent(store, rootDir),
      openrouter: new OpenRouterAgent(store, rootDir, { keyProvider:readOpenRouterKey }),
    };
    this.agents = this.providers; // geriye dönük uyumluluk
    this.coordinator = new Coordinator(store, this.providers, () => this.config.data.coordinator);
    this.providers.antigravity.onNeedsAttention = () => {
      this.notify("Ajan Konseyi 🔔", "Antigravity görev bekliyor — köprü çalışma alanındaki ajana inbox'u kontrol ettirin");
    };
    this._bridgeTimer = setInterval(() => this.refreshBridgeHealth(), 30_000);
    this._bridgeTimer.unref?.();
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
    if (prov === "openrouter") return this.config.data.apiProviders?.openrouter?.configured === true;
    return true;
  }

  availableMembers(run = null) {
    return this.members().filter((m) => m.enabled && providerAllowed(run, m.provider) && this.providerAvailable(m.provider));
  }

  mediaCapableMembers(attachments, list = this.availableMembers()) {
    return list.filter((m) => unsupportedAttachments(m.provider, attachments).length === 0);
  }

  async generateConversationTitle(run, userText) {
    if(!run||run.titleManual)return null;
    const originalTitle=run.title;
    const candidates=["antigravity","claude","codex"]
      .map((provider)=>this.availableMembers(run).find((m)=>m.provider===provider)).filter(Boolean);
    const prompt=`Bu konuşma için Türkçe, doğal ve açıklayıcı 3-7 kelimelik bir başlık üret. Yalnız başlığı yaz; tırnak, Markdown, emoji, noktalama veya açıklama ekleme. Kullanıcının cümlesinin başını kopyalama; konuşmanın gerçek amacını özetle.\n\nKullanıcının isteği:\n${truncate(userText,1800)}`;
    for(const member of candidates){
      if(run.titleManual)return null;
      const res=await this.providers[member.provider].send(prompt,{
        fresh:true,silent:true,sessionKey:`title#${run.id}#${member.provider}#${uid()}`,
        memberId:member.id,model:member.model||undefined,effort:member.effort||undefined,
        timeoutMs:member.provider==="antigravity"?45_000:60_000,
      });
      const title=res.ok?normalizeGeneratedConversationTitle(res.text):"";
      if(!title)continue;
      if(run.titleManual||run.title!==originalTitle)return null;
      run.title=title;
      run.titleProvider=member.provider;
      run.titleGeneratedAt=now();
      this.store.updateRun(run);
      return title;
    }
    return null;
  }

  async enhanceStudioPrompt(input={}) {
    const providerName=input.engine==="openai-image"?"codex":"antigravity";
    const member=this.availableMembers().find((m)=>m.provider===providerName);
    if(!member) throw new Error(`${providerName==="codex"?"Codex":"Antigravity"} etkin değil`);
    const run={id:uid("studio-prompt-"),kind:"studio_prompt",transient:true,messages:[],tasks:[],usage:{},attachments:input.attachments||[],agents:[member.id],stopRequested:false,projectDir:null,request:String(input.text||"")};
    const images=(input.attachments||[]).filter((a)=>a.kind==="image"&&a.path).map((a)=>a.path);
    const res=await this.callMember(run,member,studioEnhancementPrompt({...input,hasReferences:images.length>0}),{fresh:true,images,media:input.attachments||[],label:"prompt güçlendiriliyor",timeoutMs:90_000});
    if(!res.ok) throw new Error(res.error||"Prompt güçlendirilemedi");
    return String(res.text||"").replace(/^```(?:text|markdown)?\s*/i,"").replace(/```$/," ").trim();
  }

  // Antigravity ajanı şu anda fiilen izleme yapıyor mu? (taze kalp atışı)
  antigravitySleeping() {
    // Native agy CLI kalıcı bir GUI/daemon kalp atışına ihtiyaç duymaz; ilk
    // görevde başlatılır. Henüz çağrılmamış olması "uyuyor" anlamına gelmez.
    return false;
  }

  memberListText(list) {
    return list.map((m) =>
      `- ${m.id} | ${m.name} | ${m.provider} | rol=${m.role}${m.model ? ` | model=${m.model}` : ""}`
    ).join("\n");
  }

  explicitlyRequestedMember(text, list = this.availableMembers()) {
    const value = String(text || "");
    for (const member of list) {
      if (member.provider === "antigravity") {
        // Adin metinde SADECE gecmesi yeterli degildir. Eskiden ciplak
        // "antigravity" sozcugu bile turu tek uyeye indiriyordu; is bolumu
        // anlatan bir istekte uye adlarini saymak butun turu cokertiyordu.
        const direct = /@antigravit(?:y|iy)\b|\bantigravit(?:y|iy)\b.{0,32}\b(?:yapsın|yanıtlasın|devam etsin|çalışsın|üretsin|incelesin)\b|\b(?:bunu|işi|görevi)\s+antigravit(?:y|iy)\b/i;
        const denied = /\bantigravit(?:y|iy)\s+(?:değil|olmasın)\b/i;
        if (direct.test(value) && !denied.test(value)) return member;
      }
      const labels = [member.name, member.provider].filter(Boolean)
        .map((label) => String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      for (const label of labels) {
        const direct = new RegExp(`@${label}\\b|\\b${label}\\b.{0,32}\\b(?:yapsın|yanıtlasın|devam etsin|çalışsın|üretsin|incelesin)\\b|\\b(?:bunu|işi|görevi)\\s+${label}\\b`, "i");
        const denied = new RegExp(`\\b${label}\\s+(?:değil|olmasın)\\b`, "i");
        if (direct.test(value) && !denied.test(value)) return member;
      }
    }
    return null;
  }

  sessionKeyFor(run, member) {
    return `${run.id}#${member.id}`;
  }

  acquireAgentLease(run,member,type,resource,label,ttlMs=15*60_000){
    if(!this.resourceLeases)return null;
    return this.resourceLeases.acquireLease({type,resource,owner:{runId:run.id,taskId:String(label||""),agentId:member?.id||"system",label:member?.name||label||"Ajan Konseyi"},ttlMs,metadata:{provider:member?.provider||"system"}});
  }
  releaseAgentLease(lease){if(!lease||!this.resourceLeases)return;try{this.resourceLeases.releaseLease(lease.id,lease.token);}catch{}}
  exportArtifacts(run,stage="snapshot"){if(!this.artifactExporter)return null;try{return this.artifactExporter(run,stage);}catch(error){this.log(`artifact export başarısız: ${String(error.message||error)}`);return null;}}

  // Ortak gecmis modele few-shot ornek gibi okunur. Bos yanitlar, sagayici
  // hata satirlari ve ayni sorunun tekrarlari modeli yanlis ornege ozendirdigi
  // icin baglama alinmaz; ayni soru yalniz son haliyle kalir.
  conversationHistoryMessages(messages) {
    const NOISE = /^(Tur hatayla bitti|.+ yanıt veremedi:|⏹ Durduruldu)/;
    const usable = messages.filter((m) => {
      const content = String(m?.content || "").trim();
      if (!content) return false;
      if (m.kind === "error") return false;
      if (m.from === "sistem" && NOISE.test(content)) return false;
      return true;
    });
    const lastUserAt = new Map();
    usable.forEach((m, i) => {
      if (m.from !== "kullanici") return;
      lastUserAt.set(String(m.content || "").trim(), i);
    });
    // Yinelenen soru dusunce ona verilmis yanit da dusmeli; aksi halde eski
    // yanit yetim kalip yeni istegin hemen onune gelir ve ornek gibi okunur.
    const kept = [];
    let dropping = false;
    usable.forEach((m, i) => {
      if (m.from === "kullanici") {
        dropping = lastUserAt.get(String(m.content || "").trim()) !== i;
        if (!dropping) kept.push(m);
        return;
      }
      if (!dropping) kept.push(m);
    });
    return kept;
  }

  sharedConversationContext(run, maxChars = 24_000) {
    const messages = this.conversationHistoryMessages(run.messages || []);
    const lines = messages.map((m) => {
      const who = m.from === "kullanici" ? "Kullanıcı" : (m.fromLabel || this.memberById(m.from)?.name || "Sistem");
      const attachments = (m.attachments || []).map((a) => ` [Ek: ${a.name}, ${a.kind || a.mime}]`).join("");
      return `${who}: ${String(m.content || "").trim()}${attachments}`;
    });
    let text = lines.join("\n\n");
    if (text.length > maxChars) text = "…(önceki bölüm kısaltıldı)…\n" + text.slice(-maxChars);
    return text;
  }

  referencedImages(run, prompt, currentImages = []) {
    if (currentImages.length) return currentImages;
    if (!/(?:\bbu(?:na|nu|nun)?\b|önceki|yukarıdaki|az önce|aynı|benzer|referans|görsel|fotoğraf|resim)/i.test(prompt)) return [];
    for (const message of [...(run.messages || [])].reverse()) {
      const images = (message.attachments || []).filter((a) => a.kind === "image" && a.path && fs.existsSync(a.path)).map((a) => a.path);
      if (images.length) return images;
    }
    return [];
  }

  // Üye çağrısı: durum rozetini yönetir, kullanım verisini üyeye yazar
  // ---- Runtime kimlik zarfi ----
  // Rozet, mesaji kimin URETMESI ISTENDIGINE degil GERCEKTEN kimin urettigine
  // bakmalidir. Her cagri icin istenen uye, fiilen calisan saglayici/model ve
  // varsa devir nedeni kaydedilir; UI kimligi bu zarftan okur. Ajanin kendi
  // metninde "ben Xim" demesi kanit sayilmaz.
  recordEnvelope(run, { requestedMember, actualProvider, actualModel, label, reason = null, startedAt, ok = true }) {
    run.envelopes = run.envelopes || [];
    const envelope = {
      id: uid("exec-"),
      requestedMemberId: requestedMember?.id || null,
      requestedMemberName: requestedMember?.name || null,
      requestedProvider: requestedMember?.provider || null,
      actualProvider: actualProvider || requestedMember?.provider || null,
      actualModel: actualModel || null,
      substituted: Boolean(actualProvider && requestedMember?.provider && actualProvider !== requestedMember.provider),
      reason, label: label || null, ok,
      startedAt: startedAt || new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    run.envelopes.push(envelope);
    appendRunEvent(run, "provider.finished", {
      envelopeId: envelope.id, requestedProvider: envelope.requestedProvider,
      actualProvider: envelope.actualProvider, actualModel: envelope.actualModel,
      substituted: envelope.substituted, ok: envelope.ok,
    }, envelope.endedAt);
    if (run.envelopes.length > 400) run.envelopes = run.envelopes.slice(-400);
    // Kalicilik istege baglidir: zarf zaten run nesnesinde. Minimal bir store
    // (testler, gomulu kullanim) cagri yolunu dusurmemeli.
    this.store.saveRun?.(run);
    return envelope;
  }

  async callMember(run, member, prompt, opts = {}) {
    assertProviderAllowed(run, member?.provider);
    const used=Object.values(run.usage||{}).reduce((sum,item)=>({calls:sum.calls+(item.calls||0),tokens:sum.tokens+(item.input||0)+(item.output||0)}),{calls:0,tokens:0});
    const budget=run.budget||{enabled:false,maxCalls:24,maxTokens:250000};
    if(budget.enabled&&!opts.ignoreBudget&&(used.calls>=budget.maxCalls||used.tokens>=budget.maxTokens)){
      budget.stopped=true;budget.reason=used.calls>=budget.maxCalls?"Çağrı bütçesi doldu":"Token bütçesi doldu";run.budget=budget;this.store.saveRun(run);
      return{ok:false,error:`${budget.reason}. Bütçeyi artırarak görevi sürdürebilirsiniz.`,budgetExceeded:true};
    }
    // Bağlayıcı seçimini zenginleştirilmiş prompttan/sohbet geçmişinden yapma.
    // Aksi halde geçmişte geçen "GitHub" gibi bir sözcük, sıradan Ox Alpha
    // mesajını Codex bağlayıcısına yönlendirip yanlış sağlayıcı çalıştırır.
    const resolvedCwd = resolveMemberCwd(run, opts);
    if (resolvedCwd !== opts.cwd) opts = { ...opts, cwd: resolvedCwd };

    const routeText = opts.routeText ?? prompt;
    const identityQuestion = isIdentityQuestion(routeText);
    // Kimlik soruları hiçbir bağlayıcıya veya ortak Codex köprüsüne devredilemez.
    const route = identityQuestion ? null : connectorRoute(member.provider, routeText);
    if (route?.mode === "shared") assertProviderAllowed(run, route.provider);
    const provider = this.providers[route?.mode === "shared" ? route.provider : member.provider];
    let connectorLease=null;
    const connectorMode=connectorAccessMode(route?.connector,routeText);
    // Okuma/arama bağlantıları paylaşılabilir. Yalnız dış serviste durum
    // değiştiren işlemler özel lease alır. Ortak Codex köprüsünde lease sahibi
    // görünen üye değil, işlemi gerçekten yürüten sağlayıcıdır.
    if(route?.connector&&connectorMode==="write"&&!opts.isolated){
      const leaseMember=route.mode==="shared"
        ? {id:`connector-${route.provider}`,name:`${route.provider} bağlayıcısı`,provider:route.provider}
        : member;
      try{connectorLease=this.acquireAgentLease(run,leaseMember,"external-service",route.connector,opts.label||"connector");}
      catch(error){this.store.setAgentStatus(member.id,"error",String(error.message).slice(0,80));return{ok:false,error:error.message,orchestrationError:true};}
    }
    try {
    this.store.setAgentStatus(member.id, "busy", opts.label || "");
    // Eski yanlış yönlendirmeler oturum geçmişine "Ben Codex'im" yazmış olabilir.
    // Kimlik doğrulamasını kirlenmiş geçmişten tamamen ayır.
    // opts.lean: DAR BAGLAM. Denetci gibi tek islik cagrilarda ortak gecmis,
    // yetenek sozlesmesi ve tarayici/yayin yardimlari isteme girmez; cwd ve
    // dosya araclari calismaya devam eder (denetci iddialari koddan dogrular).
    // isolated'dan farki: izolasyon araclari da kapatir, lean yalniz istemi
    // inceltir. Olculen sorun: 5 KB'lik dosyanin denetimine 73k girdi token.
    const history = opts.isolated || opts.lean || identityQuestion ? "" : this.sharedConversationContext(run);
    const images = opts.isolated ? [] : this.referencedImages(run, prompt, opts.images || []);
    const effectiveOpts = { ...opts, images };
    const capabilityContract = `--- AJAN KONSEYİ ORTAK YETENEK SÖZLEŞMESİ ---
Arka planda, kullanıcıdan rutin onay istemeden çalış. Sağlayıcında bulunan terminal, dosya düzenleme, web araştırma/tarayıcı, görsel okuma-üretme, MCP, eklenti, skill, alt ajan, plan ve görev araçlarını gerektiğinde doğrudan kullan. Yapabildiğin işi tarif etmekle yetinme; tamamla ve sonucu doğrula. Ürettiğin görsel, video, ses, PDF, belge, sunum, tablo veya diğer dosyaları proje bağlıysa PROJENİN İÇİNE (tercihen <proje>/cikti/ altına), proje yoksa ${this.rootDir}/generated dizinine gerçek dosya olarak kaydet ve yanıtta mutlak dosya yolunu ayrı satırda ver. Webden alınan güncel iddialarda kaynak bağlantılarını ekle. Kullanıcı özellikle istemedikçe uygulama/GUI açma. Yalnız kullanıcı hesabı, ödeme, yayınlama, silme veya geri döndürülemez işlem gerçekten gerekiyorsa dur.
Çalışırken yalnız anlamlı aşamalarda kısa durum bildir; her araç çağrısını, düşünceyi veya ham JSON'u kullanıcıya dökme. Nihai yanıtta sonuçla başla, yapılanları kısa ve doğal biçimde özetle, doğrulamayı belirt ve gereksiz başlık/listeler kullanma. Ajan Konseyi arayüzündeki üslup tüm sağlayıcılarda aynı, sade ve profesyonel olmalıdır.
--- SÖZLEŞME SONU ---`;
    const browserToken=opts.isolated||opts.lean?null:this.browserBridge?.issueAgentToken({actor:member.name,provider:member.provider});
    const browserHelp=browserToken?`\n\n--- UYGULAMA TARAYICI ARACI ---\nKullanıcı tarayıcıda açma, inceleme, tıklama veya yazma istediğinde curl, localhost, MCP ya da kendi browser aracını kullanma. Bunun yerine yanıtının TAMAMINI şu makine-okur biçiminde döndür:\n<<<AJAN_BROWSER_ACTION>>>{"action":"snapshot","payload":{}}<<<END>>>\nEylemler: open {url}, snapshot {}, navigate {url}, click {elementId}, type {elementId,text}. Açık sekmeyi incelemek için önce snapshot; yeni site için open kullan. Araç sonucu sana otomatik geri verilecek ve aynı işi sürdürmen istenecek. Normal alanlarda işlem yap; e-posta/kullanıcı adı, parola, OTP ve ödeme alanlarını kullanıcı doldurur. Bu köprü Codex, Claude ve Antigravity için aynıdır.\n--- TARAYICI ARACI SONU ---`:"";
    // Bilgisayar kullanimi: uye ekrani gorup fare/klavye kullanabilir.
    // Kullanicinin acik istegi olmadan tanitilmaz ki uye kendiliginden
    // ekrana uzanmaya kalkmasin; tur basina bir kez onay alinir.
    const bilgisayarIstegi=/(?:ekran(?:ım|ımı|da|daki|ini)?|bilgisayar(?:ımı|ımda|ı)?|masaüstü|uygulamay[ıi]|pencere(?:yi|de)?|tıkla|fare|klavye|yaz(?:ıp|arak)? gönder|erişilebilirlik)/iu.test(String(prompt||""));
    const computerHelp=(!opts.lean&&!opts.isolated&&this.computerBridge&&bilgisayarIstegi)?`\n\n--- BİLGİSAYAR KULLANMA ARACI ---\nKullanıcının EKRANINI görmen veya fare/klavye kullanman gerekiyorsa (uygulama penceresi incele, düğmeye tıkla, forma yaz) yanıtının TAMAMINI şu biçimde döndür:\n<<<AJAN_BILGISAYAR>>>{"action":"screenshot","payload":{}}<<<END>>>\nEylemler: screenshot {}, click {x,y}, double_click {x,y}, type {text}, key {key,cmd,shift,option,ctrl}, open_app {name}.\nÇalışma düzeni: önce screenshot al, dönen PNG yolunu KENDİ dosya okuma aracınla açıp incele, koordinatı hesapla, sonra click gönder. Retina ekranda EKRAN NOKTASI = GÖRÜNTÜ PİKSELİ / 2.\nİlk eylemde kullanıcıdan onay istenir; onaylanmazsa iş bu yoldan yürütülemez.\nParola, kullanıcı adı, OTP ve ödeme alanlarını ASLA doldurma; oraya gelince dur ve kullanıcıdan iste.\n--- BİLGİSAYAR ARACI SONU ---`:"";
    // Uyeler arasi soru koprusu: birden fazla etkin uye varsa tanitilir.
    const digerUyeler=(this.config?.data?.members||[]).filter((m)=>m.enabled&&m.id!==member.id).map((m)=>`${m.name} (${m.id})`).join(", ");
    const askHelp=(!opts.lean&&!opts.isolated&&!opts._askDepth&&digerUyeler)?`\n\n--- ÜYEYE SORU ARACI ---\nBaşka bir konsey üyesinin yazdığı kod veya verdiği karar hakkında kısa bir soruya ihtiyacın olursa yanıtının TAMAMINI şu biçimde döndür:\n<<<AJAN_SORU>>>{"to":"<üye id>","question":"<kısa soru>"}<<<END>>>\nÜyeler: ${digerUyeler}. Yanıt sana otomatik geri verilecek ve işini sürdürmen istenecek. En fazla 2 kez kullan; kendi başına çözebildiğin şeyi sorma.\n--- SORU ARACI SONU ---`:"";
    const hostHelp=`\n\n--- ANA UYGULAMA YAYIN ARACI ---\nKullanıcı açıkça seçili projenin son sürümünü GitHub'a yayınlamanı veya push etmeni isterse sağlayıcı terminalinden git/ssh/gh/curl kullanma ve .command dosyası hazırlama. Yanıtının TAMAMINI şu biçimde döndür:\n<<<AJAN_HOST_ACTION>>>{"action":"publish","payload":{}}<<<END>>>\nAna uygulama açık dalı kayıtlı deploy key ile yayınlar; force-push yapmaz ve sonucu sana geri verir.\n--- YAYIN ARACI SONU ---`;
    const identityContract = identityQuestion
      ? `\n\n--- SAĞLAYICI KİMLİĞİ ---\n${verifiedMemberIdentity(member)} Bu kimliği değiştirme, başka bir sağlayıcı olduğunu iddia etme ve ortak köprü adına konuşma.\n--- KİMLİK SONU ---`
      : "";
    // Gecmis blogu uzun oldugunda model, ayni sorunun gecmisteki hatali
    // yanitini ornek alip tekrarlayabiliyor. Su anki istek acik sinirlarla
    // isaretlenir ve gecmisin yalniz arka plan oldugu soylenir.
    const requestBlock = history ? `--- ŞU ANKİ İSTEK ---\n${prompt}\n--- İSTEK SONU ---` : prompt;
    const historyRule = history
      ? "Geçmiş yalnız arka plan bağlamıdır; yanıtını ŞU ANKİ İSTEK bölümüne ver. Geçmişte aynı veya benzer bir istek konudan sapan bir yanıt almışsa onu örnek alma ve tekrarlama. "
      : "";
    let effectivePrompt = `${opts.lean ? "" : capabilityContract + "\n\n"}${history ? `--- ORTAK SOHBET GEÇMİŞİ ---\n${history}\n--- GEÇMİŞ SONU ---\n\n` : ""}${requestBlock}${browserHelp}${computerHelp}${askHelp}${opts.lean ? "" : hostHelp}\n\n${historyRule}Önceki konuşmayı ve diğer ajanların yanıtlarını aynı sohbetin bağlamı kabul et. Kullanıcı açıkça konu değiştirmedikçe kaldığı yerden devam et; geçmişte verilmiş bilgi veya eki tekrar isteme.`;
    // Kullanicinin ARA YONLENDIRMELERI (tur calisirken yazdigi fikirler) ve
    // yarida kesilmis tur notlari bir SONRAKI uye cagrisina islenir: is
    // birakilmaz, kaldigi yerden yeni bilgiyle surdurulur.
    if (!opts.isolated && Array.isArray(run.steeringNotes) && run.steeringNotes.length) {
      const notlar = run.steeringNotes.splice(0).map((n) => `- ${n}`).join("\n");
      this.store.updateRun(run);
      effectivePrompt = `--- KULLANICIDAN ARA YÖNLENDİRME ---\n${notlar}\nBu notları şu anki işine HEMEN dahil et; işi baştan alma, kaldığın yerden sürdür.\n--- ARA YÖNLENDİRME SONU ---\n\n${effectivePrompt}`;
    }
    if (opts.style === "codex" && !opts.lean && !opts.isolated) effectivePrompt += CODEX_STYLE_CONTRACT;
    if (identityQuestion) effectivePrompt += identityContract;
    if(opts.isolated) effectivePrompt=`--- İZOLE İNCELEME: ORTAK GEÇMİŞ, ARAÇLAR VE BAĞLAYICILAR KAPALI ---\n\n${prompt}\n\nBu çağrı bağımsızdır; önceki konuşma veya sağlayıcı oturumu kullanma.`;
    if (route?.mode === "shared" && !opts.isolated) {
      const label = CONNECTORS[route.connector]?.label || route.connector;
      this.store.setAgentStatus(member.id, "busy", `${label} · ortak Codex köprüsü`);
      this.store.streamProgress(member.id, `${label} bağlayıcısı kullanılıyor`, "");
      effectivePrompt = bridgePrompt(route, effectivePrompt);
    }
    // Antigravity'nin headless language_server sürümü ImageData alanını RPC'de
    // kabul etse de bazı hesap/model kombinasyonlarında modele aktarmıyor.
    // macOS Vision OCR/sınıflandırması tamamen cihazda çalışır; görsel başka bir
    // modele veya servise gönderilmeden güvenilir bağlam olarak aktarılır.
    if (member.provider === "antigravity" && images.length) {
      let vision;
      try { vision = await this.analyzeImages(images); }
      catch (err) {
        this.log(`yerel görsel çözümleme atlandı: ${String(err.message || err)}`);
        vision = "";
      }
      if (vision) effectivePrompt += `\n\n--- CİHAZDA ÇÖZÜMLENEN GÖRSEL İÇERİĞİ ---\n${vision}\n--- GÖRSEL İÇERİĞİ SONU ---\nBu içeriği ekli görsel bağlamı olarak kullan; erişemediğini söyleme.`;
    }
    // Antigravity'de otomatik tier modeli -low/-medium/-high son eki taşır ve
    // --effort ile çakışır. Kullanıcı açık model seçmediyse effort tercihini
    // koru; bu durumda hesabın varsayılan modelini agy seçsin.
    const suppressAntigravityTier = member.provider === "antigravity" && !member.model && !!member.effort;
    const selectedModel = member.model || (suppressAntigravityTier ? "" : (opts.tierModel || undefined));
    // Adim gunlugu: ajanin yaptiklari (okudu/yazdi/calistirdi...) canli
    // olarak arayuze akar, bitince mesaja ilistirilip kalici olur.
    const stepLog = new StepLog({ onChange: (list) => this.store.streamSteps?.(member.id, list) });
    const providerOpts = {
      ...effectiveOpts,
      steps: stepLog,
      // Kimlik karari tek yerde uretilir; saglayici ajanlari bunu yeniden
      // hesaplamak yerine devralir.
      identityQuestion,
      fresh: identityQuestion ? true : effectiveOpts.fresh,
      sessionKey: opts.sessionKey || (route?.mode === "shared"
        ? `${this.sessionKeyFor(run, member)}#connector#${route.connector}`
        : this.sessionKeyFor(run, member)),
      memberId: member.id,
      model: selectedModel,
      effort: member.effort || undefined,
      onUsage: (u) => { this.accumUsage(run, member.id, u); this.trackSessionContext(run, member, u); },
    };
    const envStartedAt = new Date().toISOString();
    let res = await provider.send(effectivePrompt, providerOpts);
    const attachSteps = () => {
      const finished = stepLog.finish();
      if (finished && res && typeof res === "object") res.steps = finished;
      // memberMsg cagrildiginda mesaja ilistirilsin diye uye basina bekletilir.
      if (finished) (this._pendingSteps ||= {})[member.id] = finished;
      // Dosya izlenebilirligi: bu turda hangi uye hangi dosyayi okudu/yazdi.
      // Adim basliklarindaki dosya adlari toplanir; tur sonunda harita mesaji dusler.
      if (finished && !opts.isolated && run.turnActive) {
        const harita = (run.turnFileMap ||= {});
        for (const st of finished.steps) {
          const dosyalar = String(st.title).match(/[\w./-]+\.(?:html?|js|mjs|cjs|ts|tsx|jsx|css|scss|json|md|txt|py|rb|go|rs|java|sh|zsh|yml|yaml|toml|xml|svg|sql|swift|kt|c|h|cpp|hpp|plist|lock|env|cfg|ini|csv|patch|diff|conf)\b/gi) || [];
          for (const dosya of dosyalar.slice(0, 6)) {
            const kayit = (harita[dosya] ||= { okuyan: [], yazan: [] });
            const liste = st.kind === "yazdi" ? kayit.yazan : (["okudu", "aradi"].includes(st.kind) ? kayit.okuyan : null);
            if (liste && !liste.includes(member.name)) liste.push(member.name);
          }
        }
      }
    };
    // Sağlayıcı sandbox'ının localhost erişimine bel bağlama. Üç sağlayıcının da
    // yapılandırılmış isteğini orkestratör kendi güvenilir köprüsünde çalıştırır.
    for(let step=0;res.ok&&step<12;step++){
      const browserAction=browserToken&&parseBrowserAction(res.text);
      const computerAction=(computerHelp&&parseComputerAction(res.text))||null;
      const hostAction=parseHostAction(res.text);
      const askAction=(!opts._askDepth&&parseAgentAsk(res.text))||null;
      if(!browserAction&&!computerAction&&!hostAction&&!askAction)break;
      const action=browserAction||computerAction||hostAction||askAction;
      let result;
      try{
        if(askAction){
          const hedefUye=this.memberById(askAction.to)||(this.config?.data?.members||[]).find((m)=>m.enabled&&m.name.toLocaleLowerCase("tr-TR")===askAction.to.toLocaleLowerCase("tr-TR"));
          if(!hedefUye||!hedefUye.enabled||hedefUye.id===member.id)throw new Error("Geçersiz üye: "+askAction.to);
          stepLog.add("devretti",`${hedefUye.name} üyesine soruldu`,`soru: ${askAction.question}`);
          const cevap=await this.callMember(run,hedefUye,`Konsey üyesi ${member.name} sana soruyor (kısa ve net yanıtla):\n${askAction.question}`,{lean:true,_askDepth:1,label:`${member.name} → ${hedefUye.name}`,timeoutMs:180_000});
          result=cevap.ok?{answer:String(cevap.text||"").slice(0,4000),from:hedefUye.name}:{error:String(cevap.error||"yanıt alınamadı")};
        }
        else if(browserAction)result=await this.browserBridge.request({token:browserToken,...browserAction});
        else if(computerAction){
          // Tur basina BIR KEZ sorulur; kullanicinin karari (evet/hayir) tur boyunca gecerli.
          if(run._computerOnay===undefined){
            this.notify("Ajan Konseyi ⚠", "Bilgisayar kullanma onayı bekleniyor");
            run._computerOnay=await this.store.requestApproval(run,{
              kind:"computer",
              title:"Bilgisayar kullanma onayı",
              detail:`${member.name} ekranınızı görmek ve fare/klavye kullanmak istiyor. İlk eylem: ${describeComputerAction(computerAction).title}. Onay bu tur boyunca geçerlidir; parola, OTP ve ödeme alanlarını üye doldurmaz.`,
            });
          }
          if(!run._computerOnay)result={error:"Kullanıcı bilgisayar kullanımını onaylamadı. Bu yolu bırak; işi ekransız tamamla veya kullanıcıya devret."};
          else result=await this.computerBridge.request(computerAction);
        }
        else{
          if(!isExplicitPublishRequest(prompt))throw new Error("Yayınlama için kullanıcının bu mesajda açık talebi gerekli");
          const projectDir=run.projectDir||process.env.AJAN_KONSEYI_SOURCE_DIR;
          const deployKey=path.join(this.rootDir,"generated","ajan-konseyi-deploy");
          const gate=this.enforceEvidenceGate(run,"publish");
          const publishLease=this.acquireAgentLease(run,member,"external-service",`github:${path.resolve(projectDir)}`,"publish",30*60_000);
          try{result={...await gitops.publishCurrentBranch(projectDir,deployKey,String(hostAction.payload.branch||"")),evidenceGate:gate};}
          finally{this.releaseAgentLease(publishLease);}
        }
      }
      catch(error){result={error:String(error.message||error)};}
      // Jeton kullaniciya gorunmez; eylem katlanir bir adim satiri olur.
      // Ham istek+sonuc detayda saklanir — tiklaninca acilir (Codex'in
      // "Ran page script ›" davranisi).
      if(!askAction){
        const tarif=computerAction?describeComputerAction(action):describeAgentAction(action);
        stepLog.add(tarif.kind,tarif.title,
          `istek: ${JSON.stringify(action,null,1).slice(0,1500)}\nsonuç: ${JSON.stringify(result,null,1).slice(0,3000)}`,
          {status:result&&result.error?"failed":"ok"});
      }
      const followup=`--- ANA UYGULAMA ARAÇ SONU ---\nİstenen eylem: ${JSON.stringify(action)}\nSonuç: ${JSON.stringify(result)}\n--- SONUÇ BİTTİ ---\nKullanıcının görevini sürdür. Başka bir araç eylemi gerekiyorsa ilgili ACTION biçimini döndür; iş tamamlandıysa normal nihai yanıtını ver.`;
      res=await provider.send(opts.fresh?`${effectivePrompt}\n\n${followup}`:followup,{...providerOpts,fresh:opts.fresh});
    }
    // Nihai yanitta jeton kalintisi kalmasin: 12 tur biter ya da model jetonun
    // yanina duz metin eklerse ayikla (adim satiri zaten kaydedildi).
    if (res && typeof res.text === "string" && /<<<AJAN_(?:BROWSER_ACTION|HOST_ACTION|SORU|BILGISAYAR)>>>/.test(res.text)) {
      const temiz = stripActionTokens(res.text);
      res = { ...res, text: temiz || "Tarayıcı eylemi yürütüldü; ayrıntı adım satırında." };
    }
    if (identityQuestion && res.ok && !identityResponseMatchesProvider(member, res.text)) {
      this.log(`kimlik yanıtı düzeltildi: ${member.provider} -> ${String(res.text || "").slice(0, 160)}`);
      res = { ...res, text: verifiedMemberIdentity(member), raw: { ...(res.raw || {}), identityCorrected: true } };
    }
    attachSteps();
    const stopped = run.stopRequested;
    this.store.setAgentStatus(member.id, res.ok || stopped ? "idle" : "error",
      res.ok || stopped ? "" : String(res.error || "").slice(0, 80));
    if (route && res?.raw) res.raw.connectorRoute = route;
    // Gercekten hangi saglayici/model calisti? Rozet bunu okur.
    this.recordEnvelope(run, {
      requestedMember: member,
      actualProvider: route?.mode === "shared" ? route.provider : member.provider,
      actualModel: providerOpts?.model || member.model || null,
      label: opts.label,
      reason: route?.mode === "shared" ? `ortak bağlayıcı: ${route.connector}` : null,
      startedAt: envStartedAt,
      ok: res?.ok !== false,
    });
    return res;
    } finally {
      // Sağlayıcı, görsel çözümleyici veya araç köprüsü beklenmedik biçimde
      // hata atsa bile dış servis kilidi sonraki ajanları engellememeli.
      this.releaseAgentLease(connectorLease);
    }
  }

  isImageGenerationRequest(text) {
    const value=String(text||"").trim();
    const visual=/(?:görsel|fotoğraf|resim|image|illustration|illüstrasyon|poster|logo|ikon)/iu;
    if(!visual.test(value)) return false;

    // Sözcük varlığı niyet değildir. Olumsuzlama, geçmiş bir eylemi anlatma,
    // yetenek sorgusu ve meta inceleme hiçbir zaman üretim başlatmamalı.
    if(/(?:oluştur|üret|çiz|tasarla)(?:ma|me)\b|(?:oluştur|üret|çiz|tasarla)(?:manı|menı|manızı|menizi)?\s+(?:istemedim|demedim)|(?:oluştur|üret|çiz|tasarla)(?:dı|di|du|dü|tı|ti|tu|tü)\b/iu.test(value)) return false;
    if(/(?:yetenek denetimi|yeteneklerini? (?:öğren|incele|değerlendir|karşılaştır)|ayrı ayrı değerlendir|eksik yetenek|durumunu raporla|yapabiliyor mu|oluşturabiliyor mu|üretebiliyor mu|oluşturma yeteneği|üretme yeteneği|sana sordum|soruyorum|merak ediyorum)/iu.test(value)) return false;

    // Otomatik üretim yalnız açık bir emirle başlar. Fiil kökünü eşlemek yerine
    // tam emir biçimini eşlemek "oluşturdu/oluşturabiliyor" yanlışlarını önler.
    const explicitCommand=/(?:görsel|fotoğraf|resim|image|illustration|illüstrasyon|poster|logo|ikon).{0,120}\b(?:oluştur|üret|çiz|tasarla|generate|create)(?:ın|iniz)?\b|\b(?:oluştur|üret|çiz|tasarla|generate|create)(?:ın|iniz)?\b.{0,120}(?:görsel|fotoğraf|resim|image|illüstrasyon|poster|logo|ikon)/iu;
    const explicitWant=/(?:görsel|fotoğraf|resim|image|illüstrasyon|poster|logo|ikon).{0,80}(?:istiyorum|istiyoruz|hazırla|yap)(?:\b|$)/iu;
    const explicitPolite=/(?:bana|benim için|bunu|şunu).{0,140}(?:görsel|fotoğraf|resim|image|illüstrasyon|poster|logo|ikon)?.{0,80}(?:oluşturabilir|üretebilir|çizebilir|tasarlayabilir)\s+misin/iu;
    return explicitCommand.test(value) || explicitWant.test(value) || explicitPolite.test(value);
  }

  isImageRevisionRequest(run, text) {
    const previousImage=[...(run.messages||[])].reverse().some((m)=>(m.attachments||[]).some((a)=>a.kind==="image"&&a.generated));
    return previousImage && /(?:gerçekçi|fotogerçekçi|fotoğraf gibi|daha doğal|yeniden|tekrar|düzelt|değiştir|benzer|bunun neresi)/i.test(String(text||""));
  }

  imageGenerationPrompt(text) {
    if (!this.isImageGenerationRequest(text)) return String(text || "");
    const explicitIllustration = /(?:svg|vektör|vector|ikon|logo|çizgi|karikatür|cartoon|anime|illustration|illüstrasyon|flat design)/i.test(String(text || ""));
    return `${text}\n\n--- GÖRSEL ÜRETİM KALİTE SÖZLEŞMESİ ---
Yerleşik generate_image aracını doğrudan kullan. SVG, HTML, canvas, Mermaid, Python/çizim kodu, programatik rasterleştirme veya webden hazır görsel indirme kullanma.
${explicitIllustration
  ? "Kullanıcının açıkça istediği illüstrasyon/vektör stilini koru; yine de sonucu native görsel üretim aracıyla yüksek kaliteli raster olarak üret."
  : "Kullanıcı başka bir stil istemediyse varsayılan sonuç fotogerçekçi, doğal, profesyonel fotoğraf kalitesinde, doğru anatomi ve ince doku ayrıntılarıyla üretilsin; çocuk kitabı/clip-art/vektör görünümüne dönüştürme."}
Tek bir yüksek kaliteli PNG/JPEG/WebP çıktı üret. Aynı görselin SVG kopyasını hazırlama. Ara durum veya 'hazırlanıyor' metni yazma; yalnız araç tamamlandıktan sonra gerçek dosya yolunu bildir.
--- KALİTE SÖZLEŞMESİ SONU ---`;
  }

  requestedImageCount(text) {
    const value = String(text || "");
    const numeric = value.match(/\b(\d{1,2})\s*(?:adet|tane|farklı|varyasyon|görsel|resim|fotoğraf)/i)?.[1];
    return Math.max(1, Math.min(Number(numeric) || 1, 30));
  }

  async validatedImageAssets(requestText, assets) {
    const raster = (assets || []).filter((a) => a.kind === "image" && a.mime !== "image/svg+xml" && a.path && fs.existsSync(a.path));
    if (!raster.length) return [];
    const count = this.requestedImageCount(requestText);
    const rules = [
      { request: /(?:kedi|cat|kitten)/i, labels: /(?:\bcat\b|feline|kitten|adult_cat)/i },
      { request: /(?:köpek|dog|puppy)/i, labels: /(?:\bdog\b|canine|puppy)/i },
      { request: /(?:kuş|bird)/i, labels: /(?:\bbird\b|avian)/i },
      { request: /(?:araba|otomobil|car\b)/i, labels: /(?:automobile|vehicle|\bcar\b)/i },
    ];
    const rule = rules.find((item) => item.request.test(String(requestText || "")));
    if (!rule) return raster.slice(0, count);
    const accepted = [];
    for (const asset of raster) {
      try {
        const vision = await this.analyzeImages([asset.path]);
        if (rule.labels.test(vision)) accepted.push(asset);
      } catch (err) {
        this.log(`üretilen görsel kalite doğrulaması atlandı (${path.basename(asset.path)}): ${String(err.message || err)}`);
        accepted.push(asset); // Vision yoksa gerçek dosyayı haksız yere kaybetme.
      }
      if (accepted.length >= count) break;
    }
    return accepted;
  }

  keepOnlyAssetPaths(text, allAssets, keptAssets) {
    const kept = new Set((keptAssets || []).map((a) => path.resolve(a.path)));
    let result = String(text || "");
    for (const asset of allAssets || []) {
      if (!asset.path || kept.has(path.resolve(asset.path))) continue;
      const escaped = String(asset.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`^.*${escaped}.*$`, "gmi"), "");
    }
    return result.replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Koordinatörlü toplu görsel koşusu. Fikir/prompt iyileştirme işleri konsey
   * üyelerine dağıtılır; gerçek dosya üretimi yüksek kaliteli ortak raster
   * motorundan geçer. Worker havuzu aynı anda en fazla 6 dış
   * işlem açarak masaüstünü ve sağlayıcı oturumlarını korur.
   */
  startImageBatch(run, { prompts, concurrency = 4 } = {}) {
    const work = Array.isArray(prompts) ? prompts : [];
    const limit = Math.max(1, Math.min(Number(concurrency) || 4, 6, work.length || 1));
    run.turnActive = true;
    run.status = "running";
    run.phase = "image_planning";
    run.batch = { total:work.length, completed:0, failed:0, concurrency:limit, startedAt:new Date().toISOString() };
    const members = this.members().filter((m) => run.agents.includes(m.id));
    const advisers = members.filter((m) => ["claude", "codex", "antigravity"].includes(m.provider));
    run.tasks = work.map((prompt, index) => ({
      id:uid("img-"), title:`${run.imageStudio?.mediaKind === "video" ? "Video" : "Görsel"} ${index + 1}`, prompt,
      assignee:(advisers[index % Math.max(1, advisers.length)] || members[0])?.id || "antigravity",
      generator:run.imageStudio?.generatorId || "codex", status:"pending", result:null, error:null,
    }));
    this.store.updateRun(run);
    this.store.addMessage(run, { from:"koordinator", provider: this.config?.data?.coordinator?.provider || null, kind:"info", content:`${work.length} görsel görevi ${limit} eşzamanlı worker ile konseye dağıtıldı. Sanat yönetimini seçilen ajanlar, yüksek kaliteli raster üretimini ortak görsel motoru yapacak.` });
    this.runImageBatch(run, limit).catch((err) => this.failRun(run, err));
  }

  async runImageBatch(run, concurrency) {
    const members = this.members();
    const generator = members.find((m) => m.id === run.imageStudio?.generatorId) || members.find((m) => m.provider === "codex") || members.find((m) => m.provider === "antigravity") || {
      id:"shared-image-generator", name:"Ortak Görsel Motoru", provider:"codex", role:"uygulayici", model:"", effort:"",
    };
    let cursor = 0;
    const worker = async () => {
      while (!run.stopRequested) {
        const task = run.tasks[cursor++];
        if (!task) return;
        task.status = "running"; task.startedAt = new Date().toISOString();
        run.phase = "image_generating"; this.store.updateRun(run);
        const adviser = members.find((m) => m.id === task.assignee);
        try {
          const video=run.imageStudio?.mediaKind === "video";
          const engine=run.imageStudio?.engine || "openai-image";
          const duration=run.imageStudio?.duration;
          const format=`En-boy oranı ${run.imageStudio?.aspect || "1:1"}; kalite ${run.imageStudio?.quality || "standard"}.${video&&duration&&duration!=="auto"?` Süre tam ${duration} saniye.`:""}`;
          let productionPrompt = video ? `${task.prompt}\n${format}` : this.imageGenerationPrompt(`${task.prompt}\n${format}\nGörsel oluştur.`);
          // Görev sahibi kompozisyonu hazırlar; raster motoru ayrı çalışır.
          if (adviser && adviser.id !== generator.id) {
            const advised = await this.callMember(run, adviser,
              `Bu görsel için kısa, üretime hazır ve kullanıcı niyetine sadık bir prompt yaz. Canva, MCP veya görsel üretim aracı çağırma; dosya üretme. Yalnız üretim promptunu döndür.\n\n${task.prompt}`,
              { label:"görsel promptu hazırlıyor", timeoutMs:90_000, shouldStop:()=>run.stopRequested });
            if (advised.ok && advised.text?.trim()) productionPrompt = this.imageGenerationPrompt(`${advised.text.trim()}\nGörsel oluştur.`);
          }
          const referenceNote=attachmentPrompt(run.attachments||[]);
          const engineInstruction=video
            ? `Yerleşik Gemini video aracını ${engine === "veo-3.1" ? "Veo 3.1" : "Gemini Omni Flash Video"} motoruyla kullan. Gerçek MP4/MOV/WebM video ve varsa yerel ses üret.`
            : `Yerleşik görsel üretim aracını ${engine === "openai-image" ? "OpenAI GPT Image" : engine === "gemini-pro-image" ? "Gemini Nano Banana Pro (gemini-3-pro-image)" : "Gemini Nano Banana 2 (gemini-3.1-flash-image)"} motoruyla kullan. Referans varsa görseli yeniden tarif etmek yerine doğrudan düzenle.`;
          const generated = await this.callMember(run, generator,
            `${productionPrompt}${referenceNote}\n\n${engineInstruction} Dosyayı ${this.rootDir}/generated içine benzersiz bir adla kaydet ve mutlak dosya yolunu yaz. Gerçek medya dosyası olmadan görevi tamamlanmış sayma.`,
            { label:`${task.title} üretiliyor`, cwd:run.projectDir || this.rootDir,
              images:(run.attachments||[]).filter((a)=>a.kind==="image").map((a)=>a.path), media:run.attachments||[],
              sessionKey:`${run.id}#image#${task.id}`, timeoutMs:5*60*1000,
              shouldStop:()=>run.stopRequested });
          if (!generated.ok) throw new Error(generated.error || "Ortak görsel motoru başarısız");
          const assets = collectGeneratedAssets(generated.text, this.rootDir, run.projectDir)
            .filter((a) => a.kind === (video ? "video" : "image") && (video || a.mime !== "image/svg+xml") && a.path && fs.existsSync(a.path));
          const accepted = video ? assets.slice(0,1) : await this.validatedImageAssets(task.prompt, assets);
          if (!accepted.length) throw new Error("Native araç konuya uygun, açılabilir bir PNG/JPEG/WebP dosyası döndürmedi");
          const cleanResult = this.keepOnlyAssetPaths(generated.text, assets, accepted);
          task.status="done"; task.result=cleanResult; task.attachments=accepted; run.batch.completed++;
          this.memberMsg(run, adviser || generator, "result", cleanResult, task.id, task.prompt);
        } catch (err) {
          task.status="failed"; task.error=String(err.message || err); run.batch.failed++;
          this.store.addMessage(run, { from:"sistem", kind:"error", taskId:task.id, content:`${task.title} üretilemedi: ${task.error}` });
        } finally {
          task.endedAt = new Date().toISOString(); this.store.updateRun(run);
        }
      }
    };
    await Promise.all(Array.from({ length:concurrency }, worker));
    run.turnActive=false; run.batch.endedAt=new Date().toISOString();
    const stopped=run.stopRequested;
    this.store.updateRun(run, { status:stopped ? "stopped" : (run.batch.completed ? "done" : "failed"), phase:stopped ? "stopped" : "done" });
    this.store.addMessage(run, { from:"koordinator", provider: this.config?.data?.coordinator?.provider || null, kind:run.batch.failed ? "info" : "result", content:`Toplu üretim tamamlandı: ${run.batch.completed}/${run.batch.total} başarılı, ${run.batch.failed} hatalı.` });
    this.persistSessions(run);
  }

  async guaranteeImageOutput(run, requestedMember, requestText, responseText, opts = {}) {
    if (!this.isImageGenerationRequest(requestText) && !this.isImageRevisionRequest(run, requestText)) return responseText;
    const existing = collectGeneratedAssets(responseText, this.rootDir, run.projectDir);
    const explicitlySvg=/(?:\bsvg\b|vektör|vector)/i.test(String(requestText||""));
    const needsRaster=!explicitlySvg || /(?:gerçekçi|fotogerçekçi|fotoğraf|photoreal|realistic|insan|portre)/i.test(String(requestText||""));
    const eligible = existing.filter((a)=>a.kind==="image"&&a.path&&fs.existsSync(a.path)&&(!needsRaster||a.mime!=="image/svg+xml"));
    const validated = await this.validatedImageAssets(requestText, eligible);
    if(validated.length) return this.keepOnlyAssetPaths(responseText, existing, validated);

    // Bir sağlayıcı yalnız "oluşturdum" diyerek gerçek dosya döndürmediyse
    // Codex'in yüksek kaliteli raster aracını ortak motor
    // olarak kullan. Yanıt, istenen üyenin aynı mesajında render edilir.
    // Ortak motor devreye giriyor: bu bir KIMLIK DEVRIDIR. Zarfa yazilir ve
    // mesajda gorunur kilinir; "Antigravity" rozetiyle Codex ciktisi sunulmaz.
    run.imageEngineHandoff = run.imageEngineHandoff || {};
    const generator = this.members().find((m) => m.enabled && m.provider === "codex") ||
      this.members().find((m) => m.enabled && m.provider === "antigravity") || {
      id: "shared-image-generator", name: "Ortak Görsel Motoru", provider: "codex", role: "uygulayici", model: "", effort: "",
    };
    this.store.setAgentStatus(requestedMember.id, "busy", "görsel dosyası doğrulanıyor");
    this.store.streamProgress(requestedMember.id, "görsel üretiliyor", "");
    const generated = await this.callMember(run, generator,
      `Kullanıcının aşağıdaki görsel isteğini yerine getir. Bu görevde SVG, HTML, canvas, çizim kodu veya yalnız prompt KESİNLİKLE geçerli değildir. Yerleşik görsel üretim aracını MUTLAKA çağır ve gerçek piksel tabanlı PNG/JPEG/WebP üret. İstek gerçekçi/fotogerçekçi diyorsa bunu üretim promptunda açıkça koru; stilize illüstrasyona dönüştürme. Önceki görselin düzeltilmesi isteniyorsa sohbet geçmişindeki kompozisyonu referans al. Dosyayı ${this.rootDir}/generated içine kaydet, sips ile açılabildiğini doğrula ve mutlak yolu son yanıtta yaz.\n\nGÖRSEL İSTEĞİ / DÜZELTME:\n${requestText}`,
      { label:"görsel üretiliyor", cwd:run.projectDir || this.rootDir, images:opts.images || [], media:opts.media || [], timeoutMs:5*60*1000, shouldStop:()=>run.stopRequested }
    );
    if (!generated.ok) throw new Error(`Görsel üretilemedi: ${generated.error}`);
    const assets = collectGeneratedAssets(generated.text, this.rootDir, run.projectDir);
    const accepted = await this.validatedImageAssets(requestText, assets);
    if (!accepted.length) {
      throw new Error("Görsel motoru yanıt verdi ancak açılabilir bir görsel dosyası oluşturmadı");
    }
    // Geçersiz SVG/"yapamam" açıklamasını son mesaja taşımıyoruz; kullanıcı
    // yalnız gerçek üretim sonucunu ve raster önizlemeyi görür.
    // Kimlik devri kaydi: rozet bu bilgiyi okuyup "X motoruyla üretildi" der.
    run.imageEngineHandoff[requestedMember.id] = {
      engineProvider: generator.provider, engineName: generator.name, at: new Date().toISOString(),
    };
    this.recordEnvelope(run, {
      requestedMember, actualProvider: generator.provider, actualModel: generator.model || null,
      label: "görsel üretimi", reason: "ortak görsel motoru", ok: true,
    });
    this.store.saveRun?.(run);
    const engineLabel = generator.provider === requestedMember.provider ? "" :
      ` (görsel dosyası ${generator.provider} motoruyla üretildi)`;
    return `İstenen görsel yüksek kaliteli ortak görsel motoruyla oluşturuldu ve doğrulandı${engineLabel}.\n\n${this.keepOnlyAssetPaths(generated.text, assets, accepted)}`;
  }

  // Mesaja GERCEK saglayici ve model imzasi eklenir. Uye adi kullanici
  // tarafindan serbestce verildigi icin (ornegin "Antigravity" adli bir uyenin
  // arkasinda Claude olabilir) arayuzde adin yaninda saglayici rozeti gosterilir.
  memberSignature(member) {
    const model = member.model || this.pickTierModel(member.provider, "balanced") || "";
    return { provider: member.provider, model: model || null };
  }

  memberMsg(run, member, kind, content, taskId = null, requestText = "", summary = null) {
    // Uyenin bu cagrida biriken adim gunlugu mesajla birlikte kalici olur;
    // arayuz bitmis mesajda "⚙ N adım · X sn" katlanir blogu bundan cizer.
    const stepData = this._pendingSteps?.[member.id] || null;
    if (stepData) delete this._pendingSteps[member.id];
    let attachments = collectGeneratedAssets(content, this.rootDir, run.projectDir);
    const wantsVector = /(?:\bsvg\b|vektör|vector)/i.test(String(requestText || ""));
    if (!wantsVector && attachments.some((a) => a.kind === "image" && a.mime !== "image/svg+xml")) {
      attachments = attachments.filter((a) => a.mime !== "image/svg+xml");
    }
    let displayContent = attachments.some((a) => a.inlineSource === "svg")
      ? String(content).replace(/```(?:svg|xml)\s*\n[\s\S]*?<svg\b[\s\S]*?<\/svg>\s*```/gi, "_SVG tasarımı oluşturuldu; aşağıdaki önizlemeden açabilir veya indirebilirsiniz._")
      : content;
    // Üretilen dosya sohbet kartında zaten görsel olarak sunulur. Ham file://
    // bağlantılarını, mutlak yolları ve terminal benzeri doğrulama metnini
    // kullanıcıya gösterme; bunlar yalnız iç doğrulama için tutulur.
    // Kart olarak sunulan dosyanin mutlak yolu metinde ayrica satir olarak
    // durmasin (Codex yolu karta gomer, metinde tekrarlamaz).
    for (const a of attachments) {
      if (!a.path) continue;
      const yol = a.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      displayContent = String(displayContent).replace(new RegExp(`^\\s*\`?${yol}\`?\\s*$`, "gm"), "");
    }
    if (attachments.some((a) => a.generated)) {
      displayContent = String(displayContent)
        .replace(/\[[^\]]+\]\(file:\/\/\/[^)]+\)/gi, "")
        .replace(/`\/(?:Users|private|tmp)\/[^`\n]+\.(?:png|jpe?g|webp|gif|avif|svg|pdf|docx?|xlsx?|csv|mp4|mov|webm)`/gi, "")
        .replace(/^\s*(?:\*\*)?(?:Mutlak )?Dosya yolu:(?:\*\*)?\s*$/gmi, "")
        .replace(/^\s*\/(?:Users|private|tmp)\/[^\n]+\.(?:png|jpe?g|webp|gif|avif|svg|pdf|docx?|xlsx?|csv|mp4|mov|webm)\s*$/gmi, "")
        .replace(/\n{3,}/g, "\n\n").trim();
      if (!wantsVector) displayContent = displayContent
        .replace(/\s*\([^)]*(?:SVG|vektör)[^)]*\)/gi, "")
        .replace(/\b(?:ve|,)?\s*(?:ölçeklenebilir\s+)?vektör\s+SVG\s+format(?:ında|larında)?/gi, "");
      if (!displayContent) displayContent = "Görsel hazır.";
    }
    // Boş balon kullanıcı için sessiz başarısızlıktır: ne yanıt ne hata görür.
    // Sağlayıcı metin de dosya da üretmediyse bunu görünür bir hataya çevir.
    if (!String(displayContent).trim() && !attachments.length) {
      this.log(`${member.provider}/${member.name} boş yanıt döndürdü (kind=${kind})`);
      this.store.addMessage(run, { from: "sistem", kind: "error",
        content: `${member.name} boş yanıt döndürdü (sağlayıcı: ${member.provider}); mesaj yazılmadı. İsteği daraltıp yeniden deneyin.` });
      return [];
    }
    this.store.addMessage(run, {
      from: member.id, fromLabel: member.name, provider: member.provider,
      model: this.memberSignature(member).model,
      // Görsel ortak motorla üretildiyse gerçek üretici mesajda taşınır.
      engineProvider: (attachments.some((a) => a.kind === "image") && run.imageEngineHandoff?.[member.id]?.engineProvider !== member.provider)
        ? run.imageEngineHandoff?.[member.id]?.engineProvider || null : null,
      kind, taskId, content: displayContent, attachments, summary,
      steps: stepData,
    });
    return attachments;
  }

  // Yerel Vision çağrısı tek noktadan geçer: statik ESM importu testlerde
  // değiştirilemediği için hata yolu bu metot geçersiz kılınarak sınanır.
  // Saf geçiş kalmalıdır; hatayı yutmak varlık-koruma semantiğini tersine çevirir.
  analyzeImages(paths) {
    return analyzeImagesLocally(paths, this.rootDir);
  }

  // Tanılama günlüğünün kendisi hata yollarını asla kesmemeli.
  log(text) {
    try {
      const dir = path.join(this.rootDir, "runs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "orchestrator.log"), `[${now()}] ${text}\n`);
    } catch {}
  }

  // ---- macOS bildirimi ----
  notify(title, body, kind) {
    if (!this.config?.data.notifications) return;
    const eventKind=kind||(/(?:hata|durdu)/i.test(body)?"error":/(?:onay|bekliyor)/i.test(body)?"approval":"done");
    if (this.config.data.notificationEvents?.[eventKind] === false) return;
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
    health.antigravity = this.bridgeHealth();
    const openRouterConfigured = await this.providers.openrouter.isConfigured().catch(() => false);
    health.openrouter = {
      ok: openRouterConfigured,
      detail: openRouterConfigured ? "Ox Alpha · OpenRouter API bağlı" : "OpenRouter API anahtarı ayarlanmamış",
    };
    this.store.setHealth(health);
    return health;
  }

  bridgeHealth() {
    const agent = this.providers.antigravity;
    const fresh = agent.isFresh();
    const installed = agent.isConnected();
    return {
      ok: installed,
      detail: fresh
        ? "native CLI aktif — tüm araçlarla arka planda bağlı"
        : installed
          ? "native CLI hazır — ilk görevde arka planda başlatılır"
          : "Antigravity CLI kurulu değil",
    };
  }

  refreshBridgeHealth() {
    this.providers.antigravity.updateBridgeStatus();
    this.store.setHealth({ ...(this.store.health || {}), antigravity: this.bridgeHealth() });
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
    run.usageDaily ??= {};
    const day = usageDayKey(u.ts || Date.now());
    if (day) {
      const perAgent = (run.usageDaily[day] ??= {});
      const bucket = perAgent[name] || { input: 0, cachedInput: 0, output: 0, calls: 0, costUsd: 0 };
      bucket.input += u.input || 0;
      bucket.cachedInput += u.cachedInput || 0;
      bucket.output += u.output || 0;
      bucket.costUsd += u.costUsd || 0;
      bucket.calls += 1;
      perAgent[name] = bucket;
    }
    const totals=Object.values(run.usage).reduce((sum,item)=>({calls:sum.calls+(item.calls||0),tokens:sum.tokens+(item.input||0)+(item.output||0)}),{calls:0,tokens:0});
    run.budget ??= {enabled:false,maxCalls:24,maxTokens:250000,stopped:false};
    run.budget.usedCalls=totals.calls;run.budget.usedTokens=totals.tokens;
    if (!run.transient) this.store.saveRun(run);
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
    enrichAttachments(run.attachments || []).then((items) => { run.attachments = items; this.store.updateRun(run); return this.runPipeline(run, false); })
      .catch((err) => this.failRun(run, err))
      .finally(() => this.persistSessions(run));
  }

  resumeRun(run) {
    if (!["interrupted", "stopped", "failed", "evidence_blocked"].includes(run.status)) {
      throw new Error("Bu koşu devam ettirilemez (durum: " + run.status + ")");
    }
    run.stopRequested = false;
    this.store.updateRun(run, { status: "running" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kaldığı yerden devam ettiriliyor." });
    if (run.kind === "image_batch" || run.kind === "image-batch") {
      const pending = (run.tasks || []).filter((task) => task.status !== "done");
      for (const task of pending) {
        task.status = "pending";
        task.error = null;
      }
      run.batch ??= {};
      run.batch.total = run.tasks.length;
      run.batch.completed = run.tasks.filter((task) => task.status === "done").length;
      run.batch.failed = 0;
      run.turnActive = true;
      this.store.updateRun(run, { phase:"image_planning" });
      this.runImageBatch(run, Math.max(1, Math.min(Number(run.batch.concurrency) || 4, 6)))
        .catch((err) => this.failRun(run, err))
        .finally(() => this.persistSessions(run));
      return;
    }
    this.runPipeline(run, true)
      .catch((err) => this.failRun(run, err))
      .finally(() => this.persistSessions(run));
  }

  failRun(run, err) {
    this.store.addMessage(run, {
      from: "sistem", kind: "error",
      content: "Koşu hatayla sonlandı: " + String(err.message || err),
    });
    const evidenceBlocked=err instanceof EvidenceGateError;
    this.store.updateRun(run, { status:evidenceBlocked?"evidence_blocked":(run.kind === "chat" ? "idle" : "failed"),phase:evidenceBlocked?"evidence_gate":run.phase,error:String(err.message || err) });
    this.exportArtifacts(run,evidenceBlocked?"evidence-blocked":"failed");
    this.notify("Ajan Konseyi", "Koşu hatayla durdu");
  }

  checkStop(run) {
    if (run.stopRequested) throw new Error("Kullanıcı durdurdu");
  }

  // Kapı bir DURDURMA NOKTASIDIR, idam değil. Engel sebeplerinden hangi adımın
  // eksik olduğu çıkarılır ve YALNIZ o adım tekrarlanır; tamamlanmış görevler,
  // tartışma ve oylama korunur. Böylece bir konsey koşusunun tamamı çöpe gitmez.
  async repairEvidenceGap(run, reasons, worktrees = {}) {
    const S = this.store;
    let repaired = false;

    // (a) Eksik/başarısız review: yalnız o görevin incelemesi yeniden yapılır.
    const taskIds = [...new Set(reasons
      .map((reason) => /^\[([\w.-]+)\]/.exec(String(reason))?.[1])
      .filter(Boolean))];
    for (const taskId of taskIds) {
      const task = (run.tasks || []).find((item) => item.id === taskId && item.status === "done");
      if (!task) continue;
      S.addMessage(run, { from: "sistem", kind: "info", content: `↻ [${taskId}] kanıt eksiği için yalnız bu görevin bağımsız incelemesi yenileniyor.` });
      run.reviews = (run.reviews || []).filter((review) => review.taskId !== taskId);
      await this.reviewTask(run, task, worktrees);
      repaired = true;
      if (run.stopRequested) return repaired;
    }

    // (b) Zorunlu test çalışmamış/başarısız: testi tekrar çalıştır.
    const testReasons = reasons.filter((reason) => /Zorunlu test/.test(String(reason)));
    if (testReasons.length && run.testCommand) {
      const testDir = path.join(S.runsDir, run.id, "worktrees", "_integration");
      const dir = fs.existsSync(testDir) ? testDir : (run.projectDir || this.rootDir);
      S.addMessage(run, { from: "sistem", kind: "info", content: "↻ Zorunlu test kanıtı eksik; test yeniden çalıştırılıyor." });
      await this.runTests(run, dir);
      repaired = true;
    }

    // (c) Doğrulayıcı turu geçmedi: yalnız doğrulama (ve düzeltme) turu yenilenir.
    if (reasons.some((reason) => /Doğrulayıcı turu geçmedi/.test(String(reason)))) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "↻ Doğrulayıcı turu yenileniyor (tartışma ve oylama korunuyor)." });
      run.verify = null;
      await this.verifyRound(run, worktrees);
      repaired = true;
    }
    return repaired;
  }

  enforceEvidenceGate(run,action,options){
    try{const result=assertEvidenceGate(run,action,options);this.store.updateRun(run);return result;}
    catch(error){this.store.updateRun(run);this.store.addMessage(run,{from:"sistem",kind:"error",content:`EvidenceGate ${action} işlemini engelledi:\n- ${(error.reasons||[error.message]).join("\n- ")}`});throw error;}
  }

  // Kod turu baslamadan once otomatik anlik goruntu. Ajanlar dosya
  // degistirmeye baslamadan ONCE alinir; kullanici "Kontrol noktaları"
  // ekranindan tek tikla o ana donebilir. Maliyet kontrolu: yalniz kod
  // modunda, en fazla 10 dakikada bir, son 3 otomatik kopya saklanir.
  async autoCheckpoint(run, { force = false } = {}) {
    // force: kucuk-is yollari run.mode'u degistirmeden ana agaca yazabilir;
    // mod denetimi o cagrilar icin atlanir.
    if ((!force && run.mode !== "code") || !run.projectId || !run.projectDir) return null;
    const project = this.config.getProject(run.projectId);
    if (!project) return null;
    const dir = path.join(this.rootDir, "checkpoints");
    try {
      if (!shouldAutoCheckpoint(dir, project.id)) return null;
      const meta = createCheckpoint(dir, project, {
        name: `Tur öncesi · ${truncate(run.request, 40)}`, auto: true,
      });
      pruneAutoCheckpoints(dir, project.id, 3);
      this.store.addMessage(run, {
        from: "sistem", kind: "info",
        content: `📌 Tur öncesi otomatik kontrol noktası alındı ("${meta.name}"). Proje menüsündeki "Kontrol noktaları"ndan bu ana dönebilirsiniz.`,
      });
      return meta;
    } catch (error) {
      // Anlik goruntu alinamamasi turu engellemez.
      this.store.addMessage(run, { from: "sistem", kind: "info", content: `Otomatik kontrol noktası alınamadı: ${String(error.message || error)}` });
      return null;
    }
  }

  // Yetenek katalogu: gövdeler diske yazılır, isteme yalnız başlık + kısa
  // açıklama + dosya yolu girer (aşamalı açılım). Yetenek sayısı arttıkça
  // bağlam maliyeti sabit kalır; ajan gerekeni kendisi okur.
  skillCatalogFor(run) {
    const project = run.projectId ? this.config.getProject(run.projectId) : null;
    if (!project?.skills?.length) return "";
    try {
      const entries = writeSkillFiles(this.rootDir, project.id, project.skills);
      return skillCatalog(entries);
    } catch {
      return "";
    }
  }

  // ---- Bağlam bütçesi izleme ----
  // CLI oturumu her çağrıda TÜM konuşmayı yeniden gönderir; bu yüzden son
  // çağrının (input + önbellekten okunan) toplamı, o oturumun güncel bağlam
  // doluluğunun iyi bir vekilidir. Sağlayıcılar pencere doluluğunu
  // raporlamadığı için ölçüm "tahmini" olarak sunulur.
  trackSessionContext(run, member, usage) {
    if (!usage) return;
    const tokens = Number(usage.input || 0) + Number(usage.cachedInput || 0);
    if (!tokens) return;
    const model = member.model || this.pickTierModel(member.provider, "balanced") || "";
    const limit = contextWindowFor(member.provider, model);
    run.sessionContext = run.sessionContext || {};
    run.sessionContext[member.id] = {
      tokens, limit, model: model || null,
      pct: limit ? Math.min(100, Math.round((tokens / limit) * 100)) : null,
      at: new Date().toISOString(),
    };
    this.store.saveRun(run);
  }

  // Oturumu devir teslim özetiyle tazele: eski CLI oturumu kapatılır, yeni
  // oturum kısa bir özetle tohumlanır. Sıkıştırma eşiğine gelmeden yapılırsa
  // hem kalite korunur hem de tekrar tekrar tüm geçmişin gönderilmesi biter.
  async refreshMemberSession(run, memberId) {
    const member = this.memberById(memberId);
    if (!member) throw new Error("Bilinmeyen üye");
    const provider = this.providers[member.provider];
    const key = this.sessionKeyFor(run, member);
    if (!provider.sessions.get(key)) throw new Error(`${member.name} için açık oturum yok`);

    const ask = "Bu sohbeti yeni bir oturumda kaldığın yerden sürdüreceksin. " +
      "Devir teslim notu yaz: kullanıcının amacı, alınan kararlar, üzerinde çalışılan dosyalar ve açık işler. " +
      "En fazla 250 kelime, madde madde, Türkçe. Başka hiçbir şey yazma.";
    const res = await this.callMember(run, member, ask, { label: "devir teslim özeti" });
    const handoff = res.ok ? truncate(res.text, 4000) : "";

    provider.sessions.delete(key);
    run.sessionHandoff = run.sessionHandoff || {};
    if (handoff) run.sessionHandoff[member.id] = handoff;
    if (run.sessionContext) delete run.sessionContext[member.id];
    this.persistSessions(run);
    this.store.addMessage(run, {
      from: "sistem", kind: "info",
      content: `♻️ ${member.name} oturumu tazelendi${handoff ? " (devir teslim notu aktarıldı)" : ""}. Bağlam sayacı sıfırlandı.`,
    });
    return { ok: true, handoff: Boolean(handoff) };
  }

  // Kod tabani brifingi: sembol haritasi + KANIT KURALI.
  // Bu brifing yalniz planlama isteminde degil, hizli yanit ve DOGRUDAN MESAJ
  // yollarinda da verilir; aksi halde ajan kodu hic gormeden "su ozellik yok"
  // gibi eskimis iddialar uretir (sektor analizi raporunda birebir yasandi).
  async codebaseBrief(run, { limit = 6000 } = {}) {
    if (!run.projectDir) return "";
    let map = "";
    try { map = await this.projectContext.repoMap(run.projectDir); } catch { return ""; }
    if (!map) return "";
    return `\n\nKOD TABANI BRİFİNGİ (${run.projectDir}${run.commitHash ? ` · commit ${run.commitHash}` : ""}):\n` +
      `Kod hakkında bir iddia üretmeden ÖNCE ilgili dosyanın güncel hâlini oku; her iddiaya dosya:satır kanıtı ekle. ` +
      `Bir özelliğin "eksik" olduğunu söylemeden önce sembol haritasında ve dosyalarda ara.\n` +
      truncate(map, limit);
  }

  // Koordinatör çağrıları için koşuya özgü bağlam (durumsuz Coordinator)
  coordCtx(run) {
    return {
      runId: run.id,
      excludedProviders: run.excludedProviders || [],
      stopCheck: () => run.stopRequested,
      onUsage: (u) => this.accumUsage(run, "koordinator", u),
    };
  }

  pickTierModel(provider, tier) {
    if (!this.config?.data.smartModels) return undefined;
    return TIER_MAP[provider]?.[tier] || undefined;
  }

  // ================= SOHBET TURU =================
  enqueueMessage(run, item) {
    run.queuedMessages ||= [];
    const queued = {
      id: uid("queue-"),
      ts: new Date().toISOString(),
      target: item.target || "konsey",
      approach: ["quick", "pair", "council"].includes(item.approach) ? item.approach : null,
      intensity: ["ekonomik", "dengeli", "titiz"].includes(item.intensity) ? item.intensity : null,
      text: item.text,
      attachments: item.attachments || [],
      mode: item.mode || "auto",
    };
    run.queuedMessages.push(queued);
    this.store.updateRun(run);
    return queued;
  }

  drainMessageQueue(run) {
    if (run.turnActive || run.directActive || !run.queuedMessages?.length) return;
    const next = run.queuedMessages.shift();
    this.store.updateRun(run);
    queueMicrotask(() => {
      const job = next.target === "konsey"
        ? this.continueChat(run, next.text, next.attachments, next.mode, { approach: next.approach, intensity: next.intensity })
        : this.directMessage(run, next.target, next.text, next.attachments);
      job.catch((err) => this.store.addMessage(run, {
        from: "sistem", kind: "error", content: "Sıradaki mesaj işlenemedi: " + String(err.message || err),
      }));
    });
  }

  // ---- Mesaj duzenle & yeniden calistir ----
  // Kullanicinin eski bir mesajini duzeltip turu oradan yeniden baslatir:
  // o mesajdan (dahil) sonrasi silinir, saglayici CLI oturumlari sifirlanir
  // (eski baglam yeni gercekle celismesin), yeni metinle tur baslar.
  rewindChat(run, messageId, newText, attachments = []) {
    if (run.turnActive || run.directActive) throw new Error("Tur çalışırken mesaj düzenlenemez; önce durdurun");
    const index = (run.messages || []).findIndex((m) => m.id === messageId);
    if (index === -1) throw new Error("Mesaj bulunamadı");
    const hedef = run.messages[index];
    if (hedef.from !== "kullanici") throw new Error("Yalnız kendi mesajlarınızı düzenleyebilirsiniz");
    run.messages = run.messages.slice(0, index);
    run.report = null; run.reviews = []; run.votes = []; run.verify = null;
    for (const agent of Object.values(this.providers)) agent.resetSession(run.id);
    run.sessions = {};
    this.store.updateRun(run);
    this.store.emit("event", { type: "run_updated", runId: run.id });
    return this.continueChat(run, String(newText || hedef.content), attachments.length ? attachments : (hedef.attachments || []), run.mode || "auto");
  }

  async continueChat(run, text, attachments = [], mode = "auto", opts = {}) {
    const S = this.store;
    if (run.turnActive) throw new Error("Bu sohbette bir tur zaten çalışıyor; önce durdurun");
    run.turnActive = true;
    run.stopRequested = false;
    // Bilgisayar kullanma onayi tur basina gecerlidir; yeni turda yeniden sorulur.
    delete run._computerOnay;
    run.request = text;
    attachments = await enrichAttachments(attachments);
    run.attachments = attachments;
    run.reviews = [];
    run.votes = [];
    run.verify = null;
    // Yogunluk sohbet duzeyinde kalicidir; her mesajla degistirilebilir.
    if (["ekonomik", "dengeli", "titiz"].includes(opts.intensity)) run.intensity = opts.intensity;
    const intensity = applyIntensity(run);
    run.maxDebateRounds = intensity.maxDebateRounds;
    run.reviewRounds = intensity.reviewRounds;
    S.updateRun(run, { status: "running", phase: "thinking" });
    const ctx = this.coordCtx(run);
    this.restoreSessions(run);

    const attachNote = attachments.length
      ? "\n\n" + attachments.map((a) => `📎 ${a.url || a.path}`).join("\n")
      : "";
    S.addMessage(run, { from: "kullanici", kind: "message", content: text || "Ek dosyaları incele.", attachments });

    try {
      const avail = this.availableMembers(run);
      if (!avail.length) throw new Error("Ulaşılabilir üye yok (kenar çubuğundan üyeleri kontrol edin)");

      // Kullanici kod/isbolumu/tartisma modunu ACIKCA sectiyse konsey turu
      // ister. Metinde gecen bir uye adi bu secimi ezmemelidir; ezerse
      // calisma kopyalari, inceleme ve kanit kapisi sessizce devre disi
      // kalir. Tek uyeye sormak icin bestecideki hedef secici kullanilir ve
      // o yol buraya hic ugramaz.
      // "/" komutuyla zorlanan kademe her seyi ezer; koordinatore sorulmaz
      // ("/hizli" tam da koordinator gecikmesinden kacmak icindir).
      const forced = ["quick", "pair", "council"].includes(opts.approach) ? opts.approach : null;
      const requestedMember = mode === "auto" && !forced ? this.explicitlyRequestedMember(text, avail) : null;
      let routed = null;
      if (!forced && !requestedMember) {
        // Acik modlarda da koordinator once isin boyutuna bakar: kucuk is
        // tam konsey torenine girmeden tek uye veya ikili ile biter
        // (kademeli acilim). Konsey secilirse kullanicinin modu korunur.
        routed = normalizeRoute(
          await this.coordinator.routeTurn(run, this.memberListText(avail), ctx,
            { ...(mode !== "auto" ? { selectedMode: mode } : {}), intensity: run.intensity || null }),
          avail.map((m) => m.id));
        this.checkStop(run);
      }
      let route = resolveTurnRoute({ mode, forced, requestedMemberId: requestedMember?.id || null, routed });
      // Kucuk-is yoluna inildiginde kullanici bunu keyfi sanmasin: tek satir
      // gerekce dusulur ve buyutme kestirmesi hatirlatilir.
      if (mode !== "auto" && !forced && route.approach !== "council") {
        S.addMessage(run, { from: "sistem", kind: "info",
          content: `⚡ ${route.approach === "quick" ? "Hızlı yol" : "İkili yol"}: ${routed?.reason || "iş küçük değerlendirildi"} — tam konsey için mesajı /konsey ile başlatın.` });
      }
      // Zorlanan kademede uye secilmemisse: kod isinde kod yazabilen uye,
      // degilse ilk uygun uye.
      if (forced && route.approach !== "council" && !route.member_id) {
        route.member_id = (mode === "code" ? preferredCoder(avail)?.id : null) || avail[0].id;
      }
      if (route.approach === "pair" && !route.reviewer_id) {
        route.reviewer_id = avail.find((m) => m.id !== route.member_id)?.id || null;
      }

      if (attachments.length) {
        const capable = this.mediaCapableMembers(attachments, avail);
        if (!capable.length) throw new Error("Seçili medya türlerini okuyabilen etkin bir ajan yok");
        if (route.approach === "quick" && !capable.some((m) => m.id === route.member_id)) route.member_id = capable[0].id;
      }
      // Kod modunda kucuk-is yollari ANA agaca yazar; konseydeki worktree
      // korumasi burada yoktur. Dosyalara dokunulmadan geri donulebilir bir
      // nokta birakilir (shouldAutoCheckpoint araligi zaten kisitlar).
      if (mode === "code" && route.approach !== "council") await this.autoCheckpoint(run, { force: true });

      // Kod isinde tur basinda numstat anlik goruntusu alinir; tur sonunda
      // fark "N dosya değiştirildi +X −Y" karti olarak son mesaja islenir
      // (Codex'in ChatGPT gorunumundeki diff kartinin karsiligi).
      const diffBase = mode === "code" && run.projectDir ? await numstatSnapshot(run.projectDir) : null;
      const responseStyle = mode === "code" ? "codex" : null;
      if (route.approach === "quick") {
        const member = avail.find((m) => m.id === route.member_id) || avail[0];
        await this.quickReply(run, member, text, attachments, { allowFallback: !route.explicit, style: responseStyle });
        // Tur ici tirmanma: uye isi uygulayamadan bloke bildirdiyse tur
        // sessizce "bitti" sayilmaz; baska bir uye uretici olur, ikili yol
        // devreye girer.
        const last = [...run.messages].reverse().find((m) => m.from === member.id && m.kind === "message")?.content;
        if (last && reportsBlockedResult(last) && avail.length > 1 && !run.stopRequested) {
          const producer = avail.find((m) => m.id !== member.id);
          const reviewer = avail.find((m) => m.id !== producer.id) || member;
          S.addMessage(run, { from: "sistem", kind: "info",
            content: `⤴ İkiliye genişletildi: ${member.name} işi uygulayamadan bloke bildirdi; ${producer.name} üretecek, ${reviewer.name} denetleyecek.` });
          route = { approach: "pair", member_id: producer.id, reviewer_id: reviewer.id, escalated: true };
        }
      }
      if (route.approach === "pair") {
        const producer = avail.find((m) => m.id === route.member_id) || avail[0];
        const reviewer = avail.find((m) => m.id === route.reviewer_id && m.id !== producer.id)
          || avail.find((m) => m.id !== producer.id);
        let pairOut = null;
        if (!reviewer) await this.quickReply(run, producer, text, attachments, { allowFallback: !route.explicit, style: responseStyle });
        else pairOut = await this.pairReply(run, producer, reviewer, text, attachments, { style: responseStyle });
        // Tur ici tirmanma: denetci isin ikiliyi astigini bildirirse ayni
        // istek tam konseyle yeniden ele alinir; kullanicinin sectigi mod
        // korunur.
        if (pairOut?.escalate && !run.stopRequested) {
          S.addMessage(run, { from: "sistem", kind: "info",
            content: `⤴ Konseye genişletildi: ${pairOut.reason || "iş ikili incelemeyi aşıyor"}` });
          route = { approach: "council", mode: ["discussion", "split", "code"].includes(mode) ? mode : (routed?.mode || "discussion") };
        }
      }
      if (diffBase && route.approach !== "council" && !run.stopRequested) {
        const after = await numstatSnapshot(run.projectDir);
        const delta = diffDelta(diffBase, after);
        if (delta) {
          const sonMesaj = [...run.messages].reverse().find((m) => m.kind === "message" && m.from !== "kullanici" && m.from !== "sistem");
          if (sonMesaj) { sonMesaj.diff = delta; S.updateRun(run); }
          // Dosya haritasinin YAZAN sutunu adim basliklarina bel baglamaz:
          // uye dolayli komutla yazarsa (orn. python betigi) adimda dosya adi
          // gorunmez; git diff gercegi bilir. Yazari diff kaydindan tamamla.
          if (sonMesaj) {
            const yazarAd = this.memberById(sonMesaj.from)?.name || sonMesaj.fromLabel || "Üye";
            const harita = (run.turnFileMap ||= {});
            for (const f of delta.files || []) {
              const ad = String(f.path).split("/").pop();
              const kayit = (harita[ad] ||= { okuyan: [], yazan: [] });
              if (!kayit.yazan.includes(yazarAd)) kayit.yazan.push(yazarAd);
            }
          }
        }
      }
      if (route.approach === "council") {
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
      // Dosya haritasi: bu turda kim neyi okudu/yazdi (katlanir kart).
      if (run.turnFileMap && Object.keys(run.turnFileMap).length) {
        const yazilan = Object.values(run.turnFileMap).some((k) => k.yazan.length);
        if (yazilan || Object.keys(run.turnFileMap).length >= 2) {
          S.addMessage(run, { from: "sistem", kind: "filemap", content: "Dosya haritası", fileMap: run.turnFileMap });
        }
        run.turnFileMap = null;
      }
      // Tur, ara yonlendirme islenemeden bittiyse not KAYBOLMAZ: normal
      // mesaj olarak kuyruga iner ve hemen yeni tur olarak islenir.
      if (Array.isArray(run.steeringNotes) && run.steeringNotes.length) {
        for (const not of run.steeringNotes.splice(0)) this.enqueueMessage(run, { target: "konsey", text: not, mode });
      }
      S.updateRun(run, { status: "idle", phase: "idle" });
      if (!run.stopRequested) this.notify("Ajan Konseyi ✓", "Yanıt hazır");
      this.drainMessageQueue(run);
    }
  }

  async quickReply(run, member, text, attachments, { allowFallback = true, style = null } = {}) {
    const S = this.store;
    S.setPhase(run, "answering");
    const images = attachments.filter((a) => a.kind === "image").map((a) => a.path).filter((p) => fs.existsSync(p));
    const imageNote = attachmentPrompt(attachments);
    const brief = await this.codebaseBrief(run);
    const prefixFor = (mem) => {
      if (this.providers[mem.provider].sessions.get(this.sessionKeyFor(run, mem))) return "";
      const history = run.messages.slice(-10, -1)
        .map((m) => `[${m.fromLabel || m.from}]: ${truncate(m.content, 800)}`).join("\n");
      return `Sen "${mem.name}" adlı konsey üyesisin (${mem.provider}${mem.role !== "auto" ? ", rolün: " + mem.role : ""}); çok üyeli bir yapay zekâ konsey sohbetine katılıyorsun. ` +
        `Türkçe ve düzgün Markdown ile yanıtla.` +
        (run.projectDir ? ` Bağlı proje: ${run.projectDir}` : "") +
        (this.config.getProject(run.projectId)?.instructions ? `\n\nProje talimatları:\n${this.config.getProject(run.projectId).instructions}` : "") +
        this.skillCatalogFor(run) +
        (this.projectHistory(run) ? `\n\nProjede önceki sohbetlerden devralınan bağlam:\n${this.projectHistory(run)}` : "") +
        (this.projectContext.readMemory(run.projectId) ? `\n\nKalıcı proje hafızası:\n${truncate(this.projectContext.readMemory(run.projectId),4000)}` : "") +
        (run.sessionHandoff?.[mem.id] ? `\n\nÖnceki oturumundan devir teslim notun:\n${run.sessionHandoff[mem.id]}` : "") +
        (history ? `\n\nSohbet geçmişi:\n${history}` : "") + brief + "\n\n--- KULLANICININ MESAJI ---\n";
    };
    const generatingImage = this.isImageGenerationRequest(text) || this.isImageRevisionRequest(run, text);
    const agentText = generatingImage ? this.imageGenerationPrompt(text) : text;
    // Claude ve Antigravity görsel görevinde sanat yönetmeni olarak çalışır;
    // Canva/MCP oturumuna takılmaz. Gerçek raster dosyası aşağıda ortak Codex
    // motoruyla üretilir ve seçilen ajanın yanıtı olarak gösterilir.
    const adviserOnly = generatingImage && member.provider !== "codex";
    let res = await this.callMember(run, member, prefixFor(member) + (adviserOnly
      ? `Canva, MCP veya herhangi bir görsel üretim aracı çağırma. Dosya üretme. Kullanıcının isteği için yalnız kısa, ayrıntılı ve üretime hazır bir görsel promptu yaz.\n\n${text}`
      : agentText) + imageNote, {
      label: generatingImage ? "görsel üretiyor" : "yanıtlıyor",
      images,
      media: attachments,
      cwd: run.projectDir || undefined,
      // Sohbette Antigravity'ye uzun süre takılı kalınmaz
      // Flash görsel üretimi dakikalarca yanıtsız kalırsa bu gerçek ilerleme
      // değildir. Kartı kapatıp anlaşılır hata/yeniden deneme akışına geç.
      timeoutMs: adviserOnly ? 90 * 1000 : member.provider === "antigravity"
        ? 6 * 60 * 1000
        : undefined,
      shouldStop: () => run.stopRequested,
      routeText: text,
      style,
    });
    // Üye yanıt veremezse (zaman aşımı/hata) sohbet takılmasın: bir kez başka üye dener
    if (!res.ok && !run.stopRequested && allowFallback) {
      const alt = this.availableMembers(run).find((m) => m.id !== member.id && m.provider !== "antigravity");
      if (alt) {
        S.addMessage(run, { from: "sistem", kind: "info", content: `${member.name} yanıt veremedi (${truncate(res.error, 100)}); ${alt.name} devralıyor.` });
        member = alt;
        res = await this.callMember(run, member, prefixFor(member) + text + imageNote, {
          label: "yanıtlıyor", images, media: attachments, cwd: run.projectDir || undefined,
          routeText: text,
          shouldStop: () => run.stopRequested,
          style,
        });
      }
    }
    if (res.ok) {
      // Danışmanın üretim promptunu gerçek görsel isteğine eklemek kaliteyi ve
      // ajanın yaratıcı katkısını korur; kullanıcı ham promptu görmez.
      const renderRequest = adviserOnly && res.text?.trim() ? `${text}\n\nSANAT YÖNETMENİ NOTU:\n${res.text.trim()}` : text;
      res.text = await this.guaranteeImageOutput(run, member, renderRequest, adviserOnly ? "" : res.text, { images, media:attachments });
      this.memberMsg(run, member, "message", res.text, null, text);
    } else if (!run.stopRequested) {
      throw new Error(`${member.name} yanıt veremedi: ${res.error}`);
    }
  }

  // ---- L2: Üretici + bağımsız denetçi ----
  // Tam konseyin (plan/tartışma/oylama) maliyetini ödemeden ikinci bir göz
  // sağlar. Denetçi engelleyici sorun bulursa üretici BİR kez düzeltir.
  async pairReply(run, producer, reviewer, text, attachments = [], { style = null } = {}) {
    const S = this.store;
    S.setPhase(run, "answering");
    await this.quickReply(run, producer, text, attachments, { allowFallback: true, style });
    if (run.stopRequested) return;

    const answer = [...run.messages].reverse().find((m) => m.from === producer.id && m.kind === "message")?.content;
    if (!answer) return;

    S.setPhase(run, "review");
    const reviewPrompt = this.roleHeader(reviewer, run) +
      `İKİLİ İNCELEME. "${producer.name}" üyesinin kullanıcıya verdiği yanıtı bağımsız denetle.\n\n` +
      `Kullanıcının isteği:\n${truncate(text, 2000)}\n\n` +
      `Denetlenecek yanıt:\n${truncate(answer, 6000)}\n\n` +
      `TUTUMLU ÇALIŞ: yalnız iddiaları doğrulamak için GEREKEN dosyaları oku (genelde 1-3 dosya); proje taramasi yapma, web'e çıkma. ` +
      `Yalnız SONUCU DEĞİŞTİRECEK sorunları bildir (hata, eksik, yanlış varsayım, risk). ` +
      `Üslup/biçim tercihi bildirme. Kod veya dosya hakkında iddia üretmeden önce güncel hâlini oku ve dosya:satır kanıtı ver.\n` +
      `İş ikili incelemenin taşıyabileceğinden GENİŞ veya RİSKLİYSE (çok yönlü analiz, mimari karar, geniş kod değişikliği) "buyut":true döndür; konsey devralır.\n` +
      `YALNIZCA şu şemada tek bir JSON nesnesi döndür:\n` +
      `{"verdict":"onay|duzeltme","issues":["engelleyici sorunlar"],"summary":"tek cümlelik değerlendirme","buyut":false}`;
    const res = await this.callMember(run, reviewer, reviewPrompt, {
      label: "ikili inceleme", shouldStop: () => run.stopRequested,
      // Denetci tek islik ve kendi basina yeterli bir cagridir: dar baglam +
      // taze oturum. Uzun sohbetlerde oturum devami her turda eski baglami
      // yeniden tasiyordu; inceleme icin buna gerek yok.
      lean: true, fresh: true,
    });
    if (!res.ok || run.stopRequested) return;

    const verdict = extractJson(res.text) || { verdict: "onay", issues: [], summary: res.text };
    if (shouldEscalatePair(verdict)) {
      this.memberMsg(run, reviewer, "review", `🔍 İkili inceleme — iş ikiliyi aşıyor\n${verdict.summary || ""}`);
      return { escalate: true, reason: verdict.summary || null };
    }
    const issues = Array.isArray(verdict.issues) ? verdict.issues.filter(Boolean) : [];
    const needsFix = verdict.verdict === "duzeltme" && issues.length > 0;
    this.memberMsg(run, reviewer, "review",
      `🔍 İkili inceleme — ${needsFix ? "düzeltme istendi" : "onaylandı"}\n${verdict.summary || ""}` +
      (issues.length ? "\n" + issues.map((i) => `• ${i}`).join("\n") : ""));
    run.reviews.push({
      taskId: null, reviewer: reviewer.id, reviewerName: reviewer.name,
      agreement: needsFix ? 2 : 5, severity: needsFix ? "orta" : "dusuk", points: issues,
    });
    S.updateRun(run);
    if (!needsFix) return;

    const fixPrompt = `Bağımsız denetçi (${reviewer.name}) yanıtında şu engelleyici sorunları buldu:\n` +
      issues.map((i) => `• ${i}`).join("\n") +
      `\n\nBunları gider ve kullanıcıya DÜZELTİLMİŞ nihai yanıtı ver. Neyi değiştirdiğini bir cümleyle belirt.`;
    const fix = await this.callMember(run, producer, fixPrompt, {
      label: "düzeltme", shouldStop: () => run.stopRequested,
    });
    if (fix.ok && !run.stopRequested) this.memberMsg(run, producer, "message", fix.text);
  }

  stopTurn(run) {
    run.stopRequested = true;
    for (const p of Object.values(this.providers)) p.stop(run.id);
    for (const memberId of run.agents || []) this.store.clearStream(memberId);
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
      S.addMessage(run, { from: "kullanici", kind: "message", content: run.request, attachments: run.attachments || [] });
    }

    const avail = this.availableMembers(run);
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
      const planningContext={
        historyText: this.projectHistory(run),
        memoryText: this.projectContext.readMemory(run.projectId),
        repoMap: run.projectDir ? await this.projectContext.repoMap(run.projectDir) : "",
        testFirst: run.testFirst,
        attachmentsText: attachmentPrompt(run.attachments || []),
      };
      run.contextManifest={updatedAt:new Date().toISOString(),sources:[
        {kind:"history",label:"Proje sohbet geçmişi",chars:planningContext.historyText.length,enabled:!!planningContext.historyText},
        {kind:"memory",label:"Kalıcı proje hafızası",chars:planningContext.memoryText.length,enabled:!!planningContext.memoryText},
        {kind:"repo",label:"Repo haritası",chars:planningContext.repoMap.length,enabled:!!planningContext.repoMap},
        {kind:"attachments",label:"Dosya ve görsel ekleri",chars:planningContext.attachmentsText.length,count:(run.attachments||[]).length,enabled:!!planningContext.attachmentsText},
      ]};
      const plan = normalizePlan(await this.coordinator.plan(run, this.memberListText(avail), planningContext, ctx), avail.map((m) => m.id));
      this.checkStop(run);
      if (run.mode === "auto") run.mode = plan.mode || "discussion";
      const assignedTasks = enforceTaskAssignments(plan.subtasks || [], avail, plan.mode || run.mode, this.config?.data.smartModels!==false);
      run.tasks = assignedTasks.map((t) => {
        const m = this.memberById(t.member_id) || avail[0];
        return {
          id: t.id, title: t.title, assignee: m.id, assigneeName: m.name,
          prompt: t.prompt, status: "pending", result: null,
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on : [],
          tier: ["fast", "balanced", "strong"].includes(t.model_tier) ? t.model_tier : "balanced",
          routingReason:t.routing_reason||"Koordinatör ataması",
          // Aynı yapılandırılmış üye birden fazla göreve atansa bile her görev
          // ayrı sağlayıcı konuşmasıdır; böylece koordinatör ajan çoğaltabilir.
          agentInstanceId: uid("agent-"),
          contract: normalizeTaskContract({
            goal:t.prompt||t.title, nonGoals:[], allowedPaths:["**"], forbiddenPaths:[],
            risk:t.model_tier==="strong"?"high":"medium",
            acceptanceCriteria:[`Görev sonucu doğrulanabilir biçimde tamamlandı: ${t.title}`],
            testCommands:run.testCommand?[run.testCommand]:[], approvalBoundaries:[],
          }),
        };
      });
      run.reviewRounds = Math.min(plan.review_rounds ?? 1, 2);
      S.addMessage(run, {
        from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "message",
        content: `Analiz: ${plan.analysis}\n\nMod: ${run.mode}\nGörev dağılımı:\n` +
          run.tasks.map((t) => `- [${t.id}] ${t.title} → ${t.assigneeName} (${t.tier}${t.dependsOn.length ? ", bağımlı: " + t.dependsOn.join(",") : ""})`).join("\n"),
      });
      S.updateRun(run);
    }

    // ---- Kod modu: üye başına worktree ----
    const worktrees = {};
    if (run.mode === "code") {
      // Ajanlar dosyalara dokunmadan once geri donulebilir bir nokta birak.
      await this.autoCheckpoint(run);
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
      if (!run.targetBranch) run.targetBranch = await gitops.currentBranch(run.projectDir);
      // Antigravity kod yazan uye degildir ama kod modunda arastirma ve
      // dogrulama gorevleri alir. Kopya verilmezse calisma dizini bos kalir,
      // projeyi hic goremez ve gorevini yapamaz. Kopyada calistigi olculdu;
      // urettigi bir degisiklik olursa da diger uyeler gibi kanit kapisindan
      // gecer. Birlestirme yalniz gercekten diff ureten dallar icin islenir.
      const involved = [...new Set(run.tasks.map((t) => t.assignee))]
        .map((id) => this.memberById(id)).filter(Boolean);
      for (const m of involved) {
        worktrees[m.id] = await gitops.createWorktree(run.projectDir, S.runsDir, run.id, m.id);
      }
      run.tasks.forEach(task=>{const workspace=worktrees[task.assignee];if(workspace)task.workspace={branch:workspace.branch,path:workspace.wtDir,isolated:true};});
      S.updateRun(run);
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
      // Tek bir sağlayıcı çağrısının reddedilmesi diğer hazır görevlerin
      // sonuçlarını yutmasın ve bütün koşuyu "çalışıyor" durumunda bırakmasın.
      await Promise.allSettled(ready.map(async (task) => {
        try {
          await this.runTask(run, task, worktrees);
          if (task.status === "done" && this.availableMembers(run).length > 1 && (run.reviewRounds ?? 1) > 0) {
            const already = run.reviews.some((r) => r.taskId === task.id);
            if (!already) reviewPromises.push(this.reviewTask(run, task, worktrees));
          }
        } catch (err) {
          if (run.stopRequested) return;
          task.status = "failed";
          task.endedAt = new Date().toISOString();
          task.result = String(err?.message || err);
          S.addMessage(run, { from: "sistem", kind: "error", taskId: task.id, content: `${task.assigneeName || task.assignee} görevi beklenmedik biçimde durdu: ${task.result}` });
          S.updateRun(run);
        }
      }));
    }
    this.checkStop(run);
    const doneTasks = run.tasks.filter((t) => t.status === "done");
    if (doneTasks.length === 0) throw new Error("Hiçbir alt görev tamamlanamadı");

    if (reviewPromises.length) {
      S.setPhase(run, "review");
      await Promise.all(reviewPromises);
      await this.reconcilePeerFeedback(run, worktrees);
      await this.revalidateChangedReviews(run,worktrees);
    }

    // ---- 3. ÇELİŞKİ / TARTIŞMA / OYLAMA ----
    let voteInfo = null;
    const activeMembers = [...new Set(doneTasks.map((t) => t.assignee))]
      .map((id) => this.memberById(id)).filter(Boolean);
    // Tek uye urettiyse gorus ayriligi olusamaz; koordinatore sormak bosuna
    // sure ve kota harcar.
    if (this.availableMembers(run).length > 1 && activeMembers.length > 1) {
      let round = 0;
      while (round < run.maxDebateRounds) {
        this.checkStop(run);
        const assess = await this.assessConflict(run, round + 1, ctx);
        S.addMessage(run, {
          from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "message",
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
    if (this.availableMembers(run).length > 1 && !run.stopRequested) {
      if (applyIntensity(run).verify) {
        await this.verifyRound(run, worktrees);
        await this.revalidateChangedReviews(run,worktrees);
      } else {
        S.addMessage(run, { from: "sistem", kind: "info", content: "Ekonomik yoğunluk: doğrulayıcı turu atlandı." });
      }
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
    S.addMessage(run, { from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "decision", content: `KARAR: ${fin.decision}\n\nGerekçe: ${fin.rationale}` });
    this.projectContext.appendMemory(run.projectId, run, fin.decision);
    if (!chatTurn) {
      // Kapı takılırsa koşuyu öldürme: eksik adımı onar ve yeniden dene.
      let doneGate = null;
      for (let attempt = 1; attempt <= 3 && !doneGate; attempt++) {
        try {
          doneGate = this.enforceEvidenceGate(run, "done", { requireTests: run.mode === "code" });
        } catch (error) {
          if (!(error instanceof EvidenceGateError) || attempt === 3 || run.stopRequested) throw error;
          S.addMessage(run, { from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "info", content: `Kanıt kapısı takıldı (${attempt}/3). Tüm koşu iptal edilmiyor; yalnız eksik adım yenileniyor.` });
          const repaired = await this.repairEvidenceGap(run, error.reasons || [], worktrees);
          if (!repaired) throw error;
        }
      }
      S.addMessage(run,{from:"sistem",kind:"info",content:`✓ EvidenceGate tamamlanma için geçti · ${doneGate.evidence.reviews.length} review kanıtı`});
      S.updateRun(run, { status: "done", phase: "done" });
      this.exportArtifacts(run,"done");
      this.notify("Ajan Konseyi ✓", "Koşu tamamlandı: " + truncate(run.request, 60));
    }
  }

  // ---- Tek alt görev ----
  async runTask(run, task, worktrees) {
    const S = this.store;
    let member = this.memberById(task.assignee);
    const avail = this.availableMembers(run);
    if (requiresCodeAuthoring(task, run.mode) && !canAuthorCode(member)) {
      const coder = preferredCoder(avail, Object.fromEntries(avail.map((m) => [m.id, run.tasks.filter((t) => t.assignee === m.id).length])));
      if (!coder) { task.status="failed"; task.result="Kod yazabilecek etkin Claude veya Codex üyesi yok."; S.updateRun(run); return; }
      S.addMessage(run, { from:"koordinator", provider: this.config?.data?.coordinator?.provider || null, kind:"info", taskId:task.id, content:`Kod yazma görevi ${member?.name || task.assigneeName} yerine ${coder.name} üyesine atandı. Antigravity araştırma, görsel ve doğrulama görevlerinde tutulur.` });
      member=coder; task.assignee=coder.id; task.assigneeName=coder.name;
    }
    if (!member || !avail.some((m) => m.id === member.id)) {
      const fb = avail.find((m) => m.id !== task.assignee);
      if (!fb) { task.status = "failed"; return; }
      S.addMessage(run, { from: "sistem", kind: "info", taskId: task.id, content: `${task.assigneeName || task.assignee} ulaşılamaz; görev ${fb.name} üyesine devredildi.` });
      member = fb;
      task.assignee = fb.id;
      task.assigneeName = fb.name;
    }
    if (unsupportedAttachments(member.provider, run.attachments || []).length) {
      const compatible = this.mediaCapableMembers(run.attachments || [], avail).find((m) => m.id !== member.id);
      if (!compatible) { task.status="failed"; task.result="Bu ek türlerini okuyabilen ajan yok."; this.store.updateRun(run); return; }
      this.store.addMessage(run, { from:"sistem", kind:"info", taskId:task.id, content:`${member.name} ek türünü okuyamadığı için görev ${compatible.name} üyesine yönlendirildi.` });
      member=compatible; task.assignee=compatible.id; task.assigneeName=compatible.name;
    }
    task.status = "active";
    task.startedAt = new Date().toISOString();
    S.updateRun(run);
    S.addMessage(run, { from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "task", taskId: task.id, content: `[${member.name}] için görev: ${task.title}\n\n${task.prompt}` });

    const images = (run.attachments || []).filter((a) => a.kind === "image").map((a) => a.path).filter((p) => fs.existsSync(p));
    const agSleeping = member.provider === "antigravity" && this.antigravitySleeping();
    if (agSleeping) {
      this.notify("Ajan Konseyi 🔔", `${member.name} görev bekliyor — Antigravity'de ajana 'inbox'u kontrol et' deyin`);
    }
    const opts = {
      label: task.title,
      sessionKey: `${run.id}#worker#${task.agentInstanceId || task.id}`,
      timeoutMs: agSleeping ? 5 * 60 * 1000 : undefined,
      codeMode: run.mode === "code",
      cwd: worktrees[member.id]?.wtDir || (run.mode !== "code" ? run.projectDir || undefined : undefined),
      // Kod modunda ayri calisma kopyasi yoksa ajan ANA agaca yazmamalidir.
      // Bu, cwd'nin bos birakilmasinin kasitli oldugunu belirtir; asagidaki
      // proje dizini varsayilani bu durumda devreye girmez.
      noProjectCwd: run.mode === "code" && !worktrees[member.id]?.wtDir,
      tierModel: this.pickTierModel(member.provider, task.tier),
      images, media: run.attachments || [],
      shouldStop: () => run.stopRequested,
      // Rol başlığı ve bağımlılık çıktıları servis yönlendirmesini kirletemez.
      routeText: task.prompt,
    };
    const imageNote = attachmentPrompt(run.attachments || []);
    let depContext = "";
    for (const depId of task.dependsOn || []) {
      const dep = run.tasks.find((t) => t.id === depId);
      if (dep?.status === "done" && dep.result) {
        depContext += `\n--- ÖNCEKİ GÖREVİN ÇIKTISI [${dep.id}: ${dep.title} / ${dep.assigneeName}] ---\n${truncate(dep.result, 6000)}\n`;
      }
    }
    const preparePrompt=(source,cwd)=>{
      let value=String(source||"");
      if(cwd&&run.projectDir)value=value.split(run.projectDir).join(cwd);
      if(!cwd)return{prompt:value,inputDir:null};
      const inputDir=path.join(cwd,".ajan-inputs");let copied=false;
      value=value.replace(/([`'\"])(\/[^`'\"\n]+)\1/g,(whole,quote,absolute)=>{
        try{if(!path.isAbsolute(absolute)||absolute.startsWith(cwd+path.sep)||!fs.statSync(absolute).isFile())return whole;fs.mkdirSync(inputDir,{recursive:true});const target=path.join(inputDir,`${crypto.createHash("sha256").update(absolute).digest("hex").slice(0,8)}-${path.basename(absolute)}`);fs.copyFileSync(absolute,target);copied=true;return `${quote}${target}${quote}`;}catch{return whole;}
      });
      return{prompt:`Yazılabilir ve güncel proje kopyan: ${cwd}. Ana proje yoluna gitme; bütün okuma, düzenleme, git ve test komutlarını bu çalışma kopyasında yap.\n\n${value}`,inputDir:copied?inputDir:null};
    };
    const prepared=preparePrompt(task.prompt,opts.cwd);
    const header = this.roleHeader(member, run) + depContext + imageNote;
    const invokeMember = async (prompt, callOpts) => {
      try {
        return await this.callMember(run, member, prompt, callOpts);
      } catch (error) {
        return { ok:false, error:error?.message || String(error), raw:{ thrown:true } };
      }
    };
    let res = await invokeMember(header + prepared.prompt + summaryContract(), opts);
    // Durdurulmuş eski bir sağlayıcı çağrısı, aynı koşu yeniden başlatıldıktan
    // sonra yeni görevin durumunu veya atamasını ezmemeli.
    if (res.cancelled) return;
    if(res.ok&&reportsBlockedResult(res.text))res={ok:false,error:`Ajan işi uygulamadan bloke bildirdi: ${truncate(res.text,500)}`};
    if(prepared.inputDir)fs.rmSync(prepared.inputDir,{recursive:true,force:true});

    // Bir üyenin görevi hata verdiğinde başka sağlayıcıya geçirip sonucu o üye
    // üretmiş gibi göstermeyiz. Geçici köprü/sağlayıcı hatalarında aynı üyeyi,
    // temiz bir oturumla sınırlı sayıda yeniden deneriz.
    for (let attempt = 2; !res.ok && !run.stopRequested && attempt <= 3; attempt++) {
      S.addMessage(run, {
        from:"sistem", kind:"info", taskId:task.id,
        content:`${member.name} yanıtı alınamadı; aynı ajanla yeniden deneniyor (${attempt}/3).`,
      });
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt - 1)));
      res = await invokeMember(header + prepared.prompt + summaryContract(), { ...opts, fresh:true });
      if (res.cancelled) return;
      if(res.ok&&reportsBlockedResult(res.text))res={ok:false,error:`Ajan işi uygulamadan bloke bildirdi: ${truncate(res.text,500)}`};
    }

    if (!res.ok && !run.stopRequested) {
      S.addMessage(run, { from:"sistem", kind:"error", taskId:task.id, content:`${member.name} üç denemede de görevi tamamlayamadı: ${res.error}` });
      if (member.provider === "antigravity") {
        S.addMessage(run, {
          from:"koordinator", provider: this.config?.data?.coordinator?.provider || null, kind:"info", taskId:task.id,
          content:`⚠ ${member.name} (Antigravity) görüşü üç denemede de alınamadı; görev başka bir yapay zekâ adına tamamlanmış sayılmayacak.`,
        });
      }
    }

    task.endedAt = new Date().toISOString();
    if (res.ok) {
      res.text = await this.guaranteeImageOutput(run, member, task.prompt, res.text, opts);
      task.status = "done";
      // Özet iç bağlam aktarımı için saklanır; kullanıcıya gösterilen metinden
      // blok çıkarılır. Böylece aynı içerik inceleme/tartışma/sentez istemlerine
      // tam metin olarak tekrar tekrar kopyalanmaz.
      task.summary = extractSummary(res.text) || truncate(res.text, 700);
      task.result = stripSummaryBlock(res.text);
      this.memberMsg(run, member, "result", task.result, task.id, "", task.summary);
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
    const providerBoundary = member.provider === "antigravity"
      ? " Antigravity olarak kaynak kodu yazma veya değiştirme; araştırma, görsel/medya, tarayıcı-UX doğrulaması, içerik ve alternatif görüş üret. Kod değişikliği gerektiğini görürsen bunu Claude/Codex için somut öneri ve kanıt olarak yaz."
      : " Claude/Codex olarak gerektiğinde kaynak kodu yazabilir, değiştirebilir ve test edebilirsin.";
    return `Sen "${member.name}" adlı konsey üyesisin (sağlayıcı: ${member.provider}). Konseyde başka üyeler de var; koordinatör görevleri dağıtır.${rolePart}${providerBoundary}${commitPart} Diğer üyelerin bulgularına atıf yap, katılmadığın noktayı gerekçelendir ve sonraki üyeye uygulanabilir bir devir notu bırak. Yanıtlarını Türkçe ve düzgün Markdown biçiminde yaz (başlıklar, listeler, kod için \`\`\` blokları); gereksiz uzatma.\n\nKullanıcının ana isteği: "${truncate(run.request, 1200)}"\n\n--- SANA VERİLEN GÖREV ---\n`;
  }

  // ---- Puanlı çapraz inceleme ----
  async reviewTask(run, task, worktrees) {
    const S = this.store;
    const author = this.memberById(task.assignee);
    const reviewers = selectTaskReviewers(task, author, this.availableMembers(run), run.reviewRounds ?? 1);
    const authorWorktree=worktrees?.[task.assignee]?.wtDir;
    let authorEvidence;
    if(authorWorktree) authorEvidence=await gitops.createImmutableSnapshot(authorWorktree,`ajan review: ${task.id}`);
    else {
      const result=String(task.result||"");
      const digest=crypto.createHash("sha256").update(result).digest("hex");
      authorEvidence={commit:`artifact-sha256:${digest}`,parentCommit:"",tree:`artifact-tree:${digest}`,diff:result};
    }
    const eventTests=testEvidenceFromEvents(run,task.id);
    authorEvidence.tests=eventTests.length?eventTests:(run.tests||[]).filter((test)=>!test.taskId||test.taskId===task.id);
    const packet=createReviewPacket({taskId:task.id,contract:task.contract,author:authorEvidence});
    await Promise.all(reviewers.map(async (reviewer) => {
      const prompt=isolatedReviewPrompt(packet,reviewer.name);
      const res = await this.callMember(run, reviewer, prompt, {
        label: `inceleme: ${task.id}`,
        isolated:true, fresh:true,
        sessionKey:`${run.id}#isolated-review#${task.id}#${reviewer.id}#${packet.fingerprint}`,
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
        evidencePacket:packet.fingerprint,
        reviewedCommit:packet.author.commit,
        reviewedTree:packet.author.tree,
        contractFingerprint:packet.contract.fingerprint,
      });
      this.memberMsg(run, reviewer, "review",
        `İnceleme [${task.id}] — katılım: ${j.agreement}/5, önem: ${j.severity}\n` +
        (j.points || []).map((p) => `• ${p}`).join("\n") +
        (j.evidence?.length ? `\nKanıt: ${j.evidence.join("; ")}` : "") +
        (j.suggestion ? `\nÖneri: ${j.suggestion}` : ""), task.id);
      S.updateRun(run);
    }));
    this.exportArtifacts(run,"review");
  }

  async revalidateChangedReviews(run,worktrees){
    const stale=[];
    for(const task of (run.tasks||[]).filter((item)=>item.status==="done")){
      const active=(run.reviews||[]).filter((review)=>review.taskId===task.id&&!review.invalidatedAt);
      if(!active.length)continue;
      const wtDir=worktrees?.[task.assignee]?.wtDir;
      let tree;
      if(wtDir)tree=(await gitops.createImmutableSnapshot(wtDir,`ajan revalidation: ${task.id}`)).tree;
      else{const digest=crypto.createHash("sha256").update(String(task.result||"")).digest("hex");tree=`artifact-tree:${digest}`;}
      if(!invalidateStaleReviews(run.reviews,task.id,tree).length)continue;
      stale.push(task);
      this.store.addMessage(run,{from:"sistem",kind:"info",taskId:task.id,content:`Review onayı geçersiz sayıldı: [${task.id}] içeriği incelemeden sonra değişti. Yeni commit tekrar incelenecek.`});
    }
    if(stale.length)this.store.updateRun(run);
    for(const task of stale)await this.reviewTask(run,task,worktrees);
    return stale;
  }

  // İnceleme yalnız raporda kalmaz: ciddi/somut itirazlar görev sahibine geri
  // döner. Yazar diğer ajanların görüşlerine tek tek cevap verir, gerekiyorsa
  // kendi çalışma kopyasında düzeltir ve görev çıktısını günceller.
  async reconcilePeerFeedback(run, worktrees) {
    const S=this.store;
    for (const task of run.tasks.filter((t)=>t.status==="done")) {
      const feedback=run.reviews.filter((r)=>r.taskId===task.id && (r.agreement<=3 || r.severity==="yuksek"));
      if(!feedback.length) continue;
      let author=this.memberById(task.assignee);
      if(requiresCodeAuthoring(task,run.mode)&&!canAuthorCode(author)) author=preferredCoder(this.availableMembers(run));
      if(!author) continue;
      const peerText=feedback.map((r)=>`### ${r.reviewerName} (${r.agreement}/5, ${r.severity})\n${r.points.map((p)=>`- ${p}`).join("\n")}`).join("\n\n");
      const prompt=this.roleHeader(author,run)+
        `İSTİŞARE / REVİZYON TURU. Diğer konsey üyeleri [${task.id}] ${task.title} çıktına aşağıdaki itirazları verdi:\n\n${peerText}\n\n`+
        `Her itirazı değerlendir. Katılıyorsan çözümü uygula; katılmıyorsan teknik kanıtla açıkla. Sonunda "Devir özeti" başlığıyla hangi görüşlerin kabul edildiğini ve nihai durumunu yaz.`+
        (requiresCodeAuthoring(task,run.mode)?" Gerekli kod değişikliklerini kendi çalışma kopyanda uygula ve ilgili testleri çalıştır.":"");
      const res=await this.callMember(run,author,prompt,{
        label:`istişare: ${task.id}`, codeMode:requiresCodeAuthoring(task,run.mode),
        cwd:worktrees?.[author.id]?.wtDir || run.projectDir || undefined,
        shouldStop:()=>run.stopRequested,
      });
      if(res.ok) {
        task.result += `\n\n--- İSTİŞARE SONRASI REVİZYON ---\n${truncate(res.text,6000)}`;
        this.memberMsg(run,author,"debate",`İstişare sonrası revizyon [${task.id}]:\n${res.text}`,task.id);
        S.updateRun(run);
      }
    }
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
    await Promise.all(this.availableMembers(run).map(async (member) => {
      const recent = run.messages
        .filter((m) => ["review", "debate", "result"].includes(m.kind) && m.from !== member.id)
        .slice(-4)
        .map((m) => `[${m.fromLabel || m.from}]: ${m.summary || truncate(m.content, 3000)}`)
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
    S.addMessage(run, { from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "info", content: "Tartışma tur sınırına ulaşıldı; rubrikli oylamaya geçiliyor." });
    const positions = run.tasks.filter((t) => t.status === "done")
      .map((t) => `- "${t.assigneeName}" (${t.assignee}) yaklaşımı: ${t.summary || truncate(t.result, 2000)}`).join("\n");
    const votes = [];
    await Promise.all(this.availableMembers(run).map(async (member) => {
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
    const avail = this.availableMembers(run);
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
      const author = this.availableMembers(run).find((m) => m.id === authorId);
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
      this.exportArtifacts(run,"integration");
      return;
    }

    const mergeGate=this.enforceEvidenceGate(run,"merge",{requireTests:false});
    S.addMessage(run,{from:"sistem",kind:"info",content:`✓ EvidenceGate merge için geçti · ${mergeGate.evidence.reviews.length} review kanıtı`});

    const plan = await this.coordinator.mergePlan(run, diffs, this.coordCtx(run));
    S.addMessage(run, {
      from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "message",
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
    let allMerged = true;
    if (!approved) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Birleştirme reddedildi. Değişiklikler kendi dallarında duruyor; diff'ler Dosyalar sekmesinde." });
    } else {
      const finalOrder = completeMergeOrder(plan.merge_order, diffs.map((d) => d.memberId));
      for (const memberId of finalOrder) {
        const d = diffs.find((x) => x.memberId === memberId);
        const result = await gitops.mergeBranch(run.projectDir, S.runsDir, run.id, d.branch);
        if (result.ok) {
          merged = true;
          S.addMessage(run, { from: "sistem", kind: "info", content: `✓ ${d.branch} birleştirildi.` });
        } else {
          allMerged = false;
          S.addMessage(run, {
            from: "sistem", kind: "error",
            content: `✗ ${d.branch} birleştirilemedi (çakışma): ${result.conflicts.join(", ") || result.error}. Elle inceleme gerekli.`,
          });
        }
      }
    }

    let testsPassed = !run.testCommand;
    if (run.testCommand && merged) {
      const testDir = path.join(S.runsDir, run.id, "worktrees", "_integration");
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
          const fixApproved = await S.requestApproval(run, {
            kind: "testfix",
            title: "Test düzeltmesi için kod değişikliği onayı",
            detail: "Testler başarısız oldu. Bir ajanın integration dalında asgari düzeltmeyi yapmasına ve commit atmasına izin verilsin mi?",
          });
          this.checkStop(run);
          if (!fixApproved) {
            S.addMessage(run, { from: "sistem", kind: "info", content: "Otomatik test düzeltmesi reddedildi." });
          } else {
            S.addMessage(run, { from: "koordinator", provider: this.config?.data?.coordinator?.provider || null, kind: "info", content: "Testler kırıldı; onaylanan düzeltme turu başlıyor." });
            const fixerId = [...diffs].sort((a, b) => b.diff.length - a.diff.length)[0]?.memberId;
            const fixer = this.availableMembers(run).find((m) => m.id === fixerId);
            if (fixer) {
              // Bu projede daha once cozulmus benzer hatalar varsa ipucu olarak ver.
              const firstFailure = testResult.output;
              const priorRepairs = findSimilarRepairs(this.rootDir, run.projectId, firstFailure);
              if (priorRepairs.length) {
                S.addMessage(run, { from: "sistem", kind: "info", content: `🧠 Bu hataya benzer ${priorRepairs.length} geçmiş çözüm bulundu; onarım istemine eklendi.` });
              }
              const fixPrompt = this.roleHeader(fixer, run) +
                `Birleştirme sonrası testler KIRILDI. Test çıktısı:\n\n${truncate(testResult.output, 6000)}\n\n` +
                `Bu dizinde çalışıyorsun: ${testDir}\nTestleri geçirecek asgari düzeltmeyi uygula ve ne değiştirdiğini özetle.` +
                repairHint(priorRepairs);
              const fix = await this.callMember(run, fixer, fixPrompt, {
                label: "test düzeltme", codeMode: true, cwd: testDir, shouldStop: () => run.stopRequested,
              });
              if (fix.ok) {
                this.memberMsg(run, fixer, "result", `Test düzeltmesi:\n${fix.text}`);
                testResult = await this.runTests(run, testDir);
                run.repairHistory??=[];run.repairHistory.push({attempt:1,agent:fixer.name,ok:testResult.ok,at:new Date().toISOString()});
                for(let attempt=2;!testResult.ok&&attempt<=3&&!run.stopRequested;attempt++){
                  S.addMessage(run,{from:"koordinator", provider: this.config?.data?.coordinator?.provider || null,kind:"info",content:`Otomatik onarma ${attempt}/3: kalan test hataları yeniden inceleniyor.`});
                  const retry=await this.callMember(run,fixer,`${this.roleHeader(fixer,run)}Önceki düzeltmeden sonra testler hâlâ başarısız. Güncel çıktı:\n\n${truncate(testResult.output,6000)}\n\nKök nedeni bul, yalnız gerekli kodu düzelt ve testi çalıştır.`,{label:`test düzeltme ${attempt}/3`,codeMode:true,cwd:testDir,shouldStop:()=>run.stopRequested});
                  if(!retry.ok)break;
                  this.memberMsg(run,fixer,"result",`Test düzeltmesi ${attempt}/3:\n${retry.text}`);
                  testResult=await this.runTests(run,testDir);
                  run.repairHistory.push({attempt,agent:fixer.name,ok:testResult.ok,at:new Date().toISOString()});S.updateRun(run);
                }
                // Kirmizi -> yesil olduysa hata imzasi + cozum cifti hafizaya yazilir.
                if (testResult.ok) {
                  const lastFix = [...(run.messages || [])].reverse()
                    .find((m) => m.from === fixer.id && /Test düzeltmesi/.test(String(m.content || "")))?.content || fix.text;
                  const saved = recordRepair(this.rootDir, run.projectId, {
                    output: firstFailure, solution: lastFix, agent: fixer.name, command: run.testCommand,
                  });
                  if (saved) S.addMessage(run, { from: "sistem", kind: "info", content: "🧠 Bu hata ve çözümü proje onarım hafızasına kaydedildi; benzeri tekrar çıkarsa ajana hatırlatılacak." });
                }
                const integrationTask={id:`${run.id}-integration-fix`,title:"Birleştirme sonrası test düzeltmesi",assignee:fixer.id,assigneeName:fixer.name,prompt:"Birleştirme sonrası testleri geçiren asgari düzeltme",status:"done",result:fix.text,tier:"strong",contract:normalizeTaskContract({goal:"Birleştirme sonrası test hatasını gider",nonGoals:["İlgisiz yeniden yapılandırma"],allowedPaths:["**"],forbiddenPaths:[],risk:"high",acceptanceCriteria:["Zorunlu test başarıyla geçer"],testCommands:[run.testCommand],approvalBoundaries:["Hedef dala uygulamadan önce kullanıcı onayı"]})};
                run.tasks=run.tasks.filter((task)=>task.id!==integrationTask.id);run.tasks.push(integrationTask);S.updateRun(run);
                await this.reviewTask(run,integrationTask,{[fixer.id]:{wtDir:testDir}});
                await gitops.commitAll(testDir, `ajan(${fixer.name}): test düzeltmesi`).catch(() => {});
              }
            }
          }
        }
        testsPassed = testResult.ok;
      }
    } else if (run.testCommand && !merged) {
      S.addMessage(run, { from: "sistem", kind: "info", content: "Birleşik integration dalı oluşmadığı için test çalıştırılmadı." });
      testsPassed = false;
    }

    if (merged && allMerged && testsPassed) {
      const publishGate=this.enforceEvidenceGate(run,"publish");
      S.addMessage(run,{from:"sistem",kind:"info",content:`✓ EvidenceGate yayın için geçti · ${publishGate.requiredCommands.length} zorunlu test`});
      const publish = await S.requestApproval(run, {
        kind: "publish",
        title: `Test edilmiş kodu ${run.targetBranch} dalına uygula`,
        detail: `Integration dalı testlerden geçti. ajan/${run.id}/integration dalı, projenin ${run.targetBranch} dalına fast-forward ile uygulansın mı? Ana çalışma ağacı kirliyse işlem güvenli biçimde durur.`,
      });
      this.checkStop(run);
      if (publish) {
        const result = await gitops.publishIntegration(run.projectDir, run.id, run.targetBranch);
        S.addMessage(run, {
          from: "sistem", kind: result.ok ? "info" : "error",
          content: result.ok ? `✓ Test edilmiş değişiklikler ${result.branch} dalına uygulandı.` : `✗ Hedef dala uygulama durduruldu: ${result.error}`,
        });
      } else {
        S.addMessage(run, { from: "sistem", kind: "info", content: `Yayınlama reddedildi; test edilmiş kod ajan/${run.id}/integration dalında tutuluyor.` });
      }
    } else if (merged && !allMerged) {
      S.addMessage(run, { from: "sistem", kind: "error", content: "Bazı dallar birleştirilemediği için eksik integration dalı hedef dala uygulanmadı." });
    }
    this.exportArtifacts(run,"integration");
  }

  async runTests(run, testDir) {
    const S = this.store;
    try {
      const { stdout, stderr } = await exec("/bin/zsh", ["-lc", run.testCommand], {
        cwd: testDir, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
      });
      const output = truncate(stdout + "\n" + stderr, 12000);
      recordTestExecution(run,{command:run.testCommand,ok:true,output,cwd:testDir});
      S.addMessage(run, { from: "sistem", kind: "info", content: "✓ Testler başarılı.\n" + truncate(stdout, 3000) });
      S.updateRun(run);
      return { ok: true, output };
    } catch (err) {
      const output = truncate((err.stdout || "") + "\n" + (err.stderr || err.message), 12000);
      recordTestExecution(run,{command:run.testCommand,ok:false,output,cwd:testDir});
      S.addMessage(run, { from: "sistem", kind: "error", content: "✗ Testler BAŞARISIZ:\n" + truncate(output, 3000) });
      S.updateRun(run);
      return { ok: false, output };
    }
  }

  projectHistory(run) {
    if (!run.projectDir) return "";
    const prev = Object.values(this.store.runs)
      .filter((r) => r.projectDir === run.projectDir && r.id !== run.id && (r.report || r.messages?.length || r.decisions?.length || r.files?.length))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6);
    if (!prev.length) return "";
    return prev
      .map((r) => {
        const recent=(r.messages||[]).filter((m)=>m.kind!=="task").slice(-6).map((m)=>`[${m.fromLabel||m.from}]: ${truncate(m.content,500)}`).join("\n");
        const decisions=(r.decisions||[]).slice(-4).map((d)=>`- ${d.title}: ${d.rationale||d.detail||""}`).join("\n");
        const files=(r.files||[]).slice(-12).map((f)=>`${f.change} ${f.path}`).join(", ");
        return `### Önceki proje sohbeti (${r.createdAt.slice(0,10)}): ${truncate(r.title||r.request,150)}\n${truncate(r.report||recent,2200)}${decisions?`\nKararlar:\n${truncate(decisions,1000)}`:""}${files?`\nDosyalar: ${truncate(files,800)}`:""}`;
      })
      .join("\n\n");
  }

  async directMessage(run, memberId, content, attachments = []) {
    const S = this.store;
    if (run.turnActive || run.directActive) {
      return { ok: true, queued: true, item: this.enqueueMessage(run, { target: memberId, text: content, attachments }) };
    }
    run.directActive = true;
    run.stopRequested = false;
    S.updateRun(run, { status: "running", phase: "answering" });
    const member = this.memberById(memberId);
    try {
      if (!member) throw new Error("Bilinmeyen üye: " + memberId);
      const unsupported = unsupportedAttachments(member.provider, attachments);
      if (unsupported.length) throw new Error(`${member.name} şu ekleri okuyamaz: ${unsupported.map((a)=>a.name).join(", ")}`);
      this.restoreSessions(run);
      attachments = await enrichAttachments(attachments);
      const images = attachments.filter((a) => a.kind === "image").map((a) => a.path).filter((p) => fs.existsSync(p));
      const attachNote = attachments.length ? "\n" + attachments.map((a) => `📎 ${a.url || a.path}`).join("\n") : "";
      // Kullanici metni zaten "@Üye:" ile basliyorsa onek ikilenmesin.
      const mention = new RegExp(`^\\s*@${member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i");
      const bareContent = String(content || "").replace(mention, "");
      S.addMessage(run, { from: "kullanici", kind: "message", content: `@${member.name}: ${bareContent || "Ek dosyaları incele."}`, attachments });
      const imageNote = attachmentPrompt(attachments);
      const inherited=this.projectHistory(run);
      const memory=this.projectContext.readMemory(run.projectId);
      // Ilk temasta kod tabani brifingi + kanit kurali verilir; ajan kodu
      // gormeden "su ozellik yok" gibi iddialar uretmesin.
      const firstContact = !this.providers[member.provider].sessions.get(this.sessionKeyFor(run, member));
      const brief = firstContact ? await this.codebaseBrief(run) : "";
      const res = await this.callMember(run, member,
        `Kullanıcıdan sana doğrudan bir mesaj geldi (konsey sohbeti bağlamında, Türkçe ve Markdown ile yanıtla).${inherited?`\n\nProjede önceki sohbetlerden devralınan bağlam:\n${inherited}`:""}${memory?`\n\nKalıcı proje hafızası:\n${truncate(memory,4000)}`:""}${brief}\n\n${bareContent}${imageNote}`,
        { label: "doğrudan mesaj", images, media: attachments, timeoutMs: member.provider === "antigravity" ? 12 * 60 * 1000 : undefined,
          // Sağlayıcı/bağlayıcı kararını proje hafızası veya önceki sohbetten
          // değil, yalnız kullanıcının bu turdaki gerçek mesajından üret.
          // Böylece geçmişte geçen "Codex" ya da "GitHub" sözcükleri Claude,
          // Antigravity ve Ox Alpha'yı ortak Codex köprüsüne taşıyamaz.
          routeText: bareContent,
          shouldStop: () => run.stopRequested });
      if (res.ok) {
        res.text = await this.guaranteeImageOutput(run, member, bareContent, res.text, { images, media:attachments });
        this.memberMsg(run, member, "message", res.text);
      }
      else if (!run.stopRequested) S.addMessage(run, { from: "sistem", kind: "error", content: `${member.name} yanıt veremedi: ${res.error}` });
      return res;
    } finally {
      run.directActive = false;
      this.persistSessions(run);
      S.updateRun(run, { status: "idle", phase: "idle" });
      this.drainMessageQueue(run);
    }
  }

  async testAntigravityBridge() {
    const agent = this.providers.antigravity;
    const result = await agent.send(
      "KÖPRÜ BAĞLANTI TESTİ: Yalnızca 'ANTIGRAVITY_KOPRU_OK' yaz. Bu bir kullanıcı görevi değildir.",
      { label: "köprü testi", sessionKey: "bridge-test", timeoutMs: 90_000 }
    );
    agent.updateBridgeStatus();
    if (!result.ok) throw new Error(result.error || "Antigravity köprüsü yanıt vermedi");
    this.refreshBridgeHealth();
    return { ok: true, reply: result.text };
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
    for (const memberId of run.agents || []) this.store.clearStream(memberId);
    this.store.cancelApprovals(run.id);
    this.store.updateRun(run, { status: "stopped", phase: "stopped" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kullanıcı tarafından durduruldu." });
  }
}
