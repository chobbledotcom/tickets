/**
 * Proves the admin route manifest (ADMIN_AREAS in src/features/admin/index.ts)
 * stays honest as areas and routes change:
 *
 * - every route an area defines lives under `/admin` and under one of the
 *   segments the area declares (a route added under an undeclared segment
 *   would be unreachable — the dispatcher never loads the area for it);
 * - every declared segment serves at least one route (no stale entries);
 * - no two areas define the same pattern (so per-segment merge order can
 *   never silently decide which handler wins).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_AREAS, adminPathSegment } from "#routes/admin/index.ts";
import { awaitTestRequest, describeWithEnv } from "#test-utils";

const patternPath = (pattern: string): string => pattern.split(" ")[1] ?? "";

const loadAreaRoutes = async (): Promise<Map<string, string[]>> => {
  const routesByArea = new Map<string, string[]>();
  for (const [name, area] of Object.entries(ADMIN_AREAS)) {
    routesByArea.set(name, Object.keys(await area.load()));
  }
  return routesByArea;
};

describe("admin route manifest", () => {
  test("every route falls under /admin and a segment its area declares", async () => {
    for (const [name, patterns] of await loadAreaRoutes()) {
      const declared = ADMIN_AREAS[name]!.segments;
      for (const pattern of patterns) {
        const path = patternPath(pattern);
        expect(path === "/admin" || path.startsWith("/admin/"), pattern).toBe(
          true,
        );
        const segment = adminPathSegment(path);
        expect(
          declared,
          `${name}: ${pattern} (segment "${segment}")`,
        ).toContain(segment);
      }
    }
  });

  test("every declared segment serves at least one of its area's routes", async () => {
    for (const [name, patterns] of await loadAreaRoutes()) {
      const served = patterns.map((pattern) =>
        adminPathSegment(patternPath(pattern)),
      );
      for (const segment of ADMIN_AREAS[name]!.segments) {
        expect(served, `${name}: stale segment "${segment}"`).toContain(
          segment,
        );
      }
    }
  });

  test("no two areas define the same pattern", async () => {
    const owners = new Map<string, string>();
    for (const [name, patterns] of await loadAreaRoutes()) {
      for (const pattern of patterns) {
        expect(
          owners.get(pattern),
          `${pattern} in both ${owners.get(pattern)} and ${name}`,
        ).toBeUndefined();
        owners.set(pattern, name);
      }
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
