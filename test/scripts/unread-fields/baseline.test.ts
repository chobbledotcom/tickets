import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { UNREAD_FIELD_BASELINE } from "#scripts/unread-fields/baseline.ts";
import { expectStableUniqueIdentities } from "#test-utils/unread-field-policy.ts";

describe("unread-field baseline", () => {
  test("holds exact current debt in stable order", () => {
    expectStableUniqueIdentities(UNREAD_FIELD_BASELINE);
  });

  test("names only exported production files", () => {
    expect(
      UNREAD_FIELD_BASELINE.every(({ exportedFrom }) =>
        exportedFrom.startsWith("src/"),
      ),
    ).toBe(true);
  });
});
