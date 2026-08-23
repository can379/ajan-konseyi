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
  const approach = route?.approach === "quick" ? "quick" : "council";
  return {
    approach,
    member_id: validMemberIds.includes(route?.member_id) ? route.member_id : validMemberIds[0],
    mode: ["discussion", "split", "code"].includes(route?.mode) ? route.mode : "discussion",
    reason: String(route?.reason || ""),
  };
}
