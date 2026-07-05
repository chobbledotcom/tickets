/**
 * Reclaim libsql's leaked file descriptors during long test runs.
 *
 * libsql's file-backed client leaks one file descriptor per client creation and
 * per interactive transaction: `close()` never releases it — a transaction
 * orphans its connection and neither `commit()` nor `close()` shuts it down, so
 * only garbage collection reclaims it. The suite mints a fresh client every test
 * and runs many `withTransaction` writes, so under high `--parallel` worker
 * counts these leaked descriptors outrun GC and exhaust the process limit
 * ("Too many open files"). That exhaustion lands on whichever test is unlucky
 * enough to hit the wall — a flaky failure that moves between runs.
 *
 * Calling `gc()` periodically keeps the descriptor count bounded. `gc` is only
 * exposed when the harness passes `--v8-flags=--expose-gc` (see
 * `buildDenoTestArgs`); without it — a bare `deno test` — this is a safe no-op.
 *
 * The amortised counter below is module state, so it starts from zero in every
 * test file. A large file crosses the every-{@link RECLAIM_FDS_EVERY} threshold
 * many times, but a file with fewer DB setups than the threshold never GCs at
 * all — and once the suite is organised as many small focused files (the
 * ~400-line-file rule), those never-reclaimed leaks add up across files and can
 * exhaust a low descriptor limit that the same tests in monolithic files stayed
 * under. `describeWithEnv` therefore also calls {@link reclaimLeakedFdsNow} in
 * `afterAll`, so every suite hands back its descriptors when it finishes no
 * matter how few tests it ran.
 */

/** Force a GC every this many calls, amortising its cost across the run. */
export const RECLAIM_FDS_EVERY = 20;

const state = { count: 0 };

/**
 * Call once per test DB setup. Forces a GC every {@link RECLAIM_FDS_EVERY}
 * invocations to reclaim libsql's leaked descriptors. `gc` defaults to the
 * runtime's `globalThis.gc` (present only under `--expose-gc`); it is injectable
 * so the behaviour is unit-testable without depending on the V8 flag.
 */
export const maybeReclaimLeakedFds = (
  gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc,
): void => {
  state.count += 1;
  if (state.count % RECLAIM_FDS_EVERY !== 0) return;
  if (gc) gc();
};

/**
 * Reclaim leaked descriptors right now, regardless of the amortised counter —
 * called at suite teardown (`describeWithEnv`'s `afterAll`) so a small file
 * that never reaches {@link RECLAIM_FDS_EVERY} setups still releases its
 * leaked descriptors instead of carrying them for the rest of the run.
 */
export const reclaimLeakedFdsNow = (
  gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc,
): void => {
  if (gc) gc();
};
