# Chobble Tickets

Chobble Tickets is a reservation system that runs on Bunny Edge Scripting (or any Deno environment) with libsql, which encrypts all PII at rest and handles free and paid listings with Stripe, Square, or SumUp.

It is developed by [Chobble CIC](https://chobble.com) - a community interest company, which means the assets are locked to the community and can't be sold off.

**Website**: [tickets.chobble.com](https://tickets.chobble.com)

This is not "open core" - every feature is available under **AGPLv3** with no proprietary add-ons. If you'd rather not host it yourself, I offer hosted instances at [tix.chobble.com](https://tix.chobble.com/ticket/register) for £5/month or £50/year.

---

## Deploy on Bunny Edge Scripting

This is the recommended way to deploy it. Fork the repo, connect it to Bunny, and deploy via GitHub Actions - you can pull in upstream changes and push your own customisations on your own schedule.

1. **Fork or clone** this repository
2. **Create a Bunny Database** in the [Bunny dashboard](https://dash.bunny.net) - note the database URL and token
3. **Create a Bunny Edge Script** using your repository as the linked source
4. **Add secrets** to the script in the Bunny dashboard:

   | Secret              | Description                        |
   | ------------------- | ---------------------------------- |
   | `DB_URL`            | Your Bunny database URL            |
   | `DB_TOKEN`          | Your Bunny database auth token     |
   | `DB_ENCRYPTION_KEY` | 32-byte base64-encoded AES-256 key |

5. **Add GitHub Actions secrets** to your repository: `BUNNY_SCRIPT_ID` and `BUNNY_ACCESS_KEY`

Pushes to `main` trigger the deploy workflow automatically. The database schema auto-migrates on first request. Visit `/setup/` to set your admin password and currency.

For image uploads, also add `STORAGE_ZONE_NAME` and `STORAGE_ZONE_KEY` as Bunny secrets. See the [CONFIG_KEYS reference](https://chobbledotcom.github.io/tickets/doc.ts/~/CONFIG_KEYS.html) for all optional variables.

---

## Features

### Listings

- Standard listings (fixed capacity) and daily listings (per-date capacity with calendar picker)
- Listing groups for organising related listings together
- Optional listing date and location fields, displayed on the ticket page
- Configurable contact fields: email, phone, postal address (any combination)
- Special instructions field for attendee notes
- Terms and conditions - set globally in settings, attendees must agree before booking
- Capacity limits, max tickets per purchase, registration deadlines
- Multi-listing booking - combine listings in one URL (`/ticket/listing1+listing2`), one form, one checkout
- Multi-booking link builder on the dashboard for generating combined-listing URLs
- Listing QR code SVG (`/ticket/:slug/qr`) for posters and printed materials
- Embeddable via iframe with configurable CSP frame-ancestors
- Custom thank-you URL or default confirmation page
- Non-transferable tickets - per-listing toggle requiring ID verification at check-in
- Listing image and file attachment uploads (encrypted, stored on Bunny CDN)
- Manual attendee creation from the admin listing page (walk-ins, comps)

### Payments

- Stripe, Square, and SumUp, with a provider interface so adding others is straightforward
- Enter your API key in admin settings and the webhook endpoint configures itself
- Checkout sessions with metadata, webhook-driven attendee creation
- Configurable booking fee added to each transaction
- "Pay what you want" pricing with optional minimum and maximum
- Deposits / partial payments: take a flat, percentage, or per-item amount up front and track the rest as owed
- Self-service balance payment: attendees get a signed, PII-free `/pay/:token` link to pay off what they owe, no login
- With no provider configured, paid bookings are still accepted and recorded as a balance owed
- Automatic refund if capacity exceeded after payment or listing price changes during checkout
- Admin-issued full refunds for individual attendees or all attendees in bulk

### Check-in

- Each ticket gets a unique URL (`/t/:token`) with a QR code
- Staff scan QR to reach check-in page, toggle check-in/out
- Built-in QR scanner - open from a listing page, uses device camera, check-in-only (no accidental check-outs)
- ID verification prompt for non-transferable listings before completing check-in
- Cross-listing detection: scanner warns if a ticket belongs to a different listing
- Multi-ticket view for multi-listing bookings (`/t/token1+token2`)

### Wallet passes

- Apple Wallet: generates `.pkpass` files with listing details and barcode
- Web service API for automatic Apple pass updates (follows the Apple Wallet spec)
- Google Wallet: inline RS256-signed "Add to Google Wallet" save links
- Configurable via admin settings or environment variables

### Localisation

- ICU MessageFormat copy with locale picked from the `Accept-Language` header
- Rebrand layer (`I18N_REPLACEMENTS`): substring replacements (e.g. `ticket|booking`) that rewrite copy without touching HTML, links, or interpolated values, applied once at load

### Admin

- Listing CRUD, duplicate, deactivate/reactivate, delete (requires typing listing name)
- Calendar view for daily listings with per-date attendee counts
- Attendee list with date filtering (daily listings), check-in status filtering
- Attendee editing - update name, contact details, quantity, or reassign to a different listing
- CSV export (respects active filters)
- Per-listing and global activity log (creation, updates, check-ins, exports, refunds, deletions)
- Holiday/blackout date management for daily listings
- Multi-user with graded roles: owners invite managers (full back office) via time-limited links (7-day expiry), plus a content-only `editor` (edits listings/site but holds no data key, so attendee PII stays undecryptable) and a delivery `agent` (locked to its own run sheet)
- Session management: view active sessions, kill all others
- Attendee merge: deduplicate records with a review-then-apply diff that repoints ledger entries and posts write-off adjustments so balances stay correct
- Contact history per email/phone: last-contacted, visit/booking counts, and an owner-encrypted private note, keyed by a blind HMAC index
- Bulk email: compose/preview/send to filtered attendee groups with reusable subject/body templates (encrypted under the owner key); recipients get one-click unsubscribe / resubscribe / erase links
- Catalog import/export: export any listing or group as portable JSON and re-import it to move a catalog between sites
- Settings: payment provider config, email templates, custom domain, embed host restrictions, terms and conditions, password change
- Privacy tools (`/admin/privacy`): plain-language data-minimisation guidance, automatic/manual purging of orphaned attendee records, and GDPR erasure of a contact's recognition record by email or phone
- Demo mode (`DEMO_MODE=true`): replaces all user-entered text with generated sample data so demos hold no real PII
- Branding: custom header image, website title, theme colours
- Built-in admin guide (`/admin/guide`) with FAQ for all features
- Ntfy error notifications for production monitoring (optional; sends domain + error code only, never PII)

### Logistics

- Optional postcode/address lookup on booking and admin forms, via a same-origin proxy that keeps the provider key server-side, caches results encrypted, and rate-limits anonymous use; provider is pluggable
- Drop-off and collection dates per booking (collection on the last booked day)
- Van/agent allocations: assign a drop-off and collection agent per booking, filter the calendar by agent
- Delivery driver login (`agent` role): an auto-generated run sheet of today's and tomorrow's drop-offs and collections with per-leg done toggles, walled off from the rest of admin

### Multi-site hosting

- One-click site builder: provision a new tenant on Bunny Edge or Deno Deploy, auto-creating its database and its own encryption key
- Sell sites as products: buying a "site" listing auto-provisions and assigns a live site to the buyer, with its own renewal tracking and tokenised `/renew` flow
- Self-updating fleet: each site records its build commit; the host sees which sites are behind and redeploys them from the latest GitHub release
- Secret backfill: detects host secrets a site is missing and fills them in without overwriting deliberately-changed values

### Embedding

- Generated `<script>` and `<iframe>` snippets to drop the booking form onto an existing site
- `/order.js` widget turns any `data-add-listing` link on the operator's own site into a live multi-item cart, with per-origin CORS
- Iframe-aware checkout (popup vs redirect, hidden header, auto-resize) and a dynamic, CDN-cached `/custom.css` for restyling public pages

### SMS

- Two-way SMS to attendees via the SMS Gateway for Android relay, with message text and phone numbers encrypted before they leave the server
- Signed inbound webhook ingests delivery receipts and replies, matching inbound messages to the right attendee by phone

### Feeds

- ICS calendar feed (`/feeds/listings.ics`) for calendar apps
- RSS feed (`/feeds/listings.rss`) for feed readers
- CalDAV operations feed (`/caldav/events.ics`) of bookings for staff calendars, filtered per agent so a driver sees only their jobs

### Email Notifications

- Automatic confirmation email to attendees and notification email to admins on each registration
- Five HTTP API providers: Resend, Postmark, SendGrid, Mailgun (US/EU)
- Customisable email templates using Liquid syntax (subject, HTML body, text body)
- Built-in template filters: `currency` (formats amounts) and `pluralize`
- Configured in admin settings - optional, the system works without it

### Contact form

- Optional contact form on the public contact page
- Enabled per-site from **Site → Contact** — only needs a configured business email
- Submissions are CSRF-protected and emailed to the business address (reply-to set to the sender)
- [Botpoison](https://botpoison.com) proof-of-work spam protection is a progressive enhancement: set `BOTPOISON_PUBLIC_KEY`/`BOTPOISON_SECRET_KEY` and submissions must also pass server-side verification

### Public JSON API

- RESTful API for listing and booking (`/api/listings`, `/api/listings/:slug`, `/api/listings/:slug/availability`, `/api/listings/:slug/book`)
- No API key required - it serves the same data as the public booking pages
- CORS-enabled for cross-origin requests

### Webhooks

- Outbound POST on every registration (free or paid) to per-listing and/or global webhook URLs
- Payload: name, email, phone, address, amount, currency, payment ID, ticket URL, per-ticket details
- Multi-listing bookings send one consolidated webhook

<details>
<summary>Example webhook payload</summary>

<!-- This example is tested - see test/lib/webhook-example.test.ts -->

```json
{
  "address": "42 Oak Lane, Bristol, BS1 1AA",
  "amount_owed": 0,
  "business_email": "hello@example.com",
  "currency": "GBP",
  "email": "alice@example.com",
  "name": "Alice Smith",
  "notification_type": "registration.completed",
  "payment_id": "pi_3abc123def456",
  "phone": "+44 7700 900000",
  "price_paid": 3000,
  "special_instructions": "Wheelchair access needed",
  "ticket_url": "https://tickets.example.com/t/A1B2C3D4E5",
  "tickets": [
    {
      "date": "2025-08-20",
      "listing_name": "Summer Workshop",
      "listing_slug": "summer-workshop",
      "quantity": 2,
      "ticket_token": "A1B2C3D4E5",
      "unit_price": 1500
    }
  ],
  "timestamp": "2025-08-20T14:30:00.000Z"
}
```

Prices are in the smallest currency unit (e.g. pence, cents). For multi-listing bookings the `tickets` array contains one entry per listing and the `ticket_url` combines tokens with `+` - one webhook, not several.

</details>

### Encryption

- **Hybrid RSA-OAEP + AES-256-GCM** for attendee PII (name, email, phone, postal address)
  - Public key encrypts on submission (no auth needed)
  - Private key only available to authenticated admin sessions
  - A database dump alone is not sufficient to recover PII - an attacker would also need the encryption key from the environment
- **AES-256-GCM** for payment IDs, prices, check-in status, API keys, holiday names, usernames
- **PBKDF2** (600k iterations, SHA-256) for password hashing
- Three-layer key hierarchy: env var root key → RSA key pair → per-user wrapped data keys
- The data key is wrapped with a key derived from the admin password (never stored), so a database dump plus the environment key still can't decrypt PII without a login
- Activity log entries are encrypted with the owner's public key: unauthenticated code (webhooks, error handlers) can write them, but only a logged-in admin can read them
- If you lose the password, the data is permanently unreadable - there is no backdoor

### Concurrency

- Capacity check + insert in a single SQL statement to reduce the window for overbooking
- Payment webhook idempotency via two-phase locking on `processed_payments` table
- Stale reservation auto-cleanup after 5 minutes

### Security

- CSRF: double-submit cookie with 256-bit random tokens, path-scoped, plus an HMAC-signed cookieless fallback so checkout works inside in-app browsers that block cookies
- Rate limiting: 5 failed logins → 15-minute IP lockout (IPs HMAC-hashed before storage), plus separate lockouts on unknown ticket tokens and failed API keys
- SSRF guard: any URL the server fetches on the operator's behalf is forced to public HTTPS (localhost, `.internal`, and raw IPs rejected)
- Boot-time config checks: refuses to start with a missing/short encryption key rather than run insecure
- Constant-time password comparison with random delay
- Session tokens hashed before database storage, 24-hour expiry, HttpOnly cookies
- Content-Type validation on all POST endpoints

These measures aim to raise the cost of common attacks. They do not guarantee security against all scenarios - proper operational practices (key management, access control, monitoring) are equally important.

---

## Alternative Deployment

### Docker

```bash
docker build -t chobble-tickets .
docker run -p 3000:3000 \
  -v tickets-data:/data \
  -e DB_URL="file:/data/tickets.db" \
  -e DB_ENCRYPTION_KEY="your-base64-key" \
  chobble-tickets
```

The Dockerfile uses a local SQLite file by default - set `DB_URL` and `DB_TOKEN` to point at a remote Turso database instead if you prefer.

### One-click platforms

Deploy to: [DigitalOcean](https://cloud.digitalocean.com/apps/new?repo=https://github.com/chobbledotcom/tickets/tree/main) | [Heroku](https://heroku.com/deploy?template=https://github.com/chobbledotcom/tickets/tree/main) | [Koyeb](https://app.koyeb.com/deploy?type=git&repository=github.com/chobbledotcom/tickets&branch=main&name=chobble-tickets&builder=dockerfile&ports=3000;http;/) | [Render](https://render.com/deploy?repo=https://github.com/chobbledotcom/tickets)

You can also deploy with [Fly.io](https://fly.io) (`fly launch`) or any Docker host.

## Repository layout

For the current repository layout and path conventions, see [`REPO_STRUCTURE.md`](./REPO_STRUCTURE.md).

---

## Development

```bash
# Install Deno, cache dependencies, run all checks
./setup.sh

# Run locally
DB_URL=libsql://your-db.turso.io DB_TOKEN=your-token \
  DB_ENCRYPTION_KEY=your-base64-key deno task start

# Run tests (stripe-mock downloaded automatically)
deno task test
```

On first launch, visit `/setup/` to set admin credentials and currency. Payment providers are configured at `/admin/settings`.

### Available tasks

```
deno task start          # Run server
deno task test           # Run tests
deno task test:coverage  # Tests with coverage report
deno task lint           # Format + lint with Biome — fixes in place
deno task lint:ci        # Strict read-only lint (what precommit runs everywhere)
deno task typecheck      # Type check
deno task build:edge     # Build for Bunny Edge
deno task deploy:edge <script-id> # Build, upload, and publish to Bunny Edge using BUNNY_ACCESS_KEY from .env
deno task backup         # Dump the database out-of-band (uploads to storage; --out <path> for a local .zip)
deno task precommit      # All checks (typecheck, lint, cpd, build:edge, test:coverage)
```

### Environment variables

| Variable            | Required | Description                              |
| ------------------- | -------- | ---------------------------------------- |
| `DB_URL`            | Yes      | libsql database URL                      |
| `DB_TOKEN`          | Yes\*    | Database auth token (\*remote databases) |
| `DB_ENCRYPTION_KEY` | Yes      | 32-byte base64-encoded AES-256 key       |

Optional:

| Variable                | Description                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_EMAIL_ADDRESS`   | Enables a superuser recovery account and the owner-only Support page (`/admin/support`). The email local-part (before `@`) must be a valid username: 2–32 characters, letters, numbers, hyphens, and underscores only. Email delivery must be configured before the superuser can be enabled. |
| `SUPPORT_PAGE_TEXT`     | Optional markdown for the Support page (requires `ADMIN_EMAIL_ADDRESS`). Use literal `\n` for line breaks. The form beneath it delivers to `ADMIN_EMAIL_ADDRESS` and needs a business email, like the contact form.                          |
| `SUPPORT_FORM_NAG_DAYS` | Optional positive integer (default `7`): how long the Support page shows a "you last submitted this form …" notice after a submission, to discourage duplicates.                                                                            |
| `BOTPOISON_PUBLIC_KEY`  | Optional [Botpoison](https://botpoison.com) public key. When set with `BOTPOISON_SECRET_KEY`, adds proof-of-work spam protection to the contact form (which otherwise works without it).                                                       |
| `BOTPOISON_SECRET_KEY`  | Optional Botpoison secret key. Used server-side to verify contact form submissions when Botpoison is enabled.                                                                                                                                |

Optional:

| Variable | Description |
|----------|-------------|
| `ADMIN_EMAIL_ADDRESS` | Enables a superuser recovery account. The email local-part (before `@`) must be a valid username: 2–32 characters, letters, numbers, hyphens, and underscores only. Email delivery must be configured before the superuser can be enabled. |
| `DEBUG_KEY` | Optional diagnostic key. `GET /health` returns a plain `Up :)` by default; a request carrying a matching `X-Debug-Key` header gets a small JSON payload (build commit, build timestamp, server time). Unset ⇒ the verbose response is disabled. |

**Database maintenance:** pruning of expired sessions, rate-limit rows, payment idempotency records and (optionally) orphaned attendees runs automatically while serving requests, self-gated to roughly once per `PRUNE_INTERVAL_HOURS` (default 24) per table — so a site with regular traffic needs no setup. To guarantee pruning on a quiet site, point a cron at `GET /scheduled` — a dynamic route that prunes on every hit (static asset URLs such as `/favicon.ico` are served before pruning runs, so they won't do). On a builder, `POST /scheduled` additionally pokes the least-recently-pruned built site (a plain request that triggers _its_ prune), so one cron on the master keeps quiet client sites pruned too — run it often enough to cover the fleet within `PRUNE_INTERVAL_HOURS` (e.g. hourly handles ~24 clients at the default).

**Backups:** every table is dumped to a single `.zip`, with table reads keyset-paginated so no single response trips libsqld's "Response is too large" payload cap (the server limit behind Bunny's databases). Backups run **out-of-band**, not inside the migration: a full dump of a ~31-table schema can't fit alongside a migration within one edge request's [50-subrequest budget](https://docs.bunny.net/scripting/limits), so migrations just migrate, and a backup is taken by GitHub Actions (or `deno task backup`) beforehand. To enforce that, **`/admin/update` and the per-site update button refuse to deploy unless a backup of that database was taken in the last hour.**

The deploy workflows back a site up (via `POST /instance/site-credentials`) before deploying to it (the staging push-to-`main` trigger is the one exception — see below):

- **`.github/workflows/backup.yml`** (manual) — backs up the main instance's own database with `DB_URL` / `DB_TOKEN` / `STORAGE_ZONE_NAME` / `STORAGE_ZONE_KEY` repository secrets.
- **`.github/workflows/deploy-clients.yml`** (manual) — upgrades the built client sites that accept the published tier. It asks the main instance for the DB credentials of the sites on that tier (each site's own full-access token — the workflow only reads, to take backups), backs each up to the builder's storage, then deploys. The **`tier`** run input (`alpha` default, then `beta` or `release`) is the release channel being published: each site carries its own `updates` channel and only the sites at the deploy's tier or more eager are returned — a `release` deploy reaches every site, `beta` reaches beta + alpha sites, `alpha` only alpha sites. The default is `alpha` (the smallest blast radius), so you ship a risky build to alpha sites first and reaching the whole fleet is the deliberate `release` choice. For a canary (`alpha`/`beta`) the workflow **fails closed** unless the main instance echoes the tier back in its response, so running it against a master that predates tier filtering (which would ignore the filter and return the whole fleet) can't silently deploy to everyone — upgrade the master first. It needs the `MAIN_INSTANCE` URL secret plus `STORAGE_ZONE_*` and `BUNNY_ACCESS_KEY`; CDN-enabled builds additionally need the four optional CDN secrets below. The `MAIN_INSTANCE_KEY` that authorizes the credentials endpoint is **pasted in as a run input each time, never stored** (set the same value as the main instance's `MAIN_INSTANCE_KEY` env). `BUNNY_SCRIPT_DATA` is no longer needed — the script ids come from the endpoint.
- **`.github/workflows/bunny-deploy.yml`** (staging) and **`.github/workflows/production-deploy.yml`** — same flow narrowed to the single site whose script id matches `BUNNY_STAGING_SCRIPT_ID` / `BUNNY_SCRIPT_ID` (the deploy **fails unless exactly one** fleet site matches), via the shared `backup-site` action. They take `MAIN_INSTANCE_KEY` as a run input but fall back to the stored secret. **Only manual runs back up:** the staging push-to-`main` trigger (a merge) deploys without a backup, so it needs no `MAIN_INSTANCE_KEY` / `MAIN_INSTANCE` / `STORAGE_ZONE_*` secrets — just `BUNNY_STAGING_SCRIPT_ID` and `BUNNY_ACCESS_KEY`, plus the optional CDN secrets when CDN publishing is enabled. A manual run backs up by default (needing those backup secrets, or the key pasted in) and can untick **Back up the database before deploying** to skip it — the escape hatch for when the backup itself is broken.

**Optional static CDN builds:** set all four repository secrets `CDN_URL`, `CDN_BUNNY_STORAGE_ZONE_NAME`, `CDN_BUNNY_STORAGE_ZONE_KEY`, and `CDN_BUNNY_PULL_ZONE_ID` to publish site-independent browser bundles and image-codec WASM to a dedicated Bunny Storage/Pull Zone during the build. The existing `BUNNY_ACCESS_KEY` secret purges that pull zone after every successful upload. Each upload carries its SHA-256 checksum, and the build then fetches every public URL and verifies its bytes before emitting a script that depends on it. The generated script contains immutable, content-addressed CDN URLs and the matching CSP origin; these values are not runtime Bunny script secrets. Configure the pull zone's browser cache override for a long lifetime because these paths change whenever their content changes. Site-bound assets such as the embed bootstrap and dynamic order widget remain in each script. If all four CDN secrets are absent, the build remains fully self-contained. A partial configuration fails the build. Historical restore builds intentionally receive none of these secrets and therefore retain their embedded assets.

Tune `BACKUP_PAGE_SIZE` (default 500 rows per read) via env if a single page ever approaches the payload cap.

**Restoring to a point in time:** the running build records the git commit it was built from into its own `settings` table (`current_script_commit`, written on boot; cleared if a build ships without one, so it never goes stale), so every dump carries the commit the site was running when the backup was taken. Restoring a backup rolls back the **data** and surfaces that commit (the full SHA); to roll the **code** back to match, run the **`.github/workflows/restore-deploy.yml`** workflow with that commit and the target script id. It builds the edge bundle fresh from our repository at that commit (git is the per-commit source of truth) and deploys it — so a restore only ever redeploys a commit from our own history, never code carried inside an (untrusted) uploaded backup file. For safety the workflow validates the commit is a full SHA and deploys via the external Bunny action pinned to an immutable SHA, so the production API key is never handed to a deploy wrapper loaded from the checked-out (possibly old) commit. (The rebuilt old code reports the rebuild time as its build version, so the in-app updater may not surface the latest release afterwards — redeploy latest via the normal deploy workflow to return to it.)

See the [CONFIG_KEYS reference](https://chobbledotcom.github.io/tickets/doc.ts/~/CONFIG_KEYS.html) for all optional variables (email providers, Apple Wallet, image uploads, and more).

---

## Tech Stack

- **Runtime**: Deno - runs standalone, via Docker, or on Bunny Edge Scripting
- **Database**: libsql (local SQLite or remote Turso)
- **Payments**: Stripe, Square
- **Build**: esbuild, single-file output
- **Templates**: Server-rendered JSX
- **Crypto**: Web Crypto API (AES-256-GCM, RSA-OAEP, PBKDF2)

## License

AGPLv3 - developed by [Chobble CIC](https://chobble.com), a community interest company.
