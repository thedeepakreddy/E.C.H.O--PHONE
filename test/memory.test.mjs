import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  cleanDates, datesFromSnap, fromSnap, fromNote, packVector, unpackVector, cosine, rank, keywordScore,
  syncDates, dueDateAlerts, markSent, alertMessage, comingUp, createMemory, DIMS,
} from "../lib/memory.js";
import { cleanSnap } from "../lib/snap.js";
import { createStore } from "../lib/store.js";
import { deriveKeys, signPass } from "../lib/secure.js";
import { runTick, buildBriefing, DEFAULT_PREFS } from "../lib/briefing.js";
import { createCloud } from "../lib/cloud.js";
import { zonedToUtc } from "../lib/time.js";
import { createRelay } from "../server.js";

const SECRET = "m".repeat(48);
const DEVICE = "1234567890abcdef1234567890abcdef";
const TZ = "Europe/Budapest";
const NOW = Date.parse("2026-10-06T10:00:00Z");
const BILL = { readable: true, kind: "bill", title: "Electricity bill · MVM Next", summary: "Your October electricity bill.", amount: 18420, currency: "HUF",
  due_date: "2026-10-20", payee: "MVM Next", account: "HU 1234 3381", category: "Utilities" };
const POLICY = { readable: true, kind: "document", title: "Car insurance · Allianz", summary: "Your car insurance policy for the Skoda.",
  key_dates: [{ date: "2026-11-01", what: "Car insurance renews" }, { date: "2026-11-01", what: "car insurance renews" }, { date: "1 Nov", what: "bad" }] };

/** A stand-in for Gemini's embeddings: words that mean the same land on the same number. */
const SAME = { electricity: "power", power: "power", energy: "power", bill: "bill", pay: "bill", invoice: "bill", insurance: "insure", policy: "insure",
  renew: "renew", renews: "renew", renewal: "renew", car: "car", skoda: "car", locker: "locker", gym: "locker", code: "code", pin: "code" };
function fakeEmbed(text) {
  const v = new Array(DIMS).fill(0);
  v[DIMS - 1] = 0.3; // a little in common, like real embeddings
  for (const w of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    const c = SAME[w];
    if (!c) continue;
    let h = 0;
    for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % (DIMS - 1);
    v[h] += 1;
  }
  return v;
}

test("dates: real days only, each with what happens, no repeats, in order", () => {
  assert.deepEqual(cleanDates([{ date: "2026-11-01", what: "Renews" }, { date: "2026-11-01", what: "renews" }, { date: "2026-02-30x", what: "x" }, { date: "2026-10-09", what: "" }, { date: "2026-10-08", what: "Dentist" }]),
    [{ date: "2026-10-08", what: "Dentist" }, { date: "2026-11-01", what: "Renews" }]);
  assert.deepEqual(datesFromSnap(cleanSnap(BILL)), [{ date: "2026-10-20", what: "Pay MVM Next (18,420 HUF)" }]);
  assert.deepEqual(datesFromSnap(cleanSnap(POLICY)), [{ date: "2026-11-01", what: "Car insurance renews" }], "a document's key dates, cleaned");
});

test("a saved snap keeps what it found, never a photo; a note keeps the user's words", () => {
  const s = fromSnap(cleanSnap(BILL), { snapId: "abcd1234" });
  assert.equal(s.kind, "bill");
  assert.equal(s.snapId, "abcd1234");
  assert.match(s.embedText, /Amount: 18420 HUF/);
  assert.match(s.words, /mvm next/);
  assert.equal(s.body.snap.account, "3381", "still only the last 4 of an account");
  const n = fromNote({ text: "My gym locker code is 4471\nLocker 12, second floor" });
  assert.equal(n.title, "My gym locker code is 4471");
  assert.equal(n.body.text, "My gym locker code is 4471\nLocker 12, second floor");
  assert.throws(() => fromNote({ text: "   " }), /Write what Echo should remember/);
});

