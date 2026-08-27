export function normalizePlan(plan, validMemberIds) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.subtasks)) {
    throw new Error("Koordinatör planı geçersiz: subtasks dizisi eksik");
  }
  const validModes = new Set(["discussion", "split", "code"]);
  const seen = new Set();
  // Koordinatör görevin gerektirdiği kadar bağımsız ajan işi oluşturabilir.
  // Pratik sınır sağlayıcı kotası ve kullanıcının durdurma kontrolüdür.
  const subtasks = plan.subtasks.map((task, index) => {
    if (!task || typeof task !== "object") throw new Error(`Koordinatör planı geçersiz: görev ${index + 1}`);
    let id = String(task.id || `t${index + 1}`).replace(/[^\w-]/g, "_").slice(0, 40);
    if (!id || seen.has(id)) id = `t${index + 1}`;
    seen.add(id);
    const memberId = validMemberIds.includes(task.member_id) ? task.member_id : validMemberIds[0];
    if (!memberId) throw new Error("Koordinatör planı geçersiz: atanabilir üye yok");
    return {
      id,
      title: String(task.title || `Görev ${index + 1}`).slice(0, 160),
      member_id: memberId,
      prompt: String(task.prompt || task.title || "Görevi tamamla").slice(0, 16000),
      depends_on: Array.isArray(task.depends_on) ? task.depends_on.map(String).filter((x) => x !== id) : [],
      model_tier: ["fast", "balanced", "strong"].includes(task.model_tier) ? task.model_tier : "balanced",
    };
  });
  if (!subtasks.length) throw new Error("Koordinatör planı geçersiz: hiç görev üretilmedi");
  const ids = new Set(subtasks.map((t) => t.id));
  for (const task of subtasks) task.depends_on = [...new Set(task.depends_on.filter((id) => ids.has(id)))];
  return {
    ...plan,
    analysis: String(plan.analysis || "Plan hazırlandı"),
    mode: validModes.has(plan.mode) ? plan.mode : "discussion",
    subtasks,
    review_rounds: Math.max(0, Math.min(Number(plan.review_rounds) || 0, 2)),
  };
}

export function completeMergeOrder(requested, memberIds) {
  const valid = new Set(memberIds);
  const ordered = Array.isArray(requested) ? requested.filter((id) => valid.has(id)) : [];
  return [...new Set([...ordered, ...memberIds])];
}

export function normalizeRoute(route, validMemberIds) {
  // L1 quick · L2 pair (uretici + bagimsiz denetci) · L3 council
  let approach = ["quick", "pair", "council"].includes(route?.approach) ? route.approach : "council";
  const member_id = validMemberIds.includes(route?.member_id) ? route.member_id : validMemberIds[0];
  let reviewer_id = validMemberIds.includes(route?.reviewer_id) ? route.reviewer_id : null;
  if (reviewer_id === member_id) reviewer_id = null;
  // Denetci bulunamazsa ikinci uyeye dus; o da yoksa L1'e in.
  if (approach === "pair" && !reviewer_id) reviewer_id = validMemberIds.find((id) => id !== member_id) || null;
  if (approach === "pair" && !reviewer_id) approach = "quick";
  return {
    approach,
    member_id,
    reviewer_id,
    mode: ["discussion", "split", "code"].includes(route?.mode) ? route.mode : "discussion",
    // Router acikken koordinator isin agirligina gore model kademesi de secer.
    tier: ["fast", "balanced", "strong"].includes(route?.tier) ? route.tier : "balanced",
    reason: String(route?.reason || ""),
  };
}
