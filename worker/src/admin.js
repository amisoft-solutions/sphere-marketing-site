import {
  baseHeaders,
  clientIp,
  cookieIsSecure,
  cookieValue,
  escapeHtml,
  readBodyObject,
  sessionCookie,
  sha256Hex,
  timingSafeEqual,
} from "./http.js";
import { approvalEmailEnabled, sendApprovalEmail } from "./email.js";
import { adminLoginLimit, adminLoginWindowMs, consumeRateLimit, rateBucket } from "./rate-limit.js";

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "sphere_admin";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ["pending", "approved", "rejected"];
export const ADMIN_HOST = "admin.spheresce.com";
export const APPROVAL_CLAIM_TTL_MS = 3 * 60 * 1000;
const STALE_CLAIM_ERROR = "The send did not finish. You can resend it.";

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const path = canonicalAdminPath(url);
  if (path === "/admin/login" && request.method === "POST") {
    return login(request, env);
  }
  if (path === "/admin/logout" && request.method === "POST") {
    return logout(request, env);
  }
  const resendMatch = path.match(/^\/admin\/requests\/([0-9a-f-]+)\/resend$/i);
  if (resendMatch && request.method === "POST") {
    return resendApproval(request, env, resendMatch[1]);
  }
  const sendMatch = path.match(/^\/admin\/requests\/([0-9a-f-]+)\/send$/i);
  if (sendMatch && request.method === "POST") {
    return sendApproval(request, env, sendMatch[1]);
  }
  const newLinkMatch = path.match(/^\/admin\/requests\/([0-9a-f-]+)\/new-link$/i);
  if (newLinkMatch && request.method === "POST") {
    return sendNewLink(request, env, newLinkMatch[1]);
  }
  const statusMatch = path.match(/^\/admin\/requests\/([0-9a-f-]+)$/i);
  if (statusMatch && request.method === "POST") {
    return updateStatus(request, env, statusMatch[1]);
  }
  if (path === "/admin" && request.method === "GET") {
    return listPage(request, env, url);
  }
  return text("Not found", 404);
}

function onAdminHost(request) {
  return new URL(request.url).hostname === ADMIN_HOST;
}

function adminRoute(request, suffix = "") {
  if (!onAdminHost(request)) return `/admin${suffix}`;
  if (!suffix) return "/";
  if (suffix.startsWith("?")) return `/${suffix}`;
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

function canonicalAdminPath(url) {
  if (url.hostname !== ADMIN_HOST) return url.pathname;
  const path = url.pathname;
  if (path === "/" || path === "") return "/admin";
  if (path === "/login" || path === "/logout" || path.startsWith("/requests/")) return `/admin${path}`;
  return path;
}

function cookieHeader(request, env, token, maxAge) {
  return sessionCookie(token, {
    secure: cookieIsSecure(request, env),
    maxAge,
    domain: onAdminHost(request) ? ADMIN_HOST : undefined,
  });
}

function queueLocation(request, returnStatus) {
  const status = String(returnStatus || "");
  const query = STATUSES.includes(status) ? `?status=${status}` : "";
  return adminRoute(request, query);
}

async function login(request, env) {
  const ip = clientIp(request);
  const bucket = await rateBucket("admin", ip, env.RATE_LIMIT_SALT);
  let limited = false;
  try {
    const hit = await consumeRateLimit(env.DB, bucket, adminLoginLimit(env), adminLoginWindowMs(env));
    limited = hit.limited;
  } catch (err) {
    console.error("admin rate limit failed", err && err.message);
    return html(loginDocument(request, "The sign-in page is temporarily unavailable. Please try again."), 503);
  }
  if (limited) {
    return html(loginDocument(request, "Too many sign-in attempts. Please wait and try again."), 429);
  }

  const body = await readBodyObject(request);
  const provided = typeof body.password === "string" ? body.password : "";
  const secret = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  const matches = secret ? await passwordsMatch(provided, secret) : await passwordsMatch(provided, "missing-admin-secret");
  if (!secret || !matches) {
    return html(loginDocument(request, "That password was not accepted."), 401);
  }

  const token = randomToken();
  const csrf = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MS);
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(await sha256Hex(token), csrf, now.toISOString(), expires.toISOString())
    .run();

  return new Response(null, {
    status: 303,
    headers: baseHeaders({
      Location: adminRoute(request),
      "Set-Cookie": cookieHeader(request, env, token, Math.floor(SESSION_MS / 1000)),
    }),
  });
}

