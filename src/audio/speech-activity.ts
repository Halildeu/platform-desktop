/**
 * Konuşma etkinliği sinyali (platform-desktop#144, gitops#3837).
 *
 * Soru: "Son 10 saniyede biri konuşuyor mu?" Motorun metin üretip üretmediğinden
 * bağımsız, yalnız mikrofondan ölçülür. Gecikme göstergesi bunu, motor sustuğunda
 * sessizliği gerçek bir takılmadan ayırmak için kullanır; kapsam göstergesi de
 * aynı sinyali kullanacak (#146 / gitops#3837), bu yüzden mantık tek yerde durur.
 *
 * Neden anlık ses düzeyi değil de oran: 24 Eylül kalibrasyonunda (tek mikrofon,
 * 20 sn, 100 ms pencere) kesintisiz konuşma sırasında bile pencerelerin %10'u
 * 0.0002'nin altında kaldı; kelime aralarındaki boşluklar buna sebep. Tek pencereye
 * bakan bir kural konuşmanın ortasında sürekli durum değiştirir. Oran ise temiz
 * ayırdı:
 *
 *   sessiz oda            %1   eşiğin üstünde
 *   arka planda konuşma   %4
 *   kullanıcı konuşuyor  %87
 *
 * Sınır: ölçüm tek makinede ve gürültü bastırmalı bir mikrofonla yapıldı. Oran
 * tanı çıktısına yazılır; başka donanımdaki gerçek değerler gitops#3837'de
 * toplanır ve sabitler ölçümle güncellenir.
 */

/** Ses düzeyinin ölçüldüğü pencere; kalibrasyonla aynı. */
export const SPEECH_ACTIVITY_FRAME_MS = 100;
/** Oranın hesaplandığı geriye dönük süre. */
export const SPEECH_ACTIVITY_WINDOW_MS = 10_000;
/** Bir pencerenin "ses var" sayılması için RMS eşiği (kalibrasyonla aynı değer). */
export const SPEECH_ACTIVITY_RMS_THRESHOLD = 0.0008;
/**
 * "Konuşma var" demek için gereken en düşük oran. Ölçülen arka plan (%4) ile
 * konuşma (%87) arasında geniş güvenlik payı bırakılarak seçildi.
 */
export const SPEECH_ACTIVITY_MIN_RATIO = 0.4;

const FRAMES_PER_WINDOW = SPEECH_ACTIVITY_WINDOW_MS / SPEECH_ACTIVITY_FRAME_MS;

export interface SpeechActivitySnapshot {
  /** Son 10 sn'de eşiğin üstündeki pencere oranı; pencere dolmadıysa null. */
  ratio: number | null;
  /** Oranın hesaplandığı pencere sayısı. */
  frameCount: number;
}

/**
 * Yakalanan her ses parçasını alır, 100 ms'lik pencerelere böler ve son 10 sn'nin
 * oranını tutar. Parça boyutu serbesttir (AudioWorklet 128 örnek gönderir).
 */
export class SpeechActivityMeter {
  private readonly samplesPerFrame: number;
  private frameSumSquares = 0;
  private frameSampleCount = 0;
  /** Tamamlanan pencerelerin "ses var" bayrakları, en eskiden en yeniye. */
  private readonly frames: boolean[] = [];
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
      return { ratio: null, frameCount: this.frames.length };
    }
    return { ratio: this.activeFrames / this.frames.length, frameCount: this.frames.length };
  }

  reset(): void {
    this.frameSumSquares = 0;
    this.frameSampleCount = 0;
    this.frames.length = 0;
    this.activeFrames = 0;
  }

  private closeFrame(): void {
    const rms = Math.sqrt(this.frameSumSquares / this.frameSampleCount);
    const active = rms >= SPEECH_ACTIVITY_RMS_THRESHOLD;
    this.frames.push(active);
    if (active) {
      this.activeFrames += 1;
    }
    if (this.frames.length > FRAMES_PER_WINDOW) {
      const dropped = this.frames.shift();
      if (dropped) {
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
