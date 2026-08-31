import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { UNREAD_FIELD_EXEMPTIONS } from "#scripts/unread-fields/exemptions.ts";
import { expectStableUniqueIdentities } from "#test-utils/unread-field-policy.ts";

describe("unread-field exemptions", () => {
  test("holds reviewed exact identities in stable order", () => {
    expectStableUniqueIdentities(
      UNREAD_FIELD_EXEMPTIONS.map(({ identity }) => identity),
    );
  });

  test("names production evidence for every exemption", () => {
    expect(
      UNREAD_FIELD_EXEMPTIONS.every(
        ({ reason }) => reason.evidence.trim().length > 0,
      ),
    ).toBe(true);
  });
});
