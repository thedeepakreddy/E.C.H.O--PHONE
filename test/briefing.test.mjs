import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify } from "node:crypto";
import { encryptPayload, vapidKeys, vapidAuthorization, validSubscription } from "../lib/push.js";
import { localParts, zonedToUtc, cleanPrefs, briefingDue, addReminder, buildBriefing, runTick } from "../lib/briefing.js";
import { signPass } from "../lib/secure.js";
import { createRelay } from "../server.js";

const SECRET = "b".repeat(48);
const DEVICE = "abcdefabcdefabcdefabcdefabcdef12";
const b = (s) => Buffer.from(s, "base64url");

test("notification encryption matches RFC 8291's published example byte for byte", () => {
  const out = encryptPayload(b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    { asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(out.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("the relay's notification key is stable and its signature verifies", () => {
  const v = vapidKeys(SECRET);
  assert.equal(v.publicKey, vapidKeys(SECRET).publicKey, "the same secret gives the same key after a restart");
  assert.notEqual(v.publicKey, vapidKeys("c".repeat(48)).publicKey);
  const auth = vapidAuthorization("https://web.push.apple.com/abc", v, { contact: "https://echo-phone.onrender.com", now: 1791300000000 });
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m);
  const claims = JSON.parse(b(m[2]).toString());
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "https://echo-phone.onrender.com");
  const pub = b(m[4]);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, b(m[3])));
  assert.equal(validSubscription({ endpoint: "https://evil.example.com/x", keys: { p256dh: m[4], auth: "BTBZMqHH6r4Tts7J_aSIgg" } }), false, "only real push services");
  assert.equal(validSubscription({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: m[4], auth: "BTBZMqHH6r4Tts7J_aSIgg" } }), true);
});

test("wall-clock times in a time zone, across daylight saving", () => {
  assert.equal(new Date(zonedToUtc("2026-10-08T18:00", "Europe/Budapest")).toISOString(), "2026-10-08T16:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-12-01T09:00", "Europe/Budapest")).toISOString(), "2026-12-01T08:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-10-08T07:00", "America/New_York")).toISOString(), "2026-10-08T11:00:00.000Z");
  assert.ok(Number.isNaN(zonedToUtc("tomorrow", "Europe/Budapest")));
  assert.deepEqual(localParts(Date.parse("2026-10-08T05:30:00Z"), "Europe/Budapest"), { date: "2026-10-08", time: "07:30", weekday: 4 });
});

test("the briefing goes out once a day, after its time, not hours late, on the right days", () => {
  const dev = { sub: { endpoint: "x" }, prefs: cleanPrefs({ on: true, time: "07:00", tz: "Europe/Budapest" }), lastBrief: "", reminders: [] };
  assert.equal(briefingDue(dev, Date.parse("2026-10-08T04:55:00Z")), false, "06:55 is too early");
  assert.equal(briefingDue(dev, Date.parse("2026-10-08T05:03:00Z")), true, "07:03 is due");
  dev.lastBrief = "2026-10-08";
  assert.equal(briefingDue(dev, Date.parse("2026-10-08T05:08:00Z")), false, "once a day");
  dev.lastBrief = "";
  assert.equal(briefingDue(dev, Date.parse("2026-10-08T08:30:00Z")), false, "10:30 is too late to call it a morning briefing");
  dev.prefs = cleanPrefs({ days: "weekdays" }, dev.prefs);
  assert.equal(briefingDue(dev, Date.parse("2026-10-10T05:05:00Z")), false, "Saturday, weekdays only");
  assert.equal(briefingDue({ ...dev, sub: null }, Date.parse("2026-10-08T05:05:00Z")), false, "no notifications, no briefing");
  assert.equal(cleanPrefs({ time: "25:00", tz: "Mars/Base" }).time, "07:00", "bad settings are ignored");
});

test("reminders: real times only, in the phone's time zone", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const dev = { reminders: [] };
  const r = addReminder(dev, { text: "Plan dinner", when: "2026-10-08T18:00", tz: "Europe/Budapest" }, now, "r1");
  assert.equal(new Date(r.at).toISOString(), "2026-10-08T16:00:00.000Z");
  assert.throws(() => addReminder(dev, { text: "x", when: "2026-10-01T09:00", tz: "Europe/Budapest" }, now, "r2"), /passed/);
  assert.throws(() => addReminder(dev, { text: "", when: "2026-10-08T18:00", tz: "Europe/Budapest" }, now, "r3"), /What should/);
  assert.throws(() => addReminder(dev, { text: "x", when: "Thursday", tz: "Europe/Budapest" }, now, "r4"), /date and time/);
});

