import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { fieldSpecList } from "#test-utils/fields.ts";

describe("the attendee status fields", () => {
  test("hold the three switches, the name, and the reservation amount", () => {
    expect(STATUS_FIELDS).toEqual(
      fieldSpecList({
        isPaidDefault: "switch",
        isPublicDefault: "switch",
        isReservation: "switch",
        name: "name",
        reservationAmount: "text",
      }),
    );
  });
});
