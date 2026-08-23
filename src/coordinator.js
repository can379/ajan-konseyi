import { extractJson, truncate } from "./util.js";

// Koordinatör: görevleri analiz eden, bölen, dağıtan ve sonuçları birleştiren
// "beyin". Hangi yapay zekânın (claude/codex/antigravity) koordinatör olacağına
// KULLANICI karar verir; seçilen sağlayıcının CLI'ı abonelik oturumuyla kullanılır.
export class Coordinator {
  constructor(store, providers, getCfg) {
    this.store = store;
    this.providers = providers;   // {claude, codex, antigravity} adaptörleri
    this.getCfg = getCfg;         // () => config.data.coordinator
  }

  agentFor() {
    const cfg = this.getCfg?.() || {};
    return this.providers[cfg.provider] || this.providers.claude;
  }

  // orkestratörün oturum/durdurma erişimi için
  get agent() {
    return this.agentFor();
  }

  coordKey(ctx) {
    return (ctx?.runId || "global") + "#koord";
  }

  resetSession(runId) {
    const key = (runId || "global") + "#koord";
    for (const p of Object.values(this.providers)) p.sessions.delete(key);
  }

  // ctx: {runId, stopCheck, onUsage} — koşuya özgü bağlam her çağrıda gelir;
  // örnek durumu tutulmaz, paralel koşular birbirini ezemez (konsey bulgusu #1).
  async askJson(prompt, label, ctx = {}) {
    const cfg = this.getCfg?.() || {};
    const opts = {
      label,
      sessionKey: this.coordKey(ctx),
      model: cfg.model || undefined,
      effort: cfg.effort || undefined,
      shouldStop: ctx.stopCheck || undefined,
      onUsage: ctx.onUsage || undefined,
    };
    this.store.setAgentStatus("koordinator", "busy", label || "");
    try {
      let res = await this.agentFor().send(prompt, opts);
      if (!res.ok) throw new Error(`Koordinatör çağrısı başarısız: ${res.error}`);
      let json = extractJson(res.text);
      if (!json) {
        res = await this.agentFor().send(
          "Önceki yanıtın geçerli JSON içermiyordu. Aynı içeriği, açıklama olmadan YALNIZCA tek bir JSON nesnesi olarak tekrar ver.",
          opts
        );
        if (!res.ok) throw new Error(`Koordinatör çağrısı başarısız: ${res.error}`);
        json = extractJson(res.text);
      }
      if (!json) throw new Error("Koordinatör geçerli JSON üretemedi: " + truncate(res.text, 300));
      this.store.setAgentStatus("koordinator", "idle");
      return json;
    } catch (err) {
      const stopped = ctx.stopCheck?.() === true;
      this.store.setAgentStatus("koordinator", stopped ? "idle" : "error", stopped ? "" : String(err.message).slice(0, 80));
      throw err;
    }
  }

  // ---- Sohbet turu yönlendirme ----
  async routeTurn(run, memberList, ctx) {
    const prompt = `Sen konseyin KOORDİNATÖRÜSÜN ve sürekli bir SOHBETİ yönetiyorsun.

${this.digest(run, 8)}

Kullanıcının YENİ mesajı:
"""
${truncate(run.request, 2000)}
"""

Kullanılabilir üyeler (id | ad | sağlayıcı | rol):
${memberList}
${run.projectDir ? `Bağlı proje: ${run.projectDir}` : "Bağlı proje yok."}

Karar ver:
- "quick": mesaj tek bir üyenin doğrudan yanıtlayabileceği türde (soru, sohbet, açıklama, görüş). En uygun üyenin ID'sini seç.
- "council": görev bölüşümü, çok yönlü analiz, tartışma veya KOD DEĞİŞİKLİĞİ gerektiriyor. Uygun modu seç (discussion|split|code). Kod değişikliği isteniyorsa ve proje bağlıysa mode "code" olmalı.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{"approach": "quick|council", "member_id": "üye id'si", "mode": "discussion|split|code", "reason": "tek cümle (Türkçe)"}`;
    return this.askJson(prompt, "yönlendirme", ctx);
  }

