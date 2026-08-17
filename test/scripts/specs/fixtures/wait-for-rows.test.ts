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
    // The second row's line arrives just after the first poll.
    setTimeout(() => {
      void Deno.writeTextFile(path, "two\n", { append: true });
    }, 5);
    await waitForRows(path, { pollMs: 1 });
    expect(
      (await Deno.readTextFile(path)).split("\n").filter(Boolean),
    ).toHaveLength(2);
  });
});
