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

const DEFAULT_ENABLED_FEATURES = parseEnabledFeatures("");

describe("admin navigation", () => {
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
