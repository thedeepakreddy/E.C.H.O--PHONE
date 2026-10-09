import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKeys, signPass, verifyPass, seal, unseal } from "../lib/secure.js";
import { createStore } from "../lib/store.js";
import { classify } from "../lib/gemini.js";
import { createCloud, buildContents, quotaDay, nextReset, CloudError, RESERVE } from "../lib/cloud.js";
import { buildIcs, addMinutes } from "../lib/calendar.js";
import { ensureSchedule } from "../lib/tick.js";
import { createRelay } from "../server.js";
import http from "node:http";

const SECRET = "s".repeat(48);
const DEVICE = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-06T10:00:00Z");

/** Shared with Echo's own test (src/_remoteapptest.ts): both sides must agree byte for byte. */
export const VECTOR = { secret: "v".repeat(40), device: "f".repeat(32), gen: 3, now: 1791300000000 };

test("cloud pass: genuine, tamper-proof, expiring and revocable", () => {
  const { pass: key } = deriveKeys(SECRET);
  const p = signPass(key, { device: DEVICE, gen: 1, now: NOW });
  assert.equal(verifyPass(key, p, { now: NOW + 1000 })?.device, DEVICE);
  assert.equal(verifyPass(key, p, { now: NOW + 31 * 86400_000 }), null, "expires after 30 days");
  assert.equal(verifyPass(key, p, { now: NOW, minGen: 2 }), null, "a sign-out of every phone cancels it");
  assert.equal(verifyPass(deriveKeys("x".repeat(48)).pass, p, { now: NOW }), null, "another relay's key can't vouch for it");
  const [h, body, sig] = p.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), g: 99 })).toString("base64url");
  assert.equal(verifyPass(key, `${h}.${forged}.${sig}`, { now: NOW }), null, "edited claims fail the signature");
  assert.equal(verifyPass(key, signPass(key, { device: "nope", gen: 1, now: NOW }), { now: NOW }), null, "device ids are 32 hex characters");
  const v = signPass(deriveKeys(VECTOR.secret).pass, VECTOR);
  assert.match(v, /^cp1\./);
  assert.equal(v, "cp1.eyJ2IjoxLCJkIjoiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYiLCJpYXQiOjE3OTEzMDAwMDAsImV4cCI6MTc5Mzg5MjAwMCwiZyI6M30.pOA4SN7qh0I460FKakT56xpRZMA7ATc6gwJFKZ8NiUs", "the shared vector (Echo signs, the relay checks)");
});

test("sealed values round-trip and never show plaintext", () => {
  const { store: key } = deriveKeys(SECRET);
  const s = seal(key, { reminder: "pay the electricity bill" });
  assert.doesNotMatch(s, /electricity/);
  assert.deepEqual(unseal(key, s), { reminder: "pay the electricity bill" });
  assert.throws(() => unseal(deriveKeys("y".repeat(48)).store, s), "another key can't open it");
});

test("store: memory fallback, and Upstash only ever sees ciphertext", async () => {
  let t = NOW;
  const mem = createStore({ key: deriveKeys(SECRET).store, now: () => t });
  await mem.set("a", { x: 1 }, 60);
  assert.deepEqual(await mem.get("a"), { x: 1 });
  assert.equal(await mem.incr("n", 60), 1);
  assert.equal(await mem.incr("n", 60), 2);
  t += 61_000;
  assert.equal(await mem.get("a"), null, "expiry works");
  assert.equal(await mem.count("n"), 0);

  const wire = [];
  const kv = new Map();
  const fakeUpstash = async (url, init) => {
    const args = JSON.parse(init.body);
    wire.push(init.body);
    assert.equal(init.headers.authorization, "Bearer tok");
    const [cmd, k, v] = args;
    const result = cmd === "SET" ? (kv.set(k, v), "OK") : cmd === "GET" ? kv.get(k) ?? null : cmd === "INCR" ? (kv.set(k, String(Number(kv.get(k) ?? 0) + 1)), Number(kv.get(k))) : 1;
    return { ok: true, json: async () => ({ result }) };
  };
  const up = createStore({ url: "https://x.upstash.io", token: "tok", key: deriveKeys(SECRET).store, fetchImpl: fakeUpstash });
  assert.equal(up.remote, true);
  await up.set("note", { text: "dentist at 13:30" });
  assert.ok(wire.every((w) => !w.includes("dentist")), "the store never receives the plaintext");
  assert.deepEqual(await up.get("note"), { text: "dentist at 13:30" });
  assert.equal(await up.incr("q:x", 60), 1);
});

