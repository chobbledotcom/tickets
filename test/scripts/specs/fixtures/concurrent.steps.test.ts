import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CONCURRENT_ROWS,
  waitForRows,
} from "#test/scripts/specs/fixtures/concurrent.steps.ts";
import { tempDir } from "#test-utils/files.ts";

/** A runs file already holding `count` rows' lines. */
const runsFile = async (root: string, count: number): Promise<string> => {
  const path = `${root}/runs.txt`;
  await Deno.writeTextFile(path, "run\n".repeat(count));
  return path;
};

describe("waitForRows", () => {
  test("returns once every row has written its line", async () => {
    using temp = tempDir();
    const path = await runsFile(temp.path, CONCURRENT_ROWS);
    // No options: the defaults are what the real step uses.
    expect(await waitForRows(path)).toBeUndefined();
  });

  test("returns as soon as a late row's line arrives", async () => {
    using temp = tempDir();
    const path = await runsFile(temp.path, CONCURRENT_ROWS - 1);
    // The second row writes while the first is already polling, which is what
    // happens when the rows really do run side by side.
    const waiting = waitForRows(path, { pollMs: 1, timeoutMs: 5_000 });
    await Deno.writeTextFile(path, "run\n", { append: true });
    expect(await waiting).toBeUndefined();
  });

  test("gives up and names the shortfall when a row never starts", async () => {
    using temp = tempDir();
    const path = await runsFile(temp.path, 1);
    await expect(
      waitForRows(path, { pollMs: 1, rows: 3, timeoutMs: 0 }),
    ).rejects.toThrow(
      "Only 1 of 3 rows started within the wait, so the rows did not run at " +
        "the same time.",
    );
  });
});
