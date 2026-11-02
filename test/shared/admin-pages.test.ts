import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import {
  adminLandingPath,
  afterSavePath,
  entityReturnPath,
  readOnlyGetRoutePatterns,
  visibleSections,
  visibleTopLevel,
} from "#shared/admin-pages.ts";
import type { AdminDestinationDef } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE, adminDestination } from "#shared/admin-surface.ts";
import { normalizePath } from "#shared/path.ts";
import { type AdminLevel, ALL_ADMIN_LEVELS } from "#types";

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
    assert(
      !visibleTopLevel(context)
        .map((link) => link.href)
        .includes("/admin/site"),
    );
    assertArrayIncludes(
      visibleTopLevel({
        ...context,
        enabledFeatures: setFeatureEnabled(
          DEFAULT_ENABLED_FEATURES,
          "site",
          true,
        ),
      }).map((link) => link.href),
      ["/admin/site"],
    );
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
    const hidden = visibleTopLevel(context).map((link) => link.href);
    const visible = visibleTopLevel({
      ...context,
      builder: true,
      support: true,
    }).map((link) => link.href);
    // Builds is a top-level section now: it leaves the Settings sub-nav and
    // answers only to the builder flag.
    assert(!hidden.includes("/admin/built-sites"));
    assert(
      !visibleSections({ ...context, support: true })
        .flatMap((section) => section.items)
        .map((link) => link.href)
        .includes("/admin/built-sites"),
    );
    assertArrayIncludes(visible, ["/admin/built-sites"]);
    const subNav = visibleSections({ ...context, support: true })
      .flatMap((section) => section.items)
      .map((link) => link.href);
    assertArrayIncludes(subNav, ["/admin/support"]);
    const featureLinks = visibleSections({
      ...context,
      enabledFeatures: setFeatureEnabled(
        setFeatureEnabled(DEFAULT_ENABLED_FEATURES, "attributes", true),
        "questions",
        true,
      ),
    }).flatMap((section) => section.items);
    assertArrayIncludes(
      featureLinks.map((link) => link.href),
      ["/admin/attributes"],
    );
    assertArrayIncludes(
      featureLinks.map((link) => link.href),
      ["/admin/questions"],
    );
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
    assert(
      !sections.map((section) => section.topHref).includes("/admin/ledger"),
    );
  });

  test("derives read-only blocks from destination intent", () => {
    assertArrayIncludes(readOnlyGetRoutePatterns(), ["/admin/listing/new"]);
    assert(!readOnlyGetRoutePatterns().includes("/admin/listings"));
  });
});

describe("entityReturnPath", () => {
  test("sends a reader to the record's own page", () => {
    expect(entityReturnPath("/admin/listings", 5)).toBe("/admin/listing/5");
    expect(entityReturnPath("/admin/groups", 7)).toBe("/admin/groups/7");
  });

  test("falls back to the list when a section has no record page", () => {
    expect(entityReturnPath("/admin/settings", 1)).toBe("/admin/settings");
  });
});

describe("afterSavePath", () => {
  test("fills the saved record into the landing the route declares", () => {
    expect(afterSavePath(adminDestination("groupEdit"), 7)).toBe(
      "/admin/groups/7",
    );
    expect(afterSavePath(adminDestination("attendeeRefund"), 9)).toBe(
      "/admin/attendees/9/actions",
    );
  });

  test("lands a collection's edit on the list it declares", () => {
    expect(afterSavePath(adminDestination("modifierEdit"), 3)).toBe(
      "/admin/modifiers",
    );
    expect(afterSavePath(adminDestination("logisticsEdit"), 4)).toBe(
      "/admin/logistics",
    );
  });

  test("says which route declares no landing", () => {
    expect(() => afterSavePath(adminDestination("groupDelete"), 7)).toThrow(
      'Admin route "groupDelete" declares no after-save landing',
    );
  });

  test("says when a landing needs the record it names", () => {
    expect(() => afterSavePath(adminDestination("groupEdit"))).toThrow(
      'Admin route "groupEdit" lands on "group", which names a record',
    );
  });

  test("mints a filled path for every declared landing", () => {
    // One walk over the whole surface: a landing is a route that exists, and
    // every value it names is the saved record's id. A declaration that named
    // another kind of parameter would mint a path no page serves.
    for (const [id, destination] of Object.entries(
      ADMIN_SURFACE.destinations,
    )) {
      const landing = destination.afterSave;
      if (landing === undefined) continue;
      expect(ADMIN_SURFACE.destinations[landing.id], id).toBe(landing);
      for (const param of landing.pattern.match(/:\w+/g) ?? []) {
        expect(param, `${id} ${param}`).toMatch(/^:(?:id|\w+Id)$/);
      }
      expect(afterSavePath(destination, 42), id).toBe(
        landing.pattern.replace(/:(\w+)/g, "42"),
      );
    }
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
    assertArrayIncludes(
      visibleTopLevel(ownerContext).map((link) => link.href),
      ["/admin/ledger"],
    );
    assert(
      !visibleSections(ownerContext)
        .map((section) => section.topHref)
        .includes("/admin/ledger"),
    );
  });

  test("hides an add link while the site is read only, keeping the rest", () => {
    const readOnly = visibleSections({ ...ownerContext, isReadOnly: true })
      .flatMap((section) => section.items)
      .map((link) => link.href);
    const writable = visibleSections(ownerContext)
      .flatMap((section) => section.items)
      .map((link) => link.href);
    assertArrayIncludes(writable, ["/admin/listing/new"]);
    assert(!readOnly.includes("/admin/listing/new"));
    assertArrayIncludes(readOnly, ["/admin/listings"]);
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
    assert(!editorLinks.includes("/admin/settings"));
  });
});

describe("adminLandingPath", () => {
  /** The route that serves an address a visitor can type. Request paths drop
   * a trailing slash, so the dashboard serves "/admin" for "/admin/". */
  const routeServingAt = (path: string): AdminDestinationDef => {
    const route = Object.values(ADMIN_SURFACE.destinations).find(
      ({ pattern }) => normalizePath(pattern) === path,
    );
    if (!route) throw new Error(`No admin route serves "${path}"`);
    return route;
  };

  test("lands every role on a route that role can open", () => {
    for (const adminLevel of ALL_ADMIN_LEVELS) {
      assertArrayIncludes(
        routeServingAt(adminLandingPath(adminLevel)).audience,
        [adminLevel],
      );
    }
  });

  test("keeps each role's landing page", () => {
    expect(adminLandingPath("agent")).toBe("/admin/deliveries");
    expect(adminLandingPath("editor")).toBe("/admin/listings");
    expect(adminLandingPath("scanner")).toBe("/admin/scanner");
    expect(adminLandingPath("owner")).toBe("/admin");
    expect(adminLandingPath("manager")).toBe("/admin");
  });

  test("says which role has no landing", () => {
    // Reached only past the types, which is how a role the declaration does
    // not cover shows itself.
    expect(() => adminLandingPath("spectator" as AdminLevel)).toThrow(
      'No admin landing is declared for "spectator"',
    );
  });
});
