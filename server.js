/**
 * Echo Remote — the relay.
 *
 * The phone app lives here, at one permanent https address. Echo, on the Mac,
 * dials OUT to this server and keeps asking "anything for me?" (long polling),
 * so it is reachable from any network without opening a port, a tunnel or a
 * router setting. A phone request is parked here until Echo collects it, and
 * Echo's answer is handed back.
 *
 * This server decides nothing. The password, sessions, lockouts, approvals and
 * every safety check stay on the Mac, which sees each request as if the phone
 * had asked it directly. What the relay does enforce: only the Echo holding
 * RELAY_SECRET may collect requests, and no one may flood the queue.
 *
 *   RELAY_SECRET   shared with Echo (keys.env: ECHO_RELAY_SECRET). Required.
 *   PORT           set by Render.
 *
 * Phone mode (Echo in the cloud, working with the Mac off) adds, all optional:
 *   GEMINI_API_KEY             the cloud brain (free tier is fine); GEMINI_MODEL to change it
 *   UPSTASH_REDIS_REST_URL     durable, encrypted storage
 *   UPSTASH_REDIS_REST_TOKEN
 *   QSTASH_TOKEN               the 5-minute tick (QSTASH_URL if the console shows one)
 *   GEMINI_EMBED_MODEL         search by meaning in saved memory (default gemini-embedding-001)
 *   GEMINI_BROWSE_MODEL        Echo's browsing, comma-separated in order (default: the two best Flash models the key can use)
 *
 * Phone mode is reached with a cloud pass that Echo on the Mac signs at sign-in
 * (lib/secure.js), so the relay can trust it while the Mac is off. It can never
 * reach the Mac: everything that touches the Mac still goes through the Mac.
 *
 * Node's standard library only, no dependencies.
 */
import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveKeys, verifyPass, seal, unseal } from "./lib/secure.js";
import { createStore } from "./lib/store.js";
import { createGemini, pickBrowseModels } from "./lib/gemini.js";
import { createCloud, CloudError } from "./lib/cloud.js";
import { buildIcs, validEvent } from "./lib/calendar.js";
import { ensureSchedule } from "./lib/tick.js";
import { vapidKeys, sendPush, validSubscription } from "./lib/push.js";
import { DEFAULT_PREFS, cleanPrefs, addReminder, buildBriefing, runTick, localParts, validTz, parsePhoneCalendar } from "./lib/briefing.js";
import { MAX_IMAGE_B64, cleanExpense, monthTotals, recheckSnap, snapActions } from "./lib/snap.js";
import { MAX_WAITING, FINAL, checkTask, checkAssertion, forPhone, tidy, notificationFor } from "./lib/handoff.js";
import { createMemory, fromSnap, fromNote, forPhone as memoryForPhone, syncDates, contextText, comingUp } from "./lib/memory.js";
import {
  UA, SEARCH_URL, MAX_PAGE, MAX_ASSET, PAGE_HEADERS, ASSET_TYPE, proxyPath, fromProxyPath, checkUrl, addressOrSearch, sensitiveHost,
  cookieHeader, storeCookies, fetchUpstream, decodeBody, rewriteHtml, rewriteCss, notePage,
} from "./lib/browse.js";

export const POLL_MS = 25_000;          // how long Echo's "anything for me?" is held open
export const REQUEST_MS = 30_000;       // how long a phone request may wait for Echo's answer
export const SLOW_REQUEST_MS = 90_000;  // voice: Echo transcribes before answering
export const ONLINE_MS = 45_000;        // Echo counts as online this long after its last poll
export const MAX_QUEUE = 64;
export const MAX_BODY = 12 * 1024 * 1024;
export const LOGIN_LIMIT = 10;          // password attempts per address per window
export const LOGIN_WINDOW_MS = 15 * 60_000;

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
/** The app's version: a hash of its files, so an open app can tell it's out of date and reload. */
export const APP_VERSION = (() => {
  const h = createHash("sha256");
  for (const f of ["index.html", "app.js", "app.css", "humanoid-core.js", "sw.js"]) { try { h.update(readFileSync(join(PUBLIC, f))); } catch { /* missing in tests */ } }
  return h.digest("hex").slice(0, 12);
})();
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};
// Everything the phone app is allowed to load: this origin and nothing else.
const SECURITY = {
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
};
/** Echo's own routes, forwarded. Anything else is a static file or a 404. */
const FORWARDED = new Set([
  "/login", "/status", "/events", "/pending", "/confirm", "/command", "/voice", "/mouse", "/keys",
  "/action", "/stop", "/frame", "/signout-all", "/close", "/log", "/rtc/offer", "/rtc/answer", "/rtc/ice",
  "/chat", "/chat/voice", "/chat/import", "/passkey/options", "/passkey/register", "/passkey/login",
]);
/** Phone mode: requests per device per minute, and how big a request may be. */
export const CLOUD_RATE = 30;
export const CLOUD_BODY = 256 * 1024;
export const CLOUD_VOICE_BODY = 4 * 1024 * 1024;
export const MAX_EXPENSES = 500;
export const MAX_SNAPS = 100;
/** How long a calendar link from Phone mode keeps working. */
export const ICS_TTL_MS = 30 * 86400_000;
/** Echo's Browser: how long its session cookie lasts, and requests per phone per minute (pages and their images). */
export const BROWSE_SESSION_MS = 12 * 3600_000;
export const BROWSE_RATE = 900;

/**
 * World intelligence for the World page, from Osiris (osirisai.live): conflict
 * zones, earthquakes (USGS, each with its tsunami flag), wildfires (NASA FIRMS)
 * and severe weather (NASA EONET). Fetched here, not by the phone — the page may
 * only talk to this server — and cached, so any number of phones cost Osiris one
 * request per feed every few minutes. These are Osiris's own feeds, not a
 * published API, so every field is read defensively and a failed feed keeps
 * the last good copy rather than emptying the page.
 */
export const WORLD_TTL_MS = 5 * 60_000;
const OSIRIS = "https://osirisai.live/api";

export function summariseWorld({ conflicts, earthquakes, fires, weather }, now = Date.now()) {
  const day = now - 24 * 3600_000;
  const quakes = (earthquakes?.earthquakes ?? []).filter((q) => Number.isFinite(q?.magnitude) && q.time > day);
  const list = (arr) => (Array.isArray(arr) ? arr : []);
  const fireList = list(fires?.fires);
  return {
    updatedAt: now,
    conflicts: list(conflicts?.zones).map((z) => ({
      id: String(z.id ?? ""), label: String(z.label ?? ""), severity: String(z.severity ?? ""),
      lat: z.lat, lng: z.lng, description: String(z.description ?? "").slice(0, 240),
      latest: list(z.events)[0] ? { title: String(z.events[0].title ?? "").slice(0, 200), url: z.events[0].url ?? null, at: z.events[0].timestamp ?? null } : null,
    })),
    earthquakes: {
      count: quakes.length,
      strong: quakes.filter((q) => q.magnitude >= 4.5).length,
      top: [...quakes].sort((a, b) => b.magnitude - a.magnitude).slice(0, 12)
        .map((q) => ({ id: q.id, magnitude: q.magnitude, place: String(q.place ?? ""), at: q.time, depthKm: q.depth, tsunami: !!q.tsunami, url: q.url ?? null })),
    },
    tsunamis: quakes.filter((q) => q.tsunami).map((q) => ({ id: q.id, magnitude: q.magnitude, place: String(q.place ?? ""), at: q.time })),
    fires: {
      count: fireList.length,
      highConfidence: fireList.filter((f) => /^(h|high)$/i.test(String(f.confidence ?? ""))).length,
      strongest: [...fireList].sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0)).slice(0, 5).map((f) => ({ lat: f.lat, lng: f.lng, frp: f.frp })),
    },
    storms: list(weather?.events).slice(0, 12).map((e) => ({
      id: String(e.id ?? ""), title: String(e.title ?? ""), type: String(e.type ?? ""), severity: String(e.severity ?? ""), at: e.date ?? null, source: e.provider ?? null,
    })),
  };
}

