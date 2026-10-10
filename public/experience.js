/* The daily-work interface. Its small adapter keeps Mac control inside app.js. */
window.createEchoExperience = function (api) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (text, fn, cls = "glass small-pill") => { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", fn); return b; };
  const error = (e) => api.toast(e.message || "Couldn't update Echo. Try again.", true);
  const localDate = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: api.tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const localInput = (t) => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: api.tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const f = Object.fromEntries(p.map((p) => [p.type, p.value])); return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}`;
  };
  let daily = null, index = { folders: [], threads: [] }, thread = null, pendingThread = null, folder = "all", requestSerial = 0;
  const installation = api.installation;
  let account = api.account();
  function rememberThread(t) {
    thread = t; localStorage.setItem(`echo_thread_${account}`, t.id);
    $("conversation-title").textContent = t.title;
    $("conversation-open").setAttribute("aria-label", `${t.title}. Open conversations and folders`);
    api.setThread(t.id, t.messages || []);
  }
  async function ensureThread({ sync = false } = {}) {
    if (account !== api.account()) { account = api.account(); thread = null; pendingThread = null; }
    if (thread && !sync) return thread.id;
    if (pendingThread) return pendingThread;
    const currentAccount = account;
    const promise = (async () => {
      index = await api.cloud("/cloud/conversations");
      const legacy = api.legacyMessages();
      if (legacy.length && !localStorage.getItem(`echo_migrated_${account}`)) {
        const migration = await api.cloud("/cloud/conversations/migrate", { installation, messages: legacy });
        localStorage.setItem(`echo_migrated_${account}`, "1");
        if (migration.thread) localStorage.setItem(`echo_thread_${account}`, migration.thread.id);
        index = await api.cloud("/cloud/conversations");
      }
      const id = thread?.id || localStorage.getItem(`echo_thread_${account}`);
      const found = index.threads.find((t) => t.id === id) || index.threads[0];
      const result = found ? await api.cloud(`/cloud/conversations?id=${encodeURIComponent(found.id)}`) : await api.cloud("/cloud/conversations", { action: "create" });
      if (currentAccount === api.account()) rememberThread(result.thread);
      return result.thread.id;
    })().finally(() => { if (pendingThread === promise) pendingThread = null; });
    pendingThread = promise;
    return pendingThread;
  }
  async function newConversation() {
    if (api.busy()) return api.toast("Let Echo finish this reply first.");
    try {
      await ensureThread();
      const d = await api.cloud("/cloud/conversations", { action: "create", folderId: folder === "all" ? "inbox" : folder });
      rememberThread(d.thread); api.closeSheets(); api.show("chat"); api.focusChat();
    } catch (e) { error(e); }
  }
  function sheet(title) {
    let s = $("sheet-experience");
    if (!s) { s = node("section", "glass sheet experience-sheet"); s.id = "sheet-experience"; s.hidden = true; s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true"); s.setAttribute("aria-labelledby", "experience-heading"); document.body.appendChild(s); }
    s.replaceChildren();
    const head = node("header", "experience-head"), h = node("h2", "", title); h.id = "experience-heading";
    const close = button("Close", api.closeSheets, "glass pill"); head.append(h, close); s.append(head);
    const content = node("div", "experience-content"); s.append(content); api.openSheet(s.id); return content;
  }
  async function conversations() {
    const content = sheet("Conversations"); content.append(node("p", "sub small", "Loading your conversations…"));
    try {
      await ensureThread(); index = await api.cloud("/cloud/conversations");
      if (!$("sheet-experience").hidden) renderConversations(content);
    } catch (e) { content.replaceChildren(node("p", "err", e.message), button("Try again", conversations)); }
  }
  function renderConversations(content) {
    content.replaceChildren();
    const top = node("div", "daily-buttons"); top.append(button("New conversation", newConversation, "cta small-pill"), button("New folder", () => folderForm(content))); content.append(top);
    const filters = node("div", "folder-filters"); filters.setAttribute("aria-label", "Conversation folders");
    for (const f of [{ id: "all", name: "All" }, ...index.folders]) {
      const b = button(f.name, () => { folder = f.id; renderConversations(content); }); b.setAttribute("aria-pressed", String(folder === f.id)); filters.append(b);
    }
    content.append(filters);
    const list = node("div", "conversation-list"); content.append(list);
    for (const t of index.threads.filter((t) => folder === "all" || t.folderId === folder)) {
      const row = node("div", "conversation-row"), open = button("", async () => {
        if (api.busy()) return api.toast("Let Echo finish this reply first.");
        try { const d = await api.cloud(`/cloud/conversations?id=${encodeURIComponent(t.id)}`); rememberThread(d.thread); api.closeSheets(); api.show("chat"); } catch (e) { error(e); }
      }, "conversation-entry");
      open.append(node("b", "clamp1", t.title), node("span", "sub small clamp1", t.preview || "Start a thought"));
      if (t.id === thread?.id) open.setAttribute("aria-current", "true");
      const edit = button("···", () => editConversation(t), "bubble b44"); edit.setAttribute("aria-label", `Manage ${t.title}`); row.append(open, edit); list.append(row);
    }
    if (!list.children.length) list.append(node("p", "sub empty", "No conversations here yet."));
    if (!["all", "inbox"].includes(folder)) content.append(button("Remove folder", async () => {
      try { await api.cloud("/cloud/conversations", { action: "deleteFolder", id: folder }); folder = "all"; conversations(); } catch (e) { error(e); }
    }, "text-btn"));
    content.append(node("p", "sub tiny", "Echo organizes a clear topic as you talk. You can move or rename it here."));
  }
  function field(form, label, type = "text", value = "") {
    const id = `experience-field-${++requestSerial}`, wrapper = node("label", "experience-label", label), input = node("input", "glass experience-input");
    input.type = type; input.id = id; input.value = value; wrapper.htmlFor = id; wrapper.append(input); form.append(wrapper); return input;
  }
  function folderForm(content) {
    content.replaceChildren(); const form = node("form", "experience-form"), name = field(form, "Folder name"); name.maxLength = 40; name.required = true;
    const save = node("button", "cta big-btn", "Create folder"); form.append(save);
    form.addEventListener("submit", async (e) => { e.preventDefault(); save.disabled = true; try { const d = await api.cloud("/cloud/conversations", { action: "folder", name: name.value }); folder = d.folder.id; conversations(); } catch (e) { error(e); } finally { save.disabled = false; } });
    content.append(form, button("Back to conversations", conversations)); name.focus();
  }
  function editConversation(t) {
    const content = sheet("Conversation details"), form = node("form", "experience-form"), name = field(form, "Conversation name", "text", t.title);
    name.maxLength = 80; name.required = true;
    const label = node("label", "experience-label", "Folder"), select = node("select", "glass experience-input"); select.setAttribute("aria-label", "Folder");
    for (const f of index.folders) { const o = node("option", "", f.name); o.value = f.id; o.selected = f.id === t.folderId; select.append(o); }
    label.append(select); form.append(label); const save = node("button", "cta big-btn", "Save"); form.append(save);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); save.disabled = true;
      try { await api.cloud("/cloud/conversations", { action: "rename", id: t.id, title: name.value }); await api.cloud("/cloud/conversations", { action: "move", id: t.id, folderId: select.value }); if (thread?.id === t.id) { thread.title = name.value; $("conversation-title").textContent = name.value; } conversations(); } catch (e) { error(e); } finally { save.disabled = false; }
    });
    content.append(form, button("Delete conversation…", () => {
      content.replaceChildren(node("p", "sub small", "This removes the synced conversation from your Echo account. Saved notes and commitments remain."), button("Delete conversation", async () => {
        try { await api.cloud("/cloud/conversations", { action: "delete", id: t.id }); if (thread?.id === t.id) { thread = null; await ensureThread({ sync: true }); } conversations(); } catch (e) { error(e); }
      }, "glass big-btn danger-row"), button("Keep conversation", conversations));
    }, "text-btn danger-row"));
  }
  async function loadToday({ quiet = false } = {}) {
    if (!api.hasSession()) return;
    const requestedAccount = api.account();
    if (!daily && !quiet) $("today-body").replaceChildren(node("p", "sub empty", "Gathering your day…"));
    try {
      const d = await api.cloud(`/cloud/today?tz=${encodeURIComponent(api.tz())}`);
      if (requestedAccount !== api.account()) return;
      daily = d;
      $("today-date").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
      $("today-notifications").hidden = d.notifications || !d.rows.some((r) => r.status === "open");
      renderToday(); renderCuriosity();
    } catch (e) {
      if (!daily) $("today-body").replaceChildren(node("p", "err", e.message), button("Try again", () => loadToday()));
      else if (!quiet) error(e);
    }
  }
  function renderToday() {
    const content = $("today-body"); content.replaceChildren(); const now = Date.now(), date = localDate(now);
    const upcoming = [], seen = new Set();
    for (const r of daily.rows.filter((r) => r.due && localDate(r.due) > date)) {
      if (r.repeat && !r.snoozedUntil && seen.has(r.taskId)) continue;
      if (r.repeat && !r.snoozedUntil) seen.add(r.taskId);
      upcoming.push(r);
    }
    const groups = [
      ["Needs a moment", daily.rows.filter((r) => r.due && localDate(r.due) < date)],
      ["Today", daily.rows.filter((r) => r.due && localDate(r.due) === date)],
      ["Whenever you’re ready", daily.rows.filter((r) => !r.due)],
      ["Coming up", upcoming],
    ];
    for (const [title, rows] of groups) {
      if (!rows.length) continue;
      const section = node("section", "daily-group"); section.append(node("h2", "daily-group-title", title));
      for (const r of rows) section.append(dailyRow(r)); content.append(section);
    }
    if (!daily.rows.length) {
      const empty = node("section", "glass bcard daily-empty"); empty.append(node("span", "daily-empty-mark", "✓"), node("h2", "", "Room to breathe"), node("p", "sub small", "No commitments waiting here. Tell Echo what to keep track of, or add one with +.")); content.append(empty);
    }
    const calendar = node("section", "daily-group"); calendar.append(node("h2", "daily-group-title", "Your calendar"));
    for (const e of daily.events) {
      const row = node("div", "glass daily-item calendar-item"); row.append(node("b", "", e.title), node("p", "sub small", `${new Date(e.start).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}${e.location ? ` · ${e.location}` : ""}`)); calendar.append(row);
    }
    if (!daily.events.length) calendar.append(node("p", "sub small", daily.calendarUpdatedAt ? "No upcoming events in your latest calendar update." : "Connect your iPhone calendar in Settings to see its events here."));
    if (daily.calendarUpdatedAt) calendar.append(node("p", "sub tiny", `Last calendar update: ${new Date(daily.calendarUpdatedAt).toLocaleString()}`));
    calendar.append(button(daily.calendarUpdatedAt ? "Calendar settings" : "Connect calendar", () => api.show("settings"))); content.append(calendar);
    if (daily.completed.length) {
      const done = node("details", "daily-completed"), title = node("summary", "", `Done recently · ${daily.completed.length}`); done.append(title);
      for (const r of daily.completed) done.append(dailyRow(r, true)); content.append(done);
    }
  }
  function dailyRow(r, completed = false) {
    const row = node("article", `glass daily-item${completed ? " is-complete" : ""}`), label = node("div", "daily-kind", r.kind === "bill" ? "Bill" : r.kind === "reminder" ? "Reminder" : "Task");
    row.dataset.taskId = r.taskId;
    if (r.repeat) label.append(node("span", "", ` · ${r.repeat.interval > 1 ? `every ${r.repeat.interval} ` : ""}${r.repeat.frequency}`));
    row.append(label, node("b", "daily-title", r.text));
    if (r.due) row.append(node("p", "sub small", `${new Date(r.due).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${r.snoozedUntil ? " · snoozed" : ""}`));
    const actions = node("div", "daily-buttons");
    const done = button(completed ? "Undo" : "Done", async () => {
      done.disabled = true;
      try { await api.cloud("/cloud/today/action", { action: completed ? "undo" : "done", taskId: r.taskId, id: r.id }); api.react(completed ? "attentive" : "celebrate"); await loadToday(); } catch (e) { error(e); done.disabled = false; }
    }, completed ? "glass small-pill" : "cta small-pill"); actions.append(done);
    if (!completed) actions.append(button("Snooze", () => snooze(r)));
    if (r.source?.type === "memory") actions.append(button("Source", () => api.openMemory(r.source.ref)));
    else if (r.threadId) actions.append(button("Conversation", () => openReference({ type: "conversation", id: r.threadId })));
    const more = button("···", () => removeItem(r), "bubble b44 daily-more"); more.setAttribute("aria-label", `Manage ${r.text}`);
    row.append(more, actions); return row;
  }
  function removeItem(r) {
    const content = sheet(r.repeat ? "Remove recurring reminder?" : "Remove this item?");
    content.append(node("p", "sub small", r.repeat ? "This removes the series and all of its occurrences." : r.text), button("Remove", async () => { try { await api.cloud("/cloud/today/action", { action: "delete", taskId: r.taskId }); api.closeSheets(); loadToday(); } catch (e) { error(e); } }, "glass big-btn danger-row"));
  }
  function snooze(r) {
    const content = sheet("Give it a little room"), form = node("form", "experience-form");
    const saveUntil = async (until) => { await api.cloud("/cloud/today/action", { action: "snooze", taskId: r.taskId, id: r.id, until, tz: api.tz() }); api.closeSheets(); loadToday(); };
    const choices = node("div", "daily-buttons");
    for (const [label, ms] of [["In 1 hour", 3600_000], ["Tomorrow", 86400_000]]) choices.append(button(label, async () => { try { await saveUntil(localInput(Date.now() + ms)); } catch (e) { error(e); } }));
    content.append(node("p", "sub small", `${r.text}${r.repeat ? " · only this occurrence changes" : ""}`), choices);
    const until = field(form, "Or choose a time", "datetime-local", localInput(Date.now() + 3600_000)); until.required = true;
    const save = node("button", "cta big-btn", "Snooze"); form.append(save); content.append(form);
    form.addEventListener("submit", async (e) => { e.preventDefault(); save.disabled = true; try { await saveUntil(until.value); } catch (e) { error(e); } finally { save.disabled = false; } });
  }
  function captureForm() {
    const content = sheet("A little less to remember"), form = node("form", "experience-form"), text = field(form, "What needs doing?"); text.required = true; text.maxLength = 240;
    const when = field(form, "When? Leave empty for a task", "datetime-local");
    const label = node("label", "experience-label", "Repeats"), repeat = node("select", "glass experience-input"); repeat.setAttribute("aria-label", "Repeat reminder");
    for (const [value, name] of [["none", "Once"], ["daily", "Every day"], ["weekdays", "Weekdays"], ["weekly", "Every week"], ["monthly", "Every month"]]) { const o = node("option", "", name); o.value = value; repeat.append(o); }
    label.append(repeat); form.append(label); const save = node("button", "cta big-btn", "Keep track of this"); form.append(save); content.append(form);
    content.append(node("p", "sub small", "Or tell Echo naturally in Chat. No switches to turn on."));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); save.disabled = true;
      try { await api.cloud("/cloud/today", { text: text.value, when: when.value || null, repeat: repeat.value, tz: api.tz() }); api.closeSheets(); api.react("encouraging"); api.toast("Kept in Today"); loadToday(); } catch (e) { error(e); } finally { save.disabled = false; }
    }); text.focus();
  }
  function renderCuriosity() {
    const box = $("echo-curiosity"); box.replaceChildren(); box.hidden = !daily?.curiosity;
    if (!daily?.curiosity) return;
    const q = daily.curiosity, ask = button(q.question, () => { box.hidden = true; api.cloud("/cloud/curiosity/dismiss", { id: q.id, tz: api.tz() }).catch(() => {}); api.react("curious"); api.ask(q.prompt); }, "curiosity-question");
    const dismiss = button("×", async () => { box.hidden = true; try { await api.cloud("/cloud/curiosity/dismiss", { id: q.id, tz: api.tz() }); } catch (e) { error(e); } }, "curiosity-dismiss"); dismiss.setAttribute("aria-label", "Dismiss Echo's question for today"); box.append(ask, dismiss);
  }
  async function openReference(ref) {
    if (ref.type === "memory") return api.openMemory(ref.id);
    if (ref.type === "task") {
      api.show("today"); await loadToday();
      $("today-body").querySelector(`[data-task-id="${CSS.escape(ref.id)}"]`)?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      return;
    }
    try { const d = await api.cloud(`/cloud/conversations?id=${encodeURIComponent(ref.id)}`); rememberThread(d.thread); api.show("chat"); } catch (e) { error(e); }
  }
  async function loadAccount() {
    $("account-error").textContent = ""; $("account-key-result").hidden = true; $("recovery-key").value = "";
    $("account-key").hidden = !api.hasSession();
    if (!api.hasSession()) return;
    try {
      const d = await api.cloud("/cloud/account"); $("account-key").disabled = !d.durable;
      $("account-key").textContent = d.recoveryEnabled ? "Replace recovery key…" : "Create recovery key";
      $("account-status").textContent = d.durable ? `Echo account · ${d.account}. Phone conversations, tasks and Saved items sync across restored phones.${d.recoveryEnabled ? " Your recovery key is set up." : " Save a recovery key before changing phones."}` : "This server uses temporary storage. Recovery and durable sync need Upstash configured on the server.";
    } catch (e) { $("account-error").textContent = e.message; }
  }
  async function generateKey() {
    const b = $("account-key"); b.disabled = true;
    try { const d = await api.cloud("/cloud/account/key", {}); $("recovery-key").value = d.code; $("account-key-result").hidden = false; b.textContent = "Replace recovery key…"; } catch (e) { $("account-error").textContent = e.message; } finally { b.disabled = false; }
  }
  $("account-key").addEventListener("click", () => {
    if ($("account-key").textContent.startsWith("Replace")) { const content = sheet("Replace your recovery key?"); content.append(node("p", "sub small", "Your previous key will stop working. Save the new key somewhere private."), button("Replace key", () => { api.closeSheets(); generateKey(); }, "cta big-btn")); }
    else generateKey();
  });
  $("account-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("recovery-key").value); api.toast("Recovery key copied. Save it somewhere private."); } catch { $("recovery-key").select(); api.toast("Select and copy the key."); } });
  $("account-back").addEventListener("click", () => api.show(api.hasSession() ? "more" : "signin", { back: true }));
  $("account-recover").addEventListener("submit", async (e) => {
    e.preventDefault(); const b = e.target.querySelector("button"); b.disabled = true; $("account-error").textContent = "";
    try {
      const r = await fetch("/phone/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: $("account-code").value }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.message || "Couldn't recover this account.");
      $("account-code").value = ""; await api.restore(d); account = api.account(); thread = null; pendingThread = null; daily = null; await ensureThread(); api.show("today"); loadToday(); api.toast("Your Echo is here. Phone data is synced.");
    } catch (e) { $("account-error").textContent = e.message; } finally { b.disabled = false; }
  });
  $("conversation-open").addEventListener("click", conversations); $("conversation-new").addEventListener("click", newConversation);
  $("today-add").addEventListener("click", captureForm); $("today-refresh").addEventListener("click", () => loadToday());
  $("today-capture").addEventListener("submit", (e) => { e.preventDefault(); const input = $("today-thought"), text = input.value.trim(); if (!text) return; input.value = ""; api.ask(`Don't let me forget this: ${text}`); });
  $("today-allow").addEventListener("click", async () => { const b = $("today-allow"); b.disabled = true; try { await api.notifications(); api.toast("Reminder notifications are on"); loadToday(); } catch (e) { error(e); } finally { b.disabled = false; } });
  $("more-snap").addEventListener("click", () => api.snap());
  $("more-delegate").addEventListener("click", () => api.draft("Do this for me: "));
  async function onView(view) {
    if (view === "account") return loadAccount();
    if (!api.hasSession()) return;
    if (["today", "home"].includes(view)) loadToday({ quiet: view === "home" });
    if (view === "chat" && !api.busy()) try { await ensureThread({ sync: true }); } catch (e) { error(e); }
  }
  setInterval(() => {
    if (document.hidden || !api.hasSession() || api.busy()) return;
    if (["today", "home"].includes(api.view())) loadToday({ quiet: true });
    if (api.view() === "chat" && !api.typing()) ensureThread({ sync: true }).catch(() => {});
  }, 30_000);
  return { ensureThread, onView, openReference, afterReply: () => { thread = null; loadToday({ quiet: true }); }, reset: () => { account = api.account(); thread = null; daily = null; } };
};
