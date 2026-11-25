import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import worker from "../src/index.js";
import { requestDetailItems } from "../src/admin.js";
import { sha256Hex } from "../src/http.js";
import { countRequests, createDb, d1, makeEnv, payload } from "./helpers.js";

async function postDemo(env, body, { origin, ip, userAgent } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (ip) headers["CF-Connecting-IP"] = ip;
  if (userAgent) headers["User-Agent"] = userAgent;
  const response = await worker.fetch(
    new Request("https://worker.test/api/demo-requests", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env
  );
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, json, text };
}

function cookieFrom(response) {
  const header = response.headers.get("Set-Cookie") || "";
  const match = header.match(/sphere_admin=([^;]*)/);
  return match ? match[1] : "";
}

test("stores a valid request and keeps the service document free of the admin password", async () => {
  const db = createDb();
  const env = makeEnv(db);
  const health = await worker.fetch(new Request("https://worker.test/"), env);
  const healthBody = await health.text();
  assert.equal(health.status, 200);
  assert.equal(healthBody.includes(env.ADMIN_PASSWORD), false);

  const { response, json } = await postDemo(env, payload(), {
    origin: "https://www.spheresce.com",
    ip: "203.0.113.10",
    userAgent: "SpherePreview/1.0",
  });
  assert.equal(response.status, 201);
  assert.equal(json.ok, true);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://www.spheresce.com");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(countRequests(db), 1);
  const row = db.prepare("SELECT * FROM demo_requests").get();
  assert.equal(row.status, "pending");
  assert.equal(row.full_name, "Jordan Lee");
  assert.equal(row.job_title, "Lead Statistical Programmer");
  assert.equal(row.organization, "Northwind Biometrics");
  assert.equal(row.phone, "+1 202 555 0143");
  assert.equal(row.country, "");
  assert.equal(row.organization_type, "");
  assert.equal(row.interest, "");
  assert.equal(row.heard_about, "");
  assert.equal(row.consent_to_contact, null);
  assert.match(readFileSync(new URL("../src/index.js", import.meta.url), "utf8"), /consent_to_contact,\s*user_agent[\s\S]*NULL,/);
  assert.equal(row.user_agent, "SpherePreview/1.0");
  assert.equal(row.work_email, "jordan.lee@northwindbio.example");
});

test("rejects a disallowed origin, a honeypot, a fast submit, and invalid fields without storing them", async () => {
  const db = createDb();
  const env = makeEnv(db);

  const blocked = await postDemo(env, payload(), { origin: "https://evil.example", ip: "203.0.113.20" });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.response.headers.get("Access-Control-Allow-Origin"), null);

  const honeypot = await postDemo(env, payload({ faxNumber: "filled" }), {
    origin: "https://www.spheresce.com",
    ip: "203.0.113.21",
  });
  assert.equal(honeypot.response.status, 400);
  assert.equal(JSON.stringify(honeypot.json).toLowerCase().includes("honeypot"), false);

  const fast = await postDemo(env, payload({ formLoadedAt: Date.now() }), {
    origin: "https://www.spheresce.com",
    ip: "203.0.113.22",
  });
  assert.equal(fast.response.status, 400);
  assert.match(fast.json.error, /moment/);

  const invalid = await postDemo(env, payload({ workEmail: "nope", phone: "12" }), {
    ip: "203.0.113.23",
  });
  assert.equal(invalid.response.status, 400);
  assert.ok(invalid.json.fields.workEmail);
  assert.ok(invalid.json.fields.phone);
  assert.equal(countRequests(db), 0);
});

test("localhost is closed unless a test sets ALLOW_LOCALHOST", async () => {
  const db = createDb();
  const closed = makeEnv(db);
  delete closed.ALLOW_LOCALHOST;
  const blocked = await postDemo(closed, payload(), { origin: "http://localhost:8765", ip: "203.0.113.50" });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.response.headers.get("Access-Control-Allow-Origin"), null);

  const alsoClosed = await postDemo(makeEnv(db), payload(), { origin: "http://127.0.0.1:8765", ip: "203.0.113.52" });
  assert.equal(alsoClosed.response.status, 403);

  const open = makeEnv(db, { ALLOW_LOCALHOST: "true" });
  const allowed = await postDemo(open, payload(), { origin: "http://127.0.0.1:8765", ip: "203.0.113.51" });
  assert.equal(allowed.response.status, 201);
  assert.equal(allowed.response.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:8765");
  assert.equal(countRequests(db), 1);
});

