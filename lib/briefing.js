/**
 * The morning briefing and Echo's reminders — the timed work the tick does.
 *
 * Each phone (by its device id) has its notification subscription, its
 * briefing settings and its reminders, all kept sealed in the store under one
 * key. Every tick: reminders that are due are sent, and a phone whose briefing
 * time has passed today (in its own time zone) gets its briefing — once a day,
 * and not at all if the tick comes more than three hours late.
 *
 * The briefing is built from what's here, with no AI call: weather, world
 * events near the phone, the Mac's last digest (calendar, unread email,
 * finished missions), today's reminders and saved dates coming up.
 */
import { sendPush } from "./push.js";
import { validTz, localParts, zonedToUtc } from "./time.js";
import { comingUp, dueDateAlerts, markSent, alertMessage, pruneDates } from "./memory.js";

export const BRIEF_LATE_MIN = 180;
export const MAX_REMINDERS = 50;
export const NEAR_QUAKE_KM = 500;
export const NEAR_STORM_KM = 1000;
export const DEFAULT_PREFS = { on: false, time: "07:00", days: "daily", tz: "UTC", place: null };

export { validTz, localParts, zonedToUtc };

export function cleanPrefs(p, old = DEFAULT_PREFS) {
  const out = { ...DEFAULT_PREFS, ...old };
  if (typeof p?.on === "boolean") out.on = p.on;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p?.time))) out.time = p.time;
  if (["daily", "weekdays", "weekends"].includes(p?.days)) out.days = p.days;
  if (p?.tz && validTz(p.tz)) out.tz = p.tz;
  if (p && "place" in p) {
    const pl = p.place;
    out.place = pl && Number.isFinite(+pl.lat) && Number.isFinite(+pl.lon) && Math.abs(+pl.lat) <= 90 && Math.abs(+pl.lon) <= 180
      ? { name: String(pl.name ?? "").slice(0, 60) || "Your location", lat: +pl.lat, lon: +pl.lon } : null;
  }
  return out;
}

export function briefingDue(dev, now) {
  const p = dev?.prefs;
  if (!p?.on || !dev.sub) return false;
  const lp = localParts(now, p.tz);
  if (p.days === "weekdays" && (lp.weekday === 0 || lp.weekday === 6)) return false;
  if (p.days === "weekends" && lp.weekday > 0 && lp.weekday < 6) return false;
  if (dev.lastBrief === lp.date || lp.time < p.time) return false;
  const [h, m] = p.time.split(":").map(Number);
  const [nh, nm] = lp.time.split(":").map(Number);
  return nh * 60 + nm - (h * 60 + m) <= BRIEF_LATE_MIN;
}

export function addReminder(dev, { text, when, tz }, now, id) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!t) throw Object.assign(new Error("What should I remind you about?"), { input: true });
  const at = zonedToUtc(when, tz);
  if (!Number.isFinite(at)) throw Object.assign(new Error("That reminder needs a date and time."), { input: true });
  if (at < now - 60_000) throw Object.assign(new Error("That time has already passed."), { input: true });
  if (at > now + 366 * 86400_000) throw Object.assign(new Error("That's more than a year away."), { input: true });
  dev.reminders = (dev.reminders ?? []).filter((r) => !r.sent).slice(-(MAX_REMINDERS - 1));
  const r = { id, text: t, at, when: String(when), tz, sent: false };
  dev.reminders.push(r);
  return r;
}

const WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm" };
function weatherTip(code, high, low) {
  if (code >= 95) return "Thunderstorms about: stay in if you can.";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82) || (code >= 51 && code <= 57)) return "Take an umbrella.";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Snow: allow extra time.";
  if (Number.isFinite(low) && low <= 2) return "Cold start: wrap up.";
  if (Number.isFinite(high) && high >= 30) return "Hot day: drink plenty of water.";
  return "";
}
function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const ACUTE = new Set(["severeStorms", "volcanoes", "floods", "landslides", "wildfires"]);
const clipTitle = (t) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > 90 ? `${s.slice(0, 87).replace(/[\s,;]+\S*$/, "")}…` : s; };

