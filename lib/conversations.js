/** Phone conversations and folders, bounded and isolated by the authenticated account. */
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const fail = (s) => { throw Object.assign(new Error(s), { input: true }); };
export const conversationState = () => ({ folders: [{ id: "inbox", name: "Inbox" }], threads: [], migrated: [] });
export function newThread(st, raw, now, id) {
  if (st.threads.length >= 100) fail("You have 100 conversations. Remove an older one first.");
  const folder = st.folders.find((f) => f.id === raw.folderId)?.id ?? "inbox";
  const thread = { id, title: clip(raw.title, 80) || "New conversation", folderId: folder, at: now, messages: [], receipts: [] };
  st.threads.unshift(thread); return thread;
}
export function threadFor(st, id) { const t = st.threads.find((t) => t.id === id); if (!t) fail("That conversation no longer exists."); return t; }
export function changeConversation(st, raw, now, id) {
  if (raw.action === "create") return { thread: newThread(st, raw, now, id) };
  if (raw.action === "folder") {
    const name = clip(raw.name, 40); if (!name) fail("Give the folder a name.");
    const existing = st.folders.find((f) => f.name.toLowerCase() === name.toLowerCase()); if (existing) return { folder: existing };
    if (st.folders.length >= 30) fail("You have 30 folders. Use an existing one.");
    const folder = { id, name }; st.folders.push(folder); return { folder };
  }
  if (raw.action === "deleteFolder") {
    if (raw.id === "inbox") fail("Inbox stays available for new conversations.");
    st.folders = st.folders.filter((f) => f.id !== raw.id);
    for (const t of st.threads) if (t.folderId === raw.id) t.folderId = "inbox";
    return { ok: true };
  }
  const t = threadFor(st, raw.id);
  if (raw.action === "rename") { const title = clip(raw.title, 80); if (!title) fail("Give the conversation a name."); t.title = title; }
  else if (raw.action === "move") { if (!st.folders.some((f) => f.id === raw.folderId)) fail("That folder no longer exists."); t.folderId = raw.folderId; }
  else if (raw.action === "delete") st.threads = st.threads.filter((x) => x !== t);
  else fail("Unknown conversation action.");
  return { ok: true };
}
export function migrateConversations(st, raw, now, id) {
  const key = clip(raw.installation, 80); if (!/^[a-zA-Z0-9_-]{8,80}$/.test(key)) fail("Invalid installation.");
  if (st.migrated.includes(key)) return { thread: st.threads.find((t) => t.migration === key) ?? null };
  const items = Array.isArray(raw.messages) ? raw.messages.filter((m) => m?.src === "phone" && typeof m.text === "string").slice(-400) : [];
  let t = null;
  if (items.length) {
    t = newThread(st, { title: "Earlier conversations" }, now, id); t.migration = key;
    const seen = new Set();
    t.messages = items.filter((m) => { if (seen.has(m.k)) return false; seen.add(m.k); return true; }).map((m) => ({ k: clip(m.k, 80), at: Number(m.at) || now, from: m.from === "you" ? "you" : "echo", text: clip(m.text, 12000), src: "phone", kind: "text", threadId: t.id }));
  }
  st.migrated = [...st.migrated, key].slice(-100); return { thread: t };
}
export function conversationIndex(st) {
  return { folders: st.folders, threads: st.threads.map(({ messages, receipts, ...t }) => ({ ...t, count: messages.length, preview: messages.at(-1)?.text.slice(0, 120) ?? "" })).sort((a, b) => b.at - a.at) };
}
export function recordTurn(t, { requestId, text, result, now }) {
  if (t.receipts.some((r) => r.id === requestId)) return;
  const messages = [
    { k: requestId, at: now, from: "you", text: text || result.transcript || "Voice message", kind: text ? "text" : "voice", src: "phone", threadId: t.id },
    { k: `${requestId}-echo`, at: now + 1, from: "echo", text: result.reply, kind: "text", src: "phone", threadId: t.id,
      actions: result.actions, sources: result.sources, saved: result.saved, captures: result.captures, references: result.references },
  ];
  t.messages = [...t.messages, ...messages].slice(-400); t.at = now;
  if (t.title === "New conversation") t.title = messages[0].text.replace(/\s+/g, " ").slice(0, 65);
  t.receipts = [...t.receipts, { id: requestId, result }].slice(-8);
}
export function searchConversations(st, query) {
  const words = clip(query, 200).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const t of st.threads) for (const m of t.messages) {
    if (m.from !== "you") continue;
    const score = words.filter((w) => m.text.toLowerCase().includes(w)).length;
    if (score) hits.push({ id: t.id, type: "conversation", title: t.title, text: m.text.slice(0, 1500), at: m.at, score });
  }
  return hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 4);
}
