import { test } from "node:test";
import assert from "node:assert/strict";
import { addDaily, dailyRows, actDaily, nextLocal, notifyDaily } from "../lib/daily.js";
import { runTick } from "../lib/briefing.js";

const NOW = Date.parse("2026-10-09T10:00Z"), tz = "Europe/Budapest";
test("monthly reminders clamp short months without losing their original day", () => {
  const rule = { frequency: "monthly", interval: 1, days: [] }, anchor = "2027-01-31T09:00";
  const feb = nextLocal(anchor, rule, anchor); assert.equal(feb, "2027-02-28T09:00");
  assert.equal(nextLocal(feb, rule, anchor), "2027-03-31T09:00");
  assert.equal(nextLocal("2028-01-31T09:00", rule, "2028-01-31T09:00"), "2028-02-29T09:00");
});
test("recurrence preserves wall time through DST and supports selected weekdays", () => {
  const dev = {}, now = Date.parse("2026-10-23T06:00Z");
  addDaily(dev, { text: "Standup", when: "2026-10-24T09:00", tz, repeat: "daily" }, now, "standup");
  const rows = dailyRows(dev, now), sat = rows.find((r) => r.when.startsWith("2026-10-24")), sun = rows.find((r) => r.when.startsWith("2026-10-25"));
  assert.equal(sun.at - sat.at, 25 * 3600_000); assert.equal(sun.when, "2026-10-25T09:00");
  const rule = { frequency: "weekly", interval: 2, days: [1, 3] };
  assert.equal(nextLocal("2026-10-05T09:00", rule, "2026-10-05T09:00"), "2026-10-07T09:00");
  assert.equal(nextLocal("2026-10-07T09:00", rule, "2026-10-05T09:00"), "2026-10-19T09:00");
  assert.equal(nextLocal("2026-10-09T09:00", { frequency: "weekdays", interval: 2, days: [] }), "2026-10-13T09:00");
});
test("nonexistent initial times are rejected; spring repeats use the first available minute", () => {
  const now = Date.parse("2027-03-26T10:00Z"), dev = {};
  assert.throws(() => addDaily(dev, { text: "Gap", when: "2027-03-28T02:30", tz }, now, "gap"), /doesn't exist/);
  assert.throws(() => addDaily(dev, { text: "Bad date", when: "2027-02-30T09:00", tz }, now, "bad"), /doesn't exist/);
  addDaily(dev, { text: "Daily", when: "2027-03-27T02:30", tz, repeat: "daily" }, now, "daily");
  const gap = dailyRows(dev, now).find((r) => r.when === "2027-03-28T02:30");
  assert.equal(new Date(gap.at).toISOString(), "2027-03-28T01:00:00.000Z");
});
test("Done is idempotent and Snooze affects one occurrence, including undated tasks", () => {
  const dev = {}, t = addDaily(dev, { text: "Review", when: "2026-10-09T13:00", tz, repeat: "daily" }, NOW, "review");
  const [first, next] = dailyRows(dev, NOW);
  actDaily(dev, { taskId: t.id, id: first.id, action: "snooze", until: "2026-10-10T14:00" }, NOW);
  assert.equal(t.occurrences.find((o) => o.id === next.id).at, next.at);
  actDaily(dev, { taskId: t.id, id: first.id, action: "done" }, NOW);
  actDaily(dev, { taskId: t.id, id: first.id, action: "done" }, NOW + 10);
  assert.equal(dailyRows(dev, NOW, { completed: true }).length, 1);
  assert.equal(t.occurrences[0].doneAt, NOW);
  const anytime = addDaily(dev, { text: "Write a draft", tz }, NOW, "draft");
  actDaily(dev, { taskId: anytime.id, id: "draft:anytime", action: "snooze", until: "2026-10-10T09:00" }, NOW);
  assert.ok(dailyRows(dev, NOW).find((r) => r.taskId === "draft").due);
  assert.throws(() => actDaily(dev, { taskId: t.id, id: first.id, action: "snooze", until: "2026-10-10T15:00" }, NOW), /already done/);
});
test("captures deduplicate retries and notification delivery never completes a task", async () => {
  const dev = { subscriptions: { phoneone: { sub: { endpoint: "one" }, phoneOnly: true }, phonetwo: { sub: { endpoint: "two" }, phoneOnly: true } } };
  const raw = { text: "Call Sam", when: "2026-10-09T12:00", tz };
  const a = addDaily(dev, raw, NOW, "a"), b = addDaily(dev, raw, NOW, "b"); assert.equal(a.id, b.id);
  const sent = [], push = async (sub) => { sent.push(sub.endpoint); return { ok: sub.endpoint === "one" }; };
  await notifyDaily(dev, NOW + 1000, push); await notifyDaily(dev, NOW + 2000, push);
  assert.deepEqual(sent, ["one", "two", "two"]);
  assert.equal(dailyRows(dev, NOW)[0].status, "open");
  actDaily(dev, { taskId: a.id, id: a.occurrences[0].id, action: "snooze", until: "2026-10-09T14:00" }, NOW);
  await notifyDaily(dev, NOW + 7200_000, async (sub) => { sent.push(sub.endpoint); return { ok: true }; });
  assert.deepEqual(sent.slice(-2), ["one", "two"]);
});
test("snoozed repeats fire separately and weekday series skip weekend starts", async () => {
  const dev = { sub: { endpoint: "one" }, phoneOnly: true }, now = Date.parse("2026-10-09T08:00Z");
  const task = addDaily(dev, { text: "Check mail", when: "2026-10-09T09:00", tz: "UTC", repeat: "daily" }, now, "mail");
  const first = task.occurrences[0];
  actDaily(dev, { taskId: task.id, id: first.id, action: "snooze", until: "2026-10-10T14:00", tz: "UTC" }, now);
  const sent = [], push = async (_sub, m) => { sent.push(m.tag); return { ok: true }; };
  await notifyDaily(dev, Date.parse("2026-10-10T09:00Z"), push);
  await notifyDaily(dev, Date.parse("2026-10-10T14:00Z"), push);
  assert.deepEqual(sent, ["mail:2026-10-10T09:00", first.id]);
  const weekdays = addDaily(dev, { text: "Weekday", when: "2026-10-10T09:00", tz: "UTC", repeat: "weekdays" }, now, "weekdays");
  assert.equal(weekdays.when, "2026-10-12T09:00");
});
test("multi-phone briefing scopes do not leak a Mac digest to recovered Phone sessions", async () => {
  const phones = { devices: { acct: { phoneOnly: false, prefs: { on: true, time: "12:00", days: "daily", tz }, reminders: [],
    subscriptions: { pairedone: { sub: { endpoint: "mac" }, phoneOnly: false }, recovered: { sub: { endpoint: "phone" }, phoneOnly: true } } } } };
  const briefings = [], push = async () => ({ ok: true });
  await runTick({ phones, now: NOW, tools: {}, macOnline: true, push, digest: (_id, dev) => dev.phoneOnly ? null : { at: NOW, email: [{ from: "private", subject: "Secret" }] }, storeBriefing: (_id, b, scope) => briefings.push({ b, scope }) });
  assert.equal(briefings.length, 2);
  assert.equal(briefings.find((b) => b.scope).b.email, undefined);
  assert.equal(briefings.find((b) => !b.scope).b.email[0].subject, "Secret");
  await runTick({ phones, now: NOW + 1000, tools: {}, macOnline: true, push, digest: () => null, storeBriefing: () => assert.fail("duplicate briefing") });
});
