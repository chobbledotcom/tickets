/**
 * Re-throw `error` unless it is a Deno `NotFound` — the common "treat a missing
 * file/dir as absent, surface everything else" guard for filesystem catches.
 */
export const rethrowUnlessNotFound = (error: unknown): void => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
};
