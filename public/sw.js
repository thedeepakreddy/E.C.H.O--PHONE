/*
 * Keeps the app's own files on the phone so it opens instantly and still shows
 * its shell with no signal. Only these files: nothing from Echo (status, chat,
 * the screen) is ever cached — it is fetched live or not at all.
 */
const CACHE = "echo-shell-v31";
const SHELL = ["/", "/app.css", "/app.js", "/experience.js", "/voice-session.js", "/speech-particles.js", "/humanoid-core.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png", "/img/reactor.png", "/img/reactor-core.png", "/img/reactor-mid.png", "/img/reactor-outer.png", "/img/osiris.jpg"];

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

// Notifications from Echo: the morning briefing, reminders, "your Mac finished".
// Each one says which page to open; a tap brings the app forward on it.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Echo", {
    body: d.body || "", tag: d.tag || undefined, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
    data: { url: typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { c.postMessage({ type: "open", url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
