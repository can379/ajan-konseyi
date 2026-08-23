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
import { extractJson, now, truncate, uid } from "./util.js";
import * as gitops from "./gitops.js";
import { completeMergeOrder, normalizePlan, normalizeRoute } from "./validation.js";
import { enrichAttachments, attachmentPrompt, unsupportedAttachments, collectGeneratedAssets } from "./media.js";
import { analyzeImagesLocally } from "./localVision.js";
import { bridgePrompt, connectorRoute, CONNECTORS } from "./connectorBridge.js";
import { canAuthorCode, enforceTaskAssignments, preferredCoder, requiresCodeAuthoring } from "./taskPolicy.js";

const exec = promisify(execFile);
const BROWSER_ACTION_RE=/<<<AJAN_BROWSER_ACTION>>>\s*([\s\S]*?)\s*<<<END>>>/;
const HOST_ACTION_RE=/<<<AJAN_HOST_ACTION>>>\s*([\s\S]*?)\s*<<<END>>>/;
export function parseBrowserAction(text){const match=String(text||"").match(BROWSER_ACTION_RE);if(!match)return null;try{const value=JSON.parse(match[1]);if(!["open","snapshot","navigate","click","type"].includes(value.action))return null;return{action:value.action,payload:value.payload&&typeof value.payload==="object"?value.payload:{}};}catch{return null;}}
export function parseHostAction(text){const match=String(text||"").match(HOST_ACTION_RE);if(!match)return null;try{const value=JSON.parse(match[1]);if(value.action!=="publish")return null;return{action:"publish",payload:value.payload&&typeof value.payload==="object"?value.payload:{}};}catch{return null;}}

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
    return true;
  }

  availableMembers() {
    return this.members().filter((m) => m.enabled && this.providerAvailable(m.provider));
  }

  mediaCapableMembers(attachments, list = this.availableMembers()) {
    return list.filter((m) => unsupportedAttachments(m.provider, attachments).length === 0);
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
        const direct = /@?antigravit(?:y|iy)\b|\bantigravit(?:y|iy)\b.{0,32}\b(?:yapsın|yanıtlasın|devam etsin|çalışsın|üretsin|incelesin)\b/i;
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

  sharedConversationContext(run, maxChars = 24_000) {
    const messages = run.messages || [];
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
  async callMember(run, member, prompt, opts = {}) {
    const route = connectorRoute(member.provider, prompt);
    const provider = this.providers[route?.mode === "shared" ? route.provider : member.provider];
    this.store.setAgentStatus(member.id, "busy", opts.label || "");
    const history = this.sharedConversationContext(run);
    const images = this.referencedImages(run, prompt, opts.images || []);
    const effectiveOpts = { ...opts, images };
    const capabilityContract = `--- AJAN KONSEYİ ORTAK YETENEK SÖZLEŞMESİ ---
Arka planda, kullanıcıdan rutin onay istemeden çalış. Sağlayıcında bulunan terminal, dosya düzenleme, web araştırma/tarayıcı, görsel okuma-üretme, MCP, eklenti, skill, alt ajan, plan ve görev araçlarını gerektiğinde doğrudan kullan. Yapabildiğin işi tarif etmekle yetinme; tamamla ve sonucu doğrula. Ürettiğin görsel, video, ses, PDF, belge, sunum, tablo veya diğer dosyaları bağlı proje ya da ${this.rootDir}/generated dizinine gerçek dosya olarak kaydet ve yanıtta mutlak dosya yolunu ayrı satırda ver. Webden alınan güncel iddialarda kaynak bağlantılarını ekle. Kullanıcı özellikle istemedikçe uygulama/GUI açma. Yalnız kullanıcı hesabı, ödeme, yayınlama, silme veya geri döndürülemez işlem gerçekten gerekiyorsa dur.
--- SÖZLEŞME SONU ---`;
    const browserToken=this.browserBridge?.issueAgentToken({actor:member.name,provider:member.provider});
    const browserHelp=browserToken?`\n\n--- UYGULAMA TARAYICI ARACI ---\nKullanıcı tarayıcıda açma, inceleme, tıklama veya yazma istediğinde curl, localhost, MCP ya da kendi browser aracını kullanma. Bunun yerine yanıtının TAMAMINI şu makine-okur biçiminde döndür:\n<<<AJAN_BROWSER_ACTION>>>{"action":"snapshot","payload":{}}<<<END>>>\nEylemler: open {url}, snapshot {}, navigate {url}, click {elementId}, type {elementId,text}. Açık sekmeyi incelemek için önce snapshot; yeni site için open kullan. Araç sonucu sana otomatik geri verilecek ve aynı işi sürdürmen istenecek. Normal alanlarda işlem yap; e-posta/kullanıcı adı, parola, OTP ve ödeme alanlarını kullanıcı doldurur. Bu köprü Codex, Claude ve Antigravity için aynıdır.\n--- TARAYICI ARACI SONU ---`:"";
    const hostHelp=`\n\n--- ANA UYGULAMA YAYIN ARACI ---\nKullanıcı açıkça seçili projenin son sürümünü GitHub'a yayınlamanı veya push etmeni isterse sağlayıcı terminalinden git/ssh/gh/curl kullanma ve .command dosyası hazırlama. Yanıtının TAMAMINI şu biçimde döndür:\n<<<AJAN_HOST_ACTION>>>{"action":"publish","payload":{}}<<<END>>>\nAna uygulama açık dalı kayıtlı deploy key ile yayınlar; force-push yapmaz ve sonucu sana geri verir.\n--- YAYIN ARACI SONU ---`;
    let effectivePrompt = `${capabilityContract}\n\n${history ? `--- ORTAK SOHBET GEÇMİŞİ ---\n${history}\n--- GEÇMİŞ SONU ---\n\n` : ""}${prompt}${browserHelp}${hostHelp}\n\nÖnceki konuşmayı ve diğer ajanların yanıtlarını aynı sohbetin bağlamı kabul et. Kullanıcı açıkça konu değiştirmedikçe kaldığı yerden devam et; geçmişte verilmiş bilgi veya eki tekrar isteme.`;
    if (route?.mode === "shared") {
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
    const providerOpts = {
      ...effectiveOpts,
      sessionKey: opts.sessionKey || (route?.mode === "shared"
        ? `${this.sessionKeyFor(run, member)}#connector#${route.connector}`
        : this.sessionKeyFor(run, member)),
      memberId: member.id,
      model: selectedModel,
      effort: member.effort || undefined,
      onUsage: (u) => this.accumUsage(run, member.id, u),
    };
    let res = await provider.send(effectivePrompt, providerOpts);
    // Sağlayıcı sandbox'ının localhost erişimine bel bağlama. Üç sağlayıcının da
    // yapılandırılmış isteğini orkestratör kendi güvenilir köprüsünde çalıştırır.
    for(let step=0;res.ok&&step<12;step++){
      const browserAction=browserToken&&parseBrowserAction(res.text);
      const hostAction=parseHostAction(res.text);
      if(!browserAction&&!hostAction)break;
      const action=browserAction||hostAction;
      let result;
      try{
        if(browserAction)result=await this.browserBridge.request({token:browserToken,...browserAction});
        else{
          if(!/(?:github|git\b).{0,80}(?:yayın|yayin|push|gönder)|(?:yayınla|yayinla|push et).{0,80}(?:github|repo|proje|sürüm)/i.test(prompt))throw new Error("Yayınlama için kullanıcının bu mesajda açık talebi gerekli");
          const projectDir=run.projectDir||process.env.AJAN_KONSEYI_SOURCE_DIR;
          const deployKey=path.join(this.rootDir,"generated","ajan-konseyi-deploy");
          result=await gitops.publishCurrentBranch(projectDir,deployKey,String(hostAction.payload.branch||""));
        }
      }
      catch(error){result={error:String(error.message||error)};}
      const followup=`--- ANA UYGULAMA ARAÇ SONU ---\nİstenen eylem: ${JSON.stringify(action)}\nSonuç: ${JSON.stringify(result)}\n--- SONUÇ BİTTİ ---\nKullanıcının görevini sürdür. Başka bir araç eylemi gerekiyorsa ilgili ACTION biçimini döndür; iş tamamlandıysa normal nihai yanıtını ver.`;
      res=await provider.send(opts.fresh?`${effectivePrompt}\n\n${followup}`:followup,{...providerOpts,fresh:opts.fresh});
    }
    const stopped = run.stopRequested;
    this.store.setAgentStatus(member.id, res.ok || stopped ? "idle" : "error",
      res.ok || stopped ? "" : String(res.error || "").slice(0, 80));
    if (route && res?.raw) res.raw.connectorRoute = route;
    return res;
  }

  isImageGenerationRequest(text) {
    const value=String(text||"");
    // "Görsel üretme yeteneğini denetle" bir görsel siparişi değil, meta
    // incelemedir. Bu ayrım yapılmazsa rapor sonunda gereksiz ImageGen açılır.
    if(/(?:yetenek denetimi|yeteneklerini (?:öğren|incele|değerlendir|karşılaştır)|ayrı ayrı değerlendir|eksik yetenek|durumunu raporla)/i.test(value)) return false;
    return /(?:görsel|fotoğraf|resim|image|illustration|illüstrasyon|poster|logo|ikon).{0,80}(?:oluştur|üret|çiz|tasarla|generate|create)|(?:oluştur|üret|çiz|tasarla).{0,80}(?:görsel|fotoğraf|resim|image|illüstrasyon)/i.test(value);
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
      id:uid("img-"), title:`Görsel ${index + 1}`, prompt,
      assignee:(advisers[index % Math.max(1, advisers.length)] || members[0])?.id || "antigravity",
      generator:"codex", status:"pending", result:null, error:null,
    }));
    this.store.updateRun(run);
    this.store.addMessage(run, { from:"koordinator", kind:"info", content:`${work.length} görsel görevi ${limit} eşzamanlı worker ile konseye dağıtıldı. Sanat yönetimini seçilen ajanlar, yüksek kaliteli raster üretimini ortak görsel motoru yapacak.` });
    this.runImageBatch(run, limit).catch((err) => this.failRun(run, err));
  }

  async runImageBatch(run, concurrency) {
    const members = this.members();
    const generator = members.find((m) => m.provider === "codex") || members.find((m) => m.provider === "antigravity") || {
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
          let productionPrompt = this.imageGenerationPrompt(`${task.prompt}\nGörsel oluştur.`);
          // Görev sahibi kompozisyonu hazırlar; raster motoru ayrı çalışır.
          if (adviser && adviser.id !== generator.id) {
            const advised = await this.callMember(run, adviser,
              `Bu görsel için kısa, üretime hazır ve kullanıcı niyetine sadık bir prompt yaz. Canva, MCP veya görsel üretim aracı çağırma; dosya üretme. Yalnız üretim promptunu döndür.\n\n${task.prompt}`,
              { label:"görsel promptu hazırlıyor", timeoutMs:90_000, shouldStop:()=>run.stopRequested });
            if (advised.ok && advised.text?.trim()) productionPrompt = this.imageGenerationPrompt(`${advised.text.trim()}\nGörsel oluştur.`);
          }
          const generated = await this.callMember(run, generator,
            `${productionPrompt}\n\nDosyayı ${this.rootDir}/generated içine benzersiz bir adla kaydet ve mutlak dosya yolunu yaz. Yerleşik görsel üretim aracını MUTLAKA kullan; gerçek PNG/JPEG/WebP olmadan görevi tamamlanmış sayma.`,
            { label:`${task.title} üretiliyor`, cwd:run.projectDir || this.rootDir,
              sessionKey:`${run.id}#image#${task.id}`, timeoutMs:5*60*1000,
              shouldStop:()=>run.stopRequested });
          if (!generated.ok) throw new Error(generated.error || "Ortak görsel motoru başarısız");
          const assets = collectGeneratedAssets(generated.text, this.rootDir)
            .filter((a) => a.kind === "image" && a.mime !== "image/svg+xml" && a.path && fs.existsSync(a.path));
          const accepted = await this.validatedImageAssets(task.prompt, assets);
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
    this.store.addMessage(run, { from:"koordinator", kind:run.batch.failed ? "info" : "result", content:`Toplu üretim tamamlandı: ${run.batch.completed}/${run.batch.total} başarılı, ${run.batch.failed} hatalı.` });
    this.persistSessions(run);
  }

  async guaranteeImageOutput(run, requestedMember, requestText, responseText, opts = {}) {
    if (!this.isImageGenerationRequest(requestText) && !this.isImageRevisionRequest(run, requestText)) return responseText;
    const existing = collectGeneratedAssets(responseText, this.rootDir);
    const explicitlySvg=/(?:\bsvg\b|vektör|vector)/i.test(String(requestText||""));
    const needsRaster=!explicitlySvg || /(?:gerçekçi|fotogerçekçi|fotoğraf|photoreal|realistic|insan|portre)/i.test(String(requestText||""));
    const eligible = existing.filter((a)=>a.kind==="image"&&a.path&&fs.existsSync(a.path)&&(!needsRaster||a.mime!=="image/svg+xml"));
    const validated = await this.validatedImageAssets(requestText, eligible);
    if(validated.length) return this.keepOnlyAssetPaths(responseText, existing, validated);

    // Bir sağlayıcı yalnız "oluşturdum" diyerek gerçek dosya döndürmediyse
    // Codex'in yüksek kaliteli raster aracını ortak motor
    // olarak kullan. Yanıt, istenen üyenin aynı mesajında render edilir.
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
    const assets = collectGeneratedAssets(generated.text, this.rootDir);
    const accepted = await this.validatedImageAssets(requestText, assets);
    if (!accepted.length) {
      throw new Error("Görsel motoru yanıt verdi ancak açılabilir bir görsel dosyası oluşturmadı");
    }
    // Geçersiz SVG/"yapamam" açıklamasını son mesaja taşımıyoruz; kullanıcı
    // yalnız gerçek üretim sonucunu ve raster önizlemeyi görür.
    return `İstenen görsel yüksek kaliteli ortak görsel motoruyla oluşturuldu ve doğrulandı.\n\n${this.keepOnlyAssetPaths(generated.text, assets, accepted)}`;
  }

  memberMsg(run, member, kind, content, taskId = null, requestText = "") {
    let attachments = collectGeneratedAssets(content, this.rootDir);
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
    this.store.addMessage(run, {
      from: member.id, fromLabel: member.name, provider: member.provider,
      kind, taskId, content: displayContent, attachments,
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
    health.antigravity = this.bridgeHealth();
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
    enrichAttachments(run.attachments || []).then((items) => { run.attachments = items; this.store.updateRun(run); return this.runPipeline(run, false); })
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
  enqueueMessage(run, item) {
    run.queuedMessages ||= [];
    const queued = {
      id: uid("queue-"),
      ts: new Date().toISOString(),
      target: item.target || "konsey",
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
        ? this.continueChat(run, next.text, next.attachments, next.mode)
        : this.directMessage(run, next.target, next.text, next.attachments);
      job.catch((err) => this.store.addMessage(run, {
        from: "sistem", kind: "error", content: "Sıradaki mesaj işlenemedi: " + String(err.message || err),
      }));
    });
  }

  async continueChat(run, text, attachments = [], mode = "auto") {
    const S = this.store;
    if (run.turnActive) throw new Error("Bu sohbette bir tur zaten çalışıyor; önce durdurun");
    run.turnActive = true;
    run.stopRequested = false;
    run.request = text;
    attachments = await enrichAttachments(attachments);
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
    S.addMessage(run, { from: "kullanici", kind: "message", content: text || "Ek dosyaları incele.", attachments });

    try {
      const avail = this.availableMembers();
      if (!avail.length) throw new Error("Ulaşılabilir üye yok (kenar çubuğundan üyeleri kontrol edin)");

      const requestedMember = this.explicitlyRequestedMember(text, avail);
      let route;
      if (requestedMember) {
        route = { approach: "quick", member_id: requestedMember.id, explicit: true };
      } else if (mode !== "auto") {
        route = { approach: "council", mode };
      } else {
        route = normalizeRoute(await this.coordinator.routeTurn(run, this.memberListText(avail), ctx), avail.map((m) => m.id));
        this.checkStop(run);
      }

      if (attachments.length) {
        const capable = this.mediaCapableMembers(attachments, avail);
        if (!capable.length) throw new Error("Seçili medya türlerini okuyabilen etkin bir ajan yok");
        if (route.approach === "quick" && !capable.some((m) => m.id === route.member_id)) route.member_id = capable[0].id;
      }
      if (route.approach === "quick") {
        let member = avail.find((m) => m.id === route.member_id) || avail[0];
        await this.quickReply(run, member, text, attachments, { allowFallback: !route.explicit });
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
      this.drainMessageQueue(run);
    }
  }

  async quickReply(run, member, text, attachments, { allowFallback = true } = {}) {
    const S = this.store;
    S.setPhase(run, "answering");
    const images = attachments.filter((a) => a.kind === "image").map((a) => a.path).filter((p) => fs.existsSync(p));
    const imageNote = attachmentPrompt(attachments);
    const prefixFor = (mem) => {
      if (this.providers[mem.provider].sessions.get(this.sessionKeyFor(run, mem))) return "";
      const history = run.messages.slice(-10, -1)
        .map((m) => `[${m.fromLabel || m.from}]: ${truncate(m.content, 800)}`).join("\n");
      return `Sen "${mem.name}" adlı konsey üyesisin (${mem.provider}${mem.role !== "auto" ? ", rolün: " + mem.role : ""}); çok üyeli bir yapay zekâ konsey sohbetine katılıyorsun. ` +
        `Türkçe ve düzgün Markdown ile yanıtla.` +
        (run.projectDir ? ` Bağlı proje: ${run.projectDir}` : "") +
        (history ? `\n\nSohbet geçmişi:\n${history}` : "") + "\n\n--- KULLANICININ MESAJI ---\n";
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
    });
    // Üye yanıt veremezse (zaman aşımı/hata) sohbet takılmasın: bir kez başka üye dener
    if (!res.ok && !run.stopRequested && allowFallback) {
      const alt = this.availableMembers().find((m) => m.id !== member.id && m.provider !== "antigravity");
      if (alt) {
        S.addMessage(run, { from: "sistem", kind: "info", content: `${member.name} yanıt veremedi (${truncate(res.error, 100)}); ${alt.name} devralıyor.` });
        member = alt;
        res = await this.callMember(run, member, prefixFor(member) + text + imageNote, {
          label: "yanıtlıyor", images, media: attachments, cwd: run.projectDir || undefined,
          shouldStop: () => run.stopRequested,
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
      S.addMessage(run, { from: "kullanici", kind: "message", content: run.request, attachments: run.attachments || [] });
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
      const plan = normalizePlan(await this.coordinator.plan(run, this.memberListText(avail), {
        historyText: this.projectHistory(run),
        memoryText: this.projectContext.readMemory(run.projectId),
        repoMap: run.projectDir ? await this.projectContext.repoMap(run.projectDir) : "",
        testFirst: run.testFirst,
        attachmentsText: attachmentPrompt(run.attachments || []),
      }, ctx), avail.map((m) => m.id));
      this.checkStop(run);
      if (run.mode === "auto") run.mode = plan.mode || "discussion";
      const assignedTasks = enforceTaskAssignments(plan.subtasks || [], avail, plan.mode || run.mode);
      run.tasks = assignedTasks.map((t) => {
        const m = this.memberById(t.member_id) || avail[0];
        return {
          id: t.id, title: t.title, assignee: m.id, assigneeName: m.name,
          prompt: t.prompt, status: "pending", result: null,
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on : [],
          tier: ["fast", "balanced", "strong"].includes(t.model_tier) ? t.model_tier : "balanced",
          // Aynı yapılandırılmış üye birden fazla göreve atansa bile her görev
          // ayrı sağlayıcı konuşmasıdır; böylece koordinatör ajan çoğaltabilir.
          agentInstanceId: uid("agent-"),
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
      if (!run.targetBranch) run.targetBranch = await gitops.currentBranch(run.projectDir);
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
      await this.reconcilePeerFeedback(run, worktrees);
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
    if (requiresCodeAuthoring(task, run.mode) && !canAuthorCode(member)) {
      const coder = preferredCoder(avail, Object.fromEntries(avail.map((m) => [m.id, run.tasks.filter((t) => t.assignee === m.id).length])));
      if (!coder) { task.status="failed"; task.result="Kod yazabilecek etkin Claude veya Codex üyesi yok."; S.updateRun(run); return; }
      S.addMessage(run, { from:"koordinator", kind:"info", taskId:task.id, content:`Kod yazma görevi ${member?.name || task.assigneeName} yerine ${coder.name} üyesine atandı. Antigravity araştırma, görsel ve doğrulama görevlerinde tutulur.` });
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
    S.addMessage(run, { from: "koordinator", kind: "task", taskId: task.id, content: `[${member.name}] için görev: ${task.title}\n\n${task.prompt}` });

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
      tierModel: this.pickTierModel(member.provider, task.tier),
      images, media: run.attachments || [],
      shouldStop: () => run.stopRequested,
    };
    const imageNote = attachmentPrompt(run.attachments || []);
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
      const fb = requiresCodeAuthoring(task, run.mode)
        ? this.availableMembers().find((m) => m.id !== member.id && canAuthorCode(m))
        : this.availableMembers().find((m) => m.id !== member.id);
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
      res.text = await this.guaranteeImageOutput(run, member, task.prompt, res.text, opts);
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
    const providerBoundary = member.provider === "antigravity"
      ? " Antigravity olarak kaynak kodu yazma veya değiştirme; araştırma, görsel/medya, tarayıcı-UX doğrulaması, içerik ve alternatif görüş üret. Kod değişikliği gerektiğini görürsen bunu Claude/Codex için somut öneri ve kanıt olarak yaz."
      : " Claude/Codex olarak gerektiğinde kaynak kodu yazabilir, değiştirebilir ve test edebilirsin.";
    return `Sen "${member.name}" adlı konsey üyesisin (sağlayıcı: ${member.provider}). Konseyde başka üyeler de var; koordinatör görevleri dağıtır.${rolePart}${providerBoundary}${commitPart} Diğer üyelerin bulgularına atıf yap, katılmadığın noktayı gerekçelendir ve sonraki üyeye uygulanabilir bir devir notu bırak. Yanıtlarını Türkçe ve düzgün Markdown biçiminde yaz (başlıklar, listeler, kod için \`\`\` blokları); gereksiz uzatma.\n\nKullanıcının ana isteği: "${truncate(run.request, 1200)}"\n\n--- SANA VERİLEN GÖREV ---\n`;
  }

  // ---- Puanlı çapraz inceleme ----
  async reviewTask(run, task, worktrees) {
    const S = this.store;
    const reviewers = this.availableMembers().filter((m) => m.id !== task.assignee);
    await Promise.all(reviewers.map(async (reviewer) => {
      const prompt = this.roleHeader(reviewer, run) +
        `"${task.assigneeName}" üyesinin şu çıktısını eleştirel incele:\n\n### ${task.title}\n${truncate(task.result, 6000)}\n\n` +
        (reviewer.provider === "antigravity" && requiresCodeAuthoring(task, run.mode)
          ? `Bu bir kod görevidir. Kodu değiştirme; kullanıcı deneyimi, araştırma bulguları, görünür davranış, tarayıcı testi ve eksik gereksinimler açısından incele. Düzeltmeyi Claude/Codex'e tarif et.\n\n`
          : "") +
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

  // İnceleme yalnız raporda kalmaz: ciddi/somut itirazlar görev sahibine geri
  // döner. Yazar diğer ajanların görüşlerine tek tek cevap verir, gerekiyorsa
  // kendi çalışma kopyasında düzeltir ve görev çıktısını günceller.
  async reconcilePeerFeedback(run, worktrees) {
    const S=this.store;
    for (const task of run.tasks.filter((t)=>t.status==="done")) {
      const feedback=run.reviews.filter((r)=>r.taskId===task.id && (r.agreement<=3 || r.severity==="yuksek"));
      if(!feedback.length) continue;
      let author=this.memberById(task.assignee);
      if(requiresCodeAuthoring(task,run.mode)&&!canAuthorCode(author)) author=preferredCoder(this.availableMembers());
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
            S.addMessage(run, { from: "koordinator", kind: "info", content: "Testler kırıldı; onaylanan düzeltme turu başlıyor." });
            const fixerId = [...diffs].sort((a, b) => b.diff.length - a.diff.length)[0]?.memberId;
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
                testResult = await this.runTests(run, testDir);
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
      S.addMessage(run, { from: "kullanici", kind: "message", content: `@${member.name}: ${content || "Ek dosyaları incele."}`, attachments });
      const imageNote = attachmentPrompt(attachments);
      const res = await this.callMember(run, member,
        `Kullanıcıdan sana doğrudan bir mesaj geldi (konsey sohbeti bağlamında, Türkçe ve Markdown ile yanıtla):\n\n${content}${imageNote}`,
        { label: "doğrudan mesaj", images, media: attachments, timeoutMs: member.provider === "antigravity" ? 12 * 60 * 1000 : undefined,
          shouldStop: () => run.stopRequested });
      if (res.ok) {
        res.text = await this.guaranteeImageOutput(run, member, content, res.text, { images, media:attachments });
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
    this.store.cancelApprovals(run.id);
    this.store.updateRun(run, { status: "stopped", phase: "stopped" });
    this.store.addMessage(run, { from: "sistem", kind: "info", content: "Koşu kullanıcı tarafından durduruldu." });
  }
}
