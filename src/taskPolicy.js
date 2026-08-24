// Turkce sozcukler ek alir: "kod" -> "kodu", "araştır" -> "araştırması".
// Kaliplarin sonunda \b kullanilmasi bu eklerde eslesmeyi bozuyordu ve
// davranis erratikti: "araştırıp" esliyor ("ı" ASCII olmadigi icin \b
// tutuyor) ama "araştırması" eslesmiyordu. Bu yuzden kok eslesmesi yapilir;
// bas sinirini koruyup son sinir birakilir, ekler serbest kalir.
// Ayrica JS'de "\\b" Turkce harften ONCE de eslesmez: bosluk da "ö" de
// sozcuk karakteri sayilmadigi icin sinir olusmaz. Bu yuzden "özet" ve
// "çeviri" kokleri hicbir zaman tutmuyordu. Sinir Unicode harf/rakam
// olumsuzlamasiyla kurulur.
const stems = (list) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${list.join("|")})`, "iu");

const CODE_ACTION = stems(["kod","code","source","implement","uygula","geliştir","düzelt","refactor",
  "endpoint","api","component","fonksiyon","class","test yaz","migration","schema",
  "css","html","javascript","typescript","python","swift","react","node"]);
const NON_CODE_SPECIALTY = stems(["araştır","research","web","kaynak","rakip","trend","görsel",
  "fotoğraf","video","illüstrasyon","tasarım üret","canva","tarayıcıda test",
  "kullanıcı deneyimi","içerik","metin","çeviri","özet"]);

// Salt okunur gorevlerin istemi "kod veya test yazma" gibi YASAK cumleleri
// icerir. Kalip olumsuzlamayi goremedigi icin bu cumleler gorevi kod gorevi
// gibi gosteriyor, arastirma isleri ucuz saglayiciya hic yonlenmiyordu.
// Acik salt-okunur beyani her seyin onunde gelir.
// Yalniz KESIN beyanlar sayilir. "kod yazma" veya "hiçbir dosyayı
// değiştirme" gibi ifadeler gercek kod gorevlerinin "KATI SINIRLAR"
// bolumunde de gecer ("baska dosyaya dokunma" anlaminda); onlari salt
// okunur saymak kod gorevini kod yazamayan uyeye yollar. Olculdu ve
// duzeltildi; asagidaki kalip gercek kosudan alinan iki istemle sinanir.
const READ_ONLY_DECLARATION = /salt okunur|yalnızca oku ve raporla|sadece oku ve raporla/iu;

export function requiresCodeAuthoring(task, mode = "discussion") {
  const text = `${task?.title || ""}\n${task?.prompt || ""}`;
  if (READ_ONLY_DECLARATION.test(text)) return false;
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

export function enforceTaskAssignments(tasks, members, mode, smartModels = true) {
  const counts = Object.fromEntries(members.map((m) => [m.id, 0]));
  return tasks.map((task) => {
    let member = members.find((m) => m.id === task.member_id) || members[0];
    const simpleNonCode=!requiresCodeAuthoring(task,mode)&&task.model_tier!=="strong";
    const antigravity=members.filter((m)=>m.provider==="antigravity").sort((a,b)=>(counts[a.id]||0)-(counts[b.id]||0))[0];
    if(smartModels&&simpleNonCode&&antigravity) member=antigravity;
    if (requiresCodeAuthoring(task, mode) && !canAuthorCode(member)) {
      member = preferredCoder(members, counts) || member;
    }
    if (member) counts[member.id] = (counts[member.id] || 0) + 1;
    return { ...task, member_id: member?.id || task.member_id, routing_reason:smartModels&&simpleNonCode&&antigravity?"Düşük maliyetli Antigravity rotası":"Uzmanlık ve risk rotası" };
  });
}
