/**
 * Web Push: notifications to the phone, with no third-party library.
 *
 * Two standards, both small:
 *   - VAPID (RFC 8292): the relay proves who it is to Apple's push service
 *     with a signed token. Its key is derived from RELAY_SECRET, so it stays the
 *     same across restarts and nothing new needs configuring.
 *   - Message encryption (RFC 8291, aes128gcm): every notification is encrypted
 *     for the phone's own key, so the push service only ever carries ciphertext.
 * Checked against RFC 8291's published example in test/briefing.test.mjs.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s ?? ""), "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** The relay's VAPID key pair, derived from RELAY_SECRET. */
export function vapidKeys(secret) {
  let d;
  for (let i = 0; ; i++) {
    d = Buffer.from(hkdfSync("sha256", Buffer.from(String(secret)), Buffer.from("echo-relay"), Buffer.from(`vapid v1/${i}`), 32));
    const n = BigInt(`0x${d.toString("hex")}`);
    if (n > 0n && n < P256_ORDER) break;
  }
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const privateKey = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  return { privateKey, publicKey: b64u(pub) };
}

/** RFC 8291 encryption of one notification for one subscription. */
export function encryptPayload(plaintext, keys, { asPrivate, salt = randomBytes(16) } = {}) {
  const uaPublic = fromB64u(keys?.p256dh);
  const authSecret = fromB64u(keys?.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("That notification subscription has bad keys.");
  const ecdh = createECDH("prime256v1");
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export function vapidAuthorization(endpoint, vapid, { contact, now = Date.now() }) {
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: vapid.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Only real push services: a subscription can't make the relay call anything else. */
export function validSubscription(sub) {
  try {
    const u = new URL(String(sub?.endpoint));
    return u.protocol === "https:" && /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(u.hostname)
      && fromB64u(sub?.keys?.p256dh).length === 65 && fromB64u(sub?.keys?.auth).length >= 16;
  } catch { return false; }
}

/**
 * Send one notification. `gone` means the phone has unsubscribed (or the app
 * was removed): the subscription should be forgotten.
 */
export async function sendPush(sub, message, { vapid, contact, fetchImpl = fetch, now = Date.now(), ttl = 86400, urgency = "normal" }) {
  const payload = Buffer.from(JSON.stringify(message));
  const res = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidAuthorization(sub.endpoint, vapid, { contact, now }),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency,
    },
    body: encryptPayload(payload, sub.keys),
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}
