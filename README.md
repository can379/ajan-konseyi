# Ajan Konseyi

Bilgisayarınızda kurulu ve **abonelik oturumlarıyla** giriş yapılmış yapay zekâ
araçlarının (Claude Code, Codex, Antigravity) ortaklaşa çalıştığı yerel bir
çoklu yapay zekâ iş birliği sistemi.

**Hiçbir ücretli geliştirici API'si kullanılmaz.** Sistem, araçların kendi
CLI/uygulama oturumlarını çağırır; API anahtarı istemez, saklamaz ve alt
süreçlere geçen ortamdan `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`GEMINI_API_KEY` değişkenlerini bilerek temizler. Oturum açma bilgileri
okunmaz ve hiçbir yere gönderilmez.

## Gereksinimler

- Node.js 18+ (harici npm paketi gerekmez, sıfır bağımlılık)
- `claude` CLI kurulu ve abonelikle giriş yapılmış (`claude` çalıştırıp bir kez giriş yapın)
- `codex` CLI kurulu ve ChatGPT hesabıyla giriş yapılmış (`codex login`)
- (İsteğe bağlı) Antigravity masaüstü uygulaması — aşağıdaki köprü kurulumuna bakın
- Kod modu için: hedef proje bir **git deposu** olmalı

## Başlatma

```bash
node server.js
```

Ana ekran: **http://localhost:4780**

## Mimari

```
Kullanıcı → Web arayüzü (localhost:4780)
              │
        Orkestratör (Node)
              │
        Koordinatör ──── kendi ayrı Claude CLI oturumu (planlama, hakemlik, sentez)
              │
   ┌──────────┼──────────────┐
 claude     codex        antigravity
 (claude -p (codex exec  (dosya köprüsü:
  --resume)   resume)     inbox/outbox)
