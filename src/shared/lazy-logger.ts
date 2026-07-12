/**
 * Run something with the logger loaded on demand.
 *
 * `env.ts` and the db query-log both need to log without a static `logger`
 * import: the logger depends (transitively) on them, so a static import would
 * form a cycle. This loads the logger only when there is actually something to
 * report, then hands its exports to `use`.
 */
export const withLazyLogger = async (
  use: (logger: typeof import("#shared/logger.ts")) => void,
): Promise<void> => {
  use(await import("#shared/logger.ts"));
};
