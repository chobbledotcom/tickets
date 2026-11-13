/** The listing JSON API's declared numeric bounds: `duration_days` accepts the
 *  form's range (1 to MAX_DURATION_DAYS), and the integer field kinds refuse a
 *  body value below the field's declared minimum. Split from the main
 *  api-listing-body suite to keep both under the ~400-line target. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bodyToCreateInput } from "#routes/admin/api-listing-body.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("Admin API - listing declared bounds", { db: true }, () => {
  describe("bodyToCreateInput", () => {
    test("rejects a duration outside the declared range", async () => {
      for (const duration_days of [0, 91]) {
        const result = await bodyToCreateInput({
          duration_days,
          max_attendees: 10,
          name: "Test",
        });
        expect(result).toEqual({
          error: "duration_days must be a whole number from 1 to 90",
          ok: false,
        });
      }
    });

    test("accepts a duration at the declared bounds", async () => {
      for (const duration_days of [1, 90]) {
        const result = await bodyToCreateInput({
          duration_days,
          max_attendees: 10,
          name: "Test",
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.durationDays).toBe(duration_days);
      }
    });

    test("rejects declared-minimum violations on the quantity fields", async () => {
      for (const body of [
        { max_attendees: 10, max_quantity: 0, name: "Test" },
        { max_attendees: 10, min_quantity: 0, name: "Test" },
      ]) {
        const result = await bodyToCreateInput(body);
        expect(result).toEqual({
          error: `${Object.keys(body).find((key) => key.endsWith("quantity"))} has an invalid value`,
          ok: false,
        });
      }
    });

    test("accepts quantity fields at their declared minimum", async () => {
      const result = await bodyToCreateInput({
        max_attendees: 1,
        max_quantity: 1,
        min_quantity: 1,
        name: "Test",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.maxAttendees).toBe(1);
        expect(result.value.maxQuantity).toBe(1);
        expect(result.value.minQuantity).toBe(1);
      }
    });

    test("rejects a value outside the vocabulary or range its field declares", async () => {
      const refused: readonly Record<string, unknown>[] = [
        { unit_price: -100 },
        { unit_price: 100.5 },
        { max_price: -1 },
        { max_price: 0.5 },
        { listing_type: "daliy" },
        { bookable_days: ["monday"] },
      ];
      for (const value of refused) {
        const result = await bodyToCreateInput({
          max_attendees: 10,
          name: "Test",
          ...value,
        });
        expect(result).toEqual({
          error: `${Object.keys(value)[0]} has an invalid value`,
          ok: false,
        });
      }
    });

    test("accepts each declared listing type, weekday and whole price", async () => {
      const result = await bodyToCreateInput({
        bookable_days: ["Monday", "Sunday"],
        listing_type: "daily",
        max_attendees: 10,
        max_price: 2000,
        name: "Test",
        unit_price: 1250,
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          bookableDays: ["Monday", "Sunday"],
          listingType: "daily",
          maxPrice: 2000,
          unitPrice: 1250,
        },
      });
    });

    test("accepts a price of zero", async () => {
      const result = await bodyToCreateInput({
        max_attendees: 10,
        max_price: 0,
        name: "Test",
        unit_price: 0,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { maxPrice: 0, unitPrice: 0 },
      });
    });
  });
});