const NOW = Date.parse("2026-10-08T05:02:00Z"); // 07:02 in Budapest
const raw = {
  earthquakes: { earthquakes: [
    { time: NOW - 3600_000, magnitude: 4.9, place: "12 km N of Szeged, Hungary", lat: 46.35, lng: 20.15, tsunami: 0 },
    { time: NOW - 3600_000, magnitude: 6.1, place: "far away", lat: 4.8, lng: 118.8, tsunami: 1 },
  ] },
  weather: { events: [
    { title: "Super Typhoon", category: "severeStorms", type: "Severe Storm", lat: 31.6, lng: 146.4 },
    { title: "Drought is ongoing in Austria, Bosnia & Herzegovina, Belgium, Belarus, Switzerland, Czech Republic, Germany", category: "drought", type: "Drought", lat: 47.6, lng: 14.1 },
    { title: "Danube flooding near Vienna", category: "floods", type: "Flood", lat: 48.2, lng: 16.4 },
  ] },
  conflicts: { zones: [{ label: "UKRAINE WAR", severity: "war", events: [{ title: "Drone attack in Odesa" }] }] },
};
const tools = { weather: async () => ({ temp: 14.2, high: 17.4, low: 9.1, code: 61 }), worldRaw: async () => raw };
const digest = {
  at: NOW - 9 * 3600_000,
  calendar: [{ title: "Design review", start: "2026-10-08T08:00:00Z" }, { title: "Dentist", start: "2026-10-08T11:30:00Z" }, { title: "Tomorrow thing", start: "2026-10-09T08:00:00Z" }],
  email: [{ from: "Render", subject: "Deploy failed" }, { from: "Anna", subject: "Contract draft" }],
  missions: [{ goal: "weather app tests", status: "completed", at: NOW - 5 * 3600_000 }],
};

test("a briefing from the weather, the Mac's digest, reminders and the world nearby", async () => {
  const prefs = cleanPrefs({ on: true, tz: "Europe/Budapest", place: { name: "Budapest", lat: 47.5, lon: 19.04 } });
  const dev = { reminders: [{ id: "a", text: "Plan dinner", at: Date.parse("2026-10-08T16:00:00Z"), sent: false }] };
  const br = await buildBriefing({ prefs, dev, now: NOW, tools, digest, macOnline: false });
  assert.equal(br.title, "Good morning · 14°, light rain");
  assert.equal(br.weather.tip, "Take an umbrella.");
  assert.deepEqual(br.calendar, [{ title: "Design review", time: "10:00" }, { title: "Dentist", time: "13:30" }], "today only, in local time");
  assert.equal(br.near.quakes.length, 1, "only the quake within 500 km");
  assert.deepEqual(br.near.storms.map((x) => x.title), ["Danube flooding near Vienna"], "a nearby flood counts; a continent-wide drought doesn't");
  assert.equal(br.world.zone, "UKRAINE WAR");
  assert.equal(br.body, "2 events today, first at 10:00. 2 emails need you. 1 reminder today. Earthquake M4.9 nearby. Your Mac finished \"weather app tests\".");
});

