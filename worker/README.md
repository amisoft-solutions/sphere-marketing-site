# SPHERE demo requests

Cloudflare Worker and D1 database for the marketing-site demo form. The Worker stays on a `workers.dev` hostname. Do not add a route, custom domain, or DNS record for spheresce.com, and do not edit the `CNAME` file. The live Pages source is unchanged by this repo until someone switches it in the repository settings. See the site README for that one-time step.

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

Copy `.dev.vars.example` to `.dev.vars`, set `ADMIN_PASSWORD` and `RATE_LIMIT_SALT`, and leave `COOKIE_SECURE=false` so the admin cookie works on `http://localhost`. The example also sets `ALLOW_LOCALHOST=true`, which is the only place localhost is allowed. Production `wrangler.toml` sets `ALLOW_LOCALHOST` to `false`. `.dev.vars` is gitignored.

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

   That applies `migrations/0001_init.sql` and `migrations/0002_approval_email.sql`.

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

   Wrangler prints a `workers.dev` URL. There is no custom domain to configure.

7. The deployed API is `https://sphere-demo-requests.aged-bonus-5453.workers.dev/api/demo-requests`. `config.js` is already set to that URL. It is the only place the page reads the endpoint. Do not put an inbox address in any file under the site root.

8. Open the Worker’s `/admin` path and sign in with `ADMIN_PASSWORD`.

`ALLOWED_ORIGINS` in `wrangler.toml` lists `https://www.spheresce.com` and `https://spheresce.com`. `ALLOW_LOCALHOST` is `false` there, so localhost is not accepted in production. Append another origin to that variable at deploy time if a preview host must call the API, and do not commit an organization hostname. `.dev.vars` is what turns localhost on for `wrangler dev`.

Optional rate-limit vars, if the defaults (8 demo posts per IP per hour, 8 admin sign-in attempts per IP per 15 minutes) are too tight:

- `DEMO_RATE_LIMIT`
- `DEMO_RATE_WINDOW_MS`
- `ADMIN_LOGIN_RATE_LIMIT`
- `ADMIN_LOGIN_WINDOW_MS`

## Approval email

When an admin marks a request approved, the Worker can email that person the demo video link. `APPROVAL_EMAIL_ENABLED` is `false` in `wrangler.toml`. Leave it false until `https://video.spheresce.com` resolves and spheresce.com is onboarded to Email Sending. The queue works with the flag off.

The message is sent with the `SEND_EMAIL` binding. Recipients are not restricted. `allowed_sender_addresses` is only `no-reply@spheresce.com`, so the from address cannot drift. Sending to arbitrary recipients requires the Workers Paid plan. The Workers Free plan can send only to verified destination addresses.

`EMAIL_FROM` is `SPHERE team <no-reply@spheresce.com>`. `VIDEO_URL` is `https://video.spheresce.com`. The message greets the person by name, includes that video link, and signs off as the SPHERE team. It does not set a response address.

Onboard spheresce.com before turning the flag on:

1. The zone must use Cloudflare DNS. In the dashboard, open Compute > Email Service > Email Sending and choose Onboard Domain for spheresce.com.
2. Apply the `cf-bounce` records Cloudflare shows. Leave the apex MX and SPF records alone. The new records are:
   - MX records on `cf-bounce.spheresce.com` so bounces route to Cloudflare.
   - TXT on `cf-bounce.spheresce.com`: `v=spf1 include:_spf.mx.cloudflare.net ~all`
   - TXT on `cf-bounce._domainkey.spheresce.com` for the DKIM key Cloudflare generates.
3. Add DMARC on `_dmarc.spheresce.com`. Onboarding may add `v=DMARC1; p=reject` when no DMARC record exists. If anything else might send as `@spheresce.com`, start with `p=none`, confirm the new mail authenticates, then tighten the policy. Use the exact records from the dashboard. Leave `APPROVAL_EMAIL_ENABLED` false until `https://video.spheresce.com` resolves.

Approving a request claims the row when it has not been sent and there is no claim from the last 3 minutes, sends once, then sets `approval_email_sent_at`. A failed send stores `approval_email_error` and clears the claim. A claim older than 3 minutes is recorded as failed so the queue does not stay on “Sending”; resend is then allowed. A duplicate is possible only if the first send had already left before that timeout. Approved rows that never got an email, including ones approved while the flag was off, have a Send action while the flag is on. Approving the same request again does not send a second message after a successful send. Rejected and pending requests are not emailed.

Admin notification mail below stays off. Do not set `NOTIFY_TO` for this feature.

## Email

Leave admin notification email off. New requests still appear in D1 and on `/admin`.

`NOTIFY_EMAIL_ENABLED` must be the string `true` or the Worker will not send mail. The recipient is the `NOTIFY_TO` secret, never a value in the repo, and never the work email on the request. If `NOTIFY_TO` is the same address as the requester, the send is skipped.

The admin-notification options below do not add DNS on spheresce.com. Approval mail, above, does.

### 1. Keep using the admin queue

No mailbox and no DNS. Review `/admin` and reply yourself from your own mail if you want to. This is the default.

### 2. Cloudflare Email Routing `send_email` on a zone you already route

Use this only when some other domain is already on Cloudflare Email Routing (MX already in place on that domain).

- The `send_email` binding is already present for approval mail. Do not add a destination allowlist to it.
- Set var `EMAIL_PROVIDER` to `cloudflare_email`.
- `EMAIL_FROM` is already the SPHERE sender. Point admin alerts at a different verified sender only if you turn this path on.
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

### What not to add for admin alerts

Do not turn on admin alerts by adding these:

- Cloudflare Email Routing on spheresce.com
- MailChannels records on spheresce.com
- A Worker route or custom domain that points spheresce.com at this Worker

Approval mail uses Email Sending on spheresce.com, which is the `cf-bounce` records and DMARC described above. That is separate from admin alerts.

## Files

| Path | Purpose |
| --- | --- |
| `src/index.js` | Public `POST /api/demo-requests` |
| `../shared/demo-request-validate.js` | Shared validation. The marketing page imports this file. Do not put secrets or an endpoint in it. |
| `src/admin.js` | `/admin` queue |
| `src/email.js` | Admin alerts (off) and approval mail (off until the video host resolves) |
| `migrations/0001_init.sql` | D1 schema |
| `migrations/0002_approval_email.sql` | Approval email columns |
| `wrangler.toml` | Bindings and placeholders |

## Request body

JSON fields: `requestType` (`Demo request`), `fullName`, `jobTitle`, `organization`, `workEmail`, `phone`, optional `country`, `organizationType` (`Pharma/biotech`, `CRO`, `Academic`, `Other`), `interest`, `heardAbout`, `consentToContact`, `faxNumber` (honeypot, must be empty), and `formLoadedAt` (millisecond timestamp from when the form was shown).
