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
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveKeys, verifyPass, seal, unseal } from "./lib/secure.js";
import { createStore } from "./lib/store.js";
import { createGemini } from "./lib/gemini.js";
import { createCloud, CloudError } from "./lib/cloud.js";
import { buildIcs, validEvent } from "./lib/calendar.js";
import { ensureSchedule } from "./lib/tick.js";

export const POLL_MS = 25_000;          // how long Echo's "anything for me?" is held open
export const REQUEST_MS = 30_000;       // how long a phone request may wait for Echo's answer
export const SLOW_REQUEST_MS = 90_000;  // voice: Echo transcribes before answering
export const ONLINE_MS = 45_000;        // Echo counts as online this long after its last poll
export const MAX_QUEUE = 64;
export const MAX_BODY = 12 * 1024 * 1024;
export const LOGIN_LIMIT = 10;          // password attempts per address per window
export const LOGIN_WINDOW_MS = 15 * 60_000;

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
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
/** How long a calendar link from Phone mode keeps working. */
export const ICS_TTL_MS = 30 * 86400_000;

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
  const cloudHits = new Map();
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
      waiter.res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-relay-pass-gen": String(passGen) });
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
      res.writeHead(204, { "cache-control": "no-store", "x-relay-pass-gen": String(passGen) });
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
    if (e instanceof CloudError) return send(res, CLOUD_STATUS[e.kind] ?? 502, { error: e.kind, message: e.message, resetsAt: e.resetsAt ?? null });
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
    if (req.method !== "POST") return send(res, 404, "Not found");
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
    if (path === "/cloud/chat" || path === "/cloud/voice") {
      if (!cloud) return send(res, 503, { error: "setup", message: "Phone mode isn't set up yet: add GEMINI_API_KEY on Render." });
      if (rateLimited(claims.device)) return send(res, 429, { error: "busy", message: "Slow down a little — too many messages this minute." });
      try {
        const body = await readJson(req, path === "/cloud/voice" ? CLOUD_VOICE_BODY : CLOUD_BODY);
        const context = { ...(body.context && typeof body.context === "object" ? body.context : {}), macOnline: online() };
        let result;
        if (path === "/cloud/voice") {
          const audio = String(body.audio ?? "");
          if (!/^[A-Za-z0-9+/=]{100,}$/.test(audio)) return send(res, 400, { error: "input", message: "That recording didn't come through." });
          result = await cloud.chat({ history: body.history, audio, context });
        } else result = await cloud.chat({ history: body.history, text: body.text, context });
        for (const a of result.actions) if (a.type === "calendar" && validEvent(a.data)) a.url = icsUrl(a.data);
        return send(res, 200, result);
      } catch (e) { return sendCloudError(res, e); }
    }
    return send(res, 404, "Not found");
  }

  async function cronTick(req, res) {
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (given.length !== cronBuf.length || !timingSafeEqual(given, cronBuf)) return send(res, 404, "Not found");
    // Timed work (the briefing, reminders) joins here in later updates.
    await store.setCount("tick:last", now()).catch(() => {});
    return send(res, 200, { ok: true, at: now() });
  }

  async function serveStatic(res, path) {
    const name = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(PUBLIC, name));
    if (!file.startsWith(PUBLIC + "/") || !TYPES[extname(file)]) return send(res, 404, "Not found");
    try {
      const data = await readFile(file);
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
    if (path === "/healthz") return send(res, 200, { ok: true, echo: online() ? "online" : "offline", phone: { brain: Boolean(cloud), store: store.remote ? "upstash" : "memory" } });
    if (path.startsWith("/cloud/")) return void cloudRoute(req, res, path);
    if (path === "/cron/tick" && req.method === "POST") return void cronTick(req, res);
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
    if (path === "/agent/poll" || path === "/agent/reply") {
      if (!agentAuthorized(req)) return send(res, 404, "Not found");
      if (path === "/agent/poll" && req.method === "GET") return agentPoll(req, res);
      if (path === "/agent/reply" && req.method === "POST") return agentReply(req, res);
      return send(res, 404, "Not found");
    }
    if (FORWARDED.has(path)) return forward(req, res, path, url.search);
    if (req.method === "GET") return serveStatic(res, path);
    send(res, 404, "Not found");
  };
  return { handler, keys, state: () => ({ online: online(), queued: queue.length, waiting: waiters.length, inFlight: inFlight.size, passGen }) };
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
  const gemini = paired && env.GEMINI_API_KEY ? createGemini({ apiKey: env.GEMINI_API_KEY.trim(), model: (env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim(), base: env.GEMINI_BASE || undefined }) : null;
  const relay = createRelay({
    secret: relaySecret, store, gemini,
    limits: { messages: Number(env.PHONE_DAILY_MESSAGES) || 200 },
  });
  console.log(`Phone mode: brain ${gemini ? gemini.model : "off (no GEMINI_API_KEY)"}, store ${store.remote ? "Upstash" : "memory only (no UPSTASH_REDIS_REST_URL/TOKEN)"}`);
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
  const server = http.createServer(handler);
  // Long polls outlive Node's default timeouts; keep the socket open for them.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;
  server.listen(Number(process.env.PORT) || 10000, () => console.log(`Echo relay listening on ${server.address().port}`));
}
