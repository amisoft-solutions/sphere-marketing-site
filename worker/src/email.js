/**
 * Admin notification email. Off unless NOTIFY_EMAIL_ENABLED is the string "true".
 * The recipient is NOTIFY_TO (Worker secret or var). Never the person who submitted the form.
 * The message never includes a demo video or a viewing link.
 */

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
