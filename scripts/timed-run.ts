/**
 * The shared "run a labelled async job and watch the clock" wrapper behind the
 * profiling scripts: the cold-boot profiler's phase timings and the cold-start
 * benchmark's per-query timeline are both instances of it.
 */

/** Runs a labelled async job and gives back the job's own result. */
export type TimedRun = <T>(label: string, run: () => Promise<T>) => Promise<T>;

/** Build a labelled async runner. `before` (optional) runs ahead of the job —
 * e.g. a fake network delay — and `after` sees the label, the start time, and
 * the elapsed milliseconds once the job finishes. The clock starts before
 * `before`, so a simulated delay counts toward the measured time. */
export const timedRunner =
  (hooks: {
    after: (label: string, startedAt: number, ms: number) => void;
    before?: () => Promise<void>;
  }): TimedRun =>
  async (label, run) => {
    const startedAt = performance.now();
    if (hooks.before) await hooks.before();
    const result = await run();
    hooks.after(label, startedAt, performance.now() - startedAt);
    return result;
  };
