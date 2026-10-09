/* Admin credentials stay in an HttpOnly session cookie; only its CSRF token lives in this page. */
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = "", generation = 0, data = null, page = "overview", usersPage = 0, selectedUser = null, pendingAction = null, refreshing = false;
  const labels = { suspend: "Suspend Phone access", resume: "Restore Phone access", disable_notifications: "Disconnect notifications", reset_recovery: "Revoke recovery key" };
  const descriptions = {
    suspend: "This account will lose Phone access and stop receiving notifications until you restore it. Saved data is kept. This does not close its separate Mac sign-in.",
    resume: "This account can use Echo Phone again. Its existing valid sessions and notification subscriptions become available.",
    disable_notifications: "Disconnect every push subscription on this account. Users can enable notifications again from their phones. Tasks and reminders are kept.",
    reset_recovery: "The existing recovery key will stop working. Signed-in phones remain connected and can create a new key. A user without another signed-in phone could lose access.",
  };
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const date = (t) => t ? new Date(t).toLocaleString() : "Not recorded";
  const empty = (container, message) => container.replaceChildren(node("p", message, "empty"));
  function notice(message = "") { $("notice").textContent = message; $("notice").hidden = !message; }
  function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $("toast").hidden = true; }, 5000); }
  function showLogin() {
    ++generation; csrf = ""; data = null; selectedUser = null; pendingAction = null;
    $("console").hidden = true; $("login-view").hidden = false; $("logout").hidden = true;
    for (const id of ["stats", "connections", "version-details", "usage-details", "recent-problems", "problem-list", "audit-list", "user-list", "user-detail", "user-actions"]) $(id).replaceChildren();
    for (const id of ["user-dialog", "confirm-dialog"]) if ($(id).open) $(id).close();
    $("user-title").textContent = ""; $("user-id").textContent = "";
  }
  async function api(path, body) {
    const res = await fetch(`/admin/api/${path}`, { credentials: "same-origin", cache: "no-store", method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json", "x-echo-admin-csrf": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await res.json();
    if (!res.ok) { if (res.status === 401 && path !== "login") { showLogin(); $("login-note").textContent = "Your admin session ended. Sign in again."; } throw new Error(value.message || "Admin request failed."); }
    return value;
  }
  async function openConsole(session) {
    ++generation; csrf = session.csrf; $("login-view").hidden = true; $("console").hidden = false; $("logout").hidden = false;
    $("password").value = ""; await refresh();
  }
  function showPage(next) {
    page = next; $("page-title").textContent = { overview: "Overview", users: "Users", problems: "Problems", activity: "Activity" }[next];
    for (const section of document.querySelectorAll(".page")) section.hidden = section.id !== next;
    for (const b of document.querySelectorAll("nav button")) { b.classList.toggle("selected", b.dataset.page === next); if (b.dataset.page === next) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
    if (next === "users") void loadUsers();
  }
  document.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));
  function stat(value, label, detail) { const e = node("div", null, "stat"); e.append(node("strong", String(value)), node("p", label), node("span", detail, "muted")); return e; }
  function connection(title, description, state, tone = "") {
    const e = node("div", null, "connection"), text = node("div"); text.append(node("b", title), node("p", description, "muted")); e.append(text, node("span", state, `badge ${tone}`)); return e;
  }
  function details(container, items) { container.replaceChildren(); for (const [label, value] of items) container.append(node("dt", label), node("dd", String(value))); }
  function renderProblem(container, list) {
    container.replaceChildren(); if (!list.length) return empty(container, "No problems recorded in this server run.");
    for (const p of list) {
      const e = node("article", null, "problem"), title = node("div", null, "problem-title");
      title.append(node("b", p.operation), node("span", p.status ? `HTTP ${p.status}` : p.code.replaceAll("_", " "), `badge ${p.status >= 500 ? "bad" : "warn"}`));
      const meta = node("div", null, "meta"); meta.append(node("span", date(p.at)), node("span", p.source === "phone" ? `${p.platform} · ${p.installed ? "Home Screen" : "Browser"}` : "Server"));
      if (p.account) meta.append(node("span", `Account …${p.account.slice(-6)}`));
      if (p.requestId) meta.append(node("span", `Request ${p.requestId}`));
      if (p.app) meta.append(node("span", `App ${p.app}`));
      e.append(title, node("p", p.hint, "muted small"), meta); container.append(e);
    }
  }
  function render() {
    const d = data;
    $("stats").replaceChildren(stat(d.users.total, "Phone accounts", `${d.users.recentlyActive} active in the last 24 hours`), stat(d.requests.requests, "API requests", `${d.requests.averageMs} ms average`), stat(d.requests.failures, "Server failures", `${d.requests.limited} rate-limited requests`), stat(d.mac.waitingJobs, "Waiting Mac jobs", `${d.mac.queued} relay requests queued`));
    $("connections").replaceChildren(
      connection("Phone AI", d.brain.model || "No model configured. Check GEMINI_API_KEY on Render.", d.brain.configured ? "Configured" : "Missing", d.brain.configured ? "" : "bad"),
      connection("Account storage", d.storage.durable ? "Durable storage answered the current read." : "Temporary memory. Accounts and saved data do not survive a restart.", d.storage.durable ? "Connected" : "Temporary", d.storage.durable ? "" : "warn"),
      connection("Echo Mac", d.mac.online ? `Last contact: ${date(d.mac.lastSeenAt)}` : "Optional connection. Phone works independently.", d.mac.online ? "Online" : "Offline", d.mac.online ? "" : "warn"),
      connection("Reminders", `Last successful tick: ${date(d.tick.lastSuccessAt)}. Scheduled callback: ${date(d.tick.lastScheduledAt)}.`, d.tick.failed ? "Tick failed" : d.tick.lastSuccessAt ? "Running" : "Waiting", d.tick.failed ? "bad" : d.tick.lastSuccessAt ? "" : "warn")
    );
    const dl = $("version-details"); details(dl, [["App version", d.app], ["Git commit", d.commit ? d.commit.slice(0, 12) : "Local / unavailable"], ["Server uptime", `${Math.floor(d.uptimeSeconds / 60)} minutes`], ["Node runtime", d.node], ["Reports since", date(d.collectedSince)], ["Scheduled wake-up", d.schedulerConfigured ? "Configured" : "Not configured"]]);
    if (d.usage) details($("usage-details"), [["Messages", `${d.usage.messages} / ${d.usage.messageCap}`], ["Scans", `${d.usage.snaps} / ${d.usage.snapCap}`], ["Browser steps", `${d.usage.browse} / ${d.usage.browseCap}`], ["AI requests", `${d.usage.requests}${d.usage.limit ? ` / ${d.usage.limit}` : " · provider limit unknown"}`], ["Quota resets", date(d.usage.resetsAt)]]);
    else empty($("usage-details"), "Phone AI is not configured.");
    renderProblem($("recent-problems"), d.problems.slice(0, 3)); renderProblems();
    $("audit-list").replaceChildren();
    if (!d.audit.length) empty($("audit-list"), "No admin account actions yet.");
    for (const a of d.audit) { const e = node("div", null, "audit-row"); e.append(node("b", labels[a.action] || "Account action"), node("p", `Account …${a.account.slice(-6)} · ${date(a.at)}`, "muted small")); $("audit-list").append(e); }
    $("updated").textContent = `Updated ${new Date().toLocaleTimeString()} · refreshes every 30 seconds`;
  }
  function renderProblems() { if (data) renderProblem($("problem-list"), data.problems.filter((p) => $("problem-filter").value === "all" || p.source === $("problem-filter").value)); }
  $("problem-filter").addEventListener("change", renderProblems);
  async function refresh() {
    if (!csrf || refreshing) return; refreshing = true; const run = generation; $("refresh").disabled = true;
    try { const next = await api("overview"); if (run !== generation) return; data = next; render(); notice(); if (page === "users") await loadUsers(); }
    catch (e) { if (run === generation) notice(`${e.message} Last displayed data may be out of date.`); }
    finally { refreshing = false; $("refresh").disabled = false; }
  }
  async function loadUsers() {
    const run = generation, requestedPage = usersPage, q = $("user-search").value.trim();
    try {
      const r = await api(`users?page=${usersPage}&q=${encodeURIComponent(q)}`);
      if (run !== generation || requestedPage !== usersPage || q !== $("user-search").value.trim()) return;
      $("user-list").replaceChildren();
      if (!r.items.length) empty($("user-list"), "No accounts match this search.");
      for (const u of r.items) {
        const row = node("div", null, "user-row"), summary = node("div"), extra = node("div", null, "user-extra");
        summary.append(node("b", `Account …${u.account}`), node("p", u.status, `small ${u.status === "suspended" ? "error" : "muted"}`));
        extra.append(node("p", `Last active: ${date(u.lastSeenAt)}`, "small muted"), node("p", `${u.tasks} tasks · ${u.notifications} notification connections · Recovery ${u.recovery ? "on" : "off"}`, "small muted"));
        const button = node("button", "Manage"); button.setAttribute("aria-label", `Manage account ${u.account}`); button.addEventListener("click", () => void openUser(u.id)); row.append(summary, extra, button); $("user-list").append(row);
      }
      $("user-count").textContent = `${r.total} accounts · Page ${r.page + 1}`; $("prev").disabled = r.page === 0; $("next").disabled = (r.page + 1) * r.pageSize >= r.total;
    } catch (e) { if (run === generation) notice(e.message); }
  }
  async function openUser(id) {
    const run = generation;
    try { const r = await api(`users/${id}`); if (run !== generation) return; selectedUser = r.user;
      $("user-title").textContent = `Account …${r.user.account}`; $("user-id").textContent = r.user.id;
      const dl = node("dl"); details(dl, [["Status", r.user.status], ["First seen", date(r.user.createdAt)], ["Last active", date(r.user.lastSeenAt)], ["Recovery", r.user.recovery ? "Enabled" : "Not configured"], ["Mac pairing", r.user.paired ? "Previously paired" : "Standalone / unknown"], ["Notifications", r.user.notifications], ["Tasks", r.user.tasks], ["Conversations", r.user.conversations], ["Saved items", r.user.saved], ["Scans", r.user.scans]]); $("user-detail").replaceChildren(dl);
      $("user-actions").replaceChildren();
      for (const action of [r.user.status === "suspended" ? "resume" : "suspend", "disable_notifications", "reset_recovery"]) {
        const b = node("button", labels[action], action === "resume" ? "primary" : "danger"); b.disabled = action === "reset_recovery" && !r.user.recovery || action === "disable_notifications" && !r.user.notifications;
        b.addEventListener("click", () => { pendingAction = { id: r.user.id, action }; $("confirm-title").textContent = `${labels[action]}?`; $("confirm-text").textContent = descriptions[action]; $("confirm-dialog").showModal(); }); $("user-actions").append(b);
      }
      if (!$("user-dialog").open) $("user-dialog").showModal();
    } catch (e) { toast(e.message); }
  }
  $("close-user").addEventListener("click", () => $("user-dialog").close());
  $("cancel-action").addEventListener("click", () => { pendingAction = null; $("confirm-dialog").close(); });
  $("confirm-action").addEventListener("click", async () => {
    if (!pendingAction) return; const action = pendingAction, run = generation; $("confirm-action").disabled = true;
    try { const result = await api("users/action", action); if (run !== generation) return; $("confirm-dialog").close(); pendingAction = null; toast(result.auditStored ? "Account updated." : "Account updated, but the activity record could not be saved."); await openUser(action.id); await refresh(); if (page !== "users") await loadUsers(); }
    catch (e) { toast(e.message); } finally { $("confirm-action").disabled = false; }
  });
  $("search-form").addEventListener("submit", (e) => { e.preventDefault(); usersPage = 0; void loadUsers(); });
  $("prev").addEventListener("click", () => { usersPage = Math.max(0, usersPage - 1); void loadUsers(); });
  $("next").addEventListener("click", () => { usersPage++; void loadUsers(); });
  $("refresh").addEventListener("click", () => void refresh());
  $("export").addEventListener("click", () => {
    if (!data) return; const { audit, problems, ...rest } = data;
    const exported = { ...rest, problems: problems.map(({ account, ...p }) => p), adminActions: audit.map(({ account, ...a }) => a) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
    const a = node("a"); a.href = url; a.download = `echo-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast("Diagnostics exported without account IDs.");
  });
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault(); $("login-button").disabled = true; $("login-note").textContent = "Signing in…";
    try { await openConsole(await api("login", { password: $("password").value })); }
    catch (e) { $("login-note").textContent = e.message; } finally { $("login-button").disabled = false; }
  });
  $("logout").addEventListener("click", async () => { try { await api("logout", {}); showLogin(); $("login-note").textContent = "Signed out."; } catch (e) { toast(e.message); } });
  setInterval(() => { if (!document.hidden && csrf) void refresh(); }, 30_000);
  window.addEventListener("pageshow", () => { if (csrf) void refresh(); });
  api("session").then((s) => { if (s.authenticated) return openConsole(s); $("login-note").textContent = s.configured ? "Use the owner password. Normal Echo accounts cannot open admin." : "Admin access is not configured. Set ECHO_ADMIN_PASSWORD on Render to a private password of at least 24 characters."; }).catch((e) => { $("login-note").textContent = e.message; });
})();
