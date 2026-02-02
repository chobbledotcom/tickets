# Tickets

A minimal ticket reservation system built with Deno and libsql, deployable to Bunny Edge Scripting.

## Features

- **Event management** — capacity limits, registration deadlines, configurable fields (email, phone, or both)
- **Free and paid tickets** — Stripe and Square support with a pluggable provider architecture
- **Multi-event booking** — register for multiple events in a single checkout
- **Encryption at rest** — all PII encrypted with AES-256-GCM and hybrid RSA-OAEP
- **Admin dashboard** — attendee management, CSV export, check-in tracking, activity log, session management
- **Edge deployment** — builds to a single file for Bunny CDN edge scripting
- **Web-based setup** — admin password, currency, and payment providers configured via browser

## Quick Start

```bash
# Install Deno, cache dependencies, and run all checks
./setup.sh

# Run locally
DB_URL=libsql://your-db.turso.io DB_TOKEN=your-token \
  DB_ENCRYPTION_KEY=your-base64-key ALLOWED_DOMAIN=localhost \
  deno task start

# Run tests (stripe-mock is downloaded and started automatically)
deno task test
```

## Initial Setup

On first launch, the app redirects to `/setup/` to configure:

- **Admin password** — required for the admin dashboard
- **Currency code** — currency for payments (default: GBP)

Payment providers (Stripe/Square) are configured later in the admin settings page at `/admin/settings`.

All configuration is stored encrypted in the database.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_URL` | Yes | libsql database URL |
| `DB_TOKEN` | Yes* | Database auth token (*required for remote databases) |
| `DB_ENCRYPTION_KEY` | Yes | 32-byte base64-encoded encryption key |
| `ALLOWED_DOMAIN` | Yes | Domain for security validation |
| `PORT` | No | Server port for local development (default: `3000`) |

## Deployment

### GitHub Secrets

| Secret | Description |
|--------|-------------|
| `BUNNY_SCRIPT_ID` | Bunny Edge script ID |
| `BUNNY_ACCESS_KEY` | Bunny API access key |

### Bunny Native Secrets

Configure `DB_URL`, `DB_TOKEN`, `DB_ENCRYPTION_KEY`, and `ALLOWED_DOMAIN` in the Bunny Edge Scripting dashboard.

### Build & Deploy

```bash
deno task build:edge
```

After deploying, visit your site URL to complete setup via the browser.

## Development

```bash
deno task start          # Run server locally
deno task test           # Run tests
deno task test:coverage  # Run tests with coverage report
deno task lint           # Lint
deno task fmt            # Format
deno task typecheck      # Type check
deno task precommit      # All checks (typecheck, lint, cpd, test:coverage)
```

## License

MIT
