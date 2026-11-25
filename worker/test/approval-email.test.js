import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deliverApprovalEmail, expireStaleApprovalClaims } from "../src/admin.js";
import { renderApprovalEmail, sendApprovalEmail, videoLinkTtlDays } from "../src/email.js";
import worker from "../src/index.js";
import { countRequests, createDb, makeEnv, payload } from "./helpers.js";

const FROM = "Logic Pursuits Representative <no-reply@spheresce.com>";
const VIDEO = "https://video.spheresce.com";

function mailEnv(db, overrides = {}) {
  const sends = [];
  const env = makeEnv(db, {
    APPROVAL_EMAIL_ENABLED: "true",
    EMAIL_FROM: FROM,
    VIDEO_URL: VIDEO,
    VIDEO_LINK_SECRET: "test-video-secret",
    SEND_EMAIL: {
      send: async (message) => {
        sends.push(message);
      },
    },
    ...overrides,
  });
  env.sends = sends;
  return env;
}

async function postDemo(env, body, ip) {
  const response = await worker.fetch(
    new Request("https://worker.test/api/demo-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    }),
    env
  );
  assert.equal(response.status, 201, await response.clone().text());
}

async function signIn(env, ip) {
  const login = await worker.fetch(
    new Request("https://worker.test/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": ip,
      },
      body: `password=${encodeURIComponent(env.ADMIN_PASSWORD)}`,
    }),
    env
  );
  assert.equal(login.status, 303);
  const cookie = (login.headers.get("Set-Cookie") || "").match(/sphere_admin=([^;]*)/)[1];
  const page = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  return { cookie, csrf };
}

async function postForm(env, path, cookie, body) {
  return worker.fetch(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `sphere_admin=${cookie}`,
      },
      body,
    }),
    env
  );
}

test("approving sends the video link once, and approving again does not", async () => {
  const db = createDb();
  const env = mailEnv(db);
  await postDemo(env, payload({ fullName: "Jordan Lee" }), "203.0.113.80");
  const { cookie, csrf } = await signIn(env, "203.0.113.81");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;

  const approved = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved`);
  assert.equal(approved.status, 303);
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].to, "jordan.lee@northwindbio.example");
  assert.deepEqual(env.sends[0].from, { name: "Logic Pursuits Representative", email: "no-reply@spheresce.com" });
  assert.equal(env.sends[0].replyTo, undefined);
  assert.match(env.sends[0].text, /Hello Jordan Lee,/);
  assert.match(env.sends[0].text, /https:\/\/video\.spheresce\.com\/v\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.match(env.sends[0].text, /This link expires in 7 days/);
  assert.match(env.sends[0].html, /This link expires in 7 days/);
  const sentExpiry = Date.parse(db.prepare("SELECT video_link_expires_at FROM demo_requests WHERE id = ?").get(id).video_link_expires_at);
  const remainingDays = (sentExpiry - Date.now()) / 86400000;
  assert.ok(remainingDays > 6.9 && remainingDays < 7.1);
  assert.match(env.sends[0].text, /A Logic Pursuits Representative approved your demo request/);
  assert.match(env.sends[0].text, /\nLogic Pursuits Representative$/);
  assert.equal(env.sends[0].text.includes("The SPHERE team approved"), false);
  assert.match(env.sends[0].html, /A Logic Pursuits Representative approved your demo request/);
  assert.equal(env.sends[0].html.includes("The SPHERE team approved"), false);
  const row = db.prepare("SELECT approval_email_sent_at, approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?").get(id);
  assert.ok(row.approval_email_sent_at);
  assert.equal(row.approval_email_claimed_at, null);
  assert.equal(row.approval_email_error, null);

  const again = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=rejected`);
  assert.equal(again.status, 303);
  const reapproved = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved`);
  assert.equal(reapproved.status, 303);
  assert.equal(env.sends.length, 1);
  assert.equal(db.prepare("SELECT status FROM demo_requests WHERE id = ?").get(id).status, "approved");
});

test("only one of two overlapping sends claims the row", async () => {
  const db = createDb();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const env = mailEnv(db, {
    SEND_EMAIL: {
      send: async () => {
        started += 1;
        await gate;
      },
    },
  });
  await postDemo(env, payload(), "203.0.113.82");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  db.prepare("UPDATE demo_requests SET status = 'approved' WHERE id = ?").run(id);

  const first = deliverApprovalEmail(env, id);
  const second = deliverApprovalEmail(env, id);
  const deadline = Date.now() + 2000;
  while (started < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(started, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.sent).length, 1);
  assert.equal(results.filter((result) => result.reason === "not-claimed").length, 1);
  assert.equal(env.sends ? started : started, 1);
});

test("a failed send can be resent, and a bad token cannot", async () => {
  const db = createDb();
  let fail = true;
  const env = mailEnv(db, {
    SEND_EMAIL: {
      send: async (message) => {
        env.sends.push(message);
        if (fail) throw new Error("mailbox unavailable");
      },
    },
  });
  await postDemo(env, payload({ fullName: "Jordan Lee" }), "203.0.113.83");
  const { cookie, csrf } = await signIn(env, "203.0.113.84");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  const approved = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved&return_status=approved`);
  assert.equal(approved.status, 303);
  const failed = db.prepare("SELECT approval_email_sent_at, approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?").get(id);
  assert.equal(failed.approval_email_sent_at, null);
  assert.equal(failed.approval_email_claimed_at, null);
  assert.match(failed.approval_email_error, /mailbox unavailable/);

  const page = await worker.fetch(
    new Request("https://worker.test/admin?status=approved", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  assert.match(html, /Failed, mailbox unavailable/);
  assert.match(html, /Resend email/);
  assert.match(html, /Approving emails the requester the demo video link/);

  const forged = await postForm(env, `/admin/requests/${id}/resend`, cookie, "csrf=nope");
  assert.equal(forged.status, 403);
  assert.equal(env.sends.length, 1);

  fail = false;
  const resent = await postForm(env, `/admin/requests/${id}/resend`, cookie, `csrf=${csrf}&return_status=approved`);
  assert.equal(resent.status, 303);
  assert.equal(env.sends.length, 2);
  const sent = db.prepare("SELECT approval_email_sent_at, approval_email_error, approval_email_claimed_at FROM demo_requests WHERE id = ?").get(id);
  assert.ok(sent.approval_email_sent_at);
  assert.equal(sent.approval_email_error, null);
  assert.equal(sent.approval_email_claimed_at, null);
  assert.equal(countRequests(db), 1);
});

