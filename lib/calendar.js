/**
 * Calendar files for "Add to Calendar" and "Remind me".
 *
 * A Home Screen app on iPhone can't hand an event straight to Calendar, but
 * Safari opening a text/calendar file shows the system's "Add" sheet. Times
 * are floating (no time zone), so the event lands at the same wall-clock time
 * the user asked for, wherever the phone is.
 */
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "2026-10-08T15:00" plus minutes, still as a floating local time. */
export function addMinutes(local, minutes) {
  const m = LOCAL_TIME.exec(local);
  if (!m) throw new Error("bad time");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + minutes * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const icsTime = (local) => `${local.replace(/[-:]/g, "")}00`;
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** RFC 5545 folds lines at 75 octets; continuation lines start with a space. */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function validEvent(e) {
  return Boolean(e && typeof e.title === "string" && e.title.trim() && LOCAL_TIME.test(String(e.start)) && (!e.end || LOCAL_TIME.test(String(e.end))));
}

export function buildIcs(e, { uid, now = Date.now() }) {
  const end = e.end && e.end > e.start ? e.end : addMinutes(e.start, Number(e.durationMin) > 0 ? Number(e.durationMin) : 60);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const alert = Number.isInteger(e.alertMinutes) && e.alertMinutes >= 0 ? e.alertMinutes : 30;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Echo//Echo Phone//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${uid}@echo-phone`, `DTSTAMP:${stamp}`,
    `DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(end)}`,
    `SUMMARY:${esc(e.title.trim().slice(0, 120))}`,
    ...(e.location ? [`LOCATION:${esc(String(e.location).slice(0, 200))}`] : []),
    ...(e.notes ? [`DESCRIPTION:${esc(String(e.notes).slice(0, 1000))}`] : []),
    "BEGIN:VALARM", `TRIGGER:-PT${alert}M`, "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title.trim().slice(0, 120))}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
