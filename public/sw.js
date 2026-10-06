/*
 * Keeps the app's own files on the phone so it opens instantly and still shows
 * its shell with no signal. Only these files: nothing from Echo (status, chat,
 * the screen) is ever cached — it is fetched live or not at all.
 */
const CACHE = "echo-shell-v1";
const SHELL = ["/", "/app.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png", "/img/humanoid.jpg", "/img/reactor.png", "/img/osiris.jpg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const path = url.pathname === "/index.html" ? "/" : url.pathname;
  if (!SHELL.includes(path)) return; // the API goes straight to the network
  // Newest copy when online (so an update shows on the next open), cached copy when not.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); }
    return r;
  }).catch(() => caches.match(path)));
});
