# Chobble Tickets

A self-hosted ticket reservation system built by [Chobble CIC](https://chobble.com), a community interest company. Runs on any Deno environment (or Bunny Edge Scripting) with libsql (Turso). Encrypts all PII at rest. Handles free and paid events with Stripe or Square.

**Website**: [tickets.chobble.com](https://tickets.chobble.com)

This is not "open core" — every feature is available under **AGPLv3** with no proprietary add-ons. Hosted instances available at [tix.chobble.com](https://tix.chobble.com/ticket/register) for £50/year, no tiers.

## Deploy

Deploy to: **[DigitalOcean](https://cloud.digitalocean.com/apps/new?repo=https://github.com/chobbledotcom/tickets/tree/main)**, **[Heroku](https://heroku.com/deploy?template=https://github.com/chobbledotcom/tickets/tree/main)**, **[Koyeb](https://app.koyeb.com/deploy?type=git&repository=github.com/chobbledotcom/tickets&branch=main&name=chobble-tickets&builder=dockerfile&ports=3000;http;/)**, or **[Render](https://render.com/deploy?repo=https://github.com/chobbledotcom/tickets)**

Also deployable with [Fly.io](https://fly.io) (`fly launch`) or any Docker host.

## Features

### Events
- Standard events (fixed capacity) and daily events (per-date capacity with calendar picker)
- Optional event date and location fields, displayed on the ticket page
- Configurable contact fields: email, phone, postal address (any combination)
- Terms and conditions — set globally in settings, attendees must agree before booking
- Capacity limits, max tickets per purchase, registration deadlines
- Multi-event booking — combine events in one URL (`/ticket/event1+event2`), one form, one checkout
- Multi-booking link builder on the dashboard for generating combined-event URLs
- Event QR code SVG (`/ticket/:slug/qr`) for posters and printed materials
- Embeddable via iframe with configurable CSP frame-ancestors
- Custom thank-you URL or default confirmation page
- Non-transferable tickets — per-event toggle requiring ID verification at check-in
- Manual attendee creation from the admin event page (walk-ins, comps)

### Payments
- Stripe and Square with a pluggable provider interface
- Enter your API key in admin settings — webhook endpoint auto-configures
- Checkout sessions with metadata, webhook-driven attendee creation
- Automatic refund if capacity exceeded after payment or event price changes during checkout
- Admin-issued full refunds for individual attendees or all attendees in bulk

### Check-in
- Each ticket gets a unique URL (`/t/:token`) with a QR code
- Staff scan QR to reach check-in page, toggle check-in/out
- Built-in QR scanner — open from an event page, uses device camera, check-in-only (no accidental check-outs)
- ID verification prompt for non-transferable events before completing check-in
- Cross-event detection: scanner warns if a ticket belongs to a different event
- Multi-ticket view for multi-event bookings (`/t/token1+token2`)

### Admin
- Event CRUD, duplicate, deactivate/reactivate, delete (requires typing event name)
- Attendee list with date filtering (daily events), check-in status filtering
- Attendee editing — update name, contact details, quantity, or reassign to a different event
- CSV export (respects filters)
- Per-event activity log (creation, updates, check-ins, exports, deletions)
- Holiday/blackout date management for daily events
- Multi-user: owners invite managers via time-limited links (7-day expiry)
- Session management: view active sessions, kill all others
- Settings: payment provider config, email templates, custom domain, embed host restrictions, terms and conditions, password change, database reset
- Built-in admin guide (`/admin/guide`) with FAQ for all features
- Ntfy error notifications for production monitoring (optional)

### Encryption
- **Hybrid RSA-OAEP + AES-256-GCM** for attendee PII (name, email, phone, postal address)
  - Public key encrypts on submission (no auth needed)
  - Private key only available to authenticated admin sessions
  - A database dump alone is not sufficient to recover PII — an attacker would also need the encryption key from the environment
- **AES-256-GCM** for payment IDs, prices, check-in status, API keys, holiday names, usernames
- **PBKDF2** (600k iterations, SHA-256) for password hashing
- Three-layer key hierarchy: env var root key → RSA key pair → per-user wrapped data keys
- Lost password = permanently unreadable data. No backdoor.

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

These measures aim to raise the cost of common attacks. They do not guarantee security against all scenarios — proper operational practices (key management, access control, monitoring) are equally important.

### Email Notifications
- Automatic confirmation email to attendees and notification email to admins on each registration
- Five HTTP API providers: Resend, Postmark, SendGrid, Mailgun (US/EU)
- Customisable email templates using Liquid syntax (subject, HTML body, text body)
- Built-in template filters: `currency` (formats amounts) and `pluralize`
- Configured in admin settings — optional, system works without it

### Public JSON API
- RESTful API for event listing and booking (`/api/events`, `/api/events/:slug`, `/api/events/:slug/availability`, `/api/events/:slug/book`)
- No API key required — same data as public booking pages
- CORS-enabled for cross-origin requests

### Webhooks
- Outbound POST on every registration (free or paid) to per-event and/or global webhook URLs
- Payload: name, email, phone, address, amount, currency, payment ID, ticket URL, per-ticket details
- Multi-event bookings send one consolidated webhook

<details>
<summary>Example webhook payload</summary>

<!-- This example is tested — see test/lib/webhook-example.test.ts -->

```json
{
  "event_type": "registration.completed",
  "name": "Alice Smith",
  "email": "alice@example.com",
  "phone": "+44 7700 900000",
  "address": "42 Oak Lane, Bristol, BS1 1AA",
  "special_instructions": "Wheelchair access needed",
  "price_paid": 3000,
  "currency": "GBP",
  "payment_id": "pi_3abc123def456",
  "ticket_url": "https://tickets.example.com/t/A1B2C3D4E5",
  "tickets": [
    {
      "event_name": "Summer Workshop",
      "event_slug": "summer-workshop",
      "unit_price": 1500,
      "quantity": 2,
      "date": "2025-08-20",
      "ticket_token": "A1B2C3D4E5"
    }
  ],
  "timestamp": "2025-08-20T14:30:00.000Z",
  "business_email": "hello@example.com"
}
```

Prices are in the smallest currency unit (e.g. pence, cents). For multi-event bookings the `tickets` array contains one entry per event and the `ticket_url` combines tokens with `+`.

</details>

## Quick Start

```bash
# Install Deno, cache dependencies, run all checks
./setup.sh

# Run locally
DB_URL=libsql://your-db.turso.io DB_TOKEN=your-token \
  DB_ENCRYPTION_KEY=your-base64-key ALLOWED_DOMAIN=localhost \
  deno task start

# Run tests (stripe-mock downloaded automatically)
deno task test
```

On first launch, visit `/setup/` to set admin credentials and currency. Payment providers are configured at `/admin/settings`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_URL` | Yes | libsql database URL |
| `DB_TOKEN` | Yes* | Database auth token (*remote databases) |
| `DB_ENCRYPTION_KEY` | Yes | 32-byte base64-encoded AES-256 key |
| `ALLOWED_DOMAIN` | Yes | Domain for security validation |

There are additional optional variables covering emails, Apple Wallet, image uploads, and more — see the [CONFIG_KEYS reference](https://chobbledotcom.github.io/tickets/doc.ts/~/CONFIG_KEYS.html) for the full list.

## Deployment

### Docker

```bash
docker build -t chobble-tickets .
docker run -p 3000:3000 \
  -v tickets-data:/data \
  -e DB_URL="file:/data/tickets.db" \
  -e DB_ENCRYPTION_KEY="your-base64-key" \
  -e ALLOWED_DOMAIN="your-domain.com" \
  chobble-tickets
```

The Dockerfile uses a local SQLite file by default. Set `DB_URL` and `DB_TOKEN` to point at a remote Turso database instead if preferred.

### Bunny Edge Scripting

Builds to a single JavaScript file for Bunny Edge Scripting:

```bash
deno task build:edge
```

Configure `DB_URL`, `DB_TOKEN`, `DB_ENCRYPTION_KEY`, and `ALLOWED_DOMAIN` as Bunny native secrets. For image uploads, also configure `STORAGE_ZONE_NAME` and `STORAGE_ZONE_KEY`. GitHub Actions secrets: `BUNNY_SCRIPT_ID`, `BUNNY_ACCESS_KEY`.

Database schema auto-migrates on first request.

## Development

```bash
deno task start          # Run server
deno task test           # Run tests
deno task test:coverage  # Tests with coverage report
deno task lint           # Lint
deno task fmt            # Format
deno task typecheck      # Type check
deno task precommit      # All checks (typecheck, lint, cpd, build:edge, test:coverage)
```

## Tech Stack

- **Runtime**: Deno — runs standalone, via Docker, or on Bunny Edge Scripting
- **Database**: libsql (local SQLite or remote Turso)
- **Payments**: Stripe, Square
- **Build**: esbuild, single-file output
- **Templates**: Server-rendered JSX
- **Crypto**: Web Crypto API (AES-256-GCM, RSA-OAEP, PBKDF2)

## License

AGPLv3 — developed by [Chobble CIC](https://chobble.com), a community interest company.
