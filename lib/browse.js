/**
 * Echo's Browser: web pages fetched by the relay and shown inside the phone app.
 *
 * iOS won't let a Home Screen app show or control most other sites, so the
 * relay fetches each page and rewrites it: every link, form, image and
 * stylesheet points back through the relay, and every script is removed. The
 * page then lives on the app's own address, where the app can read it and
 * click it for Echo, and where it can do nothing on its own: no scripts run
 * (none are left, the frame is sandboxed without scripts, and the response's
 * own policy forbids them), so a page can't reach the app's sign-in or pass.
 *
 * What that costs: sites that only work with their scripts (web apps, many
 * shops' checkouts, maps) don't work here. Reading, searching, links and
 * ordinary forms do.
 *
 * The relay only fetches public addresses (never this server's own network,
 * whatever a page or redirect says), keeps each phone's cookies for the sites
 * it signed in to, sealed, and refuses to carry sign-ins to banks and payment
 * sites.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

export const MAX_PAGE = 4 * 1024 * 1024;
export const MAX_ASSET = 8 * 1024 * 1024;
export const MAX_URL = 4000;
export const UPSTREAM_MS = 20_000;
export const MAX_COOKIES = 600;
export const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
/** Search: Bing answers servers like this relay (DuckDuckGo and Mojeek don't), and links straight to results on phones. */
export const SEARCH_URL = (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`;

/** Sign-ins Echo's Browser won't carry: do these in Safari. */
const SENSITIVE = /(^|\.)(paypal\.com|stripe\.com|revolut\.com|wise\.com|klarna\.com|venmo\.com|cash\.app|coinbase\.com|binance\.com|kraken\.com|appleid\.apple\.com|icloud\.com|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com)$|(^|[.-])(bank|banking|netbank|ebank|onlinebank)([.-]|$)|(^|\.)(otpbank\.hu|raiffeisen\.hu|erstebank\.hu|kh\.hu|cib\.hu|unicredit\.hu|mbhbank\.hu|granitbank\.hu|chase\.com|bankofamerica\.com|wellsfargo\.com|citi\.com|hsbc\.com|barclays\.co\.uk|santander\.com|ing\.com|n26\.com|monzo\.com)$/i;
export const sensitiveHost = (host) => SENSITIVE.test(String(host).toLowerCase());

// ---- addresses ------------------------------------------------------------------

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
/** The relay path that shows (p), fetches (r), searches with a GET form (g) or posts (f) to a URL. */
export const proxyPath = (kind, url) => `/b/${kind}/${b64url(url)}`;
export function fromProxyPath(path) {
  const m = /^\/b\/([prgf])\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!m) return null;
  try {
    const url = Buffer.from(m[2], "base64url").toString("utf8");
    return checkUrl(url) ? { kind: m[1], url } : null;
  } catch { return null; }
}
/** An http(s) address with a host, short enough to carry. */
export function checkUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || u.length > MAX_URL) return null;
    return url;
  } catch { return null; }
}
/** What the user typed in the address bar: an address, or a search. */
export function addressOrSearch(input) {
  const t = String(input ?? "").trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return checkUrl(t)?.href ?? SEARCH_URL(t);
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return checkUrl(`https://${t}`)?.href ?? SEARCH_URL(t);
  return SEARCH_URL(t);
}

function ipv4Public(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (p[2] === 0 || p[2] === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && p[2] === 100))) return false;
  if (a === 203 && b === 0 && p[2] === 113) return false;
  return true;
}
/** Only the public internet: never loopback, private, link-local (cloud metadata), or reserved addresses. */
export function publicIp(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(s)) return ipv4Public(s);
  if (!net.isIPv6(s)) return false;
  // An IPv4 address carried inside IPv6 (::ffff:10.0.0.1, 64:ff9b::…): judge the IPv4 one.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) return ipv4Public(v4[1]);
  if (s.startsWith("::ffff:") || s.startsWith("64:ff9b:")) return false;
  if (s === "::" || s === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith("2001:db8") || s.startsWith("100::")) return false;
  return true;
}
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    // IPv4 first: cloud servers (Render) don't always have a working IPv6 route out.
    const ok = addrs.filter((a) => publicIp(a.address)).sort((x, y) => x.family - y.family);
    if (!ok.length) return cb(Object.assign(new Error(`${hostname} is a private address`), { code: "EBLOCKED" }));
    if (options?.all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });
}

// ---- cookies -------------------------------------------------------------------

