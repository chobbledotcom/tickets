import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  MUTATION_RUN_ID_ENV,
  MUTATION_RUN_LOCK_FILE,
  MUTATION_RUN_ROOT_ENV,
  MUTATION_SNAPSHOT_CHILD_ENV,
  MUTATION_WORK_ROOT_ENV,
} from "#scripts/mutation/isolation-state.ts";
import {
  isSnapshotChild,
  runSnapshotChild,
} from "#scripts/mutation/snapshot-child.ts";
import { projectRoot } from "#scripts/project-root.ts";
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

  test("holds the run's lock while it works", async () => {
    await withTempDir(async (runRoot) => {
      setRunVars(runRoot);
      const lock = join(runRoot, MUTATION_RUN_LOCK_FILE);

      const held = await runSnapshotChild(() => pathExists(lock));

      expect(held).toBe(true);
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
