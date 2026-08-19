import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminDestinationAllowed,
  adminDestinationAt,
  adminPath,
  adminPattern,
  adminRecordPath,
} from "#shared/admin-surface.ts";

describe("the pattern a route declares", () => {
  test("is the one the surface holds, for every route", () => {
    // adminPattern names the literal its declaration wrote, which the fold
    // cannot carry through as a type. This reads all of them back, so the
    // name and the value can never drift apart unnoticed.
    const wrong = Object.entries(ADMIN_SURFACE.destinations)
      .filter(
        ([id, destination]) =>
          adminPattern(id as AdminDestinationId) !== destination.pattern,
      )
      .map(([id]) => id);
    expect(wrong).toEqual([]);
  });

  test("says which id was never declared", () => {
    // Reached only past the types, which is how a page definition naming a
    // route that does not exist shows itself.
    expect(() => adminPattern("nowhere" as AdminDestinationId)).toThrow(
      'No admin route is declared as "nowhere"',
    );
  });

  test("refuses to mint a record URL for a route taking two parameters", () => {
    // An entity page names the route it serves, so a route that needs a
    // second value cannot be one, and saying so at the page definition beats
    // minting a URL with a parameter still in it.
    expect(() => adminRecordPath("answerEdit", 7)).toThrow(
      'Admin route "answerEdit" does not address one record',
    );
  });

  test("refuses to mint a record URL for a route taking none", () => {
    // A collection's own path names no record either, and quietly returning
    // it would send every record to the same page.
    expect(() => adminRecordPath("holidays", 7)).toThrow(
      'Admin route "holidays" does not address one record',
    );
  });

  test("mints a record URL whatever the route calls its parameter", () => {
    expect(adminRecordPath("attendee", 7)).toBe("/admin/attendees/7");
    expect(adminRecordPath("holiday", 7)).toBe("/admin/holidays/7");
  });

  test("says which path has no route", () => {
    expect(() => adminDestinationAt("/admin/nowhere")).toThrow(
      'No admin route is declared at "/admin/nowhere"',
    );
  });

  test("keeps the parameters the route takes", () => {
    expect(adminPattern("holiday")).toBe("/admin/holidays/:id");
    expect(adminPattern("holidays")).toBe("/admin/holidays");
  });
});

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
