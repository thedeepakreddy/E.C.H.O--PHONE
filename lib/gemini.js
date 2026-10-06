/**
 * A small Gemini client: one generateContent call, with the free tier's limits
 * understood rather than treated as failures.
 *
 * A 429 says which limit was hit. A per-minute limit is waited out once (if
 * Google says the wait is short); a per-day limit is reported with its size,
 * so Phone mode can show "37 of 1,000 today" from Google's own numbers.
 */
export class GeminiError extends Error {
  /** kind: "auth" | "minute" | "day" | "server" | "blocked" | "other" */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function classify(status, data) {
  const err = data?.error ?? {};
  const message = String(err.message ?? `HTTP ${status}`);
  if (status === 429) {
    const details = Array.isArray(err.details) ? err.details : [];
    const violations = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations : []));
    const day = violations.find((v) => /PerDay/i.test(String(v?.quotaId ?? v?.quotaMetric ?? "")));
    const retry = details.find((d) => d?.retryDelay)?.retryDelay;
    const retryMs = retry ? Math.round(parseFloat(String(retry)) * 1000) : 0;
    if (day) return new GeminiError("day", message, { limit: Number(day.quotaValue) || null, retryMs });
    return new GeminiError("minute", message, { retryMs });
  }
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(message))) return new GeminiError("auth", message);
  if (status >= 500) return new GeminiError("server", message);
  return new GeminiError("other", message);
}

export function createGemini({
  apiKey, model, base = "https://generativelanguage.googleapis.com/v1beta",
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  async function generate(body, { modelId = model, onRequest = () => {} } = {}) {
    for (let attempt = 0; ; attempt++) {
      onRequest();
      let res, data;
      try {
        res = await fetchImpl(`${base.replace(/\/+$/, "")}/models/${encodeURIComponent(modelId)}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        if (attempt === 0) { await sleep(1500); continue; }
        throw new GeminiError("server", String(e?.message ?? e));
      }
      if (res.ok) return data;
      const err = classify(res.status, data);
      if (attempt === 0 && err.kind === "minute" && (err.retryMs || 0) <= 12_000) { await sleep(err.retryMs || 3000); continue; }
      if (attempt === 0 && err.kind === "server") { await sleep(1500); continue; }
      throw err;
    }
  }
  return { model, generate };
}
