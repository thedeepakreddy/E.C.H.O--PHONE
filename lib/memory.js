/**
 * Memory: what the user saves for Echo to remember — what a snap found, or a
 * note in their own words — found again by meaning, with its dates turned into
 * reminders.
 *
 * Per phone, sealed in the store: an index that search reads in one go (each
 * item's title, summary, dates, a few hundred characters of its text and its
 * vector), and each item's full content under its own key. Vectors come from
 * Gemini's embedding model, 512 numbers stored as one byte each. When
 * embedding isn't available an item is still found by its words, and gets its
 * vector on a later search.
 *
 * Saved dates are copied into the phone's record in the tick's data
 * (`dev.memDates`), so the tick can send "in 7 days" and "tomorrow" without
 * reading the index every minute.
 */
import { snapContextText, recheckSnap } from "./snap.js";
import { validTz, localParts, zonedToUtc, addDays, daysBetween } from "./time.js";

export const MAX_ITEMS = 250;
export const DIMS = 512;
export const MAX_DATES = 8;
export const MAX_NOTE = 2000;
/** Reminders for a saved date: this many days before, at this time. */
export const LEADS = [7, 1];
export const ALERT_TIME = "09:00";
/** The briefing's "Coming up" looks this far ahead. */
export const COMING_DAYS = 14;
export const GROUP = { bill: "Bills", receipt: "Receipts", event: "Events", letter: "Documents", document: "Documents", note: "Notes", menu: "Other", product: "Other", other: "Other" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, n) : "");
const bad = (message) => Object.assign(new Error(message), { input: true });

