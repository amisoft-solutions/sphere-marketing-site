import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { signVideoToken, verifyVideoToken } from "../src/video-token.js";
import { srtToVtt } from "../src/srt.js";
import { createDb, makeEnv } from "./helpers.js";

const SECRET = "test-video-secret";
const ID = "55555555-5555-4555-8555-555555555555";

function videoBytes() {
  return new TextEncoder().encode("0123456789abcdef");
}

function bucket() {
  const bytes = videoBytes();
  const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello there\n";
  return {
    async head(key) {
      if (key.endsWith(".mp4")) return { size: bytes.length };
      return null;
    },
    async get(key, options = {}) {
      if (key.endsWith(".srt")) {
        return { text: async () => srt, body: null, size: srt.length };
      }
      let offset = 0;
      let length = bytes.length;
      if (options.range) {
        offset = options.range.offset;
        length = options.range.length;
      }
      const slice = bytes.slice(offset, offset + length);
      return {
        size: bytes.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      };
    },
  };
}

async function approvedToken(db, { status = "approved", expiryEpoch, secret = SECRET } = {}) {
  const expiry = expiryEpoch ?? Math.floor(Date.now() / 1000) + 3600;
  const token = await signVideoToken(secret, ID, expiry);
  db.prepare(
    `INSERT INTO demo_requests (
      id, created_at, updated_at, status, request_type, full_name, job_title, organization,
      work_email, phone, consent_to_contact, video_link_expires_at
    ) VALUES (?, ?, ?, ?, 'Demo request', 'Jordan Lee', 'Role', 'Org', 'person@example.com', '+1 202 555 0199', 0, ?)`
  ).run(ID, "2026-11-24T00:00:00.000Z", "2026-11-24T00:00:00.000Z", status, new Date(expiry * 1000).toISOString());
  return { token, expiry };
}

test("tokens verify, expire, and reject tampering", async () => {
  const expiry = Math.floor(Date.now() / 1000) + 100;
  const token = await signVideoToken(SECRET, ID, expiry);
  const ok = await verifyVideoToken(SECRET, token, Math.floor(Date.now() / 1000));
  assert.equal(ok.ok, true);
  assert.equal(ok.id, ID);
  assert.equal(ok.expiry, expiry);

  const expired = await verifyVideoToken(SECRET, token, expiry + 1);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");

  const [payload, signature] = token.split(".");
  const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
  const bad = await verifyVideoToken(SECRET, tampered, Math.floor(Date.now() / 1000));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid");
  const wrongSecret = await verifyVideoToken("other-secret", token);
  assert.equal(wrongSecret.ok, false);
});

test("a link is revoked when the request is not approved", async () => {
  const db = createDb();
  const { token } = await approvedToken(db, { status: "rejected" });
  const env = makeEnv(db, { VIDEO_LINK_SECRET: SECRET, VIDEO_BUCKET: bucket() });
  const response = await worker.fetch(new Request(`https://video.spheresce.com/v/${token}`), env);
  assert.equal(response.status, 410);
  const html = await response.text();
  assert.match(html, /This link has expired or is invalid\. Please contact the SPHERE team\./);
  assert.equal(html.includes("Password"), false);
});

test("video range requests return 206 and captions are converted", async () => {
  const db = createDb();
  const { token } = await approvedToken(db);
  const env = makeEnv(db, { VIDEO_LINK_SECRET: SECRET, VIDEO_BUCKET: bucket() });
  const response = await worker.fetch(
    new Request(`https://video.spheresce.com/v/${token}/video`, { headers: { Range: "bytes=0-4" } }),
    env
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Content-Range"), "bytes 0-4/16");
  assert.equal(response.headers.get("Content-Length"), "5");
  assert.equal(response.headers.get("Cache-Control"), "private");
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), "01234");

  const open = await worker.fetch(
    new Request(`https://video.spheresce.com/v/${token}/video`, { headers: { Range: "bytes=100-120" } }),
    env
  );
  assert.equal(open.status, 416);
  assert.match(open.headers.get("Content-Range"), /bytes \*\/16/);

  const captions = await worker.fetch(new Request(`https://video.spheresce.com/v/${token}/captions.vtt`), env);
  assert.equal(captions.status, 200);
  const vtt = await captions.text();
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500/);
  assert.equal(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHi\n").includes(","), false);

  const page = await worker.fetch(new Request(`https://video.spheresce.com/v/${token}`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /SPHERE Executive Overview/);
  assert.match(html, /<video/);
  assert.match(html, /captions\.vtt/);
  assert.equal(page.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
});

test("the video host does not expose admin or the API", async () => {
  const db = createDb();
  const env = makeEnv(db, { VIDEO_LINK_SECRET: SECRET, VIDEO_BUCKET: bucket() });
  const admin = await worker.fetch(new Request("https://video.spheresce.com/admin"), env);
  assert.equal(admin.status, 404);
  const adminHtml = await admin.text();
  assert.equal(adminHtml.includes("Password"), false);
  assert.match(adminHtml, /This link has expired or is invalid/);
  const api = await worker.fetch(new Request("https://video.spheresce.com/api/demo-requests", { method: "POST" }), env);
  assert.equal(api.status, 404);
  const workerAdmin = await worker.fetch(new Request("https://worker.test/admin"), env);
  assert.equal(workerAdmin.status, 200);
  assert.match(await workerAdmin.text(), /Password/);
});
