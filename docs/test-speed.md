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
   - Payoff: 5,460 migration applications become 104. Chain CPU falls from
     about 1,415 s to about 25 s, and the critical path from 184.6 s to about
     25 s. A full run falls to about 175 s (estimate: the chain no longer sets
     the wall, and the next longest block is 86.4 s).
   - Blast radius: one new test file, nine removed files, and `helpers.ts`.
   - Risk: medium. The walk shares one database, so an assertion must only
     read. The pristine fixture claim narrows at early boundaries, so keep the
     five cheap pristine boundaries. The walk must count the applied migrations
     at each step, so a skipped migration fails the test.

2. **Raise the worker cap on the coverage gate, after one measurement.**
   - Change: measure the peak RSS of one isolate group under `--coverage`.
     Then raise `COVERAGE_WORKER_CAP` in `scripts/workers.ts` from 4 to 8. If
     memory is short, halve the group size first.
   - Evidence: `COVERAGE_WORKER_CAP` in `scripts/workers.ts` sets the worker
     count under `--coverage`. `scripts/test-harness.ts` and
     `scripts/precommit/runner.ts` call it. CI uses an 8-core runner.
   - Payoff: gate wall falls from about 1,120 s to about 560 s at 8 workers
     (estimate: leaf CPU ÷ worker count). The doubling holds, because it is the
     same work on twice the workers, but the coverage gate keeps its
     instrumentation overhead, so 8 workers gives about half the gate time, not
     parity with a plain `deno task test` run. The `test` job comment in
     `.github/workflows/test.yml` says the full suite with coverage finishes in
     about seven minutes on the 8-core runner at 4 workers, so the JUnit CPU
     sum implies a much longer gate and the difference points at machine load
     during the audit run, which means the RSS measurement must also record the
     gate wall time at 4 and at 8 workers.
   - Blast radius: `scripts/workers.ts`, `scripts/test-groups.ts` and their
     tests.
   - Risk: out of memory. Each worker keeps a coverage buffer for the code that
     its group loads. The cap must not move before the RSS measurement, and the
     measurement must name one group and one worker count.

3. **Add direct fixtures for listings and attendees.**
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

4. **Parse model data once, and share one legacy migration run.**
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

5. **Remove redundant tests, as maintenance work.**
   - Change:
     - Keep one auth-gate test per channel and one CSRF test per channel.
     - Merge the per-route 404 tests into one table per route family.
     - Turn identical-body ladders into input and expected tables.
     - Replace `toBeDefined` with the assertion that names the value or shape.
     - Delete a test that pins an export alias or a constant to its own
       literal.
   - Evidence: 172 `testRequiresAuth` sites in
     `test/test-utils/assertions.ts`, 27 per-route CSRF tests against the gate
     in `src/features/auth.ts`, 63 per-route 404 tests, 1,361 identical-body
     tests, and 94 `toBeDefined`.
   - Payoff: no large time win. Each of these tests costs milliseconds. The
     gain is fewer copies to keep in step and a failure name that points at one
     case.
   - Blast radius: test files only. The identical-body ladders alone span 197
     files.
   - Risk: low, with one guard. Coverage can fall where a duplicate test is the
     only reader of a line, so run `deno task cov:files` on the file before a
     delete and `deno task test:coverage` after.

These five changes leave the fixture database and the isolate groups alone.
The first change owns the large win on wall clock. The second owns the large
win on the coverage gate. The fourth owns the next win on the ordinary run.
Treat the fifth as hygiene, not as a speed item.

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
