/** Owner-only operations. Never returns credentials, conversations or saved content. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DEVICE_ID } from "./secure.js";
import { MAC_ROUTES } from "./mac-routes.js";

const SESSION_MS = 6 * 3600_000;
const ACTIONS = new Set(["suspend", "resume", "disable_notifications", "reset_recovery"]);
const FEATURES = new Set(["app", "voice", "speech", "sync", "browser"]);
const CODES = new Set(["runtime", "promise", "network", "microphone_denied", "microphone_unavailable", "playback"]);
const hash = (s) => createHash("sha256").update(String(s)).digest();
const CLOUD_ROUTES = new Set(["/cloud/status", "/cloud/account", "/cloud/account/key", "/cloud/conversations", "/cloud/conversations/migrate", "/cloud/today", "/cloud/today/action", "/cloud/curiosity/dismiss", "/cloud/push/key", "/cloud/push/test", "/cloud/push/subscribe", "/cloud/push/unsubscribe", "/cloud/briefing", "/cloud/briefing/prefs", "/cloud/briefing/now", "/cloud/calendar/key", "/cloud/chat", "/cloud/voice", "/cloud/snap", "/cloud/snaps", "/cloud/memory", "/cloud/memory/save", "/cloud/memory/delete", "/cloud/handoff", "/cloud/handoff/cancel", "/cloud/browse/session", "/cloud/browse/plan", "/cloud/browse/step", "/cloud/browse/report", "/cloud/diagnostics"]);
const routeName = (path) => {
  if (CLOUD_ROUTES.has(path)) return path;
  if (["/phone/session", "/phone/recover", "/weather", "/world", "/geocode", "/cron/tick"].includes(path)) return path;
  if (path.startsWith("/b/")) return "Browser proxy";
  if (path.startsWith("/cal/")) return "Calendar sync";
  if (path.startsWith("/agent/")) return "Mac relay";
  if (MAC_ROUTES.has(path)) return `Mac ${path}`;
  return "Other request";
};
export function problemHint(p) {
  if (p.code === "setup") return "This feature is missing required configuration. Check the AI connection and Render environment settings.";
  if (p.code === "microphone_denied") return "The browser denied microphone access. Check site permissions on the affected phone.";
  if (p.feature === "voice") return "The voice session stopped. Check microphone permission, audio interruptions and whether the app was backgrounded.";
  if (p.feature === "speech") return "Speech playback failed on the phone. Check its audio output and try starting voice with a tap.";
  if (p.status === 429) return "A request or AI quota limit was reached. Check usage before retrying.";
  if (p.status === 401) return "A session or recovery credential was rejected. Check account status and sign-in.";
  if (p.status === 403) return "Access was denied. Check account suspension, pairing and request permissions.";
  if (p.status === 503 && p.operation.startsWith("Mac")) return "The Mac may be asleep or disconnected. Optional Mac availability does not affect standalone Phone access.";
  if (p.status >= 500) return "A service request failed. Check storage, AI configuration, usage and the matching Render logs.";
  return "Check the affected feature and reproduce the problem. Private error text is deliberately not collected.";
}

export function createAdmin({ password = "", now, withPhones, withKey, store, snapshot, send, readJson, clientIp, publicUrl }) {
  const configured = typeof password === "string" && password.length >= 24;
  const configurationError = configured ? null : password ? "password_too_short" : "password_missing";
  const configurationMessage = configurationError === "password_too_short"
    ? "The admin password saved on Render is too short. Update ECHO_ADMIN_PASSWORD to at least 24 characters, then select Save and deploy."
    : "Admin access is not configured. Set ECHO_ADMIN_PASSWORD to a private password of at least 24 characters on Render, then select Save and deploy.";
  const passwordHash = hash(password);
  const sessions = new Map(), attempts = new Map(), problems = [];
  const startedAt = now();
  const totals = { requests: 0, failures: 0, limited: 0, durationMs: 0 };
  let tickState = { lastAttemptAt: null, lastSuccessAt: null, failed: false };
  const cookieName = "echo_admin";
  // Production always uses HTTPS. Plain HTTP is allowed only for a loopback development origin.
  const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(publicUrl);
  const cookie = (value, age) => `${cookieName}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${local ? "" : "; Secure"}`;
  const safeWrite = (req) => /^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? "")) &&
    req.headers["sec-fetch-site"] !== "cross-site" &&
    (!req.headers.origin || [`https://${req.headers.host}`, ...(local ? [`http://${req.headers.host}`] : [])].includes(req.headers.origin));
  const session = (req) => {
    const match = /(?:^|;\s*)echo_admin=([a-f0-9]{64})(?:;|$)/.exec(String(req.headers.cookie ?? ""));
    const id = match ? hash(match[1]).toString("hex") : "";
    const entry = sessions.get(id);
    if (!entry || entry.exp <= now()) { sessions.delete(id); return null; }
    return { id, ...entry };
  };
  const limited = (ip) => {
    const t = now();
    for (const [k, v] of attempts) if (v.until <= t) attempts.delete(k);
    const keys = [hash(ip).toString("hex"), "global"];
    if (keys.some((k) => (attempts.get(k)?.hits ?? 0) >= (k === "global" ? 100 : 10))) return true;
    for (const k of keys) { const e = attempts.get(k) ?? { hits: 0, until: t + 15 * 60_000 }; e.hits++; attempts.set(k, e); }
    return false;
  };
  function record(raw) {
    const p = { id: randomUUID().slice(0, 12), at: now(), ...raw };
    problems.unshift({ ...p, hint: problemHint(p) });
    problems.length = Math.min(problems.length, 120);
  }
  function observe(req, res, path) {
    if (path.startsWith("/admin") || path.startsWith("/agent/") || path === "/healthz" || path === "/version" || /\.(js|css|png|jpg|html|webmanifest)$/.test(path) || path === "/") return;
    const t = Date.now(), requestId = randomUUID().slice(0, 12);
    res.setHeader("x-echo-request-id", requestId);
    res.once("finish", () => {
      const durationMs = Math.max(0, Date.now() - t);
      totals.requests++; totals.durationMs += durationMs;
      // The optional Mac can be asleep. Keep traffic metrics, but don't turn
      // an expected relay-offline response into a Phone service failure.
      if (MAC_ROUTES.has(path) && res.statusCode === 503 && res.adminErrorCode === "offline") return;
      if (res.statusCode >= 500) totals.failures++;
      if (res.statusCode === 429) totals.limited++;
      if ([401, 403, 429].includes(res.statusCode) || res.statusCode >= 500) {
        const problem = { source: "server", operation: routeName(path), status: res.statusCode, durationMs, requestId, code: res.adminErrorCode ?? null, account: req.adminDevice ?? null };
        record(problem);
        if (res.statusCode >= 500) console.warn(JSON.stringify({ event: "echo_request_failed", requestId, operation: problem.operation, status: problem.status, code: problem.code }));
      }
    });
  }
  const userSummary = (id, d) => ({ id, account: id.slice(-6), status: d.suspended ? "suspended" : "active", createdAt: d.createdAt ?? null,
    lastSeenAt: d.lastSeenAt ?? null, recovery: !!d.recoveryHash, paired: d.phoneOnly === false,
    notifications: Object.values(d.subscriptions ?? {}).filter((s) => s.sub).length || (d.sub ? 1 : 0),
    tasks: d.daily?.tasks?.length ?? 0, reminders: d.reminders?.length ?? 0, expenses: d.expenses?.length ?? 0 });
  async function overview() {
    const state = await withPhones((p) => {
      const list = Object.entries(p.devices).map(([id, d]) => userSummary(id, d));
      return { total: list.length, active: list.filter((d) => d.status === "active").length, suspended: list.filter((d) => d.status === "suspended").length,
        recentlyActive: list.filter((d) => d.lastSeenAt && now() - d.lastSeenAt < 24 * 3600_000).length, recoveryEnabled: list.filter((d) => d.recovery).length };
    }, { save: false });
    const [tickLast, audit] = await Promise.all([store.count("tick:last"), store.get("admin:audit")]);
    return { ...await snapshot(), startedAt, uptimeSeconds: Math.floor((now() - startedAt) / 1000), users: state,
      requests: { ...totals, averageMs: totals.requests ? Math.round(totals.durationMs / totals.requests) : 0 },
      tick: { ...tickState, lastScheduledAt: tickLast || null }, problems: [...problems], audit: audit?.items ?? [],
      collectedSince: startedAt, sessionHours: 6 };
  }
  async function route(req, res, url) {
    const path = url.pathname;
    const who = session(req);
    if (path === "/admin/api/session" && req.method === "GET") return send(res, 200, { configured, authenticated: !!who, ...(!configured ? { configurationError, message: configurationMessage } : {}), ...(who ? { csrf: who.csrf, expiresAt: who.exp } : {}) });
    if (path === "/admin/api/login" && req.method === "POST") {
      if (!safeWrite(req)) return send(res, 403, { message: "Open the admin page to sign in." });
      if (!configured) return send(res, 503, { message: configurationMessage });
      if (limited(clientIp(req))) return send(res, 429, { message: "Too many admin sign-in attempts. Try again in 15 minutes." });
      const body = await readJson(req, 2048);
      if (typeof body.password !== "string" || !timingSafeEqual(hash(body.password), passwordHash)) return send(res, 401, { message: "The admin password is incorrect." });
      for (const [id, s] of sessions) if (s.exp <= now()) sessions.delete(id);
      if (sessions.size >= 100) return send(res, 429, { message: "Too many admin sessions. Wait for a session to expire." });
      const token = randomBytes(32).toString("hex"), csrf = randomBytes(24).toString("hex"), exp = now() + SESSION_MS;
      if (who) sessions.delete(who.id);
      sessions.set(hash(token).toString("hex"), { csrf, exp });
      return send(res, 200, { authenticated: true, csrf, expiresAt: exp }, { "set-cookie": cookie(token, SESSION_MS / 1000) });
    }
    if (!who) return send(res, 401, { message: "Sign in with the admin password." });
    if (req.method === "POST" && (!safeWrite(req) || req.headers["x-echo-admin-csrf"] !== who.csrf)) return send(res, 403, { message: "This admin action needs a fresh session. Reload and try again." });
    if (path === "/admin/api/logout" && req.method === "POST") {
      sessions.delete(who.id); return send(res, 200, { ok: true }, { "set-cookie": cookie("", 0) });
    }
    if (path === "/admin/api/overview" && req.method === "GET") return send(res, 200, await overview());
    if (path === "/admin/api/users" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 32);
      const page = Math.max(0, Math.min(1_000_000, Number.parseInt(url.searchParams.get("page"), 10) || 0));
      const list = await withPhones((p) => Object.entries(p.devices).map(([id, d]) => userSummary(id, d))
        .filter((d) => d.id.includes(q)).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id)), { save: false });
      return send(res, 200, { total: list.length, page, pageSize: 20, items: list.slice(page * 20, page * 20 + 20) });
    }
    const match = /^\/admin\/api\/users\/([a-f0-9]{32})$/.exec(path);
    if (match && req.method === "GET") {
      const id = match[1];
      const user = await withPhones((p) => p.devices[id] ? userSummary(id, p.devices[id]) : null, { save: false });
      if (!user) return send(res, 404, { message: "That account no longer exists." });
      const [conversations, memory, scans] = await Promise.all([store.get(`conversations:${id}`), store.get(`mem:${id}`), store.get(`snaps:${id}`)]);
      return send(res, 200, { user: { ...user, conversations: conversations?.threads?.length ?? 0, saved: memory?.items?.length ?? 0, scans: scans?.items?.length ?? 0 } });
    }
    if (path === "/admin/api/users/action" && req.method === "POST") {
      const body = await readJson(req, 2048);
      if (!DEVICE_ID.test(String(body.id ?? "")) || !ACTIONS.has(body.action)) return send(res, 400, { message: "Choose a valid account and action." });
      const result = await withPhones((p) => {
        const d = p.devices[body.id]; if (!d) return null;
        if (body.action === "suspend") d.suspended = true;
        if (body.action === "resume") d.suspended = false;
        if (body.action === "disable_notifications") { d.sub = null; d.subscriptions = {}; }
        // Clearing this hash immediately invalidates recovery, even if deleting its index fails.
        const oldHash = body.action === "reset_recovery" ? d.recoveryHash : null;
        if (oldHash) delete d.recoveryHash;
        return { user: userSummary(body.id, d), oldHash };
      });
      if (!result) return send(res, 404, { message: "That account no longer exists." });
      if (result.oldHash) await store.del(`recovery:${result.oldHash}`).catch(() => {});
      let auditStored = true;
      await withKey("admin:audit", () => ({ items: [] }), (a) => {
        a.items = [{ id: randomUUID().slice(0, 12), at: now(), action: body.action, account: body.id }, ...a.items].slice(0, 100);
      }).catch(() => { auditStored = false; record({ source: "server", operation: "Admin audit storage", status: 502 }); });
      return send(res, 200, { ok: true, user: result.user, auditStored });
    }
    return send(res, 404, { message: "Admin operation not found." });
  }
  return { route, observe, tickStarted: () => { tickState.lastAttemptAt = now(); },
    tickFinished: (ok) => { tickState.failed = !ok; if (ok) tickState.lastSuccessAt = now(); else record({ source: "server", operation: "Reminder tick", status: 502 }); },
    clientProblem(device, body) {
      if (!FEATURES.has(body.feature) || !CODES.has(body.code)) return false;
      const platform = ["ios", "android", "desktop", "unknown"].includes(body.platform) ? body.platform : "unknown";
      record({ source: "phone", operation: body.feature, feature: body.feature, code: body.code, account: device, platform,
        app: /^[a-f0-9]{12}$/.test(body.app) ? body.app : null, installed: body.installed === true });
      return true;
    } };
}
