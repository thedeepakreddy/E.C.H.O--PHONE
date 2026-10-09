import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/voice-session.js";
const { Segmenter, Session } = globalThis.EchoVoice;
const frame = (level = 0) => new Float32Array(1600).fill(level);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function utterance(push) {
  for (let i = 0; i < 5; i++) push(frame(.08));
  for (let i = 0; i < 15; i++) push(frame());
}

test("voice segmentation ignores silence and clicks, preserves pre-roll and waits through a short pause", () => {
  const detector = new Segmenter(16000);
  for (let i = 0; i < 3000; i++) assert.equal(detector.push(frame(.002)), null);
  assert.ok(detector.pre.length <= 3);
  detector.push(frame(.1));
  for (let i = 0; i < 20; i++) assert.equal(detector.push(frame()), null);
  let results = [];
  const push = (samples) => { const turn = detector.push(samples); if (turn) results.push(turn); };
  for (let i = 0; i < 5; i++) push(frame(.08));
  for (let i = 0; i < 8; i++) push(frame());
  assert.equal(results.length, 0);
  for (let i = 0; i < 5; i++) push(frame(.06));
  for (let i = 0; i < 15; i++) push(frame());
  assert.equal(results.length, 1);
  assert.ok(results[0].length >= 30);
  for (let i = 0; i < 30; i++) assert.equal(detector.push(frame()), null);
});

test("long utterances remain below the voice endpoint limit", () => {
  const detector = new Segmenter(48000);
  let result;
  for (let i = 0; i < 700; i++) {
    const turn = detector.push(new Float32Array(4096).fill(.08));
    if (turn) { result = turn; break; }
  }
  const seconds = result.reduce((n, chunk) => n + chunk.length, 0) / 48000;
  assert.ok(seconds >= 55 && seconds < 56);
  assert.ok(44 + seconds * 16000 * 2 < 2_200_000);
});
test("quiet phone speech is sent after a pause without sending ambient noise", () => {
  const detector = new Segmenter(16000), results = [];
  const push = (level) => { const result = detector.push(frame(level)); if (result) results.push(result); };
  for (let i = 0; i < 100; i++) push(.0015);
  assert.equal(results.length, 0);
  for (let i = 0; i < 8; i++) push(.006);
  for (let i = 0; i < 16; i++) push(.0015);
  assert.equal(results.length, 1);
  assert.ok(results[0].some((chunk) => chunk[0] > .005));
  for (let i = 0; i < 100; i++) push(.0015);
  assert.equal(results.length, 1);
});
test("a pause over background sound ends a louder utterance and later turns still work", () => {
  const detector = new Segmenter(16000), results = [];
  const push = (level) => { const result = detector.push(frame(level)); if (result) results.push(result); };
  for (let i = 0; i < 8; i++) push(.1);
  // This background level exceeded the former .014 cutoff, so a pause never ended.
  for (let i = 0; i < 20; i++) push(.016);
  assert.equal(results.length, 1);
  for (let i = 0; i < 100; i++) push(.016);
  assert.equal(results.length, 1);
  for (let i = 0; i < 8; i++) push(.08);
  for (let i = 0; i < 20; i++) push(.016);
  assert.equal(results.length, 2);
});

test("one voice session handles multiple turns and excludes audio while answering", async () => {
  let push, finish, turns = 0, closes = 0;
  const states = [];
  const session = new Session({
    acquire: async (input) => { push = input; return { rate: 16000, close: () => closes++ }; },
    onTurn: () => { turns++; session.phase("speaking"); return new Promise((resolve) => { finish = resolve; }); },
    onState: (state) => states.push(state),
  });
  await session.start();
  utterance(push); await flush();
  assert.equal(turns, 1); assert.equal(session.state, "speaking");
  utterance(push); await flush(); assert.equal(turns, 1);
  finish(true); await flush(); assert.equal(session.state, "listening");
  for (let i = 0; i < 4; i++) push(frame()); // speaker tail is discarded
  utterance(push); await flush(); assert.equal(turns, 2);
  session.stop(); finish(true); await flush();
  assert.equal(session.state, "off"); assert.equal(closes, 1);
  utterance(push); await flush(); assert.equal(turns, 2);
  assert.deepEqual(states.slice(0, 4), ["starting", "listening", "thinking", "speaking"]);
});

test("stopping while permission is pending releases late microphone and ignores its callbacks", async () => {
  let allow, oldError, closes = 0, errors = 0;
  const session = new Session({
    acquire: (_, onError) => { oldError = onError; return new Promise((resolve) => { allow = resolve; }); },
    onError: () => errors++,
  });
  const start = session.start(); session.stop();
  allow({ rate: 16000, close: () => closes++ }); await start;
  oldError(new Error("stale track ended"));
  assert.equal(closes, 1); assert.equal(errors, 0); assert.equal(session.state, "off");
});

test("Stop between speech detection and the request prevents the request entirely", async () => {
  let push, calls = 0;
  const session = new Session({ acquire: async (input) => { push = input; return { rate: 16000, close() {} }; }, onTurn: () => ++calls });
  await session.start(); utterance(push); session.stop(); await flush();
  assert.equal(calls, 0);
});

test("permission denial, microphone interruption and unsuccessful replies leave voice off", async () => {
  let error;
  const denied = new Session({ acquire: async () => { throw new Error("Denied"); }, onError: (e) => { error = e; } });
  await denied.start(); assert.equal(denied.state, "off"); assert.equal(error.message, "Denied");
  let push, interrupt, closes = 0;
  const session = new Session({ acquire: async (input, onError) => { push = input; interrupt = onError; return { rate: 16000, close: () => closes++ }; }, onTurn: async () => null });
  await session.start(); utterance(push); await flush();
  assert.equal(session.state, "off"); assert.equal(closes, 1);
  await session.start(); interrupt(new Error("Interrupted"));
  assert.equal(session.state, "off"); assert.equal(closes, 2);
});
test("a mic with no audio callbacks fails clearly and closes; a silent working mic stays available", async () => {
  let closes = 0, error, push;
  const session = new Session({ frameTimeoutMs: 20,
    acquire: async (input) => { push = input; return { rate: 16000, close: () => closes++ }; },
    onError: (e) => { error = e; },
  });
  await session.start(); await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(session.state, "off"); assert.equal(closes, 1); assert.match(error.message, /isn't delivering audio/);
  error = null; await session.start(); push(frame());
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(session.state, "listening"); assert.equal(error, null);
  session.stop(); assert.equal(closes, 2);
});
