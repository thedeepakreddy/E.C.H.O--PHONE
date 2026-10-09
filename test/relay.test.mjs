import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRelay, summariseWorld, LOGIN_LIMIT } from "../server.js";

const SECRET = "s".repeat(48);

/** A relay on a random local port, with helpers for the phone and for Echo. */
async function start(opts = {}) {
  const relay = createRelay({ secret: SECRET, pollMs: 300, requestMs: 1500, ...opts });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) } });
  return { relay, base, agent, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("refuses to start without a long secret", () => {
  assert.throws(() => createRelay({ secret: "" }));
  assert.throws(() => createRelay({ secret: "short" }));
});

test("health and the app shell are public; a path out of public/ is not", async () => {
  const r = await start();
  try {
    assert.equal((await fetch(r.base + "/healthz").then((x) => x.json())).echo, "offline");
    const page = await fetch(r.base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal((await fetch(r.base + "/../server.js")).status, 404);
    assert.equal((await fetch(r.base + "/%2e%2e/server.js")).status, 404);
    assert.equal((await fetch(r.base + "/nothing.html")).status, 404);
  } finally { await r.close(); }
});

test("Echo's side needs the secret; without it the relay looks like nothing is there", async () => {
  const r = await start();
  try {
    assert.equal((await fetch(r.base + "/agent/poll")).status, 404);
    assert.equal((await fetch(r.base + "/agent/poll", { headers: { authorization: "Bearer " + "x".repeat(48) } })).status, 404);
  } finally { await r.close(); }
});

test("while Echo is offline the phone is told so, not left hanging", async () => {
  const r = await start();
  try {
    const res = await fetch(r.base + "/status?t=abc");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "offline");
  } finally { await r.close(); }
});

test("a phone request reaches Echo, and Echo's answer reaches the phone", async () => {
  const r = await start();
  try {
    assert.equal((await r.agent("/agent/poll")).status, 204); // marks Echo online
    const poll = r.agent("/agent/poll").then((x) => x.json());
    const phone = fetch(r.base + "/login?t=abc", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1", cookie: "js=old" },
      body: JSON.stringify({ password: "pw" }),
    });
    const job = await poll;
    assert.equal(job.method, "POST");
    assert.equal(job.path, "/login?t=abc");
    assert.equal(job.ip, "203.0.113.9", "the phone's own address, for Echo's lockout");
    assert.equal(job.headers.cookie, "js=old");
    assert.deepEqual(JSON.parse(Buffer.from(job.body, "base64").toString()), { password: "pw" });
    const reply = await r.agent("/agent/reply", { method: "POST", body: JSON.stringify({
      id: job.id, status: 200, headers: { "content-type": "application/json", "set-cookie": "js=new; Secure", "x-evil": "1" },
      body: Buffer.from('{"ok":true}').toString("base64"),
    }) });
    assert.equal(reply.status, 204);
    const res = await phone;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), "js=new; Secure");
    assert.equal(res.headers.get("x-evil"), null, "only content-type, set-cookie and cache-control pass through");
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await r.close(); }
});

test("a request made before Echo polls waits for it; one Echo never answers times out", async () => {
  const r = await start();
  try {
    await r.agent("/agent/poll");
    const phone = fetch(r.base + "/status?t=abc");
    await new Promise((x) => setTimeout(x, 50));
    const job = await r.agent("/agent/poll").then((x) => x.json());
    assert.equal(job.path, "/status?t=abc");
    const res = await phone; // never answered
    assert.equal(res.status, 504);
    const late = await r.agent("/agent/reply", { method: "POST", body: JSON.stringify({ id: job.id, status: 200, body: "" }) });
    assert.equal(late.status, 404, "an answer after the timeout matches nothing");
  } finally { await r.close(); }
});

test("when Echo hangs up, the phone hears it's offline at once", async () => {
  const r = await start();
  try {
    const ctl = new AbortController();
    const poll = r.agent("/agent/poll", { signal: ctl.signal }).catch(() => null);
    await new Promise((x) => setTimeout(x, 50));
    assert.equal((await fetch(r.base + "/healthz").then((x) => x.json())).echo, "online");
    ctl.abort(); // Echo quits with its poll still open
    await poll;
    await new Promise((x) => setTimeout(x, 50));
    assert.equal((await fetch(r.base + "/healthz").then((x) => x.json())).echo, "offline");
    assert.equal((await fetch(r.base + "/status?t=abc")).status, 503);
  } finally { await r.close(); }
});

test("password guessing is capped per address before it reaches Echo", async () => {
  const r = await start();
  try {
    await r.agent("/agent/poll");
    const statuses = [];
    for (let i = 0; i <= LOGIN_LIMIT; i++) {
      const p = fetch(r.base + "/login?t=abc", { method: "POST", headers: { "x-forwarded-for": "198.51.100.7" }, body: "{}" });
      if (i < LOGIN_LIMIT) {
        const job = await r.agent("/agent/poll").then((x) => x.json());
        await r.agent("/agent/reply", { method: "POST", body: JSON.stringify({ id: job.id, status: 401, body: "" }) });
      }
      statuses.push((await p).status);
    }
    assert.equal(statuses.at(-1), 429);
    assert.ok(statuses.slice(0, -1).every((s) => s === 401));
  } finally { await r.close(); }
});