test("vectors: packed into bytes, cosine still right; ranking by meaning, words as a fallback", () => {
  const a = fakeEmbed("electricity bill"), b = fakeEmbed("power invoice"), c = fakeEmbed("gym locker code");
  const pa = unpackVector(packVector(a));
  assert.equal(pa.length, DIMS);
  assert.ok(cosine(pa, b) > 0.9, "same meaning, different words");
  assert.ok(cosine(pa, c) < 0.4);
  const items = [
    { id: "1", words: "electricity bill · mvm next", vec: packVector(a) },
    { id: "2", words: "my gym locker code is 4471", vec: packVector(c) },
    { id: "3", words: "car insurance renews", vec: null }, // saved while embedding was down
  ];
  assert.deepEqual(rank(items, { query: "what do I owe for power", qvec: fakeEmbed("power") }).map((h) => h.it.id), ["1"]);
  assert.deepEqual(rank(items, { query: "insurance", qvec: fakeEmbed("insurance") }).map((h) => h.it.id), ["3"], "found by its words");
  assert.deepEqual(rank(items, { query: "locker", qvec: null }).map((h) => h.it.id), ["2"], "no embeddings at all: words");
  assert.equal(keywordScore("what is the", "anything"), 0, "small words don't count");
});

test("saved dates: 7 days and 1 day before at 9:00 local, never twice, late ones skipped", () => {
  const dev = { prefs: { ...DEFAULT_PREFS, tz: TZ } };
  const items = [
    { id: "a", title: "Electricity bill", remind: true, dates: [{ date: "2026-10-20", what: "Pay MVM" }] },
    { id: "b", title: "Dentist", remind: true, dates: [{ date: "2026-10-09", what: "Dentist" }] },
    { id: "c", title: "Old", remind: true, dates: [{ date: "2026-10-01", what: "Gone" }] },
    { id: "d", title: "Muted", remind: false, dates: [{ date: "2026-10-10", what: "Muted" }] },
  ];
  syncDates(dev, items, TZ, NOW);
  assert.deepEqual(dev.memDates.map((e) => e.what), ["Dentist", "Pay MVM"], "no past dates, nothing muted");
  const dentist = dev.memDates[0];
  assert.equal(dentist.sent[7], true, "saved 3 days ahead: the 7-day reminder is already past, so it's skipped");
  assert.equal(dentist.sent[1], false);
  assert.deepEqual(comingUp(dev, NOW, TZ).map((c) => [c.what, c.days]), [["Dentist", 3], ["Pay MVM", 14]]);
  const sevenBefore = zonedToUtc("2026-10-13T09:00", TZ);
  const before = dueDateAlerts(dev, sevenBefore - 60_000);
  assert.equal(before.due.length, 0);
  assert.equal(before.stale, 1, "the dentist's reminder, 4 days late by now, is dropped rather than sent");
  const { due } = dueDateAlerts(dev, sevenBefore + 60_000);
  assert.deepEqual(due.map((d) => [d.entry.what, d.lead]), [["Pay MVM", 7]]);
  markSent(due[0]);
  assert.equal(dueDateAlerts(dev, sevenBefore + 120_000).due.length, 0, "never twice");
  const msg = alertMessage(due[0]);
  assert.equal(msg.title, "In 7 days: Pay MVM");
  assert.equal(msg.url, "/?view=memory&id=a");
  // Rebuilt after a change: what was sent stays sent.
  syncDates(dev, items, TZ, sevenBefore + 200_000);
  assert.equal(dev.memDates.find((e) => e.item === "a").sent[7], true);
  assert.equal(dev.memDates.some((e) => e.item === "b"), false, "a date that has passed is dropped");
});

test("the tick sends saved-date reminders, and the briefing shows what's coming up", async () => {
  const dev = { sub: { endpoint: "https://web.push.apple.com/x", keys: {} }, prefs: { ...DEFAULT_PREFS, tz: TZ }, reminders: [], lastBrief: "" };
  syncDates(dev, [{ id: "a", title: "Electricity bill", remind: true, dates: [{ date: "2026-10-20", what: "Pay MVM" }] }], TZ, NOW);
  const sent = [];
  const push = async (_sub, m) => { sent.push(m); return { ok: true }; };
  const at = zonedToUtc("2026-10-19T09:01", TZ);
  assert.equal(await runTick({ phones: { devices: { [DEVICE]: dev } }, now: at, tools: {}, push, storeBriefing: async () => {} }), true);
  assert.deepEqual(sent.map((m) => m.title), ["Tomorrow: Pay MVM"]);
  await runTick({ phones: { devices: { [DEVICE]: dev } }, now: at + 60_000, tools: {}, push, storeBriefing: async () => {} });
  assert.equal(sent.length, 1, "once");
  const b = await buildBriefing({ prefs: dev.prefs, dev, now: zonedToUtc("2026-10-15T07:00", TZ), tools: {} });
  assert.deepEqual(b.comingUp.map((c) => [c.what, c.days]), [["Pay MVM", 5]]);
  assert.match(b.body, /Coming up: Pay MVM in 5 days\./);
});

