import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { adminPath, adminRouteAllowed } from "#shared/admin-surface.ts";

describe("admin surface paths", () => {
  test("fills every named route parameter", () => {
    expect(adminPath("answerEdit", { answerId: 9, id: 42 })).toBe(
      "/admin/questions/42/answers/9/edit",
    );
  });

  test("allows write forms only for their audience while writable", () => {
    expect(adminRouteAllowed("modifierEdit", "manager", false)).toBe(true);
    expect(adminRouteAllowed("modifierEdit", "editor", false)).toBe(false);
    expect(adminRouteAllowed("modifierEdit", "owner", true)).toBe(false);
  });

  test("allows view routes in read-only mode", () => {
    expect(adminRouteAllowed("modifiers", "manager", true)).toBe(true);
  });
});

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