async function logout(request, env) {
  const session = await loadSession(request, env);
  if (session) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(session.token_hash).run();
  }
  return new Response(null, {
    status: 303,
    headers: baseHeaders({
      Location: adminRoute(request),
      "Set-Cookie": cookieHeader(request, env, "", 0),
    }),
  });
}

async function listPage(request, env, url) {
  const session = await loadSession(request, env);
  if (!session) return html(loginDocument(request, ""), 200);
  await expireStaleApprovalClaims(env);
  const filter = normalizeFilter(url.searchParams.get("status"));
  const counts = await statusCounts(env.DB);
  const rows = filter === "all"
    ? await env.DB.prepare(
      "SELECT * FROM demo_requests ORDER BY created_at DESC LIMIT 200"
    ).all()
    : await env.DB.prepare(
      "SELECT * FROM demo_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200"
    ).bind(filter).all();
  return html(queueDocument(request, session.csrf_token, filter, counts, rows.results || [], approvalEmailEnabled(env)), 200);
}

async function updateStatus(request, env, id) {
  const session = await loadSession(request, env);
  if (!session) return html(loginDocument(request, "Sign in to update a request."), 401);
  if (!UUID_RE.test(id)) return text("Not found", 404);
  const body = await readBodyObject(request);
  if (!timingSafeEqual(String(body.csrf || ""), session.csrf_token)) {
    return html(queueMessage(request, "The page expired. Reload it and try again."), 403);
  }
  const status = String(body.status || "");
  if (!STATUSES.includes(status)) {
    return html(queueMessage(request, "Choose pending, approved, or rejected."), 400);
  }
  const updated = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id FROM demo_requests WHERE id = ?").bind(id).first();
  if (!existing) return text("Not found", 404);
  if (status === "approved") {
    await env.DB.prepare(
      "UPDATE demo_requests SET status = ?, updated_at = ? WHERE id = ?"
    ).bind(status, updated, id).run();
    await deliverApprovalEmail(env, id);
  } else {
    await env.DB.prepare(
      `UPDATE demo_requests
       SET status = ?, updated_at = ?, video_link_expires_at = NULL, approval_email_claimed_at = NULL
       WHERE id = ?`
    ).bind(status, updated, id).run();
  }
  return new Response(null, {
    status: 303,
    headers: baseHeaders({ Location: queueLocation(request, body.return_status) }),
  });
}

async function resendApproval(request, env, id) {
  const session = await loadSession(request, env);
  if (!session) return html(loginDocument(request, "Sign in to update a request."), 401);
  if (!UUID_RE.test(id)) return text("Not found", 404);
  const body = await readBodyObject(request);
  if (!timingSafeEqual(String(body.csrf || ""), session.csrf_token)) {
    return html(queueMessage(request, "The page expired. Reload it and try again."), 403);
  }
  if (!approvalEmailEnabled(env)) {
    return html(queueMessage(request, "Approval email is off."), 400);
  }
  await expireStaleApprovalClaims(env);
  const row = await env.DB.prepare(
    "SELECT status, approval_email_sent_at, approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?"
  ).bind(id).first();
  if (!row) return text("Not found", 404);
  if (row.status !== "approved" || row.approval_email_sent_at || !row.approval_email_error) {
    return html(queueMessage(request, "This request does not have a failed approval email to resend."), 400);
  }
  await deliverApprovalEmail(env, id);
  return new Response(null, {
    status: 303,
    headers: baseHeaders({ Location: queueLocation(request, body.return_status) }),
  });
}

export async function expireStaleApprovalClaims(env, now = Date.now()) {
  const cutoff = new Date(now - APPROVAL_CLAIM_TTL_MS).toISOString();
  await env.DB.prepare(
    `UPDATE demo_requests
     SET approval_email_error = ?, approval_email_claimed_at = NULL
     WHERE approval_email_claimed_at IS NOT NULL
       AND approval_email_claimed_at <= ?`
  ).bind(STALE_CLAIM_ERROR, cutoff).run();
  return cutoff;
}