function memoryWith({ embed = async (t) => fakeEmbed(t) } = {}) {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const locks = new Map();
  const withKey = (key, empty, fn, { save = true } = {}) => {
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => { const v = (await store.get(key)) ?? empty(); const r = await fn(v); if (save) await store.set(key, v); return r; });
    locks.set(key, run.catch(() => {}));
    return run;
  };
  let n = 0;
  const dates = [];
  const memory = createMemory({ store, withKey, embed, now: () => NOW, newId: () => `id${++n}`.padEnd(8, "0"), onDates: async (d, items) => { dates.push(items.length); } });
  return { memory, store, dates };
}

test("memory: save, find by meaning, edit, delete; the same snap saved twice is one item", async () => {
  const { memory, store, dates } = memoryWith();
  const bill = await memory.add(DEVICE, fromSnap(cleanSnap(BILL), { snapId: "snap0001" }), { tz: TZ });
  assert.equal(bill.existing, false);
  assert.ok(bill.item.vec);
  assert.equal((await memory.add(DEVICE, fromSnap(cleanSnap(BILL), { snapId: "snap0001" }))).existing, true);
  const note = await memory.add(DEVICE, fromNote({ text: "My gym locker code is 4471" }));
  assert.equal((await memory.list(DEVICE)).length, 2);
  const hits = await memory.search(DEVICE, "how much is my power invoice?");
  assert.equal(hits[0].meta.id, bill.item.id);
  assert.equal(hits[0].body.snap.amount, 18420, "the full content comes with a hit");
  assert.equal((await memory.search(DEVICE, "pin for the locker"))[0].meta.id, note.item.id);
  const edited = await memory.update(DEVICE, note.item.id, { text: "Locker code changed to 5582", dates: [{ date: "2026-12-01", what: "Gym membership ends" }] }, { tz: TZ });
  assert.equal(edited.summary, "Locker code changed to 5582");
  assert.deepEqual(edited.dates, [{ date: "2026-12-01", what: "Gym membership ends" }]);
  assert.equal((await memory.get(DEVICE, note.item.id)).body.text, "Locker code changed to 5582");
  assert.equal((await memory.update(DEVICE, bill.item.id, { remind: false })).remind, false);
  await memory.remove(DEVICE, bill.item.id);
  assert.equal(await store.get(`memi:${DEVICE}:${bill.item.id}`), null, "its content goes too");
  assert.deepEqual((await memory.list(DEVICE)).map((x) => x.id), [note.item.id]);
  assert.ok(dates.length >= 4, "every change refreshes the saved dates");
});

test("memory without embeddings still works by words, and gets vectors on a later search", async () => {
  let up = false;
  const { memory } = memoryWith({ embed: async (t) => { if (!up) throw new Error("quota"); return fakeEmbed(t); } });
  const it = (await memory.add(DEVICE, fromNote({ text: "Car insurance renews on 1 November" }))).item;
  assert.equal(it.vec, null);
  assert.equal((await memory.search(DEVICE, "insurance"))[0].meta.id, it.id);
  up = true;
  await memory.search(DEVICE, "insurance");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok((await memory.list(DEVICE))[0].vec, "filled in afterwards");
});

test("Phone mode: Echo looks things up in memory and saves notes when asked", async () => {
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const bodies = [];
  const replies = [
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "c1", name: "recall_memory", args: { query: "locker code" } } }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "It's 4471." }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "c2", name: "save_memory", args: { text: "Passport expires 3 March 2027", date: "2027-03-03", date_what: "Passport expires" } } }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "Saved." }] } }] },
  ];
  const gemini = { model: "m", generate: async (b) => { bodies.push(structuredClone(b)); return replies.shift(); } };
  const cloud = createCloud({ gemini, store, now: () => NOW, tools: {} });
  const savedNotes = [];
  const memory = {
    upcoming: [{ date: "2026-10-20", what: "Pay MVM", title: "Electricity bill" }],
    search: async (q) => [{ text: `Saved 2026-10-01 · Notes: Gym locker\nMy gym locker code is 4471 (${q})` }],
    save: async (note) => { savedNotes.push(note); return { id: "n1", title: "Passport", dates: note.dates }; },
  };
  const r = await cloud.chat({ history: [], text: "what's my locker code?", context: { tz: TZ }, memory });
  assert.equal(r.reply, "It's 4471.");
  const sys = bodies[0].systemInstruction.parts[0].text;
  assert.match(sys, /Saved dates coming up: 2026-10-20 Pay MVM \(Electricity bill\)/);
  assert.ok(bodies[0].tools[0].functionDeclarations.some((d) => d.name === "recall_memory"));
  const fr = bodies[1].contents.at(-1).parts[0].functionResponse;
  assert.equal(fr.name, "recall_memory");
  assert.match(fr.response.results[0], /4471/);
  const s = await cloud.chat({ history: [], text: "remember my passport expires 3 March 2027", context: { tz: TZ }, memory });
  assert.deepEqual(savedNotes[0].dates, [{ date: "2027-03-03", what: "Passport expires" }]);
  assert.deepEqual(s.saved, [{ id: "n1", title: "Passport" }]);
  // Without memory bound, the tools aren't offered.
  replies.push({ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] });
  await cloud.chat({ history: [], text: "hi", context: {} });
  assert.equal(bodies.at(-1).tools[0].functionDeclarations.some((d) => d.name.endsWith("_memory")), false);
});

