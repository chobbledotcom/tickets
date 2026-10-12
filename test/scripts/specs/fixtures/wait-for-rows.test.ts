import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { waitForRows } from "#test/scripts/specs/fixtures/concurrent.steps.ts";

describe("waitForRows", () => {
  test("returns at once when every row has already written", async () => {
    const path = await Deno.makeTempFile();
    await Deno.writeTextFile(path, "one\ntwo\n");
    await waitForRows(path);
  });

  test("polls until the missing row's line appears", async () => {
    const path = await Deno.makeTempFile();
    await Deno.writeTextFile(path, "one\n");
    // The second row's line arrives just after the first poll. The write is
    // awaited through the promise, so the test never ends while the write's
    // file operation is still in flight. A real timer is deliberate here: the
    // unit under test polls the real filesystem on the real clock, so a fake
    // timer cannot drive it.
    const appended = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await Deno.writeTextFile(path, "two\n", { append: true });
        resolve();
      }, 5);
    });
    await waitForRows(path, { pollMs: 1 });
    await appended;
    expect(
      (await Deno.readTextFile(path)).split("\n").filter(Boolean),
    ).toHaveLength(2);
  });
});
