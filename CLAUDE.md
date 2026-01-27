# tickets

A minimal ticket reservation system using Bunny Edge Scripting and libsql.

## Getting Started

Run `./setup.sh` to install Deno, cache dependencies, and run all precommit checks (typecheck, lint, tests).

## Runtime Environment

- **Production**: Bunny Edge Scripting (Deno-based runtime on Bunny CDN)
- **Development/Testing**: Deno (for `deno task test`, `deno task start`, package management)
- **Build**: `esbuild` with `platform: "browser"` bundles to a single edge-compatible file

Code must work in both environments. The edge runtime is Deno-based, so development with Deno ensures parity.

## Preferences

- **Use FP methods**: Prefer curried functional utilities from `#fp` over imperative loops
- **100% test coverage**: All code must have complete test coverage

## FP Imports

```typescript
import { pipe, filter, map, reduce, compact, unique } from "#fp";
```

### Common Patterns

```typescript
// Compose operations
const processItems = pipe(
  filter(item => item.active),
  map(item => item.name),
  unique
);

// Instead of forEach, use for...of or curried filter/map
for (const item of items) {
  // ...
}

// Instead of array spread in reduce, use reduce with mutation
const result = reduce((acc, item) => {
  acc.push(item.value);
  return acc;
}, [])(items);
```

### Available FP Functions

| Function | Purpose |
|----------|---------|
| `pipe(...fns)` | Compose functions left-to-right |
| `filter(pred)` | Curried array filter |
| `map(fn)` | Curried array map |
| `flatMap(fn)` | Curried array flatMap |
| `reduce(fn, init)` | Curried array reduce |
| `sort(cmp)` | Non-mutating sort |
| `sortBy(key)` | Sort by property/getter |
| `unique(arr)` | Remove duplicates |
| `uniqueBy(fn)` | Dedupe by key |
| `compact(arr)` | Remove falsy values |
| `pick(keys)` | Extract object keys |
| `memoize(fn)` | Cache function results |
| `groupBy(fn)` | Group array items |

## Scripts

- `deno task start` - Run the server
- `deno task test` - Run tests
- `deno task test:coverage` - Run tests with coverage
- `deno task lint` - Check code with Deno lint
- `deno task fmt` - Format code with Deno fmt
- `deno task build:edge` - Build for Bunny Edge deployment
- `deno task precommit` - Run all checks (typecheck, lint, tests)

## Environment Variables

Environment variables are configured as **Bunny native secrets** in the Bunny Edge Scripting dashboard. They are read at runtime via `process.env`.

### Required (configure in Bunny dashboard)

- `DB_URL` - Database URL (required, e.g. `libsql://your-db.turso.io`)
- `DB_TOKEN` - Database auth token (required for remote databases)
- `DB_ENCRYPTION_KEY` - 32-byte base64-encoded encryption key (required)
- `ALLOWED_DOMAIN` - Domain for security validation (required)

### Optional

- `PORT` - Server port (defaults to 3000, local dev only)

### Stripe Configuration

Stripe is configured via the admin settings page (`/admin/settings`), not environment variables:
- Enter your Stripe secret key in the admin settings
- The webhook endpoint is automatically created in your Stripe account
- The webhook signing secret is stored encrypted in the database

Admin password and currency code are set through the web-based setup page at `/setup/` and stored encrypted in the database.

## Deno Configuration

The project uses `deno.json` for configuration:
- Import maps for `#` prefixed aliases
- npm packages via `npm:` specifier
- JSR packages via `jsr:` specifier

## Test Framework

Tests use a custom compatibility layer (`#test-compat`) that provides Jest-like APIs:
- `describe`, `test`, `it` for test organization
- `expect()` for assertions
- `beforeEach`, `afterEach` for setup/teardown
- `jest.fn()`, `spyOn()` for mocking

## Test Quality Standards

All tests must meet these mandatory criteria:

### 1. Tests Production Code, Not Reimplementations
- Import and call actual production functions
- Never copy-paste or reimplement production logic in tests
- Import constants from production code, don't hardcode

### 2. Not Tautological
- Never assert a value you just set (e.g., `expect(true).toBe(true)`)
- Always have production code execution between setup and assertion
- Verify behavior, not that JavaScript assignment works

### 3. Tests Behavior, Not Implementation Details
- Verify observable outcomes (HTTP status, content, state changes)
- Refactoring shouldn't break tests unless behavior changes
- Answer "does it work?" not "is it structured this way?"

### 4. Has Clear Failure Semantics
- Test names describe the specific behavior being verified
- When a test fails, it should be obvious what's broken
- Use descriptive assertion messages

### 5. Isolated and Repeatable
- Tests clean up after themselves (use `beforeEach`/`afterEach`)
- Tests don't depend on other tests running first
- No time-dependent flakiness

### 6. Tests One Thing
- Each test has a single reason to fail
- If you need "and" in the description, split the test

### Coverage Requirements

100% test coverage is required to merge into main. To find which specific lines are uncovered, run:

```bash
deno task test:coverage
```

Then check `coverage/` for detailed coverage information.

### Test Utilities

Use helpers from `#test-utils` instead of defining locally:

```typescript
import { mockRequest, mockFormRequest, createTestDb, resetDb } from "#test-utils";
```

### Anti-Patterns to Avoid

| Anti-Pattern | What To Do Instead |
|--------------|-------------------|
| `expect(true).toBe(true)` | Assert on actual behavior/state |
| Reimplementing production logic | Import and call production code |
| Duplicating test helpers | Use `#test-utils` |
| Magic numbers/strings | Import constants from production |
| Testing private internals | Test public API behavior |

