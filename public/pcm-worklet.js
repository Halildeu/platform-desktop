/**
 * PCM capture worklet (#2) — AudioWorklet global scope (vanilla JS).
 *
 * Her render quantum'unda (128 örnek) mono Float32 frame'i main thread'e
 * (renderer) postMessage ile yollar. PCM16'ya çevirme + resample renderer'da
 * (pcm-encode.ts) yapılır — worklet sade tutulur.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // copy: frame buffer'ı worklet yeniden kullanır
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
