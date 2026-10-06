/**
 * Durable storage: Upstash Redis over its REST API, every value sealed first.
 *
 * Render's free tier forgets everything on each sleep and deploy, so anything
 * that must outlive the process lives here. Values are encrypted with a key
 * derived from RELAY_SECRET (lib/secure.js) before they leave this server;
 * counters are plain numbers. Without Upstash configured it keeps everything
 * in memory — enough for local runs and tests, and the relay says so.
 */
import { seal, unseal } from "./secure.js";

const PREFIX = "echo:";

export function createStore({ url, token, key, fetchImpl = fetch, now = Date.now } = {}) {
  const remote = Boolean(url && token);
  const mem = new Map();
  const live = (k) => {
    const e = mem.get(k);
    if (e && e.exp && e.exp <= now()) { mem.delete(k); return undefined; }
    return e;
  };
  function memCmd([cmd, k, ...a]) {
    switch (cmd) {
      case "GET": return live(k)?.v ?? null;
      case "SET": mem.set(k, { v: a[0], exp: a[1] === "EX" ? now() + Number(a[2]) * 1000 : 0 }); return "OK";
      case "DEL": return mem.delete(k) ? 1 : 0;
      case "INCR": { const n = Number(live(k)?.v ?? 0) + 1; mem.set(k, { v: String(n), exp: live(k)?.exp ?? 0 }); return n; }
      case "EXPIRE": { const e = live(k); if (!e) return 0; e.exp = now() + Number(a[0]) * 1000; return 1; }
      default: throw new Error(`store: ${cmd} is not supported in memory`);
    }
  }
  async function cmd(args) {
    if (!remote) return memCmd(args);
    const res = await fetchImpl(url.replace(/\/+$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) throw new Error(`store: ${d.error ?? `HTTP ${res.status}`}`);
    return d.result;
  }
  return {
    remote,
    async get(k) {
      const raw = await cmd(["GET", PREFIX + k]);
      return raw == null ? null : unseal(key, raw);
    },
    async set(k, value, ttlS) {
      await cmd(ttlS ? ["SET", PREFIX + k, seal(key, value), "EX", ttlS] : ["SET", PREFIX + k, seal(key, value)]);
    },
    async del(k) { await cmd(["DEL", PREFIX + k]); },
    /** A plain counter; the first increment starts its expiry. */
    async incr(k, ttlS) {
      const n = Number(await cmd(["INCR", PREFIX + k]));
      if (ttlS && n === 1) await cmd(["EXPIRE", PREFIX + k, ttlS]);
      return n;
    },
    async count(k) { return Number((await cmd(["GET", PREFIX + k])) ?? 0) || 0; },
    async setCount(k, n, ttlS) { await cmd(ttlS ? ["SET", PREFIX + k, String(n), "EX", ttlS] : ["SET", PREFIX + k, String(n)]); },
  };
}
