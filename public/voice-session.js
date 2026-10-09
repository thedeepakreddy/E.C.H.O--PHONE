/* Foreground turn-taking. Audio is collected only while listening, never
   while Echo is answering. No silence recordings or background microphone. */
(() => {
  class Segmenter {
    constructor(rate, { silence = 1.4, minimum = .25, maximum = 55, threshold = null } = {}) {
      Object.assign(this, { rate, silence, minimum, maximum, threshold });
      this.noiseFloor = .001;
      this.reset();
    }
    reset() { this.chunks = []; this.pre = []; this.voiced = 0; this.quiet = 0; this.duration = 0; this.peak = 0; }
    push(samples) {
      const frame = new Float32Array(samples), seconds = frame.length / this.rate;
      const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
      // A fixed .014 cutoff missed low-gain phone microphones. Learn the
      // quiet level, with a small absolute floor to reject digital silence.
      // After speech starts, also recognise a drop relative to its volume.
      const cutoff = this.threshold ?? Math.max(.0025, this.noiseFloor * 2.2, Math.min(.02, this.peak * .18));
      const speech = rms >= cutoff;
      if (speech) this.peak = Math.max(this.peak, rms);
      else this.noiseFloor += (rms - this.noiseFloor) * (1 - Math.exp(-seconds / (rms < this.noiseFloor ? .2 : 2)));
      if (!this.chunks.length && !speech) {
        this.pre.push(frame);
        // Preserve the first syllable without keeping an unbounded silence buffer.
        while (this.pre.length > 1 && this.pre.reduce((n, x) => n + x.length, 0) > this.rate * .3) this.pre.shift();
        return null;
      }
      if (!this.chunks.length) { this.chunks = this.pre; this.pre = []; }
      this.chunks.push(frame); this.duration += seconds;
      if (speech) { this.voiced += seconds; this.quiet = 0; } else this.quiet += seconds;
      if (this.quiet < this.silence && this.duration < this.maximum) return null;
      const result = this.voiced >= this.minimum ? this.chunks : null;
      this.reset();
      return result;
    }
  }

  class Session {
    constructor({ acquire, onTurn, onState, onError, frameTimeoutMs = 5000 }) {
      Object.assign(this, { acquire, onTurn, onState, onError, frameTimeoutMs });
      this.state = "off"; this.generation = 0; this.mic = null;
    }
    get active() { return this.state !== "off"; }
    phase(state) { this.state = state; this.onState?.(state); }
    async start() {
      if (this.active) return;
      const generation = ++this.generation;
      this.phase("starting");
      try {
        const mic = await this.acquire(
          (samples) => { if (generation === this.generation) this.frame(samples); },
          (error) => { if (generation === this.generation) this.fail(error); },
        );
        if (generation !== this.generation) { mic.close(); return; }
        this.mic = mic; this.segmenter = new Segmenter(mic.rate); this.cooldown = 0;
        this.phase("listening");
        // A running AudioContext can still produce no capture callbacks on
        // an interrupted phone audio route. Don't leave a dead mic listening.
        this.frameTimer = setTimeout(() => {
          if (generation === this.generation) this.fail(new Error("The microphone isn't delivering audio. Check microphone access, disconnect Bluetooth if needed, then tap Listen again."));
        }, this.frameTimeoutMs);
      } catch (error) { if (generation === this.generation) this.fail(error); }
    }
    stop() {
      ++this.generation;
      clearTimeout(this.frameTimer); this.frameTimer = null;
      this.mic?.close(); this.mic = null; this.segmenter?.reset();
      this.phase("off");
    }
    fail(error) { this.stop(); this.onError?.(error); }
    frame(samples) {
      if (this.state !== "listening" || !this.mic) return;
      if (!samples.length) return;
      clearTimeout(this.frameTimer); this.frameTimer = null;
      if (this.cooldown > 0) { this.cooldown -= samples.length / this.mic.rate; return; }
      const chunks = this.segmenter.push(samples);
      if (!chunks) return;
      const generation = this.generation;
      const current = () => generation === this.generation;
      this.phase("thinking");
      Promise.resolve().then(() => current() && this.onTurn(chunks, this.mic.rate, current)).then((success) => {
        if (!current()) return;
        if (!success) { this.stop(); return; }
        this.segmenter.reset(); this.cooldown = .35;
        this.phase("listening");
      }).catch((error) => { if (current()) this.fail(error); });
    }
  }
  globalThis.EchoVoice = { Segmenter, Session };
})();
