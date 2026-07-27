/**
 * Re-throw `error` unless it is a Deno `NotFound` — the common "treat a missing
 * file/dir as absent, surface everything else" guard for filesystem catches.
 */
export const rethrowUnlessNotFound = (error: unknown): void => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
};

/**
 * Answer `null` when the thing simply is not there. Any other failure means
 * the disk could not be read at all, which throws rather than reading as
 * "nothing here".
 */
export const nullIfNotFound = <Found>(
  work: Promise<Found>,
): Promise<Found | null> =>
  work.catch((error: unknown) => {
    rethrowUnlessNotFound(error);
    return null;
  });