/** One phone's briefing for today. */
/**
 * Today's events as the iPhone sent them (a Shortcut posts them each morning):
 * one per line, "start | title | location", the start in ISO 8601. JSON
 * ({ events: [...] } or { events: "<lines>" }) is accepted too.
 */
export function parsePhoneCalendar(body) {
  let data = body;
  if (typeof body === "string") { try { data = JSON.parse(body); } catch { data = body; } }
  if (data && typeof data === "object" && !Array.isArray(data)) data = data.events ?? data.text ?? "";
  const lines = Array.isArray(data) ? data : String(data ?? "").split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    const parts = typeof line === "string" ? line.split("|").map((x) => x.trim()) : [line?.start, line?.title, line?.location];
    const start = Date.parse(String(parts[0] ?? ""));
    const title = String(parts[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!Number.isFinite(start) || !title) continue;
    events.push({ title, start: new Date(start).toISOString(), location: String(parts[2] ?? "").trim().slice(0, 120) || null });
    if (events.length >= 40) break;
  }
  return events;
}

export async function buildBriefing({ prefs, dev, now, tools, digest, macOnline, phoneCal }) {
  const tz = prefs.tz;
  const today = localParts(now, tz).date;
  const b = { date: today, at: now, place: prefs.place?.name ?? null, macOnline: Boolean(macOnline) };
  if (prefs.place) {
    try {
      const w = await tools.weather(prefs.place.lat, prefs.place.lon);
      b.weather = { temp: Math.round(w.temp), high: Math.round(w.high), low: Math.round(w.low), text: WMO[w.code] ?? "", tip: weatherTip(w.code, w.high, w.low) };
    } catch { /* the card says weather is unavailable */ }
  }
  if (digest) {
    b.macAsOf = digest.at;
    if (Array.isArray(digest.calendar)) {
      b.calendar = digest.calendar
        .map((e) => ({ title: e.title, start: Date.parse(e.start) }))
        .filter((e) => Number.isFinite(e.start) && localParts(e.start, tz).date === today)
        .sort((x, y) => x.start - y.start)
        .map((e) => ({ title: e.title, time: localParts(e.start, tz).time }))
        .slice(0, 10);
    }
    if (Array.isArray(digest.email)) b.email = digest.email.slice(0, 5);
    b.missions = (digest.missions ?? []).filter((m) => m.at > now - 86400_000).slice(0, 5);
    if (b.calendar) b.calendarFrom = "mac";
  }
  // The iPhone's own calendar wins when it was sent today.
  if (phoneCal && localParts(phoneCal.at, tz).date === today) {
    b.calendar = phoneCal.events
      .map((e) => ({ title: e.title, start: Date.parse(e.start), location: e.location }))
      .filter((e) => Number.isFinite(e.start) && localParts(e.start, tz).date === today)
      .sort((x, y) => x.start - y.start)
      .map((e) => ({ title: e.title, time: localParts(e.start, tz).time, ...(e.location ? { location: e.location } : {}) }))
      .slice(0, 12);
    b.calendarFrom = "iphone";
    b.calendarAt = phoneCal.at;
  }
  b.reminders = (dev.reminders ?? []).filter((r) => !r.sent && localParts(r.at, tz).date === today)
    .sort((x, y) => x.at - y.at).map((r) => ({ text: r.text, time: localParts(r.at, tz).time }));
  b.comingUp = comingUp(dev, now, tz);
  if (prefs.place) {
    try {
      const raw = (await tools.worldRaw()) ?? {};
      const here = { lat: prefs.place.lat, lon: prefs.place.lon };
      const day = now - 86400_000;
      b.near = {
        quakes: (raw.earthquakes?.earthquakes ?? [])
          .filter((q) => q.time > day && q.magnitude >= 4.5 && Number.isFinite(q.lat) && km(here, { lat: q.lat, lon: q.lng }) <= NEAR_QUAKE_KM)
          .map((q) => ({ magnitude: q.magnitude, place: String(q.place ?? ""), tsunami: Boolean(q.tsunami) })).slice(0, 3),
        // Things that can change your day; slow, continent-wide ones (drought, haze) aren't news nearby.
        storms: (raw.weather?.events ?? [])
          .filter((e) => ACUTE.has(e.category) && Number.isFinite(e.lat) && km(here, { lat: e.lat, lon: e.lng }) <= NEAR_STORM_KM)
          .map((e) => ({ title: clipTitle(e.title), type: String(e.type ?? "") })).slice(0, 3),
      };
      const war = (raw.conflicts?.zones ?? []).find((z) => z.severity === "war" && z.events?.[0]?.title);
      if (war) b.world = { zone: war.label, headline: war.events[0].title };
    } catch { /* world card left out */ }
  }
  // The notification itself: a short title and the few things worth knowing.
  b.title = b.weather ? `Good morning · ${b.weather.temp}°, ${b.weather.text.toLowerCase()}` : "Good morning";
  const lines = [];
  if (b.calendar) lines.push(b.calendar.length ? `${plural(b.calendar.length, "event")} today, first at ${b.calendar[0].time}.` : "Nothing on your calendar today.");
  if (b.email?.length) lines.push(`${plural(b.email.length, "email")} need${b.email.length === 1 ? "s" : ""} you.`);
  if (b.reminders.length) lines.push(`${plural(b.reminders.length, "reminder")} today.`);
  if (b.comingUp.length) { const c = b.comingUp[0]; lines.push(`Coming up: ${c.what} ${c.days === 0 ? "today" : c.days === 1 ? "tomorrow" : `in ${c.days} days`}.`); }
  if (b.near?.quakes.length) lines.push(`Earthquake M${b.near.quakes[0].magnitude.toFixed(1)} nearby.`);
  if (b.missions?.length) lines.push(`Your Mac finished "${b.missions[0].goal.slice(0, 50)}".`);
  if (!lines.length && b.weather?.tip) lines.push(b.weather.tip);
  b.body = lines.join(" ") || "Tap for today's briefing.";
  return b;
}

