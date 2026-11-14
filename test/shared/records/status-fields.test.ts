import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { fieldSpecList } from "#test-utils/fields.ts";

describe("the attendee status fields", () => {
  test("hold the three switches, the name, and the reservation amount", () => {
    expect(STATUS_FIELDS).toEqual(
      fieldSpecList({
        is_paid_default: "switch",
        is_public_default: "switch",
        is_reservation: "switch",
        name: "name",
        reservation_amount: "text",
      }),
    );
  });
});
