export function baseHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    ...extra,
  };
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: baseHeaders({
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    }),
  });
}

export function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf && cf.trim()) return cf.trim().slice(0, 80);
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded && forwarded.trim()) return forwarded.split(",")[0].trim().slice(0, 80);
  return "unknown";
}

export async function readJson(request, maxBytes = 20000) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      error: "Something went wrong while sending your request. Please try again.",
    };
  }
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "Something went wrong while sending your request. Please try again.",
    };
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "Something went wrong while sending your request. Please try again.",
    };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, status: 400, error: "Please check the form and try again." };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, status: 400, error: "Please check the form and try again." };
  }
}

export async function readBodyObject(request) {
  const type = (request.headers.get("Content-Type") || "").toLowerCase();
  if (type.includes("application/json")) {
    const parsed = await readJson(request);
    return parsed.ok ? parsed.data : {};
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) {
    const aCode = i < a.length ? a.charCodeAt(i) : 0;
    const bCode = i < b.length ? b.charCodeAt(i) : 0;
    diff |= aCode ^ bCode;
  }
  return diff === 0;
}

export function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

export function sessionCookie(token, { secure, maxAge, domain }) {
  const parts = [
    `sphere_admin=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function cookieIsSecure(request, env) {
  const flag = env && env.COOKIE_SECURE;
  if (flag === undefined || flag === null || flag === "") {
    return new URL(request.url).protocol === "https:";
  }
  return String(flag) !== "false";
}
