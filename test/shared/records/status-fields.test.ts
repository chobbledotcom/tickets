import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";

describe("the attendee status fields", () => {
  test("hold the three switches, the name, and the reservation amount", () => {
    expect(STATUS_FIELDS).toEqual([
      { key: "is_paid_default", kind: "switch" },
      { key: "is_public_default", kind: "switch" },
      { key: "is_reservation", kind: "switch" },
      { key: "name", kind: "name" },
      { key: "reservation_amount", kind: "text" },
    ]);
  });
});
