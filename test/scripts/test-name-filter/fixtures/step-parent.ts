import { assert } from "@std/assert";

Deno.test("plain parent", async (t) => {
  assert(true);
  await t.step({ fn: () => {}, ignore: true, name: "optional step" });
});