test("Gemini 429s say which limit was hit", () => {
  const day = classify(429, { error: { message: "quota", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "1000" }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "40s" }] } });
  assert.equal(day.kind, "day");
  assert.equal(day.limit, 1000);
  const minute = classify(429, { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { retryDelay: "7s" }] } });
  assert.equal(minute.kind, "minute");
  assert.equal(minute.retryMs, 7000);
  assert.equal(classify(400, { error: { message: "API key not valid. Please pass a valid API key." } }).kind, "auth");
  assert.equal(classify(503, {}).kind, "server");
});

test("quota day turns over at midnight Pacific (9:00 in Budapest)", () => {
  assert.equal(quotaDay(Date.parse("2026-10-06T06:59:00Z")), "2026-10-05");
  assert.equal(quotaDay(Date.parse("2026-10-06T07:01:00Z")), "2026-10-06");
  assert.equal(new Date(nextReset(Date.parse("2026-10-06T05:00:00Z"))).toISOString(), "2026-10-06T07:00:00.000Z");
});

test("phone history becomes alternating Gemini turns", () => {
  const c = buildContents([{ role: "echo", text: "hi" }, { role: "user", text: "a" }, { role: "user", text: "b" }, { role: "echo", text: "c" }], "next");
  assert.deepEqual(c.map((t) => t.role), ["user", "model", "user"]);
  assert.equal(c[0].parts[0].text, "a\n\nb");
  assert.equal(c[2].parts[0].text, "next");
  const v = buildContents([], "", "QUFBQQ==");
  assert.equal(v[0].parts[0].inline_data.mime_type, "audio/wav");
});

/** A scripted Gemini: each call returns the next reply. */
function scripted(replies, seen = []) {
  return { model: "test-model", generate: async (body, { onRequest } = {}) => {
    onRequest?.(); seen.push(structuredClone(body));
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(body) : next;
  } };
}
const text = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const call = (name, args, id) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args, ...(id ? { id } : {}) } }] } }] });
const tools = {
  weather: async () => ({ temp: 14, code: 61, high: 17, low: 9 }),
  world: async () => ({ updatedAt: NOW, conflicts: [], earthquakes: { count: 0, top: [] }, tsunamis: [], fires: { count: 0 }, storms: [] }),
  geocode: async (q) => (q === "Paris" ? [{ name: "Paris", country: "France", lat: 48.85, lon: 2.35 }] : []),
};

test("Phone mode runs its own tools, and everything else becomes a button", async () => {
  const seen = [];
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const gemini = scripted([
    call("get_weather", { place: "Paris" }, "c1"),
    call("add_to_calendar", { title: "Dinner", start: "2026-10-08T19:30", location: "Le Marais" }),
    text("It's 14° and rainy in Paris. I've put a button to add dinner to your calendar."),
  ], seen);
  const cloud = createCloud({ gemini, store, now: () => NOW, tools });
  const r = await cloud.chat({ history: [], text: "Weather in Paris, and add dinner Thursday 19:30", context: { tz: "Europe/Budapest", lat: 47.5, lon: 19.04 } });
  assert.match(r.reply, /14°/);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "calendar");
  assert.equal(r.actions[0].data.alertMinutes, 30);
  const weatherReply = seen[1].contents.at(-1).parts[0].functionResponse;
  assert.equal(weatherReply.id, "c1", "the call id goes back with the result");
  assert.equal(weatherReply.response.place, "Paris, France");
  assert.match(seen[2].contents.at(-1).parts[0].functionResponse.response.note, /never say you have set, added, sent or scheduled/);
  assert.match(seen[0].systemInstruction.parts[0].text, /Europe\/Budapest/);
  assert.equal(r.usage.requests, 3);
  assert.equal(r.usage.messages, 1);
});

