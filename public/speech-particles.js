/* Audio uses natural sentences; particle captions follow words independently. */
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

  // Bound long sentences as well: some mobile engines stall on long utterances.
  // These audio chunks are independent of the small canvas caption phrases.
  function sentences(text) {
    const result = [];
    for (const sentence of String(text).trim().replace(/\s+/gu, " ").match(/.+?(?:[.!?]["'’”\])]*(?=\s|$)|$)/gu) || []) {
      let line = "";
      for (const word of sentence.trim().split(" ")) {
        if (line && line.length + word.length + 1 > 240) { result.push(line); line = ""; }
        line += (line ? " " : "") + word;
      }
      if (line) result.push(line);
    }
    return result;
  }

  class Player {
    constructor({ synthesis, utterance, onStart, onPhrase, onWord, onEnd, timeout = 120000, wordMs = 350 }) {
      Object.assign(this, { synthesis, utterance, onStart, onPhrase, onWord, onEnd, timeout, wordMs });
      this.current = null;
    }
    cancel() {
      if (this.current) this.current.finish(false);
      else this.synthesis?.cancel();
    }
    play(text, voice) {
      this.cancel();
      const lines = sentences(text), full = lines.join(" ");
      if (!lines.length || !this.synthesis) return Promise.resolve(false);
      const words = full.match(/\S+/gu), visuals = [];
      for (const phrase of phrases(full)) {
        const group = phrase.split(" ");
        group.forEach((_, i) => visuals.push(group.slice(0, i + 1).join(" ")));
      }
      return new Promise((resolve) => {
        const run = { ended: false, utterances: [], timer: null, wordTimer: null, active: -1, word: -1, paused: false };
        this.current = run;
        const valid = () => this.current === run && !run.ended;
        const show = (index) => {
          if (!valid() || index < 0 || index >= words.length || index === run.word) return;
          run.word = index;
          this.onWord?.(words[index], words.slice(0, index + 1).join(" "), index);
          this.onPhrase?.(visuals[index]);
        };
        run.finish = (completed) => {
          if (run.ended) return;
          run.ended = true; clearTimeout(run.timer); clearTimeout(run.wordTimer);
          if (this.current === run) {
            this.current = null;
            if (!completed) this.synthesis.cancel();
            try { this.onEnd?.(completed); } finally { resolve(completed); }
          } else resolve(completed);
        };
        // Watch for a stalled engine, rather than cutting off a healthy long reply.
        const armTimeout = () => {
          clearTimeout(run.timer);
          run.timer = setTimeout(() => run.finish(false), this.timeout);
        };
        try {
          let offset = 0;
          run.utterances = lines.map((line, chunk) => {
            const tokens = [...line.matchAll(/\S+/gu)], start = offset;
            offset += tokens.length;
            const ut = this.utterance(line); ut.voice = voice || null;
            let local = -1, boundaries = false;
            const advance = (index) => {
              if (!valid() || run.active !== chunk) return;
              // Report omitted words too if the engine coalesces boundaries.
              if (index > local) for (let i = local + 1; i <= index; i++) show(start + i);
              else show(start + index); // real timing can correct an estimated caption
              local = index;
            };
            const schedule = () => {
              clearTimeout(run.wordTimer);
              if (!valid() || run.active !== chunk || run.paused || local >= tokens.length - 1) return;
              const word = tokens[Math.max(0, local)][0];
              const delay = boundaries ? Math.max(900, this.wordMs * 2) : this.wordMs * Math.min(1.8, Math.max(.65, word.length / 5)) + (/[.,!?;:]$/u.test(word) ? this.wordMs * .5 : 0);
              run.wordTimer = setTimeout(() => { advance(local + 1); schedule(); }, delay);
            };
            ut.onstart = () => {
              if (!valid() || chunk < run.active) return;
              run.active = chunk; run.paused = false; armTimeout(); advance(0); schedule();
            };
            ut.onboundary = (event) => {
              if (!valid() || chunk < run.active || event?.name === "sentence" || !Number.isFinite(event?.charIndex)) return;
              if (event.charIndex < 0 || event.charIndex >= line.length) return;
              // charIndex is a UTF-16 offset, matching RegExp match.index.
              run.active = chunk;
              const index = tokens.findLastIndex((token) => token.index <= event.charIndex);
              boundaries = true; armTimeout(); advance(Math.max(0, index)); schedule();
            };
            ut.onpause = () => { if (valid() && run.active === chunk) { run.paused = true; clearTimeout(run.wordTimer); } };
            ut.onresume = () => { if (valid() && run.active === chunk) { run.paused = false; armTimeout(); schedule(); } };
            ut.onend = () => {
              if (!valid() || chunk < run.active) return;
              run.active = chunk; clearTimeout(run.wordTimer); advance(tokens.length - 1);
              if (chunk === lines.length - 1) run.finish(true); else armTimeout();
            };
            ut.onerror = () => { if (valid() && chunk >= run.active) run.finish(false); };
            return ut;
          });
          this.onStart?.(full);
          armTimeout();
          for (const ut of run.utterances) { if (run.ended) break; this.synthesis.speak(ut); }
        } catch { run.finish(false); }
      });
    }
  }
  globalThis.EchoSpeech = { phrases, sentences, Player };
})();
