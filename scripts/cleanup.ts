import { rethrowUnlessNotFound } from "./not-found.ts";

export type CleanupTask = () => void | Promise<void>;

const throwCollectedErrors = (errors: unknown[]): void => {
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

export const failAfterCleanups = (
  error: unknown,
  cleanups: readonly CleanupTask[],
): Promise<never> => withCleanup<never>(() => Promise.reject(error), cleanups);
