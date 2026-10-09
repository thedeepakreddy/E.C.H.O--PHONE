import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/speech-particles.js";
const { phrases, Player } = globalThis.EchoSpeech;

function fixture(options = {}) {
  const queued = [], shown = [], ended = [];
  let cancels = 0;
  const player = new Player({
    synthesis: { speak: (ut) => queued.push(ut), cancel: () => cancels++ },
    utterance: (text) => ({ text }), onPhrase: (text) => shown.push(text), onEnd: (done) => ended.push(done), ...options,
  });
  return { player, queued, shown, ended, cancels: () => cancels };
}

test("particle phrases preserve every word, punctuation, Unicode and long names", () => {
  for (const text of [
    "Yes. I can help you with your plans today, and tomorrow too! Here is the final sentence.",
    "  Remember\n  my appointment at 12:30.\tDon't forget the €12.50 bill. ",
    "Hello 👩🏽‍💻, Καλημέρα! Let's consider supercalifragilisticexpialidocious carefully.",
    Array.from({ length: 200 }, (_, i) => `word${i}`).join(" "),
  ]) {
    const result = phrases(text);
    assert.equal(result.join(" "), text.trim().replace(/\s+/gu, " "));
    for (const line of result) {
      assert.ok(line.split(" ").length <= 4);
      assert.ok(Array.from(line).length <= 32 || line.split(" ").length === 1);
    }
  }
  assert.deepEqual(phrases("  "), []);
});

test("every queued phrase owns its particle words through the final spoken phrase", async () => {
  const f = fixture(), text = "Echo speaks the entire reply. Every remaining phrase becomes particles, including the last word.";
  const voice = { name: "Test voice" }, done = f.player.play(text, voice);
  let resolved = false; done.then(() => { resolved = true; });
  assert.equal(f.queued.map((ut) => ut.text).join(" "), text);
  for (let i = 0; i < f.queued.length; i++) {
    const ut = f.queued[i]; assert.equal(ut.voice, voice);
    ut.onstart(); ut.onboundary();
    assert.equal(f.shown.at(-1), ut.text);
    assert.equal(resolved, false);
    ut.onend();
  }
  assert.equal(await done, true);
  assert.deepEqual(f.shown, phrases(text)); assert.deepEqual(f.ended, [true]);
});

test("speech without word boundaries or start callbacks still advances on utterance completion", async () => {
  const f = fixture(), text = "We should still display every phrase when a browser only reports completion.";
  const done = f.player.play(text);
  for (const ut of f.queued) ut.onend();
  assert.equal(await done, true); assert.deepEqual(f.shown, phrases(text));
});

test("Stop and replacement ignore stale starts, ends and errors from old speech", async () => {
  const f = fixture();
  const first = f.player.play("This is the old reply. It must not come back.");
  const old = [...f.queued]; f.player.cancel(); assert.equal(await first, false);
  const second = f.player.play("Here is the new reply."); const before = [...f.shown];
  for (const ut of old) { ut.onstart(); ut.onboundary(); ut.onend(); ut.onerror(); }
  assert.deepEqual(f.shown, before); assert.deepEqual(f.ended, [false]);
  for (const ut of f.queued.slice(old.length)) { ut.onstart(); ut.onend(); }
  assert.equal(await second, true); assert.deepEqual(f.ended, [false, true]);
});

test("speech failures cancel the remaining queue and settle the session once", async () => {
  const f = fixture(), done = f.player.play("This has several phrases. An error should stop the remaining speech.");
  f.queued[0].onerror(); f.queued.at(-1).onend(); f.queued[0].onerror();
  assert.equal(await done, false); assert.deepEqual(f.ended, [false]); assert.ok(f.cancels() >= 2);
  const timeout = fixture({ timeout: 5 });
  assert.equal(await timeout.player.play("Lost platform callback."), false);
  assert.deepEqual(timeout.ended, [false]);
  const unavailable = fixture({ synthesis: { speak() { throw new Error("Speech unavailable"); }, cancel() {} } });
  assert.equal(await unavailable.player.play("Platform failed to start."), false);
  assert.deepEqual(unavailable.ended, [false]);
});
