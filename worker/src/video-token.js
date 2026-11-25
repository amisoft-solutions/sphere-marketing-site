import { timingSafeEqual } from "./http.js";

const textEncoder = new TextEncoder();

export async function signVideoToken(secret, requestId, expiryEpoch) {
  const payload = `${requestId}.${expiryEpoch}`;
  const signature = await hmac(secret, payload);
  return `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
}

export async function verifyVideoToken(secret, token, nowEpoch = Math.floor(Date.now() / 1000)) {
  const raw = String(token || "");
  const splitAt = raw.indexOf(".");
  const payloadPart = splitAt === -1 ? "" : raw.slice(0, splitAt);
  const signaturePart = splitAt === -1 ? "" : raw.slice(splitAt + 1);
  let payload = "";
  let payloadOk = false;
  try {
    payload = base64UrlDecodeString(payloadPart);
    payloadOk = payloadPart.length > 0 && !payload.includes("\u0000");
  } catch {
    payloadOk = false;
  }
  const expected = await hmac(secret, payloadOk ? payload : "");
  let actual = new Uint8Array(expected.length);
  let actualOk = false;
  try {
    const decoded = base64UrlDecodeBytes(signaturePart);
    if (decoded.length === expected.length) {
      actual = decoded;
      actualOk = true;
    }
  } catch {
    actualOk = false;
  }
  const signatureOk = timingSafeEqual(toHex(expected), toHex(actual)) && actualOk && payloadOk;
  if (!signatureOk) return { ok: false, reason: "invalid" };
  const dot = payload.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "invalid" };
  const id = payload.slice(0, dot);
  const expiry = Number(payload.slice(dot + 1));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isInteger(expiry)) return { ok: false, reason: "invalid" };
  if (expiry < nowEpoch) return { ok: false, reason: "expired", id, expiry };
  return { ok: true, id, expiry };
}

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return new Uint8Array(signature);
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeString(value) {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}