  // ---- Planlama ----
  async plan(run, memberList, extra = {}, ctx = {}) {
    const historyPart = extra.historyText
      ? `\nBu projede daha önce yapılan çalışmaların özeti (kaldığı yerden devam etmek için dikkate al):\n${extra.historyText}\n`
      : "";
    const memoryPart = extra.memoryText
      ? `\nPROJE HAFIZASI (geçmiş kararlar ve kurallar — bunlarla çelişme):\n${truncate(extra.memoryText, 4000)}\n`
      : "";
    const mapPart = extra.repoMap
      ? `\nREPO HARİTASI (ajanlar keşfe zaman harcamasın diye görev istemlerine uygun kısımlarını ekle):\n${truncate(extra.repoMap, 5000)}\n`
      : "";
    const testFirstPart = extra.testFirst
      ? `\nTEST-ÖNCE modu açık: kod görevlerinde önce bir üyeye BAŞARISIZ testleri yazdır, sonra depends_on ile bağlı ayrı bir görevde başka üyeye testleri geçirecek kodu yazdır.\n`
      : "";
    const attachPart = extra.attachmentsText ? `\n${extra.attachmentsText}\n` : "";

    const prompt = `Sen çok üyeli bir yapay zekâ konseyinin KOORDİNATÖRÜSÜN.

Kullanılabilir üyeler (id | ad | sağlayıcı | rol | model):
${memberList}

Sağlayıcı güçlü yönleri ve DEĞİŞMEZ görev sınırları:
- claude=mimari, derin muhakeme, kod yazma, kod inceleme ve güvenlik.
- codex=kod yazma, uygulama, test, hata ayıklama ve bütünleştirme.
- antigravity=web araştırması, kaynak doğrulama, görsel üretme/düzenleme, medya analizi, tarayıcı/UX testi, içerik ve alternatif görüş. Antigravity'ye kaynak kodu yazma, kodu değiştirme, refactor veya test kodu yazma görevi VERME.
Üyenin rolü "auto" değilse dağıtımda rolüne uy. AYNI role sahip birden çok üye varsa
işi aralarında paylaştır — paralel çalışırlar ve birbirlerinin çıktısını çapraz incelerler.
Farklı üyelere verilen görevler AYNI ANDA yürür; bir üyeye verilen görevler sırayla yürür.
Gerekiyorsa aynı temel üyeyi birden fazla bağımsız ajan örneği gibi kullan: her alt görev
ayrı oturumda çalışır. Üye veya ajan sayısını üçle ya da başka sabit bir sayıyla sınırlama;
işin kapsamı kaç bağımsız uzman gerektiriyorsa o kadar alt görev oluştur.
Planı tek seferlik bağımsız cevaplar gibi kurma: araştırma/tasarım bulgularını kullanacak kod görevlerine depends_on ekle. Böylece ajanlar önceki ajanın çıktısını okuyup onun üzerine çalışsın.

Kullanıcının isteği:
"""
${run.request}
"""
${historyPart}${memoryPart}${mapPart}${testFirstPart}${attachPart}
Çalışma modu: ${run.mode}
- "discussion": üyeler aynı soruyu tartışır, ortak sonuca varılır.
- "split": görev alt parçalara bölünür, üyeler paylaşır.
- "code": kod geliştirme; üyeler ayrı çalışma kopyalarında kod yazar/inceler.

Görevin: isteği analiz et ve plan çıkar. Her alt görev TEK BİR ÜYEYE (id ile) atanır.
Alt görev istemi o üyeye doğrudan gönderilecek şekilde eksiksiz yazılmalı.

Önemli kurallar:
- "Görüşleri birleştir/sentezle" türünde alt görev OLUŞTURMA; sentezi sen yaparsın.
- Kod incelemesi/analizi görevlerinde göreve şu kuralı YAZ: "Bir dosya hakkında
  iddia üretmeden önce dosyanın GÜNCEL halini oku; her iddiaya dosya:satır kanıtı ekle."
- Bir görev başka görevin çıktısına ihtiyaç duyuyorsa "depends_on" ile belirt.
- Gereksiz ajan oluşturma; fakat kapsam gerçekten paralelleşebiliyorsa gereken sayıda
  bağımsız görev/ajan örneği oluşturmaktan kaçınma.
- Her görev için zorluk kademesi "model_tier" ver: fast|balanced|strong.
- En az iki uygun üye varsa çözüm üreten görevlere çapraz inceleme yapılacağını varsay; review_rounds değerini risk ve kapsam büyüdükçe 1 veya 2 seç.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{
  "analysis": "kısa analiz (Türkçe)",
  "mode": "discussion|split|code",
  "subtasks": [
    {"id": "t1", "title": "kısa başlık", "member_id": "üye id'si", "prompt": "eksiksiz görev metni", "depends_on": [], "model_tier": "fast|balanced|strong"}
  ],
  "review_rounds": 1
}`;
    return this.askJson(prompt, "planlama", ctx);
  }

