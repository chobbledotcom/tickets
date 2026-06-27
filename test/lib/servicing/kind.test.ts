/**
 * Servicing §0 — pure unit tests for the kind guard + the kind-aware admin ref
 * link builder.
 *
 * These pin the two small predicates the rest of the feature is built from:
 *
 *   • `isServicing(kind)` — true only for `kind='servicing'`. Every customer
 *     surface branches on this to exclude servicing holds.
 *   • `attendeeAdminPath({ id, kind })` — the single pure link builder the
 *     activity log, calendar, and homepage service-events table all call so
 *     a servicing row links to `/admin/servicing/:id` and a customer row to
 *     `/admin/attendees/:id`. No second copy of this dispatch may exist
 *     (§20 "activity log and calendar share one kind-aware link builder").
 *
 * Implementation contract these tests assume (test-first — code not yet written):
 *   - `src/shared/db/attendees/kind.ts` exports `isServicing`,
 *     `SERVICING_KIND = "servicing"`, `ATTENDEE_KIND = "attendee"`.
 *   - `src/shared/attendee-links.ts` exports `attendeeAdminPath`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
// jscpd:ignore-end
import {
  ATTENDEE_KIND,
  isServicing,
  SERVICING_KIND,
} from "#shared/db/attendees/kind.ts";

describe("servicing §0 — kind guard helper classifies rows", () => {
  const cases: Array<
    [label: string, kind: string | null | undefined, expected: boolean]
  > = [
    ["attendee kind", ATTENDEE_KIND, false],
    ["servicing kind", SERVICING_KIND, true],
    ["null kind", null, false],
    ["undefined kind", undefined, false],
    ["unknown kind value", "staff", false],
    ["empty string kind", "", false],
  ];

  for (const [label, kind, expected] of cases) {
    test(`${label} ⇒ ${expected ? "servicing" : "not servicing"}`, () => {
      expect(isServicing(kind)).toBe(expected);
    });
  }

  test("isServicing is a type guard: narrows to SERVICING_KIND only when true", () => {
    const kind: string | null = SERVICING_KIND;
    // A type guard must narrow so the narrowed value is assignable to the
    // SERVICING_KIND literal — this fails to compile if the predicate is not
    // declared as a `kind is "servicing"`.
    if (isServicing(kind)) {
      const _proof: typeof SERVICING_KIND = kind;
      expect(_proof).toBe(SERVICING_KIND);
    } else {
      // servicing kind must take the true branch
      throw new Error(
        "isServicing should narrow SERVICING_KIND to the servicing branch",
      );
    }
  });
});

describe("servicing §0 — kind-aware ref link routing", () => {
  const cases: Array<[label: string, kind: string, expectedPath: string]> = [
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
