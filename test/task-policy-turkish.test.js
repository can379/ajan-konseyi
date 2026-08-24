import test from "node:test";
import assert from "node:assert/strict";
import { requiresCodeAuthoring, enforceTaskAssignments, canAuthorCode } from "../src/taskPolicy.js";

const task = (title) => ({ id: "t1", title, prompt: "", member_id: "m-claude" });

// JS'de "\b" Turkce harften once ve sonra guvenilir degildir: bosluk da "ö"
// de sozcuk karakteri sayilmaz, ASCII harfler ise ek geldiginde siniri
// bozar. Eski kaliplar bu yuzden erratikti: "araştırıp" esliyor ama
// "araştırması" eslesmiyordu; "özet" ve "çeviri" ise hic eslesmiyordu.
test("Turkce ekli arastirma gorevleri kod gorevi sayilmaz", () => {
  for (const t of ["Test altyapısı araştırması", "Rakipleri araştırma raporu",
                   "Mevcut testlerin özeti", "Belgenin çevirisi", "Görselleri hazırla"]) {
    assert.equal(requiresCodeAuthoring(task(t), "code"), false, t);
  }
});

test("Turkce ekli kod gorevleri kod gorevi sayilir", () => {
  for (const t of ["Kodu düzeltme işi", "API uçlarını geliştirme",
                   "repairMemory için test yaz", "Şemayı migration ile güncelle"]) {
    assert.equal(requiresCodeAuthoring(task(t), "code"), true, t);
  }
});

// Ucuz rota: kod yazmayan basit gorevler Antigravity'ye gitmeli. Kalip
// tutmadigi icin bu rota pratikte calismiyordu.
test("kod yazmayan gorev ucuz saglayiciya yonlendirilir", () => {
  const members = [
    { id: "m-claude", name: "Claude", provider: "claude", role: "auto" },
    { id: "m-codex", name: "Codex", provider: "codex", role: "auto" },
    { id: "m-agy", name: "Antigravity", provider: "antigravity", role: "arastirmaci" },
  ];
  const [assigned] = enforceTaskAssignments(
    [{ ...task("Rakipleri araştırma raporu"), model_tier: "balanced" }], members, "code", true);
  assert.equal(assigned.member_id, "m-agy");
});

test("kod gorevi kod yazabilen uyede kalir", () => {
  const members = [
    { id: "m-codex", name: "Codex", provider: "codex", role: "uygulayici" },
    { id: "m-agy", name: "Antigravity", provider: "antigravity", role: "arastirmaci" },
  ];
  const [assigned] = enforceTaskAssignments(
    [{ ...task("Kodu düzeltme işi"), member_id: "m-agy", model_tier: "balanced" }], members, "code", true);
  assert.ok(canAuthorCode(members.find((m) => m.id === assigned.member_id)));
});

// Asagidaki iki istem GERCEK bir kosudan alindi. Salt okunur arastirma
// gorevi ile gercek kod gorevi ayni cumleleri ("Kod YAZMA", "hiçbir dosyayı
// DEĞİŞTİRME") tasiyabiliyor: birinde gorevin tanimi, digerinde yalnizca
// kapsam siniri. Bu yuzden yalniz KESIN beyan ("SALT OKUNUR") sayilir.
const GERCEK_ARASTIRMA = { title: "Test altyapısı ve koşum yaklaşımı", prompt: "SALT OKUNUR araştırma görevi. Kod YAZMA, hiçbir dosyayı DEĞİŞTİRME.\n\nRepo: /Users/selim/Desktop/ajan\n\nGörev: Bu repoda testlerin nasıl yazıldığını ve nasıl çalıştırıldığını çıkar:\n1. package.json içindeki scripts ve devDependencies bloklarını oku; gerçek test komutunu (ör. `npm test` neye karşılık geliyor) satır kanıtıyla belirt.\n2. Hangi test çatısı kullanılıyor (node:test mi, jest mi, başka mı)? ESM mi CJS mi? assert kütüphanesi hangisi?\n3. Testlerin ortak yazım kalıpları: dosya adlandırma, import biçimi, geçici dizin/fixture kurulumu, temizlik (t.after vb.), varsa özel koşum durumları (timeout, sıralı çalıştırma, ortam değişkenleri).\n4. Sonuç olarak 5-8 maddelik, yeni bir test yazacak kişinin uyması gereken kısa bir yazım kuralları listesi ver.\n\nKURAL: Bir dosya hakkında iddia üretmeden önce dosyanın GÜNCEL halini oku; her iddiaya dosya:satır kanıtı ekle. Raporu Türkçe yaz." };
const GERCEK_KOD = { title: "Tek kenar durum testi ekle ve çalıştır", prompt: "Uygulama görevi. Önceki adımların (t1: test altyapısı/yazım kuralları, t2: mevcut test envanteri ve test edilmemiş kenar durum adayı) çıktılarını OKU ve onların üzerine çalış.\n\nHedef: src/repairMemory.js için test/ altına TEK BİR kenar durum testi ekle ve çalıştır.\n\nKATI SINIRLAR:\n- Üretim koduna DOKUNMA. src/ altında hiçbir dosyayı değiştirme (src/orchestrator.js dahil).\n- SADECE TEK BİR test ekle. Birden çok test, birden çok yeni test dosyası veya ek refactor YASAK.\n- t1'in bildirdiği yazım kurallarına (test çatısı, ESM/CJS, assert biçimi, geçici dizin ve temizlik kalıbı) uy.\n- t2'nin önerdiği kenar durumu ele al; farklı bir kenar durum seçeceksen gerekçesini yaz.\n\nZORUNLU DOĞRULAMA: Testi ekledikten sonra repodaki gerçek test komutunu çalıştır ve TAM çıktının özetini (geçen/başarısız sayısı) raporuna yapıştır. Yalnız yeni testi değil, tüm paketi çalıştır ve regresyon olmadığını göster.\n\nRaporunda: eklenen testin dosya:satır konumu, test kodunun tamamı ve koşum çıktısı yer alsın. Türkçe yaz." };

test("gercek salt okunur arastirma gorevi kod gorevi sayilmaz", () => {
  assert.equal(requiresCodeAuthoring(GERCEK_ARASTIRMA, "code"), false);
});

test("gercek kod gorevi kapsam sinirlari yuzunden salt okunur sanilmaz", () => {
  assert.equal(requiresCodeAuthoring(GERCEK_KOD, "code"), true);
});

test("gercek kod gorevi kod yazamayan uyeye yonlendirilmez", () => {
  const members = [
    { id: "m-codex", name: "Codex", provider: "codex", role: "uygulayici" },
    { id: "m-agy", name: "Antigravity", provider: "antigravity", role: "arastirmaci" },
  ];
  const [assigned] = enforceTaskAssignments(
    [{ ...GERCEK_KOD, id: "t3", member_id: "m-agy", model_tier: "balanced" }], members, "code", true);
  assert.equal(assigned.member_id, "m-codex");
});

test("gercek arastirma gorevi ucuz saglayiciya yonlendirilir", () => {
  const members = [
    { id: "m-codex", name: "Codex", provider: "codex", role: "uygulayici" },
    { id: "m-agy", name: "Antigravity", provider: "antigravity", role: "arastirmaci" },
  ];
  const [assigned] = enforceTaskAssignments(
    [{ ...GERCEK_ARASTIRMA, id: "t1", member_id: "m-codex", model_tier: "balanced" }], members, "code", true);
  assert.equal(assigned.member_id, "m-agy");
});
