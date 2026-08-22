import { ClaudeAgent } from "./agents/claudeAgent.js";
import { extractJson, truncate } from "./util.js";

// Koordinatör: görevleri analiz eden, bölen, dağıtan ve sonuçları
// birleştiren "beyin". Ücretli API yerine Claude Code CLI'nin abonelik
// oturumunu kendi ayrı oturumu ile kullanır.
export class Coordinator {
  constructor(store, rootDir) {
    this.agent = new ClaudeAgent(store, rootDir, { name: "koordinator" });
  }

  resetSession() {
    this.agent.resetSession();
  }

  stop() {
    this.agent.stop();
  }

  async askJson(prompt, label) {
    let res = await this.agent.send(prompt, { label });
    if (!res.ok) throw new Error(`Koordinatör çağrısı başarısız: ${res.error}`);
    let json = extractJson(res.text);
    if (!json) {
      res = await this.agent.send(
        "Önceki yanıtın geçerli JSON içermiyordu. Aynı içeriği, açıklama olmadan YALNIZCA tek bir JSON nesnesi olarak tekrar ver.",
        { label }
      );
      if (!res.ok) throw new Error(`Koordinatör çağrısı başarısız: ${res.error}`);
      json = extractJson(res.text);
    }
    if (!json) throw new Error("Koordinatör geçerli JSON üretemedi: " + truncate(res.text, 300));
    return json;
  }

  // 1. aşama: görevi analiz et ve alt görevlere böl
  async plan(run, availableAgents, extra = {}) {
    const rolesPart = extra.rolesText
      ? `\nKullanıcının üyeler için atadığı roller (rol "auto" değilse dağıtımda buna uy):\n${extra.rolesText}\n`
      : "";
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
    const prompt = `Sen üç yapay zekâdan oluşan bir konseyin KOORDİNATÖRÜSÜN.
Üyeler ve güçlü yönleri:
- claude (Claude Code): mimari, kapsam analizi, derin muhakeme, kod inceleme
- codex (OpenAI Codex): uygulama, kod yazma, test yazma
- antigravity (Google Antigravity): alternatif çözüm, araştırma, ikinci görüş

Şu anda KULLANILABİLİR üyeler: ${availableAgents.join(", ")}
(Listede olmayan üyeye görev ATAMA.)
${rolesPart}${historyPart}${memoryPart}${mapPart}${testFirstPart}

Kullanıcının isteği:
"""
${run.request}
"""

Çalışma modu: ${run.mode}
- "discussion": tüm üyeler aynı soruyu tartışır, ortak sonuca varılır.
- "split": görev alt parçalara bölünür, üyeler paylaşır.
- "code": kod geliştirme; üyeler ayrı çalışma kopyalarında kod yazar/inceler.
- "auto": en uygun modu SEN seç.

Görevin: isteği analiz et ve bir plan çıkar. Her alt görev tek bir üyeye atanır.
Alt görev istemi (prompt) o üyeye doğrudan gönderilecek şekilde eksiksiz ve
kendi kendine yeterli yazılmalı.

Önemli kurallar:
- "Görüşleri birleştir / sentezle / ortak rapor yaz" türünde alt görev
  OLUŞTURMA; nihai sentezi süreç sonunda koordinatör (sen) zaten yapar.
- Bir alt görev başka bir alt görevin ÇIKTISINA ihtiyaç duyuyorsa bunu
  "depends_on" alanında belirt; o çıktılar göreve otomatik eklenir ve görev
  bağımlılıkları bitince başlar. Bağımsız görevler paralel çalışır.

Ayrıca her alt görev için zorluk kademesi belirt ("model_tier"):
- "fast": basit/mekanik işler (özet, listeleme, küçük düzeltme)
- "balanced": normal işler
- "strong": zor muhakeme, mimari kararlar, karmaşık kod

YALNIZCA şu şemada tek bir JSON nesnesi döndür, başka hiçbir şey yazma:
{
  "analysis": "kısa analiz (Türkçe)",
  "mode": "discussion|split|code",
  "subtasks": [
    {"id": "t1", "title": "kısa başlık", "assignee": "claude|codex|antigravity", "prompt": "üyeye gidecek eksiksiz görev metni", "depends_on": [], "model_tier": "fast|balanced|strong"}
  ],
  "review_rounds": 1
}`;
    return this.askJson(prompt, "planlama");
  }

  // Çapraz incelemelerden sonra: çelişki var mı?
  async assessConflict(run, round) {
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
  "debate_prompt": "çelişki varsa, üyelere gönderilecek tartışma sorusu; yoksa boş dize"
}`;
    return this.askJson(prompt, "çelişki değerlendirme");
  }

  // Oylama sonrası veya uzlaşma sonrası nihai sentez
  async finalize(run, voteInfo = null) {
    const votePart = voteInfo
      ? `\nOylama sonuçları:\n${JSON.stringify(voteInfo, null, 2)}\n`
      : "";
    const prompt = `Konsey çalışması tamamlanmak üzere. Ortak kayıt aşağıda.

${this.digest(run, 18)}
${votePart}
Görevin: nihai kararı ve kullanıcıya sunulacak raporu hazırla. Rapor Türkçe,
markdown biçiminde olmalı ve şunları içermeli: yapılan iş özeti, üyelerin
katkıları, varsa görüş ayrılıkları ve nasıl çözüldüğü, nihai sonuç/öneri,
varsa açık kalan konular.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{
  "decision": "tek cümlelik nihai karar (Türkçe)",
  "rationale": "bu kararın neden seçildiği (Türkçe)",
  "report_markdown": "tam rapor (markdown, Türkçe)"
}`;
    return this.askJson(prompt, "sentez");
  }

  // Kod modunda: hangi değişiklikler nasıl birleştirilmeli?
  async mergePlan(run, diffs) {
    const diffText = diffs
      .map((d) => `--- ${d.agent} (dal: ${d.branch}) ---\n${truncate(d.diff, 6000)}`)
      .join("\n\n");
    const prompt = `Kod görevi tamamlandı. Üyeler ayrı git dallarında çalıştı.
Değişiklikler:

${diffText}

${this.digest(run, 8)}

Görevin: birleştirme planı çıkar. AYNI dosyada çakışan değişiklikler otomatik
birleştirilMEZ; bunları "conflicts" alanında listele, kullanıcı incelemesine
sunulacaklar.

YALNIZCA şu şemada tek bir JSON nesnesi döndür:
{
  "summary": "değişikliklerin kısa özeti (Türkçe)",
  "merge_order": ["önce birleştirilecek dalın sahibi ajan adı", "..."],
  "conflicts": ["çakışma açıklaması", "..."],
  "risks": ["risk", "..."]
}`;
    return this.askJson(prompt, "birleştirme planı");
  }

  // Görev yeniden atama: bir üye başarısız/ulaşılamaz olduğunda
  pickFallback(assignee, availableAgents) {
    const order = ["claude", "codex", "antigravity"];
    for (const a of order) {
      if (a !== assignee && availableAgents.includes(a)) return a;
    }
    return null;
  }

  // Ortak kaydın sınırlı bir özeti — gereksiz büyüklükte geçmiş gönderilmez
  digest(run, lastN = 12) {
    const msgs = run.messages.slice(-lastN);
    const lines = msgs.map(
      (m) => `[${m.from} / ${m.kind}${m.taskId ? " / " + m.taskId : ""}]\n${truncate(m.content, 3500)}`
    );
    return `Ana istek: "${truncate(run.request, 1500)}"\n\nSon kayıtlar:\n${lines.join("\n\n")}`;
  }
}