test("Phone mode refuses unsafe buttons and odd times", async () => {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const seen = [];
  const cloud = createCloud({ gemini: scripted([
    call("open_link", { url: "javascript:alert(1)" }),
    call("remind_me", { text: "x", when: "tomorrow" }),
    call("send_to_mac", { task: "Build the weather app's settings screen" }),
    text("ok"),
  ], seen), store, now: () => NOW, tools });
  const r = await cloud.chat({ history: [], text: "go" });
  assert.match(seen[1].contents.at(-1).parts[0].functionResponse.response.error, /https/);
  assert.match(seen[2].contents.at(-1).parts[0].functionResponse.response.error, /local time/);
  assert.deepEqual(r.actions.map((a) => a.type), ["mac"]);
});

test("the last round must answer in words", async () => {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const seen = [];
  const loops = Array.from({ length: 4 }, () => call("get_weather", {}));
  const cloud = createCloud({ gemini: scripted([...loops, text("Here you go.")], seen), store, now: () => NOW, tools });
  const r = await cloud.chat({ history: [], text: "weather", context: { lat: 1, lon: 1 } });
  assert.equal(r.reply, "Here you go.");
  assert.equal(seen.at(-1).toolConfig.functionCallingConfig.mode, "NONE");
});

test("daily caps, Google's day limit and the briefing reserve", async () => {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const cloud = createCloud({ gemini: scripted([text("a"), text("b")]), store, now: () => NOW, tools, limits: { messages: 2 } });
  await cloud.chat({ history: [], text: "1" });
  await cloud.chat({ history: [], text: "2" });
  await assert.rejects(cloud.chat({ history: [], text: "3" }), (e) => e instanceof CloudError && e.kind === "cap");

  const store2 = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const dayErr = Object.assign(new Error("quota"), {});
  const { GeminiError } = await import("../lib/gemini.js");
  const c2 = createCloud({ gemini: scripted([new GeminiError("day", "quota", { limit: 1000 })]), store: store2, now: () => NOW, tools });
  await assert.rejects(c2.chat({ history: [], text: "x" }), (e) => e.kind === "quota" && e.resetsAt > NOW);
  assert.equal(await store2.count("qlimit"), 1000, "the real limit is learned from Google");
  await store2.setCount(`q:${quotaDay(NOW)}`, 1000 - RESERVE);
  await assert.rejects(c2.chat({ history: [], text: "y" }), (e) => e.kind === "quota" && /briefing/.test(e.message));
  void dayErr;
});

test("a voice message comes back with what was heard", async () => {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const cloud = createCloud({ gemini: scripted([text("» What's the weather like?\n\nSunny and 20°.")]), store, now: () => NOW, tools });
  const r = await cloud.chat({ history: [], audio: "QUFBQQ==".repeat(20) });
  assert.equal(r.transcript, "What's the weather like?");
  assert.equal(r.reply, "Sunny and 20°.");
});

test("calendar files: floating times, an alert, escaped and folded", () => {
  assert.equal(addMinutes("2026-10-08T23:30", 60), "2026-10-09T00:30");
  const ics = buildIcs({ title: "Dinner, with Anna; 7 people", start: "2026-10-08T19:30", location: "Le Marais", alertMinutes: 30, notes: "x".repeat(200) }, { uid: "u1", now: NOW });
  assert.match(ics, /DTSTART:20261008T193000\r\n/);
  assert.match(ics, /DTEND:20261008T203000\r\n/);
  assert.match(ics, /SUMMARY:Dinner\\, with Anna\\; 7 people/);
  assert.match(ics, /TRIGGER:-PT30M/);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines are folded");
});

