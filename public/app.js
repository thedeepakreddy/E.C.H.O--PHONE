/*
 * Echo Remote — the phone app.
 *
 * Plain script, no framework, no build step. Everything Echo-related goes to
 * this server's forwarded routes, which reach Echo on the Mac through the
 * relay; World, weather and city search are served by this server directly.
 * Text from anywhere else (messages, task names, headlines) is always set with
 * textContent and never parsed as markup.
 */
(() => {
  "use strict";
  const VERSION = "1.0.0";
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };

  // ---------- no zoom, ever ----------
  // iOS ignores user-scalable=no in Safari for accessibility; these stop the
  // pinch and double-tap gestures so the app stays fixed like a native one.
  document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
  document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
  // Double-tap zoom is off through touch-action: manipulation (app.css). No
  // touchmove/touchend listener here: a blocking one makes every scroll wait
  // on this script, which is what made the chat feel stuck.
  let touching = false;
  document.addEventListener("touchstart", () => { touching = true; }, { passive: true });
  const lifted = () => { touching = false; setTimeout(fitViewport, 60); };
  document.addEventListener("touchend", lifted, { passive: true });
  document.addEventListener("touchcancel", lifted, { passive: true });

  // ---------- the visual viewport (keyboard) ----------
  // The page is sized to what is actually visible, so when the keyboard comes
  // up the chat composer rests right on top of it and the tab bar steps aside.
  const vv = window.visualViewport;
  let stickToBottom = true; // is the chat showing its newest message?
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  function fitViewport() {
    // A Home Screen app on iOS reports a page a status bar shorter than the
    // screen, which left a gap under the tab bar; in portrait use the screen.
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", `${Math.round(h)}px`);
    const keyboard = vv ? window.innerHeight - vv.height > 140 : false;
    // While the keyboard is up, keep the page exactly the viewport's height so
    // iOS has nothing to scroll; the chat view sizes itself from --vvh then.
    const portrait = window.innerWidth < window.innerHeight;
    const appH = standalone && portrait && !keyboard ? Math.max(window.innerHeight, screen.height) : window.innerHeight;
    document.documentElement.style.setProperty("--app-h", `${Math.round(appH)}px`);
    const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    body.classList.toggle("kb", !!(keyboard && typing));
    // iOS pans the page when the keyboard opens; pull it back, but never in the
    // middle of a drag — that is what fought the finger and felt like a wall.
    if (vv && vv.offsetTop && !touching) window.scrollTo(0, 0);
    // Reading the newest message: stay on it while the keyboard comes and goes.
    // Scrolled up through the conversation: stay right there.
    if (body.dataset.view === "chat" && stickToBottom) scrollMessages();
  }
  if (vv) { vv.addEventListener("resize", fitViewport); vv.addEventListener("scroll", fitViewport); }
  // The page is the screen; it never scrolls as a whole (lists scroll inside it).
  window.addEventListener("scroll", () => { if (!body.classList.contains("kb") && window.scrollY && !touching) window.scrollTo(0, 0); }, { passive: true });
  window.addEventListener("resize", fitViewport);
  document.addEventListener("focusin", () => setTimeout(fitViewport, 50));
  document.addEventListener("focusout", () => setTimeout(fitViewport, 50));
  fitViewport();

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(text, bad = false) {
    const t = $("toast");
    t.textContent = text;
    t.classList.toggle("bad", bad);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- link token and session ----------
  const params = new URLSearchParams(location.search);
  let T = params.get("t");
  if (T && /^[0-9a-f]{32}$/.test(T)) store.set("echo_t", T); else T = store.get("echo_t");
  let S = store.get("echo_s") || "";

  // ---------- Phone mode: this phone's id, its cloud pass, where Echo runs ----------
  // Get started creates a standalone Phone session. Optional Mac sign-in adds
  // a paired cloud pass; both use the same phone id to keep its saved data.
  let DEV = store.get("echo_dev");
  if (!DEV || !/^[0-9a-f]{32}$/.test(DEV)) {
    DEV = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store.set("echo_dev", DEV);
  }
  let PASS = store.get("echo_pass") || "";
  function passClaims() {
    try { return JSON.parse(atob(PASS.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
  }
  const passValid = () => { const c = passClaims(); return !!c && c.exp * 1000 > Date.now(); };
  const passFresh = () => { const c = passClaims(); return !!c && Date.now() - c.iat * 1000 < 86400_000; };
  function savePass(p) { if (typeof p === "string" && p.startsWith("cp1.")) { PASS = p; store.set("echo_pass", p); } }
  let mode = store.get("echo_mode") === "mac" && T && S ? "mac" : "phone";
  let macOnline = false, macOfflineSince = 0, cloudInfo = null, cloudBusy = false, macChip = "Your Mac";
  /** This phone's briefing settings, whether it gets notifications, and its latest briefing. */
  let briefInfo = null;
  const u = (p) => `${p}${p.includes("?") ? "&" : "?"}t=${T}${S ? `&s=${S}` : ""}`;

  async function api(path, { json, body: payload, method, raw, quiet } = {}) {
    const opt = { method: method || "GET", headers: {} };
    if (json !== undefined) { opt.method = "POST"; opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(json); }
    if (payload !== undefined) { opt.method = "POST"; opt.body = payload; }
    const r = await fetch(u(path), opt);
    if (r.status === 401 && S && !quiet) { signedOut("Signed out. Sign in again."); throw Object.assign(new Error("signed out"), { status: 401 }); }
    if (raw) return r;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.message || d.error || d.reason || `HTTP ${r.status}`), { status: r.status, data: d });
    return d;
  }
  const pub = (p) => fetch(p).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

  // ---------- views ----------
  const TABS = ["home", "today", "chat", "memory", "more"];
  let experience = null, currentThread = store.get(`echo_thread_${DEV}`) || null;
  const INSTALLATION = store.get("echo_installation") || crypto.randomUUID();
  store.set("echo_installation", INSTALLATION);
  let currentView = "signin", lastTab = store.get("echo_tab") || "home";
  /** Where each pushed page's Back goes: the page it was opened from. */
  const backTo = {};
  function show(view, { back = false } = {}) {
    if (view === "screen" && !(S && macOnline)) { toast("That needs your Mac, and it's offline right now.", true); return; }
    if (!back && !TABS.includes(view) && view !== currentView && currentView !== "signin") backTo[view] = currentView;
    currentView = view;
    body.dataset.view = view;
    for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `v-${view}`;
    $("tabbar").hidden = view === "signin";
    for (const b of document.querySelectorAll("[data-tab]")) {
      if (b.dataset.tab === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    }
    if (TABS.includes(view)) { lastTab = view; store.set("echo_tab", view); }
    if (view === "home" && window.echoCore) window.echoCore.replay(); // the figure assembles every time
    if (view === "chat") { unread = 0; renderBadge(); setTimeout(scrollMessages, 30); pollChat(); window.echoCore?.avatar(); }
    if (view === "world") loadWorld();
    if (view === "settings") { loadPhoneCal(); renderMacPage(); }
    if (view === "mac") renderMacPage();
    if (view === "browser") openBrowser();
    if (view === "screen") openScreen(); else closeScreen();
    if (view === "missions") { setSeg(seg); renderMissions(); renderHandoffs(); loadHandoffs(); }
    if (view === "brain" && last) renderBrain(last);
    if (view === "memory") { renderMemory(); loadMemory(); }
    experience?.onView(view);
  }
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => b.dataset.tab === "memory" ? openMemory() : show(b.dataset.tab)));
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) show(open.dataset.open);
    if (e.target.closest("[data-back]")) show(backTo[currentView] && backTo[currentView] !== currentView ? backTo[currentView] : lastTab, { back: true });
    if (e.target.closest("[data-close]")) closeSheets();
  });

  // ---------- sheets ----------
  let sheetFocus = null;
  function openSheet(id) {
    closeSheets();
    sheetFocus = document.activeElement;
    $("scrim").hidden = false;
    $(id).hidden = false;
    setTimeout(() => $(id).querySelector("input,textarea,button,select")?.focus(), 0);
  }
  function closeSheets() {
    $("scrim").hidden = true;
    document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
    if (sheetFocus?.isConnected) sheetFocus.focus();
    sheetFocus = null;
  }
  $("scrim").addEventListener("click", closeSheets);
  document.addEventListener("keydown", (e) => {
    const s = document.querySelector(".sheet:not([hidden])"); if (!s) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheets(); }
    if (e.key === "Tab") {
      const focus = [...s.querySelectorAll("button,input,textarea,select,a[href]")].filter((n) => !n.disabled && n.getClientRects().length);
      if (!focus.length) return;
      if (e.shiftKey && document.activeElement === focus[0]) { e.preventDefault(); focus.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === focus.at(-1)) { e.preventDefault(); focus[0].focus(); }
    }
  });

  // ---------- sign in ----------
  const b64 = {
    toBuf: (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer,
    fromBuf: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  };
  const faceIdAllowed = () => store.get("echo_faceid") !== "off" && !!window.PublicKeyCredential;

  // ---------- the first screen, and Settings → Your Mac ----------
  // The first screen is only "Get started". Everything about the Mac (its link
  // or QR code, its password, Face ID) lives on the Your Mac page in Settings.
  function showWelcome() {
    show("signin");
    $("start-note").hidden = false;
  }
  let phoneSessionPending = null;
  function ensurePhoneSession() {
    if (passValid() && (passClaims()?.p !== true || passFresh())) return Promise.resolve();
    if (phoneSessionPending) return phoneSessionPending;
    phoneSessionPending = (async () => {
      const r = await fetch("/phone/session", {
        method: "POST", headers: { "content-type": "application/json", ...(PASS ? { "x-echo-pass": PASS } : {}) }, body: "{}",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) { PASS = ""; store.set("echo_pass", null); }
        throw new Error(d.message || "Couldn't start Echo. Check your connection and try again.");
      }
      if (!/^[0-9a-f]{32}$/.test(d.device) || !String(d.cloudPass).startsWith("cp1.")) throw new Error("Couldn't start Echo. Try again.");
      DEV = d.device; store.set("echo_dev", DEV); savePass(d.cloudPass);
    })().finally(() => { phoneSessionPending = null; });
    return phoneSessionPending;
  }
  $("get-started").addEventListener("click", async () => {
    const button = $("get-started");
    button.disabled = true; button.textContent = "Starting…"; $("start-error").textContent = "";
    try {
      await ensurePhoneSession();
      if (T && S) start();
      enter(); loadWeather(); refreshCloud();
    } catch (e) { $("start-error").textContent = e.message || "Couldn't start Echo. Check your connection and try again."; }
    finally { button.disabled = false; button.textContent = "Get started"; }
  });
  /** The Your Mac page: link it (scan or paste), sign in to it, or sign out. */
  function prepareSignIn() {
    if (currentView !== "mac") show("mac"); else renderMacPage();
  }
  function macSummary() {
    if (!T) return { title: "Optional · not connected", text: "Echo on your phone works on its own. Connect a Mac to use its screen, apps and files.", short: "Optional", on: false };
    if (!S) return { title: "Linked · not signed in", text: macOnline ? "Echo is running on your Mac. Sign in with its password." : "Echo isn't running on your Mac right now. Start Echo on the Mac, then sign in.", short: "Sign in", on: false };
    return { title: macOnline ? "Connected" : "Connected · Mac offline", text: macOnline ? "Echo on your Mac is online." : "Echo on your Mac is offline. Echo on your phone still works.", short: macOnline ? "Online" : "Offline", on: macOnline };
  }
  async function renderMacPage({ faceId = true } = {}) {
    const m = macSummary();
    $("set-mac").textContent = m.short;
    if (currentView !== "mac") return;
    $("mac-state-title").textContent = m.title;
    $("mac-state-text").textContent = m.text;
    $("mac-state-dot").className = `dot${m.on ? " ok" : ""}`;
    $("no-link").hidden = !!T;
    $("signin-form").hidden = !T || !!S;
    $("mac-signed-in").hidden = !(T && S);
    if (!T || S || !faceId) return;
    $("faceid-login").hidden = true; $("signin-or").hidden = true;
    if (!faceIdAllowed()) return;
    try {
      const r = await fetch(u("/passkey/options?purpose=login"));
      if (r.ok) { $("faceid-login").hidden = false; $("signin-or").hidden = false; }
    } catch { /* offline: password only */ }
  }
  function enter() { show(TABS.includes(lastTab) ? lastTab : "home"); renderMode(); }
  function signedIn(s) {
    S = s; store.set("echo_s", s);
    $("pw").value = ""; $("signin-err").textContent = "";
    start();
    enter();
    refreshCloud();
    toast("Connected to your Mac");
  }
  /** Signed out of the Mac. `full` also forgets the cloud pass (Sign out of this phone). */
  function signedOut(message, { full = false } = {}) {
    S = ""; store.set("echo_s", null);
    stopPolling();
    if (full) {
      cloudAbort?.abort(); PASS = ""; store.set("echo_pass", null); cloudInfo = null; briefInfo = null; macOnline = false;
      mode = "phone"; store.set("echo_mode", "phone"); currentThread = null; chatCache = []; store.set(CACHE_KEY, "[]");
      mem.items = []; mem.upcoming = []; mem.open = null; memLoaded = false; snapState = null; snapCtx = null;
      experience?.reset(); renderChat(); showWelcome(); if (message) toast(message); return;
    }
    macOnline = false;
    mode = "phone"; store.set("echo_mode", "phone");
    renderMode(); renderMacPage();
    refreshCloud();
    toast(message || "Signed out of your Mac. Echo on your phone still works.");
  }
  $("mac-signout").addEventListener("click", () => signedOut("Signed out of your Mac."));
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("pw").value;
    if (!pw) { $("signin-err").textContent = "Enter your password."; return; }
    try {
      const r = await fetch(u("/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw, device: DEV }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.s) { savePass(d.cloudPass); return signedIn(d.s); }
      $("signin-err").textContent = r.status === 401 ? "That password isn't right." : r.status === 429 ? d.error : r.status === 503 ? "Your Mac is offline. Echo must be running." : r.status === 404 ? "This link isn't valid any more." : "Couldn't sign in.";
    } catch { $("signin-err").textContent = "No connection."; }
  });
  $("pw").addEventListener("input", () => ($("signin-err").textContent = ""));
  // ---------- connecting the Mac: its link, scanned or pasted ----------
  // Echo on the Mac shows its phone app link as a QR code ("show me the phone
  // remote link"), and Telegram's /link sends the same link. Only its key (the
  // 32 hex characters after t=) is kept on this phone; the Mac password comes next.
  /** The key from an Echo link, or an error message. */
  function linkKey(raw) {
    const text = String(raw || "").trim();
    let m = text.match(/^([0-9a-f]{32})$/i);
    if (!m) {
      try {
        const url = new URL(text);
        if (url.host !== location.host) return { error: `That link is for ${url.host}, not this Echo app.` };
        m = (url.searchParams.get("t") || "").match(/^([0-9a-f]{32})$/i);
      } catch { m = text.match(/[?&]t=([0-9a-f]{32})\b/i); }
    }
    return m ? { key: m[1].toLowerCase() } : { error: "That isn't your Echo link. Ask Echo to show the phone remote link, or send /link on Telegram." };
  }
  /** Use a Mac's link: keep its key and go to its password. Returns whether it worked. */
  function useLink(raw) {
    const r = linkKey(raw);
    if (r.error) return r;
    const changed = r.key !== T;
    T = r.key; store.set("echo_t", T);
    closeScanner();
    if (changed && S) { S = ""; store.set("echo_s", null); stopPolling(); macOnline = false; }
    toast(changed ? "Mac link saved. Sign in with its password." : "That's the Mac you're connected to.");
    if (changed || !S) prepareSignIn(); else renderMacPage();
    return r;
  }
  $("link-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const r = useLink($("link-in").value);
    $("link-err").textContent = r.error || "";
    if (!r.error) $("link-in").value = "";
  });
  $("scan-paste").addEventListener("submit", (e) => {
    e.preventDefault();
    const r = useLink($("scan-link").value);
    $("scan-err").textContent = r.error || "";
    if (!r.error) $("scan-link").value = "";
  });
  let scan = null;
  function loadQrReader() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el2 = document.createElement("script");
      el2.src = "/vendor/jsqr.js";
      el2.onload = () => (window.jsQR ? resolve() : reject(new Error("The QR reader didn't load.")));
      el2.onerror = () => reject(new Error("The QR reader didn't load. Check your connection."));
      document.head.appendChild(el2);
    });
  }
  async function openScanner() {
    closeSheets();
    $("scanner").hidden = false;
    $("scan-err").textContent = "";
    $("scan-hint").textContent = "Point at the QR code Echo shows on your Mac";
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser can't use the camera here. Paste the link below instead.");
      const [stream] = await Promise.all([navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }), loadQrReader()]);
      if ($("scanner").hidden) { stream.getTracks().forEach((t) => t.stop()); return; }
      const video = $("scan-video");
      video.srcObject = stream;
      await video.play().catch(() => {});
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      scan = { stream, timer: 0, lastBad: "" };
      const tick = () => {
        if (!scan) return;
        if (video.videoWidth) {
          const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * k);
          canvas.height = Math.round(video.videoHeight * k);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            const r = useLink(code.data);
            if (!r.error) return;
            // Some other QR code: say why once, and keep looking.
            if (code.data !== scan.lastBad) { scan.lastBad = code.data; $("scan-err").textContent = r.error; }
          }
        }
        scan.timer = setTimeout(tick, 160);
      };
      tick();
    } catch (e) {
      $("scan-err").textContent = e && e.name === "NotAllowedError"
        ? "Camera access is off for this app. Turn it on in the iPhone's Settings, or paste the link below."
        : (e && e.message) || "The camera didn't start. Paste the link below instead.";
    }
  }
  function closeScanner() {
    if (scan) { clearTimeout(scan.timer); scan.stream.getTracks().forEach((t) => t.stop()); scan = null; }
    $("scan-video").srcObject = null;
    $("scanner").hidden = true;
  }
  $("scan-close").addEventListener("click", closeScanner);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-scan]")) openScanner(); });
  $("faceid-login").addEventListener("click", async () => {
    try {
      const o = await fetch(u("/passkey/options?purpose=login")).then((r) => r.json());
      rememberPasskeys(o.allowCredentials);
      const cred = await navigator.credentials.get({ publicKey: {
        challenge: b64.toBuf(o.challenge), rpId: o.rpId, userVerification: "required", timeout: o.timeout,
        allowCredentials: (o.allowCredentials || []).map((c) => ({ type: "public-key", id: b64.toBuf(c.id) })),
      } });
      const r = await fetch(u("/passkey/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: encodeAssertion(cred), device: DEV }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.s) { savePass(d.cloudPass); return signedIn(d.s); }
      $("signin-err").textContent = d.error || "Face ID didn't work. Use your password.";
    } catch (err) {
      if (err && err.name !== "NotAllowedError") $("signin-err").textContent = "Face ID isn't available. Use your password.";
    }
  });
  function encodeAssertion(cred) {
    return { id: cred.id, rawId: b64.fromBuf(cred.rawId), type: cred.type, response: {
      clientDataJSON: b64.fromBuf(cred.response.clientDataJSON), authenticatorData: b64.fromBuf(cred.response.authenticatorData),
      signature: b64.fromBuf(cred.response.signature), userHandle: cred.response.userHandle ? b64.fromBuf(cred.response.userHandle) : null,
    } };
  }
  async function faceIdConfirm() {
    const o = await api("/passkey/options?purpose=confirm");
    rememberPasskeys(o.allowCredentials);
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: b64.toBuf(o.challenge), rpId: o.rpId, userVerification: "required", timeout: o.timeout,
      allowCredentials: (o.allowCredentials || []).map((c) => ({ type: "public-key", id: b64.toBuf(c.id) })),
    } });
    return encodeAssertion(cred);
  }

  // ---------- polling ----------
  const timers = {};
  let started = false;
  function loop(name, fn, ms) {
    const tick = async () => {
      if (!S) return;
      let next = typeof ms === "function" ? ms() : ms;
      try { await fn(); } catch (e) { if (e && (e.status === 503 || e.status === 504)) next = Math.max(next, 5000); }
      if (document.hidden) next = Math.max(next, 15000);
      timers[name] = setTimeout(tick, next);
    };
    clearTimeout(timers[name]);
    tick();
  }
  function stopPolling() { started = false; Object.values(timers).forEach(clearTimeout); }
  function start() {
    if (started) return;
    started = true;
    loop("status", pollStatus, 2500);
    loop("pending", pollPending, 2000);
    loop("chat", pollChat, () => (currentView === "chat" ? 1500 : 6000));
    loop("events", pollEvents, 1500);
    loadWeather();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (S) { started = false; start(); }
    refreshCloud();
  });

  // ---------- status ----------
  const STATE = {
    idle: ["STANDING BY", "#8fe9f3"], listening: ["LISTENING", "#5ee7f5"], thinking: ["THINKING", "#b98cff"],
    acting: ["TAKING ACTION", "#74f2a0"], speaking: ["SPEAKING", "#ffcf40"], error: ["ERROR", "#ff6b6b"], asleep: ["ASLEEP", "#ff8a8a"],
  };
  let last = null, offline = false, logsAfter = 0, lastActivity = "";
  async function pollStatus() {
    try {
      // Renew this phone's cloud pass about once a day while the Mac is reachable.
      const d = await api(`/status?logs=${logsAfter}${passFresh() && passClaims()?.p !== true ? "" : `&pass=${DEV}`}`);
      if (d.cloudPass) { const had = passValid(); savePass(d.cloudPass); if (!had) refreshCloud(); }
      offline = false;
      last = d; lastStatusAt = Date.now();
      for (const l of d.logs || []) { logsAfter = Math.max(logsAfter, l.id); if (l.kind !== "user") lastActivity = l; }
      macChip = (d.vitals && d.vitals.chip) ? d.vitals.chip.replace(/^Apple /, "Mac · ") : "Your Mac";
      markMac(true);
      if (d.faceId && d.faceId.registered && !pkIds().length && !pkAsked) { pkAsked = true; api("/passkey/options?purpose=confirm").then((o) => rememberPasskeys(o.allowCredentials)).catch(() => {}); }
      if (currentView === "missions") renderMissions();
      if (currentView === "brain") renderBrain(d);
      renderSettings(d);
    } catch (e) {
      if (e.status === 503 || e.status === 504) { offline = true; markMac(false); }
      throw e;
    }
  }
  /** The Mac came or went: banners, the pill and the copy of Phone mode's chat. */
  function markMac(on) {
    // "Back" only after this phone actually saw it go away, not on the first answer after opening.
    if (on && !macOnline) { dismissedBack = !macOfflineSince; dismissedOffline = false; macOfflineSince = 0; }
    if (!on && !macOfflineSince) macOfflineSince = Date.now();
    const changed = macOnline !== on;
    macOnline = on;
    renderMode();
    renderBanners();
    if (on) syncToMac();
    if (changed && currentView === "missions") renderMissions(); // "Running" becomes "Last seen running", and back
  }
  const prettyModel = (m) => String(m || "").replace(/-preview.*$/, "").replace(/^gemini-/i, "Gemini ").replace(/-([a-z])/g, (_, c) => ` ${c.toUpperCase()}`).replace("Flash Lite", "Flash-Lite");
  function cloudLine() {
    if (!cloudInfo) return "Checking…";
    if (!cloudInfo.ready) return "Not set up yet: add the Gemini key on Render";
    const u = cloudInfo.usage;
    return u ? `${prettyModel(cloudInfo.model)} · ${u.requests}${u.limit ? ` of ${u.limit}` : ""} requests today` : prettyModel(cloudInfo.model);
  }
  function setStats(list) {
    [["s-cmd", "s-cmd-l"], ["s-tools", "s-tools-l"], ["s-done", "s-done-l"], ["s-err", "s-err-l"]].forEach(([v, l], i) => { $(v).textContent = list[i][0]; $(l).textContent = list[i][1]; });
  }
  function stateDot(color) { $("state-dot").style.background = color; $("state-dot").style.boxShadow = `0 0 12px ${color}`; }
  /** Everything that depends on where Echo runs, painted in one place. */
  function renderMode() {
    renderMacPage({ faceId: false });
    const phone = mode === "phone";
    body.dataset.mode = mode;
    const h = new Date().getHours();
    $("greeting").textContent = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : h < 22 ? "Good evening" : "Good night";
    $("mac-dot").className = phone ? "dot cloud" : macOnline ? "dot ok" : "dot";
    $("mac-name").textContent = phone ? "Phone" : macOnline ? macChip : "Mac offline";
    $("set-mode").textContent = phone ? "Phone" : "Mac";
    $("mode-mac").setAttribute("aria-checked", String(!phone));
    $("mode-phone").setAttribute("aria-checked", String(phone));
    $("mode-phone").disabled = false;
    $("mode-mac-status").textContent = !T ? "Optional · connect in Settings" : macOnline ? "Online now" : "Offline right now";
    $("mode-phone-status").textContent = passValid() ? cloudLine() : "Available without a Mac";
    $("set-cloud").textContent = passValid() ? cloudLine() : "Start Echo on this phone";
    $("signout-all").hidden = !PASS || passClaims()?.p === true;
    const prompts = phone ? ["Help me handle this", "Do this for me", "Don’t let me forget this", "What did we decide?"] : ["Status of my tasks", "What's on my screen?", "Read my latest email", "Good night"];
    document.querySelectorAll(".chips .chip").forEach((chip, i) => { chip.textContent = prompts[i] || chip.textContent; });
    if (phone) paintPhoneHome(); else if (macOnline && last) paintMacHome(last); else paintOffline();
    renderTyping(chatTyping || cloudBusy);
  }
  function paintPhoneHome() {
    const ready = !!(cloudInfo && cloudInfo.ready);
    body.dataset.status = cloudBusy ? "thinking" : "idle";
    $("state-label").textContent = cloudBusy ? "THINKING" : "ON YOUR PHONE";
    stateDot(cloudBusy ? "#b98cff" : "#5ee7f5");
    $("brain-name").textContent = !passValid() ? "Connecting…" : ready ? prettyModel(cloudInfo.model) : cloudInfo ? "Not set up" : "";
    const u = cloudInfo && cloudInfo.usage;
    setStats([[u ? u.messages : "—", "Messages"], [u ? u.requests : "—", "Requests"], [u && u.limit ? Math.max(0, u.limit - u.requests) : "—", "Left today"], [macOnline ? "On" : "Off", "Mac"]]);
    $("activity-line").textContent = lastCloudLine || (ready ? "Echo is answering from your phone." : cloudInfo ? "Phone mode needs the Gemini key on Render." : "Connecting…");
  }
  function paintMacHome(d) {
    const st = STATE[d.status] || STATE.idle;
    body.dataset.status = STATE[d.status] ? d.status : "idle"; // drives the humanoid and the reactor
    $("state-label").textContent = st[0];
    stateDot(st[1]);
    $("brain-name").textContent = d.brain ? `${d.brain.label} · ${d.brain.model}` : "";
    const a = d.analytics || {};
    setStats([[a.commands || 0, "Commands"], [a.toolCalls || 0, "Tool calls"], [a.completedTasks || 0, "Done"], [a.errors || 0, "Errors"]]);
    if (lastActivity) $("activity-line").textContent = `${lastActivity.text}`;
  }
  function paintOffline() {
    const a = (last && last.analytics) || {};
    setStats([[a.commands || 0, "Commands"], [a.toolCalls || 0, "Tool calls"], [a.completedTasks || 0, "Done"], [a.errors || 0, "Errors"]]);
    $("state-label").textContent = "MAC OFFLINE";
    body.dataset.status = "asleep";
    stateDot("#ff8a8a");
    $("brain-name").textContent = passValid() ? "Tap the pill to use Phone" : "";
    $("activity-line").textContent = "Your Mac is asleep, off, or Echo isn't running.";
  }

  // ---------- where Echo runs ----------
  async function setMode(m) {
    if (m === "mac" && !(T && S)) { closeSheets(); prepareSignIn(); return; }
    if (m === "phone") {
      try { await ensurePhoneSession(); } catch (e) { toast(e.message, true); return; }
    }
    mode = m; store.set("echo_mode", m);
    closeSheets();
    renderMode(); renderBanners();
    if (m === "phone") refreshCloud();
    toast(m === "phone" ? "Echo is on your phone" : "Echo is on your Mac");
  }
  $("mac-pill").addEventListener("click", () => { renderMode(); openSheet("sheet-mode"); });
  $("set-mode-row").addEventListener("click", () => { renderMode(); openSheet("sheet-mode"); });
  $("mode-mac").addEventListener("click", () => setMode("mac"));
  $("mode-phone").addEventListener("click", () => setMode("phone"));
  // "Your Mac is offline" (Mac mode) and "Your Mac is back" (Phone mode).
  let dismissedOffline = false, dismissedBack = true;
  function renderBanners(nudge = false) {
    let b = null;
    const offlineLong = !macOnline && macOfflineSince && Date.now() - macOfflineSince > 20_000;
    if (mode === "mac" && !macOnline && passValid() && (offlineLong || nudge)) {
      if (store.get("echo_autoswitch") === "on") { setMode("phone"); toast("Your Mac is offline, so Echo moved to your phone."); return; }
      if (!dismissedOffline || nudge) b = { title: "Your Mac is offline.", text: "Use Echo on your phone until it's back?", yes: "Switch to Phone", go: () => setMode("phone"), no: () => { dismissedOffline = true; } };
    } else if (mode === "phone" && macOnline && !dismissedBack) {
      // Echo restarting on the Mac ends this phone's session there, so it may need a sign-in.
      b = S
        ? { title: "Your Mac is back.", text: "Echo can work on your Mac again.", yes: "Switch to Mac", go: () => { dismissedBack = true; setMode("mac"); }, no: () => { dismissedBack = true; } }
        : { title: "Your Mac is back.", text: "Sign in to use it again, and to copy this chat over.", yes: "Sign in", go: () => { dismissedBack = true; prepareSignIn(); }, no: () => { dismissedBack = true; } };
    }
    for (const id of ["home-banner", "chat-banner"]) {
      const n = $(id);
      n.hidden = !b;
      if (!b) continue;
      n.querySelector(".bn-title").textContent = b.title;
      n.querySelector(".bn-text").textContent = ` ${b.text}`;
      n.querySelector(".bn-yes").textContent = b.yes;
      n.querySelector(".bn-yes").onclick = () => { b.go(); renderBanners(); };
      n.querySelector(".bn-no").onclick = () => { b.no(); renderBanners(); };
    }
  }
  setInterval(() => { if (!document.hidden) renderBanners(); }, 5000);

  // ---------- Phone mode: the cloud brain ----------
  async function cloudApi(path, json, { signal } = {}) {
    await ensurePhoneSession();
    const r = await fetch(path, {
      method: json ? "POST" : "GET",
      headers: { "x-echo-pass": PASS, "x-echo-installation": INSTALLATION, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
      signal,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { PASS = ""; store.set("echo_pass", null); cloudInfo = null; showWelcome(); renderMode(); }
    if (!r.ok) throw Object.assign(new Error(d.message || `HTTP ${r.status}`), { status: r.status, data: d });
    return d;
  }
  async function refreshCloud() {
    if (currentView === "signin" || (!PASS && !(T && S))) return;
    try {
      await ensurePhoneSession();
      cloudInfo = await cloudApi("/cloud/status");
      if (!S) markMac(!!T && !!cloudInfo.macOnline);
      briefInfo = await cloudApi("/cloud/briefing");
      renderBriefSettings();
      if (currentView === "missions") loadHandoffs();
    } catch { /* keep the last answer */ }
    renderMode();
  }
  setInterval(() => { if (!document.hidden) refreshCloud(); }, 20_000);
  function cloudProblem(e) {
    if (e.status === 401) return "This phone session ended. Tap Get started to continue.";
    const d = e.data || {};
    let msg = d.message || "Phone mode had a problem. Try again.";
    if (d.resetsAt) msg += ` It comes back at ${clock(d.resetsAt)}.`;
    return msg;
  }

  // ---------- approvals ----------
  let pending = null, shownPending = "";
  async function pollPending() {
    const d = await api("/pending");
    pending = d.pending && d.pending.id ? d.pending : null;
    $("approval-card").hidden = !pending;
    $("stats-card").hidden = !!pending;
    if (!pending) { if (!$("sheet-approval").hidden) closeSheets(); return; }
    $("approval-mini").textContent = pending.prompt;
    if (pending.id !== shownPending) {
      shownPending = pending.id;
      if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
      openApproval();
    }
  }
  function openApproval() {
    if (!pending) return;
    $("ap-text").textContent = pending.prompt;
    $("ap-tier").textContent = pending.tier ? `${pending.tier[0].toUpperCase()}${pending.tier.slice(1)} risk` : "";
    openSheet("sheet-approval");
  }
  $("approval-card").addEventListener("click", openApproval);
  async function answer(approved) {
    if (!pending) return closeSheets();
    try {
      const d = await api("/confirm", { json: { id: pending.id, approved } });
      toast(d.ok ? (approved ? "Approved" : "Denied") : "That question already closed.", !d.ok);
    } catch { toast("Couldn't reach your Mac.", true); }
    closeSheets();
    pollPending().catch(() => {});
  }
  $("ap-approve").addEventListener("click", () => answer(true));
  $("ap-deny").addEventListener("click", () => answer(false));

  // ---------- home actions ----------
  $("act-stop").addEventListener("click", async () => {
    stopSpeaking();
    voiceAskedAt = 0;
    if (cloudBusy) { cloudAbort?.abort(); setCloudBusy(false); toast("Stopped"); }
    if (!(S && macOnline)) return;
    try { await api("/stop", { json: {} }); if (mode === "mac") toast("Stopped"); } catch { toast("Couldn't reach your Mac.", true); }
  });
  $("act-neural").addEventListener("click", async () => {
    if (mode === "phone") return openBriefing();
    if (!(S && macOnline)) return toast("That needs your Mac, and it's offline right now.", true);
    try { await api("/action", { json: { type: "open-neural" } }); toast("Neural map is open on your Mac"); } catch (e) { toast(e.message, true); }
  });

  // ---------- voice capture (Whisper on the Mac does the listening) ----------
  async function capture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser can't use the microphone.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node); node.connect(ctx.destination);
    const startedAt = Date.now();
    const end = () => { node.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close(); };
    return {
      startedAt,
      cancel: end,
      stop() { end(); return toWav(chunks, ctx.sampleRate, 16000); },
    };
  }
  function toWav(chunks, rate, target) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const ratio = rate / target, len = Math.floor(total / ratio);
    const all = new Float32Array(total);
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, target, true); v.setUint32(28, target * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return buf;
  }

  // Home "Listen": talk to Echo; the answer is always read out on this phone.
  // (Chat is the place for text: typed messages and voice notes get written replies.)
  let homeRec = null;
  $("act-listen").addEventListener("click", async () => {
    // Anything still queued is dropped before the tap unlocks speech, or the
    // unlock would play it: that was the "ghost voice" of an old reply.
    stopSpeaking();
    primeSpeech();
    const btn = $("act-listen");
    if (!homeRec) {
      voiceAskedAt = 0; // talking over Echo: the reply to the last question isn't wanted any more
      try { homeRec = await capture(); btn.setAttribute("aria-pressed", "true"); toast("Listening… tap again to send"); }
      catch (e) { toast(e.message || "Allow the microphone to talk to Echo.", true); }
      return;
    }
    const wav = homeRec.stop(); homeRec = null; btn.setAttribute("aria-pressed", "false");
    if (wav.byteLength < 44 + 16000) return toast("Too short — tap, speak, then tap again.", true);
    if (mode === "phone") return void sendCloudVoice(wav, { speak: true });
    try { await api("/voice", { body: wav }); voiceAskedAt = Date.now(); toast("Sent to Echo"); } catch { toast("Couldn't reach your Mac.", true); }
  });

  // ---------- replies read aloud on the phone ----------
  // iPhone only lets a page speak once a tap has started speech, and the answer
  // arrives seconds after the tap. So every Listen tap starts a silent sentence,
  // which keeps the voice unlocked for the reply.
  let firstEvents = true, eventsNext = 0;
  /** When this phone last sent its voice from the Echo page: only the answer to that is read aloud. */
  let voiceAskedAt = 0;
  const VOICE_REPLY_MS = 120_000;
  function stopSpeaking() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (talking) { talking = 1; speechEnd(); }
  }
  // Leaving or coming back to the app: whatever was queued is old by then, so it never plays later.
  document.addEventListener("visibilitychange", stopSpeaking);
  function primeSpeech() {
    if (!window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch { /* fine */ }
  }
  document.addEventListener("pointerdown", primeSpeech, { once: true });
  async function pollEvents() {
    const d = await api(`/events?since=${eventsNext}`);
    eventsNext = d.nextIndex || eventsNext;
    for (const it of d.items || []) {
      if (it.kind !== "reply" || firstEvents) continue;
      const text = String(it.line).replace(/^Echo:\s*/, "");
      if (mode === "mac") $("activity-line").textContent = text;
      // Spoken only when it answers this phone's own Listen, and the app is open;
      // replies to anything else (the Mac's microphone, typed chat) stay silent.
      // And only a reply Echo wrote after the question (an older one is never the answer).
      const fresh = !Number.isFinite(it.at) || it.at >= voiceAskedAt - 5000;
      if (voiceAskedAt && fresh && Date.now() - voiceAskedAt < VOICE_REPLY_MS && !document.hidden) say(text);
    }
    firstEvents = false;
  }
  function say(text) {
    if (!window.speechSynthesis || document.hidden) return;
    // One reply at a time: a new one replaces anything queued, so nothing old can play later.
    speechSynthesis.cancel();
    if (talking) { talking = 1; speechEnd(); }
    const ut = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    ut.voice = voices.find((v) => /Daniel|Arthur|Samantha|Karen/.test(v.name)) || voices[0] || null;
    let ended = false;
    const done = () => { if (!ended) { ended = true; speechEnd(); } };
    ut.onboundary = (e) => { if (Number.isFinite(e.charIndex)) speechWord(e.charIndex); };
    ut.onend = done;
    ut.onerror = done;
    speechStart(text);
    speechSynthesis.speak(ut);
  }

  // ---------- Echo speaking on the phone: the figure bursts, the words show ----------
  // While a reply is read aloud here, the humanoid bursts apart. Its particles
  // spell the first few words, then the words follow the voice as captions;
  // 4.5 s after it stops, the figure gathers back together.
  const caption = $("speech-caption");
  let talking = 0, settleTimer = 0, capTimer = 0, capText = "", capAt = 0, capHeard = false;
  function firstWords(text) {
    const words = String(text).replace(/\s+/g, " ").trim().split(" ");
    const out = [];
    for (const w of words) {
      if (out.length >= 3 || (out.join(" ") + " " + w).trim().length > 18) break;
      out.push(w.replace(/[.,!?;:"“”]+$/g, ""));
      if (/[.!?]$/.test(w)) break;
    }
    return out.join(" ") || words[0].slice(0, 12);
  }
  function renderCaption(upTo) {
    const text = capText;
    const at = Math.min(text.length, Math.max(0, upTo));
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    let start = 0, cur = sentences[sentences.length - 1];
    for (const sn of sentences) { if (start + sn.length > at) { cur = sn; break; } start += sn.length; }
    const rel = Math.min(cur.length, Math.max(0, at - start));
    const cut = rel + ((/^\S*/.exec(cur.slice(rel)) || [""])[0].length);
    clear(caption);
    const line = el("p", "cap-line");
    line.append(el("span", "said", cur.slice(0, cut)), document.createTextNode(cur.slice(cut)));
    caption.appendChild(line);
  }
  function speechStart(text) {
    talking++;
    clearTimeout(settleTimer);
    const core = window.echoCore;
    if (core) {
      core.burst(true);
      setTimeout(() => core.spell(firstWords(text)), 350);
      setTimeout(() => core.spell(null), 2600);
    }
    capText = String(text); capAt = Date.now(); capHeard = false;
    renderCaption(0);
    clearInterval(capTimer);
    // Without word timing from the voice, follow it at a speaking pace.
    capTimer = setInterval(() => { if (!capHeard) renderCaption(Math.floor(((Date.now() - capAt) / 1000) * 15)); }, 250);
    setTimeout(() => { if (talking || settleTimer) caption.classList.add("on"); }, 1400);
  }
  function speechWord(i) { capHeard = true; renderCaption(i); }
  function speechEnd() {
    talking = Math.max(0, talking - 1);
    if (talking) return;
    clearInterval(capTimer);
    renderCaption(capText.length);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      caption.classList.remove("on");
      if (window.echoCore) window.echoCore.burst(false);
    }, 4500);
  }

  // ---------- chat ----------
  // One conversation from two places: Echo on the Mac (Mac mode) and Echo in
  // the cloud (Phone mode). Both are kept on this phone, so the history shows
  // even with the Mac off, and Phone mode's messages are copied to the Mac's
  // chat once it's back (each with this phone's own id, so never twice).
  let chatAfter = 0, unread = 0, chatTyping = false, lastDay = "", chatLoaded = false, lastAt = 0;
  let cloudAbort = null, lastCloudLine = "", preparingCloud = false;
  const messagesEl = $("messages");
  const CACHE_KEY = "echo_chat_cache", CACHE_MAX = 400;
  let chatCache = [];
  try { chatCache = JSON.parse(store.get(CACHE_KEY) || "[]").filter((m) => m && m.k && typeof m.text === "string"); } catch { chatCache = []; }
  let saveTimer = 0;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { chatCache = chatCache.slice(-CACHE_MAX); store.set(CACHE_KEY, JSON.stringify(chatCache)); }, 300);
  }
  const byTime = () => chatCache.filter((m) => mode !== "phone" || (m.src === "phone" && (!currentThread || !m.threadId || m.threadId === currentThread))).sort((x, y) => x.at - y.at);
  const newKey = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  function scrollMessages() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  messagesEl.addEventListener("scroll", () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }, { passive: true });
  function renderBadge() { const b = $("chat-badge"); b.hidden = !unread; b.textContent = unread > 9 ? "9+" : String(unread); }
  function addMessage(m) {
    const day = new Date(m.at).toDateString();
    const before = $("typing");
    const put = (n) => (before ? messagesEl.insertBefore(n, before) : messagesEl.appendChild(n));
    if (day !== lastDay) {
      lastDay = day;
      const today = new Date().toDateString() === day;
      put(el("div", "day", today ? "Today" : new Date(m.at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })));
    }
    const mine = m.from === "you";
    const n = el("div", `msg ${mine ? "me cta" : "echo glass"}${m.kind === "voice" ? " voice" : ""}`);
    n.appendChild(document.createTextNode(m.text));
    if (!mine && m.actions && m.actions.length) {
      const acts = el("div", "acts");
      for (const a of m.actions) {
        const btn = el("button", "glass act-btn", a.done ? `Reminder set · ${eventWhen(a.data.start)}` : a.label);
        btn.addEventListener("click", (e) => { e.stopPropagation(); runAction(a, btn); });
        acts.appendChild(btn);
      }
      n.appendChild(acts);
    }
    if (!mine && m.saved && m.saved.length) {
      const acts = el("div", "acts");
      for (const sv of m.saved) {
        const chip = el("button", "glass act-btn saved-chip", `✓ Saved: ${sv.title}`);
        chip.addEventListener("click", (e) => { e.stopPropagation(); openMemory({ id: sv.id }); });
        acts.appendChild(chip);
      }
      n.appendChild(acts);
    }
    if (!mine && (m.captures?.length || m.references?.length)) {
      const receipts = el("div", "acts");
      for (const c of m.captures || []) {
        const b = el("button", "glass act-btn saved-chip", `✓ Today: ${c.text}`); b.addEventListener("click", (e) => { e.stopPropagation(); show("today"); }); receipts.append(b);
      }
      for (const r of m.references || []) {
        const b = el("button", "glass act-btn", `↗ ${r.title}`); b.addEventListener("click", (e) => { e.stopPropagation(); experience?.openReference(r); }); receipts.append(b);
      }
      n.append(receipts);
    }
    if (!mine && m.sources && m.sources.length) {
      const srcs = el("div", "srcs");
      for (const src of m.sources) {
        const link = el("a", "", src.title);
        link.href = src.url; link.target = "_blank"; link.rel = "noopener";
        srcs.appendChild(link);
      }
      n.appendChild(srcs);
    }
    const t = el("time", "", clock(m.at));
    if (m.src === "phone") t.appendChild(el("span", "via", " · on your phone"));
    else if (m.via === "handoff") t.appendChild(el("span", "via", " · left from your phone"));
    n.appendChild(t);
    n.dataset.k = m.k;
    put(n);
    lastAt = Math.max(lastAt, m.at);
  }
  function renderChat() {
    const fromBottom = stickToBottom ? null : messagesEl.scrollHeight - messagesEl.scrollTop;
    clear(messagesEl); lastDay = ""; lastAt = 0;
    for (const m of byTime()) addMessage(m);
    renderTyping(chatTyping || cloudBusy);
    if (fromBottom == null) scrollMessages(); else messagesEl.scrollTop = messagesEl.scrollHeight - fromBottom;
  }
  function putMessage(m) {
    chatCache.push(m);
    saveCache();
    if (mode === "phone" && (m.src !== "phone" || (m.threadId && currentThread && m.threadId !== currentThread))) return;
    if (m.at >= lastAt) { addMessage(m); if (stickToBottom || m.from === "you") scrollMessages(); } else renderChat();
  }
  function dropMessage(m) {
    chatCache = chatCache.filter((x) => x !== m);
    saveCache();
    renderChat();
  }
  function renderTyping(on) {
    let t = $("typing");
    if (on && !t) { t = el("div", "typing glass"); t.id = "typing"; t.setAttribute("aria-label", "Echo is typing"); t.append(el("i"), el("i"), el("i")); messagesEl.appendChild(t); }
    if (!on && t) t.remove();
    if (on && t && t !== messagesEl.lastChild) messagesEl.appendChild(t); // keep it last
    $("presence").textContent = on ? "typing…" : mode === "phone" ? "on your phone" : macOnline ? "online" : "offline";
  }
  async function pollChat() {
    if (!S) return;
    const d = await api(`/chat?since=${chatAfter}`);
    let changed = false;
    for (const m of d.messages || []) {
      chatAfter = Math.max(chatAfter, m.id);
      const copy = m.ref && chatCache.find((x) => x.k === m.ref);
      if (copy) { if (!copy.synced) { copy.synced = true; changed = true; } continue; } // our own Phone mode message, back from the Mac
      const k = `m${m.id}-${m.at}`;
      if (chatCache.some((x) => x.k === k)) continue;
      putMessage({ k, at: m.at, from: m.from, text: m.text, kind: m.kind, src: m.via === "phone" ? "phone" : "mac", ...(m.via === "handoff" ? { via: "handoff" } : {}) });
      if (chatLoaded && m.from === "echo" && currentView !== "chat") unread++; // history is not "unread"
    }
    if (changed) saveCache();
    chatLoaded = true;
    chatTyping = !!d.typing;
    renderTyping(chatTyping || cloudBusy);
    renderBadge();
    syncToMac();
  }
  const input = $("chat-input");
  function autosize() { input.style.height = "40px"; input.style.height = `${Math.min(120, input.scrollHeight)}px`; }
  function setComposerMode() {
    const has = !!input.value.trim();
    $("ico-mic").toggleAttribute("hidden", has); $("ico-send").toggleAttribute("hidden", !has); // SVG has no .hidden
    $("send-btn").setAttribute("aria-label", has ? "Send" : "Hold to record a voice note");
  }
  input.addEventListener("input", () => { autosize(); setComposerMode(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  function restoreInput(text) { input.value = text; autosize(); setComposerMode(); }
  /** A draft about the Mac's own work (missions, projects): it goes to the Mac even in Phone mode. */
  let macDraft = false;
  async function sendChat(text = input.value) {
    text = String(text).trim();
    if (!text) return;
    restoreInput("");
    input.placeholder = "Message";
    const toMac = macDraft; macDraft = false;
    if (mode === "phone" && !toMac) return sendCloud(text);
    try {
      const d = await api("/chat", { json: { text } });
      if (d.message) {
        chatAfter = Math.max(chatAfter, d.message.id);
        const k = `m${d.message.id}-${d.message.at}`;
        if (!chatCache.some((x) => x.k === k)) putMessage({ k, at: d.message.at, from: "you", text: d.message.text, kind: d.message.kind, src: "mac" });
      }
      renderTyping(true); scrollMessages();
    } catch (e) {
      restoreInput(text);
      if (e.status === 503 && passValid()) { renderBanners(true); toast("Your Mac is offline. Switch to Phone to ask Echo here.", true); }
      else toast(e.status === 503 ? "Your Mac is offline — message not sent." : "Couldn't send that.", true);
    }
  }
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) sendChat(); });
    document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
      if (mode === "phone" && /handle this|do this for me|forget this/i.test(c.textContent)) { restoreInput(`${c.textContent}: `); input.focus(); }
      else sendChat(c.textContent);
    }));
  // Tapping the conversation puts the keyboard away. Tapping a message offers
  // to remember it (Saved) or copy it.
  messagesEl.addEventListener("click", (e) => {
    input.blur();
    const n = e.target.closest(".msg");
    const open = messagesEl.querySelector(".msg-tools");
    if (e.target.closest(".msg-tools, button, a")) return;
    if (open) { open.remove(); if (open.parentElement === n) return; }
    if (!n || (window.getSelection && String(window.getSelection()).length)) return;
    const m = chatCache.find((x) => x.k === n.dataset.k);
    if (!m || !m.text || (m.kind === "voice" && m.text === "Voice message")) return;
    const tools = el("div", "msg-tools");
    if (passValid()) {
      const rem = el("button", "glass small-pill", "Remember");
      rem.addEventListener("click", () => { tools.remove(); openMemNote(m.text); });
      tools.appendChild(rem);
    }
    const copy = el("button", "glass small-pill", "Copy");
    copy.addEventListener("click", async () => { tools.remove(); try { await navigator.clipboard.writeText(m.text); toast("Copied"); } catch { toast("Couldn't copy.", true); } });
    tools.appendChild(copy);
    n.appendChild(tools);
  });

  // ---------- Phone mode: asking Echo in the cloud ----------
  const shortcutList = () => String(store.get("echo_shortcuts") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
  function historyNow() { return byTime().slice(-20).map((m) => ({ role: m.from === "you" ? "user" : "echo", text: m.text })); }
  function localTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }
  function cloudContext() {
    const pl = place();
    const tz = localTz();
    return { tz, city: pl && pl.name !== "Current location" ? pl.name : undefined, lat: pl ? pl.lat : undefined, lon: pl ? pl.lon : undefined, shortcuts: shortcutList(),
      ...(snapCtx && snapCtx.until > Date.now() ? { snap: snapCtx.snap } : {}) };
  }
  function setCloudBusy(on) {
    cloudBusy = on;
    renderTyping(chatTyping || on);
    if (mode === "phone") paintPhoneHome();
    window.echoCore?.avatar();
  }
  async function askCloud(path, payload, { speak = false } = {}) {
    if (!passValid()) { toast("Tap Get started to use Echo on this phone.", true); return null; }
    cloudAbort?.abort();
    const abort = (cloudAbort = new AbortController());
    setCloudBusy(true);
    try {
      const d = await cloudApi(path, { ...payload, threadId: currentThread, context: cloudContext() }, { signal: abort.signal });
      const reply = { k: payload.requestId ? `${payload.requestId}-echo` : newKey(), at: Date.now(), from: "echo", text: d.reply, kind: "text", src: "phone", threadId: currentThread,
        actions: d.actions || [], sources: d.sources || [], saved: d.saved || [], captures: d.captures || [], references: d.references || [] };
      putMessage(reply);
      prepareActions(reply);
      lastCloudLine = d.reply;
      if (d.usage && cloudInfo) cloudInfo.usage = d.usage;
      if (speak) say(d.reply);
      if (currentView !== "chat") { unread++; renderBadge(); }
      renderMode();
      window.echoCore?.react(d.expression || "attentive");
      experience?.afterReply();
      const delegation = reply.actions.find((a) => a.type === "browse" && a.autoStart);
      if (delegation) setTimeout(() => runEcho(delegation.data.task), 0);
      syncToMac();
      return d;
    } catch (e) {
      if (e.name !== "AbortError") toast(cloudProblem(e), true);
      return null;
    } finally {
      if (cloudAbort === abort) setCloudBusy(false);
    }
  }
  async function sendCloud(text) {
    if (cloudBusy || preparingCloud) { restoreInput(text); return toast("Let Echo finish this reply first."); }
    preparingCloud = true;
    try { await experience?.ensureThread(); } catch (e) { toast(e.message, true); restoreInput(text); return; } finally { preparingCloud = false; }
    const history = historyNow();
    const mine = { k: newKey(), at: Date.now(), from: "you", text, kind: "text", src: "phone", threadId: currentThread };
    putMessage(mine);
    const d = await askCloud("/cloud/chat", { text, history, requestId: mine.k });
    if (!d) { dropMessage(mine); restoreInput(text); }
  }
  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  async function sendCloudVoice(wav, opts = {}) {
    if (wav.byteLength > 2_200_000) return toast("That's too long. Keep voice messages under a minute.", true);
    if (cloudBusy || preparingCloud) return toast("Let Echo finish this reply first.");
    preparingCloud = true;
    try { await experience?.ensureThread(); } catch (e) { return toast(e.message, true); } finally { preparingCloud = false; }
    const history = historyNow();
    const mine = { k: newKey(), at: Date.now(), from: "you", text: "Voice message", kind: "voice", src: "phone", threadId: currentThread };
    putMessage(mine);
    const d = await askCloud("/cloud/voice", { audio: toBase64(wav), history, requestId: mine.k }, opts);
    if (!d) return dropMessage(mine);
    if (d.transcript) { mine.text = d.transcript; saveCache(); renderChat(); }
  }
  // Buttons under Phone mode's answers. Nothing happens until one is tapped.
  async function makeIcs(a) {
    const d = await cloudApi("/cloud/ics", { event: a.data });
    a.url = d.url;
    saveCache();
    return d.url;
  }
  function prepareActions(m) {
    // Calendar links normally arrive with the answer; older ones are made now,
    // so a tap can open Safari straight away.
    for (const a of m.actions || []) if (a.type === "calendar" && !a.url) makeIcs(a).catch(() => {});
  }
  const eventWhen = (local) => { const d = new Date(local); return isNaN(d) ? local : d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
  /**
   * A Home Screen app can't open a calendar file itself (its in-app browser
   * shows a white page), so the link goes to the Safari app, which offers
   * "Add to Calendar". If Safari doesn't come up, a sheet offers the link.
   */
  function openCalendar(a) {
    if (!a.url) { makeIcs(a).then(() => toast("Ready. Tap the button again.")).catch((e) => toast(cloudProblem(e), true)); return; }
    const link = new URL(a.url, location.origin).href;
    if (!standalone) { location.href = link; return; }
    location.href = `x-safari-${link}`;
    setTimeout(() => { if (!document.hidden) showCalendarHelp(a, link); }, 1500);
  }
  function showCalendarHelp(a, link) {
    $("cal-title").textContent = a.data.title;
    $("cal-when").textContent = `${eventWhen(a.data.start)}${a.data.location ? ` · ${a.data.location}` : ""}`;
    $("cal-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast("Link copied. Paste it into Safari."); }
      catch { toast("Couldn't copy the link.", true); }
    };
    openSheet("sheet-cal");
  }
  async function runAction(a, btn) {
    if (a.type === "link") return void window.open(a.data.url, "_blank", "noopener");
    if (a.type === "shortcut") {
      const q = `name=${encodeURIComponent(a.data.name)}${a.data.input ? `&input=text&text=${encodeURIComponent(a.data.input)}` : ""}`;
      location.href = `shortcuts://run-shortcut?${q}`;
      return;
    }
    if (a.type === "calendar") return openCalendar(a);
    if (a.type === "reminder") {
      if (a.done) return toast("That reminder is already set.");
      if (!(briefInfo && briefInfo.subscribed)) {
        toast("Turn on Briefing and reminders in Settings to get reminders from Echo. Adding it to Calendar for now.");
        return openCalendar(a);
      }
      btn.setAttribute("aria-busy", "true");
      try {
        await cloudApi("/cloud/reminders", { text: a.data.title, when: a.data.start, tz: localTz() });
        a.done = true; saveCache();
        if (a.snapId) cloudApi("/cloud/snaps/done", { id: a.snapId, type: "reminder" }).catch(() => {});
        btn.textContent = `Reminder set · ${eventWhen(a.data.start)}`;
        toast(`Echo will remind you ${eventWhen(a.data.start)}`);
      } catch (e) { toast(cloudProblem(e), true); }
      finally { btn.removeAttribute("aria-busy"); }
      return;
    }
    if (a.type === "browse") return runEcho(a.data.task);
    if (a.type === "mac") {
      if (!(S && macOnline)) return openHandoff(a.data.task); // the Mac is away: leave it for later, approved with Face ID
      btn.setAttribute("aria-busy", "true");
      try { await api("/chat", { json: { text: a.data.task } }); toast("Sent to your Mac"); pollChat().catch(() => {}); }
      catch { toast("Couldn't reach your Mac.", true); }
      finally { btn.removeAttribute("aria-busy"); }
    }
  }
  // Copy Phone mode's messages into the Mac's chat once it's reachable.
  let syncing = false;
  async function syncToMac() {
    if (syncing || !S || !macOnline) return;
    const todo = byTime().filter((m) => m.src === "phone" && !m.synced && !(m.kind === "voice" && m.text === "Voice message"));
    if (!todo.length) return;
    syncing = true;
    try {
      while (todo.length) {
        const batch = [];
        let size = 0;
        while (todo.length && size < 150_000 && batch.length < 100) {
          const m = todo.shift();
          const item = { ref: m.k, from: m.from, text: m.text, at: m.at, kind: m.kind === "voice" ? "voice" : "text" };
          size += JSON.stringify(item).length;
          batch.push(item);
        }
        await api("/chat/import", { json: { messages: batch }, quiet: true });
        for (const it of batch) { const m = chatCache.find((x) => x.k === it.ref); if (m) m.synced = true; }
        saveCache();
      }
    } catch { /* tried again on the next poll */ } finally { syncing = false; }
  }

  // Voice notes: hold the mic (or tap the header button) to record.
  let note = null, noteTimer = 0;
  async function startNote() {
    if (note) return;
    try { note = await capture(); } catch (e) { return toast(e.message || "Allow the microphone to send voice notes.", true); }
    $("recording").hidden = false;
    noteTimer = setInterval(() => { const s = Math.floor((Date.now() - note.startedAt) / 1000); $("rec-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 250);
  }
  async function finishNote(send) {
    if (!note) return;
    clearInterval(noteTimer); $("recording").hidden = true;
    const rec = note; note = null;
    if (!send) { rec.cancel(); return; }
    const wav = rec.stop();
    if (wav.byteLength < 44 + 12000) return toast("Hold a little longer to record.", true);
    if (mode === "phone") return void sendCloudVoice(wav);
    renderTyping(true); scrollMessages();
    try {
      const d = await api("/chat/voice", { body: wav });
      if (d.message) {
        chatAfter = Math.max(chatAfter, d.message.id);
        const k = `m${d.message.id}-${d.message.at}`;
        if (!chatCache.some((x) => x.k === k)) putMessage({ k, at: d.message.at, from: "you", text: d.message.text, kind: d.message.kind, src: "mac" });
        renderTyping(true); scrollMessages();
      }
    } catch (e) { renderTyping(false); toast(e.data && e.data.error || "Couldn't send the voice note.", true); }
  }
  const sendBtn = $("send-btn");
  let holdStart = { x: 0, y: 0 };
  sendBtn.addEventListener("pointerdown", (e) => {
    if (input.value.trim()) return;
    e.preventDefault(); sendBtn.setPointerCapture(e.pointerId); holdStart = { x: e.clientX, y: e.clientY }; startNote();
  });
  sendBtn.addEventListener("pointerup", (e) => {
    if (!note) return;
    const moved = Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > 80;
    finishNote(!moved);
  });
  sendBtn.addEventListener("pointercancel", () => finishNote(false));
  sendBtn.addEventListener("contextmenu", (e) => e.preventDefault());
  $("chat-talk").addEventListener("click", () => (note ? finishNote(true) : startNote()));

  // ---------- missions ----------
  // What Echo on the Mac is working on (its /status: missions, agents,
  // projects), and the jobs left here for it (hand-offs, kept by the relay).
  // The Mac's lists need it signed in and online; hand-offs work without it.
  let seg = "missions", armed = "", lastStatusAt = 0;
  const MISSION_STATE = { completed: ["Done", "#3ee6b0"], partial: ["Partly done", "#ffb35c"], blocked: ["Blocked", "#ffb35c"], failed: ["Failed", "#ff6b6b"], cancelled: ["Stopped", "#8fa3aa"] };
  /** The Mac's step statuses as the page draws them (it says "completed", not "done"). */
  const STEP_CLASS = { completed: "done", done: "done", working: "working", running: "working", partial: "partial", blocked: "failed", failed: "failed", cancelled: "cancelled" };
  const PHASE = { completed: ["Done", "#3ee6b0"], implementing: ["Building", "#5ee7f5"], verifying: ["Checking", "#5ee7f5"], previewing: ["Preview", "#5ee7f5"], deploying: ["Deploying", "#5ee7f5"],
    planning: ["Planning", "#ffb35c"], clarifying: ["Clarifying", "#ffb35c"], "waiting-for-input": ["Needs you", "#ffb35c"], blocked: ["Blocked", "#ff6b6b"], failed: ["Failed", "#ff6b6b"], cancelled: ["Stopped", "#8fa3aa"] };
  const cap = (t) => (t ? `${String(t)[0].toUpperCase()}${String(t).slice(1)}` : "");
  /** Running missions, working agents and projects waiting on you, on their tabs. */
  function segCounts(n) {
    document.querySelectorAll("[data-seg]").forEach((b) => {
      const k = b.dataset.seg;
      const label = { missions: "Missions", agents: "Agents", projects: "Projects" }[k];
      b.textContent = n[k] ? `${label} · ${n[k]}` : label;
    });
  }
  function setSeg(k) {
    seg = k;
    document.querySelectorAll("[data-seg]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.seg === k)));
    ["missions", "agents", "projects"].forEach((n) => ($(`seg-${n}`).hidden = n !== k));
    $("handoff-box").hidden = k !== "missions"; // jobs for the Mac belong with missions
  }
  document.querySelectorAll("[data-seg]").forEach((b) => b.addEventListener("click", () => setSeg(b.dataset.seg)));
  /** Ask Echo on the Mac about its own work: in the chat, sent to the Mac whatever the mode. */
  function askMac(text) {
    if (!(S && macOnline)) return toast("That needs your Mac, and it isn't connected right now.", true);
    show("chat");
    macDraft = true;
    restoreInput(text);
    input.placeholder = "Message your Mac";
    input.focus();
  }
  /** Why the Mac's lists are empty or old: not signed in, or offline (showing what it last said). */
  function macNote() {
    if (!(T && S)) {
      const c = el("section", "glass bcard");
      c.append(el("p", "", "Your Mac's missions, agents and projects show here when it's connected."));
      const b = el("button", "glass small-pill", "Settings → Your Mac"); b.addEventListener("click", () => show("mac"));
      c.appendChild(b);
      return c;
    }
    if (!macOnline) return el("p", "fine mac-note", lastStatusAt ? `Your Mac is offline. This is what it was doing at ${clock(lastStatusAt)}.` : "Your Mac is offline.");
    return null;
  }
  function ring(pct) {
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "52"); svg.setAttribute("height", "52"); svg.setAttribute("viewBox", "0 0 52 52"); svg.classList.add("ring");
    svg.setAttribute("aria-label", `${pct}% done`);
    const c1 = document.createElementNS(NS, "circle"), c2 = document.createElementNS(NS, "circle"), t = document.createElementNS(NS, "text");
    for (const c of [c1, c2]) { c.setAttribute("cx", "26"); c.setAttribute("cy", "26"); c.setAttribute("r", "22"); c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "5"); }
    c1.setAttribute("stroke", "rgba(255,255,255,.14)");
    c2.setAttribute("stroke", "#5ee7f5"); c2.setAttribute("stroke-linecap", "round");
    c2.setAttribute("stroke-dasharray", `${(pct / 100) * 138.2} 138.2`); c2.setAttribute("transform", "rotate(-90 26 26)");
    t.setAttribute("x", "26"); t.setAttribute("y", "31"); t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "13"); t.setAttribute("font-weight", "600"); t.setAttribute("fill", "#fff");
    t.textContent = `${pct}%`;
    svg.append(c1, c2, t);
    return svg;
  }
  function renderMissions(d = last) {
    const stale = !macOnline;
    const box = $("seg-missions"), ag = $("seg-agents"), pj = $("seg-projects");
    clear(box); clear(ag); clear(pj);
    for (const target of [box, ag, pj]) { const n = macNote(); if (n) target.appendChild(n); }
    if (!d || !(T && S)) { segCounts({}); return; }
    const missions = Array.isArray(d.missions) ? d.missions : [];
    if (!missions.length) box.appendChild(Object.assign(el("div", "glass list"))).appendChild(el("p", "sub empty", "No missions yet. Ask Echo to build or research something."));
    const running = missions.filter((m) => m.status === "running"), done = missions.filter((m) => m.status !== "running");
    for (const m of running) {
      const steps = Array.isArray(m.steps) ? m.steps : [];
      const finished = steps.filter((s) => STEP_CLASS[s.status] === "done").length;
      const pct = steps.length ? Math.round(finished / steps.length * 100) : 5;
      const card = el("section", `glass mission${stale ? " stale" : ""}`);
      const top = el("div", "mission-top"); top.appendChild(ring(pct));
      const kind = String(m.id || "").startsWith("supervised.") ? "Supervised" : "Mission";
      // Steps can run side by side, so: how many are done. Offline, the clock stops when the Mac was last heard from.
      const asOf = stale && lastStatusAt ? lastStatusAt : Date.now();
      const txt = el("div", "grow"); txt.append(el("b", "", m.goal || "Mission"), el("span", "sub small", `${kind} · ${steps.length ? `${finished} of ${steps.length} done` : "starting"} · ${dur(asOf - (m.createdAt || asOf))}`));
      const live = el("span", "small row-i");
      if (stale) { live.style.color = "#ffb35c"; live.append(el("span", "dot"), document.createTextNode("Last seen running")); }
      else { live.style.color = "#74f2a0"; live.append(el("span", "dot ok pulse"), document.createTextNode("Running")); }
      top.append(txt, live); card.appendChild(top);
      if (steps.length) {
        const list = el("div", "steps");
        for (const s of steps.slice(0, 6)) { const r = el("div", `step ${STEP_CLASS[s.status] || ""}`); r.append(el("i"), el("span", "clamp1", s.goal || "")); list.appendChild(r); }
        if (steps.length > 6) list.appendChild(el("span", "sub tiny", `and ${steps.length - 6} more`));
        card.appendChild(list);
      }
      const btns = el("div", "btns2");
      const ask = el("button", "glass big-btn", "Ask about it");
      ask.addEventListener("click", () => askMac(`How is "${m.goal}" going?`));
      const stop = el("button", `big-btn stop-btn${armed === m.id ? " armed" : ""}`, armed === m.id ? "Tap again to stop" : "Stop");
      stop.disabled = stale;
      stop.addEventListener("click", async () => {
        if (armed !== m.id) { armed = m.id; renderMissions(); setTimeout(() => { if (armed === m.id) { armed = ""; renderMissions(); } }, 3000); return; }
        armed = "";
        stop.setAttribute("aria-busy", "true");
        try { const r = await api("/action", { json: { type: "stop-mission", missionId: m.id } }); toast(r.message || "Stopped", !r.ok); }
        catch (e) { toast(e.status === 503 ? "Your Mac is offline." : e.message, true); }
        pollStatus().catch(() => {}); // show the change now, not on the next poll
      });
      btns.append(ask, stop); card.appendChild(btns); box.appendChild(card);
    }
    if (done.length) {
      const list = el("section", "glass list");
      for (const m of done.slice(0, 10)) {
        const [label, color] = MISSION_STATE[m.status] || [cap(m.status) || "Ended", "#8fa3aa"];
        const r = el("button", "row"); const dot = el("span", "dot"); dot.style.background = color;
        const t = el("div", "grow"); t.append(el("span", "clamp1", m.goal || "Mission"), el("span", "sub tiny", `${label} · ${ago(m.updatedAt || m.createdAt || Date.now())}`));
        r.append(dot, t);
        r.addEventListener("click", () => askMac(`What happened with "${m.goal}"?`));
        list.appendChild(r);
      }
      box.appendChild(list);
    }
    const agents = Array.isArray(d.agents) ? d.agents : [];
    const projects0 = Array.isArray(d.projects) ? d.projects : [];
    segCounts({ missions: running.length, agents: agents.filter((a) => /work|run/.test(String(a.status || ""))).length, projects: projects0.filter((p) => p.question).length });
    const al = el("section", "glass list");
    if (!agents.length) al.appendChild(el("p", "sub empty", "No agents are working right now."));
    for (const a of agents) {
      const r = el("div", "row"); const av = el("span", "glass avatar-sq", String(a.name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "AG");
      const t = el("div", "grow"); t.append(el("span", "clamp1", a.name || "Agent"), el("span", "sub tiny clamp1", a.progress || a.goal || ""));
      const working = /work|run/.test(String(a.status || ""));
      const st = el("span", "small", working ? (stale ? "Last seen working" : "Working") : cap(a.status)); st.style.color = working ? (stale ? "#ffb35c" : "#74f2a0") : "";
      r.append(av, t, st); al.appendChild(r);
    }
    ag.appendChild(al);
    const projects = Array.isArray(d.projects) ? d.projects : [];
    const pl = el("section", "glass list");
    if (!projects.length) pl.appendChild(el("p", "sub empty", "No projects yet."));
    for (const p of projects) {
      const [label, color] = PHASE[p.phase] || [cap(p.phase) || "Project", "#ffb35c"];
      const r = el("button", "row"); const t = el("div", "grow");
      t.append(el("span", "clamp1", p.name || "Project"), el("span", "sub tiny", `rev ${p.revision ?? 0} · ${p.criteria ?? 0} criteria · ${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}`));
      if (p.question) t.appendChild(el("span", "small clamp2 proj-q", `Echo asks: ${p.question}`));
      const tag = el("span", "tag", label); tag.style.color = color;
      r.append(t, tag);
      r.addEventListener("click", () => askMac(p.question ? `About the project "${p.name}": ` : p.phase === "completed" ? `Run the checks for the project "${p.name}".` : `Continue building the project "${p.name}".`));
      pl.appendChild(r);
    }
    pj.appendChild(pl);
  }

  // ---------- world ----------
  let world = null, worldAt = 0, wf = "all";
  async function loadWorld(force) {
    if (!force && world && Date.now() - worldAt < 4 * 60_000) return renderWorld();
    try { world = await pub("/world"); worldAt = Date.now(); renderWorld(); }
    catch { if (!world) { const l = $("world-list"); clear(l); l.appendChild(el("p", "sub empty", "Osiris isn't answering right now. Try again in a minute.")); } }
  }
  document.querySelectorAll("[data-wf]").forEach((b) => b.addEventListener("click", () => {
    wf = b.dataset.wf; document.querySelectorAll("[data-wf]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); renderWorld();
  }));
  function renderWorld() {
    if (!world) return;
    $("world-updated").textContent = `Live from Osiris · ${clock(world.updatedAt)}`;
    const stats = $("world-stats"); clear(stats);
    const stat = (n, label, color) => { const s = el("div", "glass stat"); const b = el("b", "", n); b.style.color = color; s.append(b, el("span", "sub tiny", label)); return s; };
    stats.append(stat(world.conflicts.length, "Conflicts", "#ff8a8a"), stat(world.earthquakes.count, "Quakes", "#ffc27a"),
      stat(world.fires.count.toLocaleString(), "Fires", "#ff9b5c"), stat(world.tsunamis.length, "Tsunami", "#8fc6ff"));
    const items = [];
    for (const z of world.conflicts) items.push({ k: "conflict", color: z.severity === "war" ? "#ff6b6b" : "#ff9b6b", title: z.label.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()), meta: z.severity === "war" ? "War" : "High", detail: z.latest ? z.latest.title : z.description, url: z.latest && z.latest.url });
    for (const q of world.earthquakes.top.slice(0, 8)) items.push({ k: "quake", color: "#ffb35c", title: `M${q.magnitude.toFixed(1)} · ${q.place}`, meta: clock(q.at), detail: `Depth ${Math.round(q.depthKm)} km${q.tsunami ? " · tsunami flagged" : ""}`, url: q.url });
    for (const s of world.storms) items.push({ k: "hazard", color: "#b48cff", title: s.title, meta: s.severity || s.type, detail: `${s.type}${s.source ? ` · ${s.source}` : ""}` });
    items.push({ k: "hazard", color: "#ff8a3d", title: `${world.fires.count.toLocaleString()} active fire detections`, meta: "NASA FIRMS", detail: `${world.fires.highConfidence} high-confidence hotspots worldwide` });
    items.push(world.tsunamis.length
      ? { k: "hazard", color: "#6fb6ff", title: `${world.tsunamis.length} tsunami-flagged earthquake${world.tsunamis.length > 1 ? "s" : ""}`, meta: "USGS", detail: world.tsunamis.map((t) => t.place).join(" · ") }
      : { k: "hazard", color: "#6fb6ff", title: "No tsunami alerts", meta: "Now", detail: `None of today's ${world.earthquakes.count} earthquakes is flagged.` });
    const order = { conflict: 0, quake: 1, hazard: 2 };
    const shown = items.filter((i) => wf === "all" || i.k === wf).sort((a, b) => (wf === "all" ? order[a.k] - order[b.k] : 0));
    const l = $("world-list"); clear(l);
    for (const i of shown.slice(0, 40)) {
      const r = el(i.url ? "a" : "div", "row wrow");
      if (i.url) { r.href = i.url; r.target = "_blank"; r.rel = "noopener"; }
      const dot = el("span", "dot"); dot.style.background = i.color; dot.style.boxShadow = `0 0 10px ${i.color}`;
      const t = el("div", "grow"); const head = el("div", "whead"); head.append(el("b", "", i.title), el("span", "sub tiny", i.meta));
      t.append(head, el("span", "sub small", i.detail));
      r.append(dot, t); l.appendChild(r);
    }
  }

  // ---------- weather ----------
  const WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Rain", 63: "Rain", 65: "Heavy rain", 71: "Snow", 73: "Snow", 75: "Heavy snow", 80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm" };
  function place() { try { return JSON.parse(store.get("echo_place") || "null"); } catch { return null; } }
  function weatherIcon(code, day) {
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "w-icon");
    const p = document.createElementNS(NS, "path");
    if (code <= 1) { p.setAttribute("d", day ? "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" : "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"); }
    else if (code <= 3 || code === 45 || code === 48) p.setAttribute("d", "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z");
    else p.setAttribute("d", "M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a3.5 3.5 0 0 0 1 7zM9 18l-1 3M13 18l-1 3M17 18l-1 3");
    p.setAttribute("fill", code <= 1 && !day ? "#e8f1ff" : "none"); p.setAttribute("stroke", "#e8f1ff"); p.setAttribute("stroke-width", "1.6"); p.setAttribute("stroke-linecap", "round");
    svg.appendChild(p); return svg;
  }
  async function loadWeather() {
    const pl = place();
    $("set-place").textContent = pl ? pl.name : "Not set";
    if (!pl) return;
    try {
      const w = await pub(`/weather?lat=${pl.lat}&lon=${pl.lon}`);
      $("w-place").textContent = pl.name;
      $("w-temp").textContent = `${Math.round(w.temp)}°`;
      const ic = $("w-icon"); clear(ic); ic.appendChild(weatherIcon(w.code, w.isDay));
      $("w-detail").textContent = `${WMO[w.code] || "—"} · H ${Math.round(w.high)}° L ${Math.round(w.low)}° · feels ${Math.round(w.feels)}°`;
    } catch { $("w-detail").textContent = "Weather unavailable right now"; }
    clearTimeout(timers.weather); timers.weather = setTimeout(loadWeather, 10 * 60_000);
  }
  $("weather-card").addEventListener("click", () => (place() ? loadWeather() : openSheet("sheet-place")));
  $("set-weather").addEventListener("click", () => openSheet("sheet-place"));
  function choosePlace(p) {
    store.set("echo_place", JSON.stringify(p)); closeSheets(); loadWeather(); toast(`Weather for ${p.name}`);
    if (briefInfo && briefInfo.prefs && briefInfo.prefs.on) saveBriefPrefs().catch(() => {});
  }
  $("pl-here").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location isn't available on this phone.", true);
    navigator.geolocation.getCurrentPosition(
      (pos) => choosePlace({ name: "Current location", lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }),
      () => toast("Allow location for Echo in Settings, or search for a city.", true),
      { maximumAge: 600_000, timeout: 10_000 });
  });
  $("pl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("pl-q").value.trim(); if (q.length < 2) return;
    const box = $("pl-results"); clear(box); box.hidden = false;
    try {
      const d = await pub(`/geocode?q=${encodeURIComponent(q)}`);
      if (!d.results.length) box.appendChild(el("p", "sub empty", "No places found."));
      for (const r of d.results) {
        const b = el("button", "row"); const t = el("div", "grow"); t.append(el("span", "", r.name), el("span", "sub tiny", [r.admin, r.country].filter(Boolean).join(", ")));
        b.appendChild(t); b.addEventListener("click", () => choosePlace({ name: r.name, lat: r.lat, lon: r.lon })); box.appendChild(b);
      }
    } catch { box.appendChild(el("p", "sub empty", "Search isn't available right now.")); }
  });

  // ---------- settings ----------
  function renderSettings(d) {
    $("set-brain").textContent = d.brain ? d.brain.label : "";
    const fid = d.faceId || {};
    const sw = $("sw-faceid");
    sw.setAttribute("aria-checked", String(!!(fid.registered && store.get("echo_faceid") !== "off")));
    sw.dataset.available = fid.available ? "1" : "";
    const v = d.voice || {};
    document.querySelectorAll("[data-voice]").forEach((s) => s.setAttribute("aria-checked", String(!!v[s.dataset.voice])));
  }
  $("sw-faceid").addEventListener("click", async () => {
    const sw = $("sw-faceid");
    if (!sw.dataset.available) return toast("Face ID works in the Echo app on your Home Screen.", true);
    if (sw.getAttribute("aria-checked") === "true") { store.set("echo_faceid", "off"); sw.setAttribute("aria-checked", "false"); return toast("Face ID is off on this phone"); }
    try {
      store.set("echo_faceid", null);
      if (last && last.faceId && last.faceId.registered) { sw.setAttribute("aria-checked", "true"); return toast("Face ID is on"); }
      const o = await api("/passkey/options?purpose=register");
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: b64.toBuf(o.challenge), rp: o.rp, user: { ...o.user, id: b64.toBuf(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
        authenticatorSelection: o.authenticatorSelection, attestation: "none", timeout: o.timeout,
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ type: "public-key", id: b64.toBuf(c.id) })),
      } });
      await api("/passkey/register", { json: { name: "iPhone", credential: { id: cred.id, rawId: b64.fromBuf(cred.rawId), type: cred.type, response: {
        clientDataJSON: b64.fromBuf(cred.response.clientDataJSON), attestationObject: b64.fromBuf(cred.response.attestationObject) } } } });
      rememberPasskeys([{ id: cred.id }]);
      sw.setAttribute("aria-checked", "true"); toast("Face ID is on");
    } catch (e) { if (e && e.name !== "NotAllowedError") toast(e.message || "Couldn't turn on Face ID.", true); }
  });
  document.querySelectorAll("[data-voice]").forEach((s) => s.addEventListener("click", async () => {
    const value = s.getAttribute("aria-checked") !== "true";
    s.setAttribute("aria-checked", String(value));
    try { const r = await api("/action", { json: { type: "set-voice", key: s.dataset.voice, value } }); if (!r.ok) throw new Error(r.message); }
    catch (e) { s.setAttribute("aria-checked", String(!value)); toast(e.message || "Couldn't change that.", true); }
  }));
  $("sign-out").addEventListener("click", async () => {
    if (PASS) await cloudApi("/cloud/push/unsubscribe", { installation: INSTALLATION }).catch(() => {});
    signedOut("", { full: true });
  });
  // Every phone, including this one: the Mac cancels its sessions and every cloud
  // pass; with the Mac off, the relay cancels the passes and tells the Mac later.
  let signoutArmed = 0;
  $("signout-all").addEventListener("click", async () => {
    const row = $("signout-all").querySelector(".grow");
    if (Date.now() - signoutArmed > 4000) { signoutArmed = Date.now(); row.textContent = "Tap again to sign out every phone"; setTimeout(() => (row.textContent = "Sign out every phone"), 4000); return; }
    signoutArmed = 0; row.textContent = "Sign out every phone";
    try {
      if (S && macOnline) await api("/signout-all", { json: {}, quiet: true });
      else await cloudApi("/cloud/signout-all", {});
    } catch (e) { toast(e.message || "Couldn't sign out every phone. Try again.", true); return; }
    signedOut("Every phone was signed out.", { full: true });
  });
  // Phone mode settings.
  const swAuto = $("sw-auto");
  swAuto.setAttribute("aria-checked", String(store.get("echo_autoswitch") === "on"));
  swAuto.addEventListener("click", () => {
    const on = swAuto.getAttribute("aria-checked") !== "true";
    store.set("echo_autoswitch", on ? "on" : null);
    swAuto.setAttribute("aria-checked", String(on));
    renderBanners();
  });
  const shortcutsIn = $("set-shortcuts");
  shortcutsIn.value = store.get("echo_shortcuts") || "";
  const saveShortcuts = () => store.set("echo_shortcuts", shortcutsIn.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20).join(", ") || null);
  shortcutsIn.addEventListener("change", saveShortcuts);
  shortcutsIn.addEventListener("blur", saveShortcuts);
  shortcutsIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); shortcutsIn.blur(); } });
  $("power-btn").addEventListener("click", () => openSheet("sheet-power"));
  $("po-confirm").addEventListener("click", async () => {
    try {
      const assertion = await faceIdConfirm();
      const r = await api("/action", { json: { type: "power-off", assertion } });
      closeSheets(); toast(r.message || "Echo is shutting down", !r.ok);
    } catch (e) {
      if (e && e.name === "NotAllowedError") return;
      toast(e && e.status === 409 ? "Turn on Face ID in Settings first." : (e && e.message) || "Couldn't power off.", true);
    }
  });
  $("version-line").textContent = `Echo Remote ${VERSION}`;

  // ---------- Snap & act ----------
  // Photograph a bill, receipt, ticket, letter, menu or product: Echo reads it
  // (one request), shows what it found, and offers the next step. The photo is
  // shrunk here (which also drops its location data) and never kept anywhere.
  let snapState = null, snapCtx = null, snapTimer = 0;
  const snapFile = $("snap-file");
  const KIND = { bill: "Bill", receipt: "Receipt", event: "Event", letter: "Letter", document: "Document", menu: "Menu", product: "Product", other: "Photo" };
  const CATS = ["Groceries", "Dining", "Transport", "Shopping", "Utilities", "Health", "Entertainment", "Travel", "Other"];
  const FIELDS = {
    bill: [["amount", "Amount", "number"], ["currency", "Currency", "text"], ["dueDate", "Due", "date"], ["payee", "Pay to", "text"]],
    receipt: [["amount", "Total", "number"], ["currency", "Currency", "text"], ["merchant", "Shop", "text"], ["purchaseDate", "Date", "date"], ["category", "Category", "cat"]],
    event: [["eventTitle", "Event", "text"], ["eventStart", "Starts", "datetime-local"], ["eventEnd", "Ends", "datetime-local"], ["location", "Place", "text"]],
    letter: [["sender", "From", "text"]],
    product: [["productName", "Product", "text"], ["price", "Price", "number"], ["currency", "Currency", "text"]],
  };
  function money(amount, currency) {
    if (amount == null) return "";
    try { if (currency) return new Intl.NumberFormat([], { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); } catch { /* unknown code */ }
    return `${amount.toLocaleString()}${currency ? ` ${currency}` : ""}`;
  }
  function openSnap() {
    if (!passValid()) return toast("Tap Get started to use Snap.", true);
    snapFile.value = "";
    snapFile.click();
  }
  $("act-screen").addEventListener("click", () => (mode === "phone" ? openSnapPage() : show("screen")));
  function openSnapPage() {
    if (!passValid()) return toast("Tap Get started to use Snap.", true);
    show("snap");
    renderSnap();
  }
  $("snap-chat").addEventListener("click", () => openSnap());
  $("snap-again").addEventListener("click", () => openSnap());
  snapFile.addEventListener("change", () => { const f = snapFile.files && snapFile.files[0]; if (f) readSnap(f); });
  async function shrink(file) {
    let pic;
    try { pic = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch {
      pic = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("That photo couldn't be opened.")); img.src = URL.createObjectURL(file); });
    }
    const k = Math.min(1, 1600 / Math.max(pic.width, pic.height));
    const c = document.createElement("canvas");
    c.width = Math.round(pic.width * k); c.height = Math.round(pic.height * k);
    c.getContext("2d").drawImage(pic, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("That photo couldn't be prepared.");
    return blob;
  }
  async function readSnap(file) {
    show("snap");
    if (snapState && snapState.url) URL.revokeObjectURL(snapState.url);
    snapState = { busy: true };
    renderSnap();
    try {
      const blob = await shrink(file);
      snapState.url = URL.createObjectURL(blob);
      renderSnap();
      const d = await cloudApi("/cloud/snap", { image: toBase64(await blob.arrayBuffer()), context: cloudContext() });
      Object.assign(snapState, { busy: false, id: d.id || null, result: d.snap, actions: d.actions || [] });
      if (d.usage && cloudInfo) cloudInfo.usage = d.usage;
    } catch (e) {
      Object.assign(snapState, { busy: false, error: e.status ? cloudProblem(e) : e.message || "That didn't work. Try again." });
    }
    renderSnap();
  }
  function snapLines(r) {
    const out = [`${r.title}: ${r.summary}`];
    for (const [k, label] of [...(FIELDS[r.kind] || []), ["account", "Account"]]) if (r[k] != null && r[k] !== "") out.push(`${label}: ${r[k]}`);
    for (const d of r.deadlines || []) out.push(`Deadline: ${d.date} — ${d.what}`);
    for (const d of r.keyDates || []) out.push(`Date: ${d.date} — ${d.what}`);
    if (r.text) out.push(`Text: ${r.text}`);
    return out.join("\n");
  }
  function renderSnap() {
    const box = $("snap-body");
    clear(box);
    const st = snapState || {};
    if (st.url) { const img = el("img", "snap-photo"); img.src = st.url; img.alt = "Your photo"; box.appendChild(img); }
    if (st.fromHistory) box.appendChild(el("p", "brief-date", `Scanned ${new Date(st.at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · ${clock(st.at)}`));
    if (st.busy) { const c = el("section", "glass bcard"); c.appendChild(el("p", "snap-busy", st.url ? "Reading your photo…" : "Preparing your photo…")); box.appendChild(c); }
    else if (st.error || (st.result && !st.result.readable)) {
      const c = el("section", "glass bcard");
      c.append(el("p", "", st.error || "I couldn't read that. Try closer, flatter, with more light."));
      const again = el("button", "cta big-btn", "Try another photo"); again.addEventListener("click", openSnap);
      c.appendChild(again); box.appendChild(c);
    } else if (st.result) {
      const r = st.result;
      const c = el("section", "glass bcard");
      c.append(el("span", "snap-kind", KIND[r.kind] || "Photo"), el("div", "snap-title", r.title), el("p", "sub small", r.summary));
      const fields = el("div", "snap-fields");
      for (const [key, label, type] of FIELDS[r.kind] || []) {
        const id = `sf-${key}`;
        const lab = el("label", "", label); lab.htmlFor = id;
        let input;
        if (type === "cat") {
          input = el("select");
          for (const cat of CATS) { const o = el("option", "", cat); o.value = cat; input.appendChild(o); }
          input.value = r.category || "Other";
        } else {
          input = el("input"); input.type = type; input.value = r[key] ?? "";
          if (type === "number") { input.inputMode = "decimal"; input.step = "any"; }
          if (key === "currency") { input.maxLength = 3; input.autocapitalize = "characters"; }
        }
        input.id = id;
        input.addEventListener("input", () => {
          const v = input.value.trim();
          r[key] = type === "number" ? (v === "" ? null : Number(v)) : key === "currency" ? (v.toUpperCase() || null) : (v || null);
          clearTimeout(snapTimer);
          snapTimer = setTimeout(refreshSnapActions, 450);
        });
        fields.append(lab, input);
      }
      if (r.account) fields.append(el("label", "", "Account"), el("span", "", `ends ${r.account}`));
      for (const d of r.deadlines || []) fields.append(el("label", "", "Deadline"), el("span", "", `${d.date} — ${d.what}`));
      for (const d of r.keyDates || []) if (!(r.deadlines || []).some((x) => x.date === d.date)) fields.append(el("label", "", "Date"), el("span", "", `${dayLabel(d.date)} — ${d.what}`));
      if (fields.childNodes.length) c.appendChild(fields);
      if (st.id) {
        const del = el("button", "text-btn", "Delete this scan");
        del.addEventListener("click", async () => {
          try { await cloudApi("/cloud/snaps/delete", { id: st.id }); snapState = null; toast("Scan deleted"); renderSnap(); } catch (e) { toast(cloudProblem(e), true); }
        });
        c.appendChild(del);
      }
      box.appendChild(c);
      if (r.translation) box.appendChild(bcard(`In English${r.language ? `, from ${r.language}` : ""}`, el("p", "small", r.translation)));
      box.appendChild(saveToMemoryButton());
      const handle = el("button", "cta big-btn", "Help me handle this");
      handle.addEventListener("click", () => { snapCtx = { snap: r, until: Date.now() + 20 * 60_000 }; mode = "phone"; store.set("echo_mode", "phone"); renderMode(); show("chat"); sendCloud("Help me handle this document. Explain what it means and the next practical step. Check any relevant saved context. Don't take external actions or create reminders until I've asked you to."); });
      box.appendChild(handle);
      const acts = el("div", "snap-acts"); acts.id = "snap-acts";
      box.appendChild(acts);
      renderSnapActions();
    } else {
      const c = el("section", "glass bcard");
      c.append(el("p", "", "Photograph a bill, receipt, ticket, letter, document, menu or price tag. Echo reads it, offers the next step, and can remember it for you."));
      const go = el("button", "cta big-btn", "Take or choose a photo"); go.addEventListener("click", openSnap);
      c.appendChild(go); box.appendChild(c);
    }
    const savedLink = el("button", "glass row mem-link");
    const sl = el("span", "grow"); sl.append(el("span", "", "Saved"), el("span", "sub tiny", "What Echo remembers for you, and its dates"));
    savedLink.append(el("span", "scan-badge note", "MEM"), sl, el("span", "sub", "›"));
    savedLink.addEventListener("click", () => openMemory({ from: "snap" }));
    box.appendChild(savedLink);
    const hist = el("section", "glass bcard"); hist.id = "snap-history"; box.appendChild(hist);
    const exp = el("section", "glass bcard"); exp.id = "snap-expenses"; box.appendChild(exp);
    loadScans();
    loadExpenses();
  }
  /** Save what this scan found to Echo's memory; once saved, the button opens it there. */
  function saveToMemoryButton() {
    const st = snapState;
    const btn = el("button", `glass big-btn mem-save${st.saved ? " done" : ""}`, st.saved ? "Saved to memory ✓ · Open" : "Save to memory");
    btn.addEventListener("click", async () => {
      if (st.saved) return openMemory({ id: st.saved, from: "snap" });
      btn.setAttribute("aria-busy", "true");
      try {
        const d = await cloudApi("/cloud/memory/save", { ...(st.id ? { snapId: st.id } : {}), snap: st.result, tz: localTz() });
        st.saved = d.item.id;
        const nd = nextDate(d.item);
        toast(nd ? `Saved. Echo will remind you before ${dayLabel(nd.date)}.` : "Saved. Echo will remember it.");
        btn.textContent = "Saved to memory ✓ · Open"; btn.classList.add("done");
        loadScans();
      } catch (e) { toast(cloudProblem(e), true); }
      finally { btn.removeAttribute("aria-busy"); }
    });
    return btn;
  }
  function renderSnapActions() {
    const acts = $("snap-acts");
    if (!acts || !snapState || !snapState.actions) return;
    clear(acts);
    snapState.actions.forEach((a, i) => {
      a.snapId = snapState.id || null;
      const day = (local) => { const d = new Date(local); return isNaN(d) ? local : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); };
      const label = a.type === "reminder" && /^Remind me (on|today)/.test(a.label) ? `Remind me ${day(a.data.start)}, 9:00` : a.label;
      const done = a.done && a.type === "expense" ? `Saved · ${money(a.data.amount, a.data.currency)}` : a.done ? `Reminder set · ${eventWhen(a.data.start)}` : label;
      const btn = el("button", `${i === 0 ? "cta" : "glass"} big-btn${a.done ? " done" : ""}`, done);
      btn.addEventListener("click", () => runSnapAction(a, btn));
      acts.appendChild(btn);
    });
  }
  async function refreshSnapActions() {
    if (!snapState || !snapState.result) return;
    try {
      const d = await cloudApi("/cloud/snap/actions", { snap: snapState.result, tz: localTz(), ...(snapState.id ? { id: snapState.id } : {}) });
      const was = new Map((snapState.actions || []).filter((a) => a.done).map((a) => [a.type, true]));
      snapState.actions = d.actions.map((a) => ({ ...a, done: was.get(a.type) || false }));
      renderSnapActions();
      // Already saved: the saved copy follows the correction.
      if (snapState.saved) cloudApi("/cloud/memory/update", { id: snapState.saved, snap: snapState.result, tz: localTz() }).catch(() => {});
    } catch { /* the old buttons stay */ }
  }
  async function runSnapAction(a, btn) {
    if (a.type === "calendar" || a.type === "reminder" || a.type === "mac") return runAction(a, btn);
    if (a.type === "expense") {
      if (a.done) return toast("Already saved.");
      btn.setAttribute("aria-busy", "true");
      try {
        await cloudApi("/cloud/expenses", { expense: a.data, tz: localTz() });
        a.done = true;
        if (a.snapId) cloudApi("/cloud/snaps/done", { id: a.snapId, type: "expense" }).catch(() => {});
        btn.textContent = `Saved · ${money(a.data.amount, a.data.currency)}`;
        toast(`Saved: ${money(a.data.amount, a.data.currency)} · ${a.data.category}`);
        loadExpenses();
      } catch (e) { toast(cloudProblem(e), true); }
      finally { btn.removeAttribute("aria-busy"); }
      return;
    }
    if (a.type === "ask") {
      const r = snapState.result;
      snapCtx = { snap: r, until: Date.now() + 15 * 60_000 };
      show("chat");
      if (!a.data.prompt) { input.placeholder = "Ask about your photo"; input.focus(); return; }
      // Phone mode carries the photo's details itself; the Mac gets them in the message.
      sendChat(mode === "phone" ? a.data.prompt : `${a.data.prompt}\n\n(About a photo I took — ${snapLines(r)})`);
    }
  }
  const KIND_SHORT = { bill: "BILL", receipt: "RCPT", event: "EVT", letter: "LTR", document: "DOC", menu: "MENU", product: "ITEM", other: "PIC" };
  async function loadScans() {
    const box = $("snap-history");
    if (!box || !passValid()) return;
    try {
      const d = await cloudApi("/cloud/snaps");
      clear(box);
      box.appendChild(el("h3", "", "Your scans"));
      if (!d.items.length) { box.appendChild(el("p", "sub small", "Scans you take show up here, with what Echo found. Photos aren't kept.")); return; }
      for (const it of d.items.slice(0, 30)) {
        const row = el("button", `scan-row${snapState && snapState.id === it.id ? " on" : ""}`);
        const t = el("span", "grow");
        const what = it.amount != null ? money(it.amount, it.currency) : it.date ? eventWhen(it.date) : it.summary;
        t.append(el("span", "clamp1", it.title), el("span", "sub tiny clamp1", `${what || ""}${what ? " · " : ""}${ago(it.at)}${it.saved ? " · saved" : ""}`));
        row.append(el("span", "scan-badge", KIND_SHORT[it.kind] || "PIC"), t);
        row.addEventListener("click", () => openScan(it.id));
        box.appendChild(row);
      }
    } catch { box.hidden = true; }
  }
  async function openScan(id) {
    try {
      const d = await cloudApi(`/cloud/snaps?id=${encodeURIComponent(id)}&tz=${encodeURIComponent(localTz())}`);
      if (snapState && snapState.url) URL.revokeObjectURL(snapState.url);
      snapState = { id: d.id, at: d.at, result: d.snap, actions: d.actions, fromHistory: true, saved: d.saved || null };
      renderSnap();
      document.querySelector("#v-snap .scroll").scrollTop = 0;
    } catch (e) { toast(cloudProblem(e), true); }
  }
  async function loadExpenses() {
    const box = $("snap-expenses");
    if (!box || !passValid()) return;
    try {
      const d = await cloudApi("/cloud/expenses");
      clear(box);
      box.appendChild(el("h3", "", "This month"));
      const totals = Object.entries(d.totals || {}).map(([c, v]) => money(v, c === "?" ? null : c)).join(" + ");
      box.appendChild(el("div", "big", totals || "No expenses yet"));
      if (d.count) box.appendChild(el("p", "fine", `${d.count} expense${d.count === 1 ? "" : "s"} saved from snaps`));
      for (const x of (d.items || []).slice(0, 5)) {
        const row = el("div", "exp-row");
        row.append(el("span", "t", x.date.slice(5)), el("span", "grow", `${x.merchant} · ${x.category}`), el("b", "", money(x.amount, x.currency)));
        const del = el("button", "", "✕"); del.setAttribute("aria-label", `Delete ${x.merchant}`);
        del.addEventListener("click", async () => { try { await cloudApi("/cloud/expenses/delete", { id: x.id }); loadExpenses(); } catch (e) { toast(cloudProblem(e), true); } });
        row.appendChild(del);
        box.appendChild(row);
      }
    } catch { box.hidden = true; }
  }

  // ---------- Saved: Echo's memory ----------
  // What the user saved for Echo to remember: what a snap found (never the
  // photo) or a note in their own words. Search works by meaning, and every
  // date in a saved item becomes a reminder 7 days and 1 day before.
  const GROUP_SHORT = { Bills: "BILL", Receipts: "RCPT", Events: "EVT", Documents: "DOC", Notes: "NOTE", Other: "PIC" };
  const GROUP_ORDER = ["Bills", "Documents", "Receipts", "Events", "Notes", "Other"];
  let mem = { items: [], upcoming: [], filter: "All", q: "", results: null, open: null, from: "home", dirty: false };
  let memSearchTimer = 0, memLoaded = false;
  const dayLabel = (ymd) => { const d = new Date(`${ymd}T12:00:00`); return isNaN(d) ? ymd : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); };
  const inDays = (n) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
  function nextDate(item) {
    const today = new Date().toLocaleDateString("en-CA");
    return (item.dates || []).find((d) => d.date >= today) || null;
  }
  function openMemory({ id = null, from = null } = {}) {
    if (!passValid()) return toast("Tap Get started to use Saved.", true);
    if (currentView !== "memory") mem.from = from || currentView;
    mem.open = null;
    show("memory");
    renderMemory();
    loadMemory().then(() => { if (id) openMemItem(id); });
  }
  $("mem-back").addEventListener("click", () => {
    if (mem.open) { mem.open = null; renderMemory(); return; }
    show(mem.from && mem.from !== "memory" ? mem.from : lastTab);
    if (mem.from === "snap") renderSnap();
  });
  $("mem-new").addEventListener("click", () => openMemNote());
  async function loadMemory() {
    try {
      const d = await cloudApi(`/cloud/memory?tz=${encodeURIComponent(localTz())}`);
      mem.items = d.items || []; mem.upcoming = d.upcoming || [];
      memLoaded = true;
      if (!mem.open) renderMemory();
    } catch (e) { toast(cloudProblem(e), true); }
  }
  function memRow(it, { score } = {}) {
    const row = el("button", "scan-row");
    const t = el("span", "grow");
    const nd = nextDate(it);
    const sub = nd ? `${nd.what} · ${dayLabel(nd.date)}` : it.summary || "";
    t.append(el("span", "clamp1", it.title), el("span", "sub tiny clamp1", `${sub}${sub ? " · " : ""}saved ${ago(it.at)}`));
    row.append(el("span", `scan-badge${it.group === "Notes" ? " note" : ""}`, GROUP_SHORT[it.group] || "PIC"), t);
    if (score != null && score < 0.62) row.classList.add("weak");
    row.addEventListener("click", () => openMemItem(it.id));
    return row;
  }
  function renderMemory() {
    const box = $("mem-body");
    clear(box);
    $("mem-h").textContent = mem.open ? (mem.open.item.group || "Saved") : "Saved";
    $("mem-new").hidden = !!mem.open;
    if (mem.open) return renderMemItem(box);
    const field = el("div", "glass field");
    const q = el("input"); q.type = "search"; q.placeholder = "Search what you saved"; q.value = mem.q; q.enterKeyHint = "search";
    q.setAttribute("aria-label", "Search what you saved");
    q.addEventListener("input", () => {
      mem.q = q.value;
      clearTimeout(memSearchTimer);
      if (mem.q.trim().length < 2) { mem.results = null; renderMemList(); return; }
      memSearchTimer = setTimeout(searchMemory, 450);
    });
    field.appendChild(q);
    box.appendChild(field);
    const list = el("div", "mem-list"); list.id = "mem-list";
    box.appendChild(list);
    renderMemList();
  }
  async function searchMemory() {
    const q = mem.q.trim();
    if (q.length < 2) return;
    try {
      const d = await cloudApi("/cloud/memory/search", { q });
      if (mem.q.trim() !== q) return; // typed on since
      mem.results = d.items || [];
      renderMemList();
    } catch (e) { toast(cloudProblem(e), true); }
  }
  function renderMemList() {
    const list = $("mem-list");
    if (!list) return;
    clear(list);
    if (mem.results) {
      const c = el("section", "glass bcard");
      c.appendChild(el("h3", "", mem.results.length ? "Best matches" : "No matches"));
      if (!mem.results.length) c.appendChild(el("p", "sub small", "Nothing you saved matches that. Try other words."));
      for (const it of mem.results) c.appendChild(memRow(it, { score: it.score }));
      list.appendChild(c);
      return;
    }
    if (!memLoaded) { const c = el("section", "glass bcard"); c.appendChild(el("p", "sub small", "Loading what you saved…")); list.appendChild(c); return; }
    if (!mem.items.length) {
      const c = el("section", "glass bcard");
      c.append(el("p", "", "Nothing saved yet."), el("p", "sub small", "Snap a bill, letter, ticket or document and tap Save to memory, or tap + to write something down. Echo remembers it, finds it when you ask, and reminds you of its dates."));
      const go = el("button", "cta big-btn", "Write something to remember"); go.addEventListener("click", () => openMemNote());
      c.appendChild(go);
      list.appendChild(c);
      return;
    }
    if (mem.upcoming.length) {
      const c = el("section", "glass bcard");
      c.appendChild(el("h3", "", "Coming up"));
      for (const u of mem.upcoming.slice(0, 5)) {
        const row = el("button", "up-row");
        row.append(el("span", "t", inDays(u.days)), el("span", "grow clamp1", `${u.what} · ${u.title}`));
        row.addEventListener("click", () => openMemItem(u.item));
        c.appendChild(row);
      }
      list.appendChild(c);
    }
    const groups = GROUP_ORDER.filter((g) => mem.items.some((x) => x.group === g));
    if (groups.length > 1) {
      const chips = el("div", "glass seg mem-seg"); chips.setAttribute("role", "tablist");
      for (const g of ["All", ...groups]) {
        const b = el("button", "", g); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(mem.filter === g));
        b.addEventListener("click", () => { mem.filter = g; renderMemList(); });
        chips.appendChild(b);
      }
      list.appendChild(chips);
    }
    if (!groups.includes(mem.filter)) mem.filter = "All";
    for (const g of groups.filter((x) => mem.filter === "All" || x === mem.filter)) {
      const c = el("section", "glass bcard");
      c.appendChild(el("h3", "", g));
      for (const it of mem.items.filter((x) => x.group === g)) c.appendChild(memRow(it));
      list.appendChild(c);
    }
    list.appendChild(el("p", "fine center", `${mem.items.length} saved · Echo finds them when you ask, in Phone mode`));
  }
  async function openMemItem(id) {
    try {
      const d = await cloudApi(`/cloud/memory?id=${encodeURIComponent(id)}`);
      mem.open = { item: d.item, body: d.body || {} };
      mem.dirty = false;
      if (currentView !== "memory") { mem.from = currentView; show("memory"); }
      renderMemory();
      document.querySelector("#v-memory .scroll").scrollTop = 0;
    } catch (e) { toast(cloudProblem(e), true); if (e.status === 404) loadMemory(); }
  }
  async function updateMemItem(patch, { quiet = false } = {}) {
    const o = mem.open;
    if (!o) return null;
    try {
      const d = await cloudApi("/cloud/memory/update", { id: o.item.id, tz: localTz(), ...patch });
      o.item = d.item;
      const i = mem.items.findIndex((x) => x.id === d.item.id);
      if (i >= 0) mem.items[i] = d.item;
      if (!quiet) toast("Saved");
      loadMemory();
      return d.item;
    } catch (e) { toast(cloudProblem(e), true); return null; }
  }
  function renderMemItem(box) {
    const { item, body } = mem.open;
    const c = el("section", "glass bcard");
    c.appendChild(el("span", "snap-kind", item.source === "note" ? "Note" : KIND[item.kind] || "Saved"));
    const title = el("input", "mem-title"); title.value = item.title; title.maxLength = 80; title.setAttribute("aria-label", "Title");
    c.appendChild(title);
    let text = null;
    if (item.source === "note") {
      text = el("textarea", "glass ho-text"); text.value = body.text || item.summary; text.maxLength = 2000; text.setAttribute("aria-label", "What Echo remembers");
      c.appendChild(text);
    } else if (body.snap) {
      if (item.summary) c.appendChild(el("p", "sub small", item.summary));
      const fields = el("div", "snap-fields");
      for (const [k, label] of [...(FIELDS[body.snap.kind] || []), ["account", "Account"]]) {
        const v = body.snap[k];
        if (v == null || v === "" || k === "currency") continue;
        fields.append(el("label", "", label), el("span", "", k === "amount" || k === "price" ? money(v, body.snap.currency) : k === "account" ? `ends ${v}` : k === "eventStart" || k === "eventEnd" ? eventWhen(v) : v));
      }
      if (fields.childNodes.length) c.appendChild(fields);
    }
    const save = el("button", "cta big-btn", "Save changes"); save.hidden = true;
    const dirty = () => { save.hidden = !(title.value.trim() && (title.value.trim() !== item.title || (text && text.value.trim() !== (body.text || "").trim()))); };
    title.addEventListener("input", dirty);
    if (text) text.addEventListener("input", dirty);
    save.addEventListener("click", async () => {
      save.setAttribute("aria-busy", "true");
      const patch = { title: title.value.trim(), ...(text ? { text: text.value } : {}) };
      const done = await updateMemItem(patch);
      save.removeAttribute("aria-busy");
      if (done) { if (text) mem.open.body.text = text.value.trim(); renderMemory(); }
    });
    c.appendChild(save);
    box.appendChild(c);
    if (body.snap && (body.snap.text || body.snap.translation)) {
      box.appendChild(bcard(body.snap.translation ? `In English${body.snap.language ? `, from ${body.snap.language}` : ""}` : "What it says", el("p", "small pre", body.snap.translation || body.snap.text)));
    }
    // Dates, and their reminders.
    const dc = el("section", "glass bcard");
    dc.appendChild(el("h3", "", "Dates"));
    if (!item.dates.length) dc.appendChild(el("p", "sub small", "No dates. Add one to be reminded before it."));
    for (const d of item.dates) {
      const row = el("div", "exp-row");
      row.append(el("span", "t", dayLabel(d.date)), el("span", "grow", d.what));
      const x = el("button", "", "✕"); x.setAttribute("aria-label", `Remove ${d.what}`);
      x.addEventListener("click", async () => { if (await updateMemItem({ dates: item.dates.filter((y) => y !== d) }, { quiet: true })) renderMemory(); });
      row.appendChild(x);
      dc.appendChild(row);
    }
    const add = el("div", "mem-add");
    const di = el("input"); di.type = "date"; di.setAttribute("aria-label", "Date");
    const wi = el("input"); wi.placeholder = "What happens then"; wi.maxLength = 100; wi.setAttribute("aria-label", "What happens then");
    const ab = el("button", "glass small-pill", "Add");
    ab.addEventListener("click", async () => {
      if (!di.value || !wi.value.trim()) return toast("Pick a date and say what happens then.", true);
      if (await updateMemItem({ dates: [...item.dates, { date: di.value, what: wi.value.trim() }] }, { quiet: true })) { toast("Date added"); renderMemory(); }
    });
    add.append(di, wi, ab);
    dc.appendChild(add);
    const sw = el("button", "row mem-switch"); sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", String(item.remind !== false));
    const swText = el("span", "grow"); swText.append(el("span", "", "Remind me"), el("span", "sub tiny", briefInfo && briefInfo.subscribed ? "7 days and 1 day before, at 9:00" : "Turn on Briefing and reminders in Settings to get them"));
    const track = el("span", "track"); track.appendChild(el("span", "knob"));
    sw.append(swText, track);
    sw.addEventListener("click", async () => { if (await updateMemItem({ remind: item.remind === false }, { quiet: true })) renderMemory(); });
    dc.appendChild(sw);
    box.appendChild(dc);
    const ask = el("button", "glass big-btn", "Ask Echo about it");
    ask.addEventListener("click", () => {
      if (body.snap) snapCtx = { snap: body.snap, until: Date.now() + 15 * 60_000 };
      show("chat");
      restoreInput(mode === "phone" ? `About "${item.title}" that I saved: ` : `About "${item.title}" that I saved (${item.summary}): `);
      input.focus();
    });
    box.appendChild(ask);
    const del = el("button", "text-btn center", "Delete from memory");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${item.title}"? Echo will forget it and its reminders.`)) return;
      try {
        await cloudApi("/cloud/memory/delete", { id: item.id, tz: localTz() });
        if (snapState && snapState.saved === item.id) snapState.saved = null;
        mem.items = mem.items.filter((x) => x.id !== item.id);
        mem.open = null; toast("Deleted"); renderMemory(); loadMemory();
      } catch (e) { toast(cloudProblem(e), true); }
    });
    box.appendChild(del);
    box.appendChild(el("p", "fine center", `Saved ${new Date(item.at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} · ${item.source === "note" ? "your words" : "from a snap, without the photo"}${item.indexed ? "" : " · search by meaning comes shortly"}`));
  }

  // Writing something down for Echo: from + on Saved, or from a chat message.
  function openMemNote(text = "") {
    if (!passValid()) return toast("Tap Get started to use Saved.", true);
    $("mn-text").value = text; $("mn-date").value = ""; $("mn-what").value = "";
    $("mn-save").disabled = !text.trim();
    openSheet("sheet-memnote");
    if (!text) setTimeout(() => $("mn-text").focus(), 250);
  }
  $("mn-text").addEventListener("input", () => { $("mn-save").disabled = !$("mn-text").value.trim(); });
  $("mn-save").addEventListener("click", async () => {
    const text = $("mn-text").value.trim(), date = $("mn-date").value, what = $("mn-what").value.trim();
    if (!text) return;
    if (what && !date) return toast("Pick the date too, or clear what happens then.", true);
    const btn = $("mn-save"); btn.setAttribute("aria-busy", "true");
    try {
      const d = await cloudApi("/cloud/memory/save", { note: { text, dates: date ? [{ date, what: what || text.split("\n")[0].slice(0, 100) }] : [] }, tz: localTz() });
      closeSheets();
      toast(d.item.dates.length ? `Saved. Echo will remind you before ${dayLabel(d.item.dates[0].date)}.` : "Saved. Echo will remember it.");
      if (currentView === "memory") loadMemory();
    } catch (e) { toast(cloudProblem(e), true); }
    finally { btn.removeAttribute("aria-busy"); }
  });

  // ---------- Browser ----------
  // Web pages come through the relay with their scripts taken out
  // (lib/browse.js), so they load in this frame on the app's own address: the
  // app can read and click them, and they can't run anything. You browse;
  // "Ask Echo" hands the page to Echo, which reads it as text with every link,
  // button and field numbered, picks one action at a time (lib/browse-agent.js)
  // and waits for your tap before anything that pays, sends, submits or deletes.
  const brFrame = $("br-frame");
  const PART = 12_000;
  const br = { session: 0, url: "", title: "", back: [], fwd: [], nav: null, loading: false, run: null, snap: null, waiters: [] };
  const RECENT_KEY = "echo_br_recent";
  const b64u = (s) => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const pagePath = (url) => `/b/p/${b64u(url)}`;
  const realUrl = (href) => {
    try {
      const m = /\/b\/[prgf]\/([A-Za-z0-9_-]+)/.exec(new URL(href, location.origin).pathname);
      if (!m) return null;
      const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch { return null; }
  };
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  function frameDoc() { try { return brFrame.contentDocument; } catch { return null; } }

  async function browserSession(force = false) {
    if (!force && br.session - Date.now() > 30 * 60_000) return;
    const d = await cloudApi("/cloud/browse/session", {});
    br.session = d.until;
  }
  async function openBrowser() {
    renderBrowserBar();
    if (!passValid()) { renderStart("Tap Get started to use the Browser."); return; }
    if (!br.url && !br.loading) renderStart();
    try { await browserSession(); } catch (e) { toast(cloudProblem(e), true); }
  }
  function renderStart(problem = "") {
    const box = $("br-start");
    clear(box);
    box.hidden = false;
    brFrame.hidden = true;
    box.appendChild(el("h2", "", "Echo's Browser"));
    box.appendChild(el("p", "sub small", problem || "Search or open a site above. Ask Echo to finish what you started, or give it a whole job: \"compare these three laptops\", \"find a table for two on Friday\"."));
    if (problem) return;
    const quick = el("div", "br-quick");
    for (const [label, url] of [["Bing", "https://www.bing.com/"], ["Wikipedia", "https://en.m.wikipedia.org/"], ["BBC News", "https://www.bbc.com/news"], ["Hacker News", "https://news.ycombinator.com/"]]) {
      const b = el("button", "glass chip", label); b.addEventListener("click", () => goTo(url)); quick.appendChild(b);
    }
    box.appendChild(quick);
    let recent = [];
    try { recent = JSON.parse(store.get(RECENT_KEY) || "[]"); } catch { recent = []; }
    if (recent.length) {
      box.appendChild(el("p", "group-title", "Recent"));
      const list = el("div", "glass list");
      for (const r of recent.slice(0, 8)) {
        const row = el("button", "row");
        const t = el("span", "grow"); t.append(el("span", "clamp1", r.title || hostOf(r.url)), el("span", "sub tiny clamp1", hostOf(r.url)));
        row.appendChild(t); row.addEventListener("click", () => goTo(r.url));
        list.appendChild(row);
      }
      box.appendChild(list);
    }
    box.appendChild(el("p", "sub tiny br-note", "Pages open without their scripts, so app-like sites may not work: ⋯ → Open the real page for those. Sign in to banks and payment sites in your normal browser."));
  }
  function remember(url, title) {
    let recent = [];
    try { recent = JSON.parse(store.get(RECENT_KEY) || "[]"); } catch { recent = []; }
    recent = [{ url, title }, ...recent.filter((r) => r.url !== url)].slice(0, 12);
    store.set(RECENT_KEY, JSON.stringify(recent));
  }
  let stallTimer = 0;
  /** Loading: the bar runs; a page that hasn't come after 25 s says so, with Retry and Open the real page. */
  function setLoading(on) {
    br.loading = on;
    $("br-progress").classList.toggle("on", on);
    clearTimeout(stallTimer);
    $("br-stage").querySelector(".br-stall")?.remove();
    if (on) stallTimer = setTimeout(showStall, 25_000);
  }
  function showStall() {
    if (!br.loading) return;
    const box = el("div", "glass br-stall");
    box.append(el("b", "", "This page isn't loading"), el("p", "sub small", "The site may be slow, or it may not work without its scripts."));
    const row = el("div", "btns2");
    const retry = el("button", "cta big-btn", "Retry");
    retry.addEventListener("click", () => { box.remove(); if (br.pending) loadPath(br.pending); else if (br.url) loadPath(pagePath(br.url), "reload"); });
    const safari = el("button", "glass big-btn", "Open the real page");
    safari.addEventListener("click", () => openReal(br.pendingUrl || br.url));
    row.append(safari, retry);
    box.appendChild(row);
    $("br-stage").appendChild(box);
  }
  function renderBrowserBar() {
    const u = $("br-url");
    if (document.activeElement !== u) u.value = br.url ? hostOf(br.url) + (new URL(br.url).pathname.length > 1 ? new URL(br.url).pathname : "") : "";
    $("br-back").disabled = !br.back.length;
    $("br-fwd").disabled = !br.fwd.length;
  }
  /** Load a page in the frame. `how`: "go" (a new page), "back", "fwd", "reload". */
  async function loadPath(path, how = "go") {
    try { await browserSession(); } catch (e) { toast(cloudProblem(e), true); return; }
    br.nav = how;
    br.pending = path;
    br.pendingUrl = realUrl(path) || null;
    setLoading(true);
    $("br-start").hidden = true; brFrame.hidden = false;
    brFrame.contentWindow ? brFrame.contentWindow.location.replace(path) : (brFrame.src = path);
  }
  const goTo = (url) => loadPath(pagePath(url));
  const goInput = (text, search = false) => loadPath(`/b/go?q=${encodeURIComponent(text)}${search ? "&search=1" : ""}`);
  brFrame.addEventListener("load", () => {
    const doc = frameDoc();
    if (!doc || brFrame.hidden) return;
    if (doc.querySelector('meta[name="echo-auth"]')) {
      // The session cookie ran out: renew it and load the page again, once.
      if (br.nav !== "renew") { br.nav = "renew"; browserSession(true).then(() => brFrame.contentWindow.location.reload()).catch(() => setLoading(false)); }
      return;
    }
    const url = doc.querySelector('meta[name="echo-url"]')?.content || realUrl(brFrame.contentWindow.location.href) || "";
    if (url && url !== br.url) {
      if (br.nav === "back") br.fwd.push(br.url);
      else if (br.nav === "fwd") br.back.push(br.url);
      else if (br.url) { br.back.push(br.url); br.fwd = []; }
      br.back = br.back.slice(-50);
    }
    br.nav = null;
    br.pending = null; br.pendingUrl = null;
    br.url = url;
    // A site that refused Echo's Browser (403, 429, 5xx, or couldn't be reached): Echo won't try it again this task.
    br.status = doc.querySelector('meta[name="echo-status"]')?.content || null;
    if (br.status && br.run && hostOf(url)) br.run.blocked = [...new Set([...(br.run.blocked || []), hostOf(url)])].slice(-20);
    br.title = doc.title || hostOf(url);
    setLoading(false);
    renderBrowserBar();
    if (url) remember(url, br.title);
    br.doc = doc;
    const refresh = doc.querySelector('meta[name="echo-refresh"]')?.content;
    if (refresh && refresh.startsWith("/b/p/") && !br.run) setTimeout(() => { if (frameDoc() === doc) loadPath(refresh); }, 1200);
    const waiters = br.waiters; br.waiters = [];
    for (const w of waiters) w();
  });
  // A link or form tapped inside the page: Safari won't run the app's listeners
  // in a page that may not run scripts, so watch for the next page arriving instead.
  setInterval(() => {
    if (currentView !== "browser" || brFrame.hidden || br.loading) return;
    const doc = frameDoc();
    if (doc && br.doc && doc !== br.doc && doc.readyState !== "complete") setLoading(true);
  }, 250);
  $("br-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("br-url").value.trim();
    if (!v) return;
    $("br-url").blur();
    goInput(v);
  });
  $("br-url").addEventListener("focus", () => { if (br.url) { $("br-url").value = br.url; setTimeout(() => $("br-url").select(), 0); } });
  $("br-url").addEventListener("blur", () => setTimeout(renderBrowserBar, 0));
  $("br-back").addEventListener("click", () => { if (br.back.length) loadPath(pagePath(br.back.pop()), "back"); });
  $("br-fwd").addEventListener("click", () => { if (br.fwd.length) loadPath(pagePath(br.fwd.pop()), "fwd"); });
  $("br-reload").addEventListener("click", () => { if (br.url) loadPath(pagePath(br.url), "reload"); });
  $("br-more").addEventListener("click", () => openSheet("sheet-bmore"));
  /** The real page, scripts and all: Safari from a Home Screen app, a new tab in a browser (Chrome or Safari). */
  function openReal(url) {
    if (!url) return toast("Open a page first.");
    if (standalone) location.href = `x-safari-${url}`;
    else {
      // (With "noopener" the browser reports no window even when it opened one, so cut the link by hand.)
      const w = window.open(url, "_blank");
      if (w) w.opener = null; else location.href = url;
    }
  }
  $("bm-safari").addEventListener("click", () => { closeSheets(); openReal(br.url); });
  $("bm-copy").addEventListener("click", async () => { closeSheets(); try { await navigator.clipboard.writeText(br.url); toast("Copied"); } catch { toast("Couldn't copy.", true); } });
  $("bm-start").addEventListener("click", () => { closeSheets(); br.url = ""; brFrame.hidden = true; brFrame.contentWindow && brFrame.contentWindow.location.replace("about:blank"); renderBrowserBar(); renderStart(); });
  async function clearSites() {
    if (!confirm("Sign out of every website in Echo's Browser?")) return;
    try { await cloudApi("/cloud/browse/clear", {}); toast("Signed out of all websites"); } catch (e) { toast(cloudProblem(e), true); }
  }
  $("bm-clear").addEventListener("click", () => { closeSheets(); clearSites(); });
  $("br-clear").addEventListener("click", clearSites);

  // ----- the page as Echo sees it -----
  const INTERACTIVE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=switch], [role=radio]";
  const BLOCK = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|UL|OL|TABLE|FORM|FIELDSET|BR|HR|DT|DD|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION|DETAILS)$/;
  const SKIP = /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE|HEAD|SVG|CANVAS|IFRAME|OBJECT)$/;
  const tidy = (t, n = 80) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  /** Fields Echo never types into: passwords, cards, codes, ID numbers. */
  function secretField(e) {
    const hint = `${e.type || ""} ${e.name || ""} ${e.id || ""} ${e.autocomplete || ""} ${e.placeholder || ""} ${e.getAttribute("aria-label") || ""}`.toLowerCase();
    return e.type === "password" || /cc-|card|cvv|cvc|security.?code|iban|pin\b|one-time|otp|passcode|ssn|passport|tax.?id/.test(hint);
  }
  /** What an element says, for the user: its text, value, label or image. */
  const elLabel = (e) => tidy(e.innerText || e.value || e.getAttribute("aria-label") || e.querySelector?.("img[alt]")?.alt || e.title || labelFor(e, frameDoc())
    || (e.href && realUrl(e.href) ? `the link to ${realUrl(e.href).replace(/^https?:\/\/(www\.)?/, "")}` : "") || "", 60) || "this";
  function labelFor(e, doc) {
    const aria = e.getAttribute("aria-label") || e.getAttribute("title");
    if (aria) return aria;
    if (e.id) { const l = doc.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l) return l.textContent; }
    const wrap = e.closest("label");
    if (wrap) return wrap.textContent;
    return e.getAttribute("placeholder") || e.name || "";
  }
  function describe(e, doc) {
    const tag = e.tagName;
    if (tag === "A") {
      const text = tidy(e.innerText || e.getAttribute("aria-label") || e.querySelector("img[alt]")?.alt || e.title, 90) || "link";
      const to = realUrl(e.href);
      return `<link>${text}</link>${to ? ` (${tidy(to.replace(/^https?:\/\/(www\.)?/, ""), 70)})` : ""}`;
    }
    if (tag === "SELECT") {
      const opts = [...e.options].slice(0, 14).map((o) => tidy(o.text, 30));
      return `<select "${tidy(labelFor(e, doc), 50)}" chosen="${tidy(e.selectedOptions[0]?.text, 40)}" options: ${opts.join(" | ")}${e.options.length > 14 ? " | …" : ""}>`;
    }
    if (tag === "TEXTAREA") return `<textarea "${tidy(labelFor(e, doc), 60)}" value="${tidy(e.value, 80)}">`;
    if (tag === "INPUT") {
      const type = (e.type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) return `<button>${tidy(e.value || e.alt || labelFor(e, doc), 60) || "submit"}</button>`;
      if (type === "checkbox" || type === "radio") return `<${type} "${tidy(labelFor(e, doc), 60)}"${e.checked ? " checked" : ""}>`;
      if (secretField(e)) return `<input type=${type} "${tidy(labelFor(e, doc), 50)}" — the user types this themselves>`;
      return `<input type=${type} "${tidy(labelFor(e, doc), 60)}" value="${tidy(e.value, 80)}">`;
    }
    return `<button>${tidy(e.innerText || e.getAttribute("aria-label") || e.title, 80) || "button"}</button>`;
  }
  /**
   * A search engine's results page as a clean, numbered list: title, address,
   * snippet. The rest of such a page is menus, filters and ads, which is what
   * made Echo search again and again instead of opening a result.
   */
  function searchResults(doc) {
    let u;
    try { u = new URL(br.url); } catch { return null; }
    if (!/(^|\.)bing\.com$/.test(u.hostname) || !u.pathname.startsWith("/search")) return null;
    const items = [];
    for (const li of doc.querySelectorAll("li.b_algo")) {
      const link = li.querySelector(".b_algoheader a[href], h2 a[href]") || li.querySelector("a[href]");
      const to = link && realUrl(link.href);
      if (!to || /(^|\.)bing\.com$/.test(hostOf(to))) continue;
      const snippet = li.querySelector(".b_caption p, p");
      items.push({ link, title: tidy(link.innerText || to, 120), url: to, snippet: tidy(snippet && snippet.innerText, 220) });
      if (items.length >= 10) break;
    }
    if (!items.length) return null;
    const next = doc.querySelector("a.sb_pagN[href], a[aria-label='Next page'][href], a[title='Next page'][href]");
    return { query: u.searchParams.get("q") || "", items, next };
  }
  function pageSnapshot() {
    const doc = frameDoc();
    if (!doc || !doc.body || brFrame.hidden) return { text: "", elements: [] };
    const results = searchResults(doc);
    if (results) {
      const elements = [];
      const lines = [`Search results for "${results.query}" (only the results are shown; the rest of this page is menus and ads):`];
      for (const r of results.items) {
        elements.push(r.link);
        const blocked = br.run && (br.run.blocked || []).includes(hostOf(r.url));
        lines.push(`[${elements.length}]<link>${r.title}</link> — ${r.url}${blocked ? " (this site blocks Echo's Browser: skip it)" : ""}${r.snippet ? `\n    ${r.snippet}` : ""}`);
      }
      if (results.next) { elements.push(results.next); lines.push(`[${elements.length}]<link>Next page of results</link>`); }
      return { text: lines.join("\n"), elements };
    }
    const win = brFrame.contentWindow;
    const elements = [], out = [];
    if (br.status) out.push(`(This site answered ${br.status === "error" ? "with an error" : br.status}${br.status === "403" ? " Forbidden" : br.status === "429" ? " Too Many Requests" : ""}: it doesn't let Echo's Browser in. Don't use it; go back and choose another site.)\n\n`);
    // The page's main content first, then the rest (menus, sidebars, footer).
    const main = [...doc.querySelectorAll("main, [role=main], article, #content, #main, #mw-content-text")].find((m) => (m.innerText || "").trim().length > 400) || null;
    let skipNode = null;
    const walk = (node) => {
      if (node.nodeType === 3) { const t = node.nodeValue.replace(/\s+/g, " "); if (t.trim()) out.push(t); return; }
      if (node === skipNode) return;
      if (node.nodeType !== 1 || SKIP.test(node.tagName)) return;
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return;
      const st = win.getComputedStyle(node);
      if (st.display === "none" || st.visibility === "hidden") return;
      if (node.matches(INTERACTIVE) && !node.disabled) {
        elements.push(node);
        out.push(` [${elements.length}]${describe(node, doc)} `);
        if (node.tagName !== "SUMMARY") return;
      }
      const h = /^H([1-6])$/.exec(node.tagName);
      if (h) out.push(`\n${"#".repeat(+h[1])} `);
      if (node.tagName === "IMG" && node.alt && node.alt.trim().length > 2) out.push(` (image: ${tidy(node.alt, 60)}) `);
      for (const c of node.childNodes) walk(c);
      if (BLOCK.test(node.tagName)) out.push("\n");
    };
    if (main) {
      walk(main);
      out.push("\n\n--- rest of the page (menus, links, footer) ---\n");
      skipNode = main;
    }
    walk(doc.body);
    const text = out.join("").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text, elements };
  }

  // ----- carrying out Echo's actions -----
  const RISKY_WORDS = /\b(pay|buy|order|purchase|checkout|check out|book|reserve|send|submit|confirm|delete|remove|unsubscribe|subscribe|sign ?up|register|donate|transfer|apply|post|publish)\b/i;
  function needsApproval(a, e) {
    if (a.args.risky) return true;
    if (!e) return false;
    const label = tidy(e.innerText || e.value || e.getAttribute("aria-label") || "", 80);
    const form = e.form || e.closest("form");
    const submits = (e.tagName === "BUTTON" && (e.type || "submit") === "submit") || (e.tagName === "INPUT" && /^(submit|image)$/i.test(e.type)) || (a.name === "type" && a.args.submit);
    if (submits && form && /\/b\/f\//.test(e.getAttribute("formaction") || form.getAttribute("action") || "")) return true; // sends a form to the site
    return RISKY_WORDS.test(label);
  }
  function waitForLoad(ms = 15_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { br.waiters = br.waiters.filter((w) => w !== done); resolve(false); }, ms);
      const done = () => { clearTimeout(t); resolve(true); };
      br.waiters.push(done);
    });
  }
  /** Do something that may load a new page; report where Echo ends up. */
  async function settle(act, { expectLoad = true } = {}) {
    const before = br.url;
    const loaded = waitForLoad(expectLoad ? 15_000 : 1500);
    act();
    const ok = await loaded;
    if (!ok && expectLoad && br.loading) return "The page is taking long to load.";
    if (br.status) return `The site ${hostOf(br.url)} refused Echo's Browser (${br.status}). Don't use it again: go back and choose another site.`;
    return br.url !== before ? `Now on "${tidy(br.title, 80)}" (${tidy(br.url, 120)})` : "Done; still on the same page.";
  }
  function highlight(e) {
    if (!e) return () => {};
    try { e.scrollIntoView({ block: "center" }); } catch { /* fine */ }
    const was = e.style.outline;
    e.style.outline = "3px solid #5ee7f5"; e.style.outlineOffset = "2px";
    return () => { e.style.outline = was; e.style.outlineOffset = ""; };
  }
  // ----- the human in the loop -----
  // Echo asks when it's stuck or needs a choice, and waits a minute. With no
  // answer it decides by itself and carries on, except for anything risky
  // (paying, sending, submitting, deleting): that isn't done without a tap.
  const HITL_S = 60;
  let hitl = null;
  function closeHitl(value) {
    if (!hitl) return;
    const h = hitl; hitl = null;
    clearInterval(h.timer);
    $("br-hitl").hidden = true;
    const ask = $("br-ask");
    if (ask.dataset.mode === "answer") { ask.dataset.mode = ""; ask.hidden = true; $("br-task").placeholder = "Ask Echo to do something here"; }
    h.resolve(value);
  }
  /**
   * Ask the user, with buttons (`choices`) and/or a typed answer (`text`).
   * After a minute, `fallback` (a choice id, or null) is taken for them.
   * Resolves with { id, text, timedOut }.
   */
  function askHuman(question, { choices = [], fallback = null, fallbackLabel = "Echo decides by itself", text = false } = {}) {
    closeHitl({ id: null, text: "", timedOut: false });
    return new Promise((resolve) => {
      renderRun("Echo needs you", "Answer below, or Echo carries on by itself in a minute.");
      $("br-q").textContent = question;
      const box = $("br-choices");
      clear(box);
      for (const c of choices) {
        const b = el("button", c.primary ? "cta small-pill" : "glass small-pill", c.label);
        b.addEventListener("click", () => closeHitl({ id: c.id, text: "", timedOut: false }));
        box.appendChild(b);
      }
      $("br-hitl").hidden = false;
      if (text) {
        const ask = $("br-ask");
        ask.hidden = false; ask.dataset.mode = "answer";
        $("br-task").placeholder = choices.length ? "Or tell Echo what to do" : "Type your answer";
        $("br-task").value = "";
      }
      let left = HITL_S;
      const tick = () => {
        $("br-count").textContent = `${fallbackLabel} in ${left} s`;
        if (left-- <= 0) closeHitl({ id: fallback, text: "", timedOut: true });
      };
      hitl = { resolve, timer: setInterval(tick, 1000) };
      tick();
      try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* not on iPhone */ }
    });
  }
  let approvalResolve = null, approvalTimer = 0;
  /** Risky steps: Go ahead or Don't. With no answer in a minute it's a no. Resolves true, false or "timeout". */
  function askApproval(what) {
    $("ba-what").textContent = what;
    $("ba-host").textContent = br.url ? `On ${hostOf(br.url)}` : "";
    openSheet("sheet-bapprove");
    let left = HITL_S;
    const tick = () => {
      $("ba-count").textContent = `Echo won't do it unless you tap Go ahead · ${left} s`;
      if (left-- <= 0) answerApproval("timeout");
    };
    clearInterval(approvalTimer);
    approvalTimer = setInterval(tick, 1000);
    tick();
    return new Promise((resolve) => { approvalResolve = resolve; });
  }
  function answerApproval(answer) { clearInterval(approvalTimer); const r = approvalResolve; approvalResolve = null; closeSheets(); if (r) r(answer); }
  $("ba-yes").addEventListener("click", () => answerApproval(true));
  $("ba-no").addEventListener("click", () => answerApproval(false));
  $("scrim").addEventListener("click", () => { if (approvalResolve) answerApproval(false); });
  const NOT_APPROVED = (answer) => (answer === "timeout"
    ? "The user didn't approve within a minute, so it wasn't done. Don't try it again: carry on with the rest, and put it in the report as something for the user to do."
    : "The user said no. Don't do this; find another way or carry on without it.");

  async function doAction(a) {
    const els = br.snap ? br.snap.elements : [];
    const pick = (i) => { const e = els[i - 1]; return e && e.isConnected ? e : null; };
    const run = br.run;
    switch (a.name) {
      case "click": {
        const e = pick(a.args.index);
        if (!e) return `There's no element [${a.args.index}] on this page now.`;
        const to = e.tagName === "A" && realUrl(e.href);
        if (to && (run.blocked || []).includes(hostOf(to))) return `${hostOf(to)} doesn't let Echo's Browser in (it refused earlier). Choose another link.`;
        const unmark = highlight(e);
        if (needsApproval(a, e)) {
          const ok = await askApproval(`${a.args.why || "Continue"}: tap "${elLabel(e)}"`);
          if (ok !== true || run.stopped) { unmark(); return NOT_APPROVED(ok); }
        }
        const isLink = e.tagName === "A" && e.getAttribute("href") && !e.getAttribute("href").startsWith("#");
        const submits = !!(e.form || e.closest("form")) && (e.tagName === "BUTTON" || /^(submit|image)$/i.test(e.type || ""));
        const result = await settle(() => e.click(), { expectLoad: isLink || submits });
        unmark();
        return result;
      }
      case "type": {
        const e = pick(a.args.index);
        if (!e || !/^(INPUT|TEXTAREA)$/.test(e.tagName)) return `There's no text field [${a.args.index}] on this page now.`;
        if (secretField(e)) return "That's a password, card or code field: Echo doesn't type those. Use ask_user so the user types it.";
        const unmark = highlight(e);
        e.value = a.args.text;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        if (!a.args.submit) { unmark(); return `Typed "${tidy(a.args.text, 60)}"; the field now says "${tidy(e.value, 60)}".`; }
        const form = e.form || e.closest("form");
        if (!form) { unmark(); return "Typed it, but there's no form to send; click the page's button instead."; }
        if (needsApproval(a, e)) {
          const ok = await askApproval(`Send this form with "${tidy(a.args.text, 60)}"`);
          if (ok !== true || run.stopped) { unmark(); return NOT_APPROVED(ok); }
        }
        const result = await settle(() => (form.requestSubmit ? form.requestSubmit() : form.submit()));
        unmark();
        return result;
      }
      case "select": {
        const e = pick(a.args.index);
        if (!e || e.tagName !== "SELECT") return `There's no list [${a.args.index}] on this page now.`;
        const want = a.args.option.toLowerCase();
        const opt = [...e.options].find((o) => o.text.trim().toLowerCase() === want) || [...e.options].find((o) => o.text.toLowerCase().includes(want));
        if (!opt) return `"${a.args.option}" isn't one of the options.`;
        e.value = opt.value;
        e.dispatchEvent(new Event("change", { bubbles: true }));
        return `Chose "${tidy(opt.text, 60)}".`;
      }
      case "open_url": {
        if ((run.blocked || []).includes(hostOf(a.args.url))) return `${hostOf(a.args.url)} doesn't let Echo's Browser in (it refused earlier). Choose another site.`;
        return settle(() => goTo(a.args.url));
      }
      case "search": {
        // Three searches per try: after that, open one of the results.
        if ((run.searches = (run.searches || 0) + 1) > 3) {
          const doc0 = frameDoc();
          const res0 = doc0 && searchResults(doc0);
          return `Not searched: that's the 4th search in this try. Open one of the results instead${res0 ? `: ${res0.items.slice(0, 6).map((r, k) => `${k + 1}. ${tidy(r.title, 70)} — ${r.url}`).join(" | ")}` : " (go back to the results page)"}.`;
        }
        const where = await settle(() => goInput(a.args.query, true));
        const doc = frameDoc();
        const res = doc && searchResults(doc);
        if (!res) return where;
        return `${where}. Top results: ${res.items.slice(0, 6).map((r, k) => `${k + 1}. ${tidy(r.title, 70)} — ${r.url}`).join(" | ")}`;
      }
      case "back": return br.back.length ? settle(() => loadPath(pagePath(br.back.pop()), "back")) : "There's no page to go back to.";
      case "read_more": {
        run.part++;
        return `Showing part ${run.part} of the page.`;
      }
      case "ask_user": {
        const r = await askHuman(a.args.question, { text: true, fallbackLabel: "Echo decides by itself" });
        if (r.text) { run.userSaid = r.text; return `The user said: ${r.text}`; }
        return "The user didn't answer within a minute. Decide yourself: choose the most sensible option, write which one in your memory, and carry on.";
      }
      default: return "That isn't something Echo can do here.";
    }
  }

  // ----- Echo's turn: plan, steps, report -----
  // 1. Plan: the task as 3-8 checkable steps. 2. Each step in turn: one action
  // at a time until Echo says it's done (with its result); a failed try starts
  // the step again from where it began, up to 3 tries, then Echo asks you
  // (retry, skip or stop; skip after a minute). 3. The report, from every
  // step's result. Gemini's limits are waited out; Retry carries on after a failure.
  const MAX_TRIES = 3, MAX_ACTIONS_PER_TRY = 12, MAX_ACTIONS = 90;
  const MARK = { pending: "○", active: "●", done: "✓", failed: "✕", skipped: "↷" };
  function renderRun(title, line) {
    $("br-run").hidden = false;
    $("br-run-title").textContent = title;
    $("br-run-line").textContent = line;
  }
  function renderPlan(run) {
    const ol = $("br-plan");
    clear(ol);
    if (!run || !run.plan) { ol.hidden = true; return; }
    ol.hidden = false;
    run.plan.steps.forEach((s) => {
      const li = el("li", `bp-${s.status}`);
      li.append(el("span", "bp-mark", MARK[s.status] || "○"), el("span", "grow", s.title));
      if (s.status === "active" && s.attempts > 1) li.appendChild(el("span", "bp-try", `try ${s.attempts}/${MAX_TRIES}`));
      ol.appendChild(li);
      if (s.status === "active") setTimeout(() => { try { li.scrollIntoView({ block: "nearest" }); } catch { /* fine */ } }, 0);
    });
  }
  function describeAction(a) {
    const el2 = br.snap && br.snap.elements[(a.args.index || 0) - 1];
    const what = el2 ? `"${elLabel(el2)}"` : "";
    switch (a.name) {
      case "click": return `${a.args.why || "Clicking"} — ${what}`;
      case "type": return `Typing "${tidy(a.args.text, 40)}"${what ? ` into ${what}` : ""}`;
      case "select": return `Choosing "${a.args.option}"`;
      case "open_url": return `Opening ${hostOf(a.args.url)}`;
      case "search": return `Searching for "${tidy(a.args.query, 50)}"`;
      case "back": return "Going back";
      case "read_more": return "Reading further down the page";
      case "ask_user": return "Asking you something";
      default: return "Working…";
    }
  }
  /**
   * Gemini's free tier allows only a few requests a minute. A request that hits
   * that limit (or a hiccup reaching the relay) waits as long as Google says and
   * tries again, up to 3 times, with a countdown; Take over stops the wait.
   */
  const RETRYABLE = (e) => !e.status || e.status >= 500 || ["minute", "busy"].includes(e.data && e.data.error);
  async function callBrowse(run, path, payload) {
    for (let attempt = 0; ; attempt++) {
      try { return await cloudApi(path, payload, { signal: run.abort.signal }); }
      catch (e) {
        if (run.stopped || e.name === "AbortError" || attempt >= 3 || !RETRYABLE(e)) throw e;
        const limited = e.status === 429;
        const told = Number(e.data && e.data.retryAfter);
        const wait = limited ? Math.min(90, Math.max(5, Number.isFinite(told) && told > 0 ? told + 2 : 20) + attempt * 10) : 5;
        await countdown(run, wait, limited ? "Free tier: a few requests a minute" : "Echo couldn't be reached");
      }
    }
  }
  function countdown(run, seconds, why) {
    return new Promise((resolve) => {
      let left = seconds;
      const tick = () => {
        if (run.stopped || left <= 0) { clearInterval(t); resolve(); return; }
        renderRun(`Waiting for Gemini · ${left} s`, `${why}; Echo carries on by itself.`);
        left--;
      };
      const t = setInterval(tick, 1000);
      tick();
    });
  }
  /** The plan as the relay needs it: no page elements, no per-try history. */
  const wirePlan = (run) => ({ goal: run.plan.goal, report: run.plan.report, steps: run.plan.steps.map(({ title, doneWhen, status, result, lastFail }) => ({ title, doneWhen, status, result, lastFail })) });
  const pageNow = (run) => {
    br.snap = pageSnapshot();
    const parts = Math.max(1, Math.ceil(br.snap.text.length / PART));
    run.part = Math.min(run.part, parts);
    return { url: br.url, title: br.title, text: br.snap.text.slice((run.part - 1) * PART, run.part * PART), part: run.part, parts };
  };
  /** One step: up to 3 tries, each from where the step began. Returns "done", "task_done", "failed" or "stopped". */
  async function runStep(run, st) {
    const total = run.plan.steps.length;
    while (st.attempts < MAX_TRIES && !run.stopped) {
      st.attempts++;
      renderPlan(run);
      if (st.attempts === 1 || !st.startUrl) st.startUrl = br.url;
      else if (br.url !== st.startUrl) { renderRun(`Step ${run.cur + 1} of ${total} · try ${st.attempts}`, "Starting this step again"); await settle(() => goTo(st.startUrl)); }
      st.history = [];
      run.searches = 0;
      let why = "";
      for (let k = 0; k < MAX_ACTIONS_PER_TRY && !run.stopped; k++) {
        if (run.actions >= MAX_ACTIONS) { why = "The task took too many actions overall."; break; }
        const d = await callBrowse(run, "/cloud/browse/step", {
          task: run.task, plan: wirePlan(run), current: run.cur, attempt: st.attempts, lastFail: st.lastFail, memory: run.memory,
          history: st.history.map(({ action, args, result }) => ({ action, args, result })), notes: run.notes, page: pageNow(run), userSaid: run.userSaid, blocked: run.blocked || [], context: { tz: localTz() },
        });
        if (d.usage && cloudInfo) cloudInfo.usage = d.usage;
        run.notes.push(...(d.notes || []));
        for (const s2 of d.sources || []) if (!run.sources.some((x) => x.url === s2.url)) run.sources.push(s2);
        const a = d.action;
        if (a.args && a.args.memory) run.memory = a.args.memory;
        if (run.stopped) return "stopped";
        if (a.name === "step_done") { st.result = a.args.result; return "done"; }
        if (a.name === "task_done") { st.result = a.args.result; return "task_done"; }
        if (a.name === "step_failed") { why = a.args.why; break; }
        renderRun(`Step ${run.cur + 1} of ${total}${st.attempts > 1 ? ` · try ${st.attempts}` : ""}`, describeAction(a));
        const result = await doAction(a);
        run.actions++;
        // The same action a third time in this try, without getting anywhere: this way isn't working.
        const sig = JSON.stringify([a.name, a.args.index, a.args.url, a.args.query, a.args.text, a.args.option]);
        const repeats = st.history.filter((h) => h.sig === sig).length;
        st.history.push({ action: a.name, args: a.args, result, sig });
        if (a.name !== "read_more" && a.name !== "ask_user") run.part = ["click", "back", "open_url", "search"].includes(a.name) || (a.name === "type" && a.args.submit) ? 1 : run.part;
        if (repeats >= 2) { why = `I did the same thing (${a.name}) three times without getting anywhere.`; break; }
        // Searching again and again without opening anything: say so (it's what Echo got stuck on).
        const lastNames = st.history.slice(-3).map((h) => h.action);
        if (lastNames.length === 3 && lastNames.every((n) => n === "search")) st.history[st.history.length - 1].result += " You've now searched 3 times in a row: open the most relevant result (click its number or open_url its address) instead of searching again.";
      }
      if (run.stopped) return "stopped";
      st.lastFail = why || `It took more than ${MAX_ACTIONS_PER_TRY} actions without finishing this step.`;
    }
    return run.stopped ? "stopped" : "failed";
  }
  /** `resume`: a run that stopped or failed, picked up at the step it reached (its plan, results and notes kept). */
  async function runEcho(task, resume = null) {
    if (!passValid()) return toast("Tap Get started to use the Browser.", true);
    if (br.run) return toast("Echo is already on it. Tap Take over to stop.");
    try { await experience?.ensureThread(); } catch (e) { return toast(e.message, true); }
    if (currentView !== "browser") show("browser");
    try { await browserSession(); } catch (e) { return toast(cloudProblem(e), true); }
    const run = br.run = resume
      ? { ...resume, requestId: newKey(), stopped: false, abort: new AbortController() }
      : { task, threadId: currentThread, requestId: newKey(), plan: null, cur: 0, memory: "", notes: [], sources: [], part: 1, actions: 0, userSaid: "", stopped: false, abort: new AbortController() };
    if (resume && run.plan && run.plan.steps[run.cur]) { const st = run.plan.steps[run.cur]; st.attempts = 0; st.startUrl = null; }
    $("br-result").hidden = true;
    $("br-ask").hidden = true;
    $("br-panel").classList.add("running");
    let text = null, failed = false;
    try {
      if (!run.plan) {
        renderRun("Echo is planning", "Working out the steps…");
        const page = pageNow(run);
        const d = await callBrowse(run, "/cloud/browse/plan", { task, page: { url: page.url, title: page.title, text: page.text.slice(0, 3000) }, context: { tz: localTz() } });
        run.plan = { ...d.plan, steps: d.plan.steps.map((s) => ({ ...s, status: "pending", attempts: 0, result: "", lastFail: "", history: [] })) };
      }
      renderPlan(run);
      while (!run.stopped && run.cur < run.plan.steps.length) {
        const st = run.plan.steps[run.cur];
        st.status = "active";
        renderPlan(run);
        const outcome = await runStep(run, st);
        if (outcome === "stopped" || run.stopped) break;
        if (outcome === "done") { st.status = "done"; run.cur++; continue; }
        if (outcome === "task_done") {
          st.status = "done";
          for (const rest of run.plan.steps.slice(run.cur + 1)) rest.status = "skipped";
          run.cur = run.plan.steps.length;
          break;
        }
        // Three tries didn't do it: the human in the loop decides, or Echo skips it after a minute.
        st.status = "failed";
        renderPlan(run);
        const r = await askHuman(`Step ${run.cur + 1} didn't work after ${MAX_TRIES} tries. ${st.lastFail}`, {
          choices: [{ id: "retry", label: "Try again", primary: true }, { id: "skip", label: "Skip it" }, { id: "stop", label: "Stop and report" }],
          fallback: "skip", fallbackLabel: "Echo skips it and carries on", text: true,
        });
        if (run.stopped) break;
        if (r.text) { run.userSaid = r.text; st.lastFail = `The user said: ${r.text}`; st.attempts = 0; st.status = "active"; continue; }
        if (r.id === "retry") { st.attempts = 0; st.status = "active"; continue; }
        if (r.id === "stop") { for (const rest of run.plan.steps.slice(run.cur + 1)) rest.status = "skipped"; run.cur = run.plan.steps.length; break; }
        st.status = "skipped";
        run.cur++;
      }
      if (!run.stopped) {
        renderPlan(run);
        renderRun("Echo is writing the report", "Putting every step's results together…");
        const d = await callBrowse(run, "/cloud/browse/report", { task: run.task, threadId: run.threadId, requestId: run.requestId, plan: wirePlan(run), notes: run.notes, sources: run.sources, context: { tz: localTz() } });
        text = d.report;
      }
    } catch (e) {
      if (!run.stopped && e.name !== "AbortError") { failed = true; text = e.status ? cloudProblem(e) : "Something went wrong while browsing."; }
    }
    if (!run.stopped) finishRun(run, text, { failed });
  }
  function finishRun(run, text, { failed = false, tookOver = false } = {}) {
    if (br.run !== run) return;
    br.run = null;
    closeHitl({ id: null, text: "", timedOut: false });
    $("br-panel").classList.remove("running");
    $("br-run").hidden = true;
    $("br-plan").hidden = true;
    const ask = $("br-ask"); ask.hidden = false; ask.dataset.mode = ""; $("br-task").placeholder = "Ask Echo to do something here";
    const box = $("br-result");
    clear(box);
    box.hidden = false;
    const steps = run.plan ? run.plan.steps : [];
    const count = (st) => steps.filter((s) => s.status === st).length;
    const head = el("div", "row-i br-result-head");
    head.append(el("b", "grow", tookOver ? "You took over" : failed ? "Echo couldn't go on" : "Echo's report"));
    const close = el("button", "glass small-pill", "Close"); close.addEventListener("click", () => { box.hidden = true; });
    head.appendChild(close);
    box.appendChild(head);
    if (steps.length) box.appendChild(el("p", "fine", `${MARK.done} ${count("done")} of ${steps.length} steps done${count("skipped") ? ` · ${MARK.skipped} ${count("skipped")} skipped` : ""}${count("failed") ? ` · ${MARK.failed} ${count("failed")} failed` : ""}`));
    box.appendChild(el("p", "br-answer", tookOver ? "Echo kept its plan and what it found. Carry on yourself, or let Echo continue from where it stopped." : text || "Done."));
    if (failed || tookOver) {
      const n = Math.min(run.cur + 1, steps.length || 1);
      const again = el("button", "cta big-btn br-retry", run.plan ? `${tookOver ? "Continue" : "Retry"} from step ${n}` : "Retry");
      again.addEventListener("click", () => { box.hidden = true; runEcho(run.task, run); });
      box.appendChild(again);
      if (run.plan && count("done")) box.appendChild(el("p", "fine", `The ${count("done")} finished step${count("done") === 1 ? " is" : "s are"} kept.`));
    }
    if (run.sources.length) {
      const srcs = el("div", "srcs");
      for (const s2 of run.sources.slice(0, 4)) { const l = el("button", "glass small-pill", s2.title); l.addEventListener("click", () => goTo(s2.url)); srcs.appendChild(l); }
      box.appendChild(srcs);
    }
    if (failed || tookOver) return; // only finished tasks go to the chat
    // The chat keeps the report too (and the Mac gets it with Phone mode's other messages).
    const at = Date.now();
    putMessage({ k: run.requestId, at, from: "you", text: `🌐 ${run.task}`, kind: "text", src: "phone", threadId: run.threadId });
    putMessage({ k: `${run.requestId}-echo`, at: at + 1, from: "echo", text: text || "Done.", kind: "text", src: "phone", threadId: run.threadId, sources: run.sources.slice(0, 4) });
    window.echoCore?.react("celebrate");
    syncToMac();
  }
  function takeOver() {
    const run = br.run;
    if (!run) return;
    run.stopped = true;
    run.abort.abort();
    if (approvalResolve) answerApproval(false);
    closeHitl({ id: "stop", text: "", timedOut: false });
    const st = run.plan && run.plan.steps[run.cur];
    if (st && st.status === "active") st.status = "pending";
    finishRun(run, null, { tookOver: true });
    toast("You're in control.");
  }
  $("br-takeover").addEventListener("click", takeOver);
  const brTask = $("br-task");
  brTask.addEventListener("input", () => { brTask.style.height = "40px"; brTask.style.height = `${Math.min(110, brTask.scrollHeight)}px`; });
  brTask.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("br-ask").requestSubmit(); } });
  $("br-ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = brTask.value.trim();
    if (!text) return;
    brTask.value = ""; brTask.style.height = "40px"; brTask.blur();
    if ($("br-ask").dataset.mode === "answer" && hitl) {
      renderRun("Echo is browsing", "Carrying on…");
      closeHitl({ id: "text", text, timedOut: false });
      return;
    }
    runEcho(text);
  });

  // ---------- Hand-off to the Mac ----------
  // A job left here while the Mac is away. Face ID approves its exact text (the
  // passkey signs a hash of it); the Mac checks that before running anything.
  let handoffPrepared = null, handoffItems = [], hoTimer = 0, pkAsked = false;
  function pkIds() { try { return JSON.parse(store.get("echo_pk_ids") || "[]"); } catch { return []; } }
  function rememberPasskeys(list) {
    const ids = [...new Set([...pkIds(), ...(list || []).map((c) => c && c.id).filter((x) => typeof x === "string")])].slice(-10);
    if (ids.length) store.set("echo_pk_ids", JSON.stringify(ids));
  }
  async function prepareHandoff() {
    $("ho-approve").disabled = true;
    const text = $("ho-text").value.trim();
    if (!text) { handoffPrepared = null; return; }
    const task = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    const canon = JSON.stringify({ v: 1, id: task.id, text: task.text, createdAt: task.createdAt, device: DEV });
    const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
    if ($("ho-text").value.trim() !== text) return; // edited meanwhile: the next pass prepares it
    handoffPrepared = { task, challenge };
    $("ho-approve").disabled = false;
  }
  function openHandoff(text = "") {
    if (!T || passClaims()?.p === true) { toast("Connect your Mac in Settings → Your Mac to send it jobs.", true); return; }
    if (!passValid()) return toast("Tap Get started to continue.", true);
    if (last && last.faceId && last.faceId.available && !last.faceId.registered) return toast("Turn on Face ID in Settings first, while your Mac is online.", true);
    $("ho-text").value = text;
    openSheet("sheet-handoff");
    prepareHandoff();
  }
  $("ho-text").addEventListener("input", () => { $("ho-approve").disabled = true; clearTimeout(hoTimer); hoTimer = setTimeout(prepareHandoff, 250); });
  $("ho-approve").addEventListener("click", async () => {
    const p = handoffPrepared;
    if (!p) return;
    if (Date.now() - p.task.createdAt > 8 * 60_000) { prepareHandoff(); return toast("Tap Approve again."); }
    // Face ID straight from the tap: Safari only allows it while the tap is fresh.
    const ids = pkIds();
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: {
        challenge: p.challenge, rpId: location.hostname, userVerification: "required", timeout: 60_000,
        ...(ids.length ? { allowCredentials: ids.map((id) => ({ type: "public-key", id: b64.toBuf(id) })) } : {}),
      } });
    } catch (e) {
      if (e && e.name === "NotAllowedError") return;
      return toast("Face ID isn't set up for Echo on this phone. Turn it on in Settings while your Mac is online.", true);
    }
    try {
      const d = await cloudApi("/cloud/handoff", { task: p.task, assertion: encodeAssertion(cred) });
      closeSheets();
      handoffPrepared = null;
      toast(d.macOnline ? "Sent. Your Mac will start it in a moment." : "Waiting for your Mac. You'll get a notification when it's done.");
      if (currentView === "missions") loadHandoffs();
    } catch (e) { toast(cloudProblem(e), true); }
  });
  async function loadHandoffs() {
    if (!passValid()) return;
    try { handoffItems = (await cloudApi("/cloud/handoff")).items || []; } catch { /* keep the last list */ }
    renderHandoffs();
  }
  const HO_STATE = { waiting: ["Waiting", "#ffb35c"], started: ["Working", "#5ee7f5"], done: ["Done", "#3ee6b0"], failed: ["Failed", "#ff6b6b"], rejected: ["Refused", "#ff6b6b"], cancelled: ["Cancelled", "#8fa3aa"] };
  function renderHandoffs() {
    const box = $("handoff-box");
    clear(box);
    if (!passValid()) return;
    const list = el("section", "glass list");
    const head = el("div", "row ho-head");
    head.appendChild(el("b", "grow", "Waiting for your Mac"));
    const add = el("button", "glass small-pill", "+ New job");
    add.addEventListener("click", () => openHandoff(""));
    head.appendChild(add);
    list.appendChild(head);
    if (!handoffItems.length) list.appendChild(el("p", "sub small empty-line", "Leave a job here and your Mac does it the next time Echo is on."));
    for (const it of handoffItems.slice(0, 8)) {
      let [label, color] = HO_STATE[it.status] || [it.status, "#8fa3aa"];
      // Started, then no word from the Mac for half an hour: say so rather than "Working" forever.
      const quiet = it.status === "started" && Date.now() - (it.updatedAt || 0) > 30 * 60_000;
      if (quiet) { label = "No news"; color = "#ffb35c"; }
      const row = el("div", "row ho-row");
      const t = el("div", "grow");
      t.append(el("span", "clamp2", it.text), el("span", "sub tiny", `${quiet ? "Started, no word from your Mac since" : label} · ${ago(it.updatedAt || it.createdAt || Date.now())}`));
      if (it.summary) t.appendChild(el("span", "small clamp2 ho-summary", it.summary));
      const tag = el("span", "tag", label); tag.style.color = color;
      row.append(t, tag);
      if (it.status === "waiting") {
        const x = el("button", "ho-x", "✕"); x.setAttribute("aria-label", "Cancel this job");
        x.addEventListener("click", async () => { try { await cloudApi("/cloud/handoff/cancel", { id: it.id }); loadHandoffs(); } catch (e) { toast(cloudProblem(e), true); } });
        row.appendChild(x);
      }
      list.appendChild(row);
    }
    box.appendChild(list);
  }

  // ---------- morning briefing and notifications ----------
  function renderBriefSettings() {
    const on = !!(briefInfo && briefInfo.prefs && briefInfo.prefs.on && briefInfo.subscribed);
    $("sw-brief").setAttribute("aria-checked", String(on));
    if (briefInfo && briefInfo.prefs && document.activeElement !== $("brief-time") && document.activeElement !== $("brief-days")) {
      $("brief-time").value = briefInfo.prefs.time;
      $("brief-days").value = briefInfo.prefs.days;
    }
    $("brief-note").textContent = !passValid()
      ? "Tap Get started to turn this on."
      : on ? `Your briefing arrives at ${briefInfo.prefs.time}${briefInfo.prefs.place ? ` with ${briefInfo.prefs.place.name}'s weather` : ""}. Reminders from Echo arrive as notifications too.`
        : "A notification each morning with your weather, calendar, email that needs you and what's happening nearby. Uses your weather location.";
  }
  async function saveBriefPrefs(extra = {}) {
    const pl = place();
    const r = await cloudApi("/cloud/briefing/prefs", { prefs: {
      time: $("brief-time").value || "07:00", days: $("brief-days").value, tz: localTz(),
      place: pl ? { name: pl.name, lat: pl.lat, lon: pl.lon } : null, ...extra,
    } });
    briefInfo = { ...(briefInfo || {}), prefs: r.prefs };
    renderBriefSettings();
  }
  const sameKey = (sub, key) => { try { return b64.fromBuf(sub.options.applicationServerKey) === key; } catch { return false; } };
  /** Ask for permission (inside the tap), subscribe, and tell the relay where to send. */
  async function enableNotifications() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      throw new Error(standalone ? "This iPhone can't show notifications from Echo. Update iOS and try again." : "Open Echo from your Home Screen to allow notifications.");
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications are off for Echo. Turn them on in Settings › Notifications › Echo.");
    const reg = await navigator.serviceWorker.ready;
    const { key } = await cloudApi("/cloud/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64.toBuf(key) });
    await cloudApi("/cloud/push/subscribe", { subscription: sub.toJSON(), installation: INSTALLATION });
    briefInfo = { ...(briefInfo || {}), subscribed: true };
  }
  $("sw-brief").addEventListener("click", async () => {
    if (!passValid()) return toast("Tap Get started to continue.", true);
    const on = $("sw-brief").getAttribute("aria-checked") === "true";
    try {
      if (on) {
        await saveBriefPrefs({ on: false });
        await cloudApi("/cloud/push/unsubscribe", { installation: INSTALLATION });
        briefInfo.subscribed = false;
        renderBriefSettings();
        return toast("Briefing and reminders are off");
      }
      await enableNotifications();
      await saveBriefPrefs({ on: true });
      toast(`Your briefing arrives at ${$("brief-time").value}`);
      if (!place()) { toast("Set your weather location for weather and nearby alerts."); openSheet("sheet-place"); }
    } catch (e) { toast(e.message || cloudProblem(e), true); renderBriefSettings(); }
  });
  for (const id of ["brief-time", "brief-days"]) {
    $(id).addEventListener("change", () => { if (briefInfo && briefInfo.prefs && briefInfo.prefs.on) saveBriefPrefs().then(() => toast(`Briefing at ${$("brief-time").value}`)).catch((e) => toast(cloudProblem(e), true)); });
  }
  $("push-test").addEventListener("click", async () => {
    try { await cloudApi("/cloud/push/test", {}); toast("Sent. Check your notifications."); }
    catch (e) { toast(cloudProblem(e), true); }
  });
  $("brief-open").addEventListener("click", () => openBriefing());
  // Calendar from this iPhone: a Shortcut posts today's events to a private link.
  let phoneCal = null, resetArmed = 0;
  function renderPhoneCal() {
    const last = phoneCal && phoneCal.last;
    $("phonecal-state").textContent = last ? (new Date(last.at).toDateString() === new Date().toDateString() ? `${last.count} today` : "On") : "Set up";
    $("pc-status").textContent = last
      ? `Last received ${new Date(last.at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} at ${clock(last.at)}: ${last.count} event${last.count === 1 ? "" : "s"}.`
      : "Not set up yet. Follow the steps once.";
  }
  async function loadPhoneCal() {
    if (!passValid()) return;
    try { phoneCal = await cloudApi("/cloud/calendar"); renderPhoneCal(); } catch { /* keep */ }
  }
  $("phonecal-open").addEventListener("click", () => {
    if (!passValid()) return toast("Tap Get started to continue.", true);
    openSheet("sheet-phonecal");
    loadPhoneCal();
  });
  $("pc-copy").addEventListener("click", async () => {
    if (!phoneCal) return toast("One moment…");
    try { await navigator.clipboard.writeText(phoneCal.url); toast("Link copied. Paste it into Get Contents of URL."); }
    catch { toast("Couldn't copy. Long-press to copy instead.", true); }
  });
  $("pc-reset").addEventListener("click", async () => {
    if (Date.now() - resetArmed > 4000) { resetArmed = Date.now(); return toast("Tap again to make a new link. The old one stops working."); }
    resetArmed = 0;
    try { const d = await cloudApi("/cloud/calendar/reset", {}); phoneCal = { ...(phoneCal || {}), url: d.url }; toast("New link made. Copy it into your Shortcut."); }
    catch (e) { toast(cloudProblem(e), true); }
  });
  $("brief-refresh").addEventListener("click", () => briefNow());

  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function openBriefing() {
    if (!passValid()) return toast("Tap Get started to get briefings.", true);
    show("briefing");
    const latest = briefInfo && briefInfo.latest;
    renderBriefing(latest);
    if (!latest || latest.date !== todayLocal()) briefNow();
  }
  async function briefNow() {
    const btn = $("brief-refresh");
    btn.setAttribute("aria-busy", "true");
    try {
      const pl = place();
      const r = await cloudApi("/cloud/briefing/now", { prefs: { tz: localTz(), ...(pl ? { place: { name: pl.name, lat: pl.lat, lon: pl.lon } } : {}) } });
      briefInfo = { ...(briefInfo || {}), latest: r.briefing };
      renderBriefing(r.briefing);
    } catch (e) { toast(cloudProblem(e), true); }
    finally { btn.removeAttribute("aria-busy"); }
  }
  function bcard(title, ...nodes) {
    const c = el("section", "glass bcard");
    c.appendChild(el("h3", "", title));
    for (const n of nodes) if (n) c.appendChild(n);
    return c;
  }
  function blist(items) {
    const ul = el("ul");
    for (const [t, text] of items) { const li = el("li"); if (t) li.appendChild(el("span", "t", t)); li.appendChild(el("span", "", text)); ul.appendChild(li); }
    return ul;
  }
  function renderBriefing(b) {
    const box = $("brief-body");
    clear(box);
    if (!b) { const l = el("div", "glass list"); l.appendChild(el("p", "sub empty", "Getting today's briefing…")); box.appendChild(l); return; }
    box.appendChild(el("p", "brief-date", `${new Date(b.at).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} · ${clock(b.at)}`));
    if (b.weather) box.appendChild(bcard(b.place || "Weather", el("div", "big", `${b.weather.temp}° ${b.weather.text}`), el("p", "sub small", `High ${b.weather.high}°, low ${b.weather.low}°.${b.weather.tip ? ` ${b.weather.tip}` : ""}`)));
    else box.appendChild(bcard("Weather", el("p", "sub small", b.place ? "Weather isn't available right now." : "Set your weather location in Settings for weather and nearby alerts.")));
    const asOf = b.macAsOf ? el("p", "fine", `From your Mac, as of ${clock(b.macAsOf)}${new Date(b.macAsOf).toDateString() !== new Date(b.at).toDateString() ? " yesterday" : ""}`) : null;
    const calFrom = b.calendarFrom === "iphone" ? el("p", "fine", `From your iPhone at ${clock(b.calendarAt)}`) : asOf;
    if (b.calendar) box.appendChild(bcard("Calendar", b.calendar.length ? blist(b.calendar.map((e) => [e.time, e.location ? `${e.title} · ${e.location}` : e.title])) : el("p", "sub small", "Nothing on your calendar today."), calFrom));
    else box.appendChild(bcard("Calendar", el("p", "sub small", "No calendar yet. Set up Settings → Calendar from this iPhone, or turn on your Mac.")));
    if (b.email && b.email.length) box.appendChild(bcard("Needs you", blist(b.email.map((m) => [null, `${m.from} — ${m.subject}`]))));
    if (b.reminders && b.reminders.length) box.appendChild(bcard("Reminders", blist(b.reminders.map((r) => [r.time, r.text]))));
    if (b.comingUp && b.comingUp.length) {
      const c = bcard("Coming up");
      for (const u of b.comingUp) {
        const row = el("button", "up-row");
        row.append(el("span", "t", inDays(u.days)), el("span", "grow clamp1", `${u.what} · ${u.title}`));
        row.addEventListener("click", () => openMemory({ id: u.item, from: "briefing" }));
        c.appendChild(row);
      }
      box.appendChild(c);
    }
    if (b.near) {
      const near = [...b.near.quakes.map((q) => [null, `Earthquake M${q.magnitude.toFixed(1)}, ${q.place}${q.tsunami ? " (tsunami flag)" : ""}`]), ...b.near.storms.map((st) => [null, `${st.title} (${st.type})`])];
      box.appendChild(bcard("Near you", near.length ? blist(near) : el("p", "sub small", "No earthquakes or storms within 500 km."), b.world ? el("p", "fine", `Elsewhere: ${b.world.zone.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())} — ${b.world.headline}`) : null));
    }
    const done = (b.missions || []).map((m) => [null, `${m.status === "failed" ? "Failed" : "Finished"}: ${m.goal}`]);
    box.appendChild(bcard("Your Mac", done.length ? blist(done) : el("p", "sub small", "Nothing finished overnight."), el("p", "fine", b.macOnline ? "Online now." : "Offline right now.")));
  }
  // A notification opens its page: the briefing, or the chat for a reminder.
  function openFromUrl(url) {
    try {
      const v = new URL(url, location.origin).searchParams.get("view");
      const q = new URL(url, location.origin).searchParams;
      if (v === "briefing") openBriefing(); else if (v === "chat") show("chat"); else if (v === "missions") show("missions"); else if (v === "today") show("today");
      else if (v === "memory") openMemory({ id: q.get("id"), from: TABS.includes(currentView) ? currentView : lastTab });
    } catch { /* not ours */ }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "open") openFromUrl(e.data.url); });

  // ---------- brain ----------
  function renderBrain(d) {
    const active = (d.models || []).find((m) => m.active);
    $("brain-active").textContent = active ? active.label : "—";
    $("brain-model").textContent = active ? active.model : "";
    const list = $("brain-list"); clear(list);
    for (const m of d.models || []) {
      const r = el("button", "row"); r.setAttribute("role", "radio"); r.setAttribute("aria-checked", String(!!m.active));
      const t = el("div", "grow"); t.append(el("span", "", m.label), el("span", "sub tiny", m.model));
      const note = el("span", "small", m.active ? "Active" : ""); note.style.color = "#3ee6b0";
      r.append(el("span", "radio-ring"), t, note);
      r.addEventListener("click", async () => {
        if (m.active) return;
        note.textContent = "Switching…"; note.style.color = "";
        try { const res = await api("/action", { json: { type: "switch-model", provider: m.id } }); toast(res.message || `Switched to ${m.label}`, !res.ok); }
        catch (e) { toast(e.message, true); }
        pollStatus().catch(() => {});
      });
      list.appendChild(r);
    }
    const cl = $("conn-list"); clear(cl);
    if (!(d.connections || []).length) cl.appendChild(el("p", "sub empty", "No tool connections."));
    for (const c of d.connections || []) {
      const r = el("div", "row"); const s = el("span", "small", c.status === "active" ? "Active" : "Connected"); s.style.color = "#3ee6b0";
      r.append(el("span", "grow", c.name), s); cl.appendChild(r);
    }
  }

  // ---------- screen ----------
  const ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  let pc = null, rtcConnected = false, answered = false, fallback = 0, framesOn = false, frameUrl = "", frameBlob = null;
  const video = $("screen-video"), frame = $("screen-frame");
  const videoLive = () => rtcConnected && video.videoWidth > 0;
  function openScreen() {
    if (!pc) {
      clearTimeout(fallback);
      fallback = setTimeout(() => { if (!videoLive()) startFrames(); }, 6000);
      pc = new RTCPeerConnection({ iceServers: ICE });
      pc.ontrack = (ev) => { if (ev.track.kind === "video") { video.srcObject = ev.streams[0]; $("novid").hidden = true; stopFrames(); } else $("mac-audio").srcObject = ev.streams[0]; };
      pc.onicecandidate = (ev) => { if (ev.candidate) api("/rtc/ice", { json: { candidate: ev.candidate } }).catch(() => {}); };
      pc.onconnectionstatechange = () => { rtcConnected = pc && pc.connectionState === "connected"; if (pc && /failed|closed/.test(pc.connectionState)) { pc = null; if (currentView === "screen") startFrames(); } };
      pc.addTransceiver("audio", { direction: "recvonly" }); pc.addTransceiver("video", { direction: "recvonly" });
      answered = false;
      pc.createOffer().then((o) => pc.setLocalDescription(o))
        .then(() => api("/rtc/offer", { json: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } }))
        .then(pollAnswer).catch(() => startFrames());
    } else if (!videoLive()) startFrames();
  }
  function pollAnswer() {
    if (!pc || currentView !== "screen") return;
    api("/rtc/answer").then((d) => {
      if (d.answer && !answered) { answered = true; pc.setRemoteDescription(d.answer); }
      (d.ice || []).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
    }).catch(() => {}).then(() => { if (pc && !rtcConnected) setTimeout(pollAnswer, 1000); });
  }
  /**
   * Leaving the screen ends its stream, sound included. It used to stay open:
   * the Mac's sound (Echo speaking there) kept coming to this phone, and iPhone
   * played it the moment its audio woke up, such as a Listen tap: the "ghost voice".
   */
  function closeScreen() {
    stopFrames();
    clearTimeout(fallback);
    if (pc) { const old = pc; pc = null; try { old.close(); } catch { /* already closed */ } }
    rtcConnected = false; answered = false;
    const a = $("mac-audio");
    try { a.pause(); } catch { /* fine */ }
    a.srcObject = null; a.muted = true;
    $("audio-btn").setAttribute("aria-pressed", "false");
    if (video.srcObject) { video.srcObject = null; $("novid").hidden = false; }
  }
  function startFrames() { if (framesOn || currentView !== "screen") return; framesOn = true; $("live-mode").textContent = "SNAPSHOTS"; nextFrame(); }
  function stopFrames() { framesOn = false; frame.hidden = true; $("live-mode").textContent = "LIVE"; }
  async function nextFrame() {
    if (!framesOn || !S) return;
    const asked = Date.now();
    try {
      const r = await api("/frame", { raw: true });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "No screen");
      frameBlob = await r.blob();
      const old = frameUrl; frameUrl = URL.createObjectURL(frameBlob);
      frame.onload = () => { if (old) URL.revokeObjectURL(old); };
      frame.src = frameUrl; frame.hidden = false; $("novid").hidden = true;
    } catch (e) { $("novid").hidden = false; $("novid").firstChild.textContent = e.message || "Couldn't get the screen."; }
    if (framesOn) setTimeout(nextFrame, Math.max(0, 500 - (Date.now() - asked)));
  }
  $("audio-btn").addEventListener("click", () => {
    const a = $("mac-audio"); a.muted = !a.muted; if (!a.muted) a.play().catch(() => {});
    $("audio-btn").setAttribute("aria-pressed", String(!a.muted)); toast(a.muted ? "Mac audio off" : "Mac audio on");
  });
  $("snap-btn").addEventListener("click", () => {
    const save = (blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `echo-screen-${Date.now()}.${blob.type === "image/jpeg" ? "jpg" : "png"}`; a.click(); toast("Screenshot saved"); };
    if (videoLive()) { const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext("2d").drawImage(video, 0, 0); c.toBlob(save, "image/png"); }
    else if (frameBlob) save(frameBlob); else toast("No screen yet", true);
  });
  document.querySelectorAll("[data-ctl]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-ctl]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("ctl-pad").hidden = b.dataset.ctl !== "pad"; $("ctl-keys").hidden = b.dataset.ctl !== "keys";
  }));
  // Trackpad: relative moves batched every 40 ms; a still short touch clicks, two double-click.
  const pad = $("pad");
  let touch = null, dx = 0, dy = 0, flushT = 0, lastTap = 0, tapT = 0;
  const mouse = (action, extra) => api("/mouse", { json: { action, ...extra } }).catch(() => {});
  const flush = () => { flushT = 0; if (dx || dy) { mouse("move", { dx: Math.round(dx), dy: Math.round(dy) }); dx = dy = 0; } };
  pad.addEventListener("pointerdown", (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); touch = { x: e.clientX, y: e.clientY, at: Date.now(), moved: 0 }; pad.classList.add("active"); });
  pad.addEventListener("pointermove", (e) => {
    if (!touch) return;
    const mx = e.clientX - touch.x, my = e.clientY - touch.y; touch.x = e.clientX; touch.y = e.clientY; touch.moved += Math.abs(mx) + Math.abs(my);
    dx += mx * 2.2; dy += my * 2.2; if (!flushT) flushT = setTimeout(flush, 40);
  });
  const endTouch = () => {
    if (!touch) return;
    const tap = touch.moved < 8 && Date.now() - touch.at < 260; touch = null; pad.classList.remove("active"); flush();
    if (!tap) return;
    const now = Date.now();
    if (now - lastTap < 300) { clearTimeout(tapT); lastTap = 0; mouse("dclick"); } else { lastTap = now; tapT = setTimeout(() => mouse("click"), 300); }
  };
  pad.addEventListener("pointerup", endTouch); pad.addEventListener("pointercancel", endTouch);
  document.querySelectorAll("[data-mouse]").forEach((b) => b.addEventListener("click", () => mouse(b.dataset.mouse)));
  document.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => api("/keys", { json: { key: b.dataset.key } }).catch(() => toast("Couldn't reach your Mac.", true))));
  $("type-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const text = $("type-text").value; if (!text) return;
    try { await api("/keys", { json: { text } }); $("type-text").value = ""; toast("Typed on your Mac"); } catch (err) { toast(err.message, true); }
  });

  // ---------- go ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  // A Home Screen app can stay open for days: when it comes back and the relay
  // has a newer version, reload into it, unless something is in progress.
  const LOADED_VERSION = document.querySelector('meta[name="app-version"]')?.content || "";
  async function checkVersion() {
    if (!LOADED_VERSION || LOADED_VERSION.startsWith("__")) return;
    try {
      const v = (await (await fetch("/version", { cache: "no-store" })).json()).app;
      const busy = br.run || cloudBusy || !$("scrim").hidden || (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
      if (v && v !== LOADED_VERSION && !busy) location.reload();
    } catch { /* offline: try next time */ }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
  setInterval(() => { if (!document.hidden) checkVersion(); }, 5 * 60_000);
  setComposerMode();
  experience = window.createEchoExperience({
    cloud: cloudApi, show, view: () => currentView, tz: localTz, account: () => DEV, installation: INSTALLATION,
    toast, openSheet, closeSheets, hasSession: () => !!PASS, busy: () => cloudBusy || preparingCloud, typing: () => !!input.value.trim(),
    react: (expression) => window.echoCore?.react(expression), notifications: enableNotifications,
    legacyMessages: () => chatCache.filter((m) => m.src === "phone" && !m.threadId),
    setThread: (id, messages) => {
      currentThread = id;
      if (cloudBusy) return;
      chatCache = [...chatCache.filter((m) => m.src !== "phone" || (m.threadId && m.threadId !== id)), ...messages]; saveCache(); renderChat();
    },
    focusChat: () => input.focus(), openMemory: (id) => openMemory({ id }),
    ask: (text) => { mode = "phone"; store.set("echo_mode", "phone"); renderMode(); show("chat"); sendCloud(text); },
    draft: (text) => { mode = "phone"; store.set("echo_mode", "phone"); renderMode(); show("chat"); restoreInput(text); input.focus(); },
    snap: () => { mode = "phone"; store.set("echo_mode", "phone"); renderMode(); $("snap-file").click(); },
    restore: async (d) => {
      if (PASS) await cloudApi("/cloud/push/unsubscribe", { installation: INSTALLATION }).catch(() => {});
      cloudAbort?.abort(); stopPolling(); T = null; S = ""; store.set("echo_t", null); store.set("echo_s", null);
      DEV = d.device; store.set("echo_dev", DEV); savePass(d.cloudPass); mode = "phone"; store.set("echo_mode", "phone");
      currentThread = null; chatCache = []; store.set(CACHE_KEY, "[]"); cloudInfo = null; briefInfo = null; macOnline = false;
      mem.items = []; mem.upcoming = []; mem.open = null; memLoaded = false; snapCtx = null;
      renderChat(); renderMode(); refreshCloud();
      if ("Notification" in window && Notification.permission === "granted") enableNotifications().catch(() => {});
    },
  });
  renderChat();
  if (T && S) { start(); enter(); }
  else if (PASS) { mode = "phone"; store.set("echo_mode", "phone"); enter(); loadWeather(); }
  else showWelcome();
  refreshCloud().then(() => { if (params.get("view") && currentView !== "signin") openFromUrl(location.href); });
})();
