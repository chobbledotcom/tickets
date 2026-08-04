/**
 * The side of a snapshot run that runs inside the copied checkout.
 *
 * The supervisor in isolation.ts sets these variables when it starts a child,
 * so a script can tell whether it is the outer command or the copy's worker.
 */

import { resolve } from "@std/path";
import { processExists } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { ageRunClaimToStale, keepRunClaimFresh } from "./isolation-lock.ts";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_SUPERVISOR_PID_ENV,
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

type SnapshotRunHome = { runRoot: string; supervisorPid: number };

const runHomeFromEnv = (): SnapshotRunHome => {
  runValue(MUTATION_RUN_ID_ENV);
  const runRoot = runValue(MUTATION_RUN_ROOT_ENV);
  const supervisorPid = Number(runValue(MUTATION_SUPERVISOR_PID_ENV));
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
    throw new Error(
      `${MUTATION_SUPERVISOR_PID_ENV} must be a process id, not ${runValue(MUTATION_SUPERVISOR_PID_ENV)}.`,
    );
  }
  const workRoot = resolve(runValue(MUTATION_WORK_ROOT_ENV));
  // The copy it says it is in must be the one it is running from. Anything
  // else means these values belong to another run, and the work would land in
  // whatever checkout this script was started from — the live one, most likely.
  if (workRoot !== resolve(projectRoot)) {
    throw new Error(
      `A snapshot child says it works in ${workRoot}, but it is running in ${resolve(projectRoot)}.`,
    );
  }
  return { runRoot, supervisorPid };
};

const workUnderFreshClaim = async <Result>(
  { runRoot, supervisorPid }: SnapshotRunHome,
  body: () => Promise<Result>,
): Promise<Result> => {
  const record = { root: runRoot };
  const claim = await keepRunClaimFresh(record);
  try {
    return await body();
  } finally {
    try {
      await claim.stopTouching();
    } finally {
      // With the supervisor gone, nobody is left to release the claim; age
      // it so the run reads as over the moment this child ends, instead of
      // staying "live" for a whole stale window.
      if (!processExists(supervisorPid)) {
        await ageRunClaimToStale(record, claim.ownedBy);
      }
    }
  }
};

/** Do the run's work, keeping the supervisor's claim on the run fresh — so a
 * clear-up cannot take the copy even if the supervisor is killed outright. */
export const runSnapshotChild = <Result>(
  body: () => Promise<Result>,
): Promise<Result> => workUnderFreshClaim(runHomeFromEnv(), body);