test("approval email stays off when the flag is off", async () => {
  const db = createDb();
  const env = mailEnv(db, { APPROVAL_EMAIL_ENABLED: "false" });
  await postDemo(env, payload(), "203.0.113.85");
  const { cookie, csrf } = await signIn(env, "203.0.113.86");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  const approved = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved`);
  assert.equal(approved.status, 303);
  assert.equal(env.sends.length, 0);
  const row = db.prepare("SELECT status, approval_email_sent_at FROM demo_requests WHERE id = ?").get(id);
  assert.equal(row.status, "approved");
  assert.equal(row.approval_email_sent_at, null);
  const page = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  assert.match(await page.text(), /Approval email is off/);
});

test("rejected and pending requests are not emailed", async () => {
  const db = createDb();
  const env = mailEnv(db);
  await postDemo(env, payload(), "203.0.113.87");
  const { cookie, csrf } = await signIn(env, "203.0.113.88");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  const rejected = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=rejected`);
  assert.equal(rejected.status, 303);
  assert.deepEqual(await deliverApprovalEmail(env, id), { sent: false, reason: "not-claimed" });
  db.prepare("UPDATE demo_requests SET status = 'pending' WHERE id = ?").run(id);
  assert.equal((await deliverApprovalEmail(env, id)).reason, "not-claimed");
  assert.equal(env.sends.length, 0);
  assert.equal(db.prepare("SELECT approval_email_sent_at FROM demo_requests WHERE id = ?").get(id).approval_email_sent_at, null);
});

