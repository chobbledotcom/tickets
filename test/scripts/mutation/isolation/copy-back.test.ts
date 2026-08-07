import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { keepFiles, runInSnapshot } from "#scripts/mutation/isolation.ts";
import { withCopyBackLock } from "#scripts/mutation/isolation-lock.ts";
import {
  captureConsole,
  withTempDir,
  writeFakeScript,
} from "#test/scripts/mutation/isolation-helpers.ts";
import {
  controlledChild,
  readOnlyRunRecord,
  stubCommand,
  waitForRunningRecord,
  withCapturedStopChild,
} from "./helpers.ts";

/** Long enough for a waiting run to actually reach the lock it waits on. */
const LONG_ENOUGH_TO_BE_WAITING_MS = 30;

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const ENTRY = "keeper.ts";
const KEPT = "scripts/kept.txt";

/** Start a run whose child rewrites the kept file inside its own copy. */
const runKeeper = async (
  root: string,
  body: string,
  code = 0,
): Promise<{ errors: string[]; logs: string[]; result: number }> => {
  // Ending with an exit keeps the child from writing coverage for files that
  // are deleted with the copy, which the coverage report cannot then read.
  await writeFakeScript(root, ENTRY, `${body}Deno.exit(${code});\n`);
  await Deno.writeTextFile(join(root, KEPT), "first\nsecond\n");
  return await captureConsole(() =>
    runInSnapshot(
      { args: [], copyBack: [KEPT], entryScript: `scripts/${ENTRY}` },
      root,
    ),
  );
};

const REWRITE_KEPT = `await Deno.writeTextFile("${KEPT}", "first\\n");\n`;

describe("keeping a snapshot run's file edits", () => {
  test("copies the run's version into the checkout and says so", async () => {
    await withTempDir(async (root) => {
      const run = await runKeeper(root, REWRITE_KEPT);

      expect(run.result).toBe(0);
      expect(run.logs).toContain(`Updated ${KEPT}`);
      expect(await Deno.readTextFile(join(root, KEPT))).toBe("first\n");
    });
  });

  test("keeps the edit even when the run itself reports a failure", async () => {
    await withTempDir(async (root) => {
      const run = await runKeeper(root, REWRITE_KEPT, 3);

      expect(run.result).toBe(3);
      expect(await Deno.readTextFile(join(root, KEPT))).toBe("first\n");
    });
  });

  test("fails without overwriting an edit made while the run was going", async () => {
    await withTempDir(async (root) => {
      const changeItMidRun = `
await Deno.writeTextFile("${join(root, KEPT)}", "changed by hand\\n");
${REWRITE_KEPT}`;

      const run = await runKeeper(root, changeItMidRun);

      expect(run.result).toBe(1);
      expect(run.errors.join("\n")).toContain(
        `${KEPT} changed while the isolated run was going`,
      );
      expect(await Deno.readTextFile(join(root, KEPT))).toBe(
        "changed by hand\n",
      );
      // The child exited cleanly, but the run did not do what it was for.
      const record = await readOnlyRunRecord(root);
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
    });
  });

  test("leaves the checkout alone when the run changed nothing", async () => {
    await withTempDir(async (root) => {
      const run = await runKeeper(root, "");

      expect(run.result).toBe(0);
      expect(run.logs.some((line) => line.startsWith("Updated "))).toBe(false);
      expect(await Deno.readTextFile(join(root, KEPT))).toBe("first\nsecond\n");
    });
  });
});

describe("interrupting a run as it finishes", () => {
  test("keeps nothing after interruption while waiting for the lock", async () => {
    await withTempDir(async (root) => {
      const result = await keepFiles(
        () => true,
        root,
        join(root, "missing-workspace"),
        [{ before: "original\n", file: KEPT }],
      );

      expect(result).toBe(0);
    });
  });

  test("keeps the copied file after acquiring the lock", async () => {
    await withTempDir(async (root) => {
      const workRoot = join(root, "work");
      await Deno.mkdir(join(workRoot, "scripts"), { recursive: true });
      await Deno.mkdir(join(root, "scripts"), { recursive: true });
      await Deno.writeTextFile(join(root, KEPT), "original\n");
      await Deno.writeTextFile(join(workRoot, KEPT), "updated\n");

      const result = await keepFiles(() => false, root, workRoot, [
        { before: "original\n", file: KEPT },
      ]);

      expect(result).toBe(0);
      expect(await Deno.readTextFile(join(root, KEPT))).toBe("updated\n");
    });
  });

  test("keeps nothing when the signal arrives while waiting for the copy-back lock", async () => {
    await withTempDir(async (root) => {
      await writeFakeScript(root, ENTRY, "Deno.exit(0);\n");
      await Deno.writeTextFile(join(root, KEPT), "first\nsecond\n");
      const child = controlledChild(42_431, () => {});
      using _command = stubCommand(child.child);

      await withCapturedStopChild(async (getStopChild) => {
        const run = captureConsole(() =>
          runInSnapshot(
            { args: [], copyBack: [KEPT], entryScript: `scripts/${ENTRY}` },
            root,
          ),
        );
        const started = await waitForRunningRecord(root);

        // Held here, so the run waits for it and the signal lands in that
        // wait. The copy is given something worth keeping, so a run that
        // carried on regardless would be caught writing it out.
        const released = Promise.withResolvers<void>();
        const taken = Promise.withResolvers<void>();
        const holding = withCopyBackLock(root, async () => {
          await Deno.writeTextFile(
            join(started.workRoot, KEPT),
            "kept from the copy\n",
          );
          taken.resolve();
          await released.promise;
        });
        // Only once it is really held does the run have to wait for it.
        await taken.promise;
        child.finish({ code: 0, signal: null, success: true });
        // The signal has to land while the run is inside that wait, not
        // before it gets there.
        await pause(LONG_ENOUGH_TO_BE_WAITING_MS);
        getStopChild()?.();
        released.resolve();
        await holding;

        expect((await run).result).toBe(130);
        const finished = await readOnlyRunRecord(root);
        expect(finished.status).toBe("interrupted");
        expect(await Deno.readTextFile(join(root, KEPT))).toBe(
          "first\nsecond\n",
        );
      });
    });
  });
});