async function sendNewLink(request, env, id) {
  const session = await loadSession(request, env);
  if (!session) return html(loginDocument(request, "Sign in to update a request."), 401);
  if (!UUID_RE.test(id)) return text("Not found", 404);
  const body = await readBodyObject(request);
  if (!timingSafeEqual(String(body.csrf || ""), session.csrf_token)) {
    return html(queueMessage(request, "The page expired. Reload it and try again."), 403);
  }
  if (!approvalEmailEnabled(env)) return html(queueMessage(request, "Approval email is off."), 400);
  await expireStaleApprovalClaims(env);
  const row = await env.DB.prepare("SELECT status FROM demo_requests WHERE id = ?").bind(id).first();
  if (!row) return text("Not found", 404);
  if (row.status !== "approved") {
    return html(queueMessage(request, "Only an approved request can receive a new video link."), 400);
  }
  const result = await deliverApprovalEmail(env, id, { reissue: true });
  if (!result.sent) {
    const message = result.reason === "not-claimed"
      ? "A send is already in progress."
      : (result.error || "The new link was not sent.");
    return html(queueMessage(request, message), result.reason === "not-claimed" ? 409 : 400);
  }
  return new Response(null, {
    status: 303,
    headers: baseHeaders({ Location: queueLocation(request, body.return_status) }),
  });
}

async function sendApproval(request, env, id) {
  const session = await loadSession(request, env);
  if (!session) return html(loginDocument(request, "Sign in to update a request."), 401);
  if (!UUID_RE.test(id)) return text("Not found", 404);
  const body = await readBodyObject(request);
  if (!timingSafeEqual(String(body.csrf || ""), session.csrf_token)) {
    return html(queueMessage(request, "The page expired. Reload it and try again."), 403);
  }
  if (!approvalEmailEnabled(env)) {
    return html(queueMessage(request, "Approval email is off."), 400);
  }
  await expireStaleApprovalClaims(env);
  const row = await env.DB.prepare(
    "SELECT status, approval_email_sent_at, approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?"
  ).bind(id).first();
  if (!row) return text("Not found", 404);
  if (row.status !== "approved" || row.approval_email_sent_at || row.approval_email_claimed_at || row.approval_email_error) {
    return html(queueMessage(request, "This request is not waiting for its first approval email."), 400);
  }
  await deliverApprovalEmail(env, id);
  return new Response(null, {
    status: 303,
    headers: baseHeaders({ Location: queueLocation(request, body.return_status) }),
  });
}

export async function deliverApprovalEmail(env, id, options = {}) {
  if (!approvalEmailEnabled(env)) return { sent: false, reason: "disabled" };
  const claimAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - APPROVAL_CLAIM_TTL_MS).toISOString();
  const claimSql = options.reissue
    ? `UPDATE demo_requests
       SET approval_email_claimed_at = ?, approval_email_error = NULL
       WHERE id = ?
         AND status = 'approved'
         AND (approval_email_claimed_at IS NULL OR approval_email_claimed_at <= ?)`
    : `UPDATE demo_requests
       SET approval_email_claimed_at = ?, approval_email_error = NULL
       WHERE id = ?
         AND status = 'approved'
         AND approval_email_sent_at IS NULL
         AND (approval_email_claimed_at IS NULL OR approval_email_claimed_at <= ?)`;
  const claim = await env.DB.prepare(claimSql).bind(claimAt, id, staleBefore).run();
  if (!claim.meta || claim.meta.changes < 1) return { sent: false, reason: "not-claimed" };
  const row = await env.DB.prepare(
    "SELECT id, full_name, work_email, status, approval_email_sent_at, video_link_expires_at FROM demo_requests WHERE id = ?"
  ).bind(id).first();
  try {
    const sent = await sendApprovalEmail(env, row);
    if (!sent || !sent.sent) throw new Error("Approval email was not sent.");
    await env.DB.prepare(
      `UPDATE demo_requests
       SET approval_email_sent_at = ?, approval_email_error = NULL, approval_email_claimed_at = NULL,
           video_link_expires_at = ?
       WHERE id = ? AND approval_email_claimed_at = ? AND status = 'approved'`
    ).bind(new Date().toISOString(), sent.expiresAt, id, claimAt).run();
    return { sent: true };
  } catch (err) {
    const message = String((err && err.message) || "Email sending failed").slice(0, 500);
    await env.DB.prepare(
      `UPDATE demo_requests
       SET approval_email_error = ?, approval_email_claimed_at = NULL
       WHERE id = ? AND approval_email_claimed_at = ?`
    ).bind(message, id, claimAt).run();
    return { sent: false, reason: "error", error: message };
  }
}

