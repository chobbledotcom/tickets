import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "#test/scripts/unread-fields/fixture/build.ts";
import { EVERY_FIELD } from "#test/scripts/unread-fields/fixture/every-field.ts";

/**
 * Every field the scan finds in the fixture, so a change that quietly adds
 * or drops one has to say so here.
 */
describe("the whole inventory", () => {
  const scanned = scannedFixture();

  test("reports every field of every exported shape, and only those", () => {
    expect(scanned.all.map((f) => `${f.owner}.${f.field}`).sort()).toEqual([
      ...EVERY_FIELD,
    ]);
  });
});
