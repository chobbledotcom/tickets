/**
 * Proves the admin surface stays honest as areas and routes change:
 *
 * - every lazy route lives under `/admin` and a segment its area declares;
 * - every declared segment serves at least one route (no stale entries);
 * - no two method/path pairs collide;
 * - every UI destination has a matching GET route.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";
import { adminPathSegment } from "#routes/admin/index.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

const loadAreaRoutes = async (): Promise<Map<string, string[]>> => {
  const routesByArea = new Map<string, string[]>();
  for (const [name, area] of Object.entries(ADMIN_AREA_LOADERS)) {
    routesByArea.set(name, Object.keys(await area.load()));
  }
  return routesByArea;
};

const routeParts = (route: string): readonly [method: string, path: string] => {
  const boundary = route.indexOf(" ");
  if (boundary === -1) throw new Error(`Invalid route: ${route}`);
  return [route.slice(0, boundary), route.slice(boundary + 1)];
};

describe("admin route manifest", () => {
  let routesByArea: Map<string, string[]>;

  beforeAll(async () => {
    routesByArea = await loadAreaRoutes();
  });

  test("every route falls under /admin and a segment its area declares", () => {
    for (const [area, routes] of routesByArea) {
      for (const route of routes) {
        const [method, path] = routeParts(route);
        expect(["DELETE", "GET", "PATCH", "POST", "PUT"], route).toContain(
          method,
        );
        expect(path === "/admin" || path.startsWith("/admin/"), route).toBe(
          true,
        );
        expect(
          ADMIN_SURFACE.areas[area as keyof typeof ADMIN_SURFACE.areas],
          route,
        ).toContain(adminPathSegment(path));
      }
    }
  });

  test("every declared segment serves at least one of its area's routes", () => {
    for (const [name, segments] of Object.entries(ADMIN_SURFACE.areas)) {
      const served = routesByArea
        .get(name)!
        .map((route) => adminPathSegment(routeParts(route)[1]));
      for (const segment of segments) {
        expect(served, `${name}: stale segment "${segment}"`).toContain(
          segment,
        );
      }
    }
  });

  test("method/path pairs are unique", () => {
    const routes = new Set<string>();
    for (const areaRoutes of routesByArea.values()) {
      for (const route of areaRoutes) {
        expect(routes.has(route), route).toBe(false);
        routes.add(route);
      }
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
        routesByArea.get(destination.area)!.some((route) => {
          const [method, path] = routeParts(route);
          return (
            method === "GET" && routePathPatternToRegex(path).test(concretePath)
          );
        }),
        `${destination.id}: GET ${destination.pattern}`,
      ).toBe(true);
    }
  });

  test("adminPathSegment picks the part after /admin", () => {
    expect(adminPathSegment("/admin")).toBe("");
    expect(adminPathSegment("/admin/settings")).toBe("settings");
    expect(adminPathSegment("/admin/listing/5/edit")).toBe("listing");
  });

  test("guide message ownership rejects an undeclared segment", () => {
    expect(() => ADMIN_AREA_LOADERS.guide.messageGroupsFor("unknown")).toThrow(
      'No message groups declared for admin segment "unknown"',
    );
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