  // ---- Çelişki değerlendirme ----
  async assessConflict(run, round, ctx) {
    const prompt = `Aşağıda konsey üyelerinin görev çıktıları ve birbirlerine
yaptıkları incelemeler var (tur ${round}).

${this.digest(run, 14)}

Görevin: üyeler arasında GERÇEK bir görüş ayrılığı/çelişki olup olmadığını
değerlendir. Küçük üslup farkları çelişki sayılmaz; sonucu değiştirecek
anlaşmazlıklar sayılır.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{
  "conflict": true veya false,
  "summary": "durumun kısa özeti (Türkçe)",
  "debate_prompt": "çelişki varsa üyelere gönderilecek tartışma sorusu; yoksa boş dize"
}`;
    const result = await this.askJson(prompt, "çelişki değerlendirme", ctx);
    return {
      conflict: result?.conflict === true,
      summary: String(result?.summary || "Görüş ayrılığı bulunamadı"),
      debate_prompt: String(result?.debate_prompt || ""),
    };
  }

  // ---- Nihai sentez ----
  async finalize(run, voteInfo = null, ctx = {}) {
    const votePart = voteInfo
      ? `\nOylama sonuçları:\n${JSON.stringify(voteInfo, null, 2)}\n`
      : "";
    const prompt = `Konsey çalışması tamamlanmak üzere. Ortak kayıt aşağıda.

${this.digest(run, 18)}
${votePart}
Görevin: nihai kararı ve kullanıcıya sunulacak raporu hazırla. Rapor Türkçe,
markdown biçiminde olmalı: yapılan iş özeti, üyelerin katkıları, varsa görüş
ayrılıkları ve çözümü, nihai sonuç/öneri, açık kalan konular.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{
  "decision": "tek cümlelik nihai karar (Türkçe)",
  "rationale": "bu kararın neden seçildiği (Türkçe)",
  "report_markdown": "tam rapor (markdown, Türkçe)"
}`;
    const result = await this.askJson(prompt, "sentez", ctx);
    const decision = String(result?.decision || "Çalışma tamamlandı");
    return {
      decision,
      rationale: String(result?.rationale || "Konsey çıktıları birlikte değerlendirildi."),
      report_markdown: String(result?.report_markdown || decision),
    };
  }

  // ---- Birleştirme planı ----
  async mergePlan(run, diffs, ctx) {
    const diffText = diffs
      .map((d) => `--- ${d.memberName} (dal: ${d.branch}) ---\n${truncate(d.diff, 6000)}`)
      .join("\n\n");
    const prompt = `Kod görevi tamamlandı. Üyeler ayrı git dallarında çalıştı.
Değişiklikler:

${diffText}

${this.digest(run, 8)}

Görevin: birleştirme planı çıkar. AYNI dosyada çakışan değişiklikler otomatik
birleştirilMEZ; bunları "conflicts" alanında listele.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{
  "summary": "değişikliklerin kısa özeti (Türkçe)",
  "merge_order": ["önce birleştirilecek dalın sahibi üye ID'si", "..."],
  "conflicts": ["çakışma açıklaması"],
  "risks": ["risk"]
}`;
    const result = await this.askJson(prompt, "birleştirme planı", ctx);
    return {
      summary: String(result?.summary || "Değişiklikler integration dalında birleştirilecek."),
      merge_order: Array.isArray(result?.merge_order) ? result.merge_order.map(String) : [],
      conflicts: Array.isArray(result?.conflicts) ? result.conflicts.map(String) : [],
      risks: Array.isArray(result?.risks) ? result.risks.map(String) : [],
    };
  }

  // Ortak kaydın sınırlı özeti
  digest(run, lastN = 12) {
    const msgs = run.messages.slice(-lastN);
    const lines = msgs.map(
      (m) => `[${m.fromLabel || m.from} / ${m.kind}${m.taskId ? " / " + m.taskId : ""}]\n${truncate(m.content, 3500)}`
    );
    return `Ana istek: "${truncate(run.request, 1500)}"\n\nSon kayıtlar:\n${lines.join("\n\n")}`;
  }
}