test("signing in correctly never uses up the guess allowance", async () => {
  const r = await start();
  try {
    await r.agent("/agent/poll");
    const attempt = async (status) => {
      const p = fetch(r.base + "/login?t=abc", { method: "POST", headers: { "x-forwarded-for": "198.51.100.8" }, body: "{}" });
      const job = await r.agent("/agent/poll").then((x) => x.json());
      await r.agent("/agent/reply", { method: "POST", body: JSON.stringify({ id: job.id, status, body: "" }) });
      return (await p).status;
    };
    for (let i = 0; i < LOGIN_LIMIT * 2; i++) assert.equal(await attempt(200), 200, "a phone that keeps signing in is never locked out");
    for (let i = 0; i < LOGIN_LIMIT - 1; i++) assert.equal(await attempt(401), 401);
    assert.equal(await attempt(200), 200, "one guess short of the cap, the right password still works");
  } finally { await r.close(); }
});

test("the world summary reads Osiris's feeds defensively", () => {
  const now = Date.parse("2026-10-06T04:00:00Z");
  const w = summariseWorld({
    conflicts: { zones: [{ id: "ukraine", label: "UKRAINE WAR", severity: "war", events: [{ title: "A headline", url: "https://x", timestamp: "t" }] }] },
    earthquakes: { earthquakes: [
      { id: "a", magnitude: 5.1, place: "Fiji", time: now - 3600_000, tsunami: 1 },
      { id: "b", magnitude: 3.0, place: "CA", time: now - 7200_000, tsunami: 0 },
      { id: "c", magnitude: 6.0, place: "old", time: now - 3 * 86400_000 },
      { id: "d", magnitude: null, place: "bad", time: now },
    ] },
    fires: { fires: [{ frp: 2, confidence: "high" }, { frp: 9, confidence: "nominal" }, { frp: 1, confidence: "h" }] },
    weather: { events: [{ id: "e", title: "Super Typhoon", type: "Severe Storm", severity: "high" }] },
  }, now);
  assert.equal(w.conflicts[0].latest.title, "A headline");
  assert.equal(w.earthquakes.count, 2, "only the last 24 hours, and only real magnitudes");
  assert.equal(w.earthquakes.strong, 1);
  assert.equal(w.earthquakes.top[0].id, "a");
  assert.deepEqual(w.tsunamis.map((t) => t.id), ["a"]);
  assert.equal(w.fires.count, 3);
  assert.equal(w.fires.highConfidence, 2);
  assert.equal(w.fires.strongest[0].frp, 9);
  assert.equal(w.storms[0].title, "Super Typhoon");
  const empty = summariseWorld({}, now);
  assert.equal(empty.earthquakes.count, 0);
  assert.deepEqual(empty.conflicts, []);
});

test("/world is cached, and a failed refresh keeps the last good copy", async () => {
  let t = 1_000_000, calls = 0, fail = false;
  const fetchJson = async (url) => {
    calls++;
    if (fail) throw new Error("down");
    if (url.endsWith("/conflicts")) return { zones: [{ id: "z", label: "Z" }] };
    return {};
  };
  const r = await start({ fetchJson, now: () => t });
  try {
    assert.equal((await fetch(r.base + "/world").then((x) => x.json())).conflicts[0].label, "Z");
    await fetch(r.base + "/world");
    assert.equal(calls, 4, "the second request is served from the cache");
    t += 10 * 60_000;
    fail = true;
    const stale = await fetch(r.base + "/world");
    assert.equal(stale.status, 200);
    assert.equal((await stale.json()).conflicts[0].label, "Z");
  } finally { await r.close(); }
});

test("/weather checks its coordinates", async () => {
  const r = await start({ fetchJson: async () => ({ current: { temperature_2m: 15, is_day: 0 }, daily: { temperature_2m_max: [20] } }) });
  try {
    assert.equal((await fetch(r.base + "/weather?lat=999&lon=0")).status, 400);
    const w = await fetch(r.base + "/weather?lat=47.5&lon=19.04").then((x) => x.json());
    assert.equal(w.temp, 15);
    assert.equal(w.isDay, false);
    assert.equal(w.high, 20);
  } finally { await r.close(); }
});
test("weather retries a temporary failure once and shares concurrent requests with its cache", async () => {
  let calls = 0;
  const r = await start({ fetchJson: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("temporary provider failure"), { status: 503 });
    return { current: { temperature_2m: 15 }, daily: { temperature_2m_max: [20] } };
  } });
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(r.base + "/weather?lat=47.5&lon=19.04")));
    for (const response of responses) { assert.equal(response.status, 200); assert.equal((await response.json()).temp, 15); }
    assert.equal(calls, 2);
    await fetch(r.base + "/weather?lat=47.5&lon=19.04"); assert.equal(calls, 2);
  } finally { await r.close(); }
});
test("weather does not retry provider quota errors and can recover on a later request", async () => {
  let calls = 0, limited = true;
  const r = await start({ fetchJson: async () => {
    calls++;
    if (limited) throw Object.assign(new Error("private provider response"), { status: 429 });
    return { current: { temperature_2m: 15 }, daily: { temperature_2m_max: [20] } };
  } });
  try {
    assert.equal((await fetch(r.base + "/weather?lat=47.5&lon=19.04")).status, 502); assert.equal(calls, 1);
    limited = false;
    assert.equal((await fetch(r.base + "/weather?lat=47.5&lon=19.04")).status, 200); assert.equal(calls, 2);
  } finally { await r.close(); }
});
