/**
 * The side of a snapshot run that runs inside the copied checkout.
 *
 * The supervisor in isolation.ts sets these variables when it starts a child,
 * so a script can tell whether it is the outer command or the copy's worker.
 */

import { withMutationRunLock } from "./isolation-lock.ts";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_WORK_ROOT_ENV,
} from "./isolation-state.ts";

export const isSnapshotChild = (): boolean =>
  Deno.env.get(MUTATION_SNAPSHOT_CHILD_ENV) === "1";

/**
 * Where this child's run lives. Saying it is a child and then leaving out
 * which run it belongs to is a broken setup, not a run to carry on with: the
 * work would go ahead in whatever checkout it was started from, unlocked.
 */
const runValue = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `${MUTATION_SNAPSHOT_CHILD_ENV} is set, but ${name} is not. A snapshot child cannot run without its own run to work in.`,
    );
  }
  return value;
};

const runRootFromEnv = (): string => {
  runValue(MUTATION_RUN_ID_ENV);
  const runRoot = runValue(MUTATION_RUN_ROOT_ENV);
  runValue(MUTATION_WORK_ROOT_ENV);
  return runRoot;
};

/** Do the run's work, holding its lock so a clear-up cannot take the copy. */
export const runSnapshotChild = <Result>(
  body: () => Promise<Result>,
): Promise<Result> => withMutationRunLock(runRootFromEnv(), body);
