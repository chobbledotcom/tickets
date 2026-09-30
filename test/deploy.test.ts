import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { denoServeHandler } from "#src/serve-app.ts";
import { importEntry } from "#test-utils/entry.ts";

test("the Deno Deploy entry serves through the Deno adapter", async () => {
  expect(await importEntry("#src/deploy.ts", "deploy")).toEqual([
    [denoServeHandler],
  ]);
});
