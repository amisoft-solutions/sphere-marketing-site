# SPHERE marketing site

Single-page product marketing site for **SPHERE** (Statistical Programming Hub for Execution and Reporting Environment).

Layout rhythm inspired by ReceptWise (soft paper sections, pill CTAs, generous spacing, clear stacked sections). Brand locked to navy `#0A3D6F` + paper aesthetic — not ReceptWise teal.

## Visible copy

Visible copy on spheresce.com does not use an em dash, a colon, or a semicolon.

Use a hyphen instead of an em dash (`—`, `&mdash;`, `&#8212;`, `&#x2014;`). Use a period or a comma instead of a colon or semicolon. Slight rewording is fine. Clock times such as `9:00` keep their colons. URLs keep `https://`. CSS, JavaScript, HTML syntax, and HTTP header values are not copy.

`worker/test/copy-punctuation.test.js` runs with the other Worker tests on every pull request. It reads the marketing page, SVG text, demo-form messages, validation messages, the admin queue, both emails, and the video player. A later change that puts an em dash, colon, or semicolon back into that copy fails the check. The allowances live in `worker/test/visible-copy.js`.

## Structure (one long scroll)

1. Sticky nav (anchor links only)
2. **Navy hero** — pill eyebrow, headline, lead, pill CTAs, **exactly one** product screenshot (Study home) in browser chrome + float chips; wave into paper below
3. Who it’s for — persona cards
4. Commercial imagery mosaic — workplace / analytics stock photos (not product UI)
5. Why teams adopt — problem → outcome cards
6. Split visual — biometrics professionals in a corporate office + ops copy
7. Capabilities — text modules (Study home, Mock Shells, Tracker, Runs, Files, Packages/Define, Copilot, Admin) — no extra UI shots
8. Split visual — abstract analytics graphic + tracker clarity copy
9. Study delivery — abstract workflow diagram + delivery cards
10. Compliance & audit
11. How it works — 5 steps
12. Product principles
13. Navy CTA band → Request demo
14. Footer (© SPHERE)

**Product UI policy:** only `assets/shot-study-home.png` appears on the page. Tracker / mock-shells / row detail screenshots are intentionally not shipped.

**Commercial imagery:** royalty-free Unsplash/Pexels photos + a tasteful SVG analytics composite under `assets/img-*`. No personal or company founder names on the page.

## Preview

```bash
cd /workspace/sphere-marketing-site
python3 -m http.server 8765
# http://127.0.0.1:8765/
```

## Assets

- Brand lockups/marks from `/workspace/sphere-brand/pack/`
- Single UI shot: Study home
- Marketing imagery: `img-laptop-work.jpg`, `img-analytics-charts.jpg`, `img-team-laptop-sphere.jpg`, `img-team-office-professionals.jpg`, `img-analytics-graphic.svg`

## Proof

- `screenshots/home-desktop.png`
- `screenshots/home-mobile.png`

## Live

https://www.spheresce.com/

## Request a demo

The navy contact band includes a demo request form. Required fields are full name, job title, organization, work email, and phone. The browser posts JSON to the Worker URL in `config.js`.

Storage, validation, rate limiting, and the admin queue live in [`worker/`](worker/README.md). Email notifications are off until a mailbox path that does not need new DNS on spheresce.com is chosen. The queue works without email. Customer-facing copy refers to the SPHERE team. The form posts to the Worker URL in `config.js`.

## Publishing

The site on www.spheresce.com is still published from the branch. This pull request does not change that setting, DNS, or `CNAME`.

`.github/workflows/pages.yml` builds `_site` with `scripts/assemble-site.sh`. That directory contains the marketing files only: `index.html`, `styles.css`, `main.js`, `config.js`, `demo-form.js`, `shared/demo-request-validate.js`, `assets/`, `screenshots/`, and `CNAME`. It does not contain `worker/`.

Pull requests run the build so the file list can be checked. They do not deploy. A deploy runs only if someone starts **Publish marketing site** by hand, or if a push to `main` happens after the repository variable `PAGES_SOURCE_IS_ACTIONS` is `true`.

Merge steps:

1. Merge this pull request.
2. Settings → Pages → Source → GitHub Actions.
3. Run **Publish marketing site**. The workflow uploads the marketing directory and copies `CNAME` unchanged.
4. Set the repository variable `PAGES_SOURCE_IS_ACTIONS` to `true` so later pushes to `main` publish the same way.

Until step 1, the existing branch publish keeps serving the site.
