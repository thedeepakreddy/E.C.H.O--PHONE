/**
 * The 5-minute tick.
 *
 * The phone app can't run in the background and Render's free plan has no
 * scheduler, so Upstash QStash calls POST /cron/tick every 5 minutes. That
 * keeps the relay awake (no cold starts) and is where timed work runs: the
 * morning briefing and reminders arrive in later updates.
 *
 * The schedule is created by the relay itself at start-up, with a fixed id so
 * a restart updates it instead of adding another. QStash forwards our own
 * bearer token (derived from RELAY_SECRET), and /cron/tick checks it.
 */
export const TICK_CRON = "*/5 * * * *";
export const SCHEDULE_ID = "echo-tick";

export async function ensureSchedule({ qstashToken, qstashUrl = "https://qstash.upstash.io", publicUrl, cronToken, fetchImpl = fetch }) {
  if (!qstashToken || !publicUrl) return { ok: false, reason: "not configured" };
  const target = `${publicUrl.replace(/\/+$/, "")}/cron/tick`;
  const res = await fetchImpl(`${qstashUrl.replace(/\/+$/, "")}/v2/schedules/${target}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${qstashToken}`,
      "content-type": "application/json",
      "upstash-cron": TICK_CRON,
      "upstash-schedule-id": SCHEDULE_ID,
      "upstash-method": "POST",
      "upstash-forward-authorization": `Bearer ${cronToken}`,
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { ok: false, reason: `QStash answered ${res.status}` };
  return { ok: true };
}
