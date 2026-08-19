import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ALL_ADMIN_LEVELS, isOwnerRole } from "#types";

describe("admin roles", () => {
  test("only the owner role has owner permissions", () => {
    const results = ALL_ADMIN_LEVELS.map((role) => [role, isOwnerRole(role)]);

    expect(results).toEqual([
      ["owner", true],
      ["manager", false],
      ["agent", false],
      ["editor", false],
    ]);
  });
});
