class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.samples.push(...channel);
      if (this.samples.length >= 2048) {
        const samples = new Float32Array(this.samples);
        this.samples = [];
        this.port.postMessage(samples, [samples.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
