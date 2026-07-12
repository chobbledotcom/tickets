/**
 * Run something with the logger loaded on demand.
 *
 * `env.ts` and the db query-log both need to log without a static `logger`
 * import: the logger depends (transitively) on them, so a static import would
 * form a cycle. This loads the logger only when there is actually something to
 * report, then hands its exports to `use`.
 */
export const withLazyLogger = async (
  use: (logger: typeof import("#shared/logger.ts")) => void | Promise<void>,
): Promise<void> => {
  try {
    // Await the callback too: an async `use` is assignable to this param, and
    // its rejection would escape the catch below if we didn't wait for it.
    await use(await import("#shared/logger.ts"));
  } catch {
    // Best-effort logging: a failed dynamic import or a throwing callback must
    // never crash the fire-and-forget caller or leak an unhandled rejection.
    // There is nothing useful to do when logging itself fails, so swallow it.
  }
};
