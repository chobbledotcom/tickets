import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminDestinationAllowed,
  adminPath,
} from "#shared/admin-surface.ts";

describe("admin surface paths", () => {
  test("fills every named route parameter", () => {
    expect(adminPath("answerEdit", { answerId: 9, id: 42 })).toBe(
      "/admin/questions/42/answers/9/edit",
    );
  });

  test("allows write forms only for their audience while writable", () => {
    expect(adminDestinationAllowed("modifierEdit", "manager", false)).toBe(
      true,
    );
    expect(adminDestinationAllowed("modifierEdit", "editor", false)).toBe(
      false,
    );
    expect(adminDestinationAllowed("modifierEdit", "owner", true)).toBe(false);
  });

  test("allows view routes in read-only mode", () => {
    expect(adminDestinationAllowed("modifiers", "manager", true)).toBe(true);
  });

  test("keeps the complete top-level section order", () => {
    expect(ADMIN_SURFACE.sections.map((section) => section.id)).toEqual([
      "home",
      "listings",
      "calendar",
      "servicing",
      "attendees",
      "users",
      "groups",
      "images",
      "modifiers",
      "ledger",
      "site",
      "settings",
    ]);
  });

  test("takes each route's intent from the group it is declared in", () => {
    expect(adminDestination("modifiers").intent).toBe("view");
    expect(adminDestination("modifierEdit").intent).toBe("write-form");
  });

  test("keeps each section's sub-navigation in its declared order", () => {
    const users = ADMIN_SURFACE.sections.find(
      (section) => section.id === "users",
    )!;
    expect(users.nav.map((entry) => entry.id)).toEqual([
      "users",
      "userNew",
      "sessions",
      "apiKeys",
    ]);
  });

  test("gives every route the audience its area declares", () => {
    // holidayNew states no role of its own, so it takes the area's owner-only
    // audience — the same one the handler enforces.
    expect(adminDestination("holidayNew").audience).toEqual(["owner"]);
    expect(adminDestination("holidays").audience).toEqual(["owner"]);
  });
});
