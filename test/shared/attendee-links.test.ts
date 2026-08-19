/**
 * Servicing §0 — the kind-aware admin ref link builder.
 *
 * `attendeeAdminPath({ id, kind })` is the single pure link builder the
 * activity log, calendar, and homepage service-events table all call so a
 * servicing row links to `/admin/servicing/:id` and a customer row to
 * `/admin/attendees/:id`. No second copy of this dispatch may exist
 * (§20 "activity log and calendar share one kind-aware link builder").
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import { ATTENDEE_KIND, SERVICING_KIND } from "#db/attendees/kind.ts";
import { attendeeAdminPath } from "#shared/attendee-links.ts";

describe("servicing §0 — kind-aware ref link routing", () => {
  const cases: [label: string, kind: string, expectedPath: string][] = [
    ["servicing row", SERVICING_KIND, "/admin/servicing/42"],
    ["attendee row", ATTENDEE_KIND, "/admin/attendees/42"],
    ["unknown kind defaults to attendee route", "bogus", "/admin/attendees/42"],
  ];

  for (const [label, kind, expectedPath] of cases) {
    test(`${label} ⇒ ${expectedPath}`, () => {
      expect(attendeeAdminPath({ id: 42, kind })).toBe(expectedPath);
    });
  }

  test("the two kinds never produce the same route (mutation: swapping the kinds changes both URLs)", () => {
    const servicingPath = attendeeAdminPath({ id: 7, kind: SERVICING_KIND });
    const attendeePath = attendeeAdminPath({ id: 7, kind: ATTENDEE_KIND });
    expect(servicingPath).not.toBe(attendeePath);
  });
});
