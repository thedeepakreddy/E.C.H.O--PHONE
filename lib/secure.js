/**
 * Keys, the cloud pass, and sealed storage — all derived from RELAY_SECRET.
 *
 * Echo on the Mac and this relay share one secret already. Everything the
 * relay needs to protect is derived from it with HKDF, one key per purpose, so
 * nothing new has to be configured and no key is reused across jobs:
 *
 *   pass   signs cloud passes (the Mac issues them; the relay checks them)
 *   store  seals what is kept in Upstash, so the store only ever sees ciphertext
 *   cron   the bearer token the scheduler presents to /cron/tick
 *
 * The cloud pass format is mirrored exactly in Echo (src/frontier/cloudpass.ts);
 * a shared test vector keeps the two in step.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export function deriveKeys(secret) {
  const k = (info) => Buffer.from(hkdfSync("sha256", Buffer.from(String(secret)), Buffer.from("echo-relay"), Buffer.from(info), 32));
  return { pass: k("cloud-pass v1"), store: k("store v1"), cron: k("cron v1").toString("hex") };
}

/** A cloud pass lasts this long; the Mac renews it whenever it can. */
export const PASS_TTL_S = 30 * 86400;
export const DEVICE_ID = /^[0-9a-f]{32}$/;

const b64u = (b) => Buffer.from(b).toString("base64url");

export function signPass(key, { device, gen, now = Date.now(), ttlS = PASS_TTL_S }) {
  const iat = Math.floor(now / 1000);
  const body = b64u(JSON.stringify({ v: 1, d: device, iat, exp: iat + ttlS, g: gen }));
  return `cp1.${body}.${b64u(createHmac("sha256", key).update(`cp1.${body}`).digest())}`;
}

/** The pass's claims if it is genuine, unexpired and not revoked, else null. */
export function verifyPass(key, pass, { minGen = 0, now = Date.now() } = {}) {
  const m = /^cp1\.([A-Za-z0-9_-]{10,400})\.([A-Za-z0-9_-]{43})$/.exec(String(pass ?? ""));
  if (!m) return null;
  const want = createHmac("sha256", key).update(`cp1.${m[1]}`).digest();
  const got = Buffer.from(m[2], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { return null; }
  if (p?.v !== 1 || !DEVICE_ID.test(String(p.d)) || !Number.isInteger(p.exp) || !Number.isInteger(p.g)) return null;
  if (p.exp * 1000 <= now || p.g < minGen) return null;
  return { device: p.d, gen: p.g, iat: p.iat * 1000, exp: p.exp * 1000 };
}

/** AES-256-GCM over JSON: "v1." + base64url(iv | tag | ciphertext). */
export function seal(key, value) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `v1.${b64u(Buffer.concat([iv, c.getAuthTag(), ct]))}`;
}

export function unseal(key, text) {
  const s = String(text ?? "");
  if (!s.startsWith("v1.")) throw new Error("Not a sealed value.");
  const raw = Buffer.from(s.slice(3), "base64url");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}
