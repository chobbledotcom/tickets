/**
 * Rules the admin declaration itself must keep. The fold, the navigation, and
 * the route tables all read this table, so a bad entry here reaches every one
 * of them.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_AREAS } from "#shared/admin-surface/areas.ts";
import type { AdminPatternFor } from "#shared/admin-surface/ids.ts";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminPattern,
  recordAreaIds,
  recordAreaPatterns,
} from "#shared/admin-surface.ts";
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

  test("serves a POST-only area under the URL segment it posts to", () => {
    // A POST-only area names no page of its own, so nothing else catches a
    // wrong segment: the router would 404 the post before the area loads.
    // Its write route derives the segment it serves.
    expect(ADMIN_SURFACE.areas.markdownPreview).toEqual(["markdown-preview"]);
  });

  test("lands every generated save override on a page its actors can open", () => {
    // A save must not send its actor to a forbidden page after the write.
    const stranded = routes.flatMap((route) => {
      if (route.afterSave === undefined) return [];
      const landing = ADMIN_SURFACE.destinations[route.afterSave]!;
      const shut = route.audience.filter(
        (level) => !landing.audience.includes(level),
      );
      return shut.length === 0
        ? []
        : [`${route.id} to ${landing.id}: ${shut.join(", ")}`];
    });

    expect(stranded).toEqual([]);
  });
});

describe("the derived record area writes", () => {
  test("declare each derived write under the path its helper builds", () => {
    const expected = {
      answerAdd: "/admin/questions/:id/answers",
      answerDelete: "/admin/questions/:id/answers/:answerId/delete",
      attributeOptionEdit: "/admin/attributes/:id/options/:optionId/edit",
      attributeOptionMoveUp: "/admin/attributes/:id/options/:optionId/move-up",
      groupImagesUpload: "/admin/groups/:id/images/upload",
      newsActions: "/admin/site/news/:id/actions",
      sitePageImages: "/admin/site/pages/:id/images",
      statusMoveDown: "/admin/settings/statuses/:id/move-down",
    } as const;
    type Id = keyof typeof expected;
    const ids = Object.keys(expected) as Id[];
    // The annotation checks the literal types the helpers derive.
    const declared: { readonly [K in Id]: AdminPatternFor<K> } = expected;
    expect(ids.map((id) => adminPattern(id))).toEqual(Object.values(declared));
  });

  test("give each record area the ids and paths of its five routes", () => {
    expect(recordAreaIds("settingsLogistics")).toEqual({
      detail: "logisticsAgent",
      list: "logistics",
      newPage: true,
      remove: "logisticsDelete",
    });
    const patterns: {
      readonly detail: "/admin/site/news/:id";
      readonly list: "/admin/site/news";
    } = recordAreaPatterns("news");
    expect(patterns).toEqual({
      detail: "/admin/site/news/:id",
      list: "/admin/site/news",
    });
  });
});