/** The cookies this phone holds for a URL, as a Cookie header. */
export function cookieHeader(jar, url, now = Date.now()) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const out = [];
  for (const c of jar.cookies ?? []) {
    if (c.e && c.e <= now) continue;
    if (c.s && u.protocol !== "https:") continue;
    if (c.h ? host !== c.d : !(host === c.d || host.endsWith(`.${c.d}`))) continue;
    if (!(u.pathname === c.p || u.pathname.startsWith(c.p.endsWith("/") ? c.p : `${c.p}/`) || c.p === "/")) continue;
    out.push(`${c.n}=${c.v}`);
  }
  return out.join("; ");
}
/** Keep what a response's Set-Cookie headers say. Returns whether anything changed. */
export function storeCookies(jar, url, setCookies, now = Date.now()) {
  if (!setCookies?.length) return false;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  jar.cookies ??= [];
  for (const line of setCookies) {
    const [pair, ...attrs] = String(line).split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const c = { n: pair.slice(0, eq).trim(), v: pair.slice(eq + 1).trim(), d: host, h: true, p: "/", e: 0, s: false };
    if (!c.n || c.n.length > 256 || c.v.length > 4096) continue;
    let defaultPath = u.pathname.replace(/\/[^/]*$/, "") || "/";
    c.p = defaultPath;
    for (const a of attrs) {
      const [k, ...rest] = a.split("=");
      const key = k.trim().toLowerCase(), val = rest.join("=").trim();
      if (key === "domain" && val) {
        const d = val.replace(/^\./, "").toLowerCase();
        if (!d.includes(".") || !(host === d || host.endsWith(`.${d}`))) { c.bad = true; break; }
        c.d = d; c.h = false;
      } else if (key === "path" && val.startsWith("/")) c.p = val;
      else if (key === "max-age" && /^-?\d+$/.test(val)) c.e = Number(val) <= 0 ? 1 : now + Number(val) * 1000;
      else if (key === "expires" && !c.e) { const t = Date.parse(val); if (Number.isFinite(t)) c.e = t <= now ? 1 : t; }
      else if (key === "secure") c.s = true;
    }
    if (c.bad) continue;
    jar.cookies = jar.cookies.filter((x) => !(x.n === c.n && x.d === c.d && x.p === c.p));
    if (c.e !== 1) jar.cookies.push(c);
  }
  jar.cookies = jar.cookies.filter((c) => !c.e || c.e > now).slice(-MAX_COOKIES);
  return true;
}

// ---- fetching --------------------------------------------------------------------

/**
 * One request upstream, no redirects followed (the caller decides). Public
 * addresses only, unless `anyHost` (tests). Bodies are decompressed and capped.
 */
export function fetchUpstream({ url, method = "GET", headers = {}, body = null, limit = MAX_PAGE, anyHost = false, timeoutMs = UPSTREAM_MS }) {
  return new Promise((resolve, reject) => {
    const u = checkUrl(url);
    if (!u) return reject(Object.assign(new Error("That address can't be opened."), { code: "EBADURL" }));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!anyHost) {
      if (net.isIP(host) && !publicIp(host)) return reject(Object.assign(new Error("That's a private address."), { code: "EBLOCKED" }));
      if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) return reject(Object.assign(new Error("That port can't be opened."), { code: "EBLOCKED" }));
      if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) return reject(Object.assign(new Error("That's a private address."), { code: "EBLOCKED" }));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method, headers: { "accept-encoding": "gzip, deflate, br", ...headers }, ...(anyHost ? {} : { lookup: guardedLookup }),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0, done = false;
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      const stream = enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
      stream.on("data", (c) => {
        if (done) return;
        size += c.length;
        if (size > limit) { done = true; res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true }); return; }
        chunks.push(c);
      });
      stream.on("end", () => { if (!done) { done = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: false }); } });
      stream.on("error", (e) => { if (!done) { done = true; reject(e); } });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("The site took too long to answer."), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** The text of a response, in whatever character set it declares. */
