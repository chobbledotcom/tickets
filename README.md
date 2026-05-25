# Chobble Tickets

Chobble Tickets is a reservation system that runs on Bunny Edge Scripting (or any Deno environment) with libsql, which encrypts all PII at rest and handles free and paid events with Stripe or Square.

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

### Events

- Standard events (fixed capacity) and daily events (per-date capacity with calendar picker)
- Event groups for organising related events together
- Optional event date and location fields, displayed on the ticket page
- Configurable contact fields: email, phone, postal address (any combination)
- Special instructions field for attendee notes
- Terms and conditions - set globally in settings, attendees must agree before booking
- Capacity limits, max tickets per purchase, registration deadlines
- Multi-event booking - combine events in one URL (`/ticket/event1+event2`), one form, one checkout
- Multi-booking link builder on the dashboard for generating combined-event URLs
- Event QR code SVG (`/ticket/:slug/qr`) for posters and printed materials
- Embeddable via iframe with configurable CSP frame-ancestors
- Custom thank-you URL or default confirmation page
- Non-transferable tickets - per-event toggle requiring ID verification at check-in
- Event image and file attachment uploads (encrypted, stored on Bunny CDN)
- Manual attendee creation from the admin event page (walk-ins, comps)

### Payments

- Stripe and Square, with a provider interface so adding others is straightforward
- Enter your API key in admin settings and the webhook endpoint configures itself
- Checkout sessions with metadata, webhook-driven attendee creation
- Configurable booking fee added to each transaction
- "Pay what you want" pricing with optional minimum and maximum
- Automatic refund if capacity exceeded after payment or event price changes during checkout
- Admin-issued full refunds for individual attendees or all attendees in bulk

### Check-in

- Each ticket gets a unique URL (`/t/:token`) with a QR code
- Staff scan QR to reach check-in page, toggle check-in/out
- Built-in QR scanner - open from an event page, uses device camera, check-in-only (no accidental check-outs)
- ID verification prompt for non-transferable events before completing check-in
- Cross-event detection: scanner warns if a ticket belongs to a different event
- Multi-ticket view for multi-event bookings (`/t/token1+token2`)

### Apple Wallet

- Generates `.pkpass` files for Apple Wallet with event details and barcode
- Web service API for automatic pass updates (follows the Apple Wallet spec)
- Configurable via admin settings or environment variables

### Admin

- Event CRUD, duplicate, deactivate/reactivate, delete (requires typing event name)
- Calendar view for daily events with per-date attendee counts
- Attendee list with date filtering (daily events), check-in status filtering
- Attendee editing - update name, contact details, quantity, or reassign to a different event
- CSV export (respects active filters)
- Per-event and global activity log (creation, updates, check-ins, exports, refunds, deletions)
- Holiday/blackout date management for daily events
- Multi-user: owners invite managers via time-limited links (7-day expiry)
- Session management: view active sessions, kill all others
- Settings: payment provider config, email templates, custom domain, embed host restrictions, terms and conditions, password change
- Branding: custom header image, website title, theme colours
- Built-in admin guide (`/admin/guide`) with FAQ for all features
- Ntfy error notifications for production monitoring (optional)

### Feeds

- ICS calendar feed (`/feeds/events.ics`) for calendar apps
- RSS feed (`/feeds/events.rss`) for feed readers

### Email Notifications

- Automatic confirmation email to attendees and notification email to admins on each registration
- Five HTTP API providers: Resend, Postmark, SendGrid, Mailgun (US/EU)
- Customisable email templates using Liquid syntax (subject, HTML body, text body)
- Built-in template filters: `currency` (formats amounts) and `pluralize`
- Configured in admin settings - optional, the system works without it

### Public JSON API

- RESTful API for event listing and booking (`/api/events`, `/api/events/:slug`, `/api/events/:slug/availability`, `/api/events/:slug/book`)
- No API key required - it serves the same data as the public booking pages
- CORS-enabled for cross-origin requests

### Webhooks

- Outbound POST on every registration (free or paid) to per-event and/or global webhook URLs
- Payload: name, email, phone, address, amount, currency, payment ID, ticket URL, per-ticket details
- Multi-event bookings send one consolidated webhook

<details>
<summary>Example webhook payload</summary>

<!-- This example is tested - see test/lib/webhook-example.test.ts -->

```json
{
  "address": "42 Oak Lane, Bristol, BS1 1AA",
  "business_email": "hello@example.com",
  "currency": "GBP",
  "email": "alice@example.com",
  "event_type": "registration.completed",
  "name": "Alice Smith",
  "payment_id": "pi_3abc123def456",
  "phone": "+44 7700 900000",
  "price_paid": 3000,
  "special_instructions": "Wheelchair access needed",
  "ticket_url": "https://tickets.example.com/t/A1B2C3D4E5",
  "tickets": [
    {
      "date": "2025-08-20",
      "event_name": "Summer Workshop",
      "event_slug": "summer-workshop",
      "quantity": 2,
      "ticket_token": "A1B2C3D4E5",
      "unit_price": 1500
    }
  ],
  "timestamp": "2025-08-20T14:30:00.000Z"
}
```

Prices are in the smallest currency unit (e.g. pence, cents). For multi-event bookings the `tickets` array contains one entry per event and the `ticket_url` combines tokens with `+` - one webhook, not several.

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
deno task lint           # Lint
deno task fmt            # Format
deno task typecheck      # Type check
deno task build:edge     # Build for Bunny Edge
deno task precommit      # All checks (typecheck, lint, cpd, build:edge, test:coverage)
```

### Environment variables

| Variable            | Required | Description                              |
| ------------------- | -------- | ---------------------------------------- |
| `DB_URL`            | Yes      | libsql database URL                      |
| `DB_TOKEN`          | Yes\*    | Database auth token (\*remote databases) |
| `DB_ENCRYPTION_KEY` | Yes      | 32-byte base64-encoded AES-256 key       |

Optional:

| Variable              | Description                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_EMAIL_ADDRESS` | Enables a superuser recovery account. The email local-part (before `@`) must be a valid username: 2–32 characters, letters, numbers, hyphens, and underscores only. Email delivery must be configured before the superuser can be enabled. |

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
