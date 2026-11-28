import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount-hint.ts";

describe("the attendee status fields", () => {
  test("hold the name, the three switches, and the reservation amount", () => {
    expect(STATUS_FIELDS.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: "name", kind: "name" },
      { key: "isReservation", kind: "switch" },
      { key: "isPublicDefault", kind: "switch" },
      { key: "isPaidDefault", kind: "switch" },
      { key: "reservationAmount", kind: "text" },
    ]);
  });

  test("name the status form's copy", () => {
    expect(STATUS_FIELDS).toMatchObject([
      { label: "common.name", requiredMessageKey: "statuses.name_required" },
      { label: "statuses.form_reservation_checkbox" },
      { label: "statuses.form_public_default_checkbox" },
      { label: "statuses.form_paid_default_checkbox" },
      {
        default: "0",
        hint: "statuses.form_reservation_amount_hint",
        hintPrefix: RESERVATION_AMOUNT_HINT,
        label: "statuses.form_reservation_amount_label",
      },
    ]);
  });

  test("pair the paid default and the reservation as either/or", () => {
    expect(
      STATUS_FIELDS.filter(
        (field) => "exclusive" in field && field.exclusive !== undefined,
      ),
    ).toMatchObject([
      {
        exclusive: {
          other: "isPaidDefault",
          why: "statuses.error_paid_default_reservation",
        },
        key: "isReservation",
      },
      {
        exclusive: {
          other: "isReservation",
          why: "statuses.error_paid_default_reservation",
        },
        key: "isPaidDefault",
      },
    ]);
  });
});
