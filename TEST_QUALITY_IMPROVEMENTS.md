# Test suite quality improvement plan

This repository already treats coverage as a hard hygiene floor:
`deno task precommit` runs linting, type checking, duplicate-code detection, the
edge build, and full line/branch coverage. That is valuable, but the quoted
critique is right: it does not prove that the assertions would catch meaningful
regressions. The next step is to measure assertion strength and production-like
failure modes directly.

## Current suite shape

A quick static audit of `test/**/*.ts(x)` found:

- 378 test files.
- 7,404 `test()` / `it()` declarations.
- 1,347 boolean-shape assertions such as `expect(...).toBe(true|false)`.
- 53 truthiness/falsiness assertions.
- 266 defined/undefined assertions.
- No snapshot assertions.

Those numbers are not failures by themselves. Boolean and presence checks are
often appropriate for guards, permissions, and optional state. They are also
where weak assertions tend to hide, because a broken implementation can still
produce “some truthy value” or make a compound expression true for the wrong
reason.

## Substantive improvements

### 1. Add mutation testing as an explicit quality gate

Coverage should remain mandatory, but mutation testing should be the
suite-quality metric. Start with high-risk pure or near-pure modules where
mutants run quickly:

- pricing and payment calculations;
- booking capacity/range logic;
- date and timezone helpers;
- permission/role guards;
- URL and embed safety helpers;
- CSV/export formatting;
- cryptographic token validation boundaries.

Recommended rollout:

1. Create a mutation task that runs against a small allowlist of fast modules.
2. Record the first mutation score as a baseline instead of failing the build.
3. Require no score regression on touched modules.
4. Ratchet the baseline upward as surviving mutants are converted into stronger
   behavioral tests.
5. Only then expand to route and database-heavy modules, where runtime and flaky
   mutants need more tuning.

A useful first target is not “100% mutation score”; it is “every safety-critical
change must either kill relevant mutants or document why the surviving mutant is
semantically equivalent.”

### 2. Replace compound boolean assertions with state-specific assertions

Assertions like:

```ts
expect(state.available && state.username === "admin").toBe(true);
```

should become explicit checks on the observable contract:

```ts
expect(state).toMatchObject({ available: true, username: "admin" });
```

This gives failures better diagnostics and prevents one broad boolean from
hiding which part of the behavior regressed. The audit found enough boolean
assertions to justify a gradual cleanup rule: new or touched tests should avoid
compound boolean expressions unless the tested API truly returns a boolean.

### 3. Strengthen presence checks into value or invariant checks

`toBeDefined()` and `toBeTruthy()` should usually be the beginning of an
assertion, not the end. For example, a generated key test can assert format,
length, round-trip use, encryption-at-rest, and that the plaintext is not
stored. A response-body test can assert the exact subset of fields that matters
to callers, not just that a field exists.

Proposed rule for code review: if a test only proves a value exists, require a
short explanation of why existence is the user-visible contract. Otherwise,
assert the specific value, shape, range, ordering, persistence effect, or denial
mode.

### 4. Add negative-path and metamorphic tests around critical invariants

For ticket reservations, the disaster cases are mostly boundary and invariant
violations. Add table-driven tests that probe these properties:

- capacity never goes below zero under edits, deletes, mixed orders, or
  overlapping booking ranges;
- payment callbacks are idempotent and cannot over-credit an order;
- role downgrades immediately remove access to owner-only and manager-only
  paths;
- encrypted settings and PII never appear in plaintext database columns,
  backups, logs, or rendered pages;
- CSV/export filters only include selected rows and columns;
- date-range rules behave identically across DST boundaries and configured
  timezones.

These tests should assert durable outcomes after production code runs: database
rows, HTTP statuses, emitted emails/messages, cache invalidation, or rendered
content. Avoid asserting private helper call order unless that order is itself
the contract.

### 5. Add property-based tests for compact, high-risk pure functions

Property tests are a good complement to examples for modules with clear
invariants:

- slug generation is idempotent, bounded, and safe for URLs;
- CSV generation round-trips commas, quotes, CRLF, and empty cells;
- date formatting/parsing preserves local dates across timezones;
- token parsers reject malformed, truncated, or mixed-case values;
- URL safety rejects private networks, scheme smuggling, and encoded bypasses.

Keep property tests deterministic by seeding the generator and storing any
failing seed in the test name or fixture. They should not replace example tests;
they should explore the weird inputs humans forget.

### 6. Run a weak-assertion audit before large test additions

Before accepting generated or bulk-added tests, run a lightweight audit that
reports:

- tests with no visible assertion;
- assertions that only check truthiness or definedness;
- compound boolean assertions;
- tests that assert on values set directly in the test without intervening
  production behavior;
- excessive mocking of the module under test.

This should initially be informational, then become a CI warning, and finally a
review gate for touched files. The goal is not to ban every weak-looking
assertion; it is to force deliberate review where false confidence is most
likely.

### 7. Add production-shape tests outside unit coverage

Some disasters are not line-coverage problems. Add scheduled or release-blocking
checks for:

- edge bundle smoke tests in the closest available Bunny/Deno runtime;
- backup/restore drills with encrypted settings and attendee PII;
- concurrent reservation attempts against libsql to prove atomic capacity
  updates;
- webhook replay/idempotency tests for Stripe and SumUp;
- basic load tests for listing, checkout, and admin attendee pages;
- security scans for redirects, iframe/embed host rules, and secret leakage.

These checks do not need to run on every save. They should run before release or
on a nightly schedule, with clear ownership for failures.

## Suggested priority order

1. Introduce mutation testing on a small critical allowlist.
2. Clean up compound boolean assertions in touched files.
3. Convert presence-only checks in security/payment/booking tests into contract
   assertions.
4. Add concurrency/idempotency tests for reservations and webhooks.
5. Add property-based tests for pure parsers/formatters/safety helpers.
6. Add release-level smoke, backup/restore, and load checks.

## Success metrics

Track these alongside coverage:

- mutation score on the allowlisted critical modules;
- number of surviving non-equivalent mutants;
- count of assertionless or presence-only tests in touched files;
- number of production-shape checks run before each release;
- escaped defects classified by the missing test layer: unit assertion weakness,
  integration gap, deployment/config, data migration, load, security, or wrong
  spec.

Coverage stays the floor. Mutation score, invariant tests, and production-shape
checks become the evidence that the suite would actually notice important bugs.
