# tickets

A minimal ticket reservation system using Bun and libsql.

## Preferences

- **Use FP methods**: Prefer curried functional utilities from `#fp` over imperative loops
- **Use Bun**: This project uses Bun exclusively for running, testing, and package management
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

- `bun start` - Run the server
- `bun test` - Run tests
- `bun run lint` - Check code with Biome
- `bun run lint:fix` - Fix lint issues
- `bun run cpd` - Check for duplicate code
- `bun run precommit` - Run all checks (lint, cpd, tests)

## Environment Variables

- `DB_URL` - Database URL (required, e.g. `libsql://your-db.turso.io`)
- `DB_TOKEN` - Database auth token (required for remote databases)
- `ADMIN_PASSWORD` - Additional admin password (optional, works alongside the randomly generated database password)
- `STRIPE_SECRET_KEY` - Stripe secret key (optional, enables payments when set)
- `CURRENCY_CODE` - Currency code for payments (defaults to GBP)
- `PORT` - Server port (defaults to 3000)

## Lint Rules

The Biome config enforces:
- `noForEach` - Use `for...of` or curried `filter`/`map`
- `noAccumulatingSpread` - Use reduce with mutation
- `noVar` - Use `const` (or `let` if needed)
- `noDoubleEquals` - Use `===`
- `maxComplexity: 7` - Break into smaller functions

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