/**
 * One tick: send due reminders and briefings. `phones` is the sealed state
 * ({ devices: {...} }), changed in place; the caller saves it.
 */
export async function runTick({ phones, now, tools, digest, macOnline, push, storeBriefing, phoneCalendar }) {
  let changed = false;
  for (const [id, dev] of Object.entries(phones.devices ?? {})) {
    dev.reminders ??= [];
    if (dev.sub) {
      for (const r of dev.reminders.filter((x) => !x.sent && x.at <= now)) {
        const res = await push(dev.sub, { title: "Reminder", body: r.text, url: "/?view=chat", tag: `r-${r.id}` }).catch(() => ({ ok: false }));
        if (res.ok || res.gone) { r.sent = true; changed = true; }
        if (res.gone) { dev.sub = null; changed = true; break; }
      }
    }
    // Saved dates (lib/memory.js): "in 7 days" and "tomorrow".
    const dated = dueDateAlerts(dev, now);
    if (dated.stale) changed = true;
    if (dev.sub) {
      for (const a of dated.due) {
        const res = await push(dev.sub, alertMessage(a)).catch(() => ({ ok: false }));
        if (res.ok || res.gone) { markSent(a); changed = true; }
        if (res.gone) { dev.sub = null; break; }
      }
    }
    if (pruneDates(dev, now)) changed = true;
    if (briefingDue(dev, now)) {
      const b = await buildBriefing({ prefs: dev.prefs, dev, now, tools, digest: typeof digest === "function" ? await digest(id, dev) : digest, macOnline: !dev.phoneOnly && macOnline, phoneCal: phoneCalendar ? await phoneCalendar(id) : null });
      await storeBriefing(id, b);
      const res = await push(dev.sub, { title: b.title, body: b.body, url: "/?view=briefing", tag: "briefing" }).catch(() => ({ ok: false }));
      if (res.ok || res.gone) { dev.lastBrief = b.date; changed = true; }
      if (res.gone) dev.sub = null;
    }
    const before = dev.reminders.length;
    dev.reminders = dev.reminders.filter((r) => (r.sent ? r.at > now - 2 * 86400_000 : r.at > now - 3 * 86400_000));
    if (dev.reminders.length !== before) changed = true;
  }
  return changed;
}

export { sendPush };
