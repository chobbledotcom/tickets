# Tickets

A minimal ticket reservation system built with Deno and libsql, deployable to Bunny Edge.

## Features

- Event management with attendee limits
- Ticket reservation with email collection
- Optional Stripe payment integration
- Admin dashboard with password protection
- Edge-ready deployment to Bunny CDN
- Web-based initial setup (no environment variables for config)

## Quick Start

```bash
# Install dependencies
deno install --allow-scripts

# Run locally (requires DB_URL)
DB_URL=libsql://your-db.turso.io DB_TOKEN=your-token deno task start

# Run tests (stripe-mock is started automatically)
deno task test
```

## Initial Setup

On first launch, the application will redirect to `/setup/` where you can configure:

- **Admin Password** - Required for accessing the admin dashboard
- **Stripe Secret Key** - Optional, enables paid tickets when set
- **Currency Code** - Currency for payments (default: GBP)

These settings are stored securely in the database, not in environment variables.

## Environment Variables

Only database connection settings use environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_URL` | Yes | LibSQL database URL (e.g., `libsql://your-db.turso.io`) |
| `DB_TOKEN` | Yes* | Database auth token (*required for remote databases) |
| `PORT` | No | Server port for local development (default: `3000`) |

All other configuration (admin password, Stripe keys, currency) is set through the web-based setup page and stored in the database.

## Deployment

### GitHub Secrets

Add these secrets to your GitHub repository for deployment:

| Secret | Description |
|--------|-------------|
| `BUNNY_SCRIPT_ID` | Bunny Edge script ID |
| `BUNNY_ACCESS_KEY` | Bunny API access key |

### Bunny Native Secrets

Configure these environment variables in the Bunny Edge Scripting dashboard:

| Variable | Description |
|----------|-------------|
| `DB_URL` | LibSQL database URL |
| `DB_TOKEN` | Database auth token |
| `DB_ENCRYPTION_KEY` | 32-byte base64-encoded encryption key |
| `ALLOWED_DOMAIN` | Domain for security validation |

### Build Process

```bash
# Build for edge deployment
deno task build:edge
```

### First Deployment

After deploying to Bunny Edge, visit your site URL. You'll be automatically redirected to the setup page to configure your admin password and payment settings.

## Development

```bash
# Run linter
deno task lint

# Format code
deno task fmt

# Type check
deno task typecheck

# Run all pre-commit checks
deno task precommit
```

## Testing

The test runner automatically downloads and starts stripe-mock:

```bash
# Run tests
deno task test

# Run tests with coverage
deno task test:coverage
```

## License

MIT
