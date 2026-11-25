import assert from "node:assert/strict";
import test from "node:test";
import { maybeNotify, renderAdminNotification } from "../src/email.js";

const record = {
  id: "11111111-1111-4111-8111-111111111111",
  fullName: "Jordan Lee",
  jobTitle: "Lead Statistical Programmer",
  organization: "Northwind Biometrics",
  workEmail: "jordan.lee@northwindbio.example",
  phone: "+1 202 555 0143",
  country: "",
  organizationType: "CRO",
  interest: "Tracker walkthrough",
  heardAbout: "Conference",
  consentToContact: true,
  requestType: "Demo request",
  status: "pending",
  createdAt: "2026-11-24T12:00:00.000Z",
};

test("notification text is an admin alert and not a demo delivery", () => {
  const text = renderAdminNotification(record, "https://worker.test/admin");
  assert.match(text, /Jordan Lee/);
  assert.match(text, /Organization type: CRO/);
  assert.match(text, /Interested in: Tracker walkthrough/);
  assert.match(text, /Heard about SPHERE: Conference/);
  assert.match(text, /Consent to be contacted: yes/);
  assert.equal(text.includes("Country or region"), false);
  assert.match(text, /not emailed/i);
  assert.doesNotMatch(text, /video/i);
  assert.doesNotMatch(text, /\.mp4|youtu|watch the demo/i);
});

test("notification text omits removed fields when they are missing", () => {
  const text = renderAdminNotification(
    {
      ...record,
      country: null,
      organizationType: "",
      interest: null,
      heardAbout: "  ",
      consentToContact: null,
    },
    "https://worker.test/admin"
  );
  assert.match(text, /Jordan Lee/);
  assert.match(text, /Phone: \+1 202 555 0143/);
  for (const label of ["Country or region", "Organization type", "Interested in", "Heard about SPHERE", "Consent to be contacted"]) {
    assert.equal(text.includes(label), false, label);
  }
  assert.equal(text.includes("null"), false);
  assert.equal(text.includes("undefined"), false);
  assert.equal(text.includes("—"), false);
});

test("does not send mail while the feature flag is off", async () => {
  const calls = [];
  const result = await maybeNotify(
    { NOTIFY_EMAIL_ENABLED: "false", NOTIFY_TO: "queue@example.com", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "test", EMAIL_FROM: "from@example.com" },
    record,
    { fetch: async () => { calls.push("fetch"); return new Response("{}", { status: 200 }); } }
  );
  assert.deepEqual(result, { sent: false, reason: "disabled" });
  assert.deepEqual(calls, []);
});

test("does not send when the provider is off even if the flag is on", async () => {
  const result = await maybeNotify(
    { NOTIFY_EMAIL_ENABLED: "true", NOTIFY_TO: "queue@example.com", EMAIL_PROVIDER: "off" },
    record,
    { fetch: async () => { throw new Error("fetch should not run"); } }
  );
  assert.equal(result.sent, false);
  assert.equal(result.reason, "provider-off");
});

test("refuses to use the requester as the notification recipient", async () => {
  const result = await maybeNotify(
    {
      NOTIFY_EMAIL_ENABLED: "true",
      NOTIFY_TO: "jordan.lee@northwindbio.example",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test",
      EMAIL_FROM: "from@example.com",
    },
    record,
    { fetch: async () => { throw new Error("fetch should not run"); } }
  );
  assert.equal(result.reason, "recipient-is-requester");
});

test("resend posts only to NOTIFY_TO", async () => {
  let sent;
  const result = await maybeNotify(
    {
      NOTIFY_EMAIL_ENABLED: "true",
      NOTIFY_TO: "queue@example.com",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test-key",
      EMAIL_FROM: "from@example.com",
    },
    record,
    {
      adminUrl: "https://worker.test/admin",
      fetch: async (url, init) => {
        sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
        return new Response("{}", { status: 200 });
      },
    }
  );
  assert.equal(result.sent, true);
  assert.equal(sent.url, "https://api.resend.com/emails");
  assert.deepEqual(sent.body.to, ["queue@example.com"]);
  assert.equal(sent.body.to.includes(record.workEmail), false);
  assert.doesNotMatch(sent.body.text, /video/i);
  assert.match(sent.auth, /test-key/);
});

test("cloudflare email binding receives the secret recipient", async () => {
  let message;
  const result = await maybeNotify(
    {
      NOTIFY_EMAIL_ENABLED: "true",
      NOTIFY_TO: "queue@example.com",
      EMAIL_PROVIDER: "cloudflare_email",
      EMAIL_FROM: "from@example.com",
      SEND_EMAIL: { send: async (payload) => { message = payload; } },
    },
    record
  );
  assert.equal(result.sent, true);
  assert.equal(message.to, "queue@example.com");
  assert.equal(message.to === record.workEmail, false);
});
