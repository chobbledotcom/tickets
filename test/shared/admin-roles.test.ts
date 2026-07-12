import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type AdminLevel, isOwnerRole } from "#shared/types.ts";

describe("admin roles", () => {
  test("only the owner role has owner permissions", () => {
    const results = (
      ["owner", "manager", "agent", "editor"] as AdminLevel[]
    ).map((role) => [role, isOwnerRole(role)]);

    expect(results).toEqual([
      ["owner", true],
      ["manager", false],
      ["agent", false],
      ["editor", false],
    ]);
  });
});
