import crypto from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}


// Sozlesmedeki zorunlu test komutlarini, sistemin KAYDETTIGI gercek
// calistirmalarla eslestirir. Boylece reviewer "hangi zorunlu test fiilen
// calisti, hangisi calismadi" sorusunu yazarin anlatimindan degil olaylardan
// gorur. Calismayan komut sessizce kaybolmaz; acikca "calistirilmadi" olur.
export function bindTestEvidence(contract, tests) {
  const commands = [...new Set((contract?.testCommands || []).map((c) => String(c || "").trim()).filter(Boolean))];
  const executions = Array.isArray(tests) ? tests : [];
  return commands.map((command) => {
    const match = [...executions].reverse().find((item) => String(item.command || "").trim() === command);
    if (!match) return { command, ran: false, ok: false, at: null, output: "" };
    return {
      command, ran: true, ok: match.ok === true, at: match.ts || null,
      output: String(match.output || "").slice(-4000),
    };
  });
}

function cleanTests(value) {
  return (Array.isArray(value) ? value : []).slice(-50).map((item) => ({
    command: String(item.command || "").slice(0, 1000), ok: item.ok === true,
    output: String(item.output || "").slice(-12000), ts: item.ts || null,
  }));
}

export function createReviewPacket({ taskId, contract, author }) {
  if (!contract || contract.status !== "ready") throw new Error("İnceleme için hazır TaskContract gerekli");
  if (!author?.commit) throw new Error("İnceleme için immutable yazar commit'i gerekli");
  const payload = {
    schema: "ajan-review-isolation/v1", taskId: String(taskId || ""),
    contract: canonical({ version:contract.version, goal:contract.goal, nonGoals:contract.nonGoals,
      allowedPaths:contract.allowedPaths, forbiddenPaths:contract.forbiddenPaths, risk:contract.risk,
      acceptanceCriteria:contract.acceptanceCriteria, testCommands:contract.testCommands,
      approvalBoundaries:contract.approvalBoundaries, revision:contract.revision, fingerprint:contract.fingerprint }),
    author: { commit:String(author.commit), parentCommit:String(author.parentCommit || ""), tree:String(author.tree || ""),
      diff:String(author.diff || "").slice(0,120000), tests:cleanTests(author.tests),
      // Zorunlu komut -> gercek calistirma eslesmesi (olaylardan, anlatimdan degil)
      requiredTests:bindTestEvidence(contract, author.tests) },
  };
  payload.fingerprint=crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  return freeze(payload);
}

export function isolatedReviewPrompt(packet, reviewerName="Reviewer") {
  return `Sen bağımsız reviewer ${reviewerName}. Bu inceleme oturumu izoledir.

Yalnız aşağıdaki immutable kanıt paketini kullan. Sohbet geçmişine, kullanıcının önceki mesajlarına, yazarın açıklamalarına, ortak hafızaya, proje dosyalarına, internete veya başka araçlara başvurma. Kod değiştirme. Pakette olmayan bilgi için varsayım üretme; "kanıt yok" de.

TaskContract kabul kriterlerini tek tek commit diff'i ve test sonuçlarıyla karşılaştır.
Paketteki "requiredTests" alanı, sözleşmenin zorunlu komutlarını sistemin kaydettiği GERÇEK çalıştırmalarla eşleştirir: ran=false ise o test hiç çalışmamıştır, yazarın metinde ne dediği önemsizdir.

PUANLAMA — DİKKAT. Elinde YALNIZ bu paket var: dosya sistemi, test çalıştırma ve tarayıcı YOK. Bu senin kısıtın, yazarın kusuru DEĞİL. İkisini karıştırma:
- "Diff'te SOMUT bir kusur görüyorum" (yanlış mantık, eksik kod, kriterle çelişen değişiklik) → düşük puan, önem yüksek. Kusuru diff satırıyla göster.
- "Bu paketten doğrulayamıyorum" (görsel değişiklik, çalışma zamanı davranışı, cihazda test gerektiren şey) → bunu points içinde AÇIKÇA yaz ama TEK BAŞINA düşük puan ve yüksek önem sebebi SAYMA. Diff kabul kriterine uygunsa 3-4 ver, doğrulanamayan kısmı not düş.
Ölçüt şu: bulduğun şey işi DURDURMALI mı, yoksa sadece not mu? Yüksek önem = bu haliyle birleştirilirse zarar verir. Her incelemeye 1/5 + yüksek vermek bilgi taşımaz; gerçekten engelleyici olanı ayırt et.

Sonucu YALNIZCA şu şemada tek JSON nesnesi olarak ver:
{"agreement":1-5,"severity":"dusuk|orta|yuksek","points":["somut bulgu"],"evidence":["commit/diff/test kanıtı"],"dogrulanamayan":["paketten doğrulanamayan konular"],"suggestion":"tek cümlelik öneri"}

--- IMMUTABLE REVIEW PACKET (${packet.fingerprint}) ---
${JSON.stringify(packet,null,2)}
--- PACKET END ---`;
}

export function invalidateStaleReviews(reviews,taskId,currentTree,at=new Date().toISOString()){
  const active=(reviews||[]).filter((review)=>review.taskId===taskId&&!review.invalidatedAt);
  if(!active.length||active.every((review)=>review.reviewedTree===currentTree))return [];
  for(const review of active)Object.assign(review,{invalidatedAt:at,invalidationReason:"Review sonrası içerik değişti",supersededByTree:currentTree});
  return active;
}
