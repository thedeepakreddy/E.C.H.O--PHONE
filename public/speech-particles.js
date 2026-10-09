/* Every spoken phrase owns its visual: no guessed words-per-second clock. */
(() => {
  function phrases(text) {
    const words = String(text).match(/\S+/gu) || [], result = [];
    let line = [];
    const flush = () => { if (line.length) result.push(line.join(" ")); line = []; };
    for (const word of words) {
      if (line.length && (line.length >= 4 || Array.from([...line, word].join(" ")).length > 32)) flush();
      line.push(word);
      if (/[.!?;:]["'’”\])]*$/u.test(word)) flush();
    }
    flush();
    return result;
  }

  class Player {
    constructor({ synthesis, utterance, onStart, onPhrase, onEnd, timeout = 120000 }) {
      Object.assign(this, { synthesis, utterance, onStart, onPhrase, onEnd, timeout });
      this.current = null;
    }
    cancel() {
      if (this.current) this.current.finish(false);
      else this.synthesis?.cancel();
    }
    play(text, voice) {
      this.cancel();
      const lines = phrases(text);
      if (!lines.length || !this.synthesis) return Promise.resolve(false);
      return new Promise((resolve) => {
        const run = { index: -1, ended: false, utterances: [], timer: null };
        this.current = run;
        const show = (index) => {
          if (this.current !== run || run.ended || index <= run.index || index >= lines.length) return;
          run.index = index; this.onPhrase?.(lines[index]);
        };
        run.finish = (completed) => {
          if (run.ended) return;
          run.ended = true; clearTimeout(run.timer);
          if (this.current === run) {
            this.current = null;
            if (!completed) this.synthesis.cancel();
            try { this.onEnd?.(completed); } finally { resolve(completed); }
          }
          else resolve(completed);
        };
        try {
          run.utterances = lines.map((line, index) => {
            const ut = this.utterance(line); ut.voice = voice || null;
            ut.onstart = () => show(index);
            ut.onboundary = () => show(index);
            ut.onend = () => {
              if (this.current !== run || run.ended) return;
              show(index);
              if (index === lines.length - 1) run.finish(true);
              // End is also a precise transition on platforms lacking onstart.
              else show(index + 1);
            };
            ut.onerror = () => { if (this.current === run) run.finish(false); };
            return ut;
          });
          this.onStart?.(String(text));
          show(0);
          run.timer = setTimeout(() => run.finish(false), this.timeout);
          for (const ut of run.utterances) {
            if (run.ended) break;
            this.synthesis.speak(ut);
          }
        } catch { run.finish(false); }
      });
    }
  }
  globalThis.EchoSpeech = { phrases, Player };
})();
