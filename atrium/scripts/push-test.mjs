#!/usr/bin/env node
/**
 * Checks the Web Push code against the worked example in RFC 8291 (appendix A), then
 * decrypts a freshly encrypted message the way a browser would, and verifies a VAPID
 * signature. Build the module first:
 *   npx esbuild src/worker/push.ts --bundle --format=esm --platform=node --outfile=/tmp/push.mjs
 *   node scripts/push-test.mjs /tmp/push.mjs
 */
import { pathToFileURL } from "node:url";
const { encryptPush, vapidAuth } = await import(pathToFileURL(process.argv[2]).href);

const b64u = (b) => Buffer.from(b).toString("base64url");
const un = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const enc = new TextEncoder();
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const ecdhKeys = async (pub, priv) => {
  const p = un(pub);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)), ext: true };
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: priv }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
  };
};
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));

// RFC 8291, appendix A
const rfc = {
  text: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const fixed = await encryptPush(enc.encode(rfc.text), rfc.uaPublic, rfc.auth, { salt: un(rfc.salt), keys: await ecdhKeys(rfc.asPublic, rfc.asPrivate) });
check("matches the RFC 8291 example byte for byte", b64u(fixed) === rfc.body);

// Decrypt a randomly keyed message as the receiving browser would.
async function decrypt(body, uaPublic, uaPrivate, auth) {
  const salt = body.slice(0, 16), idLen = body[20], asPublic = body.slice(21, 21 + idLen), cipher = body.slice(21 + idLen);
  const ua = await ecdhKeys(uaPublic, uaPrivate);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(un(auth), shared, Buffer.concat([enc.encode("WebPush: info\0"), un(uaPublic), asPublic]), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), cipher));
  return new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)));
}
const message = JSON.stringify({ title: "Jen assigned you a task", body: "Send the price list — by Friday", url: "/tasks" });
const fresh = await encryptPush(enc.encode(message), rfc.uaPublic, rfc.auth);
check("a browser can decrypt a fresh message", (await decrypt(fresh, rfc.uaPublic, rfc.uaPrivate, rfc.auth)) === message);
check("two encryptions of one message differ", b64u(fresh) !== b64u(await encryptPush(enc.encode(message), rfc.uaPublic, rfc.auth)));

// VAPID: a signed token the push service can verify with the public key alone.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const env = { VAPID_PUBLIC_KEY: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)), VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d, MAIL_FROM: "App <app@example.com>" };
const header = await vapidAuth(env, "https://web.push.apple.com/abc123");
const [, jwt, key] = header.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
const [h, c, s] = (jwt ?? "").split(".");
const claims = JSON.parse(Buffer.from(c ?? "", "base64url").toString() || "{}");
check("VAPID token verifies with the public key", !!jwt && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, un(s), enc.encode(`${h}.${c}`))));
check("VAPID token names the push service, a contact and a near expiry", claims.aud === "https://web.push.apple.com" && claims.sub === "mailto:app@example.com" && claims.exp - Date.now() / 1000 < 24 * 3600 && key === env.VAPID_PUBLIC_KEY);
process.exit(failed ? 1 : 0);
