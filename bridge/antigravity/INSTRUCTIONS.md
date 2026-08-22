# Antigravity Köprü Talimatı

Antigravity'nin başsız (headless) bir komut satırı arayüzü bulunmadığından,
bu sistem Antigravity ile bir dosya köprüsü üzerinden konuşur.

## Kurulum (her Antigravity oturumunda bir kez)

1. Antigravity'yi açın ve şu klasörü çalışma alanı olarak ekleyin:
   /Users/selim/Desktop/ajan/bridge/antigravity

2. Antigravity'deki ajana aşağıdaki talimatı aynen yapıştırın:

---

Sen bir çoklu yapay zekâ konseyinin üyesisin. Görevin şu klasörü izlemek:
/Users/selim/Desktop/ajan/bridge/antigravity

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

## Kalıcı bağlantı ipucu (önerilir)

Sohbet ajanının izleme döngüsü, sohbet turu bitince durur. Bağlantının
kalıcı olması için Antigravity'nin **Scheduled Tasks** özelliğini kullanın:
"Her 5 dakikada bir /Users/selim/Desktop/ajan/bridge/antigravity/inbox klasörünü kontrol et; yeni .md görevlerini
işle, yanıtları outbox'a yaz ve outbox/heartbeat.txt'yi güncelle" şeklinde
zamanlanmış bir görev oluşturun. Böylece köprü sürekli canlı kalır.
