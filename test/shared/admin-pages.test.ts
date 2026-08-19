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
  // Which page a role lands on is decided by the audience the record page
  // declares, not by naming one role. Only content roles reach these two
  // call sites, so those are the roles the cases below cover.
  test("sends a role that cannot open the record page to its edit form", () => {
    expect(entityReturnPath("/admin/listings", "editor", 5)).toBe(
      "/admin/listing/5/edit",
    );
    expect(entityReturnPath("/admin/groups", "editor", 7)).toBe(
      "/admin/groups/7/edit",
    );
  });

  test("sends a role that can open the record page to the page", () => {
    expect(entityReturnPath("/admin/listings", "owner", 5)).toBe(
      "/admin/listing/5",
    );
    expect(entityReturnPath("/admin/listings", "manager", 5)).toBe(
      "/admin/listing/5",
    );
    expect(entityReturnPath("/admin/groups", "owner", 7)).toBe(
      "/admin/groups/7",
    );
    expect(entityReturnPath("/admin/groups", "manager", 7)).toBe(
      "/admin/groups/7",
    );
  });

  test("a section with no detail page falls back to its list page", () => {
    expect(entityReturnPath("/admin/settings", "owner", 1)).toBe(
      "/admin/settings",
    );
  });
});

describe("links a section hides", () => {
  const ownerContext = {
    active: "/admin/settings",
    adminLevel: "owner" as const,
    builder: false,
    enabledFeatures: setFeatureEnabled(DEFAULT_ENABLED_FEATURES, "money", true),
    isReadOnly: false,
    storage: false,
    support: false,
  };

  test("drops a section whose only link is its own landing", () => {
    // Money is on, so the owner can see the Ledger section, and it still has
    // no sub-navigation of its own because it holds exactly one link.
    expect(visibleTopLevel(ownerContext).map((link) => link.href)).toContain(
      "/admin/ledger",
    );
    expect(
      visibleSections(ownerContext).map((section) => section.topHref),
    ).not.toContain("/admin/ledger");
  });

  test("hides an add link while the site is read only, keeping the rest", () => {
    const readOnly = visibleSections({ ...ownerContext, isReadOnly: true })
      .flatMap((section) => section.items)
      .map((link) => link.href);
    const writable = visibleSections(ownerContext)
      .flatMap((section) => section.items)
      .map((link) => link.href);
    expect(writable).toContain("/admin/listing/new");
    expect(readOnly).not.toContain("/admin/listing/new");
    expect(readOnly).toContain("/admin/listings");
  });

  test("hides a link the viewer's role cannot reach", () => {
    const editorLinks = visibleSections({
      ...ownerContext,
      active: "/admin/listings",
      adminLevel: "editor",
    })
      .flatMap((section) => section.items)
      .map((link) => link.href);
    // Editors reach the listings pages but not the owner-only settings ones.
    expect(editorLinks).not.toContain("/admin/settings");
  });
});
