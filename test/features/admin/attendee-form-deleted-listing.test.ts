/**
 * Unit tests for the deleted-listing locked line: a stored booking row can
 * outlive its listing (a delete racing a mid-payment checkout keeps the
 * rows), and the editor keeps that row as a permanent no-quantity line —
 * retained on save, its stored range untouched, and impossible to un-lock.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isBookedLine,
  isNoQuantityLine,
  isRetainedLine,
  toDesiredLines,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import { bookingRow, line, parsedBase } from "./attendee-form-fixtures.ts";

/** A locked editor line: a stored row whose listing no longer resolves. */
const deletedListingLine = (
  overrides: Parameters<typeof line>[0] = {},
): ReturnType<typeof line> =>
  line({
    existingBooking: bookingRow({ listing_id: 9, quantity: 0 }),
    key: "9||0|0",
    listing: null,
    listingId: 9,
    noQuantity: true,
    quantity: 0,
    ...overrides,
  });

describe("deleted-listing locked line", () => {
  test("a deleted listing's stored row is retained as a no-quantity line", () => {
    const kept = deletedListingLine();
    expect(isBookedLine(kept)).toBe(false);
    expect(isNoQuantityLine(kept)).toBe(true);
    expect(isRetainedLine(kept)).toBe(true);
  });

  test("keeps its stored date range instead of the shared range", () => {
    const desired = toDesiredLines(
      parsedBase({
        dayCount: 3,
        lines: [
          deletedListingLine({
            existingBooking: bookingRow({
              end_at: "2026-03-03T00:00:00.000Z",
              listing_id: 9,
              quantity: 0,
              start_at: "2026-03-01T00:00:00.000Z",
            }),
            key: "9|2026-03-01T00:00:00.000Z|0|0",
          }),
        ],
        startDate: "2026-05-05",
      }),
    );
    // The shared date fields don't touch a listing that no longer exists —
    // the desired line re-states the row's own stored range, so the atomic
    // edit sees an unchanged preserve.
    expect(desired).toEqual([
      {
        date: "2026-03-01",
        durationDays: 2,
        exists: true,
        key: "9|2026-03-01T00:00:00.000Z|0|0",
        listingId: 9,
        packageGroupId: 0,
        parentListingId: 0,
        quantity: 0,
      },
    ]);
  });

  test("a range-less stored row stays range-less", () => {
    const desired = toDesiredLines(
      parsedBase({
        lines: [deletedListingLine()],
        startDate: "2026-05-05",
      }),
    );
    expect(desired[0]!.date).toBeNull();
    expect(desired[0]!.durationDays).toBe(1);
  });

  test("validation rejects un-ticking no-quantity on a deleted listing's row", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [deletedListingLine({ noQuantity: false, quantity: 1 })],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.formError).toBe(
        "This record has a booking for a deleted listing. That line is locked and cannot be changed.",
      );
    }
  });

  test("validation accepts the locked row when its no-quantity tick is kept", () => {
    const result = validateParsedForm(
      parsedBase({ lines: [deletedListingLine()] }),
    );
    expect(result.valid).toBe(true);
  });
});