export function createRelay({
  secret, now = () => Date.now(), fetchJson = defaultFetchJson, pollMs = POLL_MS, requestMs = REQUEST_MS,
  gemini = null, store = null, limits = {},
  publicUrl = "https://echo-phone.onrender.com", pushFetch = fetch, pushAnyHost = false, browseAnyHost = false,
} = {}) {
  if (!secret || secret.length < 32) throw new Error("RELAY_SECRET must be set (at least 32 characters).");
  const secretBuf = Buffer.from(secret);
  const keys = deriveKeys(secret);
  const cronBuf = Buffer.from(keys.cron);
  store ??= createStore({ key: keys.store, now });
  /**
   * Cloud passes older than this generation are cancelled ("Sign out every
   * phone"). Echo reports its generation on every poll and the relay keeps the
   * highest it has seen, so a sign-out from either side reaches both.
   */
  let passGen = 0;
  const passGenLoaded = store.count("passgen").then((n) => { passGen = Math.max(passGen, n); }).catch(() => {});
  async function raisePassGen(n) {
    if (!(Number.isInteger(n) && n > passGen)) return;
    passGen = n;
    await store.setCount("passgen", n).catch(() => {});
  }
  const vapid = vapidKeys(secret);
  /**
   * Each phone's notification subscription, briefing settings and reminders,
   * sealed under one store key. Changes go through one at a time.
   */
  let phonesLock = Promise.resolve();
  function withPhones(fn, { save = true } = {}) {
    const run = phonesLock.then(async () => {
      const phones = (await store.get("phones")) ?? { devices: {} };
      phones.devices ??= {};
      const result = await fn(phones);
      if (save) await store.set("phones", phones);
      return result;
    });
    phonesLock = run.catch(() => {});
    return run;
  }
  const deviceOf = (phones, id) => (phones.devices[id] ??= { sub: null, prefs: { ...DEFAULT_PREFS }, lastBrief: "", reminders: [], expenses: [] });
  const push = (sub, message) => sendPush(sub, message, { vapid, contact: publicUrl, fetchImpl: pushFetch, now: now() });
  const briefingTools = { weather: getWeather, worldRaw: async () => (await getWorld()).raw };
  let ticking = null;
  /** The timed work: due reminders and briefings. Never two at once. */
  function tick() {
    ticking ??= withPhones((phones) => runTick({
      phones, now: now(), tools: briefingTools, macOnline: online(), push,
      digest: () => store.get("digest").catch(() => null),
      storeBriefing: (id, b) => store.set(`brief:${id}`, b, 3 * 86400),
      phoneCalendar: (id) => store.get(`cal:${id}`).catch(() => null),
    })).catch(() => false).finally(() => { ticking = null; });
    return ticking;
  }
  /** Hand-off jobs (lib/handoff.js), sealed under one key; changes one at a time. */
  let handoffLock = Promise.resolve();
  let waitingJobs = 0;
  function withHandoffs(fn, { save = true } = {}) {
    const run = handoffLock.then(async () => {
      const state = tidy((await store.get("handoffs")) ?? { items: [] }, now());
      const result = await fn(state);
      waitingJobs = state.items.filter((i) => i.status === "waiting").length;
      if (save) await store.set("handoffs", state);
      return result;
    });
    handoffLock = run.catch(() => {});
    return run;
  }
  void withHandoffs(() => {}, { save: false }).catch(() => {}); // learn how many are waiting
  /** Read-change-write of one sealed store key, one change at a time. */
  const keyLocks = new Map();
  function withKey(key, empty, fn, { save = true, ttl } = {}) {
    const prev = keyLocks.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      const value = (await store.get(key)) ?? empty();
      const result = await fn(value);
      if (save) await store.set(key, value, ttl);
      return result;
    });
    const tail = run.catch(() => {});
    keyLocks.set(key, tail);
    tail.then(() => { if (keyLocks.get(key) === tail) keyLocks.delete(key); });
    return run;
  }
  /** Scan history per phone: what each snap found (never the photo), kept apart from the tick's data. */
  const withSnaps = (device, fn, opts) => withKey(`snaps:${device}`, () => ({ items: [] }), fn, opts);
  const snapSummary = (e) => ({ id: e.id, at: e.at, kind: e.snap.kind, title: e.snap.title, summary: e.snap.summary,
    amount: e.snap.amount, currency: e.snap.currency, date: e.snap.dueDate ?? e.snap.purchaseDate ?? e.snap.eventStart ?? null, done: e.done ?? {}, saved: e.done?.memory ?? null });
  /** Memory (lib/memory.js): saved items per phone; their dates go into the tick's data. */
  const memory = createMemory({
    store, withKey, now, newId: () => randomUUID().slice(0, 8),
    embed: gemini?.embed ? (text, opts) => gemini.embed(text, opts) : null,
    onDates: (device, items, tz) => withPhones((phones) => { syncDates(deviceOf(phones, device), items, tz, now()); }),
  });
  /** Memory as Echo's phone brain uses it: this phone's, found or saved by the tools in lib/cloud.js. */
  async function memoryFor(device, tz) {
    const dev = await withPhones((phones) => deviceOf(phones, device), { save: false });
    const zone = validTz(tz) ? tz : dev.prefs?.tz;
    return {
      upcoming: comingUp(dev, now(), zone, 30),
      search: async (q) => (await memory.search(device, q, { k: 4 })).map((h) => ({ text: contextText(h.meta, h.body) })),
      save: async (note) => (await memory.add(device, fromNote(note), { tz: zone })).item,
    };
  }
  function withLinks(actions) {
    for (const a of actions) if ((a.type === "calendar" || a.type === "reminder") && validEvent(a.data)) a.url = icsUrl(a.data);
    return actions;
  }
  /** The address the iPhone's Shortcut posts today's events to; the key in it only lets it do that. */
  const calendarUrl = (key) => `${publicUrl.replace(/\/+$/, "")}/cal/${key}`;
  const cloudHits = new Map();
  /** Each phone's cookies for the sites it uses in the Browser, sealed in the store, written a moment after they change. */
  const jars = new Map();
  function jarFor(device) {
    let e = jars.get(device);
    if (!e) {
      e = store.get(`jar:${device}`).catch(() => null).then((jar) => ({ jar: jar ?? { cookies: [] }, timer: null }));
      jars.set(device, e);
      if (jars.size > 50) jars.delete(jars.keys().next().value);
    }
    return e;
  }
  async function saveJar(device) {
    const e = await jarFor(device);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { void store.set(`jar:${device}`, e.jar, 30 * 86400).catch(() => {}); }, 1500);
    e.timer.unref?.();
  }
  /**
   * A calendar link that needs no storage: the event is sealed into the address
   * itself (encrypted, so the address shows nothing personal), with an expiry.
   * Made when the button is, so tapping it can open Safari immediately.
   */
  const icsUrl = (event) => `/ics/${seal(keys.store, { e: event, exp: now() + ICS_TTL_MS })}.ics`;
  function icsFromUrl(token) {
    try {
      const { e, exp } = unseal(keys.store, token);
      return exp > now() && validEvent(e) ? e : null;
    } catch { return null; }
  }
  /** Phone requests waiting for Echo to collect them. */
  const queue = [];
  /** Echo's polls waiting for a phone request. */
  const waiters = [];
  /** Requests Echo has collected and not yet answered, by id. */
  const inFlight = new Map();
  const logins = new Map();
  let world = null, worldAt = 0, worldLoading = null;
  const weatherCache = new Map();

  async function getWorld() {
    if (world && now() - worldAt < WORLD_TTL_MS) return world;
    worldLoading ??= (async () => {
      const names = ["conflicts", "earthquakes", "fires", "weather"];
      const results = await Promise.all(names.map((n) => fetchJson(`${OSIRIS}/${n}`).catch(() => null)));
      const fresh = Object.fromEntries(names.map((n, i) => [n, results[i]]));
      if (results.every((r) => r === null)) {
        if (world) return world; // Osiris unreachable: keep showing the last good copy
        throw new Error("Osiris is unreachable right now.");
      }
      // A feed that failed keeps its previous values instead of reading as "none".
      const prev = world?.raw ?? {};
      const raw = Object.fromEntries(names.map((n) => [n, fresh[n] ?? prev[n] ?? null]));
      world = { ...summariseWorld(raw, now()), raw };
      worldAt = now();
      return world;
    })().finally(() => { worldLoading = null; });
    return worldLoading;
  }

  async function getWeather(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = weatherCache.get(key);
    if (hit && now() - hit.at < 10 * 60_000) return hit.value;
    const q = new URLSearchParams({
      latitude: String(lat), longitude: String(lon), timezone: "auto", forecast_days: "1",
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      daily: "temperature_2m_max,temperature_2m_min",
    });
    const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?${q}`);
    const value = {
      temp: d?.current?.temperature_2m, feels: d?.current?.apparent_temperature, humidity: d?.current?.relative_humidity_2m,
      code: d?.current?.weather_code, wind: d?.current?.wind_speed_10m, isDay: d?.current?.is_day === 1,
      high: d?.daily?.temperature_2m_max?.[0], low: d?.daily?.temperature_2m_min?.[0], timezone: d?.timezone ?? null,
    };
    weatherCache.set(key, { at: now(), value });
    if (weatherCache.size > 500) weatherCache.delete(weatherCache.keys().next().value);
    return value;
  }
  const cloud = gemini ? createCloud({
    gemini, store, now, limits,
    tools: {
      weather: getWeather,
      world: async () => { const { raw, ...w } = await getWorld(); return w; },
      geocode: async (q) => ((await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(q)}`))?.results ?? [])
        .map((r) => ({ name: r.name, country: r.country ?? "", lat: r.latitude, lon: r.longitude })),
    },
  }) : null;

  let lastPoll = 0;

  const online = () => now() - lastPoll < ONLINE_MS;
  const agentAuthorized = (req) => {
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    return given.length === secretBuf.length && timingSafeEqual(given, secretBuf);
  };
  // Render puts the caller's address first in X-Forwarded-For.
  const clientIp = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";

  function send(res, status, body, headers = {}) {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY, "cache-control": "no-store",
      "content-type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/plain",
      ...headers,
    });
    res.end(data);
  }

  function readBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  /** Give the next queued request to a waiting poll, while there are both. */
  function dispatch() {
    while (queue.length && waiters.length) {
      const job = queue.shift();
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      inFlight.set(job.id, job);
      waiter.res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-relay-pass-gen": String(passGen), "x-relay-handoffs": String(waitingJobs) });
      waiter.res.end(JSON.stringify(job.wire));
    }
  }

  async function forward(req, res, path, search) {
    if (!online()) return send(res, 503, { error: "offline", message: "Echo is offline — your Mac is asleep, off, or not connected." });
    if (queue.length >= MAX_QUEUE) return send(res, 503, { error: "busy", message: "Too many requests at once." });
    const ip = clientIp(req);
    // Sign-in attempts count against the address until Echo accepts one, so a
    // correct password never uses up the allowance — only guesses do.
    let attempt = 0;
    if (path === "/login" || path === "/passkey/login") {
      attempt = now();
      const recent = (logins.get(ip) ?? []).filter((t) => attempt - t < LOGIN_WINDOW_MS);
      if (recent.length >= LOGIN_LIMIT) return send(res, 429, { error: "Too many sign-in attempts. Wait 15 minutes." });
      recent.push(attempt);
      logins.set(ip, recent);
    }
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, e.status ?? 400, { error: "Request too large." }); }
    const id = randomUUID();
    const wire = {
      id, method: req.method, path: path + search, ip,
      headers: { "content-type": req.headers["content-type"] ?? "", cookie: req.headers.cookie ?? "" },
      body: body.length ? body.toString("base64") : "",
    };
    const limit = path === "/voice" || path === "/chat/voice" ? Math.max(requestMs, SLOW_REQUEST_MS) : requestMs;
    const job = {
      id, wire,
      respond: (status, headers, payload) => {
        clearTimeout(job.timer);
        inFlight.delete(id);
        const idx = queue.indexOf(job);
        if (idx >= 0) queue.splice(idx, 1);
        if (attempt && status < 400) {
          const list = logins.get(ip) ?? [];
          const at = list.indexOf(attempt);
          if (at >= 0) list.splice(at, 1);
          if (!list.length) logins.delete(ip);
        }
        if (res.writableEnded) return;
        const out = { "cache-control": "no-store" };
        for (const name of ["content-type", "set-cookie", "cache-control"]) if (headers?.[name]) out[name] = headers[name];
        res.writeHead(status, { ...SECURITY, ...out });
        res.end(payload);
      },
    };
    job.timer = setTimeout(() => job.respond(504, { "content-type": "application/json" }, JSON.stringify({ error: "Echo didn't answer in time." })), limit);
    // The phone gave up (closed the app, lost signal): forget the request. The
    // response's close, not the request's, which fires once the body is read.
    res.on("close", () => { if (!res.writableEnded) { clearTimeout(job.timer); inFlight.delete(id); const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); } });
    queue.push(job);
    dispatch();
  }

  async function agentPoll(req, res) {
    lastPoll = now();
    await passGenLoaded;
    await raisePassGen(Number(req.headers["x-echo-pass-gen"]));
    const waiter = { res, timer: setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      res.writeHead(204, { "cache-control": "no-store", "x-relay-pass-gen": String(passGen), "x-relay-handoffs": String(waitingJobs) });
      res.end();
    }, pollMs) };
    res.on("close", () => {
      clearTimeout(waiter.timer);
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      // Echo hung up mid-poll (quit, crashed, lost its connection) rather than
      // being answered: with no other poll open it is gone now, not in 45 s —
      // and the requests it was holding will never be answered.
      if (!res.writableEnded && waiters.length === 0) dropped();
    });
    waiters.push(waiter);
    dispatch();
  }

  function dropped() {
    lastPoll = 0;
    const gone = JSON.stringify({ error: "offline", message: "Echo went offline." });
    for (const job of [...inFlight.values(), ...queue]) job.respond(503, { "content-type": "application/json" }, gone);
  }

  /** Echo reports on a hand-off job; a finished one becomes a notification on the phone that left it. */
  async function agentHandoffUpdate(req, res) {
    try {
      const b = await readJson(req, 16 * 1024);
      if (!["started", "done", "failed", "rejected"].includes(b.status)) return send(res, 400, { error: "status" });
      const item = await withHandoffs((st) => {
        const it = st.items.find((i) => i.task.id === b.id);
        if (!it || FINAL.has(it.status)) return null;
        it.status = b.status;
        it.summary = typeof b.summary === "string" ? b.summary.slice(0, 500) : null;
        it.updatedAt = now();
        return it;
      });
      if (!item) return send(res, 404, { error: "unknown job" });
      const note = notificationFor(item);
      if (note) {
        const sub = await withPhones((phones) => phones.devices[item.task.device]?.sub ?? null, { save: false }).catch(() => null);
        if (sub) await push(sub, { ...note, url: "/?view=missions", tag: `h-${item.task.id}` }).catch(() => {});
      }
      send(res, 204, "");
    } catch { send(res, 400, { error: "bad update" }); }
  }

  /** What the Mac leaves for the morning briefing (Echo's phone-digest.ts), kept sealed for a week. */
  async function agentDigest(req, res) {
    try {
      const d = await readJson(req, 64 * 1024);
      const str = (v, n) => String(v ?? "").slice(0, n);
      const digest = {
        at: now(),
        calendar: Array.isArray(d.calendar) ? d.calendar.slice(0, 40).map((e) => ({ title: str(e.title, 120), start: str(e.start, 40) })) : null,
        email: Array.isArray(d.email) ? d.email.slice(0, 10).map((e) => ({ from: str(e.from, 80), subject: str(e.subject, 160) })) : null,
        missions: Array.isArray(d.missions) ? d.missions.slice(0, 10).map((m) => ({ goal: str(m.goal, 160), status: str(m.status, 20), at: Number(m.at) || now() })) : [],
      };
      const old = await store.get("digest").catch(() => null);
      // A reading the Mac skipped this hour keeps the last one it made.
      if (!digest.calendar && old?.calendar) digest.calendar = old.calendar;
      if (!digest.email && old?.email) digest.email = old.email;
      await store.set("digest", digest, 7 * 86400);
      send(res, 204, "");
    } catch { send(res, 400, { error: "bad digest" }); }
  }

  async function agentReply(req, res) {
    lastPoll = now();
    let reply;
    try { reply = JSON.parse((await readBody(req, MAX_BODY * 2)).toString("utf8")); } catch { return send(res, 400, { error: "bad reply" }); }
    const job = inFlight.get(String(reply?.id ?? ""));
    if (!job) return send(res, 404, { error: "unknown request" });
    const status = Number.isInteger(reply.status) && reply.status >= 100 && reply.status < 600 ? reply.status : 502;
    job.respond(status, reply.headers ?? {}, reply.body ? Buffer.from(String(reply.body), "base64") : "");
    send(res, 204, "");
  }

  // ---- Phone mode ----------------------------------------------------------

  /** The cloud pass on this request, if it is genuine and current. */
  async function cloudClaims(req) {
    await passGenLoaded;
    return verifyPass(keys.pass, req.headers["x-echo-pass"], { minGen: passGen, now: now() });
  }
  function rateLimited(device) {
    const t = now();
    const hits = (cloudHits.get(device) ?? []).filter((x) => t - x < 60_000);
    hits.push(t);
    cloudHits.set(device, hits);
    if (cloudHits.size > 500) for (const [k, v] of cloudHits) if (!v.some((x) => t - x < 60_000)) cloudHits.delete(k);
    return hits.length > CLOUD_RATE;
  }
  async function readJson(req, limit) {
    return JSON.parse((await readBody(req, limit)).toString("utf8") || "{}");
  }
  const CLOUD_STATUS = { setup: 503, cap: 429, quota: 429, minute: 429, busy: 429, input: 400, failed: 502 };
  function sendCloudError(res, e) {
    if (e instanceof CloudError) return send(res, CLOUD_STATUS[e.kind] ?? 502, { error: e.kind, message: e.message, resetsAt: e.resetsAt ?? null, retryAfter: e.retryAfter ?? null });
    if (e?.status === 413) return send(res, 413, { error: "input", message: "That's too long to send." });
    if (e instanceof SyntaxError) return send(res, 400, { error: "input", message: "Bad request." });
    return send(res, 502, { error: "failed", message: "Phone mode had a problem. Try again." });
  }

  async function cloudRoute(req, res, path) {
    const claims = await cloudClaims(req);
    if (!claims) return send(res, 401, { error: "pass", message: "Sign in once with your Mac online to use Phone mode." });
    if (path === "/cloud/status" && req.method === "GET") {
      return send(res, 200, {
        ready: Boolean(cloud), model: gemini?.model ?? null, store: store.remote ? "upstash" : "memory",
        macOnline: online(), usage: cloud ? await cloud.usage().catch(() => null) : null, passExpires: claims.exp,
      });
    }
    const device = claims.device;
    if (req.method === "GET") {
      if (path === "/cloud/push/key") return send(res, 200, { key: vapid.publicKey });
      if (path === "/cloud/briefing") {
        const dev = await withPhones((phones) => deviceOf(phones, device), { save: false });
        return send(res, 200, { prefs: dev.prefs, subscribed: Boolean(dev.sub), latest: await store.get(`brief:${device}`).catch(() => null) });
      }
      if (path === "/cloud/snaps") {
        const id = new URL(req.url, "http://x").searchParams.get("id");
        const items = await withSnaps(device, (st) => st.items, { save: false });
        if (!id) return send(res, 200, { items: items.slice().reverse().map(snapSummary) });
        const e = items.find((x) => x.id === id);
        if (!e) return send(res, 404, { error: "input", message: "That scan was deleted." });
        const tz = validTz(new URL(req.url, "http://x").searchParams.get("tz")) ? new URL(req.url, "http://x").searchParams.get("tz") : "UTC";
        const actions = withLinks(snapActions(e.snap, { today: localParts(now(), tz).date })).map((a) => ({ ...a, done: Boolean(e.done?.[a.type] && (a.type === "expense" || a.type === "reminder")) }));
        return send(res, 200, { id: e.id, at: e.at, snap: e.snap, actions, saved: e.done?.memory ?? null });
      }
      if (path === "/cloud/memory") {
        const q = new URL(req.url, "http://x").searchParams;
        const id = q.get("id");
        if (id) {
          const found = await memory.get(device, id);
          if (!found) return send(res, 404, { error: "input", message: "That was deleted." });
          return send(res, 200, { item: memoryForPhone(found.meta), body: found.body });
        }
        const dev = await withPhones((phones) => deviceOf(phones, device), { save: false });
        const items = await memory.list(device);
        return send(res, 200, { items: items.slice().reverse().map(memoryForPhone), upcoming: comingUp(dev, now(), validTz(q.get("tz")) ? q.get("tz") : dev.prefs?.tz, 30) });
      }
      if (path === "/cloud/calendar") {
        const key = await withPhones((phones) => { const d = deviceOf(phones, device); d.calKey ??= randomBytes(18).toString("base64url"); return d.calKey; });
        const last = await store.get(`cal:${device}`).catch(() => null);
        return send(res, 200, { url: calendarUrl(key), last: last ? { at: last.at, count: last.events.length } : null });
      }
      if (path === "/cloud/handoff") {
        const items = await withHandoffs((st) => st.items.filter((i) => i.task.device === device).map(forPhone), { save: false });
        return send(res, 200, { items: items.reverse().slice(0, 20), macOnline: online() });
      }
      if (path === "/cloud/expenses") {
        const dev = await withPhones((phones) => deviceOf(phones, device), { save: false });
        const tz = validTz(dev.prefs?.tz) ? dev.prefs.tz : "UTC";
        const month = /^\d{4}-\d{2}$/.test(String(new URL(req.url, "http://x").searchParams.get("month"))) ? new URL(req.url, "http://x").searchParams.get("month") : localParts(now(), tz).date.slice(0, 7);
        return send(res, 200, monthTotals(dev.expenses ?? [], month));
      }
      if (path === "/cloud/reminders") {
        const dev = await withPhones((phones) => deviceOf(phones, device), { save: false });
        return send(res, 200, { reminders: (dev.reminders ?? []).filter((r) => !r.sent).sort((x, y) => x.at - y.at) });
      }
      return send(res, 404, "Not found");
    }
    if (req.method !== "POST") return send(res, 404, "Not found");
    if (path.startsWith("/cloud/push/") || path.startsWith("/cloud/briefing") || path.startsWith("/cloud/reminders") || path.startsWith("/cloud/expenses")) {
      try {
        const body = await readJson(req, 16 * 1024);
        if (path === "/cloud/push/subscribe") {
          const sub = body.subscription;
          if (!validSubscription(sub) && !(pushAnyHost && sub?.endpoint)) return send(res, 400, { error: "input", message: "That notification subscription isn't valid." });
          await withPhones((phones) => { deviceOf(phones, device).sub = { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }; });
          return send(res, 200, { ok: true });
        }
        if (path === "/cloud/push/unsubscribe") {
          await withPhones((phones) => { deviceOf(phones, device).sub = null; });
          return send(res, 200, { ok: true });
        }
        if (path === "/cloud/push/test") {
          const dev = await withPhones((phones) => deviceOf(phones, device), { save: false });
          if (!dev.sub) return send(res, 409, { error: "input", message: "Notifications aren't on for this phone yet." });
          const r = await push(dev.sub, { title: "Echo", body: "Notifications are on. Your briefing and reminders will arrive here.", url: "/", tag: "test" });
          if (r.gone) await withPhones((phones) => { deviceOf(phones, device).sub = null; });
          return send(res, r.ok ? 200 : 502, { ok: r.ok, message: r.ok ? "Sent." : r.gone ? "This phone's notifications were turned off. Turn them on again." : "Apple didn't accept it. Try again." });
        }
        if (path === "/cloud/briefing/prefs") {
          const prefs = await withPhones((phones) => { const dev = deviceOf(phones, device); dev.prefs = cleanPrefs(body.prefs ?? {}, dev.prefs); return dev.prefs; });
          return send(res, 200, { prefs });
        }
        if (path === "/cloud/briefing/now") {
          const dev = await withPhones((phones) => { const d = deviceOf(phones, device); d.prefs = cleanPrefs(body.prefs ?? {}, d.prefs); return d; });
          const b = await buildBriefing({ prefs: dev.prefs, dev, now: now(), tools: briefingTools, digest: await store.get("digest").catch(() => null), macOnline: online(), phoneCal: await store.get(`cal:${device}`).catch(() => null) });
          await store.set(`brief:${device}`, b, 3 * 86400).catch(() => {});
          return send(res, 200, { briefing: b });
        }
        if (path === "/cloud/reminders") {
          const r = await withPhones((phones) => addReminder(deviceOf(phones, device), body, now(), randomUUID().slice(0, 8)));
          return send(res, 200, { reminder: r });
        }
        if (path === "/cloud/expenses") {
          const tz = validTz(body.tz) ? body.tz : "UTC";
          const expense = await withPhones((phones) => {
            const d = deviceOf(phones, device);
            const x = { id: randomUUID().slice(0, 8), ...cleanExpense(body.expense, localParts(now(), tz).date) };
            d.expenses = [...(d.expenses ?? []), x].slice(-MAX_EXPENSES);
            return x;
          });
          return send(res, 200, { expense });
        }
        if (path === "/cloud/expenses/delete") {
          await withPhones((phones) => { const d = deviceOf(phones, device); d.expenses = (d.expenses ?? []).filter((x) => x.id !== body.id); });
          return send(res, 200, { ok: true });
        }
        if (path === "/cloud/reminders/cancel") {
          await withPhones((phones) => { const d = deviceOf(phones, device); d.reminders = (d.reminders ?? []).filter((r) => r.id !== body.id); });
          return send(res, 200, { ok: true });
        }
      } catch (e) {
        if (e?.input) return send(res, 400, { error: "input", message: e.message });
        return sendCloudError(res, e);
      }
      return send(res, 404, "Not found");
    }
    if (path === "/cloud/signout-all") {
      await raisePassGen(passGen + 1);
      return send(res, 200, { ok: true });
    }
    if (path === "/cloud/ics") {
      try {
        const { event } = await readJson(req, 16 * 1024);
        if (!validEvent(event)) return send(res, 400, { error: "input", message: "That event is missing a title or time." });
        return send(res, 200, { url: icsUrl(event) });
      } catch (e) { return sendCloudError(res, e); }
    }
    if (path === "/cloud/snaps/done" || path === "/cloud/snaps/delete" || path === "/cloud/calendar/reset") {
      try {
        const body = await readJson(req, 16 * 1024);
        if (path === "/cloud/calendar/reset") {
          const key = await withPhones((phones) => { const d = deviceOf(phones, device); d.calKey = randomBytes(18).toString("base64url"); return d.calKey; });
          return send(res, 200, { url: calendarUrl(key) });
        }
        if (path === "/cloud/snaps/delete") {
          await withSnaps(device, (st) => { st.items = st.items.filter((x) => x.id !== body.id); });
          return send(res, 200, { ok: true });
        }
        if (!["expense", "reminder"].includes(body.type)) return send(res, 400, { error: "input" });
        await withSnaps(device, (st) => { const e = st.items.find((x) => x.id === body.id); if (e) e.done = { ...(e.done ?? {}), [body.type]: true }; });
        return send(res, 200, { ok: true });
      } catch (e) { return sendCloudError(res, e); }
    }
    if (path.startsWith("/cloud/browse/")) {
      try {
        if (path === "/cloud/browse/session") {
          // The Browser's pages load in a frame, which can't send the cloud pass; a short-lived cookie for /b/ stands in for it.
          const token = seal(keys.store, { d: device, exp: now() + BROWSE_SESSION_MS, g: passGen });
          const secure = Boolean(req.socket.encrypted) || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
          return send(res, 200, { ok: true, until: now() + BROWSE_SESSION_MS }, {
            "set-cookie": `eb=${token}; Path=/b/; HttpOnly; SameSite=Strict; Max-Age=${BROWSE_SESSION_MS / 1000}${secure ? "; Secure" : ""}`,
          });
        }
        if (path === "/cloud/browse/clear") {
          const e = await jarFor(device);
          e.jar.cookies = [];
          await store.set(`jar:${device}`, e.jar, 30 * 86400).catch(() => {});
          return send(res, 200, { ok: true });
        }
        if (path === "/cloud/browse/plan" || path === "/cloud/browse/step" || path === "/cloud/browse/report") {
          if (!cloud) return send(res, 503, { error: "setup", message: "Echo's browsing needs Phone mode's brain: add GEMINI_API_KEY on Render." });
          if (rateLimited(device)) return send(res, 429, { error: "busy", message: "Slow down a little — too many requests this minute." });
          const b = await readJson(req, CLOUD_BODY);
          const context = b.context ?? {};
          if (path === "/cloud/browse/plan") return send(res, 200, await cloud.browsePlan({ task: b.task, page: b.page, context }));
          if (path === "/cloud/browse/report") return send(res, 200, await cloud.browseReport({ task: b.task, plan: b.plan, notes: b.notes, sources: b.sources, context }));
          return send(res, 200, await cloud.browseStep({
            task: b.task, plan: b.plan, current: b.current, attempt: b.attempt, lastFail: b.lastFail, memory: b.memory,
            history: b.history, notes: b.notes, page: b.page, userSaid: b.userSaid, blocked: Array.isArray(b.blocked) ? b.blocked.slice(0, 20).map(String) : [], context,
          }));
        }
      } catch (e) {
        if (e?.input) return send(res, 400, { error: "input", message: e.message });
        return sendCloudError(res, e);
      }
      return send(res, 404, "Not found");
    }
    if (path.startsWith("/cloud/memory/")) {
      try {
        const body = await readJson(req, 64 * 1024);
        const tz = validTz(body.tz) ? body.tz : undefined;
        if (path === "/cloud/memory/save" || path === "/cloud/memory/search") {
          if (rateLimited(device)) return send(res, 429, { error: "busy", message: "Slow down a little — too many requests this minute." });
        }
        if (path === "/cloud/memory/save") {
          let draft;
          if (body.note) draft = fromNote(body.note);
          else {
            const snapId = typeof body.snapId === "string" ? body.snapId : null;
            const kept = snapId ? await withSnaps(device, (st) => st.items.find((x) => x.id === snapId) ?? null, { save: false }) : null;
            const snap = body.snap ?? kept?.snap;
            if (!snap) return send(res, 400, { error: "input", message: "That scan was deleted. Snap it again to save it." });
            draft = fromSnap(snap, { snapId: kept ? snapId : null });
          }
          const { item, existing } = await memory.add(device, draft, { tz });
          if (draft.snapId) await withSnaps(device, (st) => { const e = st.items.find((x) => x.id === draft.snapId); if (e) e.done = { ...(e.done ?? {}), memory: item.id }; });
          return send(res, 200, { item: memoryForPhone(item), existing });
        }
        if (path === "/cloud/memory/update") {
          const item = await memory.update(device, String(body.id ?? ""), {
            ...(typeof body.title === "string" ? { title: body.title } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}),
            ...(Array.isArray(body.dates) ? { dates: body.dates } : {}), ...(typeof body.remind === "boolean" ? { remind: body.remind } : {}),
            ...(body.snap && typeof body.snap === "object" ? { snap: body.snap } : {}),
          }, { tz });
          return send(res, 200, { item: memoryForPhone(item) });
        }
        if (path === "/cloud/memory/delete") {
          await memory.remove(device, String(body.id ?? ""), { tz });
          await withSnaps(device, (st) => { for (const e of st.items) if (e.done?.memory === body.id) { const { memory: _, ...rest } = e.done; e.done = rest; } });
          return send(res, 200, { ok: true });
        }
        if (path === "/cloud/memory/search") {
          const hits = await memory.search(device, String(body.q ?? ""), { k: 10, withBodies: false });
          return send(res, 200, { items: hits.map((h) => ({ ...memoryForPhone(h.meta), score: Math.round(h.score * 100) / 100 })) });
        }
      } catch (e) {
        if (e?.input) return send(res, 400, { error: "input", message: e.message });
        return sendCloudError(res, e);
      }
      return send(res, 404, "Not found");
    }
    if (path === "/cloud/handoff" || path === "/cloud/handoff/cancel") {
      try {
        const body = await readJson(req, 64 * 1024);
        if (path === "/cloud/handoff/cancel") {
          const ok = await withHandoffs((st) => {
            const it = st.items.find((i) => i.task.id === body.id && i.task.device === device && i.status === "waiting");
            if (it) { it.status = "cancelled"; it.updatedAt = now(); }
            return Boolean(it);
          });
          return send(res, ok ? 200 : 409, ok ? { ok } : { error: "input", message: "That job already reached your Mac." });
        }
        const task = checkTask(body.task, device, now());
        const assertion = checkAssertion(body.assertion);
        const item = await withHandoffs((st) => {
          if (st.items.some((i) => i.task.id === task.id)) throw Object.assign(new Error("That job is already waiting."), { input: true });
          // The same job twice (a double tap, or asked again before the Mac was back) would run twice.
          const same = (t) => t.trim().toLowerCase().replace(/\s+/g, " ");
          if (st.items.some((i) => i.task.device === device && ["waiting", "started"].includes(i.status) && same(i.task.text) === same(task.text))) {
            throw Object.assign(new Error("That job is already waiting for your Mac."), { input: true });
          }
          if (st.items.filter((i) => i.status === "waiting").length >= MAX_WAITING) throw Object.assign(new Error(`${MAX_WAITING} jobs are already waiting for your Mac.`), { input: true });
          const it = { task, assertion, status: "waiting", summary: null, updatedAt: now() };
          st.items.push(it);
          return it;
        });
        return send(res, 200, { item: forPhone(item), macOnline: online() });
      } catch (e) {
        if (e?.input) return send(res, 400, { error: "input", message: e.message });
        return sendCloudError(res, e);
      }
    }
    if (path === "/cloud/snap/actions") {
      // The user corrected a field: the buttons are made again from the corrected snap. No AI call.
      try {
        const body = await readJson(req, 64 * 1024);
        const tz = validTz(body.tz) ? body.tz : "UTC";
        const snap = recheckSnap(body.snap);
        const actions = withLinks(snapActions(snap, { today: localParts(now(), tz).date }));
        if (typeof body.id === "string") await withSnaps(device, (st) => { const e = st.items.find((x) => x.id === body.id); if (e) e.snap = snap; });
        return send(res, 200, { snap, actions });
      } catch (e) { return sendCloudError(res, e); }
    }
    if (path === "/cloud/snap") {
      if (!cloud) return send(res, 503, { error: "setup", message: "Snap needs Phone mode's brain: add GEMINI_API_KEY on Render." });
      if (rateLimited(claims.device)) return send(res, 429, { error: "busy", message: "Slow down a little — too many requests this minute." });
      try {
        const body = await readJson(req, CLOUD_VOICE_BODY);
        const image = String(body.image ?? "");
        if (image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]{1000,}$/.test(image)) return send(res, 400, { error: "input", message: "That photo didn't come through. Try again." });
        const result = await cloud.snap({ image, context: body.context ?? {} });
        withLinks(result.actions);
        if (result.snap.readable) {
          result.id = randomUUID().slice(0, 8);
          await withSnaps(device, (st) => { st.items = [...st.items, { id: result.id, at: now(), snap: result.snap, done: {} }].slice(-MAX_SNAPS); });
        }
        return send(res, 200, result);
      } catch (e) { return sendCloudError(res, e); }
    }
    if (path === "/cloud/chat" || path === "/cloud/voice") {
      if (!cloud) return send(res, 503, { error: "setup", message: "Phone mode isn't set up yet: add GEMINI_API_KEY on Render." });
      if (rateLimited(claims.device)) return send(res, 429, { error: "busy", message: "Slow down a little — too many messages this minute." });
      try {
        const body = await readJson(req, path === "/cloud/voice" ? CLOUD_VOICE_BODY : CLOUD_BODY);
        const context = { ...(body.context && typeof body.context === "object" ? body.context : {}), macOnline: online() };
        const mem = await memoryFor(device, context.tz).catch(() => null);
        let result;
        if (path === "/cloud/voice") {
          const audio = String(body.audio ?? "");
          if (!/^[A-Za-z0-9+/=]{100,}$/.test(audio)) return send(res, 400, { error: "input", message: "That recording didn't come through." });
          result = await cloud.chat({ history: body.history, audio, context, memory: mem });
        } else result = await cloud.chat({ history: body.history, text: body.text, context, memory: mem });
        for (const a of result.actions) if ((a.type === "calendar" || a.type === "reminder") && validEvent(a.data)) a.url = icsUrl(a.data);
        return send(res, 200, result);
      } catch (e) { return sendCloudError(res, e); }
    }
    return send(res, 404, "Not found");
  }

  // ---- Echo's Browser (lib/browse.js) ------------------------------------------

  async function browseClaims(req) {
    const m = /(?:^|;\s*)eb=([A-Za-z0-9._-]+)/.exec(String(req.headers.cookie ?? ""));
    if (!m) return null;
    try {
      const c = unseal(keys.store, m[1]);
      await passGenLoaded;
      return c && c.exp > now() && c.g >= passGen && typeof c.d === "string" ? c : null;
    } catch { return null; }
  }
  const sendPage = (res, status, html) => send(res, status, html, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
  const redirect = (res, location) => { res.writeHead(302, { ...SECURITY, ...PAGE_HEADERS, location }); res.end(); };
  /** The real page a frame request came from (its Referer is one of ours), for the site's own Referer check. */
  function realReferer(req) {
    try { return fromProxyPath(new URL(String(req.headers.referer ?? "")).pathname)?.url ?? null; } catch { return null; }
  }
  function hitLimit(key, max) {
    const t = now();
    const hits = (cloudHits.get(key) ?? []).filter((x) => t - x < 60_000);
    hits.push(t);
    cloudHits.set(key, hits);
    return hits.length > max;
  }

  /**
   * Can this server reach the web? A few fixed pages, fetched the Browser's
   * way; no input, so it can't be pointed anywhere else. Kept for a minute.
   */
  let selfTest = null;
  function browseSelfTest() {
    if (selfTest && now() - selfTest.at < 60_000) return selfTest.result;
    const sites = ["https://en.wikipedia.org/wiki/Budapest", SEARCH_URL("budapest"), "https://html.duckduckgo.com/html/?q=budapest", "https://news.ycombinator.com/"];
    const result = Promise.all(sites.map(async (u) => {
      const t0 = Date.now();
      try {
        const r = await fetchUpstream({ url: u, headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" }, timeoutMs: 10_000, anyHost: browseAnyHost });
        return { site: new URL(u).hostname, status: r.status, bytes: r.body.length, ms: Date.now() - t0, location: r.headers.location ? String(r.headers.location).slice(0, 80) : undefined };
      } catch (e) { return { site: new URL(u).hostname, error: e?.code ?? String(e?.message ?? e), ms: Date.now() - t0 }; }
    })).then((rows) => ({ at: new Date(now()).toISOString(), rows }));
    selfTest = { at: now(), result };
    return result;
  }

  const markStatus = (html, status) => (status === "error" || status >= 400 ? html.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta name="echo-status" content="${status}">`) : html);

  async function browseRoute(req, res, url) {
    const path = url.pathname;
    const who = await browseClaims(req);
    if (!who) return sendPage(res, 401, notePage("Open the Browser again", "This page's session ended. Go back to Echo's Browser tab.").replace("<title>", '<meta name="echo-auth" content="expired"><title>'));
    if (hitLimit(`b:${who.d}`, BROWSE_RATE)) return sendPage(res, 429, notePage("Slow down a little", "Too many pages this minute. Try again in a moment."));
    if (path === "/b/go") {
      const q = String(url.searchParams.get("q") ?? "").slice(0, 2000);
      const target = url.searchParams.get("search") ? (q.trim() ? SEARCH_URL(q.trim()) : null) : addressOrSearch(q);
      return target ? redirect(res, proxyPath("p", target)) : sendPage(res, 400, notePage("Type an address or a search", ""));
    }
    const t = fromProxyPath(path);
    if (!t) return sendPage(res, 404, notePage("That address can't be opened", "It isn't a web address Echo's Browser can show."));
    let target = t.url, method = "GET", body = null;
    if (t.kind === "g") { const u = new URL(t.url); u.search = url.search; target = u.href; }
    if (t.kind === "f") {
      if (req.method !== "POST") return redirect(res, proxyPath("p", t.url));
      try { body = await readBody(req, 1024 * 1024); } catch { return sendPage(res, 413, notePage("That form is too big to send", "")); }
      method = "POST";
      // Sign-ins to banks and payment services stay in the phone's own browser, where nothing sits in between.
      const host = new URL(target).hostname;
      if (sensitiveHost(host) && /(^|&|name=")[^=&"]*(pass|pwd|pin|otp|cvv|cvc|card)[^=&"]*/i.test(body.toString("latin1").slice(0, 20000))) {
        return sendPage(res, 200, notePage("Sign in to this one outside Echo", `Echo's Browser doesn't carry sign-ins to banks and payment services like ${host}. Tap ⋯ → Open the real page.`, target));
      }
    }
    if (!checkUrl(target)) return sendPage(res, 400, notePage("That address can't be opened", ""));
    const jarE = await jarFor(who.d);
    const headers = {
      "user-agent": UA, "accept-language": String(req.headers["accept-language"] ?? "en-US,en;q=0.9").slice(0, 200),
      accept: t.kind === "r" ? "image/avif,image/webp,image/*,text/css,*/*;q=0.8" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    const ref = realReferer(req);
    if (ref) headers.referer = ref;
    if (method === "POST") { headers["content-type"] = String(req.headers["content-type"] ?? "application/x-www-form-urlencoded").slice(0, 200); headers.origin = new URL(target).origin; }
    let up;
    for (let hop = 0; ; hop++) {
      const cookie = cookieHeader(jarE.jar, target, now());
      if (cookie) headers.cookie = cookie; else delete headers.cookie;
      try {
        up = await fetchUpstream({ url: target, method, headers, body, limit: t.kind === "r" ? MAX_ASSET : MAX_PAGE, anyHost: browseAnyHost });
      } catch (e) {
        if (t.kind !== "r") console.log(`[browse] ${t.kind} ${new URL(target).hostname} failed: ${e?.code ?? e?.message ?? e}`);
        if (t.kind === "r") return send(res, 502, "");
        // DuckDuckGo often doesn't answer servers at all: the same search on Bing.
        const q = new URL(target).hostname === "html.duckduckgo.com" ? new URL(target).searchParams.get("q") : null;
        if (q) return redirect(res, proxyPath("p", SEARCH_URL(q)));
        const why = e?.code === "EBLOCKED" ? "Echo's Browser only opens public websites." : e?.code === "ENOTFOUND" ? "That site doesn't exist, or its address is mistyped." : e?.code === "ETIMEDOUT" ? "The site took too long to answer." : "The site couldn't be reached.";
        return sendPage(res, 200, markStatus(notePage("Couldn't open that page", why, target), "error"));
      }
      const setCookie = up.headers["set-cookie"];
      if (storeCookies(jarE.jar, target, Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [], now())) void saveJar(who.d);
      const loc = up.status >= 300 && up.status < 400 ? up.headers.location : null;
      if (!loc) break;
      let next;
      try { next = new URL(String(loc), target); } catch { next = null; }
      if (!next || !checkUrl(next.href)) return t.kind === "r" ? send(res, 502, "") : sendPage(res, 200, notePage("Couldn't open that page", "The site sent Echo somewhere it can't go.", target));
      // A page's redirect goes through the frame, so its address stays right; an image's is followed here.
      if (t.kind !== "r") return redirect(res, proxyPath("p", next.href));
      if (hop >= 4) return send(res, 502, "");
      target = next.href; method = "GET"; body = null;
    }
    const type = String(up.headers["content-type"] ?? "").toLowerCase();
    if (t.kind !== "r") console.log(`[browse] ${t.kind} ${new URL(target).hostname} ${up.status} ${type.split(";")[0] || "-"} ${up.body.length}b`);
    // DuckDuckGo sometimes answers a server with a bot check instead of results: search Bing instead.
    if (t.kind !== "r" && new URL(target).hostname === "html.duckduckgo.com" && (up.status === 202 || up.status >= 400 || /anomaly|challenge-form|bots use DuckDuckGo/i.test(up.body.subarray(0, 20000).toString("latin1")))) {
      const q = new URL(target).searchParams.get("q");
      if (q) return redirect(res, proxyPath("p", `https://www.bing.com/search?q=${encodeURIComponent(q)}`));
    }
    if (t.kind === "r") {
      if (!ASSET_TYPE.test(type) || up.truncated) return send(res, 415, "");
      const assetHeaders = { "content-type": type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; sandbox" };
      if (type.startsWith("text/css")) return send(res, 200, rewriteCss(decodeBody(up.body, type), target), { ...assetHeaders, "content-type": "text/css; charset=utf-8" });
      return send(res, 200, up.body, assetHeaders);
    }
    const looksHtml = /html|xml/.test(type) || (!type && /^\s*</.test(up.body.subarray(0, 200).toString("latin1")));
    // A site that refused (403, 429, 5xx): the page says so, for Echo to choose another site.
    if (looksHtml) return sendPage(res, 200, markStatus(rewriteHtml(decodeBody(up.body, type), target).html, up.status));
    if (up.status >= 400) return sendPage(res, 200, markStatus(notePage(`This site answered ${up.status}`, "It doesn't let Echo's Browser in. Try another site, or ⋯ → Open the real page.", target), up.status));
    if (type.startsWith("text/plain")) {
      const text = decodeBody(up.body, type).slice(0, 400_000).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return sendPage(res, 200, `<!doctype html><meta charset="utf-8"><meta name="echo-url" content="${target.replace(/"/g, "&quot;")}"><meta name="viewport" content="width=device-width, initial-scale=1"><pre style="white-space:pre-wrap;font:14px/1.45 ui-monospace,Menlo,monospace;padding:14px;margin:0">${text}</pre>`);
    }
    if (/^image\//.test(type)) return sendPage(res, 200, `<!doctype html><meta charset="utf-8"><meta name="echo-url" content="${target.replace(/"/g, "&quot;")}"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#111;display:grid;place-items:center;min-height:100vh"><img src="${proxyPath("r", target)}" style="max-width:100%;height:auto" alt=""></body>`);
    return sendPage(res, 200, notePage("This file can't open here", `It's ${type.split(";")[0] || "a file"} Echo's Browser can't show. Tap ⋯ → Open the real page to get it.`, target));
  }

  /** The iPhone's Shortcut posts today's events here each morning (see Settings → Calendar from this iPhone). */
  async function phoneCalendarUpload(req, res, key) {
    if (rateLimited(`cal:${key}`)) return send(res, 429, "Too many uploads this minute.");
    const device = await withPhones((phones) => Object.entries(phones.devices).find(([, d]) => d.calKey && d.calKey.length === key.length && timingSafeEqual(Buffer.from(d.calKey), Buffer.from(key)))?.[0] ?? null, { save: false });
    if (!device) return send(res, 404, "This calendar link isn't valid any more. Copy the new one from Echo's Settings.");
    try {
      const raw = (await readBody(req, 64 * 1024)).toString("utf8");
      const events = parsePhoneCalendar(raw);
      await store.set(`cal:${device}`, { at: now(), events }, 3 * 86400);
      return send(res, 200, `Echo got ${events.length} event${events.length === 1 ? "" : "s"} for today.`);
    } catch { return send(res, 400, "Echo couldn't read that."); }
  }

  async function cronTick(req, res) {
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (given.length !== cronBuf.length || !timingSafeEqual(given, cronBuf)) return send(res, 404, "Not found");
    await store.setCount("tick:last", now()).catch(() => {});
    await tick();
    return send(res, 200, { ok: true, at: now() });
  }

  async function serveStatic(res, path) {
    const name = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(PUBLIC, name));
    if (!file.startsWith(PUBLIC + "/") || !TYPES[extname(file)]) return send(res, 404, "Not found");
    try {
      let data = await readFile(file);
      // The page knows which version of the app it is, to notice a newer one (public/app.js).
      if (name === "index.html") data = Buffer.from(data.toString("utf8").replace("__APP_VERSION__", APP_VERSION));
      // The shell and the service worker must update the moment a new version
      // is deployed; the reactor art can sit in the cache.
      const cache = /\.(png|jpg)$/.test(file) ? "public, max-age=86400" : "no-cache";
      send(res, 200, data, { "content-type": TYPES[extname(file)], "cache-control": cache });
    } catch {
      send(res, 404, "Not found");
    }
  }

  const handler = (req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const path = url.pathname;
    if (path === "/healthz") return send(res, 200, { ok: true, echo: online() ? "online" : "offline", app: APP_VERSION, phone: { brain: Boolean(cloud), store: store.remote ? "upstash" : "memory", push: true } });
    if (path === "/version") return send(res, 200, { app: APP_VERSION });
    if (path === "/b/selftest" && req.method === "GET") return void browseSelfTest().then((r) => send(res, 200, r));
    if (path.startsWith("/cloud/")) return void cloudRoute(req, res, path);
    if (path.startsWith("/b/")) return void browseRoute(req, res, url).catch(() => { if (!res.headersSent) sendPage(res, 502, notePage("Couldn't open that page", "Something went wrong. Try again.")); });
    if (path === "/cron/tick" && req.method === "POST") return void cronTick(req, res);
    const cal = /^\/cal\/([A-Za-z0-9_-]{20,40})$/.exec(path);
    if (cal && req.method === "POST") return void phoneCalendarUpload(req, res, cal[1]);
    const ics = /^\/ics\/(v1\.[A-Za-z0-9_-]{20,4000})\.ics$/.exec(path);
    if (ics && req.method === "GET") {
      const event = icsFromUrl(ics[1]);
      if (!event) return send(res, 404, "This calendar link has expired. Ask Echo again.");
      const uid = createHash("sha256").update(ics[1]).digest("hex").slice(0, 32); // the same link always makes the same event
      return send(res, 200, buildIcs(event, { uid, now: now() }), { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="echo-event.ics"' });
    }
    if (path === "/world" && req.method === "GET") {
      return void getWorld().then(({ raw, ...w }) => send(res, 200, w, { "cache-control": "no-store" }))
        .catch((e) => send(res, 502, { error: String(e.message ?? e) }));
    }
    if (path === "/weather" && req.method === "GET") {
      const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: "lat and lon are required" });
      return void getWeather(lat, lon).then((w) => send(res, 200, w)).catch(() => send(res, 502, { error: "Weather is unavailable right now." }));
    }
    if (path === "/geocode" && req.method === "GET") {
      const name = String(url.searchParams.get("q") ?? "").trim().slice(0, 80);
      if (name.length < 2) return send(res, 400, { error: "q is required" });
      return void fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=${encodeURIComponent(name)}`)
        .then((d) => send(res, 200, { results: (d?.results ?? []).map((r) => ({ name: r.name, country: r.country ?? "", admin: r.admin1 ?? "", lat: r.latitude, lon: r.longitude })) }))
        .catch(() => send(res, 502, { error: "Search is unavailable right now." }));
    }
    if (path === "/agent/poll" || path === "/agent/reply" || path === "/agent/digest" || path === "/agent/handoff" || path === "/agent/handoff/update") {
      if (!agentAuthorized(req)) return send(res, 404, "Not found");
      if (path === "/agent/handoff" && req.method === "GET") {
        return void withHandoffs((st) => st.items.filter((i) => i.status === "waiting").map((i) => ({ task: i.task, assertion: i.assertion })), { save: false })
          .then((items) => send(res, 200, { items })).catch(() => send(res, 503, { error: "store" }));
      }
      if (path === "/agent/handoff/update" && req.method === "POST") return void agentHandoffUpdate(req, res);
      if (path === "/agent/digest" && req.method === "POST") return void agentDigest(req, res);
      if (path === "/agent/poll" && req.method === "GET") return agentPoll(req, res);
      if (path === "/agent/reply" && req.method === "POST") return agentReply(req, res);
      return send(res, 404, "Not found");
    }
    if (FORWARDED.has(path)) return forward(req, res, path, url.search);
    if (req.method === "GET") return serveStatic(res, path);
    send(res, 404, "Not found");
  };
  return { handler, keys, tick, vapid, state: () => ({ online: online(), queued: queue.length, waiting: waiters.length, inFlight: inFlight.size, passGen }) };
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "EchoRemote/1.0 (+personal relay)" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Started directly (Render runs `npm start`): listen. Imported by tests: don't.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const secret = String(process.env.RELAY_SECRET ?? "").trim();
  const paired = secret.length >= 32;
  // Not paired yet (RELAY_SECRET missing or short): the app, World and weather
  // still work, but no Mac can connect — with a key nobody holds — until it is set.
  const env = process.env;
  const relaySecret = paired ? secret : randomBytes(32).toString("hex");
  const keys = deriveKeys(relaySecret);
  const store = createStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, key: keys.store });
  const gemini = paired && env.GEMINI_API_KEY ? createGemini({
    apiKey: env.GEMINI_API_KEY.trim(), model: (env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim(),
    embedModel: (env.GEMINI_EMBED_MODEL || "gemini-embedding-001").trim(), base: env.GEMINI_BASE || undefined,
  }) : null;
  const relay = createRelay({
    secret: relaySecret, store, gemini, publicUrl: env.RENDER_EXTERNAL_URL || "https://echo-phone.onrender.com",
    limits: { messages: Number(env.PHONE_DAILY_MESSAGES) || 200, snaps: Number(env.PHONE_DAILY_SNAPS) || 30, browseSteps: Number(env.PHONE_DAILY_BROWSE) || 300 },
  });
  console.log(`Phone mode: brain ${gemini ? gemini.model : "off (no GEMINI_API_KEY)"}, store ${store.remote ? "Upstash" : "memory only (no UPSTASH_REDIS_REST_URL/TOKEN)"}`);
  // Browsing uses a stronger model with its own free quota: GEMINI_BROWSE_MODEL, or the best Flash model this key has.
  if (gemini) {
    const chosen = String(env.GEMINI_BROWSE_MODEL ?? "").trim();
    if (chosen) { gemini.browseModels = chosen.split(",").map((x) => x.trim()).filter(Boolean); console.log(`Browsing: ${gemini.browseModels.join(" → ")} (GEMINI_BROWSE_MODEL)`); }
    else gemini.listModels()
      .then((names) => { gemini.browseModels = pickBrowseModels(names, gemini.model, 2); console.log(`Browsing: ${[...gemini.browseModels, gemini.model].join(" → ")}${gemini.browseModels.length ? "" : " (no other Flash model on this key)"}`); })
      .catch((e) => console.log(`Browsing: ${gemini.model} (couldn't list models: ${e?.message ?? e})`));
  }
  if (paired && env.QSTASH_TOKEN) {
    ensureSchedule({ qstashToken: env.QSTASH_TOKEN.trim(), qstashUrl: env.QSTASH_URL?.trim() || undefined, publicUrl: env.RENDER_EXTERNAL_URL, cronToken: keys.cron })
      .then((r) => console.log(r.ok ? "Tick: every 5 minutes via QStash" : `Tick: not scheduled (${r.reason})`))
      .catch((e) => console.error(`Tick: not scheduled (${e?.message ?? e})`));
  }
  const handler = paired ? relay.handler : (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz" || path.startsWith("/agent/")) {
      res.writeHead(path === "/healthz" ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(path === "/healthz" ? { ok: true, echo: "unpaired" } : { error: "RELAY_SECRET isn't set on the relay." }));
    }
    return relay.handler(req, res);
  };
  if (!paired) console.error("RELAY_SECRET is missing or shorter than 32 characters: running unpaired.");
  // Timed work also runs every minute while the relay is awake, so reminders are
  // on time even between the scheduler's 5-minute wake-ups.
  if (paired) setInterval(() => { void relay.tick(); }, 60_000).unref();
  const server = http.createServer(handler);
  // Long polls outlive Node's default timeouts; keep the socket open for them.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;
  server.listen(Number(process.env.PORT) || 10000, () => console.log(`Echo relay listening on ${server.address().port}`));
}