test("rate limits repeated demo posts per address", async () => {
  const db = createDb();
  const env = makeEnv(db, { DEMO_RATE_LIMIT: "2" });
  const ip = "203.0.113.30";
  assert.equal((await postDemo(env, payload(), { ip })).response.status, 201);
  assert.equal((await postDemo(env, payload(), { ip })).response.status, 201);
  const limited = await postDemo(env, payload(), { ip });
  assert.equal(limited.response.status, 429);
  assert.match(limited.json.error, /wait/i);
  assert.equal(countRequests(db), 2);
});

test("admin can sign in, filter, and approve without the password appearing in the page", async () => {
  const db = createDb();
  const env = makeEnv(db, { COOKIE_SECURE: "true" });
  await postDemo(env, payload({ fullName: "A & B Research" }), { ip: "203.0.113.40" });
  db.prepare(
    `INSERT INTO demo_requests (
      id, created_at, updated_at, status, request_type, full_name, job_title, organization,
      work_email, phone, country, organization_type, interest, heard_about, consent_to_contact, user_agent
    ) VALUES (?, ?, ?, 'pending', 'Demo request', ?, 'Role', 'Org', 'person@example.com', '+1 202 555 0199', '', '', '', '', 0, '')`
  ).run("22222222-2222-4222-8222-222222222222", "2026-11-24T00:00:00.000Z", "2026-11-24T00:00:00.000Z", "Ann <script>");

  const loggedOut = await worker.fetch(new Request("https://worker.test/admin"), env);
  const loggedOutHtml = await loggedOut.text();
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOutHtml.includes("Jordan Lee"), false);
  assert.equal(loggedOutHtml.includes(env.ADMIN_PASSWORD), false);

  const wrong = await worker.fetch(
    new Request("https://worker.test/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.41" },
      body: "password=nope",
    }),
    env
  );
  const wrongHtml = await wrong.text();
  assert.equal(wrong.status, 401);
  assert.equal(wrongHtml.includes("nope"), false);

  const login = await worker.fetch(
    new Request("https://worker.test/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.42" },
      body: `password=${encodeURIComponent(env.ADMIN_PASSWORD)}`,
    }),
    env
  );
  assert.equal(login.status, 303);
  const cookie = cookieFrom(login);
  assert.ok(cookie);
  const setCookie = login.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);

  const page = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /A &amp; B Research/);
  assert.match(html, /Ann &lt;script&gt;/);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes(">null<"), false);
  assert.equal(html.includes(">undefined<"), false);
  assert.equal(html.includes(env.ADMIN_PASSWORD), false);
  const csrf = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(csrf);

  const forged = await worker.fetch(
    new Request("https://worker.test/admin/requests/22222222-2222-4222-8222-222222222222", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `sphere_admin=${cookie}`,
      },
      body: "csrf=wrong&status=approved",
    }),
    env
  );
  assert.equal(forged.status, 403);

  const idRow = db.prepare("SELECT id FROM demo_requests WHERE full_name = ?").get("A & B Research");
  const approved = await worker.fetch(
    new Request(`https://worker.test/admin/requests/${idRow.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `sphere_admin=${cookie}`,
      },
      body: `csrf=${encodeURIComponent(csrf[1])}&status=approved&return_status=approved`,
    }),
    env
  );
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get("Location"), "/admin?status=approved");
  const updated = db.prepare("SELECT status FROM demo_requests WHERE id = ?").get(idRow.id);
  assert.equal(updated.status, "approved");

  const filtered = await worker.fetch(
    new Request("https://worker.test/admin?status=pending", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const filteredHtml = await filtered.text();
  assert.equal(filteredHtml.includes("A &amp; B Research"), false);
  assert.match(filteredHtml, /Ann &lt;script&gt;/);
});

test("rate limits admin sign-in attempts", async () => {
  const db = createDb();
  const env = makeEnv(db, { ADMIN_LOGIN_RATE_LIMIT: "2", ADMIN_LOGIN_WINDOW_MS: "600000" });
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "CF-Connecting-IP": "203.0.113.77",
  };
  const attempt = () =>
    worker.fetch(
      new Request("https://worker.test/admin/login", { method: "POST", headers, body: "password=nope" }),
      env
    );
  assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 401);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /Too many sign-in attempts/);
});

test("an expired session is rejected when cleanup fails", async () => {
  const db = createDb();
  const real = d1(db);
  const env = makeEnv(db);
  env.DB = {
    prepare(sql) {
      if (sql.includes("DELETE FROM admin_sessions")) {
        return {
          bind() {
            return {
              async run() {
                throw new Error("cleanup failed");
              },
            };
          },
        };
      }
      return real.prepare(sql);
    },
  };
  const token = "c".repeat(64);
  const past = "2020-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO admin_sessions (token_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(await sha256Hex(token), "csrf-token", past, past);

  const expired = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: `sphere_admin=${token}` } }),
    env
  );
  const expiredHtml = await expired.text();
  assert.equal(expired.status, 200);
  assert.match(expiredHtml, /type="password"/);
  assert.equal(expiredHtml.includes("Sign out"), false);

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const liveToken = "d".repeat(64);
  db.prepare(
    "INSERT INTO admin_sessions (token_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(await sha256Hex(liveToken), "csrf-token", future, future);
  const current = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: `sphere_admin=${liveToken}` } }),
    env
  );
  const currentHtml = await current.text();
  assert.equal(current.status, 200);
  assert.match(currentHtml, /Sign out/);
  assert.equal(currentHtml.includes('id="password"'), false);
});

test("admin details keep older optional answers and skip blanks", () => {
  const older = requestDetailItems({
    job_title: "Role",
    country: "United Kingdom",
    organization_type: "CRO",
    interest: "Shells and the tracker.",
    heard_about: "Colleague",
    consent_to_contact: 1,
    request_type: "Demo request",
    updated_at: "2026-11-24T00:00:00.000Z",
  });
  const olderLabels = older.map(([label]) => label);
  assert.ok(olderLabels.includes("Country or region"));
  assert.ok(olderLabels.includes("Organization type"));
  assert.ok(olderLabels.includes("Interested in"));
  assert.ok(olderLabels.includes("Heard about SPHERE"));
  assert.deepEqual(
    older.find(([label]) => label === "Consent to be contacted"),
    ["Consent to be contacted", "Yes"]
  );

  const blank = requestDetailItems({
    job_title: "Role",
    country: null,
    organization_type: "  ",
    interest: "",
    heard_about: null,
    consent_to_contact: null,
    request_type: "Demo request",
    updated_at: "2026-11-24T00:00:00.000Z",
  });
  const blankLabels = blank.map(([label]) => label);
  for (const label of ["Country or region", "Organization type", "Interested in", "Heard about SPHERE", "Consent to be contacted"]) {
    assert.equal(blankLabels.includes(label), false, label);
  }
  assert.equal(JSON.stringify(blank).includes("null"), false);
  assert.equal(JSON.stringify(blank).includes("undefined"), false);

  const declined = requestDetailItems({
    job_title: "Role",
    consent_to_contact: 0,
    request_type: "Demo request",
    updated_at: "2026-11-24T00:00:00.000Z",
  });
  assert.deepEqual(
    declined.find(([label]) => label === "Consent to be contacted"),
    ["Consent to be contacted", "No"]
  );
});

test("a short request still stores and the queue renders without the removed answers", async () => {
  const db = createDb();
  const env = makeEnv(db);
  const sent = await postDemo(
    env,
    payload({
      country: "United States",
      organizationType: "CRO",
      interest: "Tracker",
      heardAbout: "Conference",
      consentToContact: true,
    }),
    { ip: "203.0.113.61" }
  );
  assert.equal(sent.response.status, 201);
  const row = db.prepare("SELECT * FROM demo_requests").get();
  assert.equal(row.country, "");
  assert.equal(row.organization_type, "");
  assert.equal(row.interest, "");
  assert.equal(row.heard_about, "");
  assert.equal(row.consent_to_contact, null);

  const login = await worker.fetch(
    new Request("https://worker.test/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.62" },
      body: `password=${encodeURIComponent(env.ADMIN_PASSWORD)}`,
    }),
    env
  );
  const cookie = (login.headers.get("Set-Cookie") || "").match(/sphere_admin=([^;]*)/)[1];
  const page = await worker.fetch(
    new Request("https://worker.test/admin", { headers: { Cookie: `sphere_admin=${cookie}` } }),
    env
  );
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Jordan Lee/);
  assert.equal(html.includes("Country or region"), false);
  assert.equal(html.includes("Organization type"), false);
  assert.equal(html.includes("Heard about SPHERE"), false);
  assert.equal(html.includes("Consent to be contacted"), false);
});