/** Dates as the user or the model gave them: real days, each with what happens, no repeats. */
export function cleanDates(list) {
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    const date = String(d?.date ?? "");
    const what = clip(d?.what, 100);
    if (!DATE.test(date) || Number.isNaN(Date.parse(date)) || !what) continue;
    if (out.some((x) => x.date === date && x.what.toLowerCase() === what.toLowerCase())) continue;
    out.push({ date, what });
    if (out.length >= MAX_DATES) break;
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const money = (amount, currency) => (amount == null ? "" : `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`);

/** Every date in a snap worth a reminder. */
export function datesFromSnap(s) {
  const list = [];
  if (s.dueDate) list.push({ date: s.dueDate, what: `Pay ${s.payee || s.title}${s.amount != null ? ` (${money(s.amount, s.currency)})` : ""}` });
  if (s.eventStart) list.push({ date: s.eventStart.slice(0, 10), what: s.eventTitle || s.title });
  for (const d of s.deadlines ?? []) list.push(d);
  for (const d of s.keyDates ?? []) list.push(d);
  return cleanDates(list);
}

/** What search reads: lower-case, one line, short. */
const wordsOf = (text) => clip(String(text).toLowerCase().replace(/\s+/g, " "), 800);

/** A saved item made from a snap (as the phone shows it, corrected fields and all). */
export function fromSnap(snap, { snapId = null } = {}) {
  const s = recheckSnap(snap);
  const text = snapContextText(s);
  return {
    source: "snap", kind: s.kind, title: s.title, summary: s.summary, dates: datesFromSnap(s), snapId,
    words: wordsOf(text), embedText: text, body: { snap: s },
  };
}

/** A saved item made from the user's own words. */
export function fromNote({ text, title, dates }) {
  const t = clip(String(text ?? "").replace(/\r/g, ""), MAX_NOTE);
  if (!t) throw bad("Write what Echo should remember.");
  const firstLine = t.split("\n")[0];
  const name = clip(title, 80) || (firstLine.length > 60 ? `${firstLine.slice(0, 57).replace(/\s+\S*$/, "")}…` : firstLine);
  const ds = cleanDates(dates);
  const embedText = [name, t, ...ds.map((d) => `${d.date}: ${d.what}`)].join("\n");
  return { source: "note", kind: "note", title: name, summary: clip(t.replace(/\n+/g, " "), 200), dates: ds, words: wordsOf(embedText), embedText, body: { text: t } };
}

// ---- vectors -----------------------------------------------------------------

/** 512 numbers as 512 signed bytes, scaled to the largest (cosine ignores the scale). */
export function packVector(values) {
  const v = values.slice(0, DIMS);
  const max = Math.max(...v.map(Math.abs)) || 1;
  const bytes = Int8Array.from(v, (x) => Math.round((x / max) * 127));
  return Buffer.from(bytes.buffer).toString("base64");
}
export function unpackVector(b64) {
  const buf = Buffer.from(String(b64), "base64");
  return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
}
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const TOKEN = /[\p{L}\p{N}]{2,}/gu;
const STOP = new Set(["the", "and", "for", "what", "when", "where", "which", "who", "how", "was", "is", "are", "my", "me", "on", "in", "of", "to", "do", "did", "does", "it", "at", "a", "an", "about", "with", "this", "that", "i", "you", "your", "from", "have", "has", "be"]);
/** The share of the question's words found in an item's words. */
export function keywordScore(query, words) {
  const q = [...new Set(String(query).toLowerCase().match(TOKEN) ?? [])].filter((w) => !STOP.has(w));
  if (!q.length) return 0;
  return q.filter((w) => words.includes(w)).length / q.length;
}

/** The best matches: by meaning where there are vectors, by words where there aren't, words breaking ties. */
export function rank(items, { query, qvec = null, k = 5 }) {
  const scored = items.map((it) => {
    const kw = keywordScore(query, it.words ?? "");
    const sim = qvec && it.vec ? cosine(unpackVector(it.vec), qvec) : null;
    const score = sim == null ? kw * 0.8 : sim + 0.2 * kw;
    return { it, score, sim, kw };
  });
  return scored
    .filter((x) => x.kw > 0 || (x.sim != null && x.sim >= 0.5))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---- dates and reminders -------------------------------------------------------

const dateKey = (itemId, d) => `${itemId}|${d.date}|${d.what.toLowerCase()}`;

/**
 * The phone's saved dates, rebuilt from the index after any change. Reminders
 * already sent stay sent; for a new date, a reminder whose time has already
 * passed is skipped rather than sent late (saved 3 days ahead: only "tomorrow").
 */
export function syncDates(dev, items, tz, now) {
  const zone = validTz(tz) ? tz : validTz(dev.prefs?.tz) ? dev.prefs.tz : "UTC";
  const today = localParts(now, zone).date;
  const old = new Map((dev.memDates ?? []).map((e) => [e.key, e]));
  const out = [];
  for (const it of items) {
    if (it.remind === false) continue;
    for (const d of it.dates ?? []) {
      if (d.date < today) continue;
      const key = dateKey(it.id, d);
      const was = old.get(key);
      const sent = was ? { ...was.sent } : Object.fromEntries(LEADS.map((n) => [n, alertAt(d.date, n, zone) <= now]));
      out.push({ key, item: it.id, title: it.title, date: d.date, what: d.what, tz: was?.tz ?? zone, sent });
    }
  }
  dev.memDates = out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 400);
  return dev.memDates;
}
export const alertAt = (date, lead, tz) => zonedToUtc(`${addDays(date, -lead)}T${ALERT_TIME}`, tz);

/**
 * Reminders due now (the caller marks each sent once it's delivered). One more
 * than a day and a half late is dropped instead: `stale` says how many.
 */
export function dueDateAlerts(dev, now) {
  const due = [];
  let stale = 0;
  for (const e of dev.memDates ?? []) {
    for (const lead of LEADS) {
      if (e.sent?.[lead]) continue;
      const at = alertAt(e.date, lead, e.tz);
      if (!(at <= now)) continue;
      if (now - at < 36 * 3600_000) due.push({ entry: e, lead });
      else { e.sent = { ...e.sent, [lead]: true }; stale++; }
    }
  }
  return { due, stale };
}
export const markSent = ({ entry, lead }) => { entry.sent = { ...entry.sent, [lead]: true }; };
export function alertMessage({ entry, lead }) {
  const day = new Date(`${entry.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return {
    title: lead === 1 ? `Tomorrow: ${entry.what}` : `In ${lead} days: ${entry.what}`,
    body: `${entry.title} · ${day}`,
    url: `/?view=memory&id=${encodeURIComponent(entry.item)}`, tag: `m-${entry.item}-${entry.date}-${lead}`,
  };
}
/** Dates from today on that have passed are dropped. */
export function pruneDates(dev, now) {
  const before = dev.memDates?.length ?? 0;
  if (!before) return false;
  dev.memDates = dev.memDates.filter((e) => e.date >= localParts(now, e.tz).date);
  return dev.memDates.length !== before;
}
/** Saved dates in the next two weeks, for the briefing and for Echo. */
export function comingUp(dev, now, tz, days = COMING_DAYS) {
  const zone = validTz(tz) ? tz : "UTC";
  const today = localParts(now, zone).date;
  const until = addDays(today, days);
  return (dev.memDates ?? []).filter((e) => e.date >= today && e.date <= until)
    .map((e) => ({ date: e.date, what: e.what, title: e.title, item: e.item, days: daysBetween(today, e.date) }))
    .slice(0, 8);
}

/** A saved item as words for Echo to read (information, not instructions). */
export function contextText(meta, body) {
  const head = `Saved ${new Date(meta.at).toISOString().slice(0, 10)} · ${GROUP[meta.kind] ?? "Other"}: ${meta.title}`;
  const main = body?.snap ? snapContextText(body.snap) : body?.text ?? meta.summary;
  const dates = (meta.dates ?? []).map((d) => `Date: ${d.date} — ${d.what}`);
  return [head, main, ...(body?.snap ? [] : dates)].join("\n").slice(0, 2000);
}

/** What the phone sees of an item (no vector). */
export const forPhone = ({ vec, words, ...meta }) => ({ ...meta, group: GROUP[meta.kind] ?? "Other", indexed: Boolean(vec) });

// ---- the per-phone store -------------------------------------------------------

/**
 * Saving, changing, finding and deleting a phone's memory.
 *   withKey(key, empty, fn, opts)   read-change-write of one sealed key, one change at a time
 *   embed(text, {task})            the embedding call; may throw (no key, quota, network)
 *   onDates(device, items, tz)      the saved dates changed: refresh the tick's copy
 */
export function createMemory({ store, withKey, embed = null, onDates = async () => {}, now = Date.now, newId }) {
  const indexKey = (device) => `mem:${device}`;
  const bodyKey = (device, id) => `memi:${device}:${id}`;
  const withIndex = (device, fn, opts) => withKey(indexKey(device), () => ({ items: [] }), fn, opts);

  async function vectorFor(text, task = "RETRIEVAL_DOCUMENT") {
    if (!embed) return null;
    try { return await embed(text, { task, dims: DIMS }); } catch { return null; }
  }

  const list = (device) => withIndex(device, (ix) => ix.items, { save: false });

  async function get(device, id) {
    const meta = (await list(device)).find((x) => x.id === id);
    if (!meta) return null;
    return { meta, body: await store.get(bodyKey(device, id)).catch(() => null) };
  }

  /** Save a draft (fromSnap / fromNote). The same snap saved twice is the same item. */
  async function add(device, draft, { tz } = {}) {
    if (draft.snapId) {
      const same = (await list(device)).find((x) => x.snapId === draft.snapId);
      if (same) return { item: same, existing: true };
    }
    const values = await vectorFor(draft.embedText);
    const id = newId();
    const meta = {
      id, at: now(), updated: now(), source: draft.source, kind: draft.kind, title: draft.title, summary: draft.summary,
      dates: draft.dates, remind: true, ...(draft.snapId ? { snapId: draft.snapId } : {}),
      words: draft.words, vec: values ? packVector(values) : null,
    };
    await store.set(bodyKey(device, id), draft.body);
    const { items, dropped } = await withIndex(device, (ix) => {
      ix.items.push(meta);
      const dropped = ix.items.length > MAX_ITEMS ? ix.items.splice(0, ix.items.length - MAX_ITEMS) : [];
      return { items: ix.items.slice(), dropped };
    });
    for (const d of dropped) await store.del(bodyKey(device, d.id)).catch(() => {});
    await onDates(device, items, tz);
    return { item: meta, existing: false };
  }

  /** Change an item's title, its note text or its dates, or turn its reminders on or off. */
  async function update(device, id, patch, { tz } = {}) {
    const cur = await get(device, id);
    if (!cur) throw bad("That was deleted.");
    const { meta } = cur;
    let body = cur.body ?? {};
    let draft = null;
    if (meta.source === "note" && (patch.text != null || patch.title != null || patch.dates != null)) {
      draft = fromNote({ text: patch.text ?? body.text ?? meta.summary, title: patch.title ?? meta.title, dates: patch.dates ?? meta.dates });
    } else if (meta.source === "snap" && (patch.snap != null || patch.title != null || patch.dates != null)) {
      const snap = patch.snap ?? body.snap ?? {};
      draft = fromSnap(patch.title != null ? { ...snap, title: patch.title } : snap, { snapId: meta.snapId });
      // Dates the user edited stay theirs until the snap's own fields change.
      if (patch.dates != null) draft.dates = cleanDates(patch.dates);
      else if (patch.snap == null) draft.dates = meta.dates;
    }
    const values = draft ? await vectorFor(draft.embedText) : null;
    if (draft) { body = draft.body; await store.set(bodyKey(device, id), body); }
    const { item, items } = await withIndex(device, (ix) => {
      const it = ix.items.find((x) => x.id === id);
      if (!it) throw bad("That was deleted.");
      if (draft) Object.assign(it, { title: draft.title, summary: draft.summary, dates: draft.dates, words: draft.words, vec: values ? packVector(values) : null });
      if (typeof patch.remind === "boolean") it.remind = patch.remind;
      it.updated = now();
      return { item: { ...it }, items: ix.items.slice() };
    });
    await onDates(device, items, tz);
    return item;
  }

  async function remove(device, id, { tz } = {}) {
    const items = await withIndex(device, (ix) => { ix.items = ix.items.filter((x) => x.id !== id); return ix.items.slice(); });
    await store.del(bodyKey(device, id)).catch(() => {});
    await onDates(device, items, tz);
  }

  /**
   * The items that best answer a question, with their full content. Items
   * saved while embedding was down get their vectors here, a few at a time.
   */
  async function search(device, query, { k = 5, withBodies = true } = {}) {
    const q = clip(query, 300);
    if (!q) return [];
    const items = await list(device);
    if (!items.length) return [];
    const qvec = await vectorFor(q, "RETRIEVAL_QUERY");
    if (qvec) void backfill(device, items).catch(() => {});
    const hits = rank(items, { query: q, qvec, k });
    if (!withBodies) return hits.map((h) => ({ meta: h.it, score: h.score }));
    return Promise.all(hits.map(async (h) => ({ meta: h.it, score: h.score, body: await store.get(bodyKey(device, h.it.id)).catch(() => null) })));
  }

  async function backfill(device, items, max = 3) {
    const missing = items.filter((x) => !x.vec).slice(0, max);
    for (const it of missing) {
      const body = await store.get(bodyKey(device, it.id)).catch(() => null);
      const text = body?.snap ? snapContextText(body.snap) : [it.title, body?.text ?? it.summary].join("\n");
      const values = await vectorFor(text);
      if (!values) return;
      await withIndex(device, (ix) => { const x = ix.items.find((y) => y.id === it.id); if (x && !x.vec) x.vec = packVector(values); });
    }
  }

  return { list, get, add, update, remove, search };
}
