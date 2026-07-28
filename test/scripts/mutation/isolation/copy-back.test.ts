import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runInSnapshot } from "#scripts/mutation/isolation.ts";
import {
  captureConsole,
  withoutChildCoverage,
  withTempDir,
  writeFakeScript,
} from "#test/scripts/mutation/isolation-helpers.ts";

const ENTRY = "keeper.ts";
const KEPT = "scripts/kept.txt";

/** Start a run whose child rewrites the kept file inside its own copy. */
const runKeeper = async (
  root: string,
  body: string,
): Promise<{ errors: string[]; logs: string[]; result: number }> => {
  await writeFakeScript(root, ENTRY, body);
  await Deno.writeTextFile(join(root, KEPT), "first\nsecond\n");
  return await captureConsole(() =>
    withoutChildCoverage(() =>
      runInSnapshot(
        { args: [], copyBack: [KEPT], entryScript: `scripts/${ENTRY}` },
        root,
      ),
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
      const run = await runKeeper(root, `${REWRITE_KEPT}Deno.exit(3);\n`);

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
