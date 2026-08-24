/**
 * Rules the admin declaration itself must keep. The fold, the navigation, and
 * the route tables all read this table, so a bad entry here reaches every one
 * of them.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_AREAS } from "#shared/admin-surface/areas.ts";
import { ADMIN_SURFACE, adminDestination } from "#shared/admin-surface.ts";
import { ALL_ADMIN_LEVELS } from "#types";

const routes = Object.values(ADMIN_SURFACE.destinations);

describe("the admin areas table", () => {
  test("gives every route a path under /admin", () => {
    const stray = routes
      .filter((route) => !route.pattern.startsWith("/admin"))
      .map((route) => `${route.id}: ${route.pattern}`);
    expect(stray).toEqual([]);
  });

  test("lets only real admin roles reach a route", () => {
    const strange = routes
      .filter((route) =>
        route.audience.some((level) => !ALL_ADMIN_LEVELS.includes(level)),
      )
      .map((route) => route.id);
    expect(strange).toEqual([]);
  });

  test("gives every route at least one role that can reach it", () => {
    // A route nobody can reach is dead, and its link would never render.
    const unreachable = routes
      .filter((route) => route.audience.length === 0)
      .map((route) => route.id);
    expect(unreachable).toEqual([]);
  });

  test("declares every area that serves a route", () => {
    const areaNames = new Set(Object.keys(ADMIN_AREAS));
    const orphans = routes
      .filter((route) => !areaNames.has(route.area))
      .map((route) => `${route.id}: ${route.area}`);
    expect(orphans).toEqual([]);
  });

  test("keeps the paths its own callers depend on", () => {
    // Spot checks: each is a path another module or a person types by hand.
    expect(adminDestination("home").pattern).toBe("/admin/");
    expect(adminDestination("settings").pattern).toBe("/admin/settings");
    expect(adminDestination("listingEdit").pattern).toBe(
      "/admin/listing/:id/edit",
    );
  });

  test("keeps the run sheet reachable by delivery agents", () => {
    // The handler is gated by deliveryPage, which admits agents; the surface
    // has to say the same or every link to it answers the wrong question.
    expect([...adminDestination("deliveries").audience].toSorted()).toEqual([
      "agent",
      "manager",
      "owner",
    ]);
  });
});
