# SPHERE demo requests

Cloudflare Worker and D1 database for the marketing-site demo form. The Worker stays on a `workers.dev` hostname. Do not add a route, custom domain, or DNS record for spheresce.com, and do not change GitHub Pages or the `CNAME` file.

The queue works with email turned off. `NOTIFY_EMAIL_ENABLED` defaults to `false`.

## What it does

- `POST /api/demo-requests` validates the same rules as the page, rejects the honeypot, rate-limits by IP, and stores a row with status `pending`, `approved`, or `rejected`.
- `GET /admin` lists requests, filters by status, and marks a request approved, rejected, or pending again.
- Approving a request only changes that status. The Worker never emails the person who submitted the form and never sends a demo video or viewing link.
- Browser calls are limited to the origins in `ALLOWED_ORIGINS`, plus localhost while `ALLOW_LOCALHOST` is `true`.

The admin password and the notification recipient are Worker secrets. They are not in this repo and not in the marketing page.

## Free tier

Workers and D1 both have a free tier that covers this queue. Rate limiting uses a D1 counter table, not the paid Workers rate-limiting binding. No paid add-on is required.

## Local checks

From this directory, on Node 22 or newer:

```bash
npm test
```

The marketing page can be previewed from the repository root:

```bash
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/#contact?type=demo`. The form validates in the browser. It will not deliver anywhere until `config.js` points at a deployed Worker.

For a local Worker:

```bash
npx wrangler d1 migrations apply sphere-demo-requests --local
```

Copy `.dev.vars.example` to `.dev.vars`, set `ADMIN_PASSWORD` and `RATE_LIMIT_SALT`, and leave `COOKIE_SECURE=false` so the admin cookie works on `http://localhost`. `.dev.vars` is gitignored.

```bash
npx wrangler dev
```

The local API is `http://127.0.0.1:8787/api/demo-requests`. Point a local copy of `config.js` at that URL only for the preview, and do not commit that change. Sign in at `http://127.0.0.1:8787/admin`.

## Deploy

1. Install Wrangler (3 or 4) and log in:

   ```bash
   npx wrangler login
   ```

2. From this directory, create the D1 database:

   ```bash
   npx wrangler d1 create sphere-demo-requests
   ```

3. Copy the printed database id into `wrangler.toml`, replacing `<d1-database-id>`. Leave `account_id` unset unless your Wrangler login needs it, and do not commit a real account id if you can avoid it. Do not put secrets in `wrangler.toml`.

4. Apply the migration:

   ```bash
   npx wrangler d1 migrations apply sphere-demo-requests --remote
   ```

   The schema is `migrations/0001_init.sql`.

5. Set secrets. Wrangler prompts for the value so it is not stored in the shell history as an argument if you paste it at the prompt:

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put RATE_LIMIT_SALT
   ```

   Use a long random admin password. Do not set `NOTIFY_TO` until you intentionally turn email on.

6. Deploy:

   ```bash
   npx wrangler deploy
   ```

   Wrangler prints a URL like `https://sphere-demo-requests.<account>.workers.dev`. There is no custom domain to configure.

7. In the repository root, edit `config.js` so `endpoint` is that origin plus `/api/demo-requests`:

   ```text
   https://sphere-demo-requests.<account>.workers.dev/api/demo-requests
   ```

   Commit that URL only after the Worker is deployed. `config.js` is the only place the page reads the endpoint. Do not put an inbox address in any file under the site root.

8. Open `https://<your-worker>.workers.dev/admin` and sign in with `ADMIN_PASSWORD`.

`ALLOWED_ORIGINS` in `wrangler.toml` already lists `https://www.spheresce.com`, `https://spheresce.com`, and this repository's GitHub Pages host (`https://<owner>.github.io`, with no repository path). `ALLOW_LOCALHOST=true` also allows `http://localhost` and `http://127.0.0.1` on any port. Change the variable and redeploy if the public origin changes.

Optional rate-limit vars, if the defaults (8 demo posts per IP per hour, 8 admin sign-in attempts per IP per 15 minutes) are too tight:

- `DEMO_RATE_LIMIT`
- `DEMO_RATE_WINDOW_MS`
- `ADMIN_LOGIN_RATE_LIMIT`
- `ADMIN_LOGIN_WINDOW_MS`

## Email

Leave email off. New requests still appear in D1 and on `/admin`.

`NOTIFY_EMAIL_ENABLED` must be the string `true` or the Worker will not send mail. The recipient is the `NOTIFY_TO` secret, never a value in the repo, and never the work email on the request. If `NOTIFY_TO` is the same address as the requester, the send is skipped.

Nothing below adds DNS on spheresce.com.

### 1. Keep using the admin queue

No mailbox and no DNS. Review `/admin` and reply yourself from your own mail if you want to. This is the default.

### 2. Cloudflare Email Routing `send_email` on a zone you already route

Use this only when some other domain is already on Cloudflare Email Routing (MX already in place on that domain).

- Uncomment the `send_email` binding in `wrangler.toml`.
- Set var `EMAIL_PROVIDER` to `cloudflare_email`.
- Set var `EMAIL_FROM` to a sender on that already-routed zone.
- Set secret `NOTIFY_TO` to the inbox that should receive the alert. Email Routing may require that destination to be verified.
- Set var `NOTIFY_EMAIL_ENABLED` to `true` and redeploy.

Sending as an address at spheresce.com would require Email Routing DNS on spheresce.com. Do not do that for this project.

### 3. A free transactional provider and an already-verified sender

Resend is wired up. The free tier is enough for a low volume of admin alerts.

- Verify a sender domain you already control. That DNS lives on the sender domain, not on spheresce.com. A provider that has already verified the sender does not need a new spheresce.com record.
- Set var `EMAIL_PROVIDER` to `resend`.
- Set var `EMAIL_FROM` to that verified sender.
- Set secrets `RESEND_API_KEY` and `NOTIFY_TO`.
- Set var `NOTIFY_EMAIL_ENABLED` to `true` and redeploy.

Other providers (for example Brevo or Postmark) are the same shape: an API key plus a sender that is already verified. Only Resend is implemented. Add another provider in `src/email.js` if you need one, and keep the flag off until it is configured.

### What would require spheresce.com DNS

Do not use these for this Worker:

- Cloudflare Email Routing, MX, SPF, or DKIM on spheresce.com
- MailChannels or any other setup that publishes new mail records on spheresce.com
- A custom domain or route that points spheresce.com at this Worker

## Files

| Path | Purpose |
| --- | --- |
| `src/index.js` | Public `POST /api/demo-requests` |
| `src/validate.js` | Shared validation. The marketing page imports this file. Do not put secrets or an endpoint in it. |
| `src/admin.js` | `/admin` queue |
| `src/email.js` | Notification flag, default off |
| `migrations/0001_init.sql` | D1 schema |
| `wrangler.toml` | Bindings and placeholders |

## Request body

JSON fields: `requestType` (`Demo request`), `fullName`, `jobTitle`, `organization`, `workEmail`, `phone`, optional `country`, `organizationType` (`Pharma/biotech`, `CRO`, `Academic`, `Other`), `interest`, `heardAbout`, `consentToContact`, `faxNumber` (honeypot, must be empty), and `formLoadedAt` (millisecond timestamp from when the form was shown).
