import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { countRequests, createDb, makeEnv, payload } from "./helpers.js";

const ADMIN = "https://admin.spheresce.com";
const VIDEO = "https://video.spheresce.com";
const WORKERS = "https://sphere-demo-requests.aged-bonus-5453.workers.dev";

function cookieFrom(response) {
  const header = response.headers.get("Set-Cookie") || "";
  const match = header.match(/sphere_admin=([^;]*)/);
  return match ? match[1] : "";
}

test("the admin host serves the queue at / and does not serve the API or video", async () => {
  const db = createDb();
  const env = makeEnv(db, { COOKIE_SECURE: "true" });

  const home = await worker.fetch(new Request(`${ADMIN}/`), env);
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, /type="password"/);
  assert.match(homeHtml, /action="\/login"/);
  assert.equal(homeHtml.includes(env.ADMIN_PASSWORD), false);
  assert.equal(homeHtml.includes('"service"'), false);

  const legacy = await worker.fetch(new Request(`${ADMIN}/admin`), env);
  const legacyHtml = await legacy.text();
  assert.equal(legacy.status, 200);
  assert.match(legacyHtml, /action="\/login"/);

  const api = await worker.fetch(
    new Request(`${ADMIN}/api/demo-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ADMIN },
      body: JSON.stringify(payload()),
    }),
    env
  );
  assert.equal(api.status, 404);
  assert.equal(countRequests(db), 0);

  const video = await worker.fetch(new Request(`${ADMIN}/v/not-a-token`), env);
  const videoText = await video.text();
  assert.equal(video.status, 404);
  assert.equal(videoText.includes("SPHERE Executive Overview"), false);
  assert.equal(videoText.includes("type=\"password\""), false);
});

test("admin host sign-in keeps the session cookie on that host", async () => {
  const db = createDb();
  const env = makeEnv(db, { COOKIE_SECURE: "true" });
  await worker.fetch(
    new Request("https://worker.test/api/demo-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.60" },
      body: JSON.stringify(payload({ fullName: "Queue Person" })),
    }),
    env
  );

  const wrong = await worker.fetch(
    new Request(`${ADMIN}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.61" },
      body: "password=nope",
    }),
    env
  );
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.text()).includes("nope"), false);

  const login = await worker.fetch(
    new Request(`${ADMIN}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.62" },
      body: `password=${encodeURIComponent(env.ADMIN_PASSWORD)}`,
    }),
    env
  );
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("Location"), "/");
  const setCookie = login.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Domain=admin\.spheresce\.com(?:;|$)/);
  assert.equal(/Domain=\.?spheresce\.com(?:;|$)/.test(setCookie), false);
  assert.equal(setCookie.includes("Domain=video.spheresce.com"), false);
  assert.equal(setCookie.includes(env.ADMIN_PASSWORD), false);
  const cookie = cookieFrom(login);
  assert.ok(cookie);

  const page = await worker.fetch(new Request(`${ADMIN}/`, { headers: { Cookie: `sphere_admin=${cookie}` } }), env);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Queue Person/);
  assert.match(html, /action="\/logout"/);
  assert.match(html, /href="\/"/);
  assert.match(html, /href="\/\?status=pending"/);
  assert.match(html, /action="\/requests\//);
  assert.equal(html.includes('id="password"'), false);
  assert.equal(html.includes(env.ADMIN_PASSWORD), false);
  const csrf = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(csrf);

  const id = db.prepare("SELECT id FROM demo_requests WHERE full_name = ?").get("Queue Person").id;
  const forged = await worker.fetch(
    new Request(`${ADMIN}/requests/${id}`, {
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

  const approved = await worker.fetch(
    new Request(`${ADMIN}/requests/${id}`, {
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
  assert.equal(approved.headers.get("Location"), "/?status=approved");

  const logout = await worker.fetch(
    new Request(`${ADMIN}/logout`, {
      method: "POST",
      headers: { Cookie: `sphere_admin=${cookie}` },
    }),
    env
  );
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("Location"), "/");
  const cleared = logout.headers.get("Set-Cookie") || "";
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Domain=admin\.spheresce\.com(?:;|$)/);
});

test("the video host still serves no admin, and workers.dev is unchanged", async () => {
  const db = createDb();
  const env = makeEnv(db, { COOKIE_SECURE: "true" });

  const videoAdmin = await worker.fetch(new Request(`${VIDEO}/admin`), env);
  const videoAdminHtml = await videoAdmin.text();
  assert.equal(videoAdmin.status, 404);
  assert.equal(videoAdminHtml.includes("Password"), false);
  assert.match(videoAdminHtml, /This link has expired or is invalid/);

  const videoHome = await worker.fetch(new Request(`${VIDEO}/`), env);
  const videoHomeHtml = await videoHome.text();
  assert.equal(videoHome.status, 404);
  assert.equal(videoHomeHtml.includes("type=\"password\""), false);
  assert.equal(videoHomeHtml.includes('"service"'), false);

  const videoApi = await worker.fetch(new Request(`${VIDEO}/api/demo-requests`, { method: "POST" }), env);
  assert.equal(videoApi.status, 404);
  const videoLogin = await worker.fetch(new Request(`${VIDEO}/login`), env);
  assert.equal(videoLogin.status, 404);
  assert.equal((await videoLogin.text()).includes("Password"), false);

  for (const base of ["https://worker.test", WORKERS]) {
    const health = await worker.fetch(new Request(`${base}/`), env);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "sphere-demo-requests" });

    const admin = await worker.fetch(new Request(`${base}/admin`), env);
    const adminHtml = await admin.text();
    assert.equal(admin.status, 200);
    assert.match(adminHtml, /action="\/admin\/login"/);
    assert.equal(adminHtml.includes(env.ADMIN_PASSWORD), false);

    const rootLogin = await worker.fetch(new Request(`${base}/login`), env);
    assert.equal(rootLogin.status, 404);
  }

  const login = await worker.fetch(
    new Request(`${WORKERS}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.70" },
      body: `password=${encodeURIComponent(env.ADMIN_PASSWORD)}`,
    }),
    env
  );
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("Location"), "/admin");
  const setCookie = login.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  assert.equal(/Domain=/i.test(setCookie), false);

  const lookalike = await worker.fetch(new Request("https://admin.spheresce.com.evil.example/"), env);
  assert.deepEqual(await lookalike.json(), { ok: true, service: "sphere-demo-requests" });

  const intake = await worker.fetch(
    new Request("https://worker.test/api/demo-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ADMIN,
        "CF-Connecting-IP": "203.0.113.71",
      },
      body: JSON.stringify(payload()),
    }),
    env
  );
  assert.equal(intake.status, 403);
  assert.equal(intake.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(countRequests(db), 0);
});
