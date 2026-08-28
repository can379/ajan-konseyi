import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const app=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");
const orch=fs.readFileSync(new URL("../src/orchestrator.js",import.meta.url),"utf8");
const desktop=fs.readFileSync(new URL("../desktop/main.cjs",import.meta.url),"utf8");

test("sohbet yaşam döngüsü yeniden adlandırma sabitleme arşiv ve devir içerir",()=>{
  assert.match(server,/req\.method==="PATCH"&&runDetail/);assert.match(server,/\/transfer/);
  assert.match(app,/pinned/);assert.match(app,/archived/);assert.match(html,/Bağlamıyla devret/);
});

test("proje çalışma alanı canlı sunucu çıktı kataloğu ve kontrol noktaları içerir",()=>{
  assert.match(server,/detectDevCommand/);assert.match(server,/devSessions/);assert.match(server,/\/artifacts/);assert.match(server,/checkpointsDir/);
  assert.match(app,/startProjectPreview/);assert.match(app,/renderProjectArtifacts/);assert.match(app,/openCheckpoints/);
});

test("proje talimatları yetenekler diff yorumları ve otomatik devam desteklenir",()=>{
  assert.match(orch,/Proje talimatları/);
  // Yetenekler artik toptan enjekte edilmez: govdeler diske yazilir, isteme
  // yalniz katalog girer (asamali acilim). Ifade skills.js'e tasindi.
  assert.match(orch,/skillCatalogFor\(run\)/);
  assert.match(fs.readFileSync(new URL("../src/skills.js",import.meta.url),"utf8"),/yeniden kullanılabilir çalışma yetenekleri/);
  assert.match(server,/diff-comments/);assert.match(server,/run\.status==="interrupted"&&run\.autoResume/);
  assert.match(app,/data-diff-file/);assert.match(app,/openProjectSettings/);assert.match(app,/function showModal\(html\)/);
});
test("yerleşik proje editörü güvenli dosya ağacı arama ve kaydetme sunar",()=>{
  assert.match(server,/files\\\/\(tree\|read\|write\|create\|rename\|search\)/);
  assert.match(server,/Proje dışına erişilemez/);assert.match(app,/loadEditorTree/);assert.match(app,/openEditorFile/);assert.match(html,/data-tool-tab="editor"/);
});
test("merkezi görev kuyruğu koşuları izler ve duraklatma sürdürme yeniden deneme sunar",()=>{
  assert.match(server,/taskAction/);assert.match(server,/pause\|resume\|retry\|cancel/);assert.match(app,/renderTaskCenter/);assert.match(html,/data-tool-tab="tasks"/);
});
test("canlı önizleme konsol hataları cihaz boyutları yakalama ve sunucu yeniden başlatma sunar",()=>{
  assert.match(app,/console-message/);assert.match(app,/render-process-gone/);assert.match(app,/browser-server-restart/);assert.match(html,/browser-device/);assert.match(html,/browser-capture/);
});
test("sohbetler etiketlenir toplu taşınır çöpe alınır ve dışa içe aktarılır",()=>{
  assert.match(server,/ajan-chat-v1/);assert.match(server,/deletedAt/);assert.match(app,/openChatManager/);assert.match(app,/data-bulk-chat/);assert.match(html,/Etiketleri düzenle/);
});
test("proje hafızası düzenlenir unutur sabitler işaretler ve devir paketi yapılandırılır",()=>{
  assert.match(server,/memoryMatch/);assert.match(server,/Yapılandırılmış devir paketi/);assert.match(app,/openProjectMemory/);assert.match(html,/Proje hafızası/);
});
test("yetenek paketleri proje bazlı izinler ve denetim günlüğü yönetilir",()=>{
  assert.match(server,/workspace\/skills/);assert.match(server,/workspace\/permissions/);assert.match(server,/workspace\/audit/);
  assert.match(app,/renderSecurityCenter/);assert.match(app,/externalServices/);assert.match(html,/data-tool-tab="security"/);
});
test("git ve test merkezi dal durumu diff log commit ve test çalıştırmayı sunar",()=>{
  assert.match(server,/gitCenter/);assert.match(server,/rev-list/);assert.match(server,/--unified=3/);assert.match(server,/test\.run/);
  assert.match(server,/files:status\.split\("\\n"\)/);assert.doesNotMatch(server,/files:status\.trim\(\)\.split/);
  assert.match(app,/renderGitCenter/);assert.match(html,/data-tool-tab="git"/);assert.match(html,/git-test-output/);
});
test("EvidenceGate review ve zorunlu kontroller geçmeden merge publish done işlemlerini engeller",()=>{
  // MERGE kapisi artik hep-ya-hic DEGIL: gorev bazinda degerlendirilir,
  // kaniti gecen isler birlesir, gecmeyenler dalinda kalip raporlanir.
  // Onceden tek gorev gecemese TUM birlestirme iptal oluyor ve 12 gorevlik
  // emek kullaniciya hic ulasmiyordu (canli goruldu).
  assert.match(orch,/evaluateEvidenceGate\(run, "merge"/);
  assert.match(orch,/Kanıtı yeterli bulunmayan görevler birleştirilmedi/);
  assert.match(orch,/Hiçbir dal kanıt kapısını geçemedi/);
  assert.match(orch,/enforceEvidenceGate\(run,"publish"/);
  assert.match(orch,/enforceEvidenceGate\(run, "done"/);
  // Kapi artik kosuyu oldurmez: eksik adim onarilip yeniden denenir, onarim
  // mumkun degilse hata yine yukselir (kapi gevsetilmedi).
  assert.match(orch,/await this\.repairEvidenceGap\(run, error\.reasons/);
  assert.match(orch,/if \(!repaired\) throw error/);
});
test("review sonrası değişiklik tree kimliğiyle eski onayı geçersiz kılar ve tekrar inceletir",()=>{
  assert.match(orch,/revalidateChangedReviews/);assert.match(orch,/invalidateStaleReviews/);assert.match(orch,/reviewedTree/);
});
test("ResourceLease port container DB cache ve dış servis yazma sahipliğini çakışmadan yönetir",()=>{
  assert.match(server,/workspace\/leases/);assert.match(server,/type:"port"/);assert.match(orch,/external-service/);assert.match(app,/resource-lease-list/);assert.match(html,/Aktif kaynaklar/);
});
test("ArtifactExport task handoff review integration sonuçlarını isteğe bağlı repoya aktarır",()=>{
  assert.match(server,/artifact-export/);assert.match(server,/exportRunArtifacts/);assert.match(orch,/exportArtifacts\(run,"review"/);assert.match(orch,/exportArtifacts\(run,"integration"/);assert.match(app,/project-artifact-export/);
});
test("masaüstü güncelleyici GitHub sürümünü denetler paketi boyut ve SHA-256 ile doğrular",()=>{
  assert.match(desktop,/app-update-status/);assert.match(desktop,/app-update-download/);assert.match(desktop,/createHash\("sha256"\)/);assert.match(desktop,/bytes\.length!==Number\(asset\.size\)/);
  assert.match(app,/checkApplicationUpdate/);assert.match(html,/update-download/);
});
