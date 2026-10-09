/** The JSON body's field rules that only a direct parser call can pin: the
 *  undated date sentinel, the owner-only attribute message, and the attribute
 *  id array an owner sends. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bodyToUpdateInput } from "#routes/admin/api-listing-body.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("Admin API listing body field rules", { db: true }, () => {
  test("an empty date stores the undated sentinel", async () => {
    const result = await bodyToUpdateInput(
      { date: "", max_attendees: 10, name: "Undated" },
      testListingWithCount({
        date: "2026-08-01T00:00:00.000Z",
        max_attendees: 10,
        name: "Undated",
      }),
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value.date).toBe("");
  });

  test("names the owner-only rule when a manager sends attribute options", async () => {
    const result = await bodyToUpdateInput(
      { attribute_option_ids: [7], max_attendees: 10, name: "Managed" },
      testListingWithCount({ max_attendees: 10, name: "Managed" }),
      { adminLevel: "manager" },
    );

    expect(result).toEqual({
      error: "attribute_option_ids is owner-only",
      ok: false,
    });
  });

  test("carries an owner's attribute option ids into the update input", async () => {
    const result = await bodyToUpdateInput(
      {
        attribute_option_ids: [7, 9],
        max_attendees: 10,
        name: "Owner Options",
      },
      testListingWithCount({ max_attendees: 10, name: "Owner Options" }),
      { adminLevel: "owner" },
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value.attributeOptionIds).toEqual([7, 9]);
  });

  test("names the field when an attribute id is not a positive integer", async () => {
    const result = await bodyToUpdateInput(
      {
        attribute_option_ids: ["5"],
        max_attendees: 10,
        name: "Bad Option",
      },
      testListingWithCount({ max_attendees: 10, name: "Bad Option" }),
      { adminLevel: "owner" },
    );

    expect(result).toEqual({
      error: "attribute_option_ids must contain only positive integer ids",
      ok: false,
    });
  });
});