test("a missing video link lifetime defaults to 7 days", () => {
  assert.equal(videoLinkTtlDays({}), 7);
  assert.equal(videoLinkTtlDays({ VIDEO_LINK_TTL_DAYS: "0" }), 7);
  assert.equal(videoLinkTtlDays({ VIDEO_LINK_TTL_DAYS: "nope" }), 7);
  assert.equal(videoLinkTtlDays({ VIDEO_LINK_TTL_DAYS: "7" }), 7);
  const rendered = renderApprovalEmail({ full_name: "Jordan Lee" }, `${VIDEO}/v/example.token`);
  assert.match(rendered.text, /This link expires in 7 days\./);
  assert.match(rendered.html, /This link expires in 7 days\./);
  assert.match(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"), /VIDEO_LINK_TTL_DAYS = "7"/);
});

test("approval HTML escapes the name and does not use a response address", async () => {
  const name = `Ann <script> & "quotes"`;
  const rendered = renderApprovalEmail({ full_name: name }, `${VIDEO}/v/example.token`, 14);
  assert.match(rendered.html, /Ann &lt;script&gt; &amp; &quot;quotes&quot;/);
  assert.equal(rendered.html.includes("<script>"), false);
  assert.match(rendered.text, /Hello Ann <script> & "quotes",/);
  assert.match(rendered.text, /A Logic Pursuits Representative approved your demo request/);
  assert.match(rendered.html, /<p>A Logic Pursuits Representative approved your demo request\. You can watch the demo here\.<\/p>/);
  assert.match(rendered.text, /\nLogic Pursuits Representative$/);
  assert.match(rendered.html, /<p>Logic Pursuits Representative<\/p>/);
  assert.equal(rendered.text.includes("The SPHERE team approved"), false);
  assert.equal(rendered.html.includes("The SPHERE team approved"), false);

  const db = createDb();
  const env = mailEnv(db);
  const id = "33333333-3333-4333-8333-333333333333";
  db.prepare(
    `INSERT INTO demo_requests (
      id, created_at, updated_at, status, request_type, full_name, job_title, organization,
      work_email, phone, consent_to_contact
    ) VALUES (?, ?, ?, 'approved', 'Demo request', ?, 'Role', 'Org', 'person@example.com', '+1 202 555 0199', 0)`
  ).run(id, "2026-11-24T00:00:00.000Z", "2026-11-24T00:00:00.000Z", name);
  const result = await sendApprovalEmail(env, db.prepare("SELECT * FROM demo_requests WHERE id = ?").get(id));
  assert.equal(result.sent, true);
  assert.equal(env.sends[0].html.includes("<script>"), false);
  assert.equal(Object.hasOwn(env.sends[0], "replyTo"), false);
});

test("Send emails an approved request that was stored while the flag was off", async () => {
  const db = createDb();
  const env = mailEnv(db, { APPROVAL_EMAIL_ENABLED: "false" });
  await postDemo(env, payload({ fullName: "Jordan Lee" }), "203.0.113.90");
  const { cookie, csrf } = await signIn(env, "203.0.113.91");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  const approved = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved&return_status=approved`);
  assert.equal(approved.status, 303);
  assert.equal(env.sends.length, 0);

  const hidden = await worker.fetch(
    new Request("https://worker.test/admin?status=approved", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  assert.equal((await hidden.text()).includes(">Send email<"), false);

  env.APPROVAL_EMAIL_ENABLED = "true";
  const shown = await worker.fetch(
    new Request("https://worker.test/admin?status=approved", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await shown.text();
  assert.match(html, />Send email</);
  assert.equal(html.includes(">Resend email<"), false);
  assert.equal(html.includes(">Send new link<"), false);

  const forged = await postForm(env, `/admin/requests/${id}/send`, cookie, "csrf=nope");
  assert.equal(forged.status, 403);
  assert.equal(env.sends.length, 0);

  const sent = await postForm(env, `/admin/requests/${id}/send`, cookie, `csrf=${csrf}&return_status=approved`);
  assert.equal(sent.status, 303);
  assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].to, "jordan.lee@northwindbio.example");
  const row = db.prepare("SELECT approval_email_sent_at FROM demo_requests WHERE id = ?").get(id);
  assert.ok(row.approval_email_sent_at);

  const again = await postForm(env, `/admin/requests/${id}/send`, cookie, `csrf=${csrf}`);
  assert.equal(again.status, 400);
  assert.equal(env.sends.length, 1);
});

test("a claim older than three minutes is failed and can be resent", async () => {
  const db = createDb();
  const env = mailEnv(db);
  await postDemo(env, payload(), "203.0.113.92");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  const stale = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE demo_requests SET status = 'approved', approval_email_claimed_at = ? WHERE id = ?"
  ).run(stale, id);

  await expireStaleApprovalClaims(env);
  const expired = db.prepare(
    "SELECT approval_email_claimed_at, approval_email_error, approval_email_sent_at FROM demo_requests WHERE id = ?"
  ).get(id);
  assert.equal(expired.approval_email_claimed_at, null);
  assert.equal(expired.approval_email_sent_at, null);
  assert.match(expired.approval_email_error, /resend/i);

  const fresh = new Date(Date.now() - 60 * 1000).toISOString();
  db.prepare(
    "UPDATE demo_requests SET approval_email_claimed_at = ?, approval_email_error = NULL WHERE id = ?"
  ).run(fresh, id);
  await expireStaleApprovalClaims(env);
  const stillClaimed = db.prepare("SELECT approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?").get(id);
  assert.equal(stillClaimed.approval_email_claimed_at, fresh);
  assert.equal(stillClaimed.approval_email_error, null);

  db.prepare(
    "UPDATE demo_requests SET approval_email_claimed_at = ?, approval_email_error = NULL WHERE id = ?"
  ).run(stale, id);
  const { cookie, csrf } = await signIn(env, "203.0.113.93");
  const page = await worker.fetch(
    new Request("https://worker.test/admin?status=approved", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  assert.match(html, />Resend email</);
  assert.equal(html.includes(">Send email<"), false);
  assert.equal(html.includes(">Sending<"), false);
  const resent = await postForm(env, `/admin/requests/${id}/resend`, cookie, `csrf=${csrf}&return_status=approved`);
  assert.equal(resent.status, 303);
  assert.equal(env.sends.length, 1);
});

test("a video URL other than the SPHERE host is not sent", async () => {
  const db = createDb();
  const env = mailEnv(db, { VIDEO_URL: "https://video.spheresce.com.evil.example" });
  const id = "44444444-4444-4444-8444-444444444444";
  db.prepare(
    `INSERT INTO demo_requests (
      id, created_at, updated_at, status, request_type, full_name, job_title, organization,
      work_email, phone, consent_to_contact
    ) VALUES (?, ?, ?, 'approved', 'Demo request', 'Jordan Lee', 'Role', 'Org', 'person@example.com', '+1 202 555 0199', 0)`
  ).run(id, "2026-11-24T00:00:00.000Z", "2026-11-24T00:00:00.000Z");
  await assert.rejects(() => sendApprovalEmail(env, db.prepare("SELECT * FROM demo_requests WHERE id = ?").get(id)));
  assert.equal(env.sends.length, 0);
  const result = await deliverApprovalEmail(env, id);
  assert.equal(result.sent, false);
  assert.equal(env.sends.length, 0);
  const row = db.prepare("SELECT approval_email_sent_at, approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?").get(id);
  assert.equal(row.approval_email_sent_at, null);
  assert.equal(row.approval_email_claimed_at, null);
  assert.match(row.approval_email_error, /not configured/);
});

test("Send new link reissues a link after a successful send", async () => {
  const db = createDb();
  const env = mailEnv(db);
  await postDemo(env, payload({ fullName: "Jordan Lee" }), "203.0.113.94");
  const { cookie, csrf } = await signIn(env, "203.0.113.95");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved&return_status=approved`);
  const firstLink = env.sends[0].text.match(/https:\/\/video\.spheresce\.com\/v\/\S+/)[0];
  const page = await worker.fetch(
    new Request("https://worker.test/admin?status=approved", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  assert.match(html, />Send new link</);
  assert.match(html, /Link expires /);
  const forged = await postForm(env, `/admin/requests/${id}/new-link`, cookie, "csrf=nope");
  assert.equal(forged.status, 403);
  assert.equal(env.sends.length, 1);
  const renewed = await postForm(env, `/admin/requests/${id}/new-link`, cookie, `csrf=${csrf}&return_status=approved`);
  assert.equal(renewed.status, 303);
  assert.equal(env.sends.length, 2);
  const secondLink = env.sends[1].text.match(/https:\/\/video\.spheresce\.com\/v\/\S+/)[0];
  assert.notEqual(firstLink, secondLink);
  const stored = db.prepare("SELECT video_link_expires_at FROM demo_requests WHERE id = ?").get(id);
  assert.ok(stored.video_link_expires_at);
});

test("rejecting a request invalidates its link until a new one is issued", async () => {
  const db = createDb();
  const env = mailEnv(db);
  await postDemo(env, payload({ fullName: "Jordan Lee" }), "203.0.113.96");
  const { cookie, csrf } = await signIn(env, "203.0.113.97");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved`);
  const firstLink = env.sends[0].text.match(/https:\/\/video\.spheresce\.com\/v\/\S+/)[0];
  const firstToken = firstLink.split("/v/")[1];
  const before = await worker.fetch(new Request(firstLink), env);
  assert.equal(before.status, 200);

  const rejected = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=rejected`);
  assert.equal(rejected.status, 303);
  assert.equal(db.prepare("SELECT video_link_expires_at FROM demo_requests WHERE id = ?").get(id).video_link_expires_at, null);
  const afterReject = await worker.fetch(new Request(firstLink), env);
  assert.equal(afterReject.status, 410);

  const reapproved = await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved`);
  assert.equal(reapproved.status, 303);
  assert.equal(env.sends.length, 1);
  assert.equal(db.prepare("SELECT video_link_expires_at, approval_email_sent_at FROM demo_requests WHERE id = ?").get(id).video_link_expires_at, null);
  const afterReapprove = await worker.fetch(new Request(firstLink), env);
  assert.equal(afterReapprove.status, 410);

  const renewed = await postForm(env, `/admin/requests/${id}/new-link`, cookie, `csrf=${csrf}`);
  assert.equal(renewed.status, 303);
  assert.equal(env.sends.length, 2);
  const secondToken = env.sends[1].text.match(/https:\/\/video\.spheresce\.com\/v\/\S+/)[0].split("/v/")[1];
  assert.notEqual(firstToken, secondToken);
  assert.equal((await worker.fetch(new Request(firstLink), env)).status, 410);
  assert.equal((await worker.fetch(new Request(`https://video.spheresce.com/v/${secondToken}`), env)).status, 200);
});

test("a failed new link stays visible and a claimed reissue can expire", async () => {
  const db = createDb();
  let fail = false;
  const env = mailEnv(db, {
    SEND_EMAIL: {
      send: async (message) => {
        env.sends.push(message);
        if (fail) throw new Error("new link failed");
      },
    },
  });
  await postDemo(env, payload(), "203.0.113.98");
  const { cookie, csrf } = await signIn(env, "203.0.113.99");
  const id = db.prepare("SELECT id FROM demo_requests").get().id;
  await postForm(env, `/admin/requests/${id}`, cookie, `csrf=${csrf}&status=approved&return_status=approved`);
  fail = true;
  const failed = await postForm(env, `/admin/requests/${id}/new-link`, cookie, `csrf=${csrf}&return_status=approved`);
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /new link failed/);
  const row = db.prepare("SELECT approval_email_sent_at, approval_email_error, approval_email_claimed_at FROM demo_requests WHERE id = ?").get(id);
  assert.ok(row.approval_email_sent_at);
  assert.match(row.approval_email_error, /new link failed/);
  assert.equal(row.approval_email_claimed_at, null);
  const page = await worker.fetch(
    new Request("https://worker.test/admin?status=approved", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  assert.match(html, /new link failed/);
  assert.match(html, />Send new link</);

  const stale = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE demo_requests SET approval_email_claimed_at = ?, approval_email_error = NULL WHERE id = ?"
  ).run(stale, id);
  await expireStaleApprovalClaims(env);
  const expired = db.prepare("SELECT approval_email_sent_at, approval_email_claimed_at, approval_email_error FROM demo_requests WHERE id = ?").get(id);
  assert.ok(expired.approval_email_sent_at);
  assert.equal(expired.approval_email_claimed_at, null);
  assert.match(expired.approval_email_error, /resend/i);
});
