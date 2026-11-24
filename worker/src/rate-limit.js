import { sha256Hex } from "./http.js";

export async function rateBucket(prefix, ip, salt) {
  const material = `${prefix}|${salt || "sphere-demo-rate-limit"}|${ip || "unknown"}`;
  const hex = await sha256Hex(material);
  return `${prefix}:${hex.slice(0, 32)}`;
}

/**
 * Fixed-window counter in D1. Returns limited: true when this hit exceeds `limit`.
 * Fails closed when the caller lets a database error propagate.
 */
export async function consumeRateLimit(db, bucketKey, limit, windowMs, now = Date.now()) {
  const windowStart = now - (now % windowMs);
  const existing = await db
    .prepare("SELECT count FROM rate_limits WHERE bucket_key = ? AND window_start = ?")
    .bind(bucketKey, windowStart)
    .first();

  const count = existing ? Number(existing.count) : 0;
  if (count >= limit) {
    return { limited: true, remaining: 0 };
  }

  if (existing) {
    await db
      .prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket_key = ? AND window_start = ?")
      .bind(bucketKey, windowStart)
      .run();
  } else {
    try {
      await db
        .prepare("INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)")
        .bind(bucketKey, windowStart)
        .run();
    } catch {
      await db
        .prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket_key = ? AND window_start = ?")
        .bind(bucketKey, windowStart)
        .run();
    }
  }

  try {
    await db
      .prepare("DELETE FROM rate_limits WHERE window_start < ?")
      .bind(now - 48 * 60 * 60 * 1000)
      .run();
  } catch {
    // Cleanup is best-effort. A failed delete must not block the request.
  }

  const next = count + 1;
  return { limited: false, remaining: Math.max(0, limit - next) };
}

export function demoLimit(env) {
  return positiveInt(env && env.DEMO_RATE_LIMIT, 8);
}

export function demoWindowMs(env) {
  return positiveInt(env && env.DEMO_RATE_WINDOW_MS, 60 * 60 * 1000);
}

export function adminLoginLimit(env) {
  return positiveInt(env && env.ADMIN_LOGIN_RATE_LIMIT, 8);
}

export function adminLoginWindowMs(env) {
  return positiveInt(env && env.ADMIN_LOGIN_WINDOW_MS, 15 * 60 * 1000);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
