const CODE_ACTION = /\b(?:kod|code|source|implement|uygula|geliştir|düzelt|refactor|endpoint|api|component|fonksiyon|class|test yaz|migration|schema|css|html|javascript|typescript|python|swift|react|node)\b/i;
const NON_CODE_SPECIALTY = /\b(?:araştır|research|web|kaynak|rakip|trend|görsel|fotoğraf|video|illüstrasyon|tasarım üret|canva|tarayıcıda test|kullanıcı deneyimi|içerik|metin|çeviri|özet)\b/i;

export function requiresCodeAuthoring(task, mode = "discussion") {
  const text = `${task?.title || ""}\n${task?.prompt || ""}`;
  if (NON_CODE_SPECIALTY.test(text) && !CODE_ACTION.test(text)) return false;
  return CODE_ACTION.test(text) || (mode === "code" && !NON_CODE_SPECIALTY.test(text));
}

export function canAuthorCode(member) {
  return member?.provider === "codex" || member?.provider === "claude";
}

export function preferredCoder(members, taskCounts = {}) {
  return members.filter(canAuthorCode).sort((a, b) => {
    const roleA = a.role === "uygulayici" ? -2 : a.role === "mimar" ? -1 : 0;
    const roleB = b.role === "uygulayici" ? -2 : b.role === "mimar" ? -1 : 0;
    return (roleA + (taskCounts[a.id] || 0)) - (roleB + (taskCounts[b.id] || 0));
  })[0] || null;
}

export function enforceTaskAssignments(tasks, members, mode) {
  const counts = Object.fromEntries(members.map((m) => [m.id, 0]));
  return tasks.map((task) => {
    let member = members.find((m) => m.id === task.member_id) || members[0];
    if (requiresCodeAuthoring(task, mode) && !canAuthorCode(member)) {
      member = preferredCoder(members, counts) || member;
    }
    if (member) counts[member.id] = (counts[member.id] || 0) + 1;
    return { ...task, member_id: member?.id || task.member_id };
  });
}
