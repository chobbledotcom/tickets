import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import {
  entityReturnPath,
  readOnlyGetRoutePatterns,
  visibleSections,
  visibleTopLevel,
} from "#shared/admin-pages.ts";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminDestinationAllowed,
  adminPath,
} from "#shared/admin-surface.ts";

const DEFAULT_ENABLED_FEATURES = parseEnabledFeatures("");

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

  test("uses link and view defaults for ordinary destinations", () => {
    expect(adminDestination("sessions").nav?.kind).toBe("link");
    expect(adminDestination("modifiers").intent).toBe("view");
  });

  test("shows the Site section to editors only when Site is enabled", () => {
    const context = {
      active: "/admin",
      adminLevel: "editor" as const,
      builder: false,
      enabledFeatures: DEFAULT_ENABLED_FEATURES,
      isReadOnly: false,
      storage: false,
      support: false,
    };
    expect(visibleTopLevel(context).map((link) => link.href)).not.toContain(
      "/admin/site",
    );
    expect(
      visibleTopLevel({
        ...context,
        enabledFeatures: setFeatureEnabled(
          DEFAULT_ENABLED_FEATURES,
          "site",
          true,
        ),
      }).map((link) => link.href),
    ).toContain("/admin/site");
  });

  test("applies per-link feature visibility", () => {
    const context = {
      active: "/admin/settings",
      adminLevel: "owner" as const,
      builder: false,
      enabledFeatures: DEFAULT_ENABLED_FEATURES,
      isReadOnly: false,
      storage: false,
      support: false,
    };
    const hidden = visibleSections(context).flatMap((section) => section.items);
    const visible = visibleSections({
      ...context,
      builder: true,
      support: true,
    }).flatMap((section) => section.items);
    expect(hidden.map((link) => link.href)).not.toContain("/admin/built-sites");
    expect(hidden.map((link) => link.href)).not.toContain("/admin/support");
    expect(hidden.map((link) => link.href)).not.toContain("/admin/attributes");
    expect(hidden.map((link) => link.href)).not.toContain("/admin/questions");
    expect(visible.map((link) => link.href)).toContain("/admin/built-sites");
    expect(visible.map((link) => link.href)).toContain("/admin/support");
    const featureLinks = visibleSections({
      ...context,
      enabledFeatures: setFeatureEnabled(
        setFeatureEnabled(DEFAULT_ENABLED_FEATURES, "attributes", true),
        "questions",
        true,
      ),
    }).flatMap((section) => section.items);
    expect(featureLinks.map((link) => link.href)).toContain(
      "/admin/attributes",
    );
    expect(featureLinks.map((link) => link.href)).toContain("/admin/questions");
  });

  test("omits sections with no sub-navigation", () => {
    const sections = visibleSections({
      active: "/admin/ledger",
      adminLevel: "owner",
      builder: false,
      enabledFeatures: DEFAULT_ENABLED_FEATURES,
      isReadOnly: false,
      storage: false,
      support: false,
    });
    expect(sections.map((section) => section.topHref)).not.toContain(
      "/admin/ledger",
    );
  });

  test("derives read-only blocks from destination intent", () => {
    expect(readOnlyGetRoutePatterns()).toContain("/admin/listing/new");
    expect(readOnlyGetRoutePatterns()).not.toContain("/admin/listings");
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