export function decodeBody(buf, contentType = "") {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!cs) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];
  try { return new TextDecoder(cs || "utf-8").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

// ---- rewriting -------------------------------------------------------------------

const DROP_WITH_CONTENT = new Set(["script", "iframe", "object", "applet", "frameset", "portal", "template", "audio", "dialog"]);
const DROP_TAG = new Set(["embed", "frame", "base", "meta", "link", "noscript", "param", "track"]);
const RAW_COPY = new Set(["textarea", "title", "xmp"]);
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
export const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const BAD_SCHEME = /^\s*(javascript|vbscript|data|file|blob|about|filesystem):/i;

function resolve(u, base) {
  const raw = decodeEntities(String(u ?? "")).trim();
  if (!raw || BAD_SCHEME.test(raw)) return null;
  try { const r = new URL(raw, base); return /^https?:$/.test(r.protocol) && r.href.length <= MAX_URL ? unwrap(r) : null; } catch { return null; }
}
/** A search engine's click-tracking link (Bing's /ck/a needs scripts to go on): the result it stands for. */
function unwrap(r) {
  if (/(^|\.)bing\.com$/.test(r.hostname) && r.pathname === "/ck/a") {
    const u = r.searchParams.get("u");
    if (u && u.startsWith("a1")) {
      try { const t = new URL(Buffer.from(u.slice(2), "base64url").toString("utf8")); if (/^https?:$/.test(t.protocol)) return t; } catch { /* keep the link as it is */ }
    }
  }
  return r;
}
/** A link or resource address as the frame should load it, keeping any #fragment. */
function proxied(kind, u, base) {
  const raw = decodeEntities(String(u ?? "")).trim();
  if (raw.startsWith("#")) return raw;
  const r = resolve(raw, base);
  if (!r) return null;
  const hash = r.hash;
  r.hash = "";
  return proxyPath(kind, r.href) + (kind === "p" ? hash : "");
}
function rewriteSrcset(v, base) {
  return decodeEntities(v).split(/,(?=\s*\S)/).map((part) => {
    const [u, ...desc] = part.trim().split(/\s+/);
    const p = u && !u.startsWith("data:") ? proxied("r", u, base) : u?.startsWith("data:image/") ? u : null;
    return p ? [p, ...desc].join(" ") : null;
  }).filter(Boolean).join(", ");
}
/** A stylesheet with its images, fonts and imports fetched through the relay. */
export function rewriteCss(css, base) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => {
      if (/^\s*data:(image|font|application\/font)/i.test(u)) return m;
      if (u.trim().startsWith("#")) return m;
      const p = proxied("r", u, base);
      return p ? `url("${p}")` : "url()";
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => { const p = proxied("r", u, base); return p ? `@import "${p}"` : ""; });
}

/**
 * A page made safe to show in the app: no scripts, nothing that loads from
 * anywhere but the relay, every link and form going back through it.
 * Returns the page, its title, and where a refresh tag wanted to go.
 */
