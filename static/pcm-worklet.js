class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = 1024;
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    let i = 0;
    while (i < channel.length) {
      const space = this.frameSize - this.offset;
      const take = Math.min(space, channel.length - i);
      this.buffer.set(channel.subarray(i, i + take), this.offset);
      this.offset += take;
      i += take;
      if (this.offset === this.frameSize) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(this.frameSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
