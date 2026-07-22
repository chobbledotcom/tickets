/**
 * Split the test files for one mutation run into batches that each execute in
 * their own `deno test` process.
 *
 * Why batch at all: the local libsql sqlite3 driver strands one file descriptor
 * per interactive transaction — its `Client.transaction()` detaches a
 * connection that nothing ever closes (commit/rollback only issue SQL, and the
 * later `Client.close()` reclaims a different, lazily-recreated connection), so
 * the fd is only released when V8 finalizes the orphaned handle during GC. A
 * single process that loads many test files can therefore spike past its
 * open-file ceiling before GC catches up, which surfaces as "Too many open
 * files". The full suite avoids this by sharding across `--parallel` workers;
 * the mutation runner runs each set in one process (so a mutant binds through
 * the `#…` import map), so it instead caps how many files a process loads and
 * runs the rest in a fresh process — process exit releases every fd it held.
 */

/**
 * Files per `deno test` process. Small enough that one process's transaction
 * churn stays well under the open-file ceiling on every platform (macOS
 * defaults its hard limit far lower than Linux), large enough that process
 * startup stays negligible for the common, small changed-file set.
 */
export const TEST_FILE_BATCH_SIZE = 24;

/** Chunk `testFiles` into runs of at most `size`, preserving order. */
export const batchTestFiles = (
  testFiles: string[],
  size = TEST_FILE_BATCH_SIZE,
): string[][] => {
  const batches: string[][] = [];
  for (let i = 0; i < testFiles.length; i += size) {
    batches.push(testFiles.slice(i, i + size));
  }
  return batches;
};
