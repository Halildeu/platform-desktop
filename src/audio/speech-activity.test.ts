import { describe, expect, it } from 'vitest';

import { SPEECH_ACTIVITY_MIN_RATIO, SpeechActivityMeter, isSpeechActive } from './speech-activity';

const SAMPLE_RATE = 16_000;
const SAMPLES_PER_FRAME = SAMPLE_RATE / 10; // 100 ms

/** Sabit genlikli bir 100 ms pencere: RMS değeri genliğe eşittir. */
function frame(amplitude: number): Float32Array {
  return new Float32Array(SAMPLES_PER_FRAME).fill(amplitude);
}

/**
 * 100 pencere (10 sn) üretir; `activeCount` tanesi eşiğin üstünde, gerisi altında.
 * Etkin pencereler araya serpiştirilir, gerçek konuşmadaki gibi bloklar halinde değil.
 */
function feed(meter: SpeechActivityMeter, activeCount: number, total = 100): void {
  for (let i = 0; i < total; i += 1) {
    const active =
      Math.floor(((i + 1) * activeCount) / total) > Math.floor((i * activeCount) / total);
    meter.push(frame(active ? 0.0714 : 0.0011));
  }
}

// Etkin pencere: uygulamada ölçülen konuşma ortancası (0.0714); sessiz pencere:
// uygulamada ölçülen sessizlik ortancası (0.0011). 25 Eylül, attended.
describe('SpeechActivityMeter', () => {
  it('reports silence (%1 above threshold) as not speaking', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    feed(meter, 1);
    const { ratio } = meter.snapshot();
    expect(ratio).toBeCloseTo(0.01, 5);
    expect(isSpeechActive(ratio)).toBe(false);
  });

  it('reports background speech (%4 above threshold) as not speaking', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    feed(meter, 4);
    const { ratio } = meter.snapshot();
    expect(ratio).toBeCloseTo(0.04, 5);
    expect(isSpeechActive(ratio)).toBe(false);
  });

  it('reports continuous speech (%87 above threshold) as speaking', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    feed(meter, 87);
    const { ratio } = meter.snapshot();
    expect(ratio).toBeCloseTo(0.87, 5);
    expect(isSpeechActive(ratio)).toBe(true);
  });

  it('withholds a ratio until the 10 second window is full', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    feed(meter, 99, 99);
    expect(meter.snapshot()).toEqual({ ratio: null, frameCount: 99, rms: null });
    expect(isSpeechActive(meter.snapshot().ratio)).toBe(false);

    meter.push(frame(0.0714));
    expect(meter.snapshot().ratio).toBe(1);
  });

  it('forgets frames older than 10 seconds', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    feed(meter, 100); // 10 sn konuşma
    feed(meter, 0); // ardından 10 sn sessizlik
    expect(meter.snapshot().ratio).toBe(0);
  });

  it('assembles 100 ms frames from 128-sample worklet quanta', () => {
    // AudioWorklet her seferinde 128 örnek gönderir; pencere sınırı parça
    // sınırına denk gelmek zorunda değil.
    const meter = new SpeechActivityMeter(48_000);
    const quantum = new Float32Array(128).fill(0.0714);
    const totalSamples = 48_000 * 10; // 10 sn
    for (let sent = 0; sent < totalSamples; sent += quantum.length) {
      meter.push(quantum);
    }
    expect(meter.snapshot().ratio).toBe(1);
  });

  // 25 Eylül attended testi: eşik ham mikrofonda kalibre edilmişti, uygulamada
  // tarayıcı ses işlemesinden sonra sessizlik ~0.001'e çıktı. Dağılım tanıya
  // yazılır ki eşik uygulamanın kendi sinyalinden ölçülebilsin.
  it('reports the RMS distribution of the window for calibration', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    for (let i = 0; i < 100; i += 1) {
      meter.push(frame((i + 1) / 1000)); // 0.001 … 0.100
    }
    const { rms } = meter.snapshot();
    expect(rms?.p10).toBeCloseTo(0.01, 5);
    expect(rms?.p50).toBeCloseTo(0.05, 5);
    expect(rms?.p90).toBeCloseTo(0.09, 5);
  });

  // 25 Eylül attended: uygulamanın işlenmiş sinyalinde sessizlik ~0.001. İlk
  // eşik (0.0008) ile bu sessizlik oran 1.00 veriyor ve yanlış uyarı üretiyordu.
  it('treats the processed-signal silence floor as silence', () => {
    const meter = new SpeechActivityMeter(SAMPLE_RATE);
    for (let i = 0; i < 100; i += 1) {
      // Sessizliğin %90'lık dilimi 0.0037; en gürültülü anlar dahil.
      meter.push(frame(i % 10 === 0 ? 0.0037 : 0.0011));
    }
    expect(meter.snapshot().ratio).toBe(0);
    expect(isSpeechActive(meter.snapshot().ratio)).toBe(false);
  });

  it('keeps the decision boundary at the named constant', () => {
    expect(SPEECH_ACTIVITY_MIN_RATIO).toBe(0.4);
    expect(isSpeechActive(0.4)).toBe(true);
    expect(isSpeechActive(0.39)).toBe(false);
  });
});
