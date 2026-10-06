/**
 * Wall-clock time in a time zone, and back: what reminders, the briefing and
 * saved dates are all scheduled by.
 */
const fmts = new Map();
export function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return true; } catch { return false; }
}
/** The wall-clock date, time and weekday of an instant in a time zone. */
export function localParts(ts, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** "2026-10-08T18:00" on the wall in `tz`, as an instant (daylight saving included). */
export function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local));
  if (!m || !validTz(tz)) return NaN;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(t, tz);
    const shown = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), +p.time.slice(0, 2), +p.time.slice(3, 5));
    if (shown === want) break;
    t += want - shown;
  }
  return t;
}

/** A YYYY-MM-DD date moved by whole days. */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from one YYYY-MM-DD date to another. */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400_000);
