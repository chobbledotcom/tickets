# Test suite speed: a ranked plan

One `deno task test` run on 16 cores took 335.197 s of wall clock. That run
held 28,809 leaf tests and 4,467 s of leaf CPU, so about 13 tests ran at one
time on average. The suite is already well tuned. A test pays 4.9 ms for its
database, the isolate groups share one module graph, and the static asset cache
skips the build. Most of the rest of the time sits in two places: the migration
chain and the worker cap on the coverage gate. This document condenses three
audits into one plan. It changes no code and no test.

## Where the time goes

| Part | Measurement | Share |
| --- | --- | --- |
| Full run | 335.197 s wall, 28,809 leaf tests, 4,467 s leaf CPU, 16 jobs | about 13x concurrency |
| Migration chain, 8 shards | 170.1–184.6 s per shard, 1,415 s leaf CPU | 31.7 % of leaf CPU, critical path |
| All tests with "migration" in the name | 1,935 s leaf CPU | 43.3 % of leaf CPU |
| `verify-models` pair | 46.9 s and 43.3 s | 2.0 % (estimate: 90.2 s ÷ 4,467 s) |
| Legacy-migration trio | 122.7 s | 2.7 % of leaf CPU |
| Per-test database fixture | 4.9 ms × about 11,300 database tests | about 1 % of leaf CPU |
| `createTestListing` setup | 3,988 sites × 9–14 ms | about 40 s CPU (estimate: 3,988 × about 10 ms) |
| stripe-mock start | 852 ms, once per run | 114 of 2,728 files use Stripe |
| Coverage gate at 4 workers | 4,467 s leaf CPU ÷ 4 | about 1,120 s wall (estimate) |

The chain row is part of the migration row. The rest of the suite holds the
other 56.7 % of leaf CPU, and its longest single block is 86.4 s. The
stripe-mock start costs 0.85 s per run, so it stays out of the plan below.

## Changes in order

1. **Replace the eight chain shards with one forward walk.**
   - Change: one file walks from the first boundary to the current schema.
     It calls `applyMigrationWithRetry` and `markMigrationsApplied` from
     production code, pays one seed and one rewind, then asserts at each
     boundary. The last migration stays pending for one real `initDb()`.
   - Evidence: `defineChainSuite` in
     `test/integration/db/migration-restore/helpers.ts` drives
     `chain-a.test.ts` to `chain-h.test.ts`, and the eight shard rows each take
     170.1–184.6 s.
   - Payoff: 5,460 migration applications become 471. The local
     `migration-restore` directory takes 13.6 s to 20.5 s, against 89.6 s
     before the change. The hosted coverage step falls from 387 s on the docs
     head to 338 s on the chain head. That is a fall of 51 s, or 10.4 %. The
     chain head ran on a slightly slower machine (prefix 166 s against 155 s),
     so the saving is real.
   - Blast radius: one new test file, nine removed files, and `helpers.ts`.
   - Risk: medium. The walk shares one database, so an assertion must only
     read. The pristine fixture claim narrows at early boundaries, so keep the
     five cheap pristine boundaries. The walk must count the applied migrations
     at each step, so a skipped migration fails the test.

> **Rejected: raise the worker cap on the coverage gate.**
>
> `COVERAGE_WORKER_CAP` in `scripts/workers.ts` sets the worker count under
> `--coverage`. Keep the value at 4. Do not merge the cap change.
>
> The first 8-worker run took 472 s for the `test` job, against 405 s for the
> docs baseline. Its coverage step took 376 s, against 286 s. In that run the
> eight chain files each took 54.7 s to 66.8 s. Four-worker runs of the same
> code minutes later took 24.1 s to 32.1 s. Fixed-step machine spread on
> identical code was 1.45 to 1.52 times, so the 2.2 times chain-file inflation
> is oversubscription, not machine speed. No memory pressure appeared, and line
> coverage stayed at 100 %.

2. **Add direct fixtures for listings and attendees.**
   - Change: add a direct-insert listing fixture beside `createTestListing`,
     and use it in suites whose subject is not the create form. In
     `createTestAttendee`, call `signCsrfToken()` before the ticket render.
   - Evidence: `test/test-utils/db-helpers/listings.ts` POSTs the real admin
     form, and 3,988 sites use it.
     `test/test-utils/db-helpers/attendees.ts` renders `/ticket/<slug>` only to
     read a CSRF token.
   - Payoff: listing setup falls by about 40 s CPU (estimate: 3,988 × about
     10 ms). The attendee change saves about 2–3 s CPU. Both are CPU, so the
     wall gain is a few seconds at 16 jobs.
   - Blast radius: `test/test-utils/db-helpers/` and the pure-database suites
     that switch.
   - Risk: medium for the listing helper. A suite that proves the create form
     must not switch, so each converted file needs its own review. Low for the
     attendee helper, because 263 sites already take the direct path.

