/**
 * Proves the admin surface stays honest as areas and routes change:
 *
 * - every schema route lives under `/admin` and a segment its area declares;
 * - every declared segment serves at least one route (no stale entries);
 * - every lazy module implements exactly its area's route IDs;
 * - no two route IDs or method/path pairs collide.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_AREA_LOADERS, adminPathSegment } from "#routes/admin/index.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

const loadAreaHandlers = async (): Promise<Map<string, string[]>> => {
  const handlersByArea = new Map<string, string[]>();
  for (const [name, area] of Object.entries(ADMIN_AREA_LOADERS)) {
    handlersByArea.set(name, Object.keys(await area.load()));
  }
  return handlersByArea;
};

describe("admin route manifest", () => {
  test("every route falls under /admin and a segment its area declares", () => {
    for (const route of ADMIN_SURFACE.routes) {
      expect(
        route.pattern === "/admin" || route.pattern.startsWith("/admin/"),
        route.id,
      ).toBe(true);
      const segment = adminPathSegment(route.pattern);
      expect(
        ADMIN_SURFACE.areas[route.area],
        `${route.id}: ${route.method} ${route.pattern}`,
      ).toContain(segment);
    }
  });

  test("every declared segment serves at least one of its area's routes", () => {
    for (const [name, segments] of Object.entries(ADMIN_SURFACE.areas)) {
      const served = ADMIN_SURFACE.routes
        .filter((route) => route.area === name)
        .map((route) => adminPathSegment(route.pattern));
      for (const segment of segments) {
        expect(served, `${name}: stale segment "${segment}"`).toContain(
          segment,
        );
      }
    }
  });

  test("every lazy area implements exactly its declared route IDs", async () => {
    for (const [name, handlerIds] of await loadAreaHandlers()) {
      const routeIds = ADMIN_SURFACE.routes
        .filter((route) => route.area === name)
        .map((route) => route.id)
        .sort();
      expect(handlerIds.sort(), name).toEqual(routeIds);
    }
  });

  test("route IDs and method/path pairs are unique", () => {
    const ids = new Set<string>();
    const patterns = new Set<string>();
    for (const route of ADMIN_SURFACE.routes) {
      const methodPath = `${route.method} ${route.pattern}`;
      expect(ids.has(route.id), route.id).toBe(false);
      expect(patterns.has(methodPath), methodPath).toBe(false);
      ids.add(route.id);
      patterns.add(methodPath);
    }
  });

  test("destination and server route IDs do not collide", () => {
    const destinationIds = new Set<string>(
      ADMIN_SURFACE.destinations.map((destination) => destination.id),
    );
    for (const route of ADMIN_SURFACE.routes) {
      expect(destinationIds.has(route.id), route.id).toBe(false);
    }
  });

  test("every UI destination is served by a GET route in its area", () => {
    for (const destination of ADMIN_SURFACE.destinations) {
      const concretePath = destination.pattern
        .replace(/:(\w+)/g, (_, name: string) =>
          name === "id" || name.endsWith("Id") ? "1" : "value",
        )
        .replace(/\/$/, "");
      expect(
        ADMIN_SURFACE.routes.some(
          (route) =>
            route.area === destination.area &&
            route.method === "GET" &&
            routePathPatternToRegex(route.pattern).test(concretePath),
        ),
        `${destination.id}: GET ${destination.pattern}`,
      ).toBe(true);
    }
  });

  test("adminPathSegment picks the part after /admin", () => {
    expect(adminPathSegment("/admin")).toBe("");
    expect(adminPathSegment("/admin/settings")).toBe("settings");
    expect(adminPathSegment("/admin/listing/5/edit")).toBe("listing");
  });
});

describeWithEnv("admin segment dispatch", { db: true }, () => {
  test("a path under no declared segment gets a 404", async () => {
    const response = await awaitTestRequest("/admin/no-such-area");
    expect(response.status).toBe(404);
  });

  test("a repeat hit on a settings segment succeeds twice", async () => {
    const first = await awaitTestRequest("/admin/settings");
    const second = await awaitTestRequest("/admin/settings");
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
  });
});
