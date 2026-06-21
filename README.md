# Chobble Tickets

Chobble Tickets is a reservation system that runs on Bunny Edge Scripting (or any Deno environment) with libsql, which encrypts all PII at rest and handles free and paid listings with Stripe or Square.

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

- Stripe and Square, with a provider interface so adding others is straightforward
- Enter your API key in admin settings and the webhook endpoint configures itself
- Checkout sessions with metadata, webhook-driven attendee creation
- Configurable booking fee added to each transaction
- "Pay what you want" pricing with optional minimum and maximum
- Automatic refund if capacity exceeded after payment or listing price changes during checkout
- Admin-issued full refunds for individual attendees or all attendees in bulk

### Check-in

- Each ticket gets a unique URL (`/t/:token`) with a QR code
- Staff scan QR to reach check-in page, toggle check-in/out
- Built-in QR scanner - open from a listing page, uses device camera, check-in-only (no accidental check-outs)
- ID verification prompt for non-transferable listings before completing check-in
- Cross-listing detection: scanner warns if a ticket belongs to a different listing
- Multi-ticket view for multi-listing bookings (`/t/token1+token2`)

### Apple Wallet

- Generates `.pkpass` files for Apple Wallet with listing details and barcode
- Web service API for automatic pass updates (follows the Apple Wallet spec)
- Configurable via admin settings or environment variables

### Admin

- Listing CRUD, duplicate, deactivate/reactivate, delete (requires typing listing name)
- Calendar view for daily listings with per-date attendee counts
- Attendee list with date filtering (daily listings), check-in status filtering
- Attendee editing - update name, contact details, quantity, or reassign to a different listing
- CSV export (respects active filters)
- Per-listing and global activity log (creation, updates, check-ins, exports, refunds, deletions)
- Holiday/blackout date management for daily listings
- Multi-user: owners invite managers via time-limited links (7-day expiry)
- Session management: view active sessions, kill all others
- Settings: payment provider config, email templates, custom domain, embed host restrictions, terms and conditions, password change
- Privacy tools (`/admin/privacy`): plain-language data-minimisation guidance, automatic/manual purging of orphaned attendee records, and GDPR erasure of a contact's recognition record by email or phone
- Branding: custom header image, website title, theme colours
- Built-in admin guide (`/admin/guide`) with FAQ for all features
- Ntfy error notifications for production monitoring (optional)

### Feeds

- ICS calendar feed (`/feeds/listings.ics`) for calendar apps
- RSS feed (`/feeds/listings.rss`) for feed readers

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
- If you lose the password, the data is permanently unreadable - there is no backdoor

### Concurrency

- Capacity check + insert in a single SQL statement to reduce the window for overbooking
- Payment webhook idempotency via two-phase locking on `processed_payments` table
- Stale reservation auto-cleanup after 5 minutes

### Security

- CSRF: double-submit cookie with 256-bit random tokens, path-scoped
- Rate limiting: 5 failed logins → 15-minute IP lockout (IPs HMAC-hashed before storage)
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

**Database maintenance:** pruning of expired sessions, rate-limit rows, payment idempotency records and (optionally) orphaned attendees runs automatically while serving requests, self-gated to roughly once per `PRUNE_INTERVAL_HOURS` (default 24) per table — so a site with regular traffic needs no setup. To guarantee pruning on a quiet site, point a cron at `GET /scheduled` — a dynamic route that prunes on every hit (static asset URLs such as `/favicon.ico` are served before pruning runs, so they won't do). On a builder, `POST /scheduled` additionally pokes the least-recently-pruned built site (a plain request that triggers _its_ prune), so one cron on the master keeps quiet client sites pruned too — run it often enough to cover the fleet within `PRUNE_INTERVAL_HOURS` (e.g. hourly handles ~24 clients at the default).

**Backups:** every table is dumped to a single `.zip`, with table reads keyset-paginated so no single response trips libsqld's "Response is too large" payload cap (the server limit behind Bunny's databases). Backups run **out-of-band**, not inside the migration: a full dump of a ~31-table schema can't fit alongside a migration within one edge request's [50-subrequest budget](https://docs.bunny.net/scripting/limits), so migrations just migrate, and a backup is taken by GitHub Actions (or `deno task backup`) beforehand. To enforce that, **`/admin/update` and the per-site update button refuse to deploy unless a backup of that database was taken in the last hour.**

The deploy workflows back a site up (via `POST /instance/site-credentials`) before deploying to it (the staging push-to-`main` trigger is the one exception — see below):

- **`.github/workflows/backup.yml`** (manual) — backs up the main instance's own database with `DB_URL` / `DB_TOKEN` / `STORAGE_ZONE_NAME` / `STORAGE_ZONE_KEY` repository secrets.
- **`.github/workflows/deploy-clients.yml`** (manual) — upgrades every built client site. It asks the main instance for the fleet's read-only DB credentials, backs each site up to the builder's storage, then deploys. It needs the `MAIN_INSTANCE` URL secret plus `STORAGE_ZONE_*` and `BUNNY_ACCESS_KEY`; the `MAIN_INSTANCE_KEY` that authorizes the credentials endpoint is **pasted in as a run input each time, never stored** (set the same value as the main instance's `MAIN_INSTANCE_KEY` env). `BUNNY_SCRIPT_DATA` is no longer needed — the script ids come from the endpoint.
- **`.github/workflows/bunny-deploy.yml`** (staging) and **`.github/workflows/production-deploy.yml`** — same flow narrowed to the single site whose script id matches `BUNNY_STAGING_SCRIPT_ID` / `BUNNY_SCRIPT_ID` (the deploy **fails unless exactly one** fleet site matches), via the shared `backup-site` action. They take `MAIN_INSTANCE_KEY` as a run input but fall back to the stored secret. **Only manual runs back up:** the staging push-to-`main` trigger (a merge) deploys without a backup, so it needs no `MAIN_INSTANCE_KEY` / `MAIN_INSTANCE` / `STORAGE_ZONE_*` secrets — just `BUNNY_STAGING_SCRIPT_ID` and `BUNNY_ACCESS_KEY`. A manual run backs up by default (needing those backup secrets, or the key pasted in) and can untick **Back up the database before deploying** to skip it — the escape hatch for when the backup itself is broken.

Tune `BACKUP_PAGE_SIZE` (default 500 rows per read) via env if a single page ever approaches the payload cap.

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