export function rewriteHtml(html, pageUrl) {
  let base = pageUrl;
  const out = [];
  let title = "", refresh = null, formMethod = "get";
  const len = html.length;
  let i = 0;
  const findClose = (tag, from) => {
    const re = new RegExp(`</${tag}[\\s>/]`, "ig");
    re.lastIndex = from;
    const m = re.exec(html);
    if (!m) return { start: len, end: len };
    const gt = html.indexOf(">", m.index);
    return { start: m.index, end: gt < 0 ? len : gt + 1 };
  };
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e < 0 ? len : e + 3; continue; }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") { const e = html.indexOf(">", lt); i = e < 0 ? len : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80));
    if (!m) { out.push("&lt;"); i = lt + 1; continue; }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    // Attributes, quotes respected.
    let j = lt + m[0].length;
    const attrs = [];
    let selfClose = false;
    while (j < len) {
      while (j < len && /\s/.test(html[j])) j++;
      if (html[j] === ">") { j++; break; }
      if (html[j] === "/" && html[j + 1] === ">") { selfClose = true; j += 2; break; }
      if (html[j] === "/") { j++; continue; }
      const nm = /^[^\s"'>\/=]+/.exec(html.slice(j, j + 200));
      if (!nm) { j++; continue; }
      j += nm[0].length;
      while (j < len && /\s/.test(html[j])) j++;
      let val = null;
      if (html[j] === "=") {
        j++;
        while (j < len && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") { const e = html.indexOf(q, j + 1); val = html.slice(j + 1, e < 0 ? len : e); j = e < 0 ? len : e + 1; }
        else { const v = /^[^\s>]*/.exec(html.slice(j, j + 4000))[0]; val = v; j += v.length; }
      }
      attrs.push([nm[0].toLowerCase(), val]);
    }
    i = j;
    if (closing) {
      if (!DROP_WITH_CONTENT.has(tag) && !DROP_TAG.has(tag)) out.push(`</${tag}>`);
      if (tag === "form") formMethod = "get";
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) { if (!selfClose) i = findClose(tag, i).end; continue; }
    const get = (n) => attrs.find(([k]) => k === n)?.[1] ?? null;
    if (tag === "base") { const r = resolve(get("href"), base); if (r) base = r.href; continue; }
    if (tag === "meta") {
      if (/^refresh$/i.test(get("http-equiv") ?? "")) {
        const mm = /^\s*(\d+)\s*[;,]?\s*(?:url\s*=\s*)?['"]?([^'"]*)/i.exec(decodeEntities(get("content") ?? ""));
        const r = mm?.[2] ? resolve(mm[2], base) : null;
        if (r && Number(mm[1]) <= 10) refresh = r.href;
      }
      continue;
    }
    if (tag === "link") {
      const rel = (get("rel") ?? "").toLowerCase();
      if (/\bstylesheet\b/.test(rel) && !/\balternate\b/.test(rel)) {
        const p = proxied("r", get("href"), base);
        if (p) out.push(`<link rel="stylesheet" href="${attr(p)}"${get("media") ? ` media="${attr(decodeEntities(get("media")))}"` : ""}>`);
      }
      continue;
    }
    if (DROP_TAG.has(tag)) continue;
    if (tag === "style") {
      const { start, end } = findClose("style", i);
      out.push(`<style>${rewriteCss(html.slice(i, start), base).replace(/<\/style/gi, "<\\/style")}</style>`);
      i = end;
      continue;
    }
    // Images loaded by scripts on the real site: use the address they keep for it.
    if (tag === "img" || tag === "source") {
      const src = get("src");
      const lazy = get("data-src") ?? get("data-lazy-src") ?? get("data-original") ?? get("data-url");
      if (lazy && (!src || /^data:/i.test(src))) { const k = attrs.findIndex(([n]) => n === "src"); if (k >= 0) attrs[k][1] = lazy; else attrs.push(["src", lazy]); }
      const lazySet = get("data-srcset") ?? get("data-lazy-srcset");
      if (lazySet && !get("srcset")) attrs.push(["srcset", lazySet]);
    }
    if (tag === "form") formMethod = /^post$/i.test(get("method") ?? "") ? "post" : "get";
    const kept = [];
    for (const [name, raw] of attrs) {
      if (name.startsWith("on") || ["srcdoc", "ping", "integrity", "nonce", "target", "autofocus", "http-equiv", "data-src", "data-srcset", "data-lazy-src", "data-lazy-srcset", "data-original", "data-url"].includes(name)) continue;
      if (raw == null) { kept.push(name); continue; }
      let v = raw;
      if (name === "href" && (tag === "a" || tag === "area")) v = proxied("p", raw, base);
      else if (name === "href" || name === "xlink:href") v = decodeEntities(raw).trim().startsWith("#") ? decodeEntities(raw) : tag === "image" ? proxied("r", raw, base) : null;
      else if (name === "src") v = ["img", "source", "input"].includes(tag) ? proxied("r", raw, base) : null;
      else if (name === "srcset") v = rewriteSrcset(raw, base);
      else if (name === "poster" || name === "background") v = proxied("r", raw, base);
      else if (name === "action" && tag === "form") v = null; // set below
      else if (name === "formaction") {
        const r = resolve(raw || base, base);
        const method = /^post$/i.test(get("formmethod") ?? formMethod) ? "f" : "g";
        v = r ? proxyPath(method, r.href) : null;
      } else if (name === "style") v = rewriteCss(decodeEntities(raw), base);
      else if (BAD_SCHEME.test(decodeEntities(raw)) && !/^(alt|title|value|placeholder|content|aria-label)$/.test(name)) v = null;
      else v = decodeEntities(raw);
      if (v == null) continue;
      kept.push(`${name}="${attr(v)}"`);
    }
    if (tag === "form") {
      const r = resolve(get("action") || base, base) ?? new URL(base);
      kept.push(`action="${attr(proxyPath(formMethod === "post" ? "f" : "g", r.href))}"`);
    }
    if (tag === "title" || RAW_COPY.has(tag)) {
      const { start, end } = findClose(tag, i);
      const text = html.slice(i, start);
      if (tag === "title" && !title) title = decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, 200);
      out.push(`<${tag}${kept.length ? ` ${kept.join(" ")}` : ""}>${text.replace(/</g, "&lt;")}</${tag}>`);
      i = end;
      continue;
    }
    out.push(`<${tag}${kept.length ? ` ${kept.join(" ")}` : ""}${selfClose ? " /" : ""}>`);
  }
  const head = `<!doctype html><meta charset="utf-8"><meta name="echo-url" content="${attr(pageUrl)}">${refresh ? `<meta name="echo-refresh" content="${attr(proxyPath("p", refresh))}">` : ""}<meta name="viewport" content="width=device-width, initial-scale=1">`;
  return { html: head + out.join(""), title, refresh };
}

/** A small page of our own in the frame: an error, a file that can't be shown. */
export function notePage(title, text, url = null) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${url ? `<meta name="echo-url" content="${attr(url)}">` : ""}<title>${attr(title)}</title>`
    + `<body style="margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b1418;color:#e8f6fa;padding:28px 22px">`
    + `<h1 style="font-size:22px;margin:0 0 10px">${attr(title)}</h1><p style="color:#9fb8c0;margin:0">${attr(text)}</p></body>`;
}

/** The headers every page from the Browser is served with: same-origin, no scripts, no plugins, framed only by the app. */
export const PAGE_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'self'; base-uri 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; sandbox allow-forms allow-same-origin",
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};
/** What a resource from the Browser may be: images, fonts and stylesheets only. */
export const ASSET_TYPE = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)|font\/|application\/(font-woff2?|x-font-\w+|vnd\.ms-fontobject|font-sfnt)|text\/css)/i;