```

- **Kalıcı oturumlar:** Her ajanın CLI oturumu koşu boyunca sürdürülür
  (Claude: `--resume <session_id>`, Codex: `codex exec resume <thread_id>`).
  Böylece ajanlar önceki mesajlarını hatırlar; çıktılar birbirine karışmaz ve
  her mesajın hangi ajandan geldiği kayıt altındadır.
- **Ortak hafıza:** Her koşu `runs/<id>/` altında tutulur: `state.json`
  (görevler, kararlar, oylar, dosyalar, testler) ve `messages.jsonl`
  (ortak konuşma kaydı). Nihai rapor `report.md` olarak yazılır.
- **Sınırlı bağlam:** Ajanlara tüm geçmiş değil, koordinatörün seçtiği özet
  bağlam gönderilir.

## Çalışma akışı

1. **Planlama** — Koordinatör isteği analiz eder, modu belirler (gerekirse) ve
   alt görevleri ajanlara dağıtır.
2. **Dağıtım** — Alt görevler paralel yürütülür. Ulaşılamayan/başarısız ajanın
   görevi bir kez başka ajana devredilir.
3. **Çapraz inceleme** — Her ajan diğerlerinin çıktısını eleştirel değerlendirir.
4. **Tartışma** — Koordinatör gerçek bir görüş ayrılığı saptarsa tartışma turu
   açar (tur sınırı kullanıcı ayarıdır; sonsuz tartışma engellenir).
5. **Hakemli oylama** — Tur sınırı dolduğunda ajanlardan gerekçeli oy istenir;
   kararın nedeni kullanıcıya gösterilir.
6. **Kod bütünleştirme** (kod modunda) — diff'ler toplanır, birleştirme planı
   çıkarılır, **kullanıcı onayıyla** birleştirilir, çakışmalar asla otomatik
   birleştirilmez.
7. **Test** — Test komutu yalnızca kullanıcı onayıyla çalıştırılır.
8. **Sentez** — Koordinatör nihai kararı ve markdown raporu üretir.

## Modlar

| Mod | Açıklama |
|---|---|
| Otomatik | Koordinatör görevin türüne göre modu seçer |
| Ortak tartışma | Üç ajan aynı konuda görüş bildirir, birbirini değerlendirir, uzlaşır |
| Görev paylaşımı | Büyük görev alt parçalara bölünür (dağılım sabit değildir, koordinatör karar verir) |
| Kod geliştirme | Ajanlar **ayrı git dalları + worktree'lerde** çalışır; aynı dosyanın eşzamanlı değişimi yapısal olarak engellenir |

## Antigravity köprüsü

Antigravity'nin başsız (headless) bir CLI'ı yoktur; bu yüzden dosya köprüsü
kullanılır:

1. Antigravity'yi açın, `bridge/antigravity/` klasörünü çalışma alanı yapın.
2. `bridge/antigravity/INSTRUCTIONS.md` içindeki talimatı Antigravity'deki
   ajana yapıştırın.
3. Ajan `inbox/` klasörünü izler, görevleri yapar, yanıtı `outbox/` klasörüne
   yazar ve `heartbeat.txt` günceller. Kalp atışı görüldüğünde ana ekranda
   Antigravity "hazır" görünür.

Köprü bağlı değilse koordinatör görevleri otomatik olarak Claude ve Codex
arasında dağıtır ve bunu ortak kayda not eder.

## Güvenlik kuralları (uygulamada)

- Birleştirme (merge) ve test komutu çalıştırma **onay kuyruğuna** düşer;
  kullanıcı arayüzden onaylamadan yapılmaz.
- Tartışma/inceleme görevlerinde ajanlar salt-okunur çalışır
  (Claude: `Bash,Edit,Write` araçları kapalı; Codex: `--sandbox read-only`).
- Kod modunda bile ajanlar yalnız kendi worktree'lerine yazar
  (Codex: `--sandbox workspace-write`, Claude: `acceptEdits`).
- Çakışan birleştirmeler otomatik yapılmaz; çakışan dosyalar raporlanır.
- Her mesaj/işlem hangi ajandan geldiği bilgisiyle `messages.jsonl`'e yazılır.
- Tur ve zaman sınırları: tartışma tur sınırı ayarlanabilir (1–4), her CLI
  çağrısının zaman aşımı vardır (15 dk; köprü 12 dk).
- API anahtarları ve oturum bilgileri okunmaz, saklanmaz, iletilmez.

## Arayüz

Çalışma alanı ortada ve ferahtır; her şey katlanabilir panellere taşınmıştır:

- **Sol kenar çubuğu** (☰ ile açılıp kapanır): Yeni Görev, **Projeler**
  (proje dizini ekleme/seçme — koşular projeye bağlanır ve koordinatör
  önceki koşuların raporlarını görerek **kaldığı yerden devam eder**),
  Geçmiş (koşu listesi), **Ajanlar** (her ajan için aç/kapa anahtarı,
  **model seçimi** ve **rol atama**: mimar / uygulayıcı / denetçi /
  araştırmacı / otomatik).
- **Orta**: ortak konuşma akışı ve alttaki kompozer — mod seçimi
  (Otomatik/Tartışma/Paylaşım/Kod), hedef seçimi (Konsey'e yeni görev veya
  tek bir ajana doğrudan mesaj), Gelişmiş bölümünde test komutu ve tur sınırı.
- **Sağ detay paneli** (▤): Görevler, Çıktılar, Kararlar & Oylar, Dosyalar,
  Testler, Rapor sekmeleri.
- **Onay bekleyen işlemler** sağ altta bildirim kartı olarak belirir.

Model seçimi CLI'lara `--model` / `-m` bayrağıyla iletilir (abonelik
kapsamındaki modeller); Antigravity'nin modeli uygulamanın içinden seçilir.
Ayarlar `config.json` dosyasında saklanır.

Görev henüz başlamamışken dağılımı değiştirmek için:
`POST /api/runs/<runId>/tasks/<taskId>/reassign {"assignee":"codex"}`

## Sınırlamalar (v1)

- Antigravity entegrasyonu köprü tabanlıdır; Antigravity tarafında ajanın
  klasör izleme talimatına uyması gerekir.
- Kod modunda Claude/Codex çalışır; Antigravity kod görevlerinde
  danışman/inceleyici rolü alır (kendi worktree'si yoktur).
- Koordinatör beyni Claude Code oturumudur; Claude aboneliğinin kotasını
  kullanır.
