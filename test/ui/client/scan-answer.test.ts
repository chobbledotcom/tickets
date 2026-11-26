import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ScanAnswerSchema } from "#src/ui/client/scan-answer.ts";

describe("the scan answer schema", () => {
  test("reads a refusal envelope as the status other", () => {
    expect(v.parse(ScanAnswerSchema, { error: "Not authenticated" })).toEqual({
      error: "Not authenticated",
      status: "other",
    });
    expect(v.parse(ScanAnswerSchema, {})).toEqual({ status: "other" });
  });

  test("refuses a status the page has no words for", () => {
    for (const body of [
      { name: "Ada", status: "teleported" },
      { error: "x", status: "teleported" },
    ]) {
      expect(v.safeParse(ScanAnswerSchema, body).success, body.status).toBe(
        false,
      );
    }
  });

  // Each known answer at the edge of its fields: no places left, and an
  // ask for one place. Each parses to itself.
  const KNOWN_ANSWERS: Record<string, unknown>[] = [
    {
      listingName: "Tour",
      name: "Ada",
      overAdmission: { admitted: 0, bought: 0, named: 0 },
      quantity: 0,
      remaining: 0,
      status: "checked_in",
      total: 0,
    },
    {
      listingName: "Tour",
      name: "Ada",
      quantity: 0,
      status: "already_checked_in",
      total: 0,
    },
    { name: "Ada", status: "verify_id" },
    { max: 1, name: "Ada", status: "select_quantity" },
    { listingName: "Tour", name: "Ada", status: "wrong_listing" },
    { name: "Ada", status: "refunded" },
    { status: "not_found" },
  ];
  for (const answer of KNOWN_ANSWERS) {
    test(`reads a ${answer.status} answer as itself`, () => {
      expect(v.parse(ScanAnswerSchema, answer)).toEqual(answer);
    });
  }

  test("refuses a quantity ask that offers no place", () => {
    expect(
      v.safeParse(ScanAnswerSchema, {
        max: 0,
        name: "Ada",
        status: "select_quantity",
      }).success,
    ).toBe(false);
  });
});
