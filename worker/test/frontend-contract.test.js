import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

const banned = [["Ami", "soft"].join(""), ["ATU", "LIT"].join(""), ["MA", "RS"].join("")];

const customerFiles = [
  "index.html",
  "styles.css",
  "main.js",
  "demo-form.js",
  "config.js",
  "worker/src/validate.js",
  "worker/src/index.js",
  "worker/src/admin.js",
  "worker/src/email.js",
  "worker/src/http.js",
  "worker/src/cors.js",
  "worker/src/rate-limit.js",
];

test("customer-facing files do not name other companies or an inbox", () => {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  for (const path of customerFiles) {
    const text = read(path);
    for (const word of banned) {
      assert.equal(new RegExp(`\\b${word}\\b`, "i").test(text), false, `${path} contains ${word}`);
    }
    assert.equal(email.test(text), false, `${path} contains an email address`);
    assert.equal(text.includes("mailto:"), false, path);
  }
});

test("the contact section keeps its copy and replaces the mailto with the form", () => {
  const html = read("index.html");
  assert.match(html, /See SPHERE on your next study/);
  assert.match(html, /Request a walkthrough tailored to biometrics workflows/);
  assert.match(html, /Serious booth conversation\. No invented case studies\./);
  assert.match(html, /One governed workspace from data to/);
  assert.match(html, /Built for biometrics teams who deliver studies/);
  assert.match(html, /Inspection-minded by design/);
  assert.match(html, /id="demo-request-form"/);
  assert.match(html, /name="fullName"/);
  assert.match(html, /name="jobTitle"/);
  assert.match(html, /name="organization"/);
  assert.match(html, /name="workEmail"/);
  assert.match(html, /name="phone"/);
  assert.match(html, /name="consentToContact"/);
  assert.match(html, /Pharma\/biotech/);
  assert.match(html, /aria-describedby="full-name-error"/);
  assert.match(html, /aria-invalid="false"/);
  assert.equal((html.match(/href="#contact\?type=demo"/g) || []).length, 3);
  assert.match(read("main.js"), /site-nav/);
  assert.match(read("config.js"), /https:\/\/sphere-demo-requests\.<account>\.workers\.dev\/api\/demo-requests/);
  assert.match(read("demo-form.js"), /The SPHERE team will review the request and follow up/);
});

test("worker config keeps email off and lists the public origins", () => {
  const toml = read("worker/wrangler.toml");
  assert.match(toml, /NOTIFY_EMAIL_ENABLED = "false"/);
  assert.match(toml, /EMAIL_PROVIDER = "off"/);
  assert.match(toml, /database_id = "<d1-database-id>"/);
  assert.match(toml, /https:\/\/www\.spheresce\.com/);
  assert.match(toml, /https:\/\/[a-z0-9-]+\.github\.io/);
  assert.equal(/^\s*account_id\s*=/m.test(toml), false);
  assert.match(read("worker/README.md"), /npx wrangler d1 migrations apply sphere-demo-requests --remote/);
  assert.match(read("worker/README.md"), /NOTIFY_EMAIL_ENABLED/);
});
