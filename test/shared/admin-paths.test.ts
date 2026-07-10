import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { entityReturnPath } from "#shared/admin-pages.ts";

describe("entityReturnPath (role-aware detail vs edit redirect)", () => {
  test("editors are sent to the edit form (they can't open the detail page)", () => {
    expect(entityReturnPath("/admin/listings", "editor", 5)).toBe(
      "/admin/listing/5/edit",
    );
    expect(entityReturnPath("/admin/groups", "editor", 7)).toBe(
      "/admin/groups/7/edit",
    );
  });

  test("staff are sent to the detail page", () => {
    expect(entityReturnPath("/admin/listings", "owner", 5)).toBe(
      "/admin/listing/5",
    );
    expect(entityReturnPath("/admin/listings", "manager", 5)).toBe(
      "/admin/listing/5",
    );
    expect(entityReturnPath("/admin/groups", "owner", 7)).toBe(
      "/admin/groups/7",
    );
    expect(entityReturnPath("/admin/groups", "agent", 7)).toBe(
      "/admin/groups/7",
    );
  });

  test("a section with no detail page falls back to its list page", () => {
    expect(entityReturnPath("/admin/settings", "owner", 1)).toBe(
      "/admin/settings",
    );
  });
});
