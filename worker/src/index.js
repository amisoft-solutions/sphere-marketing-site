import { handleAdmin } from "./admin.js";
import { corsHeaders, isAllowedOrigin } from "./cors.js";
import { maybeNotify } from "./email.js";
import { baseHeaders, clientIp, json, readJson } from "./http.js";
import { consumeRateLimit, demoLimit, demoWindowMs, rateBucket } from "./rate-limit.js";
import { validateDemoRequest } from "./validate.js";

const RETRY = "Something went wrong while sending your request. Please try again.";

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/demo-requests") return await handleDemo(request, env);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(request, env);
    if (url.pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: "sphere-demo-requests" });
    }
    return new Response("Not found", {
      status: 404,
      headers: baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  } catch (err) {
    console.error("request failed", err && err.message);
    return json({ ok: false, error: RETRY }, 500);
  }
}

async function handleDemo(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && !isAllowedOrigin(origin, env)) {
    return json({ ok: false, error: RETRY }, 403, baseHeaders());
  }
  const headers = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders(headers) });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: RETRY }, 405, headers);
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status, headers);

  try {
    const bucket = await rateBucket("demo", clientIp(request), env && env.RATE_LIMIT_SALT);
    const hit = await consumeRateLimit(env.DB, bucket, demoLimit(env), demoWindowMs(env));
    if (hit.limited) {
      return json(
        { ok: false, error: "Too many requests. Please wait and try again." },
        429,
        headers
      );
    }
  } catch (err) {
    console.error("rate limit failed", err && err.message);
    return json({ ok: false, error: RETRY }, 503, headers);
  }

  const result = validateDemoRequest(parsed.data, Date.now());
  if (!result.ok) {
    if (result.code === "honeypot") {
      return json({ ok: false, error: result.error }, 400, headers);
    }
    return json(
      { ok: false, error: result.error, fields: result.fields || {} },
      400,
      headers
    );
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const value = result.value;
  try {
    await env.DB.prepare(
      `INSERT INTO demo_requests (
        id, created_at, updated_at, status, request_type, full_name, job_title,
        organization, work_email, phone, country, organization_type, interest,
        heard_about, consent_to_contact, user_agent
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        now,
        now,
        value.requestType,
        value.fullName,
        value.jobTitle,
        value.organization,
        value.workEmail,
        value.phone,
        value.country,
        value.organizationType,
        value.interest,
        value.heardAbout,
        value.consentToContact ? 1 : 0,
        userAgent(request)
      )
      .run();
  } catch (err) {
    console.error("store failed", err && err.message);
    return json({ ok: false, error: RETRY }, 500, headers);
  }

  try {
    await maybeNotify(
      env,
      { ...value, id, status: "pending", createdAt: now },
      { adminUrl: new URL("/admin", request.url).href }
    );
  } catch (err) {
    console.error("notification failed", err && err.message);
  }

  return json({ ok: true }, 201, headers);
}

function userAgent(request) {
  return (request.headers.get("User-Agent") || "").replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 300);
}
