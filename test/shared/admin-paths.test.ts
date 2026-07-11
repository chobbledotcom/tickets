import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { entityReturnPath, visibleTopLevel } from "#shared/admin-pages.ts";
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

  test("marks ordinary GET routes readable", () => {
    expect(
      ADMIN_SURFACE.routes.find((route) => route.id === "getSettings"),
    ).toEqual({
      area: "settings",
      id: "getSettings",
      method: "GET",
      pattern: "/admin/settings",
      readOnly: "allow",
    });
  });

  test("marks ordinary mutations blocked", () => {
    expect(
      ADMIN_SURFACE.routes.find((route) => route.id === "postSettingsEmail"),
    ).toEqual({
      area: "settings",
      id: "postSettingsEmail",
      method: "POST",
      pattern: "/admin/settings/email",
      readOnly: "block",
    });
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

  test("uses link and view defaults for ordinary destinations", () => {
    expect(adminDestination("sessions").nav?.kind).toBe("link");
    expect(adminDestination("modifiers").intent).toBe("view");
  });

  test("shows the Site section to editors when the public site is hidden", () => {
    expect(
      visibleTopLevel({
        active: "/admin",
        adminLevel: "editor",
        builder: false,
        hasLogistics: false,
        isReadOnly: false,
        showPublicSite: false,
        storage: false,
        support: false,
      }).map((link) => link.href),
    ).toContain("/admin/site");
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