test("the tick schedule is created once, with a fixed id and our own token", async () => {
  let seen;
  const r = await ensureSchedule({ qstashToken: "q", publicUrl: "https://echo-phone.onrender.com", cronToken: "abc", fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(seen.url, "https://qstash.upstash.io/v2/schedules/https://echo-phone.onrender.com/cron/tick");
  assert.equal(seen.init.headers["upstash-cron"], "*/5 * * * *");
  assert.equal(seen.init.headers["upstash-schedule-id"], "echo-tick");
  assert.equal(seen.init.headers["upstash-forward-authorization"], "Bearer abc");
  assert.equal((await ensureSchedule({ publicUrl: "x", cronToken: "y" })).ok, false);
});

async function startRelay(opts) {
  const relay = createRelay({ secret: SECRET, pollMs: 300, ...opts });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { relay, base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test("standalone phone: start, chat, save and renew without any Mac", async () => {
  let t = NOW;
  const r = await startRelay({ now: () => t, gemini: scripted([text("Hello from your phone!")]) });
  const session = (pass, body = {}) => fetch(`${r.base}/phone/session`, {
    method: "POST", headers: { "content-type": "application/json", ...(pass ? { "x-echo-pass": pass } : {}) }, body: JSON.stringify(body),
  });
  try {
    const first = await session(null, { device: DEVICE });
    assert.equal(first.status, 200);
    const { device, cloudPass } = await first.json();
    assert.match(device, /^[0-9a-f]{32}$/);
    assert.notEqual(device, DEVICE, "a client cannot choose another phone's identity");
    assert.equal(verifyPass(r.relay.keys.pass, cloudPass, { now: t }).phoneOnly, true);
    const headers = { "x-echo-pass": cloudPass, "content-type": "application/json" };
    const chat = await fetch(`${r.base}/cloud/chat`, { method: "POST", headers, body: JSON.stringify({ text: "hi" }) });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).reply, "Hello from your phone!");
    const saved = await fetch(`${r.base}/cloud/memory/save`, { method: "POST", headers, body: JSON.stringify({ note: { title: "My note", text: "Dentist next week" } }) });
    assert.equal(saved.status, 200);
    const id = (await saved.json()).item.id;
    t += 31 * 86400_000;
    assert.equal((await fetch(`${r.base}/cloud/status`, { headers })).status, 401, "expired passes cannot call ordinary APIs");
    const renewed = await session(cloudPass);
    assert.equal(renewed.status, 200);
    const next = await renewed.json();
    assert.equal(next.device, device, "renewal preserves saved data without Mac sign-in");
    const restored = await fetch(`${r.base}/cloud/memory?id=${id}`, { headers: { "x-echo-pass": next.cloudPass } });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).body.text, "Dentist next week");
    const stranger = await (await session(null, { device })).json();
    assert.notEqual(stranger.device, device);
    assert.equal((await fetch(`${r.base}/cloud/memory?id=${id}`, { headers: { "x-echo-pass": stranger.cloudPass } })).status, 404);
    assert.equal((await session(cloudPass + "x")).status, 401, "a forged pass cannot restore an identity");
    assert.equal((await fetch(`${r.base}/phone/session`, { method: "POST", headers: { "content-type": "application/json", origin: "https://another-site.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${r.base}/phone/session`, { method: "POST", body: "{}" })).status, 403, "cross-site forms cannot start sessions");
  } finally { await r.close(); }
});

test("standalone phones cannot access Mac data or revoke paired phones; pairing keeps their data", async () => {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const r = await startRelay({ store, now: () => NOW, fetchJson: async () => ({}) });
  try {
    const start = await fetch(`${r.base}/phone/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { device, cloudPass } = await start.json();
    const headers = { "x-echo-pass": cloudPass, "content-type": "application/json" };
    const agent = { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-echo-pass-gen": "2" };
    await fetch(`${r.base}/agent/digest`, { method: "POST", headers: agent, body: JSON.stringify({ calendar: [], email: [{ from: "Private sender", subject: "Mac inbox only" }], missions: [] }) });
    await fetch(`${r.base}/agent/poll`, { headers: agent });
    const briefing = async (h) => (await (await fetch(`${r.base}/cloud/briefing/now`, { method: "POST", headers: h, body: "{}" })).json()).briefing;
    const alone = await briefing(headers);
    assert.equal(alone.email, undefined);
    assert.equal(alone.macAsOf, undefined);
    assert.equal(alone.macOnline, false);
    // The scheduled morning briefing must filter the digest too, not just the preview.
    const phones = await store.get("phones");
    phones.devices[device].prefs = { ...phones.devices[device].prefs, on: true, time: "10:00" };
    phones.devices[device].sub = { endpoint: "https://web.push.apple.com/test", keys: { p256dh: "bad", auth: "bad" } };
    await store.set("phones", phones);
    await r.relay.tick();
    assert.equal((await store.get(`brief:${device}:phone`)).email, undefined);
    assert.equal((await store.get(`brief:${device}:phone`)).macOnline, false);
    assert.equal((await fetch(`${r.base}/cloud/status`, { headers })).status, 200, "Mac-wide revocation leaves standalone sessions alone");
    assert.equal((await fetch(`${r.base}/cloud/signout-all`, { method: "POST", headers })).status, 403);
    assert.equal(r.relay.state().passGen, 2);
    assert.equal((await fetch(`${r.base}/cloud/handoff`, { method: "POST", headers, body: "{}" })).status, 403);
    const browse = await fetch(`${r.base}/cloud/browse/session`, { method: "POST", headers, body: "{}" });
    assert.equal(browse.status, 200);
    assert.equal(unseal(r.relay.keys.store, /eb=([^;]+)/.exec(browse.headers.get("set-cookie"))[1]).phoneOnly, true);
    const reminder = await fetch(`${r.base}/cloud/reminders`, { method: "POST", headers, body: JSON.stringify({ text: "My reminder", when: new Date(NOW + 3600_000).toISOString().slice(0, 16), tz: "UTC" }) });
    assert.equal(reminder.status, 200);
    // Echo Mac issues its ordinary pass for the same id at optional sign-in.
    const paired = signPass(r.relay.keys.pass, { device, gen: 2, now: NOW });
    const pairedHeaders = { ...headers, "x-echo-pass": paired };
    assert.equal((await fetch(`${r.base}/cloud/status`, { headers: pairedHeaders })).status, 200);
    assert.equal((await briefing(pairedHeaders)).email[0].subject, "Mac inbox only");
    const reminders = await (await fetch(`${r.base}/cloud/reminders`, { headers: pairedHeaders })).json();
    assert.equal(reminders.reminders[0].text, "My reminder");
    await fetch(`${r.base}/agent/poll`, { headers: { ...agent, "x-echo-pass-gen": "3" } });
    assert.equal((await fetch(`${r.base}/cloud/status`, { headers: pairedHeaders })).status, 401);
    const cookie = browse.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${r.base}/b/go?q=Budapest`, { headers: { cookie }, redirect: "manual" })).status, 302, "standalone Browser remains usable after Mac sign-out");
    assert.equal((await fetch(`${r.base}/phone/session`, { method: "POST", headers: pairedHeaders, body: "{}" })).status, 401, "a revoked paired pass cannot recover its identity through standalone renewal");
  } finally { await r.close(); }
});

test("relay: Phone mode needs a current cloud pass; Echo's sign-out reaches it", async () => {
  const r = await startRelay({ gemini: scripted([text("Hi there!"), text("again")]) });
  try {
    const pass = signPass(r.relay.keys.pass, { device: DEVICE, gen: 1 });
    const chat = (p) => fetch(`${r.base}/cloud/chat`, { method: "POST", headers: { "content-type": "application/json", ...(p ? { "x-echo-pass": p } : {}) }, body: JSON.stringify({ text: "hello", history: [] }) });
    assert.equal((await chat()).status, 401);
    const ok = await chat(pass);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).reply, "Hi there!");
    const status = await (await fetch(`${r.base}/cloud/status`, { headers: { "x-echo-pass": pass } })).json();
    assert.equal(status.ready, true);
    assert.equal(status.macOnline, false);
    // Echo signs every phone out: its next poll carries generation 2.
    const poll = await fetch(`${r.base}/agent/poll`, { headers: { authorization: `Bearer ${SECRET}`, "x-echo-pass-gen": "2" } });
    assert.equal(poll.headers.get("x-relay-pass-gen"), "2");
    assert.equal((await chat(pass)).status, 401, "the old pass is cancelled");
    const fresh = signPass(r.relay.keys.pass, { device: DEVICE, gen: 2 });
    assert.equal((await chat(fresh)).status, 200);
    // Signing out from the phone, with the Mac off, raises it too.
    assert.equal((await fetch(`${r.base}/cloud/signout-all`, { method: "POST", headers: { "x-echo-pass": fresh } })).status, 200);
    assert.equal((await chat(fresh)).status, 401);
    assert.equal(r.relay.state().passGen, 3);
  } finally { await r.close(); }
});

test("relay: without a Gemini key Phone mode says how to set it up", async () => {
  const r = await startRelay({});
  try {
    const pass = signPass(r.relay.keys.pass, { device: DEVICE, gen: 0 });
    const res = await fetch(`${r.base}/cloud/chat`, { method: "POST", headers: { "x-echo-pass": pass }, body: "{}" });
    assert.equal(res.status, 503);
    assert.match((await res.json()).message, /GEMINI_API_KEY/);
    assert.equal((await (await fetch(`${r.base}/healthz`)).json()).phone.brain, false);
  } finally { await r.close(); }
});

test("relay: calendar links are sealed, long-lived and come with the answer", async () => {
  let t = NOW;
  const r = await startRelay({ now: () => t, gemini: scripted([call("add_to_calendar", { title: "Plan dinner", start: "2026-10-08T18:00" }), text("Tap the button to add it.")]) });
  try {
    const pass = signPass(r.relay.keys.pass, { device: DEVICE, gen: 0, now: NOW });
    const made = await fetch(`${r.base}/cloud/ics`, { method: "POST", headers: { "x-echo-pass": pass }, body: JSON.stringify({ event: { title: "Dentist", start: "2026-10-09T13:30" } }) });
    const { url } = await made.json();
    assert.match(url, /^\/ics\/v1\.[A-Za-z0-9_-]+\.ics$/);
    assert.doesNotMatch(url, /Dentist/, "the address shows nothing personal");
    const ics = await fetch(r.base + url);
    assert.equal(ics.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.match(await ics.text(), /SUMMARY:Dentist/);
    const tampered = url.replace(/v1\.(.)/, (m, c) => `v1.${c === "A" ? "B" : "A"}`);
    assert.equal((await fetch(r.base + tampered)).status, 404, "an edited link opens nothing");
    const bad = await fetch(`${r.base}/cloud/ics`, { method: "POST", headers: { "x-echo-pass": pass }, body: JSON.stringify({ event: { title: "x", start: "soon" } }) });
    assert.equal(bad.status, 400);
    // Calendar remains an external action: its button arrives with a sealed link.
    const chat = await (await fetch(`${r.base}/cloud/chat`, { method: "POST", headers: { "x-echo-pass": pass }, body: JSON.stringify({ text: "remind me", history: [] }) })).json();
    assert.equal(chat.actions[0].type, "calendar");
    assert.match(chat.actions[0].url, /^\/ics\/v1\./);
    t += 31 * 86400_000;
    assert.equal((await fetch(r.base + url)).status, 404, "links expire after 30 days");
  } finally { await r.close(); }
});

test("relay: only the scheduler's token runs the tick", async () => {
  const r = await startRelay({});
  try {
    assert.equal((await fetch(`${r.base}/cron/tick`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${r.base}/cron/tick`, { method: "POST", headers: { authorization: "Bearer nope" } })).status, 404);
    const ok = await fetch(`${r.base}/cron/tick`, { method: "POST", headers: { authorization: `Bearer ${r.relay.keys.cron}` } });
    assert.equal(ok.status, 200);
  } finally { await r.close(); }
});
