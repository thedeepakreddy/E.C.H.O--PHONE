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
  // The Mac signs a cloud pass for this phone when it signs in; with it, Phone
  // mode (Echo in the cloud) works even while the Mac is off. It can't reach the Mac.
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
  let mode = store.get("echo_mode") === "phone" ? "phone" : "mac";
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
  const TABS = ["home", "chat", "missions", "world", "settings"];
  let currentView = "signin", lastTab = store.get("echo_tab") || "home";
  function show(view) {
    if (view === "screen" && !(S && macOnline)) { toast("That needs your Mac, and it's offline right now.", true); return; }
    currentView = view;
    body.dataset.view = view;
    for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `v-${view}`;
    $("tabbar").hidden = view === "signin";
    for (const b of document.querySelectorAll("[data-tab]")) {
      if (b.dataset.tab === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    }
    if (TABS.includes(view)) { lastTab = view; store.set("echo_tab", view); }
    if (view === "home" && window.echoCore) window.echoCore.replay(); // the figure assembles every time
    if (view === "chat") { unread = 0; renderBadge(); setTimeout(scrollMessages, 30); pollChat(); }
    if (view === "world") loadWorld();
    if (view === "screen") openScreen(); else closeScreen();
    if (view === "missions" && last) renderMissions(last);
    if (view === "brain" && last) renderBrain(last);
  }
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) show(open.dataset.open);
    if (e.target.closest("[data-back]")) show(lastTab);
    if (e.target.closest("[data-close]")) closeSheets();
  });

  // ---------- sheets ----------
  function openSheet(id) {
    closeSheets();
    $("scrim").hidden = false;
    $(id).hidden = false;
  }
  function closeSheets() {
    $("scrim").hidden = true;
    document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
  }
  $("scrim").addEventListener("click", closeSheets);

  // ---------- sign in ----------
  const b64 = {
    toBuf: (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer,
    fromBuf: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  };
  const faceIdAllowed = () => store.get("echo_faceid") !== "off" && !!window.PublicKeyCredential;

  async function prepareSignIn() {
    show("signin");
    if (!T) { $("signin-form").hidden = true; $("no-link").hidden = false; return; }
    $("signin-form").hidden = false; $("no-link").hidden = true;
    $("faceid-login").hidden = true; $("signin-or").hidden = true;
    $("use-phone").hidden = !passValid();
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
  }
  /** Signed out of the Mac. `full` also forgets the cloud pass (Sign out of this phone). */
  function signedOut(message, { full = false } = {}) {
    S = ""; store.set("echo_s", null);
    stopPolling();
    if (full) { PASS = ""; store.set("echo_pass", null); cloudInfo = null; }
    if (!full && mode === "phone" && passValid()) {
      macOnline = false; renderMode();
      toast("Signed out of your Mac. Echo on your phone still works.");
      return;
    }
    prepareSignIn();
    if (message) $("signin-err").textContent = message;
  }
  $("use-phone").addEventListener("click", () => { setMode("phone"); enter(); refreshCloud(); });
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
  // A Home Screen app opened without its link (added from the bare address, or
  // its storage cleared): take the link pasted from Telegram instead.
  $("link-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = $("link-in").value.trim();
    const m = raw.match(/[?&]t=([0-9a-f]{32})\b/i) || raw.match(/^([0-9a-f]{32})$/i);
    if (!m) { $("link-err").textContent = "That doesn't look like your Echo link. Send /link to Echo on Telegram and copy the whole link."; return; }
    T = m[1].toLowerCase(); store.set("echo_t", T);
    $("link-in").value = ""; $("link-err").textContent = "";
    prepareSignIn();
  });
  $("faceid-login").addEventListener("click", async () => {
    try {
      const o = await fetch(u("/passkey/options?purpose=login")).then((r) => r.json());
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
      const d = await api(`/status?logs=${logsAfter}${passFresh() ? "" : `&pass=${DEV}`}`);
      if (d.cloudPass) { const had = passValid(); savePass(d.cloudPass); if (!had) refreshCloud(); }
      offline = false;
      last = d;
      for (const l of d.logs || []) { logsAfter = Math.max(logsAfter, l.id); if (l.kind !== "user") lastActivity = l; }
      macChip = (d.vitals && d.vitals.chip) ? d.vitals.chip.replace(/^Apple /, "Mac · ") : "Your Mac";
      markMac(true);
      if (currentView === "missions") renderMissions(d);
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
    macOnline = on;
    renderMode();
    renderBanners();
    if (on) syncToMac();
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
    const phone = mode === "phone";
    body.dataset.mode = mode;
    const h = new Date().getHours();
    $("greeting").textContent = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : h < 22 ? "Good evening" : "Good night";
    $("mac-dot").className = phone ? "dot cloud" : macOnline ? "dot ok" : "dot";
    $("mac-name").textContent = phone ? "Phone" : macOnline ? macChip : "Mac offline";
    $("set-mode").textContent = phone ? "Phone" : "Mac";
    $("mode-mac").setAttribute("aria-checked", String(!phone));
    $("mode-phone").setAttribute("aria-checked", String(phone));
    $("mode-phone").disabled = !passValid() && !phone;
    $("mode-mac-status").textContent = macOnline ? "Online now" : "Offline right now";
    $("mode-phone-status").textContent = passValid() ? cloudLine() : "Sign in once with your Mac online to turn this on.";
    $("set-cloud").textContent = passValid() ? cloudLine() : "Sign in with the Mac online first";
    if (phone) paintPhoneHome(); else if (macOnline && last) paintMacHome(last); else paintOffline();
    renderTyping(chatTyping || cloudBusy);
  }
  function paintPhoneHome() {
    const ready = !!(cloudInfo && cloudInfo.ready);
    body.dataset.status = cloudBusy ? "thinking" : "idle";
    $("state-label").textContent = cloudBusy ? "THINKING" : "ON YOUR PHONE";
    stateDot(cloudBusy ? "#b98cff" : "#5ee7f5");
    $("brain-name").textContent = !passValid() ? "Sign in with the Mac online" : ready ? prettyModel(cloudInfo.model) : cloudInfo ? "Not set up" : "";
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
  function setMode(m) {
    if (m === "phone" && !passValid()) return toast("Sign in once with your Mac online to turn on Phone mode.", true);
    mode = m; store.set("echo_mode", m);
    closeSheets();
    renderMode(); renderBanners();
    if (m === "phone") refreshCloud();
    if (m === "mac" && !S) prepareSignIn();
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
    const r = await fetch(path, {
      method: json ? "POST" : "GET",
      headers: { "x-echo-pass": PASS, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
      signal,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { PASS = ""; store.set("echo_pass", null); cloudInfo = null; renderMode(); }
    if (!r.ok) throw Object.assign(new Error(d.message || `HTTP ${r.status}`), { status: r.status, data: d });
    return d;
  }
  async function refreshCloud() {
    if (!passValid()) { cloudInfo = null; renderMode(); return; }
    try {
      cloudInfo = await cloudApi("/cloud/status");
      if (!S) markMac(!!cloudInfo.macOnline);
      briefInfo = await cloudApi("/cloud/briefing");
      renderBriefSettings();
    } catch { /* keep the last answer */ }
    renderMode();
  }
  setInterval(() => { if (!document.hidden) refreshCloud(); }, 20_000);
  function cloudProblem(e) {
    if (e.status === 401) return "Sign in once with your Mac online to use Phone mode.";
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
    if (window.speechSynthesis) speechSynthesis.cancel();
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

  // Home "Listen": talk to Echo; the answer is read out on this phone.
  let homeRec = null;
  $("act-listen").addEventListener("click", async () => {
    unlockSpeech();
    const btn = $("act-listen");
    if (!homeRec) {
      try { homeRec = await capture(); btn.setAttribute("aria-pressed", "true"); toast("Listening… tap again to send"); }
      catch (e) { toast(e.message || "Allow the microphone to talk to Echo.", true); }
      return;
    }
    const wav = homeRec.stop(); homeRec = null; btn.setAttribute("aria-pressed", "false");
    if (wav.byteLength < 44 + 16000) return toast("Too short — tap, speak, then tap again.", true);
    if (mode === "phone") return void sendCloudVoice(wav, { speak: speakHere });
    try { await api("/voice", { body: wav }); toast("Sent to Echo"); } catch { toast("Couldn't reach your Mac.", true); }
  });

  // ---------- replies read aloud on the phone ----------
  let speakHere = store.get("echo_speak") !== "off", firstEvents = true, eventsNext = 0, speechReady = false;
  function unlockSpeech() {
    if (speechReady || !window.speechSynthesis) return;
    speechReady = true;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch { /* fine */ }
  }
  document.addEventListener("pointerdown", unlockSpeech, { once: true });
  async function pollEvents() {
    const d = await api(`/events?since=${eventsNext}`);
    eventsNext = d.nextIndex || eventsNext;
    for (const it of d.items || []) {
      if (it.kind !== "reply" || firstEvents) continue;
      const text = String(it.line).replace(/^Echo:\s*/, "");
      if (mode === "mac") $("activity-line").textContent = text;
      if (speakHere) say(text);
    }
    firstEvents = false;
  }
  function say(text) {
    if (!window.speechSynthesis) return;
    const ut = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    ut.voice = voices.find((v) => /Daniel|Arthur|Samantha|Karen/.test(v.name)) || voices[0] || null;
    speechSynthesis.speak(ut);
  }

  // ---------- chat ----------
  // One conversation from two places: Echo on the Mac (Mac mode) and Echo in
  // the cloud (Phone mode). Both are kept on this phone, so the history shows
  // even with the Mac off, and Phone mode's messages are copied to the Mac's
  // chat once it's back (each with this phone's own id, so never twice).
  let chatAfter = 0, unread = 0, chatTyping = false, lastDay = "", chatLoaded = false, lastAt = 0;
  let cloudAbort = null, lastCloudLine = "";
  const messagesEl = $("messages");
  const CACHE_KEY = "echo_chat_cache", CACHE_MAX = 400;
  let chatCache = [];
  try { chatCache = JSON.parse(store.get(CACHE_KEY) || "[]").filter((m) => m && m.k && typeof m.text === "string"); } catch { chatCache = []; }
  let saveTimer = 0;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { chatCache = chatCache.slice(-CACHE_MAX); store.set(CACHE_KEY, JSON.stringify(chatCache)); }, 300);
  }
  const byTime = () => [...chatCache].sort((x, y) => x.at - y.at);
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
      putMessage({ k, at: m.at, from: m.from, text: m.text, kind: m.kind, src: m.via === "phone" ? "phone" : "mac" });
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
  async function sendChat(text = input.value) {
    text = String(text).trim();
    if (!text) return;
    restoreInput("");
    if (mode === "phone") return sendCloud(text);
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
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => sendChat(c.textContent)));
  // Tapping the conversation puts the keyboard away.
  messagesEl.addEventListener("click", () => input.blur());

  // ---------- Phone mode: asking Echo in the cloud ----------
  const shortcutList = () => String(store.get("echo_shortcuts") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
  function historyNow() { return byTime().slice(-20).map((m) => ({ role: m.from === "you" ? "user" : "echo", text: m.text })); }
  function localTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }
  function cloudContext() {
    const pl = place();
    const tz = localTz();
    return { tz, city: pl && pl.name !== "Current location" ? pl.name : undefined, lat: pl ? pl.lat : undefined, lon: pl ? pl.lon : undefined, shortcuts: shortcutList() };
  }
  function setCloudBusy(on) {
    cloudBusy = on;
    renderTyping(chatTyping || on);
    if (mode === "phone") paintPhoneHome();
  }
  async function askCloud(path, payload, { speak = false } = {}) {
    if (!passValid()) { toast("Sign in once with your Mac online to use Phone mode.", true); return null; }
    cloudAbort?.abort();
    const abort = (cloudAbort = new AbortController());
    setCloudBusy(true);
    try {
      const d = await cloudApi(path, { ...payload, context: cloudContext() }, { signal: abort.signal });
      const reply = { k: newKey(), at: Date.now(), from: "echo", text: d.reply, kind: "text", src: "phone", actions: d.actions || [], sources: d.sources || [] };
      putMessage(reply);
      prepareActions(reply);
      lastCloudLine = d.reply;
      if (d.usage && cloudInfo) cloudInfo.usage = d.usage;
      if (speak) say(d.reply);
      if (currentView !== "chat") { unread++; renderBadge(); }
      renderMode();
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
    const history = historyNow();
    const mine = { k: newKey(), at: Date.now(), from: "you", text, kind: "text", src: "phone" };
    putMessage(mine);
    const d = await askCloud("/cloud/chat", { text, history });
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
    const history = historyNow();
    const mine = { k: newKey(), at: Date.now(), from: "you", text: "Voice message", kind: "voice", src: "phone" };
    putMessage(mine);
    const d = await askCloud("/cloud/voice", { audio: toBase64(wav), history }, opts);
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
        btn.textContent = `Reminder set · ${eventWhen(a.data.start)}`;
        toast(`Echo will remind you ${eventWhen(a.data.start)}`);
      } catch (e) { toast(cloudProblem(e), true); }
      finally { btn.removeAttribute("aria-busy"); }
      return;
    }
    if (a.type === "mac") {
      if (!(S && macOnline)) return toast("Your Mac is offline. Try again when it's on.", true);
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
    unlockSpeech();
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
  let seg = "missions", armed = "";
  document.querySelectorAll("[data-seg]").forEach((b) => b.addEventListener("click", () => {
    seg = b.dataset.seg;
    document.querySelectorAll("[data-seg]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    ["missions", "agents", "projects"].forEach((k) => ($(`seg-${k}`).hidden = k !== seg));
  }));
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
  function renderMissions(d) {
    const box = $("seg-missions"); clear(box);
    const missions = d.missions || [];
    if (!missions.length) box.appendChild(Object.assign(el("div", "glass list"), {})).appendChild(el("p", "sub empty", "No missions yet. Ask Echo to build or research something."));
    const running = missions.filter((m) => m.status === "running"), done = missions.filter((m) => m.status !== "running");
    for (const m of running) {
      const steps = m.steps || [];
      const finished = steps.filter((s) => /^(done|completed)$/.test(s.status)).length;
      const pct = steps.length ? Math.round(finished / steps.length * 100) : 5;
      const card = el("section", "glass mission");
      const top = el("div", "mission-top"); top.appendChild(ring(pct));
      const txt = el("div", "grow"); txt.append(el("b", "", m.goal), el("span", "sub small", `${m.id.startsWith("supervised.") ? "Supervised" : "Mission"} · ${steps.length ? `step ${Math.min(finished + 1, steps.length)} of ${steps.length}` : "starting"} · ${dur(Date.now() - m.createdAt)}`));
      const live = el("span", "small row-i"); live.style.color = "#74f2a0"; live.append(el("span", "dot ok pulse"), document.createTextNode("Running"));
      top.append(txt, live); card.appendChild(top);
      if (steps.length) {
        const list = el("div", "steps");
        for (const s of steps.slice(0, 6)) { const r = el("div", `step ${s.status}`); r.append(el("i"), el("span", "clamp1", s.goal)); list.appendChild(r); }
        card.appendChild(list);
      }
      const btns = el("div", "btns2");
      const ask = el("button", "glass big-btn", "Ask about it");
      ask.addEventListener("click", () => { show("chat"); input.value = `How is "${m.goal}" going?`; autosize(); setComposerMode(); input.focus(); });
      const stop = el("button", `big-btn stop-btn${armed === m.id ? " armed" : ""}`, armed === m.id ? "Tap again to stop" : "Stop");
      stop.addEventListener("click", async () => {
        if (armed !== m.id) { armed = m.id; renderMissions(last); setTimeout(() => { if (armed === m.id) { armed = ""; renderMissions(last); } }, 3000); return; }
        armed = "";
        try { const r = await api("/action", { json: { type: "stop-mission", missionId: m.id } }); toast(r.message || "Stopped", !r.ok); } catch (e) { toast(e.message, true); }
      });
      btns.append(ask, stop); card.appendChild(btns); box.appendChild(card);
    }
    if (done.length) {
      const list = el("section", "glass list");
      for (const m of done.slice(0, 10)) {
        const r = el("div", "row"); const dot = el("span", "dot"); dot.style.background = m.status === "failed" ? "#ff6b6b" : "#3ee6b0";
        const t = el("div", "grow"); t.append(el("span", "clamp1", m.goal), el("span", "sub tiny", `${m.status[0].toUpperCase()}${m.status.slice(1)} · ${ago(m.updatedAt)}`));
        r.append(dot, t); list.appendChild(r);
      }
      box.appendChild(list);
    }
    const ag = $("seg-agents"); clear(ag);
    const agents = d.agents || [];
    const al = el("section", "glass list");
    if (!agents.length) al.appendChild(el("p", "sub empty", "No agents are working right now."));
    for (const a of agents) {
      const r = el("div", "row"); const av = el("span", "glass avatar-sq", (a.name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "AG");
      const t = el("div", "grow"); t.append(el("span", "clamp1", a.name), el("span", "sub tiny clamp1", a.progress || a.goal));
      const s = el("span", "small", a.status === "working" || a.status === "running" ? "Working" : a.status); s.style.color = /work|run/.test(a.status) ? "#74f2a0" : "";
      r.append(av, t, s); al.appendChild(r);
    }
    ag.appendChild(al);
    const pj = $("seg-projects"); clear(pj);
    const pl = el("section", "glass list");
    const colors = { completed: "#3ee6b0", implementing: "#5ee7f5", building: "#5ee7f5", verifying: "#5ee7f5" };
    if (!(d.projects || []).length) pl.appendChild(el("p", "sub empty", "No projects yet."));
    for (const p of d.projects || []) {
      const r = el("button", "row"); const t = el("div", "grow"); t.append(el("span", "clamp1", p.name), el("span", "sub tiny", `rev ${p.revision} · ${p.criteria} criteria · ${new Date(p.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`));
      const tag = el("span", "tag", p.phase[0].toUpperCase() + p.phase.slice(1)); tag.style.color = colors[p.phase] || "#ffb35c";
      r.append(t, tag);
      r.addEventListener("click", () => { show("chat"); input.value = p.phase === "completed" ? `Run the checks for the project "${p.name}".` : `Continue building the project "${p.name}".`; autosize(); setComposerMode(); input.focus(); });
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
      sw.setAttribute("aria-checked", "true"); toast("Face ID is on");
    } catch (e) { if (e && e.name !== "NotAllowedError") toast(e.message || "Couldn't turn on Face ID.", true); }
  });
  $("sw-speak").setAttribute("aria-checked", String(speakHere));
  $("sw-speak").addEventListener("click", () => {
    speakHere = !speakHere; store.set("echo_speak", speakHere ? "on" : "off");
    $("sw-speak").setAttribute("aria-checked", String(speakHere));
    if (!speakHere && window.speechSynthesis) speechSynthesis.cancel();
  });
  document.querySelectorAll("[data-voice]").forEach((s) => s.addEventListener("click", async () => {
    const value = s.getAttribute("aria-checked") !== "true";
    s.setAttribute("aria-checked", String(value));
    try { const r = await api("/action", { json: { type: "set-voice", key: s.dataset.voice, value } }); if (!r.ok) throw new Error(r.message); }
    catch (e) { s.setAttribute("aria-checked", String(!value)); toast(e.message || "Couldn't change that.", true); }
  }));
  $("sign-out").addEventListener("click", () => signedOut("", { full: true }));
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
    } catch { /* signed out below regardless */ }
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

  // ---------- morning briefing and notifications ----------
  function renderBriefSettings() {
    const on = !!(briefInfo && briefInfo.prefs && briefInfo.prefs.on && briefInfo.subscribed);
    $("sw-brief").setAttribute("aria-checked", String(on));
    if (briefInfo && briefInfo.prefs && document.activeElement !== $("brief-time") && document.activeElement !== $("brief-days")) {
      $("brief-time").value = briefInfo.prefs.time;
      $("brief-days").value = briefInfo.prefs.days;
    }
    $("brief-note").textContent = !passValid()
      ? "Sign in once with your Mac online to turn this on."
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
    await cloudApi("/cloud/push/subscribe", { subscription: sub.toJSON() });
    briefInfo = { ...(briefInfo || {}), subscribed: true };
  }
  $("sw-brief").addEventListener("click", async () => {
    if (!passValid()) return toast("Sign in once with your Mac online first.", true);
    const on = $("sw-brief").getAttribute("aria-checked") === "true";
    try {
      if (on) {
        await saveBriefPrefs({ on: false });
        await cloudApi("/cloud/push/unsubscribe", {});
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
  $("brief-refresh").addEventListener("click", () => briefNow());

  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function openBriefing() {
    if (!passValid()) return toast("Sign in once with your Mac online to get briefings.", true);
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
    if (b.calendar) box.appendChild(bcard("Calendar", b.calendar.length ? blist(b.calendar.map((e) => [e.time, e.title])) : el("p", "sub small", "Nothing on your calendar today."), asOf));
    else box.appendChild(bcard("Calendar", el("p", "sub small", "Your Mac hasn't shared your calendar yet. It does within a minute of Echo connecting.")));
    if (b.email && b.email.length) box.appendChild(bcard("Needs you", blist(b.email.map((m) => [null, `${m.from} — ${m.subject}`]))));
    if (b.reminders && b.reminders.length) box.appendChild(bcard("Reminders", blist(b.reminders.map((r) => [r.time, r.text]))));
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
      if (v === "briefing") openBriefing(); else if (v === "chat") show("chat");
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
  function closeScreen() { stopFrames(); }
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
  setComposerMode();
  renderChat();
  if (T && S) { start(); enter(); }
  else if (mode === "phone" && passValid()) enter();
  else prepareSignIn();
  refreshCloud().then(() => { if (params.get("view") && currentView !== "signin") openFromUrl(location.href); });
})();
