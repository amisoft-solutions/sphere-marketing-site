/**
 * Admin notification email. Off unless NOTIFY_EMAIL_ENABLED is the string "true".
 * The recipient is NOTIFY_TO (Worker secret or var). Never the person who submitted the form.
 * The message never includes a demo video or a viewing link.
 *
 * Approval mail is separate. It is off unless APPROVAL_EMAIL_ENABLED is "true".
 * That message goes to the requester and includes the demo video link.
 */

import { escapeHtml } from "./http.js";

export function notificationsEnabled(env) {
  return String(env && env.NOTIFY_EMAIL_ENABLED != null ? env.NOTIFY_EMAIL_ENABLED : "false").toLowerCase() === "true";
}

export function renderAdminNotification(record, adminUrl) {
  const lines = [
    "A new SPHERE demo request is waiting for review.",
    "",
    `Name: ${record.fullName}`,
    `Job title: ${record.jobTitle}`,
    `Organization: ${record.organization}`,
    `Work email: ${record.workEmail}`,
    `Phone: ${record.phone}`,
    `Country or region: ${record.country || "—"}`,
    `Organization type: ${record.organizationType || "—"}`,
    `Interested in: ${record.interest || "—"}`,
    `Heard about SPHERE: ${record.heardAbout || "—"}`,
    `Consent to be contacted: ${record.consentToContact ? "yes" : "no"}`,
    `Request type: ${record.requestType}`,
    `Status: ${record.status}`,
    `Submitted: ${record.createdAt}`,
    "",
    "The requester is not emailed by this system.",
  ];
  if (adminUrl) {
    lines.push("", `Review the queue: ${adminUrl}`);
  }
  return lines.join("\n");
}

export async function maybeNotify(env, record, options = {}) {
  if (!notificationsEnabled(env)) {
    return { sent: false, reason: "disabled" };
  }

  const to = typeof env.NOTIFY_TO === "string" ? env.NOTIFY_TO.trim() : "";
  if (!to || !to.includes("@")) {
    return { sent: false, reason: "missing-recipient" };
  }
  if (to.toLowerCase() === String(record.workEmail || "").trim().toLowerCase()) {
    return { sent: false, reason: "recipient-is-requester" };
  }

  const provider = String(env.EMAIL_PROVIDER || "off").toLowerCase();
  const subject = "New SPHERE demo request";
  const text = renderAdminNotification(record, options.adminUrl || "");

  if (provider === "off" || provider === "") {
    return { sent: false, reason: "provider-off" };
  }

  if (provider === "cloudflare_email") {
    const from = typeof env.EMAIL_FROM === "string" ? env.EMAIL_FROM.trim() : "";
    if (!from) return { sent: false, reason: "missing-from" };
    if (!env.SEND_EMAIL || typeof env.SEND_EMAIL.send !== "function") {
      return { sent: false, reason: "missing-binding" };
    }
    await env.SEND_EMAIL.send({ to, from, subject, text });
    return { sent: true, provider };
  }

  if (provider === "resend") {
    const from = typeof env.EMAIL_FROM === "string" ? env.EMAIL_FROM.trim() : "";
    if (!from || !env.RESEND_API_KEY) return { sent: false, reason: "missing-resend-config" };
    const fetchImpl = options.fetch || fetch;
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { sent: false, reason: "provider-error" };
    return { sent: true, provider };
  }

  return { sent: false, reason: "unknown-provider" };
}

export const REQUIRED_VIDEO_URL = "https://video.spheresce.com";

export function approvalEmailEnabled(env) {
  return String(env && env.APPROVAL_EMAIL_ENABLED != null ? env.APPROVAL_EMAIL_ENABLED : "false").toLowerCase() === "true";
}

export function parseFromAddress(value) {
  const raw = String(value || "").trim();
  const named = raw.match(/^(.*?)<([^>]+)>$/);
  if (!named) return raw;
  const name = named[1].trim().replace(/^"|"$/g, "");
  const email = named[2].trim();
  if (!name || !email) return raw;
  return { name, email };
}

export function renderApprovalEmail(row, videoUrl) {
  const name = String(row.full_name || row.fullName || "").trim();
  const url = String(videoUrl || "").trim();
  const text = [
    `Hello ${name},`,
    "",
    "The SPHERE team approved your demo request. You can watch the demo here:",
    url,
    "",
    "the SPHERE team",
  ].join("\n");
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(url);
  const html = [
    `<p>Hello ${safeName},</p>`,
    "<p>The SPHERE team approved your demo request. You can watch the demo here:</p>",
    `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
    "<p>the SPHERE team</p>",
  ].join("");
  return { subject: "Your SPHERE demo", text, html };
}

export async function sendApprovalEmail(env, row) {
  if (!approvalEmailEnabled(env)) return { sent: false, reason: "disabled" };
  const to = String((row && (row.work_email || row.workEmail)) || "").trim();
  const fromRaw = typeof env.EMAIL_FROM === "string" ? env.EMAIL_FROM.trim() : "";
  const videoUrl = typeof env.VIDEO_URL === "string" ? env.VIDEO_URL.trim() : "";
  if (!to || !fromRaw || videoUrl !== REQUIRED_VIDEO_URL) {
    throw new Error("Approval email is not configured.");
  }
  if (!env.SEND_EMAIL || typeof env.SEND_EMAIL.send !== "function") {
    throw new Error("Email sending is not configured.");
  }
  const message = renderApprovalEmail(row, videoUrl);
  await env.SEND_EMAIL.send({
    to,
    from: parseFromAddress(fromRaw),
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return { sent: true };
}
