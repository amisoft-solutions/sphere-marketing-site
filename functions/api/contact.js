const MAX = {
  name: 120,
  email: 200,
  company: 160,
  phone: 40,
  title: 120,
  interest: 40,
  message: 4000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTERESTS = new Set(["Demo", "Pilot", "Pricing", "Other"]);
// Public Cloudflare Turnstile dummy secret (always passes). Production must set TURNSTILE_SECRET.
const PREVIEW_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

function genericError() {
  return json(503, {
    ok: false,
    error: "We couldn’t send your message. Please try again in a moment.",
  });
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") data[key] = value;
    }
    return data;
  }
  return {};
}

function collect(raw) {
  return {
    name: clip(raw.name, MAX.name),
    email: clip(raw.email, MAX.email),
    company: clip(raw.company, MAX.company),
    phone: clip(raw.phone, MAX.phone),
    title: clip(raw.title, MAX.title),
    interest: clip(raw.interest, MAX.interest),
    message: clip(raw.message, MAX.message),
    company_url: clip(raw.company_url || raw.website, 200),
    token: clip(raw["cf-turnstile-response"] || raw.turnstileToken, 2048),
  };
}

function validate(fields) {
  if (!fields.name) return "Enter your name.";
  if (!fields.email) return "Enter your work email.";
  if (!EMAIL_RE.test(fields.email)) return "Enter a valid work email address.";
  if (!fields.company) return "Enter your company.";
  if (!fields.phone) return "Enter your phone number.";
  if (fields.phone.replace(/\D/g, "").length < 7) return "Enter a valid phone number.";
  if (!fields.title) return "Enter your job title.";
  if (fields.interest && !INTERESTS.has(fields.interest)) fields.interest = "";
  return null;
}

async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  try {
    const body = new URLSearchParams({
      secret,
      response: token,
    });
    if (ip) body.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return false;
    const result = await res.json();
    return Boolean(result && result.success);
  } catch (err) {
    return false;
  }
}

function escapeText(value) {
  return String(value || "").replace(/\r?\n/g, "\n");
}

function buildEmail(fields) {
  const interest = fields.interest || "Not specified";
  const message = fields.message || "(none)";
  const text = [
    "A new SPHERE contact form submission:",
    "",
    `Name: ${escapeText(fields.name)}`,
    `Work email: ${escapeText(fields.email)}`,
    `Company: ${escapeText(fields.company)}`,
    `Phone: ${escapeText(fields.phone)}`,
    `Job title: ${escapeText(fields.title)}`,
    `Interest: ${escapeText(interest)}`,
    "",
    "Message:",
    escapeText(message),
  ].join("\n");
  return {
    subject: "SPHERE website inquiry" + (fields.interest ? ` — ${fields.interest}` : ""),
    text,
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let raw;
  try {
    raw = await readBody(request);
  } catch (err) {
    return json(400, { ok: false, error: "We couldn’t read that submission. Please try again." });
  }

  const fields = collect(raw);
  if (fields.company_url) {
    return json(200, { ok: true });
  }

  const problem = validate(fields);
  if (problem) return json(400, { ok: false, error: problem });

  const secret = env.TURNSTILE_SECRET || PREVIEW_TURNSTILE_SECRET;
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const verified = await verifyTurnstile(fields.token, secret, ip);
  if (!verified) {
    return json(400, {
      ok: false,
      error: "Please complete the verification check, then try again.",
    });
  }

  const destination = env.CONTACT_TO;
  const sender = env.CONTACT_FROM || "SPHERE website <noreply@spheresce.com>";
  if (!destination || !env.CONTACT_EMAIL) {
    return genericError();
  }

  const email = buildEmail(fields);
  try {
    await env.CONTACT_EMAIL.send({
      to: destination,
      from: sender,
      replyTo: { email: fields.email, name: fields.name },
      subject: email.subject,
      text: email.text,
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error("contact email failed", err && err.code ? err.code : "unknown");
    return genericError();
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}
