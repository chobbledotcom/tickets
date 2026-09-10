import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ALL_ADMIN_LEVELS, isOwnerRole, ownerOnlyAudience } from "#types";

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

describe("ownerOnlyAudience", () => {
  test("a gate that names the owner role refuses everyone else as owner-only", () => {
    expect(ownerOnlyAudience({ role: "owner", roles: undefined })).toBe(true);
    expect(ownerOnlyAudience({ role: "editor", roles: undefined })).toBe(false);
  });

  test("a gate that names one role owner-wide is owner-only", () => {
    expect(ownerOnlyAudience({ role: undefined, roles: ["owner"] })).toBe(true);
  });

  test("a gate naming owner among several roles is not owner-only", () => {
    expect(
      ownerOnlyAudience({ role: undefined, roles: ["owner", "editor"] }),
    ).toBe(false);
  });

  test("a gate with no audience spelled out is not owner-only", () => {
    expect(ownerOnlyAudience({ role: undefined, roles: undefined })).toBe(
      false,
    );
  });
});
