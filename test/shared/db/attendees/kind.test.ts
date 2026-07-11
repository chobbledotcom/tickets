/**
 * Servicing §0 — the kind guard predicate. `isServicing(kind)` is true only
 * for `kind='servicing'`; every customer surface branches on this to exclude
 * servicing holds. The kind-aware ref link builder built on top of it is
 * covered in `test/shared/attendee-links.test.ts`.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE_KIND,
  isServicing,
  SERVICING_KIND,
} from "#shared/db/attendees/kind.ts";

describe("servicing §0 — kind guard helper classifies rows", () => {
  const cases: [
    label: string,
    kind: string | null | undefined,
    expected: boolean,
  ][] = [
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
