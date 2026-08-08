import { rethrowUnlessNotFound } from "./not-found.ts";

export type CleanupTask = () => void | Promise<void>;

export const throwCollectedErrors = (errors: unknown[]): void => {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple errors occurred");
  }
};

const collectCleanupErrors = async (
  cleanups: readonly CleanupTask[],
): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

/** Run every cleanup in order, then surface every failure. */
export const runCleanups = async (
  cleanups: readonly CleanupTask[],
): Promise<void> => {
  const errors = await collectCleanupErrors(cleanups);
  throwCollectedErrors(errors);
};

/** Remove a generated file while accepting that another cleanup removed it. */
export const removeIfPresent = async (
  path: string,
  remove: (path: string) => Promise<void> = (path) => Deno.remove(path),
): Promise<void> => {
  await remove(path).catch(rethrowUnlessNotFound);
};

/** Run a task and all cleanup work without letting either hide another error. */
export const withCleanup = async <T>(
  task: () => Promise<T>,
  cleanups: readonly CleanupTask[],
): Promise<T> => {
  let outcome:
    | { succeeded: true; value: T }
    | {
        error: unknown;
        succeeded: false;
      };
  try {
    outcome = { succeeded: true, value: await task() };
  } catch (error) {
    outcome = { error, succeeded: false };
  }

  const cleanupErrors = await collectCleanupErrors(cleanups);
  if (!outcome.succeeded) {
    if (cleanupErrors.length === 0) throw outcome.error;
    throw new AggregateError(
      [outcome.error, ...cleanupErrors],
      "Multiple errors occurred",
    );
  }

  throwCollectedErrors(cleanupErrors);
  return outcome.value;
};

/**
 * Clean up something that is still being started.
 *
 * Starting a slow resource early so its wait overlaps other setup means the
 * setup after it can fail while the resource is still on its way. Checking a
 * "did it finish" variable at clean-up time would miss it and leak whatever
 * arrived afterwards, so the returned task waits for the start to settle and
 * releases whatever it produced.
 *
 * A start that failed has nothing to release, and raises its own error rather
 * than dropping it: the work may well have failed first and never reached the
 * point of awaiting the start, and a failure nobody ever sees is worse than one
 * reported twice.
 */
export const releaseWhenStarted = <T>(
  starting: Promise<T>,
  release: (started: T) => void | Promise<void>,
): CleanupTask => {
  // Claim the outcome now: without this, a start that fails while the caller is
  // still busy elsewhere is reported as an unhandled rejection.
  const settled = starting.then(
    (started) => ({ started }),
    (error: unknown) => ({ error }),
  );
  return async () => {
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    await release(outcome.started);
  };
};

export const failAfterCleanups = (
  error: unknown,
  cleanups: readonly CleanupTask[],
): Promise<never> => withCleanup<never>(() => Promise.reject(error), cleanups);
