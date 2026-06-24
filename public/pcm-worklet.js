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
    if (!input || !input[0] || !input[0].length) return true;

    if (input.length === 1) {
      this.port.postMessage(input[0].slice(0));
    } else {
      const ch0 = input[0];
      const mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        let sum = 0;
        for (let c = 0; c < input.length; c++) {
          sum += input[c][i];
        }
        mono[i] = sum / input.length;
      }
      this.port.postMessage(mono);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
