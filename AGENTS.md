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
- **100% test coverage**: All code must have complete test coverage - run `deno coverage` to find uncovered lines/branches. Coverage must also be *deterministic*: a line or branch reached only through a spawned subprocess or e2e test (e.g. the `cli/` scripts, exercised by `test/e2e/cli-api.test.ts` via `deno run`) is covered non-deterministically — the child process's coverage is collected through `DENO_COVERAGE_DIR` and is environment-sensitive, so it can pass CI on one run and fail on the next. Give any branch that must stay covered a direct in-process unit test, not just incidental subprocess coverage.
- **Hardest first, no need to ask**: When the only open question is *what order to build several things in*, the answer is always "do the more difficult one first" — just proceed, don't ask.
- **Always the complete version**: When choosing between a result that is less accurate/complete and the full, correct version, always do the complete version — even if it means changing more files than originally estimated. Our aim is always to create the most perfect software; don't ask permission to do it properly.
- **Good citizen — fix what you spot**: If you notice a bug, a coverage gap, or a flaky/fragile test while working — even in code you were not asked to touch and did not write — fix it in passing rather than stepping around it. A green build you helped produce is your responsibility too.
- **Every bug fix ships with a regression test**: Never fix a bug without also adding a test that fails before the fix and passes after it. The test must exercise the real bug — reproduce the exact condition that was broken so it would have caught the original defect — not merely touch the changed lines for coverage. Write the failing test first, confirm it fails for the right reason, then apply the fix and watch it go green. This locks the bug out for good and proves the fix actually addresses it.
- **Trust application invariants**: Do not design normal code paths around database states the application says are impossible. If an impossible state is observed, raise it as an error and repair the data explicitly rather than silently accepting or normalising it.
- **Don't defend against the impossible**: Do not add fallbacks, placeholders, or `try/catch`es for failures that can only happen when a foundational system is already broken — the encryption/data key won't decrypt, the database has vanished, a core invariant the app guarantees is violated. You will never reach such a branch without the whole app already being down: you cannot render a page whose data won't decrypt, because the *same* key protects the attendee's own PII, so the request dies long before your guard runs. Such a guard only hides a system-wide failure behind an untestable, never-exercised branch (and a coverage gap). Let it throw, loudly. Reserve resilience for failures that genuinely occur in normal operation — a flaky network call, a provider timeout, a refund that already settled, a write that lost a race. Be confident in our own systems.
- **Schema over organic structure**: Prefer a declarative schema plus functional composition (map/filter/`compact` over data) to hand-nested or imperative construction — *even for content that looks organic*, like help/FAQ pages, navigation, form layouts, or report sections. Model the thing as data (a typed list of sections/entries/fields), render it with one shared function, and let the types make invalid arrangements unrepresentable. The admin guide (`src/ui/templates/admin/guide/`) is the reference example: each topic exports a `GuideSection[]`, `renderGuideSections` turns it into markup, and because a section's `entries` can never be a section, a sub-section can't be mis-nested mid-list and drag unrelated questions under the wrong heading. When you catch yourself authoring repetitive nested JSX/markup by hand, lift it into a schema first.
- **Malleable software**: Prefer being up front with operators about the underlying data structure over hiding it. Where it's safe, expose stored records directly and give the operator a page to view and edit them — including aggregated/derived numbers — rather than treating the DB as a black box. The per-contact record editor at `/admin/history/:hmac` (raw booking/message counts plus the private note, keyed by the contact's HMAC) is the reference example. Repairing data should be a first-class operator action, not a manual DB surgery.
- **Never render a dead or forbidden link**: Don't emit a link the viewer can't follow — one whose target would 404, or whose page the current user's admin level can't open. A rendered link is a promise that it works, so gate it on the same condition the target enforces; when that condition fails, show plain text or an indicator in its place rather than a link that breaks on click. The no-quantity attendee's ticket cell is the reference: a quantity-0-only attendee has no live `/t` page (it 404s), so admin views render a "No quantity" indicator instead of the `/t` link. This holds for permission-gated links too: an action a role can't reach must not be linked for that role. Mind the blind spot — a link to a restricted page still works when the page is viewed (or tested) as a high-privilege user, so the dead link the lower-privilege roles see goes unnoticed. Gate the link on the same permission the target enforces, and when testing visibility, render the page as each role rather than only the most-privileged one.
- **Operator decides genuine conflicts — a required choice, never a silent default**: When an action hits a conflict the system cannot unambiguously resolve (e.g. an attendee merge where both records booked the same listing, or where each side carries a real payment), do NOT auto-pick a resolution and quietly proceed. Surface the conflict and make the operator choose explicitly via a **required** field — the request fails closed until they decide. Silently moving money, voiding a leg, or keeping one side by default hides a real decision behind a guess; an explicit operator choice keeps the irreversible call — especially anything that touches the money ledger — with the human who can see the context.
- **Select only needed columns**: Avoid `SELECT *` and broad "load every row" helpers — query the specific columns a caller actually uses. See [Database Queries](#database-queries).
- **SQL table aliases**: Alias tables with the full singular word using `AS`, not a single letter — write `FROM listings AS listing`, never `FROM listings e` (the `e` is a leftover from when listings were called "events"). When one query references the same table more than once (e.g. correlated subqueries that compare a row against its group), give each occurrence a descriptive word alias — `listing` for the row being checked, `groupListing` for sibling rows in its group.
- **Never lose work — commit WIP even if broken**: Uncommitted changes are lost if the working environment is reclaimed (it has happened). If you have non-trivial work in progress and are about to pause, hand off, delegate to a background agent, or end a turn with a dirty tree, **commit and push it** rather than leaving it uncommitted. A known-broken checkpoint is fine and expected — mark it unmistakably in the commit message (e.g. `WIP: <chunk> — NOT GREEN, <what fails>`) so it is never mistaken for finished work, and follow up with a green commit. Do not hold a commit back purely because the tree does not yet build or pass; losing the work is worse.
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

### Transactions and Batches

For anything more complex than a single statement, prefer libsql's batches or
interactive transactions over firing independent `execute` calls. Independent
calls neither share a transaction (a later failure can't undo an earlier write)
nor a round-trip (each one is a separate request to the primary). The helpers in
`src/shared/db/client.ts` already wrap libsql's transaction APIs — reach for
them rather than calling `getDb().batch`/`getDb().transaction` directly, so query
logging and table-scoped cache invalidation stay automatic.

- **Batch — multiple statements, no logic between them.** When you know all the
  statements up front and none depends on the result of an earlier one, use a
  batch. It runs them sequentially in one implicit transaction over a single
  round-trip: success commits everything, any failure rolls the whole thing
  back. Use `executeBatch` (writes, discards results),
  `executeBatchWithResults` (writes, returns each `ResultSet` — ideal for
  cascading deletes and multi-step writes), `queryBatch` (reads in one
  round-trip), or `queryBatchPrimary` (reads pinned to the primary when you must
  read your own just-committed writes). `deleteByFieldBatch` is a ready-made
  multi-table delete.

- **Interactive transaction — logic between steps.** When a later statement
  depends on the result of an earlier one — e.g. read a balance, validate it,
  then conditionally update; or create → check capacity → finalize, where a
  zero-row guard must abort and undo everything — use `withTransaction`. It hands
  your callback a `TxScope` whose `execute` runs inside one interactive write
  transaction, committing on success and rolling back (then rethrowing) on any
  error. The write lock is acquired with a short retry so concurrent writers
  serialize rather than failing; a database that stays locked surfaces as
  `DatabaseBusyError`. Note the trade-off: an interactive transaction locks the
  database for writing until it commits or rolls back (with a timeout), so keep
  the work inside it tight — do any expensive non-DB computation before opening
  it, and prefer a plain batch whenever no inter-step logic is actually needed.

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
- `deno task mutation <source-glob> <test-glob>` - Mutation-test your tests: mutate operators in the source and check your tests catch it (see [Mutation Testing](#mutation-testing))

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
- `MAIN_INSTANCE_KEY` - Shared secret authorizing the inter-instance site-credentials endpoint (`POST /instance/site-credentials`). When set on a builder/main instance, that endpoint returns built sites' read-only DB URL + token to a caller presenting this key as a bearer token, so the upgrade workflow can back each site up to the builder's storage before deploying. The caller passes the release tier it is publishing as `?tier=alpha|beta|release` (a tier-less call defaults to `release` ⇒ the whole fleet, which is what the single-site `backup-site` action relies on); each site carries an `updates` channel and only the sites at that tier or more eager are returned (a `release` deploy reaches every site, `beta` reaches beta + alpha sites, `alpha` only alpha sites — an unknown tier is a 400). The response echoes the applied `tier` so a caller can confirm the server actually filtered: a pre-tier build ignores the query string and omits it, letting the canary workflow fail closed instead of fanning a non-release deploy out to the whole fleet. Unset `MAIN_INSTANCE_KEY` ⇒ the endpoint is disabled (404). The upgrade workflow receives the key as a run-time input, not a stored GitHub secret.
- `BUNNY_DNS_ZONE_ID` - Bunny DNS zone ID for subdomain registration (enables subdomain feature when set with `BUNNY_API_KEY`)
- `BUNNY_DNS_SUBDOMAIN_SUFFIX` - Suffix appended to user-chosen subdomain (e.g. `.tickets`)
- `NTFY_URL` - Ntfy endpoint URL for error notifications (e.g. `https://ntfy.sh/your-topic`). Sends domain and error code only, no personal or encrypted data.
- `SENTRY_URL` - Sentry DSN for server-side error reporting (e.g. a self-hosted Bugsink: `https://<key>@bugs.example.com/<project>`). When set, the same classified server errors that log to the console and ping ntfy are also captured by Sentry, with a real stack trace when the originating exception is available. Unset ⇒ Sentry is disabled (the SDK never initializes). The release is `chobble-tickets@<commit>`, matching the source maps the deploy workflows upload; readable (un-minified) traces additionally require the `SENTRY_AUTH_TOKEN`, `SENTRY_CLI_URL` (the instance base URL, e.g. `https://bugs.example.com/`), `SENTRY_ORG`, and `SENTRY_PROJECT` GitHub Actions secrets so the deploy can inject debug IDs and upload the maps. Without those secrets the deploy still works; traces just stay minified.
- `DEBUG_KEY` - Optional diagnostic key. `GET /health` returns a plain `Up :)` by default; a request with a matching `X-Debug-Key` header instead returns JSON build diagnostics (commit, build timestamp, server time) — non-private but useful to operators. Unset ⇒ verbose health disabled. The running build also records its commit into `settings.current_script_commit` on boot, so a backup carries the commit the site was on and a restore can surface which commit to redeploy (via `.github/workflows/restore-deploy.yml`).
- `BOTPOISON_PUBLIC_KEY` - Optional Botpoison public key (sent to the browser). The contact form works without it; setting it together with `BOTPOISON_SECRET_KEY` adds proof-of-work spam protection as a progressive enhancement. The owner still enables the form under Site → Contact and sets a business email.
- `BOTPOISON_SECRET_KEY` - Optional Botpoison secret key. Used server-side to verify contact form submissions when Botpoison is enabled. Never sent to the browser.
- `ADMIN_EMAIL_ADDRESS` - Enables a superuser recovery option in owner settings. The local-part (before `@`) must be a valid app username (2–32 characters, letters, numbers, hyphens, underscores). Email delivery must be configured before the superuser can be enabled. Also enables the owner-only **Support** page (`/admin/support`), where the operator can message this address.
- `SUPPORT_PAGE_TEXT` - Optional markdown shown at the top of the Support page (requires `ADMIN_EMAIL_ADDRESS`). Use literal `\n` for line breaks since Bunny secrets can't hold real newlines. When unset, a placeholder note is shown instead. The support form below it (which delivers to `ADMIN_EMAIL_ADDRESS`) needs a business email to be set, like the public contact form.
- `SUPPORT_FORM_NAG_DAYS` - Optional positive integer (default `7`). For this many days after a support-form submission, the Support page shows a "you last submitted this form …" notice to discourage duplicate messages.
- `I18N_REPLACEMENTS` - Optional comma-separated `from|to` substring replacements that rebrand the **translatable copy** of every rendered message, e.g. `ticket|booking,attendee|guest`. Matching is case-insensitive and by substring (`ticket|booking` turns `tickets` into `bookings`), and the output copies the source word's capitalisation — `Ticket` → `Booking`, `ticket` → `booking` (only lowercase and title-case occur in real copy). It is applied to each message **template** once at load, and the rebranded template is compiled and cached, so rendering stays a plain ICU format with no per-call cost (important on a cold-booting edge runtime). It deliberately leaves alone: HTML tags and attributes (so link `href`s survive), `<code>` examples (literal route/CLI text), interpolated values such as a stored listing name (so "type this exact name" confirmations still match), and the fallback key returned for a missing translation. Avoid terms that collide with ICU keywords or placeholder names (`name`, `count`, `plural`, …).
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

### 7. Assertion Strength and Mutation Resistance

- Treat 100% coverage as a hygiene floor, not proof that tests would catch meaningful regressions.
- Prefer assertions that would fail under realistic mutants: wrong arithmetic/operator, skipped validation, inverted permission checks, missing persistence, or omitted escaping.
- Avoid compound boolean assertions such as `expect(a && b).toBe(true)`; assert the observable contract directly with exact values, object shape, persisted rows, HTTP status/body, or rendered content.
- Avoid ending a test at `toBeTruthy()` / `toBeDefined()` unless mere existence is the actual user-visible contract. If existence matters, pair it with format, value, range, ordering, persistence, or security invariants.
- For pure functions, add table-driven or property-style examples that cover families of inputs and state the invariant being protected. Keep any generated cases deterministic.
- For critical flows, include negative-path, idempotency, concurrency, and metamorphic tests: e.g. payment/webhook replay does not double-credit, capacity cannot go below zero across edits/deletes, role downgrades remove access, and PII/secrets remain encrypted or absent from responses/logs.
- When generated or bulk-added tests are involved, run `deno task test:quality-audit` and review assertionless, truthiness, presence-only, and compound-boolean findings before trusting the coverage number.

### Mutation Testing

`test:quality-audit` only *guesses* which assertions look weak. `deno task
mutation` **proves** it: it mutates operators in your source and checks whether
your tests fail. A mutant your tests still pass on ("survived") is a real gap —
a code change nothing would have caught.

```bash
# Mutate a module's operators and run its mapped tests
deno task mutation src/shared/dates.ts test/lib/dates.test.ts

# Globs and exhaustive mode (every operator replacement, not just one each)
deno task mutation 'src/lib/forms/*.ts' 'test/lib/forms/*.test.ts' --exhaustive
```

It reports a mutation score and lists each survivor as
`file:line:col  old → new`. Exit code is non-zero if any mutant survived, so it
can gate CI on a chosen module. By default it runs the test files directly
(fast, for pure-unit modules); pass `--harness` for tests that import the app /
Stripe and need built static assets + stripe-mock. Under `--harness`, mutating a
client-bundle source (anything bundled into `src/ui/static/*.js` — e.g.
`src/ui/client/admin.ts` or a module it imports) rebuilds just the affected
bundle for each mutant, so the mutation reaches the built asset the tests load.

How it works (and why it is bespoke): it mutates the source file **in place**,
runs the mapped tests in a fresh `deno test` subprocess, then restores the
file. In-place mutation is what makes mutations bind through `#…` import-map
aliases. The operator tables and AST walk are vendored from
[Mutasaurus](https://github.com/christoshrousis/mutasaurus) (MIT); its own
execution model writes a temp copy but runs the original tests, so every mutant
falsely "survives" on an alias-based project — see
`scripts/mutation/LICENSE.mutasaurus.md`. It is a **targeted** tool (run it on
the module you are hardening), not part of `deno task precommit`, which would be
far too slow across the whole tree.

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
