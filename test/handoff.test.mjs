import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkTask, checkAssertion, tidy, MAX_WAITING } from "../lib/handoff.js";
import { signPass } from "../lib/secure.js";
import { createRelay } from "../server.js";

const SECRET = "h".repeat(48);
const DEVICE = "c0ffeec0ffeec0ffeec0ffeec0ffee00";
const NOW = Date.parse("2026-10-06T15:00:00Z");
const ASSERTION = { id: "cred1", rawId: "cred1", type: "public-key", response: { clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0", authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ", signature: "MEUCIQ" } };
const task = (n, extra = {}) => ({ id: `0a1b2c3d-${String(n).padStart(4, "0")}-4222-8333-444455556666`, text: `Job ${n}`, createdAt: NOW, ...extra });

test("jobs are checked for shape; the Mac checks Face ID", () => {
  assert.equal(checkTask(task(1), DEVICE, NOW).device, DEVICE, "the job is tied to the phone that sent it");
  assert.throws(() => checkTask({ ...task(1), id: "../../etc" }, DEVICE, NOW), /malformed/);
  assert.throws(() => checkTask({ ...task(1), text: " " }, DEVICE, NOW), /up to 2000/);
  assert.throws(() => checkTask({ ...task(1), createdAt: NOW - 3600_000 }, DEVICE, NOW), /clock/);
  assert.throws(() => checkAssertion({ id: "x", response: { clientDataJSON: "<script>" } }), /didn't come through/);
  assert.equal(checkAssertion(ASSERTION).response.signature, "MEUCIQ");
  const st = tidy({ items: [
    { task: task(1, { createdAt: NOW - 9 * 86400_000 }), status: "waiting", updatedAt: NOW },
    { task: task(2), status: "done", updatedAt: NOW - 8 * 86400_000 },
    { task: task(3), status: "waiting", updatedAt: NOW },
  ] }, NOW);
  assert.deepEqual(st.items.map((i) => i.task.text), ["Job 3"], "old jobs are tidied away");
});

test("relay: leave a job, the Mac collects it, reports back, and the phone is notified", async () => {
  const pushed = [];
  let t = NOW;
  const relay = createRelay({ secret: SECRET, now: () => t, pushAnyHost: true, pollMs: 200, fetchJson: async () => ({}),
    pushFetch: async (url, init) => { pushed.push(url); return { status: 201 }; } });
  const server = http.createServer(relay.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pass = signPass(relay.keys.pass, { device: DEVICE, gen: 0, now: NOW });
  const phone = (p, body) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "x-echo-pass": pass }, body: body ? JSON.stringify(body) : undefined });
  const mac = (p, body) => fetch(base + p, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${SECRET}` }, body: body ? JSON.stringify(body) : undefined });
  try {
    await phone("/cloud/push/subscribe", { subscription: { endpoint: "http://push.test/abc", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } } });
    const left = await (await phone("/cloud/handoff", { task: task(1), assertion: ASSERTION })).json();
    assert.equal(left.item.status, "waiting");
    assert.equal((await phone("/cloud/handoff", { task: task(1), assertion: ASSERTION })).status, 400, "the same job can't be left twice");
    assert.equal((await fetch(`${base}/agent/handoff`)).status, 404, "only Echo can collect jobs");
    const poll = await mac("/agent/poll");
    assert.equal(poll.headers.get("x-relay-handoffs"), "1", "Echo hears a job is waiting on its next poll");
    const waiting = await (await mac("/agent/handoff")).json();
    assert.equal(waiting.items[0].task.device, DEVICE);
    assert.equal(waiting.items[0].assertion.response.signature, "MEUCIQ", "with the Face ID approval for the Mac to check");
    assert.equal((await mac("/agent/handoff/update", { id: task(1).id, status: "started" })).status, 204);
    assert.equal((await phone("/cloud/handoff/cancel", { id: task(1).id })).status, 409, "a started job can't be cancelled");
    assert.equal((await mac("/agent/handoff/update", { id: task(1).id, status: "done", summary: "Settings screen built and tests pass." })).status, 204);
    const mine = await (await phone("/cloud/handoff")).json();
    assert.equal(mine.items[0].status, "done");
    assert.equal(mine.items[0].summary, "Settings screen built and tests pass.");
    assert.equal(mine.items[0].assertion, undefined, "the phone never gets assertions back");
    assert.deepEqual(pushed, ["http://push.test/abc"], "a finished job becomes a notification");
    assert.equal((await mac("/agent/handoff/update", { id: task(1).id, status: "failed" })).status, 404, "a finished job stays finished");

    await phone("/cloud/handoff", { task: task(2), assertion: ASSERTION });
    assert.equal((await phone("/cloud/handoff/cancel", { id: task(2).id })).status, 200, "a waiting job can be cancelled");
    for (let i = 10; i < 10 + MAX_WAITING; i++) assert.equal((await phone("/cloud/handoff", { task: task(i), assertion: ASSERTION })).status, 200);
    const over = await phone("/cloud/handoff", { task: task(99), assertion: ASSERTION });
    assert.equal(over.status, 400);
    assert.match((await over.json()).message, /10 jobs are already waiting/);
  } finally { server.closeAllConnections?.(); server.close(); }
});
