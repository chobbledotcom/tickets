import { nowMs } from "#shared/now.ts";
import { createScopedValue } from "#shared/request-scoped.ts";

/** Keep refills on the primary while a nearby replica catches up. */
const PRIMARY_READ_AFTER_WRITE_MS = 30_000;

const primaryReads = createScopedValue(() => false);

/** Run database reads in `work` against the primary. */
export const runWithPrimaryReads = <T>(work: () => T): T =>
  primaryReads.run(true, work);

/** Whether reads in the current async scope must use the primary. */
export const mustReadFromPrimary = (): boolean => primaryReads.read();

/** A cache refill that uses the primary for a short time after invalidation. */
export interface PrimaryCacheRefill {
  afterInvalidation: (readFromPrimary: boolean) => void;
  fetch: <T>(load: () => Promise<T>) => Promise<T>;
}

/** Keep cache refills consistent after a local write without changing callers. */
export const createPrimaryCacheRefill = (
  now: () => number = nowMs,
  catchUpMs: number = PRIMARY_READ_AFTER_WRITE_MS,
): PrimaryCacheRefill => {
  let primaryUntil = 0;
  return {
    afterInvalidation: (readFromPrimary) => {
      if (readFromPrimary) {
        primaryUntil = Math.max(primaryUntil, now() + catchUpMs);
      }
    },
    fetch: (load) =>
      now() < primaryUntil ? runWithPrimaryReads(load) : load(),
  };
};