test("a tick sends what's due once, and forgets a phone that unsubscribed", async () => {
  const sent = [];
  const phones = { devices: {
    [DEVICE]: { sub: { endpoint: "ok" }, prefs: cleanPrefs({ on: true, tz: "Europe/Budapest", place: { name: "Budapest", lat: 47.5, lon: 19.04 } }), lastBrief: "",
      reminders: [{ id: "r1", text: "Take the bins out", at: NOW - 60_000, sent: false }, { id: "r2", text: "Later", at: NOW + 3600_000, sent: false }] },
    gone: { sub: { endpoint: "gone" }, prefs: cleanPrefs({}), lastBrief: "", reminders: [{ id: "r3", text: "x", at: NOW - 1, sent: false }] },
  } };
  const stored = {};
  const push = async (sub, msg) => { sent.push([sub.endpoint, msg.title, msg.body]); return sub.endpoint === "gone" ? { ok: false, gone: true } : { ok: true }; };
  const run = () => runTick({ phones, now: NOW, tools, digest: async () => digest, macOnline: true, push, storeBriefing: (id, b) => { stored[id] = b; } });
  assert.equal(await run(), true);
  assert.deepEqual(sent.map((s) => s[1]), ["Reminder", "Good morning · 14°, light rain", "Reminder"]);
  assert.equal(phones.devices[DEVICE].lastBrief, "2026-10-08");
  assert.ok(stored[DEVICE]);
  assert.equal(phones.devices.gone.sub, null, "an unsubscribed phone is forgotten");
  sent.length = 0;
  await run();
  assert.equal(sent.length, 0, "nothing twice");
});

/** A stand-in push service that decrypts what it receives, like the phone would. */
function fakePushService(uaEcdh, authSecret) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
      const shared = uaEcdh.computeSecret(asPublic);
      const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const d = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12));
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      got.push({ auth: req.headers.authorization, encoding: req.headers["content-encoding"], message: JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString()) });
      res.writeHead(201); res.end();
    });
  });
  return { server, got };
}

test("relay: subscribe, test notification, reminders and briefing, end to end", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const authSecret = Buffer.from("0123456789abcdef");
  const svc = fakePushService(ua, authSecret);
  await new Promise((r) => svc.server.listen(0, "127.0.0.1", r));
  let t = Date.parse("2026-10-07T16:00:00Z");
  const relay = createRelay({ secret: SECRET, now: () => t, pushAnyHost: true, fetchJson: async () => ({}) });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pass = signPass(relay.keys.pass, { device: DEVICE, gen: 0, now: t });
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "x-echo-pass": pass, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const key = await (await fetch(`${base}/cloud/push/key`, { headers: { "x-echo-pass": pass } })).json();
    assert.equal(key.key, relay.vapid.publicKey);
    const sub = { endpoint: `http://127.0.0.1:${svc.server.address().port}/push/abc`, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
    assert.equal((await post("/cloud/push/subscribe", { subscription: sub })).status, 200);
    assert.equal((await post("/cloud/push/test", {})).status, 200);
    assert.equal(svc.got[0].encoding, "aes128gcm");
    assert.match(svc.got[0].auth, /^vapid t=.+, k=/);
    assert.match(svc.got[0].message.body, /Notifications are on/);

    const rem = await (await post("/cloud/reminders", { text: "Plan dinner", when: "2026-10-07T18:30", tz: "Europe/Budapest" })).json();
    assert.equal(new Date(rem.reminder.at).toISOString(), "2026-10-07T16:30:00.000Z");
    assert.equal((await post("/cloud/reminders", { text: "x", when: "2026-10-01T09:00", tz: "Europe/Budapest" })).status, 400);
    await relay.tick();
    assert.equal(svc.got.length, 1, "not due yet");
    t = Date.parse("2026-10-07T16:31:00Z");
    await relay.tick();
    assert.equal(svc.got[1].message.body, "Plan dinner");
    await relay.tick();
    assert.equal(svc.got.length, 2, "sent once");

    // Echo's digest, then the morning briefing at 07:00 Budapest.
    const dig = await fetch(`${base}/agent/digest`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify(digest) });
    assert.equal(dig.status, 204);
    assert.equal((await fetch(`${base}/agent/digest`, { method: "POST", body: "{}" })).status, 404, "only Echo can leave a digest");
    const prefs = await (await post("/cloud/briefing/prefs", { prefs: { on: true, time: "07:00", tz: "Europe/Budapest", place: { name: "Budapest", lat: 47.5, lon: 19.04 } } })).json();
    assert.equal(prefs.prefs.on, true);
    t = NOW;
    await relay.tick();
    const brief = svc.got.at(-1).message;
    assert.equal(brief.tag, "briefing");
    assert.equal(brief.url, "/?view=briefing");
    assert.match(brief.body, /2 events today, first at 10:00/);
    const latest = await (await fetch(`${base}/cloud/briefing`, { headers: { "x-echo-pass": pass } })).json();
    assert.equal(latest.subscribed, true);
    assert.deepEqual(latest.latest.calendar.map((e) => e.title), ["Design review", "Dentist"]);
    const now = await (await post("/cloud/briefing/now", {})).json();
    assert.equal(now.briefing.date, "2026-10-08");
  } finally {
    server.closeAllConnections?.(); server.close();
    svc.server.closeAllConnections?.(); svc.server.close();
  }
});

