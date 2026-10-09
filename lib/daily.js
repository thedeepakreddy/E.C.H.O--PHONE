/** Durable commitments. Notification delivery and completion are separate states. */
import { localParts, zonedToUtc, validTz, addDays, daysBetween } from "./time.js";

const DAY = 86400_000;
const fail = (message) => { throw Object.assign(new Error(message), { input: true }); };
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const dailyState = (dev) => (dev.daily ??= { tasks: [], dismissed: {}, ignoredSources: [] });
export function checkedLocal(when, tz) {
  if (!validTz(tz)) fail("Choose a valid time zone.");
  const at = zonedToUtc(when, tz);
  if (!Number.isFinite(at) || `${localParts(at, tz).date}T${localParts(at, tz).time}` !== when) fail("That local date or time doesn't exist. Choose another time.");
  return at;
}
export function cleanRepeat(raw) {
  if (!raw || raw === "none") return null;
  const r = typeof raw === "string" ? { frequency: raw } : raw;
  if (!["daily", "weekdays", "weekly", "monthly"].includes(r.frequency)) fail("Use daily, weekdays, weekly or monthly recurrence.");
  const interval = r.interval == null ? 1 : Number(r.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) fail("The repeat interval must be between 1 and 12.");
  const days = Array.isArray(r.days) ? [...new Set(r.days)] : [];
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) fail("Choose valid repeat weekdays.");
  return { frequency: r.frequency, interval, days };
}
/** Move the wall clock, not the UTC instant; monthly repeats retain their original day. */
export function nextLocal(local, rule, anchor = local) {
  const date = local.slice(0, 10), time = local.slice(11);
  let next;
  if (rule.frequency === "monthly") {
    const d = new Date(`${date}T12:00Z`), wanted = Number(anchor.slice(8, 10));
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + rule.interval);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(wanted, last)); next = d.toISOString().slice(0, 10);
  } else if (rule.frequency === "weekly" && rule.days.length) {
    const anchorDate = anchor.slice(0, 10), anchorWeekday = new Date(`${anchorDate}T12:00Z`).getUTCDay();
    const monday = addDays(anchorDate, -(anchorWeekday + 6) % 7);
    for (let n = 1; n <= 7 * rule.interval + 7; n++) {
      const candidate = addDays(date, n), weekday = new Date(`${candidate}T12:00Z`).getUTCDay();
      if (rule.days.includes(weekday) && Math.floor(daysBetween(monday, candidate) / 7) % rule.interval === 0) { next = candidate; break; }
    }
  } else if (rule.frequency === "weekdays") {
    next = date;
    for (let count = 0; count < rule.interval;) {
      next = addDays(next, 1);
      if (![0, 6].includes(new Date(`${next}T12:00Z`).getUTCDay())) count++;
    }
  } else {
    next = addDays(date, rule.frequency === "weekly" ? rule.interval * 7 : rule.interval);
  }
  return `${next}T${time}`;
}
function occurrenceAt(local, tz) {
  // During the spring-forward gap, use the first available minute after the requested time.
  let at = zonedToUtc(local, tz);
  if (`${localParts(at, tz).date}T${localParts(at, tz).time}` !== local) {
    const requested = Date.parse(`${local}Z`);
    for (let m = 1; m <= 180; m++) {
      const candidate = new Date(requested + m * 60_000).toISOString().slice(0, 16), t = zonedToUtc(candidate, tz);
      if (`${localParts(t, tz).date}T${localParts(t, tz).time}` === candidate) { at = t; break; }
    }
  }
  return at;
}
export function expandTask(task, now) {
  if (!task.when) return;
  task.occurrences ??= [];
  let local = task.next;
  for (let i = 0; local && i < 12000; i++) {
    const at = occurrenceAt(local, task.tz);
    if (task.occurrences.length && at > now + 7 * DAY) break;
    if (at > now - 7 * DAY || !task.repeat) task.occurrences.push({ id: `${task.id}:${local}`, when: local, at, status: "open", delivered: [] });
    task.next = task.repeat ? nextLocal(local, task.repeat, task.when) : null;
    if (at > now + 7 * DAY || !task.repeat) break;
    local = task.next;
  }
  task.occurrences = task.occurrences.slice(-48);
}
export function addDaily(dev, raw, now, id) {
  const st = dailyState(dev), text = clip(raw.text, 240);
  if (!text) fail("What should Echo keep track of?");
  if (raw.tz != null && !validTz(raw.tz)) fail("Choose a valid time zone.");
  const tz = raw.tz || "UTC";
  let when = raw.when ? String(raw.when) : null;
  const repeat = cleanRepeat(raw.repeat);
  if (repeat && !when) fail("A recurring reminder needs a first date and time.");
  if (when) {
    const at = checkedLocal(when, tz);
    if (at < now - DAY || at > now + 366 * DAY) fail("Choose a time from today to one year ahead.");
    const weekday = localParts(at, tz).weekday;
    if (repeat?.frequency === "weekdays" && [0, 6].includes(weekday)) {
      let date = when.slice(0, 10);
      while ([0, 6].includes(new Date(`${date}T12:00Z`).getUTCDay())) date = addDays(date, 1);
      when = `${date}T${when.slice(11)}`;
    } else if (repeat?.frequency === "weekly" && repeat.days.length && !repeat.days.includes(weekday)) {
      let date = when.slice(0, 10);
      do { date = addDays(date, 1); } while (!repeat.days.includes(new Date(`${date}T12:00Z`).getUTCDay()));
      when = `${date}T${when.slice(11)}`;
    }
  }
  const kind = ["task", "reminder", "bill"].includes(raw.kind) ? raw.kind : when ? "reminder" : "task";
  const fingerprint = `${kind}|${text.toLowerCase()}|${when}|${JSON.stringify(repeat)}`;
  const existing = st.tasks.find((t) => t.fingerprint === fingerprint && t.status !== "done");
  if (existing) return existing;
  if (st.tasks.length >= 200) fail("Your Today list is full. Remove an older item first.");
  let source = null;
  if (raw.source) {
    if (!["memory", "snap", "reminder"].includes(raw.source.type) || !clip(raw.source.id, 240) || !clip(raw.source.ref, 80)) fail("That source isn't supported.");
    source = { id: clip(raw.source.id, 240), type: raw.source.type, ref: clip(raw.source.ref, 80) };
  }
  const task = { id, text, kind, when, tz, repeat, next: when, createdAt: now, status: "open", fingerprint,
    notify: raw.notify !== false, threadId: clip(raw.threadId, 80) || null, source, occurrences: [] };
  if (!when) task.occurrences.push({ id: `${id}:anytime`, at: null, when: null, status: "open", delivered: [] });
  expandTask(task, now); st.tasks.push(task); return task;
}
export function dailyRows(dev, now, { completed = false } = {}) {
  const rows = [];
  for (const t of dailyState(dev).tasks) {
    expandTask(t, now);
    for (const o of t.occurrences) {
      if ((o.status === "done") !== completed) continue;
      if (completed && o.doneAt < now - 7 * DAY) continue;
      rows.push({ ...o, taskId: t.id, text: t.text, kind: t.kind, tz: t.tz, repeat: t.repeat,
        threadId: t.threadId, source: t.source, due: o.snoozedUntil ?? o.at });
    }
  }
  return rows.sort((a, b) => (a.due ?? now) - (b.due ?? now)).slice(0, 250);
}
export function actDaily(dev, raw, now) {
  const st = dailyState(dev), t = st.tasks.find((x) => x.id === raw.taskId);
  if (!t) fail("That item no longer exists.");
  if (raw.action === "delete") {
    if (t.source?.id) st.ignoredSources = [...new Set([...(st.ignoredSources ?? []), t.source.id])].slice(-500);
    st.tasks = st.tasks.filter((x) => x !== t); return { deleted: true };
  }
  expandTask(t, now);
  const o = t.occurrences.find((x) => x.id === raw.id);
  if (!o) fail("That occurrence no longer exists. Refresh Today.");
  if (raw.action === "done") {
    if (o.status !== "done") { o.status = "done"; o.doneAt = now; }
    if (!t.repeat) t.status = "done";
  } else if (raw.action === "undo") { o.status = "open"; delete o.doneAt; t.status = "open"; }
  else if (raw.action === "snooze") {
    if (o.status === "done") fail("This item is already done.");
    const until = checkedLocal(String(raw.until), raw.tz || t.tz);
    if (until <= now || until > now + 30 * DAY) fail("Snooze to a time in the next 30 days.");
    o.snoozedUntil = until; o.delivered = [];
  } else fail("Choose Done, Undo, Snooze or Remove.");
  return o;
}
export function subscriptions(dev) {
  const list = Object.entries(dev.subscriptions ?? {}).map(([id, s]) => ({ id, ...s }));
  if (!list.length && dev.sub) list.push({ id: "legacy", sub: dev.sub, phoneOnly: !!dev.phoneOnly });
  return list;
}
export function dropSubscription(dev, id) {
  if (id === "legacy") dev.sub = null;
  else { delete dev.subscriptions[id]; dev.sub = Object.values(dev.subscriptions)[0]?.sub ?? null; }
}
export async function notifyDaily(dev, now, push) {
  const subs = subscriptions(dev);
  for (const t of dailyState(dev).tasks) {
    expandTask(t, now);
    if (!t.notify) continue;
    const scheduled = t.occurrences.filter((o) => !o.snoozedUntil && o.at != null && o.at <= now).at(-1);
    // Catch up once per series; an explicit Snooze still fires independently of tomorrow's repeat.
    const due = [...t.occurrences.filter((o) => o.snoozedUntil && o.snoozedUntil <= now), ...(scheduled ? [scheduled] : [])].filter((o) => o.status !== "done");
    for (const o of due) for (const s of subs) {
      if (o.delivered.includes(s.id)) continue;
      const r = await push(s.sub, { title: t.kind === "bill" ? "Bill due" : "Don't forget", body: t.text, url: "/?view=today", tag: o.id }).catch(() => ({ ok: false }));
      if (r.ok || r.gone) o.delivered.push(s.id);
      if (r.gone) dropSubscription(dev, s.id);
    }
  }
}
