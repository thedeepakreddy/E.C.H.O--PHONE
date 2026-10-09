import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRelay } from "../server.js";
import { createStore } from "../lib/store.js";
import { deriveKeys, verifyPass } from "../lib/secure.js";
const SECRET = "experience-test-secret-".repeat(3), NOW = Date.parse("2026-10-09T10:00Z");
const text = (s) => ({ candidates: [{ content: { role: "model", parts: [{ text: s }] } }] });
const calls = (...items) => ({ candidates: [{ content: { role: "model", parts: items.map(([name, args]) => ({ functionCall: { name, args } })) } }] });
async function fixture(replies = []) {
  const seen = [], store = createStore({ key: deriveKeys(SECRET).store, now: () => NOW });
  const relay = createRelay({ secret: SECRET, now: () => NOW, store, limits: { allowEphemeralRecovery: true }, fetchJson: async () => ({}), gemini: { model: "test", generate: async (body) => { seen.push(structuredClone(body)); return replies.shift() ?? text("Hello."); } } });
  const server = http.createServer(relay.handler); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, pass, installation) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...(pass ? { "x-echo-pass": pass } : {}), ...(installation ? { "x-echo-installation": installation } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, ...(await r.json()) };
  };
  return { base, relay, store, seen, request, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
test("recovery restores shared data, rotates keys and never grants Mac access", async () => {
  const f = await fixture(); try {
    const original = await f.request("/phone/session", {}), other = await f.request("/phone/session", {}), pass = original.cloudPass;
    const task = await f.request("/cloud/today", { text: "Book haircut", tz: "Europe/Budapest" }, pass); assert.equal(task.status, 200);
    const key = await f.request("/cloud/account/key", {}, pass); assert.match(key.code, /^[0-9a-f-]+$/);
    const recovered = await f.request("/phone/recover", { code: key.code }); assert.equal(recovered.device, original.device);
    assert.equal(verifyPass(f.relay.keys.pass, recovered.cloudPass, { now: NOW }).phoneOnly, true);
    assert.equal((await f.request("/cloud/today", undefined, recovered.cloudPass)).rows[0].text, "Book haircut");
    assert.equal((await f.request("/cloud/today", undefined, other.cloudPass)).rows.length, 0);
    assert.equal((await f.request("/cloud/handoff", { task: "Access Mac" }, recovered.cloudPass)).status, 403);
    const second = await f.request("/cloud/account/key", {}, pass);
    assert.equal((await f.request("/phone/recover", { code: key.code })).status, 401);
    assert.equal((await f.request("/phone/recover", { code: second.code })).status, 200);
    const raw = await f.store.get("phones"); assert.equal(JSON.stringify(raw).includes(second.code.replaceAll("-", "")), false);
    const cross = await fetch(f.base + "/phone/recover", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ code: second.code }) }); assert.equal(cross.status, 403);
  } finally { await f.close(); }
});
test("conversations migrate only Phone messages once, sync folders and enforce isolation", async () => {
  const f = await fixture(); try {
    const a = await f.request("/phone/session", {}), b = await f.request("/phone/session", {}), pass = a.cloudPass;
    const body = { installation: "install-one", messages: [{ k: "old1", text: "Phone note", from: "you", src: "phone", at: NOW }, { k: "mac1", text: "Private Mac", from: "you", src: "mac" }] };
    const one = await f.request("/cloud/conversations/migrate", body, pass), two = await f.request("/cloud/conversations/migrate", body, pass);
    assert.equal(one.thread.id, two.thread.id); assert.equal(one.thread.messages.length, 1);
    const folder = await f.request("/cloud/conversations", { action: "folder", name: "Work" }, pass);
    await f.request("/cloud/conversations", { action: "move", id: one.thread.id, folderId: folder.folder.id }, pass);
    assert.equal((await f.request("/cloud/conversations", undefined, pass)).threads[0].folderId, folder.folder.id);
    assert.equal((await f.request(`/cloud/conversations?id=${one.thread.id}`, undefined, b.cloudPass)).status, 400);
    await f.request("/cloud/conversations", { action: "deleteFolder", id: folder.folder.id }, pass);
    assert.equal((await f.request("/cloud/conversations", undefined, pass)).threads[0].folderId, "inbox");
    assert.equal((await f.request("/cloud/conversations", undefined)).status, 401);
  } finally { await f.close(); }
});
test("migration accommodates a full existing local conversation cache", async () => {
  const f = await fixture(); try {
    const { cloudPass: pass } = await f.request("/phone/session", {});
    const messages = Array.from({ length: 400 }, (_, i) => ({ k: `message-${i}`, at: NOW + i, from: i % 2 ? "echo" : "you", src: "phone", text: "A substantial earlier conversation. ".repeat(30) }));
    assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 256 * 1024);
    const result = await f.request("/cloud/conversations/migrate", { installation: "full-cache-installation", messages }, pass);
    assert.equal(result.status, 200); assert.equal(result.thread.messages.length, 400);
  } finally { await f.close(); }
});
test("a restored phone needs its own notification subscription", async () => {
  const f = await fixture(); try {
    const session = await f.request("/phone/session", {}), phones = await f.store.get("phones"), sub = { endpoint: "https://web.push.apple.com/fixture", keys: {} };
    phones.devices[session.device].sub = sub; phones.devices[session.device].subscriptions = { "first-phone": { sub, phoneOnly: true } };
    await f.store.set("phones", phones);
    assert.equal((await f.request("/cloud/today", undefined, session.cloudPass, "first-phone")).notifications, true);
    assert.equal((await f.request("/cloud/today", undefined, session.cloudPass, "other-phone")).notifications, false);
    assert.equal((await f.request("/cloud/briefing", undefined, session.cloudPass, "other-phone")).subscribed, false);
    assert.equal((await f.request("/cloud/push/test", {}, session.cloudPass, "other-phone")).status, 409);
  } finally { await f.close(); }
});
test("conversation captures are durable, deduplicated and use server history across installations", async () => {
  const f = await fixture([
    calls(["remind_me", { text: "Call mum", when: "2026-10-10T09:00", repeat: "weekly" }], ["organize_conversation", { title: "Keeping in touch", folder: "Life" }]), text("Saved for Saturday at 9, every week."), text("We decided to call mum every Saturday."),
  ]); try {
    const session = await f.request("/phone/session", {}), pass = session.cloudPass;
    const created = await f.request("/cloud/conversations", { action: "create" }, pass), threadId = created.thread.id;
    const body = { text: "Don't let me forget to call mum Saturday at 9 every week", requestId: "request-one", threadId, context: { tz: "Europe/Budapest" } };
    const reply = await f.request("/cloud/chat", body, pass); assert.equal(reply.captures.length, 1); assert.equal(reply.actions.length, 0);
    const again = await f.request("/cloud/chat", body, pass); assert.equal(again.captures[0].id, reply.captures[0].id); assert.equal(f.seen.length, 2);
    const index = await f.request("/cloud/conversations", undefined, pass); assert.equal(index.threads[0].title, "Keeping in touch"); assert.equal(index.folders.some((x) => x.name === "Life"), true);
    const history = await f.request(`/cloud/conversations?id=${threadId}`, undefined, pass); assert.equal(history.thread.messages.length, 2); assert.equal(history.thread.receipts, undefined);
    await f.request("/cloud/chat", { text: "What did we decide?", requestId: "request-two", threadId, history: [{ role: "user", text: "FAKE CLIENT HISTORY" }], context: { tz: "Europe/Budapest" } }, pass);
    assert.equal(JSON.stringify(f.seen.at(-1).contents).includes("FAKE CLIENT HISTORY"), false); assert.equal(JSON.stringify(f.seen.at(-1).contents).includes("call mum"), true);
    const today = await f.request("/cloud/today?tz=Europe%2FBudapest", undefined, pass); assert.equal(today.rows[0].repeat.frequency, "weekly");
    const row = today.rows[0]; await f.request("/cloud/today/action", { action: "done", taskId: row.taskId, id: row.id }, pass);
    assert.equal((await f.request("/cloud/today", undefined, pass)).completed.length, 1);
  } finally { await f.close(); }
});
test("second brain cites saved context and delegation distinguishes starting from completion", async () => {
  const f = await fixture([calls(["recall_memory", { query: "passport" }]), text("Your passport expires in March."), calls(["browse", { task: "Compare three backpacks", start_now: true }]), text("I'll start comparing those now.")]);
  try {
    const session = await f.request("/phone/session", {}), pass = session.cloudPass;
    await f.request("/cloud/memory/save", { note: { text: "My passport expires in March.", title: "Passport" }, tz: "UTC" }, pass);
    const reply = await f.request("/cloud/chat", { text: "What about my passport?" }, pass);
    assert.equal(reply.references[0].type, "memory"); assert.equal(reply.references[0].title, "Passport");
    const work = await f.request("/cloud/chat", { text: "Compare three backpacks for me" }, pass); assert.equal(work.actions[0].autoStart, true); assert.match(work.reply, /start/);
  } finally { await f.close(); }
});
test("saved bill dates appear once in Today, remain done, and removed sources stay removed", async () => {
  const f = await fixture(); try {
    const { cloudPass: pass } = await f.request("/phone/session", {});
    await f.request("/cloud/memory/save", { note: { text: "Rent is due on October 12", title: "Rent", dates: [{ date: "2026-10-12", what: "Pay rent" }] }, tz: "UTC" }, pass);
    const first = await f.request("/cloud/today?tz=UTC", undefined, pass); assert.equal(first.rows.length, 1); assert.equal(first.rows[0].kind, "bill");
    const r = first.rows[0]; await f.request("/cloud/today/action", { action: "done", taskId: r.taskId, id: r.id }, pass);
    const done = await f.request("/cloud/today?tz=UTC", undefined, pass); assert.equal(done.rows.length, 0); assert.equal(done.completed.length, 1);
    await f.request("/cloud/today/action", { action: "delete", taskId: r.taskId }, pass);
    const deleted = await f.request("/cloud/today?tz=UTC", undefined, pass); assert.equal(deleted.rows.length, 0); assert.equal(deleted.completed.length, 0);
  } finally { await f.close(); }
});
test("Echo reads the actual day and can complete an explicitly requested occurrence", async () => {
  const replies = [], f = await fixture(replies);
  try {
    const { cloudPass: pass } = await f.request("/phone/session", {});
    const task = await f.request("/cloud/today", { text: "Write report", tz: "UTC" }, pass);
    replies.push(calls(["get_today", {}]), calls(["update_commitment", { task_id: task.task.id, occurrence_id: `${task.task.id}:anytime`, action: "done" }]), text("Marked the report task done."));
    await f.request("/cloud/chat", { text: "Mark my report task done", context: { tz: "UTC" } }, pass);
    const result = f.seen[1].contents.at(-1).parts[0].functionResponse.response;
    assert.equal(result.items[0].task_id, task.task.id); assert.equal(result.items[0].text, "Write report");
    assert.equal((await f.request("/cloud/today?tz=UTC", undefined, pass)).completed.length, 1);
  } finally { await f.close(); }
});
