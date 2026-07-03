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
