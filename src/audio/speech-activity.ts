/**
 * Konuşma etkinliği sinyali (platform-desktop#144, gitops#3837).
 *
 * Soru: "Son 10 saniyede biri konuşuyor mu?" Motorun metin üretip üretmediğinden
 * bağımsız, yalnız mikrofondan ölçülür. Gecikme göstergesi bunu, motor sustuğunda
 * sessizliği gerçek bir takılmadan ayırmak için kullanır; kapsam göstergesi de
 * aynı sinyali kullanacak (#146 / gitops#3837), bu yüzden mantık tek yerde durur.
 *
 * Neden anlık ses düzeyi değil de oran: kesintisiz konuşma sırasında bile
 * pencerelerin %10'u kelime aralarına denk gelip sessiz ölçülüyor. Tek pencereye
 * bakan bir kural konuşmanın ortasında sürekli durum değiştirir; oran bakmak bunu
 * sönümler.
 *
 * Eşik UYGULAMANIN KENDİ SİNYALİNDEN ölçüldü (25 Eylül, attended, tanı çıktısı,
 * 100 ms pencere RMS dağılımı):
 *
 *                              %10      ortanca   %90
 *   sessizlik                  0.0009   0.0011    0.0037
 *   kullanıcı konuşuyor        0.0035   0.0714    0.1729
 *   sistem sesi (görüşmedeki)  0.0039   0.1046    0.2854
 *
 * İlk kalibrasyon (24 Eylül) ham mikrofondan yapılmış ve 0.0008 önermişti. Uygulama
 * ise getUserMedia varsayılanlarıyla (otomatik kazanç, gürültü bastırma) işlenmiş
 * sesi ölçtüğü için sessizlik ~0.001'e çıkıyor; 0.0008 ile sessizlikte oran 1.00
 * oldu ve "Metin gelmiyor" yanlış uyarısı çıktı. Ham mikrofon ölçümü uygulamaya
 * taşınamaz.
 *
 * 0.01 seçimi dağılımın bilinmeyen kısmında en kötü durumda da doğru karar verir:
 * sessizliğin %90'ı eşiğin altında olduğu için oran en fazla %10; konuşmada eşik
 * %10'luk dilim ile ortanca arasında olduğu için oran en az %50 — ikisi de %40
 * sınırının doğru tarafında.
 *
 * "Mikrofon + sistem sesi" kaydında hoparlörden çalan ses mikrofona değil doğrudan
 * sisteme ait kanaldan girer ve tam seviyede konuşma sayılır. Bu doğrudur (görüşmede
 * konuşan biri için metin beklenir), ama "odada uzaktan konuşan biri" durumu bu
 * düzenekle ölçülemedi.
 *
 * Sınır: tek makine, tek mikrofon. Oran ve dağılım tanı çıktısına yazılır; başka
 * donanımdaki değerler gitops#3837'de toplanır ve sabitler ölçümle güncellenir.
 */

/** Ses düzeyinin ölçüldüğü pencere; kalibrasyonla aynı. */
export const SPEECH_ACTIVITY_FRAME_MS = 100;
/** Oranın hesaplandığı geriye dönük süre. */
export const SPEECH_ACTIVITY_WINDOW_MS = 10_000;
/**
 * Bir pencerenin "ses var" sayılması için RMS eşiği. Uygulamanın işlenmiş sinyalinde
 * sessizliğin %90'ı (0.0037) ile konuşma ortancası (0.0714) arasında; yukarıdaki
 * tabloya bakın.
 */
export const SPEECH_ACTIVITY_RMS_THRESHOLD = 0.01;
/** "Konuşma var" demek için gereken en düşük oran. */
export const SPEECH_ACTIVITY_MIN_RATIO = 0.4;

const FRAMES_PER_WINDOW = SPEECH_ACTIVITY_WINDOW_MS / SPEECH_ACTIVITY_FRAME_MS;

export interface SpeechActivityRmsPercentiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface SpeechActivitySnapshot {
  /** Son 10 sn'de eşiğin üstündeki pencere oranı; pencere dolmadıysa null. */
  ratio: number | null;
  /** Oranın hesaplandığı pencere sayısı. */
  frameCount: number;
  /**
   * Son 10 sn'deki 100 ms pencere RMS dağılımı; pencere dolmadıysa null.
   *
   * Eşiği uygulamanın KENDİ sinyaline göre ölçmek için tanı çıktısına yazılır.
   * 25 Eylül attended testi, ham mikrofonla yapılan kalibrasyonun uygulamaya
   * taşınamadığını gösterdi: tarayıcı ses işlemesinden sonra sessizlik ~0.001
   * seviyesine çıkıyor (eşiğin üstü), konuşma ~0.1.
   */
  rms: SpeechActivityRmsPercentiles | null;
}

/**
 * Yakalanan her ses parçasını alır, 100 ms'lik pencerelere böler ve son 10 sn'nin
 * oranını tutar. Parça boyutu serbesttir (AudioWorklet 128 örnek gönderir).
 */
export class SpeechActivityMeter {
  private readonly samplesPerFrame: number;
  private frameSumSquares = 0;
  private frameSampleCount = 0;
  /** Tamamlanan pencerelerin RMS değerleri, en eskiden en yeniye. */
  private readonly frames: number[] = [];
  private activeFrames = 0;

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('speech activity sampleRate must be positive');
    }
    this.samplesPerFrame = Math.max(1, Math.round((sampleRate * SPEECH_ACTIVITY_FRAME_MS) / 1000));
  }

  push(samples: Float32Array): void {
    for (const sample of samples) {
      this.frameSumSquares += sample * sample;
      this.frameSampleCount += 1;
      if (this.frameSampleCount === this.samplesPerFrame) {
        this.closeFrame();
      }
    }
  }

  snapshot(): SpeechActivitySnapshot {
    if (this.frames.length < FRAMES_PER_WINDOW) {
      return { ratio: null, frameCount: this.frames.length, rms: null };
    }
    const sorted = [...this.frames].sort((a, b) => a - b);
    const at = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    return {
      ratio: this.activeFrames / this.frames.length,
      frameCount: this.frames.length,
      rms: { p10: at(0.1), p50: at(0.5), p90: at(0.9) },
    };
  }

  reset(): void {
    this.frameSumSquares = 0;
    this.frameSampleCount = 0;
    this.frames.length = 0;
    this.activeFrames = 0;
  }

  private closeFrame(): void {
    const rms = Math.sqrt(this.frameSumSquares / this.frameSampleCount);
    this.frames.push(rms);
    if (rms >= SPEECH_ACTIVITY_RMS_THRESHOLD) {
      this.activeFrames += 1;
    }
    if (this.frames.length > FRAMES_PER_WINDOW) {
      const dropped = this.frames.shift();
      if (dropped !== undefined && dropped >= SPEECH_ACTIVITY_RMS_THRESHOLD) {
        this.activeFrames -= 1;
      }
    }
    this.frameSumSquares = 0;
    this.frameSampleCount = 0;
  }
}

/** Oranın "biri konuşuyor" demeye yetip yetmediği. Pencere dolmadıysa false. */
export function isSpeechActive(ratio: number | null): boolean {
  return ratio !== null && ratio >= SPEECH_ACTIVITY_MIN_RATIO;
}
