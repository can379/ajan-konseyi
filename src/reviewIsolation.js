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
      diff:String(author.diff || "").slice(0,120000), tests:cleanTests(author.tests) },
  };
  payload.fingerprint=crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  return freeze(payload);
}

export function isolatedReviewPrompt(packet, reviewerName="Reviewer") {
  return `Sen bağımsız reviewer ${reviewerName}. Bu inceleme oturumu izoledir.

Yalnız aşağıdaki immutable kanıt paketini kullan. Sohbet geçmişine, kullanıcının önceki mesajlarına, yazarın açıklamalarına, ortak hafızaya, proje dosyalarına, internete veya başka araçlara başvurma. Kod değiştirme. Pakette olmayan bilgi için varsayım üretme; "kanıt yok" de.

TaskContract kabul kriterlerini tek tek commit diff'i ve test sonuçlarıyla karşılaştır. Sonucu YALNIZCA şu şemada tek JSON nesnesi olarak ver:
{"agreement":1-5,"severity":"dusuk|orta|yuksek","points":["somut bulgu"],"evidence":["commit/diff/test kanıtı"],"suggestion":"tek cümlelik öneri"}

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
