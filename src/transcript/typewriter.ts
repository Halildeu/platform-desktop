/**
 * Daktilo akıtma (gitops#3419 saha raporu-3): partial'lar ağdan 0.5-1.5s
 * aralıklarla 2-4 kelimelik paketler halinde gelir; rakip arayüzlerin
 * "harf harf yazıyor" hissi bir RENDER tekniğidir — hedef metin bir anda
 * basılmaz, görünen metin hedefi küçük adımlarla kovalar, birikim artarsa
 * hızlanıp yetişir. Bu modül o kovalamanın saf durum fonksiyonudur.
 */

/** Birikime göre adım bütçesi: yetişme hızı konuşmacıyı asla geride bırakmaz. */
export function typewriterBudget(backlogChars: number): number {
  if (backlogChars > 96) {
    return 12;
  }
  if (backlogChars > 48) {
    return 6;
  }
  if (backlogChars > 16) {
    return 3;
  }
  return 1;
}

/**
 * Görünen metni hedefe bir adım yaklaştırır.
 *
 * - Hedef, görüneni önek olarak taşıyorsa ileri doğru `budget` karakter yazar.
 * - Partial revize olduysa (ortak önek kısaldıysa) ANINDA ortak öneke döner —
 *   düzeltme beklemez, yanlış kelime ekranda oyalanmaz; sonraki adımlar yeni
 *   kuyruğu yazmaya devam eder.
 * - Hedef boşsa (final kuyruğu yuttu) görünen de anında boşalır.
 */
export function advanceTypewriter(displayed: string, target: string, budget: number): string {
  if (displayed === target) {
    return displayed;
  }
  if (target.length === 0) {
    return '';
  }
  const limit = Math.min(displayed.length, target.length);
  let common = 0;
  while (common < limit && displayed.charCodeAt(common) === target.charCodeAt(common)) {
    common += 1;
  }
  if (common < displayed.length) {
    return target.slice(0, common);
  }
  return target.slice(0, Math.min(target.length, displayed.length + Math.max(1, budget)));
}
