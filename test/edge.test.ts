import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bunnyServeHandler } from "#src/serve-app.ts";
import { importEntry } from "#test-utils/entry.ts";

test("the Bunny entry serves through the Bunny adapter", async () => {
  const calls = await importEntry("#src/edge.ts", "edge");
  expect(calls.map((args) => args.at(-1))).toEqual([bunnyServeHandler]);
});
