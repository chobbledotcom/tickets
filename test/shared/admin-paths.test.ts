import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groupReturnPath, listingReturnPath } from "#shared/admin-paths.ts";

describe("role-aware admin entity paths", () => {
  test("editors are sent to the edit form (they can't open the detail page)", () => {
    expect(listingReturnPath("editor", 5)).toBe("/admin/listing/5/edit");
    expect(groupReturnPath("editor", 7)).toBe("/admin/groups/7/edit");
  });

  test("staff are sent to the detail page", () => {
    expect(listingReturnPath("owner", 5)).toBe("/admin/listing/5");
    expect(listingReturnPath("manager", 5)).toBe("/admin/listing/5");
    expect(groupReturnPath("owner", 7)).toBe("/admin/groups/7");
    expect(groupReturnPath("agent", 7)).toBe("/admin/groups/7");
  });
});
