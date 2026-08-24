/**
 * Proves the admin surface stays honest as areas and routes change:
 *
 * - every lazy route lives under `/admin` and a segment its area declares;
 * - every declared segment serves at least one route (no stale entries);
 * - no two method/path pairs collide;
 * - every UI destination has a matching GET route;
 * - every GET route has a destination declaring who may reach it.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { requiredMapValue } from "#fp";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";
import { adminPathSegment } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";
import { oneServedPath } from "#test-utils/admin-surface.ts";

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

const getRoutesOf = (routes: readonly string[]): readonly string[] =>
  routes.filter((route) => routeParts(route)[0] === "GET");

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
    for (const destination of Object.values(ADMIN_SURFACE.destinations)) {
      const servedPath = oneServedPath(destination.pattern);
      expect(
        getRoutesOf(
          requiredMapValue(
            routesByArea,
            destination.area,
            `No routes loaded for area ${destination.area}`,
          ),
        ).some((route) =>
          routePathPatternToRegex(routeParts(route)[1]).test(servedPath),
        ),
        `${destination.id}: GET ${destination.pattern}`,
      ).toBe(true);
    }
  });

  test("every GET route has a destination saying who may reach it", () => {
    // The other way round from the check above, and what keeps the surface
    // complete: a page nobody declared is a page the role matrix never asks,
    // and a link the read-only gate and the nav both reason about wrongly.
    const declared = Object.values(ADMIN_SURFACE.destinations);
    const undeclared: string[] = [];
    for (const routes of routesByArea.values()) {
      for (const route of getRoutesOf(routes)) {
        const pattern = routePathPatternToRegex(routeParts(route)[1]);
        const covered = declared.some((destination) =>
          pattern.test(oneServedPath(destination.pattern)),
        );
        if (!covered) undeclared.push(route);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test("guide message ownership rejects an undeclared segment", () => {
    expect(() => ADMIN_AREA_LOADERS.guide.messageGroupsFor("unknown")).toThrow(
      'No message groups declared for admin segment "unknown"',
    );
  });
});
