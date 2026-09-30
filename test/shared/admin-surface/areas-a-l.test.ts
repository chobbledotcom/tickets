import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { AREAS_A_L } from "#shared/admin-surface/areas-a-l.ts";

/** One declared route: a bare pattern, or a pattern with its own audience. */
type DeclaredRoute = string | { pattern: string };

/** Every route pattern one area declares, views and writes alike. */
const patternsOf = (area: {
  view?: Record<string, DeclaredRoute>;
  write?: Record<string, DeclaredRoute>;
}): string[] =>
  [...Object.values(area.view ?? {}), ...Object.values(area.write ?? {})].map(
    (route) => (typeof route === "string" ? route : route.pattern),
  );

const areas = Object.entries(AREAS_A_L);

describe("the A-L admin areas", () => {
  test("declare every route as a real path under /admin/", () => {
    const stray = areas.flatMap(([name, area]) =>
      patternsOf(area)
        .filter((pattern) => !/^\/admin\/\S*$/.test(pattern))
        .map((pattern) => `${name}: ${JSON.stringify(pattern)}`),
    );
    expect(stray).toEqual([]);
  });

  test("name every extra URL segment", () => {
    const blank = areas.flatMap(([name, area]) =>
      ("segments" in area ? area.segments : [])
        .filter((segment: string) => segment === "")
        .map(() => name),
    );
    expect(blank).toEqual([]);
  });

  test("declare the per-line check-in page with the attendees, for staff", () => {
    // The quantity page a roster's Check in link opens: a staff page, so a
    // door-only scanner login is never offered it.
    expect(AREAS_A_L.attendees.view.attendeeCheckin).toBe(
      "/admin/listing/:id/attendee/:attendeeId/checkin",
    );
    expect(AREAS_A_L.attendees.audience).not.toContain("scanner");
  });
});
