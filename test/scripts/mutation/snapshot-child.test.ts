import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { runClaimIsFresh } from "#scripts/mutation/isolation-lock.ts";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
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
  MUTATION_WORK_ROOT_ENV,
];

const clearChildVars = (): void => {
  for (const name of CHILD_VARS) Deno.env.delete(name);
};

/** The run values a child started properly would see: it runs in its copy. */
const setRunVars = (runRoot: string): void => {
  Deno.env.set(MUTATION_RUN_ID_ENV, "mutation-test");
  Deno.env.set(MUTATION_RUN_ROOT_ENV, runRoot);
  Deno.env.set(MUTATION_WORK_ROOT_ENV, projectRoot);
};

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
      // The supervisor's claim, last touched long ago — as it reads moments
      // after a supervisor was killed outright.
      await Deno.writeTextFile(
        runClaimPath({ root: runRoot }),
        `the-supervisor\n${LONG_AGO.getTime()}`,
      );

      const freshDuringWork = await runSnapshotChild(() =>
        runClaimIsFresh({ root: runRoot }),
      );

      expect(freshDuringWork).toBe(true);
      // Still the supervisor's, and still there: the child never removes it.
      expect(
        (await Deno.readTextFile(runClaimPath({ root: runRoot }))).startsWith(
          "the-supervisor",
        ),
      ).toBe(true);
      expect(await pathExists(runClaimPath({ root: runRoot }))).toBe(true);
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
