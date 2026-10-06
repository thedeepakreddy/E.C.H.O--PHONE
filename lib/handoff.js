/**
 * Hand-off: jobs the phone leaves for the Mac while it's away.
 *
 * The relay only holds them. Each job carries the phone's Face ID assertion
 * over the job's exact text; the relay can't check that (the Face ID key is on
 * the Mac) and doesn't need to: the Mac verifies every job before it runs, so
 * a job the relay invented or edited would be refused there. Here: shape
 * checks, a cap of waiting jobs, statuses, and tidying up.
 */
export const MAX_WAITING = 10;
export const MAX_TEXT = 2000;
export const KEEP_MS = 7 * 86400_000;
export const STATUSES = ["waiting", "started", "done", "failed", "rejected", "cancelled"];
export const FINAL = new Set(["done", "failed", "rejected", "cancelled"]);

const TASK_ID = /^[a-f0-9-]{8,40}$/;
const B64 = /^[A-Za-z0-9_-]+={0,2}$/;

function bad(message) { return Object.assign(new Error(message), { input: true }); }

/** The task as the phone signed it: the fields the Mac will hash, unchanged. */
export function checkTask(task, device, now) {
  if (!task || typeof task.id !== "string" || !TASK_ID.test(task.id)) throw bad("That job is malformed.");
  if (typeof task.text !== "string" || !task.text.trim() || task.text.length > MAX_TEXT) throw bad(`Write the job in up to ${MAX_TEXT} characters.`);
  if (!Number.isInteger(task.createdAt) || Math.abs(task.createdAt - now) > 10 * 60_000) throw bad("This phone's clock looks wrong. Check the time and try again.");
  return { id: task.id, text: task.text, createdAt: task.createdAt, device };
}

/** Only the shape: the Mac checks the signature itself. */
export function checkAssertion(a) {
  const r = a?.response;
  const ok = a && typeof a.id === "string" && a.id.length <= 512 && r
    && ["clientDataJSON", "authenticatorData", "signature"].every((k) => typeof r[k] === "string" && r[k].length <= 8192 && B64.test(r[k]));
  if (!ok) throw bad("That Face ID approval didn't come through. Try again.");
  return { id: a.id, rawId: typeof a.rawId === "string" ? a.rawId.slice(0, 512) : a.id, type: "public-key",
    response: { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: typeof r.userHandle === "string" ? r.userHandle.slice(0, 512) : null } };
}

/** What the phone sees about its jobs (never the assertions). */
export const forPhone = (item) => ({ id: item.task.id, text: item.task.text, createdAt: item.task.createdAt, status: item.status, summary: item.summary ?? null, updatedAt: item.updatedAt });

/** Drop finished jobs after a week, and jobs that waited longer than the Mac would accept. */
export function tidy(state, now) {
  state.items = (state.items ?? []).filter((i) => (FINAL.has(i.status) ? now - i.updatedAt < KEEP_MS : now - i.task.createdAt < KEEP_MS + 86400_000)).slice(-60);
  return state;
}

export function notificationFor(item) {
  const what = item.task.text.length > 60 ? `${item.task.text.slice(0, 57)}…` : item.task.text;
  if (item.status === "done") return { title: "Your Mac finished", body: `${what}${item.summary ? ` — ${item.summary.slice(0, 120)}` : ""}` };
  if (item.status === "failed") return { title: "Your Mac couldn't finish", body: `${what}${item.summary ? ` — ${item.summary.slice(0, 120)}` : ""}` };
  if (item.status === "rejected") return { title: "Your Mac refused a job", body: `${what} — ${(item.summary ?? "").slice(0, 120)}` };
  return null;
}
