/**
 * When each of a mutant's test runs starts, and how long it may take.
 *
 * The baseline times every selected test file. A file quicker than
 * `FAST_TEST_MS` shares one run with the other quick files. A slower file gets
 * a run of its own. A mutant runs the quickest run first and stops at the first
 * failure, so a quick test that catches the bug saves every slower run.
 *
 * The order changes only how soon a failing test turns up, never the verdict.
 */

/** A test file, and how long it took to run on its own. */
export type TimedTest = Readonly<{ file: string; ms: number }>;

/** One run in a mutant's plan: its test files, and their baseline time added up. */
export type PlannedRun = Readonly<{ files: readonly string[]; ms: number }>;

/** Test files quicker than this share one `deno test` run. Starting a process
 *  costs about as much as a quick file, so one run for them all is cheaper. */
export const FAST_TEST_MS = 2_000;

/** Sort quickest first, and by name when two took as long, so the order is the
 *  same every run. */
export const quickestFirst = (a: TimedTest, b: TimedTest): number =>
  a.ms - b.ms || a.file.localeCompare(b.file);

/**
 * The test runs a mutant goes through, in order: one run of all the fast files,
 * then one run for each slow file, quickest first. Every file is in exactly one
 * run.
 *
 * For example, a 0.1 s, b 0.3 s, c 4 s and d 60 s give [a, b] (0.4 s), [c] and
 * [d].
 */
export const testPlan = (
  timings: readonly TimedTest[],
  fastMs = FAST_TEST_MS,
): PlannedRun[] => {
  const sorted = timings.toSorted(quickestFirst);
  const fast = sorted.filter((test) => test.ms < fastMs);
  const slow = sorted.filter((test) => test.ms >= fastMs);
  const alone = slow.map((test) => ({ files: [test.file], ms: test.ms }));
  if (fast.length === 0) return alone;
  return [
    {
      files: fast.map((test) => test.file),
      ms: fast.reduce((sum, test) => sum + test.ms, 0),
    },
    ...alone,
  ];
};

/**
 * The plan for one test set, taken from the baseline timings. Every file must
 * have a timing: a file the baseline never ran could not be placed in a run.
 */
export const planFor = (
  testFiles: readonly string[],
  timings: readonly TimedTest[],
  fastMs = FAST_TEST_MS,
): PlannedRun[] => {
  const timeByFile = new Map(timings.map((test) => [test.file, test]));
  return testPlan(
    testFiles.map((file) => {
      const timing = timeByFile.get(file);
      if (timing === undefined) {
        throw new Error(`No baseline timing for ${file}.`);
      }
      return timing;
    }),
    fastMs,
  );
};

/** How long a run may take: three times its baseline time, plus 10 s. A mutant
 *  that makes a test loop is then cut off in seconds, not minutes. A run past
 *  the limit is a frozen loop, not a verdict: the runner stops, names the
 *  mutant, and scores nothing. */
export const timeLimit = (run: PlannedRun): number => run.ms * 3 + 10_000;

/** How the log names a run: its one file, or "the 12 fast files". */
export const runName = (files: readonly string[]): string => {
  if (files.length === 1) return files.join("");
  return `the ${files.length} fast files`;
};
