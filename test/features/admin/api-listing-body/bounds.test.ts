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
  });
});
