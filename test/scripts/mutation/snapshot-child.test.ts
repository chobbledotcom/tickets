import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { runClaimIsFresh } from "#scripts/mutation/isolation-lock.ts";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_SUPERVISOR_PID_ENV,
  MUTATION_WORK_ROOT_ENV,
  runClaimPath,
} from "#scripts/mutation/isolation-state.ts";
import {
  isSnapshotChild,
  runSnapshotChild,
} from "#scripts/mutation/snapshot-child.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { LONG_AGO } from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists, withTempDir } from "#test-utils/files.ts";

const CHILD_VARS = [
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_SUPERVISOR_PID_ENV,
  MUTATION_WORK_ROOT_ENV,
];

const clearChildVars = (): void => {
  for (const name of CHILD_VARS) Deno.env.delete(name);
};

/** A pid that is not this process's parent, as a child killed out from
 * under its supervisor would see — whoever now holds that pid. */
const DEAD_SUPERVISOR_PID = 99_999_999;

/** The run values a child started properly would see: it runs in its copy,
 * and the supervisor that spawned it is its parent process. */
const setRunVars = (
  runRoot: string,
  supervisorPid: number = Deno.ppid,
): void => {
  Deno.env.set(MUTATION_RUN_ID_ENV, "mutation-test");
  Deno.env.set(MUTATION_RUN_ROOT_ENV, runRoot);
  Deno.env.set(MUTATION_SUPERVISOR_PID_ENV, String(supervisorPid));
  Deno.env.set(MUTATION_WORK_ROOT_ENV, projectRoot);
};

/** The supervisor's claim, last touched long ago — as it reads moments
 * after a supervisor was killed outright. */
const writeAgedSupervisorClaim = (runRoot: string): Promise<void> =>
  Deno.writeTextFile(
    runClaimPath({ root: runRoot }),
    `the-supervisor\n${LONG_AGO.getTime()}`,
  );

describe("the worker inside a snapshot", () => {
  afterEach(clearChildVars);

  test("knows it is the copy's worker only when told so", () => {
    clearChildVars();
    expect(isSnapshotChild()).toBe(false);

    Deno.env.set(MUTATION_SNAPSHOT_CHILD_ENV, "1");
    expect(isSnapshotChild()).toBe(true);
  });

  test("keeps the supervisor's claim fresh while it works", async () => {
    await withTempDir(async (runRoot) => {
      setRunVars(runRoot);
      await writeAgedSupervisorClaim(runRoot);

      const freshDuringWork = await runSnapshotChild(() =>
        runClaimIsFresh({ root: runRoot }),
      );

      expect(freshDuringWork).toBe(true);
      // Still the supervisor's, and still fresh: the supervisor lives, so
      // releasing stays its job.
      expect(
        (await Deno.readTextFile(runClaimPath({ root: runRoot }))).startsWith(
          "the-supervisor",
        ),
      ).toBe(true);
      expect(await runClaimIsFresh({ root: runRoot })).toBe(true);
    });
  });

  test("ages the claim on exit when its supervisor is gone", async () => {
    await withTempDir(async (runRoot) => {
      setRunVars(runRoot, DEAD_SUPERVISOR_PID);
      await writeAgedSupervisorClaim(runRoot);

      await runSnapshotChild(() => Promise.resolve());

      // Nobody is left to release the claim, so the child ages it: the run
      // reads as over right away, not after a whole stale window.
      expect(await pathExists(runClaimPath({ root: runRoot }))).toBe(true);
      expect(await runClaimIsFresh({ root: runRoot })).toBe(false);
      expect(
        (await Deno.readTextFile(runClaimPath({ root: runRoot }))).startsWith(
          "the-supervisor",
        ),
      ).toBe(true);
    });
  });

  test("refuses to work in a snapshot no claim protects", async () => {
    await withTempDir(async (runRoot) => {
      setRunVars(runRoot);
      let ranAnyway = false;

      await expect(
        runSnapshotChild(() => {
          ranAnyway = true;
          return Promise.resolve(0);
        }),
      ).rejects.toThrow();
      expect(ranAnyway).toBe(false);
    });
  });

  test("refuses to work when it is not told which run it belongs to", async () => {
    await withTempDir((runRoot) => {
      setRunVars(runRoot);
      Deno.env.set(MUTATION_SNAPSHOT_CHILD_ENV, "1");
      Deno.env.delete(MUTATION_WORK_ROOT_ENV);
      let ranAnyway = false;

      expect(() =>
        runSnapshotChild(() => {
          ranAnyway = true;
          return Promise.resolve(0);
        }),
      ).toThrow(
        `${MUTATION_SNAPSHOT_CHILD_ENV} is set, but ${MUTATION_WORK_ROOT_ENV} is not`,
      );
      // Carrying on would mutate whatever checkout it was started from.
      expect(ranAnyway).toBe(false);
      return Promise.resolve();
    });
  });

  test("accepts the smallest real process id as a supervisor", async () => {
    await withTempDir(async (runRoot) => {
      // Pid 1 is a real process id, so the child must work — whatever this
      // test process's own parent happens to be.
      setRunVars(runRoot, 1);
      await writeAgedSupervisorClaim(runRoot);

      expect(await runSnapshotChild(() => Promise.resolve("worked"))).toBe(
        "worked",
      );
    });
  });

  test("refuses to work with a supervisor pid that is not a process id", async () => {
    await withTempDir((runRoot) => {
      setRunVars(runRoot);
      Deno.env.set(MUTATION_SUPERVISOR_PID_ENV, "not-a-pid");

      expect(() => runSnapshotChild(() => Promise.resolve(0))).toThrow(
        "must be a process id",
      );
      return Promise.resolve();
    });
  });

  test("refuses to work when the copy it names is not the one it is in", async () => {
    await withTempDir((runRoot) => {
      setRunVars(runRoot);
      Deno.env.set(MUTATION_SNAPSHOT_CHILD_ENV, "1");
      // Values from another run: this one is not running in that copy.
      Deno.env.set(MUTATION_WORK_ROOT_ENV, join(runRoot, "somebody-elses"));
      let ranAnyway = false;

      expect(() =>
        runSnapshotChild(() => {
          ranAnyway = true;
          return Promise.resolve(0);
        }),
      ).toThrow("but it is running in");

      expect(ranAnyway).toBe(false);
      return Promise.resolve();
    });
  });
});