3. **Parse model data once, and share one legacy migration run.**
   - Change: parse the committed model data at module level in the two
     `verify-models` suites. Build the legacy database once, then assert the
     question and backfill outcomes in separate tests.
   - Evidence: `test/scripts/verify-models/invoice-flow.test.ts` and
     `test/scripts/verify-models/attendee-capacity.test.ts` parse the data in
     8 of 10 tests and in 4 of 7 tests.
     `test/integration/db/legacy-migration/` runs the full chain once per file.
   - Payoff: about 75–80 s from the parse and about 60–90 s from the legacy
     run, so about 135–170 s leaf CPU (estimate: the sum of the measured block
     times).
   - Blast radius: five test files.
   - Risk: low for the parse, because every assertion stays. Medium for the
     legacy run. First confirm that the question and backfill files start from
     the same state. `partial-state` starts half migrated, so it must stay in
     its own file.

4. **Remove redundant tests, as maintenance work.**
   - Change:
     - Delete the per-route `testRequiresAuth` copies. The central role matrix
       already proves the auth gate for every declared route.
     - Keep one invalid-token CSRF check for every mutating route. Generate the
       checks from the route table as one case matrix. A new route then gets
       its check without a hand-copied test. A route with missing CSRF wiring
       must fail a test.
     - Merge the per-route 404 tests into one table per route family, with one
       row per route.
     - Turn identical-body ladders into input and expected tables.
     - Replace `toBeDefined` with the assertion that names the value or shape.
     - Delete a test that pins an export alias or a constant to its own
       literal.
   - Evidence: 172 `testRequiresAuth` sites in
     `test/test-utils/assertions.ts`, 27 CSRF rows in the generated matrix
     against the gate in `src/features/auth.ts`, 63 per-route 404 tests, 1,361
     identical-body tests, and 94 `toBeDefined`.
   - Payoff: no large time win. Each of these tests costs milliseconds. The
     gain is fewer copies to keep in step and a failure name that points at one
     case.
   - Blast radius: test files only. The identical-body ladders alone span 197
     files.
   - Risk: low, with one guard. Coverage can fall where a duplicate test is the
     only reader of a line, so run `deno task cov:files` on the file before a
     delete and `deno task test:coverage` after.

These four changes leave the fixture database and the isolate groups alone.
The first change owns the large win on wall clock. The second owns a CPU win
in fixture setup. The third owns the next win on the ordinary run. Treat the
fourth as hygiene, not as a speed item. The rejected cap test above shows that
the coverage gate keeps its measured time at 4 workers.

## What to keep

- **The golden database copy.** A test copies a 933 KB file in 0.6 ms, opens a
  client in 2.5 ms and replays setup state in 1.5 ms. The local libsql client
  has no copy-on-write mode, so no overlay can beat the copy.
- **Isolate grouping.** 2,728 files run as 110 isolates, so the module graph
  load is 25 times smaller. The 41 solo files stay solo for timer and teardown
  correctness.
- **The static asset cache.** A hit costs a 16–24 ms hash check over 187
  files, and esbuild and sass never load.
- **The virtual clock.** 228 `FakeTime` sites cover the suite, and one real
  `await delay(0)` is left. No sleep-based wait is left to remove.

## How to measure a change

Measure before and after on the same machine and at the same job count. Read
the worker count first, because the coverage cap changes the result.

- `deno task test` prints the wall time and every test above 500 ms. The slow
  list comes from `.test-junit.xml`, which the run writes.
- `deno task test:coverage` runs the gate. It uses `COVERAGE_WORKER_CAP`
  workers, so a change to that cap shows here and not in `deno task test`.
- `deno task test:files <path>` runs one file or one folder, for a fast check
  of one change.
- `.test-junit.xml` holds one row per describe and one per leaf test. The root
  `time` is the wall clock of the child process. Never add a describe row to
  its own leaf rows.
- `deno task cov:files <path>` prints the lines and branches that one slice
  leaves uncovered. Use it before a delete. The coverage gate stays the
  authority.
- `deno task unit-tests-report` lists test files that do not mirror a source
  file. The list is a tool view, not a delete list.