test("relay: save a scan to memory, see it in Saved, search it, its dates reach the tick, delete it", async () => {
  const answer = (obj) => ({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(obj) }] } }] });
  const replies = [answer(POLICY)];
  const gemini = { model: "m", generate: async () => replies.shift(), embed: async (t) => fakeEmbed(t) };
  const relay = createRelay({ secret: SECRET, now: () => NOW, gemini, fetchJson: async () => ({}) });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pass = signPass(relay.keys.pass, { device: DEVICE, gen: 0, now: NOW });
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "x-echo-pass": pass }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const get = (p) => fetch(base + p, { headers: { "x-echo-pass": pass } }).then((r) => r.json());
  try {
    const snap = await post("/cloud/snap", { image: "A".repeat(4000), context: { tz: TZ } });
    assert.equal(snap.snap.kind, "document");
    const saved = await post("/cloud/memory/save", { snapId: snap.id, tz: TZ });
    assert.equal(saved.item.group, "Documents");
    assert.deepEqual(saved.item.dates, [{ date: "2026-11-01", what: "Car insurance renews" }]);
    assert.equal(saved.item.indexed, true);
    assert.equal(saved.item.vec, undefined, "the phone never gets vectors");
    assert.equal((await get("/cloud/snaps")).items[0].saved, saved.item.id, "the scan shows it's saved");
    assert.equal((await post("/cloud/memory/save", { snapId: snap.id, tz: TZ })).existing, true);
    const note = await post("/cloud/memory/save", { note: { text: "Gym locker code 4471" }, tz: TZ });
    assert.equal(note.item.group, "Notes");
    assert.equal((await post("/cloud/memory/save", { note: { text: "" } })).status, 400);
    const list = await get(`/cloud/memory?tz=${TZ}`);
    assert.deepEqual(list.items.map((x) => x.title), ["Gym locker code 4471", "Car insurance · Allianz"], "newest first");
    assert.deepEqual(list.upcoming.map((u) => [u.what, u.days]), [["Car insurance renews", 26]]);
    const one = await get(`/cloud/memory?id=${saved.item.id}`);
    assert.equal(one.body.snap.title, "Car insurance · Allianz");
    const found = await post("/cloud/memory/search", { q: "when does the skoda policy renew" });
    assert.equal(found.items[0].id, saved.item.id);
    // Muting an item's reminders takes its dates off the tick's list.
    await post("/cloud/memory/update", { id: saved.item.id, remind: false, tz: TZ });
    assert.equal((await get(`/cloud/memory?tz=${TZ}`)).upcoming.length, 0);
    await post("/cloud/memory/update", { id: saved.item.id, remind: true, dates: [{ date: "2026-10-12", what: "Renewal letter due" }], tz: TZ });
    assert.deepEqual((await get(`/cloud/memory?tz=${TZ}`)).upcoming.map((u) => u.what), ["Renewal letter due"]);
    await post("/cloud/memory/delete", { id: saved.item.id, tz: TZ });
    assert.equal((await get("/cloud/snaps")).items[0].saved, null, "the scan can be saved again");
    assert.equal((await get(`/cloud/memory?tz=${TZ}`)).items.length, 1);
    assert.equal((await fetch(`${base}/cloud/memory`)).status, 401, "a cloud pass is needed");
  } finally { server.closeAllConnections?.(); server.close(); }
});
