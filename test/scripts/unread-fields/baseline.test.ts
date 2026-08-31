import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { UNREAD_FIELD_BASELINE } from "#scripts/unread-fields/baseline.ts";
import { UNREAD_FIELD_EXEMPTIONS } from "#scripts/unread-fields/exemptions.ts";
import { findingIdentityKey } from "#scripts/unread-fields/identity.ts";
import { expectStableUniqueIdentities } from "#test-utils/unread-field-policy.ts";

describe("unread-field baseline", () => {
  test("holds exact current debt in stable order", () => {
    expectStableUniqueIdentities(UNREAD_FIELD_BASELINE);
  });

  test("does not claim that a reviewed exemption is debt", () => {
    const baseline = new Set(UNREAD_FIELD_BASELINE.map(findingIdentityKey));
    const overlaps = UNREAD_FIELD_EXEMPTIONS.filter(({ identity }) =>
      baseline.has(findingIdentityKey(identity)),
    );

    expect(overlaps).toEqual([]);
  });

  test("names only exported production files", () => {
    expect(
      UNREAD_FIELD_BASELINE.every(({ exportedFrom }) =>
        exportedFrom.startsWith("src/"),
      ),
    ).toBe(true);
  });
});
