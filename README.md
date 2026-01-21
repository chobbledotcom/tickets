# Tickets

A minimal ticket reservation system built with Bun and libsql, deployable to Bunny Edge.

## Features

- Event management with attendee limits
- Ticket reservation with email collection
- Optional Stripe payment integration
- Admin dashboard with password protection
- Edge-ready deployment to Bunny CDN

## Quick Start

```bash
# Install dependencies
bun install

# Run locally (requires DB_URL)
DB_URL=libsql://your-db.turso.io DB_TOKEN=your-token bun start

# Run tests (requires stripe-mock for full coverage)
stripe-mock &
bun test
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_URL` | Yes | LibSQL database URL (e.g., `libsql://your-db.turso.io`) |
| `DB_TOKEN` | Yes* | Database auth token (*required for remote databases) |
| `ADMIN_PASSWORD` | No | Admin login password. If not set, a random password is generated and stored in the database |
| `STRIPE_SECRET_KEY` | No | Stripe secret key. When set, enables paid tickets |
| `CURRENCY_CODE` | No | Currency for payments (default: `GBP`) |
| `PORT` | No | Server port for local development (default: `3000`) |

## Deployment

### GitHub Secrets

Add these secrets to your GitHub repository for Bunny Edge deployment:

| Secret | Description |
|--------|-------------|
| `DB_URL` | LibSQL database URL |
| `DB_TOKEN` | Database auth token |
| `ADMIN_PASSWORD` | Admin password (recommended for production) |
| `STRIPE_SECRET_KEY` | Stripe secret key (optional) |
| `CURRENCY_CODE` | Currency code (optional, defaults to GBP) |
| `BUNNY_SCRIPT_ID` | Bunny Edge script ID |
| `BUNNY_ACCESS_KEY` | Bunny API access key |

### Build Process

Environment variables are inlined at build time since Bunny Edge doesn't support runtime environment variables. The build script (`scripts/build-edge.ts`) handles this automatically.

```bash
# Build for edge deployment
bun run build:edge
```

## Development

```bash
# Run linter
bun run lint

# Fix lint issues
bun run lint:fix

# Type check
bun run typecheck

# Run all pre-commit checks
bun run precommit
```

## Testing

Tests require [stripe-mock](https://github.com/stripe/stripe-mock) for full coverage:

```bash
# Install stripe-mock (macOS)
brew install stripe/stripe-mock/stripe-mock

# Start stripe-mock
stripe-mock &

# Run tests
bun test
```

## License

MIT
