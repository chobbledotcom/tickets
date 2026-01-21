# tickets

A minimal ticket reservation system using Bun and libsql.

## Preferences

- **Use Bun**: This project uses Bun exclusively for running, testing, and package management
- **100% test coverage**: All code must have complete test coverage

## Scripts

- `bun start` - Run the server
- `bun test` - Run tests
- `bun run lint` - Check code with Biome
- `bun run lint:fix` - Fix lint issues
- `bun run cpd` - Check for duplicate code
- `bun run precommit` - Run all checks (lint, cpd, tests)

## Environment Variables

- `DB_URL` - Database URL (defaults to `file:tickets.db` for local SQLite)
- `DB_TOKEN` - Database auth token (optional, for remote databases)
- `PORT` - Server port (defaults to 3000)

## Lint Rules

The Biome config enforces:
- `noForEach` - Use `for...of` or curried `filter`/`map`
- `noVar` - Use `const` (or `let` if needed)
- `noDoubleEquals` - Use `===`
- `maxComplexity: 7` - Break into smaller functions
