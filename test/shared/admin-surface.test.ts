import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
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

  test("takes each route's intent from the group it is declared in", () => {
    expect(adminDestination("modifiers").intent).toBe("view");
    expect(adminDestination("modifierEdit").intent).toBe("write-form");
  });

  test("gives every route the audience its area declares", () => {
    // holidayNew states no role of its own, so it takes the area's owner-only
    // audience — the same one the handler enforces.
    expect(adminDestination("holidayNew").audience).toEqual(["owner"]);
    expect(adminDestination("holidays").audience).toEqual(["owner"]);
  });
});
