/**
 * Browser origins allowed to call the public API.
 * The production list is the ALLOWED_ORIGINS Worker var (see wrangler.toml).
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function allowedOriginList(env) {
  const configured = env && env.ALLOWED_ORIGINS;
  const source = typeof configured === "string" && configured.trim()
    ? configured
    : "https://www.spheresce.com";
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin, env) {
  if (!origin || typeof origin !== "string") return false;
  if (allowedOriginList(env).includes(origin)) return true;
  if (String(env && env.ALLOW_LOCALHOST != null ? env.ALLOW_LOCALHOST : "true") === "false") {
    return false;
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOCAL_HOSTS.has(url.hostname);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (!isAllowedOrigin(origin, env)) return headers;
  headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Accept";
  headers["Access-Control-Max-Age"] = "86400";
  return headers;
}
