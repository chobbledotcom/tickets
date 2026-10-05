/** The admin JSON API's `minimum_quantity` body mapping (registry entry
 *  `minimumQuantity`): mapped on create when sent, omitted when absent (the
 *  column default of 1 applies at insert), and merged over the stored row on
 *  update so an absent field keeps the stored value. Split from the main
 *  api-listing-body suite to keep both under the ~400-line target. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bodyToCreateInput,
  bodyToUpdateInput,
} from "#routes/admin/api-listing-body.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("Admin API - listing minimum_quantity", { db: true }, () => {
  describe("bodyToCreateInput", () => {
    test("omits the field when the body is absent", async () => {
      // Absent means the stored default of 1 applies at insert; mapping a
      // key here would freeze today's default into every API create.
      const result = await bodyToCreateInput({
        max_attendees: 10,
        name: "No Minimum",
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect("minimumQuantity" in result.value).toBe(false);
    });
  });

  describe("bodyToUpdateInput", () => {
    test("keeps the stored value when the body omits it", async () => {
      const existing = testListingWithCount({
        max_attendees: 10,
        minimum_quantity: 3,
        name: "Kept Minimum",
        slug: "kept-minimum",
      });

      const result = await bodyToUpdateInput({ name: "Renamed" }, existing);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.minimumQuantity).toBe(3);
    });

    test("maps a submitted value over the stored one", async () => {
      const existing = testListingWithCount({
        max_attendees: 10,
        max_quantity: 5,
        minimum_quantity: 3,
        name: "New Minimum",
        slug: "new-minimum",
      });

      const result = await bodyToUpdateInput({ minimum_quantity: 2 }, existing);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.minimumQuantity).toBe(2);
    });
  });
});
