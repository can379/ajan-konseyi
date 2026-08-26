// Gozlemlenebilirlik — "bu sistem iyi calisiyor mu?" sorusunun sayisal cevabi.
//
// Konsey sorusu D'ye verilen cevap: tek bir kuzey yildizi metrigi olmali,
// yanina onu aciklayan birkac tane. Secilen kuzey yildizi:
//
//   kanitli_otonom_tamamlama = kanit sozlesmesini gecerek biten is
//                              / toplam yurutulmeye calisilan is
//
// NEDEN bu: "kac is yaptik" yaniltici — kanitsiz biten is yapilmis sayilmaz,
// belirsiz biten is ise BASARISIZ da sayilmaz. Bu oran ikisini de dogru
// tarafa koyar. 1.0'a yaklasmasi "arkama bakmadan birakabilirim" demektir;
// dusmesi once BELIRSIZ yiginini buyutur, oradan gorulur.
//
// Paydalarda "zeynep haric" dikkati: izlenen magaza sayisi 6'dir. Payda 7
// alinirsa yoklama sagligi alarmi KALICI korlesir (Uye 4'un uyarisi).

import { IS_DURUM } from "./opsJobs.js";

export const IZLENEN_MAGAZA = 6;   // 7 sunucu - zeynep

export function opsMetrikleri(isler = [], { izleyici = null, kesici = null, politika = null } = {}) {
  const liste = Array.isArray(isler) ? isler : [];
  const say = (d) => liste.filter((i) => i.durum === d).length;

  const bitti = say(IS_DURUM.TAMAM);
  const belirsiz = say(IS_DURUM.BELIRSIZ);
  const hata = say(IS_DURUM.KALICI_HATA);
  const onayBekleyen = say(IS_DURUM.KULLANICI_BEKLIYOR);
  const denenen = bitti + belirsiz + hata;

  // Kuzey yildizi. Denenen is yoksa oran YOK'tur — 0 degil. Sifir yazmak
  // "kotu calisiyor" izlenimi verir; oysa daha hic denenmemistir.
  const kuzeyYildizi = denenen ? bitti / denenen : null;

  const yoklananMagaza = izleyici?.sonTur?.length ?? (izleyici?.hesap ? 1 : 0);

  return {
    kuzeyYildizi: {
      ad: "Kanıtlı otonom tamamlama",
      deger: kuzeyYildizi,
      metin: kuzeyYildizi == null ? "henüz iş denenmedi" : `%${Math.round(kuzeyYildizi * 100)}`,
      pay: bitti, payda: denenen,
      aciklama: "Kanıt sözleşmesini geçerek biten iş / yürütülmeye çalışılan iş",
    },
    satirlar: [
      { ad: "Belirsiz yığını", deger: belirsiz, hedef: 0,
        uyari: belirsiz > 0,
        aciklama: "Sonucu okunamayan iş. Tekrar denenmez; elle uzlaştırılır." },
      { ad: "Onay bekleyen", deger: onayBekleyen, hedef: null,
        uyari: onayBekleyen > 5,
        aciklama: "Geri alınamaz adım için sizin onayınızı bekliyor." },
      { ad: "Kalıcı hata", deger: hata, hedef: 0, uyari: hata > 0,
        aciklama: "Kurtarma stratejisi işe yaramadı." },
      { ad: "Yoklanan mağaza", deger: `${yoklananMagaza}/${IZLENEN_MAGAZA}`,
        uyari: izleyici?.calisiyor && yoklananMagaza < IZLENEN_MAGAZA,
        aciklama: "zeynep hariç; payda 6. Eksikse o mağaza kör noktadır." },
      { ad: "Devresi kapalı mağaza",
        deger: (kesici?.hepsi?.() || []).filter((k) => k.kapali).length, hedef: 0,
        uyari: (kesici?.hepsi?.() || []).some((k) => k.kapali),
        aciklama: "Üst üste hata verdiği için otomatik durduruldu." },
      { ad: "Politikası doğrulanmış iş türü",
        deger: (politika?.durum?.().dogrulanan || []).length,
        aciklama: "Doğrulanmamış iş türünün faz kapısı açılamaz." },
    ],
  };
}
