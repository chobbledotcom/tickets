# Chobble Tickets

A self-hosted ticket reservation system. Runs on Bunny Edge Scripting with libsql (Turso). Encrypts all PII at rest. Handles free and paid events with Stripe or Square.

Licensed under **AGPLv3**. Hosted instances available at [chobble.com](https://chobble.com) for £50/year, no tiers.

## Features

### Events
- Standard events (fixed capacity) and daily events (per-date capacity with calendar picker)
- Optional event date and location fields, displayed on the ticket page
- Configurable contact fields: email, phone, postal address (any combination)
- Terms and conditions — set globally in settings, attendees must agree before booking
- Capacity limits, max tickets per purchase, registration deadlines
- Multi-event booking — combine events in one URL (`/ticket/event1+event2`), one form, one checkout
- Multi-booking link builder on the dashboard for generating combined-event URLs
- Embeddable via iframe with configurable CSP frame-ancestors
- Custom thank-you URL or default confirmation page
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
- Cross-event detection: scanner warns if a ticket belongs to a different event
- Multi-ticket view for multi-event bookings (`/t/token1+token2`)

### Admin
- Event CRUD, duplicate, deactivate/reactivate, delete (requires typing event name)
- Attendee list with date filtering (daily events), check-in status filtering
- CSV export (respects filters)
- Per-event activity log (creation, updates, check-ins, exports, deletions)
- Holiday/blackout date management for daily events
- Multi-user: owners invite managers via time-limited links (7-day expiry)
- Session management: view active sessions, kill all others
- Settings: payment provider config, embed host restrictions, terms and conditions, password change, database reset
- Built-in admin guide (`/admin/guide`) with FAQ for all features
- Ntfy error notifications for production monitoring (optional)

### Encryption
- **Hybrid RSA-OAEP + AES-256-GCM** for attendee PII (name, email, phone, postal address)
  - Public key encrypts on submission (no auth needed)
  - Private key only available to authenticated admin sessions
  - Database breach alone does not expose PII
- **AES-256-GCM** for payment IDs, prices, check-in status, API keys, holiday names, usernames
- **PBKDF2** (600k iterations, SHA-256) for password hashing
- Three-layer key hierarchy: env var root key → RSA key pair → per-user wrapped data keys
- Lost password = permanently unreadable data. No backdoor.

### Concurrency
- Atomic capacity check + insert in a single SQL statement — no overbooking under any load
- Payment webhook idempotency via two-phase locking on `processed_payments` table
- Stale reservation auto-cleanup after 5 minutes

### Security
- CSRF: double-submit cookie with 256-bit random tokens, path-scoped
- Rate limiting: 5 failed logins → 15-minute IP lockout (IPs HMAC-hashed before storage)
- Constant-time password comparison with random delay
- Session tokens hashed before database storage, 24-hour expiry, HttpOnly cookies
- Content-Type validation on all POST endpoints

### Webhooks
- Outbound POST on every registration (free or paid) to per-event and/or global webhook URLs
- Payload: name, email, phone, address, amount, currency, payment ID, ticket URL, per-ticket details
- Multi-event bookings send one consolidated webhook

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
| `PORT` | No | Local dev server port (default: 3000) |
| `STORAGE_ZONE_NAME` | No | Bunny CDN storage zone name (required for image uploads) |
| `STORAGE_ZONE_KEY` | No | Bunny CDN storage zone access key (required for image uploads) |
| `WEBHOOK_URL` | No | Global webhook URL for all registrations |
| `NTFY_URL` | No | Ntfy endpoint for error notifications (sends domain + error code only) |

## Deployment

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
deno task precommit      # All checks (typecheck, lint, cpd, test:coverage)
```

## Tech Stack

- **Runtime**: Deno (dev) / Bunny Edge Scripting (prod, Deno-based)
- **Database**: libsql on Turso
- **Payments**: Stripe, Square
- **Build**: esbuild, single-file output
- **Templates**: Server-rendered JSX
- **Crypto**: Web Crypto API (AES-256-GCM, RSA-OAEP, PBKDF2)

## License

AGPLv3
