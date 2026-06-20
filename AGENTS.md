# tickets

A minimal ticket reservation system using Bunny Edge Scripting and libsql.

## Getting Started

Run `./setup.sh` to install Deno, cache dependencies, and run all precommit checks (typecheck, lint, tests).

## Runtime Environment

- **Production**: Bunny Edge Scripting (Deno-based runtime on Bunny CDN)
- **Development/Testing**: Deno (for `deno task test`, `deno task start`, `deno coverage`, package management)
- **Build**: `esbuild` with `platform: "browser"` bundles to a single edge-compatible file

Code must work in both environments. The edge runtime is Deno-based, so development with Deno ensures parity.

## Deno Version

This repo pins Deno 2.5.6, the lowest Bunny Edge Scripting runtime version this
project is expected to run on. Local development should use that version too.

This repo pins Deno with mise:

```bash
mise install
mise exec -- deno --version
```

The `.tool-versions` file is kept in sync for asdf-compatible tooling.

## Preferences

- **Use FP methods**: Prefer curried functional utilities from `#fp` over imperative loops
- **Zero code duplication**: jscpd runs at a non-negotiable 0% threshold. Fix duplication with a helper or currying — see [Code Duplication](#code-duplication). `jscpd:ignore` is reserved for import blocks, essentially nothing else.
- **100% test coverage**: All code must have complete test coverage - run `deno coverage` to find uncovered lines/branches
- **Trust application invariants**: Do not design normal code paths around database states the application says are impossible. If an impossible state is observed, raise it as an error and repair the data explicitly rather than silently accepting or normalising it.
- **Select only needed columns**: Avoid `SELECT *` and broad "load every row" helpers — query the specific columns a caller actually uses. See [Database Queries](#database-queries).
- **SQL table aliases**: Alias tables with the full singular word using `AS`, not a single letter — write `FROM listings AS listing`, never `FROM listings e` (the `e` is a leftover from when listings were called "events"). When one query references the same table more than once (e.g. correlated subqueries that compare a row against its group), give each occurrence a descriptive word alias — `listing` for the row being checked, `groupListing` for sibling rows in its group.
- **Final check**: Run `deno task precommit` (via `mise exec -- deno task precommit` when using the pinned toolchain) before finishing any job with code or documentation changes.

## FP Imports

```typescript
import { pipe, filter, map, reduce, compact, unique } from "#fp";
```

### Common Patterns

```typescript
// Compose operations
const processItems = pipe(
  filter((item) => item.active),
  map((item) => item.name),
  unique,
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

These are the curried helpers actually exported from `#fp`. Several are thin
adapters over `@std/collections` (noted below) so the standard library does the
work while the project keeps its pipe-friendly calling convention. For
collection operations not covered here (partitioning, keying, picking
object keys, etc.), reach for `@std/collections` directly rather than
hand-rolling — wrap it in a curried `#fp` adapter if it will be reused across
the `pipe`-based code. Note `@std/collections` has **no** `groupBy` export
(it was removed in favour of the runtime built-ins) — use native
`Object.groupBy` / `Map.groupBy` for grouping.

| Function           | Purpose                         |
| ------------------ | ------------------------------- |
| `pipe(...fns)`     | Compose functions left-to-right |
| `filter(pred)`     | Curried array filter            |
| `map(fn)`          | Curried array map               |
| `flatMap(fn)`      | Curried array flatMap           |
| `mapNotNullish(fn)`| Map, dropping nullish results (std mapNotNullish) |
| `reduce(fn, init)` | Curried array reduce            |
| `sort(cmp)`        | Non-mutating sort               |
| `unique(arr)`      | Remove duplicates (std distinct)   |
| `uniqueBy(fn)`     | Dedupe by key (std distinctBy)     |
| `compact(arr)`     | Remove null/undefined           |
| `chunk(size)`      | Split array into chunks (std chunk) |
| `sumOf(selector)`  | Sum by selector (std sumOf)        |
| `sum(arr)`         | Sum an array of numbers         |

## Code Duplication

`deno task cpd` (run as part of `deno task precommit`) runs jscpd with a **0%
threshold — this is non-negotiable**. When it fails it prints this same
guidance. Fix the duplication; do not silence it:

1. **Write a helper.** This is the answer in ~99.999% of cases. If an obvious
   shared function jumps out, extract it and call it from both sites.
2. **No obvious helper? Curry.** Lift the parts that differ into arguments of a
   function that returns the specialised version, then call it at each site.
   **Then review your work before committing — zoom out one step further.** The
   first small curry you reach for is often not the best one; a larger, more
   holistic curry across the call sites is very frequently far better.
3. **`jscpd:ignore` is the last resort.** It is excusable for basically *one*
   thing: **import blocks** (plus the rare unavoidable scrap of
   boilerplate/infrastructure we have no control over). If the duplicated code
   is not an import block, you almost certainly want option 1 or 2 — an
   `jscpd:ignore` tag anywhere else is a code smell, not a fix.

## Database Queries

Avoid `SELECT *`, and avoid loading more rows or columns than the caller needs.

- **Prefer explicit, narrow column lists.** Write `SELECT id, name, admin_level FROM …`, never `SELECT *` — list only the columns the caller reads. This keeps less plaintext/PII in memory, skips decrypting columns nobody uses, and makes each query's data dependencies obvious. Copy the existing examples: `getUserDisplayFields` (`id, username_hash, admin_level`), `getAllUserIds` (`id`), `getAllAttendeePiiBlobs` (`pii_blob`), `getAllRawEmailTemplates` (`id, subject, body`).
- **"Get all rows" is rarely the right shape.** About the only legitimate reason to read a whole table is rendering an admin collection page (e.g. `/admin/listings`, `/admin/questions`) — and even then, select only the columns those rows display, not every column on the table. Everything else should be a bounded query (by id, by key, or with a `WHERE`/`LIMIT`).

Some reads legitimately need the full row — these are the exceptions, not the rule:

- **An entity cache that also backs single-record reads.** When one request-scoped cache serves both the collection view and the `getById`/`getByKey` detail/auth reads (listings, users, groups, holidays, built-sites, attendee-statuses), it loads the full entity once so the detail, edit, and login paths it feeds have every column. Narrowing the cache load would break those reads. (`getAllListings`' `SELECT listing.*` is deliberately wide — it also carries the trigger-maintained `booked_quantity`/`income`/`tickets_count` aggregate columns.)
- **Full-table backup/restore** (`backup.ts`) — a dump needs every column to round-trip.
- **The generic `Table.findById`/`findAll` helpers** (`table.ts`) — they `SELECT *` by design and feed edit pages that need the whole row; specific tables narrow at the cache `fetchAll` layer instead.

Even when a caller genuinely needs many columns, list them explicitly rather than `SELECT *`, so adding a column later doesn't silently widen every read.

## Scripts

- `deno task start` - Run the server
- `deno task test` - Run the full suite
- `deno task test:coverage` - Run the full suite with coverage
- `deno task test:files <file>...` - Run only the given test files with the same setup as the full runner (builds static assets, starts stripe-mock, cleans up after)
- `deno task lint` - Format and lint all code with Biome (`check --write`; auto-fixes in place). Biome is the sole formatter and linter.
- `deno task lint:ci` - Strict, read-only lint (`check --error-on-warnings`, no `--write`). Fails on lint warnings (e.g. cognitive complexity) and on any code that *would* be reformatted, without touching the checkout. This is the lint `deno task precommit` runs in **every** environment, so a clean `precommit` locally means the lint step will pass in CI too. Run `deno task lint` to auto-fix before re-running.
- `deno task build:edge` - Build for Bunny Edge deployment
- `deno task backup` - Dump the database out-of-band to a `.zip`. Uploads to the configured storage zone by default (so it appears on the Backups page and lets the next migration skip its own inline backup); pass `--out <path>` to write a local file. Runs in a full Deno process, so unlike the in-edge backup it has no per-request subrequest budget and can dump arbitrarily large databases.
- `deno task precommit` - Run all checks (typecheck, lint, tests)

### Running Individual Test Files

**Do NOT use `deno task test -- --filter`** to debug a specific test — it still loads the entire test suite and is very slow.

Instead, use `deno task test:files`, which runs only the files you pass but reuses the full runner's setup — it builds the static client assets the app reads at import time, starts stripe-mock with `STRIPE_MOCK_HOST/PORT` exported, and removes any assets it generated afterwards. This means a fresh checkout can run a subset of the suite without manual preparation or leftover build artifacts:

```bash
deno task test:files test/lib/dates.test.ts
```

Arguments are forwarded verbatim to `deno test`, so multiple files, directories, and flags such as `--filter` all work:

```bash
deno task test:files test/lib/dates.test.ts --filter "formats date"
deno task test:files test/lib/server-balance.test.ts test/lib/server-webhooks.test.ts
```

#### Lower-level alternative

For a pure unit test that imports neither the app nor Stripe, you can skip the harness and run `deno test` directly on the file (fastest, but it fails on a missing `src/ui/static/*.js` asset or an unstarted stripe-mock if the test does import them):

```bash
deno test --no-check --allow-all test/lib/dates.test.ts
```

To do this for a test that depends on stripe-mock (anything importing Stripe), start the mock first (`deno task test:files` or `deno task test` does this for you, or run `.bin/stripe-mock -http-port 12111` manually) and set the env vars:

```bash
STRIPE_MOCK_HOST=localhost STRIPE_MOCK_PORT=12111 deno test --no-check --allow-all test/lib/stripe-mock.test.ts
```

## Environment Variables

Environment variables are configured as **Bunny native secrets** in the Bunny Edge Scripting dashboard. They are read at runtime via `process.env`.

### Required (configure in Bunny dashboard)

- `DB_URL` - Database URL (required, e.g. `libsql://your-db.turso.io`)
- `DB_TOKEN` - Database auth token (required for remote databases)
- `DB_ENCRYPTION_KEY` - 32-byte base64-encoded encryption key (required)

### Optional

- `PORT` - Server port (defaults to 3000, local dev only)
- `BUNNY_API_KEY` - Bunny API key (required for custom domain management, with `BUNNY_SCRIPT_ID`)
- `BUNNY_SCRIPT_ID` - Bunny Edge Script ID (required for custom domain management, with `BUNNY_API_KEY`)
- `STORAGE_ZONE_NAME` - Bunny CDN storage zone name (required for image uploads)
- `STORAGE_ZONE_KEY` - Bunny CDN storage zone access key (required for image uploads)
- `BACKUP_PAGE_SIZE` - Rows read per keyset page when dumping a table for backup (default 500). Each page is one libsql response, so this bounds the response size to stay under libsqld's "Response is too large" payload cap. Used by `deno task backup` and the admin Backups page; migrations no longer back up inline (the edge subrequest budget can't fit a full dump), so backups are taken out-of-band.
- `MAIN_INSTANCE_KEY` - Shared secret authorizing the inter-instance site-credentials endpoint (`POST /instance/site-credentials`). When set on a builder/main instance, that endpoint returns every built site's read-only DB URL + token to a caller presenting this key as a bearer token, so the upgrade workflow can back each site up to the builder's storage before deploying. Unset ⇒ the endpoint is disabled (404). The upgrade workflow receives it as a run-time input, not a stored GitHub secret.
- `BUNNY_DNS_ZONE_ID` - Bunny DNS zone ID for subdomain registration (enables subdomain feature when set with `BUNNY_API_KEY`)
- `BUNNY_DNS_SUBDOMAIN_SUFFIX` - Suffix appended to user-chosen subdomain (e.g. `.tickets`)
- `NTFY_URL` - Ntfy endpoint URL for error notifications (e.g. `https://ntfy.sh/your-topic`). Sends domain and error code only, no personal or encrypted data.
- `BOTPOISON_PUBLIC_KEY` - Optional Botpoison public key (sent to the browser). The contact form works without it; setting it together with `BOTPOISON_SECRET_KEY` adds proof-of-work spam protection as a progressive enhancement. The owner still enables the form under Site → Contact and sets a business email.
- `BOTPOISON_SECRET_KEY` - Optional Botpoison secret key. Used server-side to verify contact form submissions when Botpoison is enabled. Never sent to the browser.
- `ADMIN_EMAIL_ADDRESS` - Enables a superuser recovery option in owner settings. The local-part (before `@`) must be a valid app username (2–32 characters, letters, numbers, hyphens, underscores). Email delivery must be configured before the superuser can be enabled. Also enables the owner-only **Support** page (`/admin/support`), where the operator can message this address.
- `SUPPORT_PAGE_TEXT` - Optional markdown shown at the top of the Support page (requires `ADMIN_EMAIL_ADDRESS`). Use literal `\n` for line breaks since Bunny secrets can't hold real newlines. When unset, a placeholder note is shown instead. The support form below it (which delivers to `ADMIN_EMAIL_ADDRESS`) needs a business email to be set, like the public contact form.
- `SUPPORT_FORM_NAG_DAYS` - Optional positive integer (default `7`). For this many days after a support-form submission, the Support page shows a "you last submitted this form …" notice to discourage duplicate messages.
- `APPLE_WALLET_PASS_TYPE_ID` - Apple Wallet Pass Type ID (e.g. `pass.com.example.tickets`)
- `APPLE_WALLET_TEAM_ID` - Apple Developer Team ID (e.g. `ABC1234567`)
- `APPLE_WALLET_SIGNING_CERT` - PEM-encoded signing certificate
- `APPLE_WALLET_SIGNING_KEY` - PEM-encoded signing private key
- `APPLE_WALLET_WWDR_CERT` - PEM-encoded Apple WWDR intermediate certificate

Apple Wallet can be configured via env vars (all 5 required) or via the admin settings page. Admin settings (encrypted) take priority over env vars. If neither is configured, the feature is disabled.

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

Tests use Deno standard library packages directly:

- `@std/testing/bdd` — `describe`, `it` (aliased as `test`), `beforeEach`, `afterEach`
- `@std/expect` — `expect()` assertions
- `@std/testing/mock` — `spy()`, `stub()` for mocking
- `@std/expect/fn` — `fn()` for mock functions
- `@std/testing/time` — `FakeTime` for timer tests

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
import {
  mockRequest,
  mockFormRequest,
  createTestDb,
  resetDb,
} from "#test-utils";
```

### Anti-Patterns to Avoid

| Anti-Pattern                    | What To Do Instead               |
| ------------------------------- | -------------------------------- |
| `expect(true).toBe(true)`       | Assert on actual behavior/state  |
| Reimplementing production logic | Import and call production code  |
| Duplicating test helpers        | Use `#test-utils`                |
| Magic numbers/strings           | Import constants from production |
| Testing private internals       | Test public API behavior         |
