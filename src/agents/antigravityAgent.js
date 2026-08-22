import fs from "node:fs";
import path from "node:path";
import { BaseAgent } from "./base.js";
import { uid, sleep, now } from "../util.js";

const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_MS = 2000;

// Antigravity dosya köprüsü adaptörü.
// Antigravity'nin başsız (headless) bir CLI'ı olmadığı için görevler bir
// "gelen kutusu" klasörüne yazılır; kullanıcı Antigravity içindeki ajana
// bir kez köprü talimatını verir, ajan görevleri okuyup "giden kutusuna"
// yanıt dosyası yazar. Böylece API'siz, abonelik oturumuyla çalışır.
export class AntigravityAgent extends BaseAgent {
  constructor(store, rootDir, opts = {}) {
    super("antigravity", store, rootDir);
    this.bridgeDir = opts.bridgeDir || path.join(rootDir, "bridge", "antigravity");
    this.inbox = path.join(this.bridgeDir, "inbox");
    this.outbox = path.join(this.bridgeDir, "outbox");
    fs.mkdirSync(this.inbox, { recursive: true });
    fs.mkdirSync(this.outbox, { recursive: true });
    this.writeInstructions();
    this.updateBridgeStatus();
  }

  isConnected() {
    // Köprü, son 5 dakika içinde kalp atışı dosyası güncellendiyse bağlı sayılır.
    try {
      const st = fs.statSync(path.join(this.outbox, "heartbeat.txt"));
      return Date.now() - st.mtimeMs < 5 * 60 * 1000;
    } catch {
      return false;
    }
  }

  updateBridgeStatus() {
    if (this.store.agentStatus["antigravity"]?.status === "busy") return;
    if (this.isConnected()) {
      this.store.setAgentStatus("antigravity", "idle", "köprü bağlı");
    } else {
      this.store.setAgentStatus("antigravity", "offline", "köprü bekleniyor — bkz. bridge/antigravity/INSTRUCTIONS.md");
    }
  }

  async invoke(prompt, opts = {}) {
    const taskId = uid("agt-");
    const taskFile = path.join(this.inbox, `${taskId}.md`);
    const replyFile = path.join(this.outbox, `${taskId}.reply.md`);
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    const model = opts.model ?? this.getModel?.();
    const effort = opts.effort ?? this.getEffort?.();
    const prefNotes = [];
    if (model) prefNotes.push(`> Not: Mümkünse bu görevi "${model}" modeliyle işle.`);
    if (effort) prefNotes.push(`> Not: İstenen çaba seviyesi: ${effort}.`);
    const header = [
      `<!-- gorev-id: ${taskId} -->`,
      `<!-- yanit-dosyasi: outbox/${taskId}.reply.md -->`,
      `<!-- olusturulma: ${now()} -->`,
      ...(prefNotes.length ? ["", ...prefNotes] : []),
      "",
    ].join("\n");
    fs.writeFileSync(taskFile, header + prompt);
    this.log(`görev yazıldı: ${taskFile}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.shouldStop?.()) throw new Error("Koşu durduruldu");
      if (fs.existsSync(replyFile)) {
        // Dosya yazımı bitene kadar kısa bekle (yarım dosya okumamak için)
        await sleep(1000);
        const text = fs.readFileSync(replyFile, "utf8").trim();
        if (text) {
          // İşlenen görev dosyalarını arşive taşı
          const doneDir = path.join(this.bridgeDir, "done");
          fs.mkdirSync(doneDir, { recursive: true });
          try { fs.renameSync(taskFile, path.join(doneDir, `${taskId}.md`)); } catch {}
          try { fs.renameSync(replyFile, path.join(doneDir, `${taskId}.reply.md`)); } catch {}
          return { ok: true, text, raw: { taskId } };
        }
      }
      await sleep(POLL_MS);
    }
    try { fs.renameSync(taskFile, taskFile + ".timeout"); } catch {}
    throw new Error(
      `Antigravity köprüsünden ${Math.round(timeoutMs / 60000)} dakika içinde yanıt gelmedi. ` +
      `Antigravity açık ve köprü talimatı verilmiş mi? (bridge/antigravity/INSTRUCTIONS.md)`
    );
  }

  writeInstructions() {
    const abs = this.bridgeDir;
    const text = `# Antigravity Köprü Talimatı

Antigravity'nin başsız (headless) bir komut satırı arayüzü bulunmadığından,
bu sistem Antigravity ile bir dosya köprüsü üzerinden konuşur.

## Kurulum (her Antigravity oturumunda bir kez)

1. Antigravity'yi açın ve şu klasörü çalışma alanı olarak ekleyin:
   ${abs}

2. Antigravity'deki ajana aşağıdaki talimatı aynen yapıştırın:

---

Sen bir çoklu yapay zekâ konseyinin üyesisin. Görevin şu klasörü izlemek:
${abs}

Kurallar:
1. "inbox" klasöründe yeni bir .md dosyası belirdiğinde onu oku. Dosyanın
   başındaki yorum satırında görev kimliği (gorev-id) ve yanıt dosyası yolu yazar.
2. Görevi dikkatle yap ve yanıtını TAM OLARAK belirtilen yanıt dosyasına yaz:
   outbox/<gorev-id>.reply.md
3. Yanıt dosyasına yalnızca yanıt içeriğini yaz; başka dosya oluşturma.
4. Her kontrol turunda ve her görev tamamladığında "outbox/heartbeat.txt"
   dosyasına o anki zamanı yaz (üzerine yazarak). Bu, sistemin senin bağlı
   olduğunu anlamasını sağlar.
5. inbox klasörünü sürekli izlemeye devam et; yeni görev geldiğinde işle.
6. inbox'taki görev dosyalarını silme veya taşıma; onları sistem arşivler.

Şimdi "outbox/heartbeat.txt" dosyasına zamanı yazarak başla ve inbox'u izle.

---

3. Köprü bağlandığında ana ekrandaki Antigravity durumu "hazır" olur.

## Notlar

- Yanıt gelmezse görev zaman aşımına uğrar ve koordinatör görevi
  Claude Code veya Codex'e yeniden atar.
- Bu köprü hiçbir oturum bilgisi okumaz veya iletmez; yalnızca görev
  metinleri ve yanıtlar dosya olarak taşınır.
`;
    fs.writeFileSync(path.join(this.bridgeDir, "INSTRUCTIONS.md"), text);
  }

  stop() {
    // Dosya köprüsünde öldürülecek süreç yok; bekleme döngüsü shouldStop ile kırılır.
  }
}
