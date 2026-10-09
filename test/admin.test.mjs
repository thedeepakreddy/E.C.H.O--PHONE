import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRelay, APP_VERSION } from "../server.js";
import { createStore } from "../lib/store.js";
import { deriveKeys, seal } from "../lib/secure.js";
import { runTick, addReminder } from "../lib/briefing.js";
import { MAC_ROUTES } from "../lib/mac-routes.js";

const SECRET = "admin-test-relay-secret-".repeat(3), PASSWORD = "owner-test-password-that-is-long-enough";
async function fixture({ password = PASSWORD, pollMs = 25_000, requestMs = 30_000 } = {}) {
  let time = Date.parse("2026-10-09T14:00Z");
  const store = createStore({ key: deriveKeys(SECRET).store, now: () => time });
  const relay = createRelay({ secret: SECRET, store, now: () => time, adminPassword: password, pollMs, requestMs, publicUrl: "http://127.0.0.1",
    limits: { allowEphemeralRecovery: true }, fetchJson: async () => ({}) });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { body, cookie, csrf, pass, headers = {} } = {}) => {
    const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json",
      ...(cookie ? { cookie } : {}), ...(csrf ? { "x-echo-admin-csrf": csrf } : {}), ...(pass ? { "x-echo-pass": pass } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
  };
  const login = async () => {
    const result = await request("/admin/api/login", { body: { password: PASSWORD } }); assert.equal(result.status, 200);
    return { cookie: result.headers.get("set-cookie").split(";")[0], csrf: result.data.csrf };
  };
  return { store, relay, base, request, login, advance: (n) => { time += n; }, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
test("admin is private, fails closed without configuration, and Phone credentials never grant admin", async () => {
  const f = await fixture({ password: "" }); try {
    const phone = await f.request("/phone/session", { body: {} });
    for (const path of ["/admin/api/overview", "/admin/api/users", "/admin/api/users/action"]) {
      const result = await f.request(path, { pass: phone.data.cloudPass }); assert.equal(result.status, 401); assert.equal(result.data.users, undefined);
    }
    assert.equal((await f.request("/admin/api/login", { body: { password: PASSWORD } })).status, 503);
    const page = await fetch(f.base + "/admin"); assert.equal(page.status, 200); assert.match(await page.text(), /OWNER ACCESS/);
    assert.equal((await f.request("/phone/session", { body: {} })).status, 200);
  } finally { await f.close(); }
});
test("admin login rate limits guesses; sessions expire and logout revokes the cookie", async () => {
  const f = await fixture(); try {
    assert.equal((await f.request("/admin/api/login", { body: { password: PASSWORD }, headers: { origin: "https://evil.example" } })).status, 403);
    for (let i = 0; i < 10; i++) assert.equal((await f.request("/admin/api/login", { body: { password: "wrong" } })).status, 401);
    assert.equal((await f.request("/admin/api/login", { body: { password: PASSWORD } })).status, 429);
    f.advance(15 * 60_000 + 1); const session = await f.login();
    assert.equal((await f.request("/admin/api/overview", session)).status, 200);
    assert.equal((await f.request("/admin/api/logout", { body: {}, cookie: session.cookie })).status, 403);
    assert.equal((await f.request("/admin/api/logout", { body: {}, ...session })).status, 200);
    assert.equal((await f.request("/admin/api/overview", session)).status, 401);
    const second = await f.login(); f.advance(6 * 3600_000 + 1);
    assert.equal((await f.request("/admin/api/overview", second)).status, 401);
  } finally { await f.close(); }
});
test("management rejects CSRF and suspension blocks existing Phone credentials, recovery and browser sessions", async () => {
  const f = await fixture(); try {
    const phone = (await f.request("/phone/session", { body: {} })).data, other = (await f.request("/phone/session", { body: {} })).data;
    const key = (await f.request("/cloud/account/key", { body: {}, pass: phone.cloudPass })).data.code;
    const admin = await f.login(), action = { id: phone.device, action: "suspend" };
    assert.equal((await f.request("/admin/api/users/action", { body: action, cookie: admin.cookie })).status, 403);
    assert.equal((await f.request("/admin/api/users/action", { body: action, ...admin, headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await f.request("/cloud/account", { pass: phone.cloudPass })).status, 200);
    assert.equal((await f.request("/admin/api/users/action", { body: action, ...admin })).status, 200);
    for (const path of ["/cloud/status", "/cloud/today", "/cloud/conversations", "/cloud/memory"]) assert.equal((await f.request(path, { pass: phone.cloudPass })).status, 403);
    assert.equal((await f.request("/phone/session", { body: {}, pass: phone.cloudPass })).status, 403);
    assert.equal((await f.request("/phone/recover", { body: { code: key } })).status, 403);
    const browserCookie = `eb=${seal(f.relay.keys.store, { d: phone.device, phoneOnly: true, exp: Date.parse("2026-10-10T00:00Z") })}`;
    const browser = await fetch(f.base + "/b/go?q=https://example.com", { headers: { cookie: browserCookie }, redirect: "manual" }); assert.equal(browser.status, 401);
    assert.equal((await f.request("/cloud/account", { pass: other.cloudPass })).status, 200);
    assert.equal((await f.request("/admin/api/users/action", { body: { ...action, action: "resume" }, ...admin })).status, 200);
    assert.equal((await f.request("/phone/recover", { body: { code: key } })).status, 200);
    assert.equal((await f.request("/cloud/account", { pass: phone.cloudPass })).status, 200);
    const overview = (await f.request("/admin/api/overview", admin)).data; assert.equal(overview.audit.length, 2); assert.equal(overview.users.total, 2);
  } finally { await f.close(); }
});
test("admin revokes recovery and notifications without deleting account data; summaries exclude private content", async () => {
  const f = await fixture(); try {
    const phone = (await f.request("/phone/session", { body: {} })).data, admin = await f.login();
    const key = (await f.request("/cloud/account/key", { body: {}, pass: phone.cloudPass })).data.code;
    const phones = await f.store.get("phones"); phones.devices[phone.device].sub = { endpoint: "https://private-push-url.example", keys: { auth: "private-auth" } };
    phones.devices[phone.device].subscriptions = { first: { sub: phones.devices[phone.device].sub } }; phones.devices[phone.device].expenses = [{ name: "private purchase" }]; await f.store.set("phones", phones);
    await f.store.set(`conversations:${phone.device}`, { threads: [{ messages: [{ text: "private conversation" }] }] });
    await f.store.set(`mem:${phone.device}`, { items: [{ title: "private saved fact" }] });
    const users = (await f.request("/admin/api/users", admin)).data;
    const detail = (await f.request(`/admin/api/users/${phone.device}`, admin)).data;
    assert.equal(detail.user.conversations, 1); assert.equal(detail.user.saved, 1);
    const encoded = JSON.stringify({ users, detail }); for (const secret of [key, "private conversation", "private saved fact", "private-push-url", "private-auth", "private purchase"]) assert.equal(encoded.includes(secret), false);
    for (const action of ["disable_notifications", "reset_recovery"]) assert.equal((await f.request("/admin/api/users/action", { body: { id: phone.device, action }, ...admin })).status, 200);
    assert.equal((await f.request("/phone/recover", { body: { code: key } })).status, 401);
    assert.equal((await f.request("/cloud/account", { pass: phone.cloudPass })).status, 200);
    const after = (await f.request(`/admin/api/users/${phone.device}`, admin)).data.user; assert.equal(after.notifications, 0); assert.equal(after.recovery, false); assert.equal(after.conversations, 1);
    assert.equal((await f.request("/admin/api/users/action", { body: { id: phone.device, action: "delete" }, ...admin })).status, 400);
  } finally { await f.close(); }
});
test("diagnostics whitelist fields, strip secret-bearing URLs and record failures without raw errors", async () => {
  const f = await fixture(); try {
    const phone = (await f.request("/phone/session", { body: {} })).data, admin = await f.login();
    assert.equal((await f.request("/cloud/diagnostics", { body: { feature: "voice", code: "microphone_denied", platform: "ios", app: APP_VERSION, text: PASSWORD, url: "private-url" }, pass: phone.cloudPass })).status, 200);
    assert.equal((await f.request("/cloud/diagnostics", { body: { feature: PASSWORD, code: "runtime" }, pass: phone.cloudPass })).status, 400);
    await f.request("/cloud/chat?token=private-token", { body: { text: "private question" }, pass: phone.cloudPass });
    const overview = (await f.request("/admin/api/overview", admin)).data;
    assert.equal(overview.problems.some((p) => p.code === "microphone_denied"), true);
    assert.equal(overview.problems.some((p) => p.operation === "/cloud/chat" && p.status === 503), true);
    const encoded = JSON.stringify(overview); for (const secret of [PASSWORD, SECRET, phone.cloudPass, "private-token", "private question", "private-url"]) assert.equal(encoded.includes(secret), false);
    assert.equal(overview.requests.failures, 1); assert.equal(overview.storage.durable, false);
  } finally { await f.close(); }
});
test("optional Mac offline responses do not flood diagnostics or hide Phone failures", async () => {
  const f = await fixture(); try {
    const admin = await f.login();
    for (const path of MAC_ROUTES) {
      const result = await f.request(path);
      assert.equal(result.status, 503); assert.equal(result.data.error, "offline");
      assert.ok(result.headers.get("x-echo-request-id"));
    }
    const health = (await f.request("/healthz")).data;
    assert.equal(health.ok, true); assert.equal(health.echo, "offline");
    let overview = (await f.request("/admin/api/overview", admin)).data;
    assert.equal(overview.mac.online, false); assert.equal(overview.requests.requests, MAC_ROUTES.size);
    assert.equal(overview.requests.failures, 0); assert.equal(overview.problems.length, 0);
    const phone = (await f.request("/phone/session", { body: {} })).data;
    assert.equal((await f.request("/cloud/account", { pass: phone.cloudPass })).status, 200);
    assert.equal((await f.request("/cloud/chat", { body: { text: "hello" }, pass: phone.cloudPass })).status, 503);
    overview = (await f.request("/admin/api/overview", admin)).data;
    assert.equal(overview.requests.failures, 1); assert.equal(overview.problems.length, 1);
    assert.equal(overview.problems[0].operation, "/cloud/chat"); assert.equal(overview.problems[0].code, "setup");
  } finally { await f.close(); }
});
test("real timeouts on previously unclassified Mac routes stay visible", async () => {
  const f = await fixture({ pollMs: 5, requestMs: 20 }); try {
    const admin = await f.login();
    assert.equal((await fetch(f.base + "/agent/poll", { headers: { authorization: `Bearer ${SECRET}` } })).status, 204);
    // /pending previously appeared as Other request; its real timeout must
    // still count as a failure even though ordinary offline polls no longer do.
    assert.equal((await f.request("/pending")).status, 504);
    const overview = (await f.request("/admin/api/overview", admin)).data;
    assert.equal(overview.requests.failures, 1); assert.equal(overview.problems.length, 1);
    assert.equal(overview.problems[0].operation, "Mac /pending"); assert.equal(overview.problems[0].status, 504);
  } finally { await f.close(); }
});
test("suspended accounts receive no due reminders and reject calendar uploads; resuming preserves their tasks", async () => {
  const f = await fixture(); try {
    const phone = (await f.request("/phone/session", { body: {} })).data, admin = await f.login();
    const phones = await f.store.get("phones"), dev = phones.devices[phone.device];
    dev.calKey = "calendar-test-key-for-admin";
    dev.sub = { endpoint: "https://push.example" };
    addReminder(dev, { text: "Send report", when: "2026-10-09T14:00", tz: "UTC" }, Date.parse("2026-10-09T13:00Z"), "reminder-one");
    await f.store.set("phones", phones);
    await f.request("/admin/api/users/action", { body: { id: phone.device, action: "suspend" }, ...admin });
    const paused = await f.store.get("phones"); let deliveries = 0;
    await runTick({ phones: paused, now: Date.parse("2026-10-09T14:01Z"), push: async () => { deliveries++; return { ok: true }; } });
    assert.equal(deliveries, 0); assert.equal(paused.devices[phone.device].reminders[0].sent, false);
    assert.equal((await f.request("/cal/calendar-test-key-for-admin", { body: {} })).status, 404);
    await f.request("/admin/api/users/action", { body: { id: phone.device, action: "resume" }, ...admin });
    assert.equal((await f.store.get("phones")).devices[phone.device].reminders.length, 1);
  } finally { await f.close(); }
});
test("account list paginates and searches by public account suffix", async () => {
  const f = await fixture(); try {
    const phones = { devices: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i.toString(16).padStart(32, "0"), { lastSeenAt: i + 1 }])) };
    await f.store.set("phones", phones); const admin = await f.login();
    const first = (await f.request("/admin/api/users", admin)).data, second = (await f.request("/admin/api/users?page=1", admin)).data;
    assert.equal(first.total, 25); assert.equal(first.items.length, 20); assert.equal(second.items.length, 5);
    assert.equal(first.items.some((a) => second.items.some((b) => a.id === b.id)), false);
    const search = (await f.request("/admin/api/users?q=000018", admin)).data; assert.equal(search.items.length, 1); assert.equal(search.items[0].account, "000018");
    const auth = await f.request("/admin/api/login", { body: { password: PASSWORD } }); assert.match(auth.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  } finally { await f.close(); }
});
