import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/speech-particles.js";
const { phrases, sentences, Player } = globalThis.EchoSpeech;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(options = {}) {
  const queued = [], shown = [], spoken = [], ended = [];
  let cancels = 0;
  const player = new Player({
    synthesis: { speak: (ut) => queued.push(ut), cancel: () => cancels++ },
    utterance: (text) => ({ text }), onPhrase: (text) => shown.push(text), onWord: (word, caption, index) => spoken.push({ word, caption, index }), onEnd: (done) => ended.push(done), ...options,
  });
  return { player, queued, shown, spoken, ended, cancels: () => cancels };
}

test("particle phrases and natural audio chunks preserve punctuation, Unicode and every word", () => {
  for (const text of [
    "Yes. I can help you with your plans today, and tomorrow too! Here is the final sentence.",
    "  Remember\n my appointment at 12:30.\tDon't forget the €12.50 bill. ",
    "Hello 👩🏽‍💻, Καλημέρα! Let's consider supercalifragilisticexpialidocious carefully.",
    Array.from({ length: 200 }, (_, i) => `word${i}`).join(" "),
  ]) {
    assert.equal(sentences(text).join(" "), text.trim().replace(/\s+/gu, " "));
    const result = phrases(text);
    assert.equal(result.join(" "), text.trim().replace(/\s+/gu, " "));
    for (const line of result) {
      assert.ok(line.split(" ").length <= 4);
      assert.ok(Array.from(line).length <= 32 || line.split(" ").length === 1);
    }
  }
  assert.deepEqual(sentences(" "), []);
  assert.deepEqual(phrases("  "), []);
});

test("voice speaks complete sentences while every boundary updates word captions through the last word", async () => {
  const f = fixture(), text = "Echo speaks this entire sentence with natural pacing. Every remaining word becomes particles including the last word.";
  const voice = { name: "Test voice" }, done = f.player.play(text, voice);
  assert.deepEqual(f.queued.map((u) => u.text), sentences(text));
  assert.equal(f.queued.length, 2); assert.equal(f.shown.length, 0, "nothing is captioned before speech starts");
  let index = 0;
  for (const ut of f.queued) {
    assert.equal(ut.voice, voice); ut.onstart();
    for (const word of ut.text.matchAll(/\S+/gu)) {
      ut.onboundary({ name: "word", charIndex: word.index });
      assert.equal(f.spoken.at(-1).word, word[0]);
      assert.equal(f.spoken.at(-1).index, index++);
      assert.equal(f.shown.at(-1).split(" ").at(-1), word[0]);
    }
    ut.onend();
  }
  assert.equal(await done, true);
  assert.deepEqual(f.spoken.map((w) => w.word), text.split(" "));
  assert.equal(f.spoken.at(-1).caption, text); assert.deepEqual(f.ended, [true]);
});

test("UTF-16 word offsets, duplicate and sentence events do not lose or repeat Unicode words", async () => {
  const f = fixture(), text = "Hello 👩🏽‍💻, Καλημέρα everyone today!", done = f.player.play(text), ut = f.queued[0];
  ut.onstart(); ut.onboundary({ name: "sentence", charIndex: 0 });
  for (const word of text.matchAll(/\S+/gu)) {
    ut.onboundary({ name: "word", charIndex: word.index });
    ut.onboundary({ name: "word", charIndex: word.index });
  }
  ut.onboundary({ charIndex: -1 }); ut.onboundary({ charIndex: 9999 }); ut.onboundary({});
  ut.onend(); assert.equal(await done, true);
  assert.deepEqual(f.spoken.map((w) => w.word), text.split(" "));
});

test("missing word events use caption-only pacing, pause correctly, and never split audio", async () => {
  const f = fixture({ wordMs: 8 }), text = "Echo keeps speaking normally while captions move along.", done = f.player.play(text), ut = f.queued[0];
  ut.onstart(); await wait(15);
  assert.ok(f.spoken.length > 1); assert.equal(f.queued.length, 1);
  ut.onpause(); const count = f.spoken.length; await wait(40); assert.equal(f.spoken.length, count);
  ut.onresume(); await wait(100); ut.onend();
  assert.equal(await done, true); assert.equal(f.spoken.at(-1).caption, text);
});

test("completion alone and coalesced boundaries preserve all caption words", async () => {
  const f = fixture(), text = "The whole sentence stays together. Final words are included.", done = f.player.play(text);
  f.queued[0].onboundary({ name: "word", charIndex: 10 });
  for (const ut of f.queued) ut.onend();
  assert.equal(await done, true); assert.deepEqual(f.spoken.map((w) => w.word), text.split(" "));
});

test("Stop and replacement cancel caption timers and ignore old callbacks", async () => {
  const f = fixture({ wordMs: 8 });
  const first = f.player.play("This is the old reply. It must not come back.");
  const old = [...f.queued]; old[0].onstart(); f.player.cancel(); assert.equal(await first, false);
  const second = f.player.play("Here is the new reply."); const before = [...f.shown];
  for (const ut of old) { ut.onstart(); ut.onboundary({ charIndex: 5 }); ut.onend(); ut.onerror(); ut.onresume(); }
  await wait(30); assert.deepEqual(f.shown, before); assert.deepEqual(f.ended, [false]);
  for (const ut of f.queued.slice(old.length)) { ut.onstart(); ut.onend(); }
  assert.equal(await second, true); assert.deepEqual(f.ended, [false, true]);
});

test("speech failures cancel the queue and caption timers and settle once", async () => {
  const f = fixture({ wordMs: 8 }), done = f.player.play("This has several words. An error should stop the remaining speech.");
  f.queued[0].onstart(); f.queued[0].onerror(); const before = [...f.shown];
  f.queued.at(-1).onend(); f.queued[0].onerror(); await wait(30);
  assert.equal(await done, false); assert.deepEqual(f.shown, before); assert.deepEqual(f.ended, [false]); assert.ok(f.cancels() >= 2);
  const timeout = fixture({ timeout: 5 });
  assert.equal(await timeout.player.play("Lost platform callback."), false);
  const unavailable = fixture({ synthesis: { speak() { throw new Error("Speech unavailable"); }, cancel() {} } });
  assert.equal(await unavailable.player.play("Platform failed to start."), false);
  assert.deepEqual(unavailable.ended, [false]);
});


test("a healthy reply can outlast the inactivity timeout without being cut off", async () => {
  const f = fixture({ timeout: 100 }), done = f.player.play("First complete sentence. Second complete sentence. Third complete sentence.");
  for (const ut of f.queued) { ut.onstart(); await wait(50); ut.onend(); }
  assert.equal(await done, true); assert.deepEqual(f.ended, [true]);
});
