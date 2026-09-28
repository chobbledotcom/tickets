import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete trigger declaration exact", async () => {
  expect(await jsonHash(TRIGGERS)).toBe(
    "79f46ffc272cad114e16dab1afb84653d42d3902d43ffd5ff197ac2508c9cde0",
  );
});
