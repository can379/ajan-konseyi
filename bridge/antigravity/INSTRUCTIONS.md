# Antigravity entegrasyonu

Ajan Konseyi, Antigravity’yi yerel `agy` CLI üzerinden başsız biçimde çalıştırır.
Antigravity uygulamasına geçmek, sohbet penceresini açık tutmak veya her görevde
manuel onay vermek gerekmez.

## Gereksinimler

1. Antigravity’yi ve hesabınızın sağladığı `agy` CLI aracını kurun.
2. Terminalde `agy --version` komutunun çalıştığını doğrulayın.
3. Antigravity hesabınızın oturumunu kendi uygulaması/CLI akışıyla açın.

## Çalışma biçimi

- Her konsey konuşması kendi `conversation_id` değeriyle devam eder.
- `agy --output-format stream-json` üzerinden canlı yanıt alınır.
- Antigravity araştırma, görsel/medya, tarayıcı ve kullanıcı deneyimi görevlerine yönlendirilir.
- Kaynak kodu yazma ve değiştirme görevleri yalnız Claude veya Codex’e verilir.
- Antigravity yanıt veremezse görev güvenli biçimde uygun başka bir ajana aktarılır.
- GitHub, Gmail, Drive, Figma, Canva, Slack ve Vercel gibi hesap görevleri gerektiğinde ortak Codex bağlayıcı köprüsünden geçer; OAuth anahtarları kopyalanmaz.

`inbox`, `outbox` ve `done` klasörleri eski sürümlerle uyumluluk için tutulabilir,
ancak güncel doğal CLI mesajlaşmasında kullanılmaz.
