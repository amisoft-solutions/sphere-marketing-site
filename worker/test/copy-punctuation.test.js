import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COPY_ALLOWANCES,
  SYNTAX_EXCLUSIONS,
  extractVisiblePieces,
  scanHtml,
  scanJs,
  scanRepository,
  violationsInText,
} from "./visible-copy.js";

const root = new URL("../../", import.meta.url);

function marks(hits) {
  return hits.map((hit) => hit.mark).join("");
}

test("repository visible copy has no em dash, colon, or semicolon", () => {
  const violations = scanRepository(root);
  assert.deepEqual(
    violations,
    [],
    violations.map((hit) => `${hit.file}:${hit.line} [${hit.mark}] ${hit.text}`).join("\n")
  );
});

test("a deliberate em dash, colon, or semicolon in visible copy fails", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const colon = scanHtml("index.html", html.replace("</main>", "<p>You can watch the demo here:</p></main>"));
  assert.ok(colon.some((hit) => hit.mark === ":" && hit.text.includes("You can watch the demo here:")));
  const em = scanHtml("index.html", html.replace("</main>", "<p>Study &mdash; locked.</p></main>"));
  assert.ok(em.some((hit) => hit.mark === "—" && hit.text.includes("Study")));
  assert.ok(scanHtml("page.html", "<p>Study &#8212; locked.</p>").some((hit) => hit.mark === "—"));
  assert.ok(scanHtml("page.html", "<p>Study &#x2014; locked.</p>").some((hit) => hit.mark === "—"));
  const semi = scanHtml("index.html", html.replace("</main>", "<p>Shells in Word; trackers in Excel.</p></main>"));
  assert.ok(semi.some((hit) => hit.mark === ";"));
  assert.ok(violationsInText("Study &#8212; locked.").some((hit) => hit.char === "—"));
  assert.ok(violationsInText("Study &#x2014; locked.").some((hit) => hit.char === "—"));
  const js = scanJs("demo-form.js", 'showStatus(status, "Watch the demo here:", true);');
  assert.equal(marks(js), ":");
});

test("times, URLs, and decoded ampersands are allowed", () => {
  assert.deepEqual(violationsInText("Office hours are 9:00 to 17:30."), []);
  assert.deepEqual(violationsInText("The replay starts at 9:00:00."), []);
  assert.deepEqual(violationsInText("Submitted 2026-11-24T12:00:00.000Z."), []);
  assert.deepEqual(violationsInText("Open https://video.spheresce.com/v/abc today."), []);
  assert.deepEqual(violationsInText("Clinical study &amp; research."), []);
  assert.deepEqual(scanHtml("page.html", '<p>Meet at 9:00. See <a href="https://spheresce.com">https://spheresce.com</a>.</p>'), []);
});

test("style, script, comments, and HTTP syntax are not visible copy", () => {
  const html = [
    "<!-- HERO — navy band; single product screenshot only -->",
    "<style>a { color: red; }</style>",
    '<script>const label = "here:";</script>',
    "<p>Hello there.</p>",
  ].join("");
  assert.deepEqual(extractVisiblePieces(html).map((piece) => piece.text.trim()), ["Hello there."]);
  assert.deepEqual(scanHtml("page.html", html), []);
  const js = `
    const scheme = "https:";
    const other = "http:";
    const motion = "(prefers-reduced-motion: reduce)";
    const type = "text/html; charset=utf-8";
    const json = "application/json; charset=utf-8";
    const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";
    const cookie = "; ";
    const key = ":";
    // Timestamps use a comma; VTT uses a period.
    const fine = "Hello there.";
  `;
  assert.deepEqual(scanJs("sample.js", js), []);
});

test("the allowance list stays limited to real exceptions", () => {
  assert.deepEqual(COPY_ALLOWANCES.map((item) => item.id), ["url", "clock-time"]);
  assert.deepEqual(SYNTAX_EXCLUSIONS.map((item) => item.id), [
    "url-scheme",
    "media-type",
    "content-security-policy",
    "css-media-query",
    "wordless-code-punctuation",
  ]);
});
