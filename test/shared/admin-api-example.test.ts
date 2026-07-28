/**
 * The admin API docs page publishes an example listing. These check it against
 * a hand-written shape, so a change to the real conversion cannot quietly take
 * the documented example with it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { toAdminListing } from "#routes/admin/api.ts";
import { ADMIN_API_EXAMPLE_ADMIN_LISTING } from "#shared/admin-api-example.ts";
import { API_EXAMPLE_LISTING } from "#shared/api-example.ts";
import { AdminListingSchema } from "#test-utils/api-schemas.ts";

describe("admin API example", () => {
  test("the documented example has every admin listing field", () => {
    expect(() =>
      v.parse(AdminListingSchema, ADMIN_API_EXAMPLE_ADMIN_LISTING),
    ).not.toThrow();
  });

  test("an internal field leaking into a response is refused", () => {
    expect(() =>
      v.parse(AdminListingSchema, {
        ...ADMIN_API_EXAMPLE_ADMIN_LISTING,
        slug_index: "leaked",
      }),
    ).toThrow();
  });

  test("a missing field is refused", () => {
    const { name: _, ...withoutName } = ADMIN_API_EXAMPLE_ADMIN_LISTING;

    expect(() => v.parse(AdminListingSchema, withoutName)).toThrow();
  });

  test("a field of the wrong type is refused", () => {
    expect(() =>
      v.parse(AdminListingSchema, {
        ...ADMIN_API_EXAMPLE_ADMIN_LISTING,
        id: "1",
      }),
    ).toThrow();
  });

  test("the conversion drops the internal slug index", () => {
    expect(toAdminListing(API_EXAMPLE_LISTING)).not.toHaveProperty(
      "slug_index",
    );
  });

  test("the conversion keeps every other listing field as it was", () => {
    const { slug_index: _, ...expected } = API_EXAMPLE_LISTING;

    expect(toAdminListing(API_EXAMPLE_LISTING)).toEqual(expected);
  });

  test("the documented example says which groups the listing is in", () => {
    expect(ADMIN_API_EXAMPLE_ADMIN_LISTING.group_ids).toEqual([]);
  });
});