import { parsePhoneCalendar } from "../lib/briefing.js";

test("the iPhone's calendar: lines from a Shortcut, or JSON", () => {
  const lines = "2026-10-08T10:00:00+02:00 | Design review | Room 4\n2026-10-08T13:30:00+02:00 | Dentist\nnot a date | x\n | no time";
  const ev = parsePhoneCalendar(lines);
  assert.deepEqual(ev.map((e) => e.title), ["Design review", "Dentist"]);
  assert.equal(ev[0].start, "2026-10-08T08:00:00.000Z");
  assert.equal(ev[0].location, "Room 4");
  assert.equal(parsePhoneCalendar(JSON.stringify({ events: lines })).length, 2, "the same lines inside JSON");
  assert.equal(parsePhoneCalendar({ events: [{ start: "2026-10-08T10:00:00Z", title: "Gym" }] })[0].title, "Gym");
});

test("the briefing uses today's calendar from the iPhone over the Mac's", async () => {
  const prefs = cleanPrefs({ on: true, tz: "Europe/Budapest" });
  const phoneCal = { at: NOW - 15 * 60_000, events: parsePhoneCalendar("2026-10-08T09:00:00+02:00 | Standup | Zoom") };
  const br = await buildBriefing({ prefs, dev: { reminders: [] }, now: NOW, tools: {}, digest, phoneCal });
  assert.equal(br.calendarFrom, "iphone");
  assert.deepEqual(br.calendar, [{ title: "Standup", time: "09:00", location: "Zoom" }]);
  const stale = await buildBriefing({ prefs, dev: { reminders: [] }, now: NOW, tools: {}, digest, phoneCal: { ...phoneCal, at: NOW - 86400_000 } });
  assert.equal(stale.calendarFrom, "mac", "yesterday's upload isn't today's calendar: the Mac's is used");
});

test("relay: the Shortcut's link uploads today's events, and nothing else", async () => {
  const relay = createRelay({ secret: SECRET, now: () => NOW, fetchJson: async () => ({}), publicUrl: "https://echo-phone.onrender.com" });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pass = signPass(relay.keys.pass, { device: DEVICE, gen: 0, now: NOW });
  const get = (p) => fetch(base + p, { headers: { "x-echo-pass": pass } }).then((r) => r.json());
  try {
    const { url, last } = await get("/cloud/calendar");
    assert.match(url, /^https:\/\/echo-phone\.onrender\.com\/cal\/[A-Za-z0-9_-]{24}$/);
    assert.equal(last, null);
    assert.equal((await get("/cloud/calendar")).url, url, "the same link every time");
    const path = new URL(url).pathname;
    const up = await fetch(base + path, { method: "POST", body: "2026-10-08T10:00:00+02:00 | Design review\n2026-10-08T13:30:00+02:00 | Dentist" });
    assert.equal(await up.text(), "Echo got 2 events for today.");
    assert.equal((await get("/cloud/calendar")).last.count, 2);
    assert.equal((await fetch(`${base}/cal/${"x".repeat(24)}`, { method: "POST", body: "a" })).status, 404, "a made-up link does nothing");
    const brief = await (await fetch(`${base}/cloud/briefing/now`, { method: "POST", headers: { "x-echo-pass": pass }, body: JSON.stringify({ prefs: { tz: "Europe/Budapest" } }) })).json();
    assert.equal(brief.briefing.calendarFrom, "iphone");
    assert.deepEqual(brief.briefing.calendar.map((e) => e.title), ["Design review", "Dentist"]);
    const reset = await (await fetch(`${base}/cloud/calendar/reset`, { method: "POST", headers: { "x-echo-pass": pass }, body: "{}" })).json();
    assert.notEqual(reset.url, url);
    assert.equal((await fetch(base + path, { method: "POST", body: "x" })).status, 404, "after a reset the old link stops working");
  } finally { server.closeAllConnections?.(); server.close(); }
});
