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

const runRootFromEnv = (): string | null => {
  const id = Deno.env.get(MUTATION_RUN_ID_ENV);
  const runRoot = Deno.env.get(MUTATION_RUN_ROOT_ENV);
  const workRoot = Deno.env.get(MUTATION_WORK_ROOT_ENV);
  return id && runRoot && workRoot ? runRoot : null;
};

/** Do the run's work, holding its lock so a clear-up cannot take the copy. */
export const runSnapshotChild = async <Result>(
  body: () => Promise<Result>,
): Promise<Result> => {
  const runRoot = runRootFromEnv();
  return runRoot === null
    ? await body()
    : await withMutationRunLock(runRoot, body);
};