async function loadSession(request, env) {
  const token = cookieValue(request, COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now).run();
  } catch (err) {
    console.error("session cleanup failed", err && err.message);
  }
  const session = await env.DB.prepare(
    "SELECT token_hash, csrf_token, expires_at FROM admin_sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();
  if (!session || typeof session.expires_at !== "string" || session.expires_at <= now) return null;
  return session;
}

async function statusCounts(db) {
  const counts = { all: 0, pending: 0, approved: 0, rejected: 0 };
  const rows = await db.prepare("SELECT status, COUNT(*) AS n FROM demo_requests GROUP BY status").all();
  for (const row of rows.results || []) {
    if (STATUSES.includes(row.status)) {
      counts[row.status] = Number(row.n);
      counts.all += Number(row.n);
    }
  }
  return counts;
}

async function passwordsMatch(provided, secret) {
  const left = await sha256Hex(provided);
  const right = await sha256Hex(secret);
  return timingSafeEqual(left, right);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeFilter(value) {
  return STATUSES.includes(value) ? value : "all";
}

function html(body, status) {
  return new Response(body, {
    status,
    headers: baseHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    }),
  });
}

function text(message, status) {
  return new Response(message, {
    status,
    headers: baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

function loginDocument(request, error) {
  const alert = error
    ? `<p class="alert" role="alert">${escapeHtml(error)}</p>`
    : "";
  return layout(
    "Sign in",
    `<main>
      <h1>SPHERE demo requests</h1>
      <p class="note">Sign in to review the queue. The password is not stored in this page.</p>
      ${alert}
      <form method="post" action="${adminRoute(request, "/login")}">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>
    </main>`
  );
}

function queueMessage(request, message) {
  return layout("Demo requests", `<main><p class="alert" role="alert">${escapeHtml(message)}</p><p><a href="${adminRoute(request)}">Back to the queue</a></p></main>`);
}

function queueDocument(request, csrf, filter, counts, rows, emailOn) {
  const filters = ["all", ...STATUSES].map((status) => {
    const href = status === "all" ? adminRoute(request) : adminRoute(request, `?status=${status}`);
    const current = status === filter ? ` aria-current="page"` : "";
    const label = status === "all" ? "All" : capitalize(status);
    return `<a href="${href}"${current}>${label} (${counts[status] || 0})</a>`;
  }).join("");

  const bodyRows = rows.length
    ? rows.map((row) => renderRow(request, row, csrf, filter, emailOn)).join("")
    : `<tr><td colspan="8">No demo requests in this view.</td></tr>`;

  return layout(
    "Demo requests",
    `<header>
      <h1>SPHERE demo requests</h1>
      <form method="post" action="${adminRoute(request, "/logout")}"><button type="submit">Sign out</button></form>
    </header>
    <main>
      <p class="note">${emailOn ? "Approving emails the requester the demo video link." : "Approval email is off."}</p>
      <nav class="filters" aria-label="Filter by status">${filters}</nav>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Submitted</th>
              <th scope="col">Name</th>
              <th scope="col">Organization</th>
              <th scope="col">Work email</th>
              <th scope="col">Phone</th>
              <th scope="col">Status</th>
              <th scope="col">Email</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </main>`
  );
}

function renderRow(request, row, csrf, filter, emailOn) {
  const details = [
    ["Job title", row.job_title],
    ["Country or region", row.country],
    ["Organization type", row.organization_type],
    ["Interested in", row.interest],
    ["Heard about SPHERE", row.heard_about],
    ["Consent to be contacted", Number(row.consent_to_contact) ? "Yes" : "No"],
    ["Request type", row.request_type],
    ["Updated", formatWhen(row.updated_at)],
    ["Approval email", `${emailStatus(row).detail}${expiryLabel(row)}`],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "-")}</dd></div>`).join("");

  const actions = STATUSES.map((status) => {
    if (status === row.status) return "";
    return `<form method="post" action="${adminRoute(request, `/requests/${escapeHtml(row.id)}`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <input type="hidden" name="status" value="${status}" />
      <input type="hidden" name="return_status" value="${escapeHtml(filter === "all" ? "" : filter)}" />
      <button type="submit">${actionLabel(status)}</button>
    </form>`;
  }).join("");

  return `<tr>
    <td>${escapeHtml(formatWhen(row.created_at))}</td>
    <td>${escapeHtml(row.full_name)}</td>
    <td>${escapeHtml(row.organization)}</td>
    <td>${escapeHtml(row.work_email)}</td>
    <td>${escapeHtml(row.phone)}</td>
    <td>${escapeHtml(row.status)}</td>
    <td>${emailCell(request, row, csrf, filter, emailOn)}</td>
    <td class="actions">
      ${actions}
      <details><summary>Details</summary><dl>${details}</dl></details>
    </td>
  </tr>`;
}

function emailStatus(row) {
  if (row.approval_email_claimed_at) return { detail: "Sending", failed: false };
  if (row.approval_email_error) return { detail: `Failed, ${row.approval_email_error}`, failed: true };
  if (row.approval_email_sent_at) {
    return { detail: `Sent ${formatWhen(row.approval_email_sent_at)}`, failed: false };
  }
  return { detail: "Not sent", failed: false };
}

function emailCell(request, row, csrf, filter, emailOn) {
  const status = emailStatus(row);
  const back = escapeHtml(filter === "all" ? "" : filter);
  const token = escapeHtml(csrf);
  const resend = emailOn && row.status === "approved" && status.failed
    ? `<form method="post" action="${adminRoute(request, `/requests/${escapeHtml(row.id)}/resend`)}">
        <input type="hidden" name="csrf" value="${token}" />
        <input type="hidden" name="return_status" value="${back}" />
        <button type="submit">Resend email</button>
      </form>`
    : "";
  const send = emailOn && row.status === "approved" && !row.approval_email_sent_at && !row.approval_email_claimed_at && !row.approval_email_error
    ? `<form method="post" action="${adminRoute(request, `/requests/${escapeHtml(row.id)}/send`)}">
        <input type="hidden" name="csrf" value="${token}" />
        <input type="hidden" name="return_status" value="${back}" />
        <button type="submit">Send email</button>
      </form>`
    : "";
  const renew = emailOn && row.status === "approved" && row.approval_email_sent_at && !row.approval_email_claimed_at
    ? `<form method="post" action="${adminRoute(request, `/requests/${escapeHtml(row.id)}/new-link`)}">
        <input type="hidden" name="csrf" value="${token}" />
        <input type="hidden" name="return_status" value="${back}" />
        <button type="submit">Send new link</button>
      </form>`
    : "";
  return `${escapeHtml(status.detail + expiryLabel(row))}${send}${resend}${renew}`;
}

function expiryLabel(row) {
  if (!row.video_link_expires_at) return "";
  return ` Link expires ${formatWhen(row.video_link_expires_at)}.`;
}

function actionLabel(status) {
  if (status === "approved") return "Approve";
  if (status === "rejected") return "Reject";
  return "Mark pending";
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatWhen(value) {
  if (!value) return "";
  return String(value).replace("T", " ").replace(/\.\d{3}Z$/, " UTC").replace(/Z$/, " UTC");
}

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font: 16px/1.5 "Segoe UI", system-ui, sans-serif; color: #122033; background: #F7F5F0; }
    header, main { padding: 20px; }
    header { background: #0A3D6F; color: #fff; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    h1 { margin: 0; font-size: 1.35rem; color: inherit; }
    main { max-width: 1100px; margin: 0 auto; }
    a { color: #0A3D6F; }
    button { font: inherit; font-weight: 650; background: #0A3D6F; color: #fff; border: 0; border-radius: 999px; padding: 0.45rem 0.9rem; cursor: pointer; }
    header button { background: #fff; color: #0A3D6F; }
    label { display: block; font-weight: 650; margin: 0 0 0.35rem; }
    input[type="password"] { font: inherit; padding: 0.55rem 0.7rem; width: min(100%, 22rem); border: 2px solid #0A3D6F; border-radius: 10px; }
    form { margin: 0.8rem 0; }
    .note { color: #4A5A6A; }
    .alert { background: #FDECEC; color: #6F1D1D; padding: 0.7rem 0.9rem; border-radius: 10px; }
    .filters { display: flex; flex-wrap: wrap; gap: 0.8rem 1rem; margin: 1rem 0; }
    .filters a[aria-current="page"] { font-weight: 800; text-decoration: none; }
    .table-wrap { overflow-x: auto; background: #fff; border: 1px solid #E4DFD6; border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #E4DFD6; padding: 0.65rem 0.75rem; text-align: left; vertical-align: top; }
    th { font-size: 0.82rem; }
    .actions form { display: inline; margin: 0 0.35rem 0.35rem 0; }
    .actions button { margin-bottom: 0.35rem; }
    dl { margin: 0.5rem 0 0; }
    dt { font-weight: 700; }
    dd { margin: 0 0 0.45rem; white-space: pre-wrap; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
